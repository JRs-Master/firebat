/**
 * Codex CLI 이미지 생성 핸들러 (구독 기반, gpt-image-2 native).
 *
 * 동작: `codex exec --output-format stream-json --skip-git-repo-check "prompt"` 를
 * 자식 프로세스로 spawn → stream-json 이벤트에서 image 바이너리 추출.
 *
 * 주의: Codex CLI 이미지 출력 프로토콜은 공식 문서가 thin 해서 추정 기반.
 * - `item.completed` 의 `item.type === 'image'` 또는 `agent_image` 로 올 것으로 예상
 * - content 에 file path (/tmp/codex-image-xxx.png) 또는 base64 포함 가능성
 * - 실측 후 파싱 보강 필요 — 현재 코드는 양쪽 케이스 모두 시도
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { ImageFormatHandler, ImageFormatHandlerContext } from '../format-handler';

const CODEX_TIMEOUT_MS = 5 * 60_000; // 이미지 생성은 느릴 수 있음 (5분)

export class CliCodexImageFormat implements ImageFormatHandler {
  async generate(
    opts: ImageGenOpts,
    _callOpts: ImageGenCallOpts | undefined,
    _ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>> {
    // prompt 에 size/quality 힌트 주입 — Codex CLI 는 CLI flag 로 이미지 파라미터 지정 못함
    const sizeHint = opts.size && opts.size !== 'auto' ? ` (size: ${opts.size})` : '';
    const qualityHint = opts.quality ? ` (quality: ${opts.quality})` : '';
    const prompt = `Generate image: ${opts.prompt}${sizeHint}${qualityHint}`;

    return new Promise<InfraResult<ImageGenResult>>((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let resolved = false;
      const done = (result: InfraResult<ImageGenResult>) => {
        if (resolved) return;
        resolved = true;
        try { child.kill(); } catch { /* already dead */ }
        resolve(result);
      };

      const child = spawn('codex', ['exec', '--output-format', 'stream-json', '--skip-git-repo-check', prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => done({ success: false, error: `Codex CLI 이미지 생성 타임아웃 (${CODEX_TIMEOUT_MS}ms)` }), CODEX_TIMEOUT_MS);
      timeout.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        // stream-json 은 한 줄에 한 이벤트 (NDJSON)
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          const result = this.tryExtractImage(ev);
          if (result) {
            clearTimeout(timeout);
            done(result);
            return;
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });
      child.on('error', (e) => {
        clearTimeout(timeout);
        done({ success: false, error: `Codex CLI spawn 실패: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (resolved) return;
        done({ success: false, error: `Codex CLI 종료 (exit ${code}): ${stderrBuf.slice(0, 500) || '이미지 추출 실패'}` });
      });
    });
  }

  /** Codex CLI stream-json 이벤트에서 이미지 binary 추출 시도.
   *  프로토콜 실측 결과에 따라 확장 필요 — 현재는 3가지 패턴 지원. */
  private tryExtractImage(ev: Record<string, unknown>): InfraResult<ImageGenResult> | null {
    const type = ev.type as string | undefined;
    const item = ev.item as Record<string, unknown> | undefined;

    // 패턴 1: item.completed + item.type === 'image' + base64 data
    if (type === 'item.completed' && item) {
      const itemType = item.type as string | undefined;
      if (itemType === 'image' || itemType === 'agent_image' || itemType === 'generated_image') {
        const data = item.data as string | undefined;
        const path_ = item.path as string | undefined;
        const mimeType = (item.mime_type as string) ?? (item.mimeType as string) ?? 'image/png';
        if (data) {
          return { success: true, data: { binary: Buffer.from(data, 'base64'), contentType: mimeType } };
        }
        if (path_) {
          try {
            const binary = fs.readFileSync(path_);
            return { success: true, data: { binary, contentType: mimeType } };
          } catch (e) {
            return { success: false, error: `이미지 파일 읽기 실패: ${(e as Error).message}` };
          }
        }
      }
    }

    // 패턴 2: tool_result 메타에 이미지 파일 경로
    if (type === 'tool_result' && ev.content) {
      const content = ev.content as unknown;
      if (typeof content === 'string' && content.includes('.png')) {
        const match = content.match(/([/~][\w/.-]+\.(?:png|jpg|webp))/);
        if (match) {
          const fp = match[1].startsWith('~') ? path.join(os.homedir(), match[1].slice(2)) : match[1];
          try {
            const binary = fs.readFileSync(fp);
            return { success: true, data: { binary, contentType: 'image/png' } };
          } catch { /* 다음 패턴 시도 */ }
        }
      }
    }

    return null;
  }
}

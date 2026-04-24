/**
 * Codex CLI 이미지 생성 핸들러 (구독 기반, gpt-image-2 native).
 *
 * 공식문서: https://developers.openai.com/codex/cli/features
 *  - "$imagegen" 명령어로 명시적 이미지 생성 skill 호출
 *  - gpt-image-2 native 사용, Codex 사용 한도 3~5x 차감
 *  - 레퍼런스 이미지 첨부로 iterate 가능 (v2 에서 지원 예정)
 *
 * 동작: `codex exec --output-format stream-json --skip-git-repo-check "$imagegen <prompt>"` spawn
 *   → stream-json 이벤트에서 item.completed + item.type=agent_image / generated_image 파싱
 *   → 또는 tool_result 의 파일 경로에서 binary 추출
 *
 * 실측 기반 보강 필요 — 처음 구현은 OpenAI 공식 문서의 $imagegen 스킬 존재만 확인.
 * 실제 stream-json 이벤트 포맷은 서버에서 codex 실행 후 로그 검토로 확정.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { ImageFormatHandler, ImageFormatHandlerContext } from '../format-handler';

const CODEX_TIMEOUT_MS = 5 * 60_000;

export class CliCodexImageFormat implements ImageFormatHandler {
  async generate(
    opts: ImageGenOpts,
    _callOpts: ImageGenCallOpts | undefined,
    _ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>> {
    // $imagegen 명시적 호출 + 파라미터는 프롬프트로 전달 (Codex CLI 는 구조화 flag 미지원)
    const sizeHint = opts.size && opts.size !== 'auto' ? ` size:${opts.size}` : '';
    const qualityHint = opts.quality ? ` quality:${opts.quality}` : '';
    const prompt = `$imagegen ${opts.prompt}${sizeHint}${qualityHint}`;

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
        done({ success: false, error: `Codex CLI 종료 (exit ${code}): ${stderrBuf.slice(0, 500) || stdoutBuf.slice(-500) || '이미지 추출 실패 — 프로토콜 파서 재검토 필요'}` });
      });
    });
  }

  /** Codex CLI stream-json 이벤트에서 이미지 binary 추출.
   *  공식 프로토콜 문서 부재 — 3가지 패턴 매칭 + 실측 후 보강 필요. */
  private tryExtractImage(ev: Record<string, unknown>): InfraResult<ImageGenResult> | null {
    const type = ev.type as string | undefined;
    const item = ev.item as Record<string, unknown> | undefined;

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

/**
 * Gemini CLI 이미지 생성 핸들러 (구독 기반, gemini-2.5-flash-image native).
 *
 * 동작: `gemini -p "prompt" --output-format stream-json` spawn → 이벤트에서
 * 이미지 바이너리 추출.
 *
 * 주의: Gemini CLI 의 이미지 생성 출력 프로토콜도 실측 필요. 현재는 추정 기반:
 * - `type: 'tool_result'` 또는 `type: 'message'` 안에 inline_data / file_path 포함 가능
 * - 파일 기반이면 보통 현재 작업 디렉토리에 출력
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { ImageFormatHandler, ImageFormatHandlerContext } from '../format-handler';

const GEMINI_TIMEOUT_MS = 5 * 60_000;

export class CliGeminiImageFormat implements ImageFormatHandler {
  async generate(
    opts: ImageGenOpts,
    _callOpts: ImageGenCallOpts | undefined,
    _ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>> {
    const sizeHint = opts.size && opts.size !== 'auto' ? ` (aspect: ${opts.size})` : '';
    const prompt = `Generate an image: ${opts.prompt}${sizeHint}`;

    return new Promise<InfraResult<ImageGenResult>>((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let resolved = false;
      const done = (result: InfraResult<ImageGenResult>) => {
        if (resolved) return;
        resolved = true;
        try { child.kill(); } catch {}
        resolve(result);
      };

      const child = spawn('gemini', ['-p', prompt, '--output-format', 'stream-json', '--yolo'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => done({ success: false, error: `Gemini CLI 타임아웃 (${GEMINI_TIMEOUT_MS}ms)` }), GEMINI_TIMEOUT_MS);
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
        done({ success: false, error: `Gemini CLI spawn 실패: ${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (resolved) return;
        done({ success: false, error: `Gemini CLI 종료 (exit ${code}): ${stderrBuf.slice(0, 500) || '이미지 추출 실패'}` });
      });
    });
  }

  private tryExtractImage(ev: Record<string, unknown>): InfraResult<ImageGenResult> | null {
    // Gemini CLI 는 tool_result 이벤트에 inline_data 포함 가능성
    const type = ev.type as string | undefined;

    if (type === 'tool_result' || type === 'message') {
      const output = ev.output as Record<string, unknown> | undefined;
      const inlineData = output?.inline_data as { data?: string; mime_type?: string } | undefined
        ?? output?.inlineData as { data?: string; mimeType?: string } | undefined;
      if (inlineData?.data) {
        const mt = (inlineData as { mime_type?: string; mimeType?: string }).mime_type
          ?? (inlineData as { mime_type?: string; mimeType?: string }).mimeType
          ?? 'image/png';
        return { success: true, data: { binary: Buffer.from(inlineData.data, 'base64'), contentType: mt } };
      }
      // file_path 기반
      const fp = (output?.file_path as string | undefined) ?? (output?.path as string | undefined);
      if (fp) {
        const resolved = fp.startsWith('~') ? path.join(os.homedir(), fp.slice(2)) : fp;
        try {
          const binary = fs.readFileSync(resolved);
          return { success: true, data: { binary, contentType: 'image/png' } };
        } catch { /* 다음 */ }
      }
    }

    return null;
  }
}

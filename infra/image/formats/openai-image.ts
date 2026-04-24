/**
 * OpenAI Images API 핸들러 — gpt-image-2 (Duct Tape) 대응.
 *
 * 요청: POST https://api.openai.com/v1/images/generations
 * 바디: { model, prompt, n, size, quality, response_format }
 *  - response_format="b64_json" 으로 받으면 URL 대신 base64 binary 직접 반환 → 다운로드 round-trip 절약
 *
 * gpt-image-2 지원 파라미터:
 *  - size: "1024x1024" | "1792x1024" | "1024x1792" | "auto"
 *  - quality: "low" | "medium" | "high"
 *  - n: 1 (현재)
 *
 * 미지원 파라미터 (DALL-E 3 잔재): style 은 무시됨.
 */
import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { ImageFormatHandler, ImageFormatHandlerContext } from '../format-handler';

const DEFAULT_SIZE = '1024x1024';
const DEFAULT_QUALITY = 'medium';

function parseSize(size: string): { width?: number; height?: number } {
  const m = size.match(/^(\d+)x(\d+)$/);
  return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : {};
}

export class OpenAIImageFormat implements ImageFormatHandler {
  async generate(
    opts: ImageGenOpts,
    callOpts: ImageGenCallOpts | undefined,
    ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>> {
    const apiKey = ctx.resolveApiKey();
    if (!apiKey) return { success: false, error: `API 키가 설정되지 않았습니다: ${ctx.config.apiKeyVaultKey}` };

    const size = opts.size ?? DEFAULT_SIZE;
    const quality = opts.quality ?? DEFAULT_QUALITY;

    const body = {
      model: opts.model ?? ctx.config.id,
      prompt: opts.prompt,
      n: opts.n ?? 1,
      size,
      quality,
      response_format: 'b64_json',
    };

    try {
      const res = await fetch(ctx.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...(ctx.config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { success: false, error: `OpenAI Images API ${res.status}: ${txt.slice(0, 500)}` };
      }
      const json = await res.json() as {
        data?: Array<{ b64_json?: string; revised_prompt?: string }>;
      };
      const first = json.data?.[0];
      if (!first?.b64_json) return { success: false, error: '응답에 이미지 데이터가 없습니다' };
      const binary = Buffer.from(first.b64_json, 'base64');
      const dims = parseSize(size);
      return {
        success: true,
        data: {
          binary,
          contentType: 'image/png',
          ...(dims.width ? { width: dims.width } : {}),
          ...(dims.height ? { height: dims.height } : {}),
          ...(first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}),
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

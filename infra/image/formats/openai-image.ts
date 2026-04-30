/**
 * OpenAI Images API 핸들러 — gpt-image-1 (현 세대, DALL-E 후속).
 *
 * 두 endpoint 분기:
 *  - 일반 생성 (referenceImage 없음): POST /v1/images/generations — JSON body
 *    { model, prompt, n, size, quality }
 *  - image-to-image (referenceImage 있음): POST /v1/images/edits — multipart/form-data
 *    image (binary) + prompt + model + n + size + quality
 *  endpoint 는 config.endpoint 의 path 부분만 자동 교체 — 도메인은 그대로 유지.
 *
 * gpt-image-1 은 두 endpoint 모두 지원:
 *  - response_format 파라미터 없음 (기본 b64_json 반환)
 *  - output_format 으로 png/jpeg/webp 지정 가능 (기본 png)
 *
 * gpt-image-1 지원 파라미터:
 *  - size: "1024x1024" | "1536x1024" (landscape) | "1024x1536" (portrait) | "auto"
 *  - quality: "low" | "medium" | "high"
 *  - n: 1~10
 *
 * 유의: DALL-E 3 의 "1792x1024" / "1024x1792" 사이즈는 gpt-image-1 에선 400.
 * gpt-image-2 는 2026-05 API 공개 예정 — config 추가만 하면 핸들러 재사용.
 */
import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { ImageFormatHandler, ImageFormatHandlerContext } from '../format-handler';
import { computeImageCost } from '../image-config';

const DEFAULT_SIZE = '1024x1024';
const DEFAULT_QUALITY = 'medium';
const SUPPORTED_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', 'auto']);

/** AI 가 DALL-E 3 시절 값을 넘기면 gpt-image-1 호환 값으로 매핑 */
function normalizeSize(size?: string): string {
  if (!size) return DEFAULT_SIZE;
  if (SUPPORTED_SIZES.has(size)) return size;
  // DALL-E 3 landscape/portrait → gpt-image-1 대응 근사치
  if (size === '1792x1024') return '1536x1024';
  if (size === '1024x1792') return '1024x1536';
  return DEFAULT_SIZE;
}

function parseSize(size: string): { width?: number; height?: number } {
  if (size === 'auto') return {};
  const m = size.match(/^(\d+)x(\d+)$/);
  return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : {};
}

/** /v1/images/generations → /v1/images/edits 로 path 교체. 도메인·basepath 보존. */
function toEditsEndpoint(generationsEndpoint: string): string {
  return generationsEndpoint.replace(/\/images\/generations\b/, '/images/edits');
}

/** content-type → 파일 확장자. multipart 의 filename 파라미터에 필요 (없으면 OpenAI 가 거부) */
function extFromContentType(ct: string): string {
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  return 'png';
}

export class OpenAIImageFormat implements ImageFormatHandler {
  async generate(
    opts: ImageGenOpts,
    callOpts: ImageGenCallOpts | undefined,
    ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>> {
    const apiKey = ctx.resolveApiKey();
    if (!apiKey) return { success: false, error: `API 키가 설정되지 않았습니다: ${ctx.config.apiKeyVaultKey}` };

    const size = normalizeSize(opts.size);
    const quality = opts.quality ?? DEFAULT_QUALITY;
    const ref = opts.referenceImage;

    // ctx.config.id 우선 — resolveConfig 가 registry 기반으로 정규화한 값이라 권위. opts.model 은 힌트일 뿐
    // (사용자가 registry 에 없는 모델 ID 요청해도 fallback 된 config 로 실제 호출)
    try {
      let res: Response;
      if (ref) {
        // image-to-image: /v1/images/edits + multipart/form-data
        const form = new FormData();
        form.append('model', ctx.config.id);
        form.append('prompt', opts.prompt);
        form.append('n', String(opts.n ?? 1));
        form.append('size', size);
        form.append('quality', quality);
        const ext = extFromContentType(ref.contentType);
        const blob = new Blob([new Uint8Array(ref.binary)], { type: ref.contentType });
        form.append('image', blob, `reference.${ext}`);
        res = await fetch(toEditsEndpoint(ctx.config.endpoint), {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            ...(ctx.config.extraHeaders ?? {}),
            // Content-Type 은 fetch 가 boundary 와 함께 자동 설정 — 명시 X
          },
          body: form,
        });
      } else {
        // 일반 생성: /v1/images/generations + JSON body
        const body = {
          model: ctx.config.id,
          prompt: opts.prompt,
          n: opts.n ?? 1,
          size,
          quality,
        };
        res = await fetch(ctx.config.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(ctx.config.extraHeaders ?? {}),
          },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        // 개행 문자 제거 — 여러 줄 에러 바디가 로그 파서에 의해 중간에서 잘리던 문제 방지
        const flat = txt.replace(/\s+/g, ' ').slice(0, 2000);
        return { success: false, error: `OpenAI Images API ${res.status}${ref ? ' (edits)' : ''}: ${flat}` };
      }
      const json = await res.json() as {
        data?: Array<{ b64_json?: string; revised_prompt?: string }>;
      };
      const first = json.data?.[0];
      if (!first?.b64_json) return { success: false, error: '응답에 이미지 데이터가 없습니다' };
      const binary = Buffer.from(first.b64_json, 'base64');
      const dims = parseSize(size);
      // 비용 계산 — config.pricing 의 quality 별 단가 lookup. CostManager 가 누적.
      const costUsd = computeImageCost(ctx.config, opts.quality);
      return {
        success: true,
        data: {
          binary,
          contentType: 'image/png',
          ...(dims.width ? { width: dims.width } : {}),
          ...(dims.height ? { height: dims.height } : {}),
          ...(first.revised_prompt ? { revisedPrompt: first.revised_prompt } : {}),
          ...(costUsd != null ? { costUsd } : {}),
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

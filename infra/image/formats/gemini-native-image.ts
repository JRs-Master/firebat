/**
 * Gemini Native API 이미지 생성 핸들러 — gemini-2.5-flash-image (Nano Banana).
 *
 * 요청: POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent
 * 인증: ?key=<API_KEY> query param (또는 x-goog-api-key 헤더)
 *
 * Request body:
 *   { contents: [{ parts: [{ text: prompt }] }] }
 *
 * Response:
 *   { candidates: [{ content: { parts: [{ inline_data: { mime_type, data (base64) } }] } }] }
 *
 * Gemini 2.5 Flash Image 특징:
 *  - 사이즈는 모델이 프롬프트 기반 자동 판단 (size 파라미터 없음)
 *  - 품질도 고정 (standard)
 *  - 한국어 텍스트 렌더링 우수
 *  - 캐릭터·객체 일관성 강점
 */
import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../../core/ports';
import type { InfraResult } from '../../../core/types';
import type { ImageFormatHandler, ImageFormatHandlerContext } from '../format-handler';

export class GeminiNativeImageFormat implements ImageFormatHandler {
  async generate(
    opts: ImageGenOpts,
    _callOpts: ImageGenCallOpts | undefined,
    ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>> {
    const apiKey = ctx.resolveApiKey();
    if (!apiKey) return { success: false, error: `API 키가 설정되지 않았습니다: ${ctx.config.apiKeyVaultKey}` };

    // Gemini 는 size 를 직접 받지 않음. 프롬프트에 aspect ratio 힌트 주입 (사용자 의도 보존).
    let prompt = opts.prompt;
    if (opts.size && opts.size !== 'auto') {
      const hint = opts.size.replace('x', ':');
      prompt = `${prompt}\n\n(Aspect ratio hint: ${hint}.)`;
    }

    // referenceImage (image-to-image) — Gemini 2.5+ Flash Image 는 multimodal contents 자연 지원.
    // parts 에 inline_data (image) + text 함께 보내면 image-to-image 변환 동작.
    // text 가 변환 의도 (스타일 변경 / 실사화 등) 설명하면 됨.
    const ref = opts.referenceImage;
    const parts: Array<{ text?: string } | { inline_data?: { mime_type: string; data: string } }> = [];
    if (ref) {
      parts.push({ inline_data: { mime_type: ref.contentType, data: ref.binary.toString('base64') } });
    }
    parts.push({ text: prompt });

    const url = `${ctx.config.endpoint}?key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        const flat = txt.replace(/\s+/g, ' ').slice(0, 2000);
        return { success: false, error: `Gemini Images API ${res.status}: ${flat}` };
      }
      const json = await res.json() as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inline_data?: { mime_type?: string; data?: string };
              inlineData?: { mimeType?: string; data?: string };
            }>;
          };
        }>;
      };
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      // Gemini 응답은 snake_case (inline_data) 또는 camelCase (inlineData) — 둘 다 허용
      const imagePart = parts.find(p => p.inline_data?.data || p.inlineData?.data);
      const data = imagePart?.inline_data?.data ?? imagePart?.inlineData?.data;
      const mimeType = imagePart?.inline_data?.mime_type ?? imagePart?.inlineData?.mimeType ?? 'image/png';
      if (!data) return { success: false, error: '응답에 이미지 데이터가 없습니다' };
      const binary = Buffer.from(data, 'base64');
      return {
        success: true,
        data: { binary, contentType: mimeType },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}

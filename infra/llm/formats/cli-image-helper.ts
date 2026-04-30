/**
 * CLI 어댑터 공통 — opts.image (base64) → 임시 파일 저장 헬퍼.
 *
 * 사용 패턴 (Codex / Gemini CLI):
 *   const tmp = writeImageTempFile(opts.image, opts.imageMimeType);
 *   if (tmp) args.push('--image', tmp.path);   // Codex
 *   if (tmp) finalPrompt = `@${tmp.path}\n\n${finalPrompt}`;  // Gemini
 *   ...
 *   child.on('close', () => cleanupTempFile(tmp?.path));
 *
 * Claude Code 는 stream-json input 으로 base64 직접 전달 (이 헬퍼 미사용).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 이미지 임시 파일 저장. dirOverride 옵션으로 저장 디렉토리 지정 가능
 * (Gemini CLI 의 workspace 제약 회피용 — workspace 외 경로는 @-syntax 차단됨).
 * 미지정 시 os.tmpdir() 사용 (Codex 용).
 */
export function writeImageTempFile(image?: string, mimeType?: string, dirOverride?: string): { path: string; mimeType: string } | null {
  if (!image) return null;
  const data = image.includes(',') ? image.split(',')[1] : image;
  const mt = mimeType || image.match(/^data:([^;]+)/)?.[1] || 'image/png';
  const ext = mt.includes('png') ? 'png'
            : mt.includes('jpeg') || mt.includes('jpg') ? 'jpg'
            : mt.includes('webp') ? 'webp'
            : mt.includes('gif') ? 'gif'
            : 'bin';
  const dir = dirOverride || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `firebat-attached-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(data, 'base64'));
  return { path: tmpPath, mimeType: mt };
}

export function cleanupTempFile(p?: string | null) {
  if (!p) return;
  try { fs.unlinkSync(p); } catch { /* 이미 삭제됐거나 권한 — 무시 */ }
}

/** opts.image → base64 raw (data: prefix 제거) + media_type. Claude Code stream-json input 용. */
export function extractImageBase64(image?: string, mimeType?: string): { data: string; mediaType: string } | null {
  if (!image) return null;
  const data = image.includes(',') ? image.split(',')[1] : image;
  const mt = mimeType || image.match(/^data:([^;]+)/)?.[1] || 'image/png';
  return { data, mediaType: mt };
}

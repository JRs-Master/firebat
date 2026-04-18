/**
 * 공용 임베딩 유틸 — tool-search-index / conversation-manager 모두 같은 모델 공유
 *
 * 모델: paraphrase-multilingual-MiniLM-L12-v2 (25MB, 384차원, 한국어 OK)
 */

const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let pipelinePromise: Promise<any> | null = null;

async function getEmbedder() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = '.cache/transformers';
      env.allowLocalModels = true;
      return await pipeline('feature-extraction', MODEL_NAME);
    })();
  }
  return pipelinePromise;
}

/** 텍스트 → Float32Array (정규화된 384차원 벡터) */
export async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.data as Float32Array;
}

/** 정규화된 벡터 간 cosine similarity = dot product */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Float32Array ↔ Buffer 변환 (SQLite BLOB 저장용) */
export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

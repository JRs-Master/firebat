/**
 * 공용 임베딩 유틸 — tool-search-index / conversation-manager 모두 같은 모델 공유
 *
 * 모델: multilingual-e5-small (120MB, 384차원, 한국어 retrieval용 학습)
 * - paraphrase-MiniLM은 paraphrase mining 용이라 짧은 쿼리 noise가 심했음
 * - E5는 `query: ...` / `passage: ...` 프롬프트로 쿼리·문서 벡터를 분리 학습해 retrieval 점수 분포가 정규화됨
 * - 호출자는 embedQuery()·embedPassage() 중 상황에 맞는 쪽을 사용 (기본 embed은 passage로 취급 — 하위 호환)
 */

const MODEL_NAME = 'Xenova/multilingual-e5-small';

/** 캐시 무효화 키 — 모델 교체 시 값 변경되면 해시 불일치로 기존 캐시 자동 재임베딩 */
export const EMBED_VERSION = 'e5-small-v1';

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

async function embedWithPrefix(prefix: 'query' | 'passage', text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  // E5는 prefix 필수 — 미부착 시 점수 왜곡
  const input = `${prefix}: ${text}`;
  const output = await extractor(input, { pooling: 'mean', normalize: true });
  return output.data as Float32Array;
}

/** 사용자 쿼리 임베딩 (검색 입력) */
export async function embedQuery(text: string): Promise<Float32Array> {
  return embedWithPrefix('query', text);
}

/** 인덱스 대상 문서 임베딩 (카테고리 설명·메시지 등) */
export async function embedPassage(text: string): Promise<Float32Array> {
  return embedWithPrefix('passage', text);
}

/** 하위 호환용 기본 embed — passage 취급. 신규 호출자는 embedQuery/embedPassage 사용 */
export async function embed(text: string): Promise<Float32Array> {
  return embedPassage(text);
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

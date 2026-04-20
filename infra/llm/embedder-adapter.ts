/**
 * IEmbedderPort 어댑터 — 기존 함수형 embedder를 객체형 포트로 래핑.
 * Core 는 이 어댑터를 통해서만 임베딩 기능에 접근 (Core 순수성 유지).
 */
import type { IEmbedderPort } from '../../core/ports';
import {
  embedQuery,
  embedPassage,
  cosine,
  float32ToBuffer,
  bufferToFloat32,
  EMBED_VERSION,
} from './embedder';

export class EmbedderAdapter implements IEmbedderPort {
  readonly version = EMBED_VERSION;
  embedQuery(text: string): Promise<Float32Array> {
    return embedQuery(text);
  }
  embedPassage(text: string): Promise<Float32Array> {
    return embedPassage(text);
  }
  cosine(a: Float32Array, b: Float32Array): number {
    return cosine(a, b);
  }
  float32ToBuffer(arr: Float32Array): Buffer {
    return float32ToBuffer(arr);
  }
  bufferToFloat32(buf: Buffer): Float32Array {
    return bufferToFloat32(buf);
  }
}

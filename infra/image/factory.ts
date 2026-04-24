/**
 * Image Gen 어댑터 팩토리 — LLM factory 와 병렬 구조.
 *
 * configs/*.json 스캔해서 registry 구성 → ImageConfigDrivenAdapter 생성.
 */
import path from 'path';
import { ImageConfigDrivenAdapter } from './config-adapter';
import { loadImageGenRegistry, type ImageGenRegistry } from './image-config';

export const DEFAULT_IMAGE_MODEL = 'gpt-image-1';

export function buildImageConfigDrivenAdapter(
  registry: ImageGenRegistry,
  defaultModelId: string,
  resolveSecret: (key: string) => string | null,
): ImageConfigDrivenAdapter {
  return new ImageConfigDrivenAdapter(registry, defaultModelId, resolveSecret);
}

export function loadImageRegistry(dir?: string): ImageGenRegistry {
  const baseDir = dir || path.join(process.cwd(), 'infra', 'image', 'configs');
  return loadImageGenRegistry(baseDir);
}

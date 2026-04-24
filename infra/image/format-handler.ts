import type { ImageGenOpts, ImageGenCallOpts, ImageGenResult } from '../../core/ports';
import type { InfraResult } from '../../core/types';
import type { ImageGenModelConfig } from './image-config';

export interface ImageFormatHandlerContext {
  config: ImageGenModelConfig;
  resolveApiKey: () => string | null;
}

export interface ImageFormatHandler {
  generate(
    opts: ImageGenOpts,
    callOpts: ImageGenCallOpts | undefined,
    ctx: ImageFormatHandlerContext,
  ): Promise<InfraResult<ImageGenResult>>;
}

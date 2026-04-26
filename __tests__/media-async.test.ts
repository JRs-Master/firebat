/**
 * MediaManager.startGenerate 비동기 패턴 테스트.
 *
 * 핵심 검증:
 *   - 호출 즉시 placeholder URL 반환 (1초 미만, await imageGen X)
 *   - status='rendering' 마킹 → 백그라운드 generation 후 'done' 으로 자동 전환
 *   - finalizeBase 가 placeholder 파일 → 실제 binary 로 교체
 *   - onComplete / onError 콜백 정상 작동
 *
 * 격리: 모든 포트 (IImageGenPort / IMediaPort / IImageProcessorPort / IVaultPort / ILogPort)
 * in-memory mock — 실제 sharp / OpenAI / 디스크 0.
 */
import { describe, it, expect, vi } from 'vitest';
import { MediaManager } from '../core/managers/media-manager';
import type {
  IImageGenPort,
  IMediaPort,
  IImageProcessorPort,
  IVaultPort,
  ILogPort,
  ImageGenResult,
  MediaSaveResult,
  MediaFileRecord,
  ImageMetadata,
  ResizeOpts,
  ImageGenOpts,
  ImageGenCallOpts,
} from '../core/ports';
import type { InfraResult } from '../core/types';

// ── 헬퍼: 비동기 setImmediate flush 대기 ────────────────────────────────────
function flushAsync(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ── In-memory 포트 mock ───────────────────────────────────────────────────
interface MediaStoreEntry {
  binary: Buffer;
  contentType: string;
  record: MediaFileRecord;
}

function makeMediaPort(): IMediaPort & { _store: Map<string, MediaStoreEntry> } {
  const store = new Map<string, MediaStoreEntry>();
  let counter = 0;
  return {
    _store: store,
    async save(binary, contentType, opts) {
      const slug = `slug-${++counter}`;
      const buf = Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
      const ext = opts?.ext ?? 'png';
      const scope = opts?.scope ?? 'user';
      const record: MediaFileRecord = {
        slug, ext, contentType, bytes: buf.length, createdAt: Date.now(), scope, status: 'done',
        ...(opts?.filenameHint ? { filenameHint: opts.filenameHint } : {}),
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.size ? { size: opts.size } : {}),
        ...(opts?.quality ? { quality: opts.quality } : {}),
        ...(opts?.source ? { source: opts.source } : {}),
        ...(opts?.aspectRatio ? { aspectRatio: opts.aspectRatio } : {}),
      };
      store.set(slug, { binary: buf, contentType, record });
      return { success: true, data: { slug, url: `/${scope}/media/${slug}.${ext}`, bytes: buf.length } satisfies MediaSaveResult };
    },
    async finalizeBase(slug, scope, binary, contentType, _ext) {
      const entry = store.get(slug);
      if (!entry) return { success: false, error: 'not found' };
      entry.binary = binary;
      entry.contentType = contentType;
      entry.record.bytes = binary.length;
      entry.record.contentType = contentType;
      // ext 변경은 png/jpg 등 contentType 에서 추론 (테스트 단순화)
      if (contentType.includes('jpeg')) entry.record.ext = 'jpg';
      else if (contentType.includes('webp')) entry.record.ext = 'webp';
      else entry.record.ext = 'png';
      return { success: true };
    },
    async saveVariant(_slug, scope, suffix, format, binary, _meta) {
      return { success: true, data: `/${scope}/media/${_slug}-${suffix}.${format}` };
    },
    async updateMeta(slug, _scope, patch) {
      const entry = store.get(slug);
      if (!entry) return { success: false, error: 'not found' };
      entry.record = { ...entry.record, ...patch };
      return { success: true };
    },
    async saveErrorRecord(opts) {
      const slug = `err-slug-${++counter}`;
      const record: MediaFileRecord = {
        slug, ext: 'png', contentType: 'image/png', bytes: 0, createdAt: Date.now(),
        scope: opts.scope ?? 'user', status: 'error', errorMsg: opts.errorMsg,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      };
      store.set(slug, { binary: Buffer.from([]), contentType: 'image/png', record });
      return { success: true, data: { slug } };
    },
    async read(slug) {
      const entry = store.get(slug);
      if (!entry) return { success: true, data: null };
      return { success: true, data: entry };
    },
    async stat(slug) {
      const entry = store.get(slug);
      return { success: true, data: entry?.record ?? null };
    },
    async remove(slug) {
      store.delete(slug);
      return { success: true };
    },
    async list() {
      const items = Array.from(store.values()).map(e => e.record);
      return { success: true, data: { items, total: items.length } };
    },
  };
}

function makeImageGen(opts: { delayMs?: number; fail?: boolean; binary?: Buffer } = {}): IImageGenPort {
  return {
    getModelId: () => 'mock-model',
    listModels: () => [{ id: 'mock-model', displayName: 'Mock', provider: 'mock' }],
    async generate(_input: ImageGenOpts, _callOpts?: ImageGenCallOpts): Promise<InfraResult<ImageGenResult>> {
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      if (opts.fail) return { success: false, error: '의도적 실패' };
      const binary = opts.binary ?? Buffer.from('REAL-IMAGE-BYTES-LARGER-THAN-PLACEHOLDER');
      return {
        success: true,
        data: { binary, contentType: 'image/png', width: 1024, height: 1024 } as ImageGenResult,
      };
    },
  } as unknown as IImageGenPort;
}

function makeProcessor(): IImageProcessorPort {
  return {
    async createPlaceholder(width: number, height: number): Promise<InfraResult<Buffer>> {
      // placeholder 는 작은 사이즈 (실제 sharp 안 씀)
      return { success: true, data: Buffer.from(`PLACEHOLDER-${width}x${height}`) };
    },
    async getMetadata(binary: Buffer | Uint8Array): Promise<InfraResult<ImageMetadata>> {
      return {
        success: true,
        data: { width: 1024, height: 1024, format: 'png', bytes: (binary as Buffer).length, hasAlpha: true },
      };
    },
    async process(binary: Buffer | Uint8Array, _opts: ResizeOpts): Promise<InfraResult<Buffer>> {
      return { success: true, data: Buffer.isBuffer(binary) ? binary : Buffer.from(binary) };
    },
    async blurhash(): Promise<InfraResult<string>> {
      return { success: true, data: 'L00000fQfQfQfQfQfQfQfQfQfQfQ' };
    },
  };
}

function makeVault(): IVaultPort {
  const store = new Map<string, string>();
  return {
    getSecret: (k: string) => store.get(k) ?? null,
    setSecret: (k: string, v: string) => { store.set(k, v); return true; },
    deleteSecret: (k: string) => { store.delete(k); return true; },
    listKeys: () => Array.from(store.keys()),
    listKeysByPrefix: (p: string) => Array.from(store.keys()).filter(k => k.startsWith(p)),
  };
}

function makeLogger(): ILogPort {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  } as unknown as ILogPort;
}

// ── 테스트 ──────────────────────────────────────────────────────────────────
describe('MediaManager.startGenerate — 비동기 image_gen 패턴', () => {
  it('즉시 placeholder URL 반환 (await imageGen X) + status=rendering 마킹', async () => {
    const media = makeMediaPort();
    // 의도적으로 imageGen 을 100ms 지연시켜 sync await 안 하는지 검증
    const imageGen = makeImageGen({ delayMs: 100 });
    const mgr = new MediaManager(imageGen, media, makeProcessor(), makeVault(), makeLogger());

    const start = Date.now();
    const res = await mgr.startGenerate({ prompt: 'cat' });
    const elapsed = Date.now() - start;

    // 즉시 반환 — 100ms 미만
    expect(elapsed).toBeLessThan(50);
    expect(res.success).toBe(true);
    expect(res.data?.slug).toBeDefined();
    expect(res.data?.url).toMatch(/^\/user\/media\/.+\.png$/);

    // 즉시 시점에 status='rendering' 마킹됨 (placeholder 저장됐고 백그라운드 진행 중)
    const stat = await media.stat(res.data!.slug);
    expect(stat.data?.status).toBe('rendering');
  });

  it('백그라운드 완료 시 finalizeBase + status=done + onComplete 콜백', async () => {
    const media = makeMediaPort();
    const realBinary = Buffer.from('REAL-IMAGE-BYTES-LARGER-THAN-PLACEHOLDER-CONTENT');
    const imageGen = makeImageGen({ binary: realBinary });
    const mgr = new MediaManager(imageGen, media, makeProcessor(), makeVault(), makeLogger());

    const onComplete = vi.fn();
    const onError = vi.fn();
    const res = await mgr.startGenerate({ prompt: 'cat' }, { onComplete, onError });
    expect(res.success).toBe(true);
    const slug = res.data!.slug;

    // 즉시: placeholder 박힘 (사이즈 작음)
    const beforeStat = await media.stat(slug);
    expect(beforeStat.data?.status).toBe('rendering');
    const placeholderBytes = beforeStat.data?.bytes ?? 0;

    // 백그라운드 완료 대기 — setImmediate + Promise micro task flush
    await flushAsync();
    await new Promise(r => setTimeout(r, 50));
    await flushAsync();

    // 완료 후: status='done' + 실제 이미지로 binary 교체
    const afterStat = await media.stat(slug);
    expect(afterStat.data?.status).toBe('done');
    expect(afterStat.data?.bytes).toBeGreaterThan(placeholderBytes);
    expect(media._store.get(slug)?.binary.toString()).toContain('REAL-IMAGE-BYTES');

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].slug).toBe(slug);
    expect(onError).not.toHaveBeenCalled();
  });

  it('백그라운드 실패 시 status=error + errorMsg + onError 콜백', async () => {
    const media = makeMediaPort();
    const imageGen = makeImageGen({ fail: true });
    const mgr = new MediaManager(imageGen, media, makeProcessor(), makeVault(), makeLogger());

    const onComplete = vi.fn();
    const onError = vi.fn();
    const res = await mgr.startGenerate({ prompt: 'fail' }, { onComplete, onError });
    expect(res.success).toBe(true);
    const slug = res.data!.slug;

    // 백그라운드 실패 대기
    await flushAsync();
    await new Promise(r => setTimeout(r, 50));
    await flushAsync();

    const afterStat = await media.stat(slug);
    expect(afterStat.data?.status).toBe('error');
    expect(afterStat.data?.errorMsg).toContain('실패');

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('placeholder 저장 실패 시 즉시 error 반환 (백그라운드 안 시작)', async () => {
    const media = makeMediaPort();
    // media.save 가 실패하도록 override
    const failingMedia = {
      ...media,
      save: vi.fn(async () => ({ success: false as const, error: 'disk full' })),
    };
    const imageGen = makeImageGen();
    const mgr = new MediaManager(imageGen, failingMedia as any, makeProcessor(), makeVault(), makeLogger());

    const onComplete = vi.fn();
    const res = await mgr.startGenerate({ prompt: 'cat' }, { onComplete });
    expect(res.success).toBe(false);
    expect(res.error).toBe('disk full');

    // 백그라운드 시작 안 됐으므로 onComplete 콜백 없음
    await flushAsync();
    await new Promise(r => setTimeout(r, 30));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('placeholder URL 이 실제 디스크 파일과 1:1 매핑 — 페이지 reload 시 swap 가능', async () => {
    const media = makeMediaPort();
    const imageGen = makeImageGen({ binary: Buffer.from('FINAL-IMAGE') });
    const mgr = new MediaManager(imageGen, media, makeProcessor(), makeVault(), makeLogger());

    const res = await mgr.startGenerate({ prompt: 'hero' });
    const { slug, url } = res.data!;

    // URL 이 slug 기반 — 페이지가 이 URL 박으면 reload 시 디스크에서 진짜 파일 서빙
    expect(url).toContain(slug);

    // 즉시 시점: placeholder
    const placeholderBuf = media._store.get(slug)?.binary;
    expect(placeholderBuf?.toString()).toContain('PLACEHOLDER');

    // 백그라운드 완료 후: 같은 slug 의 binary 가 실제 이미지로 swap
    await flushAsync();
    await new Promise(r => setTimeout(r, 50));
    await flushAsync();

    const finalBuf = media._store.get(slug)?.binary;
    expect(finalBuf?.toString()).toContain('FINAL-IMAGE');
    // URL 은 그대로 — 페이지 spec 의 URL 변경 불필요
  });
});

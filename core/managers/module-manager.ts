import type { ISandboxPort, IStoragePort, IVaultPort, ModuleOutput } from '../ports';
import type { InfraResult } from '../types';
import { vkModuleSettings } from '../vault-keys';
import { mergeTokens, type DesignTokens } from '../../lib/design-tokens';

interface SystemEntry {
  name: string;
  description: string;
  runtime: string;
  type: string;   // 'service' | 'module'
  scope: string;  // 'system' | 'user'
  enabled: boolean;
}

/**
 * Module Manager — 모듈 실행 + 시스템 모듈/서비스 관리
 *
 * 인프라: ISandboxPort, IStoragePort, IVaultPort
 */
export class ModuleManager {
  constructor(
    private readonly sandbox: ISandboxPort,
    private readonly storage: IStoragePort,
    private readonly vault: IVaultPort,
  ) {}

  /** 경로 지정 직접 실행 (EXECUTE, 파이프라인 등).
   *  opts.onProgress 가 있으면 모듈 stdout 의 `[STATUS] {...}` 라인 실시간 파싱해 호출 (Step 5: Sandbox 스트리밍). */
  async execute(targetPath: string, inputData: Record<string, unknown>, opts?: import('../ports').SandboxExecuteOpts): Promise<InfraResult<ModuleOutput>> {
    return this.sandbox.execute(targetPath, inputData, opts);
  }

  /** 모듈명으로 실행 — 엔트리 파일 자동 탐색 (Form bindModule 전용) */
  async run(moduleName: string, inputData: Record<string, unknown>): Promise<InfraResult<ModuleOutput>> {
    if (moduleName.includes('..') || moduleName.includes('/') || moduleName.includes('\\')) {
      return { success: false, error: '잘못된 모듈 이름입니다.' };
    }

    const dirResult = await this.storage.listDir(`user/modules/${moduleName}`);
    if (!dirResult.success || !dirResult.data) {
      return { success: false, error: `모듈을 찾을 수 없습니다: ${moduleName}` };
    }

    const entries = ['main.py', 'index.js', 'index.mjs', 'main.php', 'main.sh'];
    const files = dirResult.data.filter(e => !e.isDirectory).map(e => e.name);
    const entry = entries.find(e => files.includes(e));
    if (!entry) {
      return { success: false, error: '모듈 엔트리 파일을 찾을 수 없습니다.' };
    }

    return this.sandbox.execute(`user/modules/${moduleName}/${entry}`, inputData);
  }

  /** 시스템 모듈 목록 (system/modules/ — type: module) */
  async listSystemModules(): Promise<SystemEntry[]> {
    return this.scanDir('system/modules', 'module');
  }

  /** 시스템 서비스 목록 (system/services/ — type: service) */
  async listSystemServices(): Promise<SystemEntry[]> {
    return this.scanDir('system/services', 'service');
  }

  /** 시스템 모듈+서비스 통합 목록 */
  async listSystem(): Promise<SystemEntry[]> {
    const [services, modules] = await Promise.all([
      this.listSystemServices(),
      this.listSystemModules(),
    ]);
    return [...services, ...modules];
  }

  /** 유저 모듈 목록 (user/modules/) — 외부 IDE 의 AI 가 기존 모듈 카탈로그 파악용 */
  async listUserModules(): Promise<SystemEntry[]> {
    return this.scanDir('user/modules', 'module');
  }

  /** 모듈 config.json 직접 파싱 응답 — 외부 AI 가 read_file 한 단계 우회.
   *  scope='system' 이면 system/modules/ + system/services/ 검색. 'user' 면 user/modules/.
   *  반환: 파싱된 config 객체 또는 null. */
  async getModuleConfig(scope: 'system' | 'user', name: string): Promise<Record<string, unknown> | null> {
    if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
    const candidates = scope === 'user'
      ? [`user/modules/${name}/config.json`]
      : [`system/modules/${name}/config.json`, `system/services/${name}/config.json`];
    for (const path of candidates) {
      const file = await this.storage.read(path);
      if (file.success && file.data) {
        try {
          return JSON.parse(file.data) as Record<string, unknown>;
        } catch {}
      }
    }
    return null;
  }

  /** 디렉토리 스캔 — config.json 읽기 */
  private async scanDir(dirPath: string, defaultType: string): Promise<SystemEntry[]> {
    const result = await this.storage.listDir(dirPath);
    if (!result.success || !result.data) return [];

    const entries: SystemEntry[] = [];
    for (const entry of result.data) {
      if (!entry.isDirectory) continue;
      const file = await this.storage.read(`${dirPath}/${entry.name}/config.json`);
      if (!file.success || !file.data) continue;
      try {
        const parsed = JSON.parse(file.data);
        const moduleName = parsed.name || entry.name;
        entries.push({
          name: moduleName,
          description: parsed.description || '',
          runtime: parsed.runtime || 'none',
          type: parsed.type || defaultType,
          scope: parsed.scope || 'system',
          enabled: this.isEnabled(moduleName),
        });
      } catch {}
    }
    return entries;
  }

  /** 모듈/서비스 활성화 여부 (기본 true — 하위 호환) */
  isEnabled(name: string): boolean {
    const settings = this.getSettings(name);
    return settings.enabled !== false; // 미설정 시 true
  }

  /** 모듈/서비스 활성화/비활성화 토글 */
  setEnabled(name: string, enabled: boolean): boolean {
    const settings = this.getSettings(name);
    settings.enabled = enabled;
    return this.setSettings(name, settings);
  }

  /** 시스템 모듈/서비스 설정 조회 */
  getSettings(name: string): Record<string, any> {
    const raw = this.vault.getSecret(vkModuleSettings(name));
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }

  /** 시스템 모듈/서비스 설정 저장 */
  setSettings(name: string, settings: Record<string, any>): boolean {
    return this.vault.setSecret(vkModuleSettings(name), JSON.stringify(settings));
  }

  /** 모듈/서비스 config.json 원본 조회 */
  async getConfig(name: string): Promise<Record<string, unknown> | null> {
    for (const dir of ['system/modules', 'system/services', 'user/modules']) {
      const file = await this.storage.read(`${dir}/${name}/config.json`);
      if (file.success && file.data) {
        try { return JSON.parse(file.data); } catch { return null; }
      }
    }
    return null;
  }

  /** SEO → CMS lazy migration — cms 키 비어있고 seo 키 있으면 1회 복사.
   *  마이그레이션 후 옛 seo 키는 그대로 둠 (rollback 안전망 — 추후 정리). */
  private migrateSeoToCms(): void {
    const cmsRaw = this.vault.getSecret(vkModuleSettings('cms'));
    if (cmsRaw) return; // 이미 마이그레이션됨 (또는 신규 설치)
    const seoRaw = this.vault.getSecret(vkModuleSettings('seo'));
    if (!seoRaw) return; // 옛 데이터 없음
    this.vault.setSecret(vkModuleSettings('cms'), seoRaw);
  }

  /** CMS 서비스 설정 조회 (편의 메서드). 이전 SEO 모듈에서 확장 — 사이트 메타·테마·레이아웃·SEO·OG 통합. */
  getCmsSettings(): {
    sitemapEnabled: boolean;
    rssEnabled: boolean;
    robotsTxt: string;
    headScripts: string;
    bodyScripts: string;
    siteTitle: string;
    siteDescription: string;
    ogBgColor: string;
    ogAccentColor: string;
    ogDomain: string;
    siteUrl: string;
    jsonLdEnabled: boolean;
    jsonLdOrganization: string;
    jsonLdLogoUrl: string;
    /** HTML lang 속성 — 검색엔진 언어 인식 + 접근성. 기본 'ko'. */
    siteLang: string;
    /** Twitter Card 타입 — summary 또는 summary_large_image. 기본 large_image (블로그·랜딩 이미지 잘 표시). */
    twitterCardType: 'summary' | 'summary_large_image';
    /** @username 형식 — 사이트 자체의 트위터 계정 (선택) */
    twitterSite: string;
    /** @username 형식 — 작성자 트위터 계정 (선택) */
    twitterCreator: string;
    /** 자동 canonical URL — 페이지가 head.canonical 미지정 시 siteUrl + slug 자동 생성. 기본 true. */
    autoCanonical: boolean;
    /** 커스텀 favicon URL — 미지정 시 Next.js 기본 (app/icon.svg). /user/media/... 또는 외부 URL 가능. */
    faviconUrl: string;
    /** ads.txt 콘텐츠 — `https://{domain}/ads.txt` 로 정적 응답. AdSense / 다른 ad 네트워크 publisher 인증용.
     *  형식: `google.com, pub-XXX, DIRECT, f08c47fec0942fa0` (한 줄 또는 여러 줄).
     *  @deprecated 2026-04-28 — `verifications` 배열의 `ads.txt` 항목으로 통합. 호환성 위해 유지. */
    adsTxt: string;
    /** 사이트 소유권 인증 파일 통합 시스템 — (filename, content) 페어 N개 자유 등록.
     *  middleware 가 `/{filename}` path 매칭 시 raw 응답.
     *  AdSense ads.txt / Google site verification (`google{code}.html`) /
     *  Naver Search Advisor (`naver{code}.html`) / Bing IndexNow (`BingSiteAuth.xml`) /
     *  Yandex (`yandex_{code}.html`) 등 모든 인증 서비스 통일. 새 서비스 = 코드 변경 0, 어드민 entry 추가만.
     *  Content-Type 확장자 자동 추론 (.txt/.html/.xml). */
    verifications: Array<{ filename: string; content: string }>;
    /** Design Tokens — 색·폰트·레이아웃·heading 스타일 통합. 22 컴포넌트 일관 적용.
     *  미설정 시 lib/design-tokens.ts 의 DEFAULT_TOKENS (Slate Pro + Pretendard + 1200px). */
    theme: DesignTokens;
  } {
    this.migrateSeoToCms();
    const s = this.getSettings('cms');
    return {
      sitemapEnabled: s.sitemapEnabled ?? true,
      rssEnabled: s.rssEnabled ?? true,
      robotsTxt: s.robotsTxt || 'User-agent: *\nAllow: /\nDisallow: /api\nDisallow: /admin',
      headScripts: s.headScripts ?? '',
      bodyScripts: s.bodyScripts ?? '',
      siteTitle: s.siteTitle || 'Firebat',
      siteDescription: s.siteDescription || 'Just Imagine. Firebat Runs.',
      ogBgColor: s.ogBgColor || '#f8fafc',
      ogAccentColor: s.ogAccentColor || '#2563eb',
      ogDomain: s.ogDomain ?? '',
      siteUrl: s.siteUrl ?? '',
      jsonLdEnabled: s.jsonLdEnabled ?? true,
      jsonLdOrganization: s.jsonLdOrganization || 'Firebat',
      jsonLdLogoUrl: s.jsonLdLogoUrl ?? '',
      siteLang: s.siteLang || 'ko',
      twitterCardType: (s.twitterCardType === 'summary' ? 'summary' : 'summary_large_image') as 'summary' | 'summary_large_image',
      twitterSite: s.twitterSite ?? '',
      twitterCreator: s.twitterCreator ?? '',
      autoCanonical: s.autoCanonical ?? true,
      faviconUrl: s.faviconUrl ?? '',
      adsTxt: s.adsTxt ?? '',
      verifications: this.resolveVerifications(s),
      theme: mergeTokens(s.theme),
    };
  }

  /** verifications 배열 해석 — 옛 `adsTxt` 단일 필드와 신규 `verifications` 배열 통합.
   *  옛 adsTxt 가 비어있지 않고 verifications 에 'ads.txt' 항목 없으면 자동 prepend.
   *  사용자가 verifications 직접 편집해 'ads.txt' 추가/삭제하면 그 결과가 우선. */
  private resolveVerifications(s: Record<string, any>): Array<{ filename: string; content: string }> {
    const explicit: Array<{ filename: string; content: string }> = Array.isArray(s.verifications)
      ? s.verifications.filter((v: any) => v && typeof v.filename === 'string' && typeof v.content === 'string')
      : [];
    const adsTxt = (s.adsTxt ?? '').trim();
    const hasAdsTxtEntry = explicit.some(v => v.filename === 'ads.txt');
    if (adsTxt && !hasAdsTxtEntry) {
      // 옛 adsTxt 자동 변환 — verifications 시스템 단일 source 화
      return [{ filename: 'ads.txt', content: adsTxt }, ...explicit];
    }
    return explicit;
  }

  /** @deprecated 2026-04-28 — `getCmsSettings()` 사용. SEO 모듈이 CMS 로 확장됨.
   *  호출처 점진 마이그레이션 위한 alias — 동작 동일. */
  getSeoSettings() {
    return this.getCmsSettings();
  }
}

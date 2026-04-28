import { notFound, redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCore } from '../../../lib/singleton';
import { ComponentRenderer } from './components';
import { BASE_URL } from '../../../infra/config';
import { headers } from 'next/headers';

/** 실제 사용할 base URL 해석 —
 *   1. SEO 설정의 siteUrl (관리자가 Firebat 설정에서 입력, 최우선)
 *   2. NEXT_PUBLIC_BASE_URL env
 *   3. 요청 헤더 host (nginx X-Forwarded-Host / Host)
 *   4. infra/config BASE_URL (env 폴백 또는 localhost:3000)
 * 범용 플랫폼이라 특정 도메인 하드코딩 배제 — 배포 환경이 자체적으로 값 제공. */
async function resolveBaseUrl(seoSiteUrl?: string): Promise<string> {
  if (seoSiteUrl) return seoSiteUrl.replace(/\/$/, '');
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, '');
  try {
    const h = await headers();
    const host = h.get('x-forwarded-host') || h.get('host');
    if (host) {
      const proto = h.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
      return `${proto}://${host}`;
    }
  } catch { /* headers() 접근 실패 — 폴백 */ }
  return BASE_URL;
}
import { PasswordGate } from './password-gate';
import { ProjectRootView } from './project-root';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

/** URL 인코딩된 한글 slug를 안전하게 디코딩 (catch-all 세그먼트 배열 지원) */
function safeDecodeSlug(slugArr: string[] | string): string {
  const raw = Array.isArray(slugArr) ? slugArr.map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).join('/') : (() => {
    try { return decodeURIComponent(slugArr); } catch { return slugArr; }
  })();
  return raw;
}

/** 페이지 visibility를 해석 (페이지 자체 → 프로젝트 상속 → 기본 public) */
function resolveVisibility(spec: { _visibility?: string; project?: string }): 'public' | 'password' | 'private' {
  const pageVis = spec._visibility;
  if (pageVis === 'private' || pageVis === 'password') return pageVis;
  // 프로젝트 상속
  if (spec.project) {
    const projectVis = getCore().getProjectVisibility(spec.project);
    if (projectVis === 'private' || projectVis === 'password') return projectVis;
  }
  return 'public';
}

type Props = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const core = getCore();
  const result = await core.getPage(slug);
  if (!result.success || !result.data) {
    // projectRoot fallback — 1-segment URL 이 프로젝트명과 매칭되면 프로젝트 카탈로그 metadata
    if (!slug.includes('/')) {
      const projects = await core.scanProjects();
      if (projects.find((p) => p.name === slug)) {
        const seo = core.getCmsSettings();
        return {
          title: `${slug} — ${seo.siteTitle}`,
          description: `${slug} 프로젝트의 모든 글`,
          robots: 'index, follow',
        };
      }
    }
    return { title: 'Not Found' };
  }

  const spec = result.data;
  const visibility = resolveVisibility(spec);

  // 비공개 페이지는 메타데이터 최소화
  if (visibility === 'private') return { title: 'Not Found' };
  // 비밀번호 페이지는 noindex
  if (visibility === 'password') {
    return {
      title: spec.head?.title ?? slug,
      robots: 'noindex, nofollow',
    };
  }

  const head = spec.head ?? {};
  const seo = core.getCmsSettings();
  const baseUrl = await resolveBaseUrl(seo.siteUrl);

  const ogTitle = head.og?.title ?? head.title ?? slug;
  const ogDesc = head.og?.description ?? head.description ?? seo.siteDescription;
  // og:image 가드 — head.og.image 가 우리 미디어 URL 이면 처리 완료 여부 확인.
  // 미완료 (rendering/error/legacy 손상) 시 자동 OG 로 폴백 — SNS·검색엔진이 placeholder 를
  // 캐싱하지 않도록 보호 (외부 캐시는 회복 어려움).
  const fallbackOg = `${baseUrl}/api/og?title=${encodeURIComponent(ogTitle)}&description=${encodeURIComponent(ogDesc)}`;
  let ogImage = fallbackOg;
  if (head.og?.image) {
    const ready = await core.isMediaReady(head.og.image);
    ogImage = ready ? head.og.image : fallbackOg;
  }

  // canonical — 사용자가 head.canonical 명시하면 우선, 아니면 SEO 의 autoCanonical 옵션 따라 siteUrl + slug 자동 생성.
  const canonical = head.canonical
    ?? (seo.autoCanonical ? `${baseUrl}/${slug}` : undefined);

  return {
    // metadataBase override — layout 의 정적 값 대신 동적 resolve 결과 사용 (상대경로 이미지도 이 기준으로 절대화)
    metadataBase: new URL(baseUrl),
    title: head.title ?? slug,
    description: head.description ?? '',
    keywords: head.keywords ?? [],
    robots: head.robots ?? 'index, follow',
    ...(canonical ? { alternates: { canonical } } : {}),
    openGraph: {
      title: ogTitle,
      description: ogDesc,
      images: [ogImage],
      type: (head.og?.type as any) ?? 'website',
      url: canonical,
      siteName: seo.siteTitle,
    },
    twitter: {
      card: seo.twitterCardType,
      title: ogTitle,
      description: ogDesc,
      images: [ogImage],
      ...(seo.twitterSite ? { site: seo.twitterSite } : {}),
      ...(seo.twitterCreator ? { creator: seo.twitterCreator } : {}),
    },
    other: Object.fromEntries(
      (head.meta ?? []).map((m: any) => [m.name ?? m.property, m.content])
    ),
  };
}

export default async function DynamicPage({ params }: Props) {
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const core = getCore();
  const result = await core.getPage(slug);
  if (!result.success || !result.data) {
    // 리디렉트 테이블 확인 — slug 변경/프로젝트 이동된 페이지 자동 이동
    const redirectTo = await core.getPageRedirect(slug);
    if (redirectTo) redirect(`/${redirectTo}`);
    // projectRoot fallback — 1-segment URL 이고 그 이름이 프로젝트로 등록되어 있으면
    // 해당 프로젝트의 모든 page list 페이지 렌더 (Phase 4 Step 3).
    if (!slug.includes('/')) {
      const projects = await core.scanProjects();
      const matched = projects.find((p) => p.name === slug);
      if (matched) {
        return <ProjectRootView projectName={slug} pageSlugs={matched.pageSlugs} />;
      }
    }
    notFound();
  }

  const spec = result.data;
  const visibility = resolveVisibility(spec);

  // 비공개 페이지 — 404 처리
  if (visibility === 'private') notFound();

  // 비밀번호 보호 페이지 — 쿠키 검증 후 미인증이면 폼 표시
  if (visibility === 'password') {
    const isProjectPassword = spec._visibility !== 'password' && !!spec.project;
    const cookieStore = await cookies();
    const cookieKey = isProjectPassword ? `fp_${spec.project}` : `fp_${slug}`;
    const savedPw = cookieStore.get(cookieKey)?.value;

    // 쿠키에 저장된 비밀번호가 있으면 검증
    let verified = false;
    if (savedPw) {
      const pw = decodeURIComponent(savedPw);
      if (isProjectPassword && spec.project) {
        verified = core.verifyProjectPassword(spec.project, pw);
      } else {
        const res = await core.verifyPagePassword(slug, pw);
        verified = res.success && res.data === true;
      }
    }

    if (!verified) {
      return (
        <PasswordGate
          slug={slug}
          title={spec.head?.title ?? slug}
          isProjectPassword={isProjectPassword}
          projectName={spec.project}
        />
      );
    }
  }

  const head = spec.head ?? {};
  const body = spec.body ?? [];
  const seo = core.getCmsSettings();
  const siteUrl = await resolveBaseUrl(seo.siteUrl);

  // CMS Phase 3 — 프로젝트별 theme override.
  // user/projects/{name}/config.json 의 theme 가 글로벌 cms theme 위에 override.
  // 페이지 spec.project 매칭 시 wrapper 에 inline CSS var 박아 :root override.
  let projectThemeStyle: React.CSSProperties | undefined;
  let projectCustomCss: string | undefined;
  let projectH1Style: string | undefined;
  let projectH2Style: string | undefined;
  let projectH3Style: string | undefined;
  if (spec.project) {
    const projectConfig = await core.getProjectConfig(spec.project);
    if (projectConfig) {
      const theme = projectConfig.theme as any;
      if (theme && typeof theme === 'object') {
        const vars: Record<string, string> = {};
        if (theme.colors?.primary) vars['--cms-primary'] = String(theme.colors.primary);
        if (theme.colors?.accent) vars['--cms-accent'] = String(theme.colors.accent);
        if (theme.colors?.up) vars['--cms-up'] = String(theme.colors.up);
        if (theme.colors?.down) vars['--cms-down'] = String(theme.colors.down);
        if (theme.colors?.text) vars['--cms-text'] = String(theme.colors.text);
        if (theme.colors?.textMuted) vars['--cms-text-muted'] = String(theme.colors.textMuted);
        if (theme.colors?.bg) vars['--cms-bg'] = String(theme.colors.bg);
        if (theme.colors?.bgCard) vars['--cms-bg-card'] = String(theme.colors.bgCard);
        if (theme.colors?.border) vars['--cms-border'] = String(theme.colors.border);
        if (theme.fonts?.body) vars['--cms-font-body'] = String(theme.fonts.body);
        if (theme.fonts?.heading) vars['--cms-font-heading'] = String(theme.fonts.heading);
        if (theme.layout?.contentMaxWidth) vars['--cms-content-max-width'] = String(theme.layout.contentMaxWidth);
        if (theme.layout?.paddingMobile) vars['--cms-padding-mobile'] = String(theme.layout.paddingMobile);
        if (theme.layout?.paddingTablet) vars['--cms-padding-tablet'] = String(theme.layout.paddingTablet);
        if (theme.layout?.paddingDesktop) vars['--cms-padding-desktop'] = String(theme.layout.paddingDesktop);
        if (theme.layout?.radius) vars['--cms-radius'] = String(theme.layout.radius);
        if (Object.keys(vars).length > 0) projectThemeStyle = vars as React.CSSProperties;
        if (theme.heading?.h1) projectH1Style = String(theme.heading.h1);
        if (theme.heading?.h2) projectH2Style = String(theme.heading.h2);
        if (theme.heading?.h3) projectH3Style = String(theme.heading.h3);
      }
      if (typeof projectConfig.customCss === 'string') projectCustomCss = projectConfig.customCss;
    }
  }

  // 페이지별 JSON-LD (WebPage)
  const pageJsonLd = seo.jsonLdEnabled ? {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${siteUrl}/${slug}`,
    url: `${siteUrl}/${slug}`,
    name: head.title ?? slug,
    description: head.description ?? seo.siteDescription,
    isPartOf: { '@id': `${siteUrl}/#website` },
  } : null;

  return (
    <>
      {pageJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(pageJsonLd) }}
        />
      )}
      {(head.scripts ?? []).map((s: any, i: number) => (
        <script key={i} src={s.src} async={s.async} crossOrigin={s.crossorigin} {...(s['data-ad-client'] ? { 'data-ad-client': s['data-ad-client'] } : {})} />
      ))}

      {(head.styles ?? []).map((s: any, i: number) => (
        <link key={i} rel="stylesheet" href={s.href} />
      ))}

      {/* 일반 본문 레이아웃 — Html 단일 블록도 동일 패턴 (이전 풀스크린 srcDoc 분기 제거).
       *  사유: srcDoc 안엔 AdSense ad script·SEO 인덱싱 모두 차단되어 광고 수익·검색 노출 0.
       *  render_iframe 단독 사용은 cron-agent 프롬프트에서 차단 (반드시 render_* 분리 사용).
       *  firebat-cms-content — Design Tokens 기반 max-width/padding/font.
       *  data-h*-style — heading style 6 옵션 (CSS 분기). */}
      {/* 프로젝트별 customCss — Phase 3. 글로벌 head/body 스크립트 위에 추가 적용. */}
      {projectCustomCss && (
        <style dangerouslySetInnerHTML={{ __html: projectCustomCss }} />
      )}
      <main className="min-h-screen bg-white">
        <div
          className="firebat-cms-content"
          data-h1-style={projectH1Style ?? seo.theme.heading.h1}
          data-h2-style={projectH2Style ?? seo.theme.heading.h2}
          data-h3-style={projectH3Style ?? seo.theme.heading.h3}
          style={projectThemeStyle}
        >
          <ComponentRenderer components={body} />
        </div>
      </main>
    </>
  );
}

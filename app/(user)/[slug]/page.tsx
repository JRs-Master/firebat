import { notFound } from 'next/navigation';
import { cookies } from 'next/headers';
import { getCore } from '../../../lib/singleton';
import { ComponentRenderer } from './components';
import { BASE_URL } from '../../../infra/config';
import { PasswordGate } from './password-gate';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

/** URL 인코딩된 한글 slug를 안전하게 디코딩 */
function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

/** 페이지 visibility를 해석 (페이지 자체 → 프로젝트 상속 → 기본 public) */
function resolveVisibility(spec: any): 'public' | 'password' | 'private' {
  const pageVis = spec._visibility;
  if (pageVis === 'private' || pageVis === 'password') return pageVis;
  // 프로젝트 상속
  if (spec.project) {
    const projectVis = getCore().getProjectVisibility(spec.project);
    if (projectVis === 'private' || projectVis === 'password') return projectVis;
  }
  return 'public';
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const core = getCore();
  const result = await core.getPage(slug);
  if (!result.success) return { title: 'Not Found' };

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
  const seo = core.getSeoSettings();

  const ogTitle = head.og?.title ?? head.title ?? slug;
  const ogDesc = head.og?.description ?? head.description ?? seo.siteDescription;
  const ogImage = head.og?.image ||
    `${BASE_URL}/api/og?title=${encodeURIComponent(ogTitle)}&description=${encodeURIComponent(ogDesc)}`;

  return {
    title: head.title ?? slug,
    description: head.description ?? '',
    keywords: head.keywords ?? [],
    robots: head.robots ?? 'index, follow',
    ...(head.canonical ? { alternates: { canonical: head.canonical } } : {}),
    openGraph: {
      title: ogTitle,
      description: ogDesc,
      images: [ogImage],
      type: (head.og?.type as any) ?? 'website',
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
  if (!result.success) notFound();

  const spec = result.data;
  const visibility = resolveVisibility(spec);

  // 비공개 페이지 — 404 처리
  if (visibility === 'private') notFound();

  // 비밀번호 보호 페이지 — 쿠키 검증 후 미인증이면 폼 표시
  if (visibility === 'password') {
    const isProjectPassword = spec._visibility !== 'password' && spec.project;
    const cookieStore = await cookies();
    const cookieKey = isProjectPassword ? `fp_${spec.project}` : `fp_${slug}`;
    const savedPw = cookieStore.get(cookieKey)?.value;

    // 쿠키에 저장된 비밀번호가 있으면 검증
    let verified = false;
    if (savedPw) {
      const pw = decodeURIComponent(savedPw);
      if (isProjectPassword) {
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
  const seo = core.getSeoSettings();
  const siteUrl = seo.siteUrl || BASE_URL;

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

      {/* Html 단독 페이지는 여백 없이 풀스크린 */}
      {body.length === 1 && body[0].type === 'Html' ? (
        <main className="h-dvh bg-white overflow-hidden">
          <ComponentRenderer components={body} fullHeight />
        </main>
      ) : (
        <main className="min-h-screen bg-white">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
            <ComponentRenderer components={body} />
          </div>
        </main>
      )}
    </>
  );
}

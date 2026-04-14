import { notFound } from 'next/navigation';
import { getCore } from '../../../lib/singleton';
import { ComponentRenderer } from './components';
import { BASE_URL } from '../../../infra/config';
import type { Metadata } from 'next';

export const dynamic = 'force-dynamic';

/** URL 인코딩된 한글 slug를 안전하게 디코딩 */
function safeDecodeSlug(slug: string): string {
  try { return decodeURIComponent(slug); }
  catch { return slug; }
}

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const rawSlug = (await params).slug;
  const slug = safeDecodeSlug(rawSlug);
  const core = getCore();
  const result = await core.getPage(slug);
  if (!result.success) return { title: 'Not Found' };

  const spec = result.data;
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
  const result = await getCore().getPage(slug);
  if (!result.success) notFound();

  const spec = result.data;
  const head = spec.head ?? {};
  const body = spec.body ?? [];

  return (
    <>
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

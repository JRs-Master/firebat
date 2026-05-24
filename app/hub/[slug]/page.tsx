import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface Ctx { params: Promise<{ slug: string }> }

/**
 * Hub URL 호환 layer — 옛 /hub/<slug> URL → /<slug> redirect.
 *
 * 진짜 hub page 는 app/(user)/[...slug]/page.tsx 의 hub fallback 안에서 admin chat
 * UI 직접 mount (사용자 의도 — URL 짧고 자연). 본 route 는 외부에 노출된 옛 /hub/<slug> 링크 호환만.
 */
export default async function HubPage({ params }: Ctx) {
  const { slug } = await params;
  redirect(`/${slug}`);
}

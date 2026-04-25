import type { Metadata } from 'next';
import { getCore } from '../../../lib/singleton';
import { SharedMessageList } from './client';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic'; // 매 요청마다 DB 조회 (공유 만료 실시간 반영)

type PageProps = { params: Promise<{ slug: string }> };

async function loadShare(slug: string) {
  const core = getCore();
  const res = await core.getShare(slug);
  if (!res.success || !res.data) return null;
  return res.data;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const share = await loadShare(slug);
  if (!share) {
    return {
      title: '만료된 공유 링크 — Firebat',
      robots: { index: false, follow: false },
    };
  }
  // 첫 user 메시지로 설명 자동 생성
  const firstUser = (share.messages as Array<{ role?: string; content?: string }>).find(m => m.role === 'user');
  const description = typeof firstUser?.content === 'string' ? firstUser.content.slice(0, 200) : 'Firebat 에서 공유된 대화';
  const hdrs = await headers();
  // baseUrl 우선순위: NEXT_PUBLIC_BASE_URL → 요청 host (nginx 자동 전달) → localhost 폴백
  let baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? '';
  if (!baseUrl) {
    const host = hdrs.get('x-forwarded-host') || hdrs.get('host');
    if (host) {
      const proto = hdrs.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
      baseUrl = `${proto}://${host}`;
    } else {
      baseUrl = 'http://localhost:3000';
    }
  }
  baseUrl = baseUrl.replace(/\/$/, '');
  const shareUrl = `${baseUrl}/share/${slug}`;
  return {
    title: `${share.title} — Firebat 공유`,
    description,
    robots: { index: false, follow: false, nocache: true },
    openGraph: {
      title: share.title,
      description,
      type: 'article',
      url: shareUrl,
      siteName: 'Firebat',
      images: [`${baseUrl}/api/og?title=${encodeURIComponent(share.title)}`],
    },
    twitter: {
      card: 'summary_large_image',
      title: share.title,
      description,
    },
  };
}

export default async function SharePage({ params }: PageProps) {
  const { slug } = await params;
  const share = await loadShare(slug);
  if (!share) {
    // 만료·미존재 — 친절한 안내 페이지 (404 대신)
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="max-w-md text-center space-y-4">
          <div className="text-6xl">⏱️</div>
          <h1 className="text-2xl font-bold text-slate-800">공유 링크가 만료되었습니다</h1>
          <p className="text-slate-500 text-sm">공유 링크는 생성 후 24시간 동안만 유효합니다. 공유자에게 새 링크를 요청하세요.</p>
          <a href="/" className="inline-block text-blue-600 hover:text-blue-800 text-sm font-medium">Firebat 홈</a>
        </div>
      </div>
    );
  }

  const expiresInHours = Math.max(0, Math.ceil((share.expiresAt - Date.now()) / 3_600_000));
  return (
    <div className="min-h-screen bg-slate-50">
      {/* 공유 배너 — 사용자 원문 노출 방지, 고정 타이틀만 */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-slate-200 px-4 py-3">
        <div className="w-full md:w-[70%] max-w-6xl mx-auto flex items-center justify-between gap-3">
          <span className="text-sm font-bold text-slate-800">Firebat 공유</span>
          <span className="text-[11px] text-slate-400 shrink-0">{expiresInHours}시간 뒤 만료</span>
        </div>
      </header>

      {/* 메시지 리스트 (client 컴포넌트) */}
      <SharedMessageList messages={share.messages} />

      {/* 푸터 CTA */}
      <footer className="max-w-3xl mx-auto px-4 py-10 text-center border-t border-slate-200 mt-8">
        <p className="text-slate-400 text-xs">
          <a href="/" className="text-blue-500 hover:text-blue-700 font-bold">Firebat</a> 에서 생성된 공유 대화입니다.
        </p>
      </footer>
    </div>
  );
}

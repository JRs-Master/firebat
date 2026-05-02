/**
 * Widget Renderer — WidgetSlot 1개를 영역(area) 컨텍스트에서 렌더.
 *
 * Phase A: 사이드바 영역만 (수직 list 패턴). Phase B/C 에서 헤더(horizontal nav row)·
 * 푸터(column 또는 row) 패턴 추가.
 *
 * 각 widget type 은 데이터 fetch (Core listPages / listAllTags 등) 필요 시 server-side.
 * RSC — async 렌더 자연 작동.
 */
import { getCore } from '../../lib/singleton';
import DOMPurify from 'isomorphic-dompurify';
import {
  type WidgetSlot,
  type WidgetArea,
  WIDGET_CATALOG,
  resolveSlotProps,
  visibilityClass,
  isWidgetAllowed,
} from '../../lib/widget-catalog';

const HTML_WIDGET_SANITIZE = {
  ALLOWED_TAGS: ['div', 'span', 'p', 'a', 'strong', 'em', 'b', 'i', 'br', 'ul', 'ol', 'li', 'img', 'h3', 'h4', 'small', 'ins', 'script'],
  ALLOWED_ATTR: ['class', 'id', 'style', 'href', 'target', 'rel', 'src', 'alt', 'width', 'height', 'data-ad-client', 'data-ad-slot', 'data-ad-format', 'data-full-width-responsive', 'async'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#|data:image\/)/i,
};

function formatDate(s?: string, timeZone: string = 'Asia/Seoul'): string {
  if (!s) return '';
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', timeZone });
}

/** Widget section wrapper — 사이드바 / 푸터의 widget 박스. 헤더는 별도 (Phase B). */
function WidgetSection({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={className}>{children}</section>;
}

function WidgetTitle({ text }: { text?: string }) {
  if (!text || !text.trim()) return null;
  return <h3>{text}</h3>;
}

// ── 개별 Widget renderer ──

async function RecentPostsWidget({ count, title }: { count: number; title?: string }) {
  const allRes = await getCore().listPages();
  const recent = allRes.success && allRes.data
    ? allRes.data
        .filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, Math.max(1, count))
    : [];
  if (recent.length === 0) return null;
  return (
    <WidgetSection>
      <WidgetTitle text={title ?? '최근 글'} />
      <ul className="list-none p-0 flex flex-col gap-2">
        {recent.map((p) => (
          <li key={p.slug}>
            <a
              href={`/${p.slug}`}
              className="no-underline block hover:opacity-70 transition-opacity"
              style={{ color: 'var(--cms-text)' }}
            >
              <div className="text-[13px] font-medium leading-snug" style={{ color: 'var(--cms-text)' }}>
                {p.title}
              </div>
              {p.updatedAt && (
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--cms-text-muted)' }}>
                  {formatDate(p.updatedAt)}
                </div>
              )}
            </a>
          </li>
        ))}
      </ul>
    </WidgetSection>
  );
}

async function CategoryListWidget({ title }: { title?: string }) {
  const allRes = await getCore().listPages();
  const allPages = allRes.success && allRes.data
    ? allRes.data.filter((p) => p.status === 'published' && (p.visibility ?? 'public') === 'public')
    : [];
  const categoryMap = new Map<string, number>();
  for (const p of allPages) {
    if (!p.project) continue;
    categoryMap.set(p.project, (categoryMap.get(p.project) ?? 0) + 1);
  }
  const categories = [...categoryMap.entries()].sort((a, b) => b[1] - a[1]);
  if (categories.length === 0) return null;
  return (
    <WidgetSection>
      <WidgetTitle text={title ?? '카테고리'} />
      <ul className="list-none p-0 flex flex-col gap-1.5">
        {categories.map(([proj, count]) => (
          <li key={proj}>
            <a
              href={`/${encodeURIComponent(proj)}`}
              className="no-underline flex items-center justify-between gap-2 hover:opacity-70 transition-opacity"
              style={{ color: 'var(--cms-text)' }}
            >
              <span className="text-[13px] font-medium truncate">{proj}</span>
              <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--cms-text-muted)' }}>
                {count}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </WidgetSection>
  );
}

async function TagCloudWidget({ limit, title }: { limit: number; title?: string }) {
  const tags = await getCore().listAllTags();
  const top = tags.slice(0, Math.max(1, limit));
  if (top.length === 0) return null;
  const maxCount = top[0].count;
  return (
    <WidgetSection>
      <WidgetTitle text={title ?? '태그'} />
      <div className="flex flex-wrap gap-1.5">
        {top.map((t) => {
          const ratio = 0.85 + 0.3 * (t.count / Math.max(1, maxCount));
          return (
            <a
              key={t.tag}
              href={`/tag/${encodeURIComponent(t.tag)}`}
              className="no-underline inline-flex items-center px-2 py-0.5 rounded transition-opacity hover:opacity-70"
              style={{
                background: 'var(--cms-bg-card)',
                color: 'var(--cms-text)',
                border: '1px solid var(--cms-border)',
                fontSize: `${ratio}rem`,
                lineHeight: 1.4,
              }}
              title={`${t.count}개 글`}
            >
              #{t.tag}
            </a>
          );
        })}
      </div>
    </WidgetSection>
  );
}

function SearchBoxWidget({ placeholder, title }: { placeholder?: string; title?: string }) {
  return (
    <WidgetSection>
      <WidgetTitle text={title ?? '검색'} />
      <form method="get" action="/search" className="flex items-stretch gap-1.5">
        <input
          type="search"
          name="q"
          placeholder={placeholder ?? '검색어...'}
          className="flex-1 px-2.5 py-1.5 text-[13px] border rounded outline-none min-w-0"
          style={{
            background: 'var(--cms-bg-card)',
            borderColor: 'var(--cms-border)',
            color: 'var(--cms-text)',
          }}
        />
        <button
          type="submit"
          className="px-2.5 py-1.5 text-[13px] font-bold rounded transition-opacity hover:opacity-90 shrink-0"
          style={{ background: 'var(--cms-primary)', color: '#fff' }}
          aria-label="검색"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </button>
      </form>
    </WidgetSection>
  );
}

function RssSubscribeWidget({ title }: { title?: string }) {
  return (
    <WidgetSection>
      <WidgetTitle text={title ?? '구독'} />
      <div className="flex flex-col gap-1.5">
        <a
          href="/feed.xml"
          className="no-underline flex items-center gap-2 text-[13px] hover:opacity-70 transition-opacity"
          style={{ color: 'var(--cms-text)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 11a9 9 0 0 1 9 9" />
            <path d="M4 4a16 16 0 0 1 16 16" />
            <circle cx="5" cy="19" r="1" />
          </svg>
          <span>RSS 피드</span>
        </a>
      </div>
    </WidgetSection>
  );
}

function HtmlBlockWidget({ content, title }: { content?: string; title?: string }) {
  if (!content || !content.trim()) return null;
  const sanitized = DOMPurify.sanitize(content, HTML_WIDGET_SANITIZE);
  return (
    <WidgetSection>
      <WidgetTitle text={title} />
      <div dangerouslySetInnerHTML={{ __html: sanitized }} />
    </WidgetSection>
  );
}

function NavLinksWidget({ useGlobalNav, customLinks, title, area }: {
  useGlobalNav?: boolean;
  customLinks?: string;
  title?: string;
  area: WidgetArea;
}) {
  const cms = getCore().getCmsSettings();
  let links = useGlobalNav ? cms.layout.header.navLinks : [];
  if (customLinks && customLinks.trim()) {
    // "label | href" 줄별 파싱
    const parsed = customLinks.split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [label, href] = line.split('|').map(s => s.trim());
        return label && href ? { label, href } : null;
      })
      .filter((x): x is { label: string; href: string } => x !== null);
    if (parsed.length > 0) links = parsed;
  }
  if (links.length === 0) return null;
  // 헤더에서는 horizontal, 사이드바·푸터에서는 vertical
  const horizontal = area === 'header';
  return (
    <WidgetSection>
      <WidgetTitle text={title} />
      <ul className={`list-none p-0 m-0 ${horizontal ? 'flex items-center gap-3 sm:gap-5 flex-wrap' : 'flex flex-col gap-1.5'}`}>
        {links.map((l, i) => (
          <li key={i}>
            <a
              href={l.href}
              className="no-underline text-[13px] sm:text-sm font-medium hover:opacity-70 transition-opacity"
              style={{ color: 'var(--cms-text)' }}
            >
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </WidgetSection>
  );
}

function SocialLinksWidget({ items, title, area }: { items?: string; title?: string; area: WidgetArea }) {
  if (!items || !items.trim()) return null;
  const parsed = items.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [type, url] = line.split('|').map(s => s.trim());
      return type && url ? { type, url } : null;
    })
    .filter((x): x is { type: string; url: string } => x !== null);
  if (parsed.length === 0) return null;
  // 모든 area 에서 horizontal 한 줄로 표시
  return (
    <WidgetSection>
      <WidgetTitle text={title} />
      <div className="flex items-center gap-3 flex-wrap">
        {parsed.map((s, i) => (
          <a
            key={i}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={s.type}
            title={s.type}
            className="no-underline hover:opacity-70 transition-opacity"
            style={{ color: 'var(--cms-text)' }}
          >
            <SocialIcon type={s.type} />
          </a>
        ))}
      </div>
    </WidgetSection>
  );
}

function SocialIcon({ type }: { type: string }) {
  const t = type.toLowerCase();
  // 흔한 brand icons. 인식 안 되는 type 은 generic globe.
  if (t === 'twitter' || t === 'x') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>;
  }
  if (t === 'telegram') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>;
  }
  if (t === 'github') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>;
  }
  if (t === 'linkedin') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.063 2.063 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" /></svg>;
  }
  if (t === 'youtube') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></svg>;
  }
  if (t === 'instagram') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" /></svg>;
  }
  if (t === 'email' || t === 'mail') {
    return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" /></svg>;
  }
  // generic
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>;
}

function SiteNameWidget() {
  const cms = getCore().getCmsSettings();
  return (
    <WidgetSection>
      <span
        className="text-base sm:text-lg font-bold tracking-tight"
        style={{ color: 'var(--cms-text)', fontFamily: 'var(--cms-font-heading)' }}
      >
        {cms.siteTitle}
      </span>
    </WidgetSection>
  );
}

function SiteLogoWidget() {
  const cms = getCore().getCmsSettings();
  const logoUrl = cms.layout.header.logoUrl;
  if (!logoUrl) {
    // 폴백 — siteName 텍스트
    return <SiteNameWidget />;
  }
  return (
    <WidgetSection>
      <a href="/" className="inline-flex items-center gap-2 no-underline" style={{ color: 'var(--cms-text)' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt={cms.siteTitle} className="h-7 w-auto" />
      </a>
    </WidgetSection>
  );
}

function CopyrightWidget({ text }: { text?: string }) {
  const cms = getCore().getCmsSettings();
  const finalText = (text && text.trim())
    ? text
    : (cms.layout.footer.text && cms.layout.footer.text.trim())
      ? cms.layout.footer.text
      : `© ${new Date().getFullYear()} ${cms.siteTitle}. All rights reserved.`;
  const html = finalText.replace(/\n/g, '<br>');
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'strong', 'em', 'b', 'i', 'br', 'span', 'small'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|\/|#)/i,
  });
  return (
    <WidgetSection>
      <div
        className="text-[12px] sm:text-[13px] leading-relaxed"
        style={{ color: 'var(--cms-text-muted)', fontFamily: 'var(--cms-font-body)' }}
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    </WidgetSection>
  );
}

function AdSlotWidget({ slotId }: { slotId?: string }) {
  const cms = getCore().getCmsSettings();
  if (!slotId || !cms.adsense.publisherId) return null;
  return (
    <WidgetSection>
      <ins
        className="adsbygoogle"
        style={{ display: 'block' }}
        data-ad-client={cms.adsense.publisherId}
        data-ad-slot={slotId}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
      <script dangerouslySetInnerHTML={{ __html: `(adsbygoogle = window.adsbygoogle || []).push({});` }} />
    </WidgetSection>
  );
}

// ── 통합 dispatch ──

export async function CmsWidget({ slot, area }: { slot: WidgetSlot; area: WidgetArea }) {
  const meta = WIDGET_CATALOG[slot.type];
  if (!meta) return null;
  // scope 가드 — 이 영역에서 허용 안 된 widget 은 미렌더 (어드민 UI 가 대부분 차단하지만 안전망)
  if (!isWidgetAllowed(meta.scope, area)) return null;
  const props = resolveSlotProps(slot);
  const visClass = visibilityClass(slot.visibility);

  let inner: React.ReactNode = null;
  switch (slot.type) {
    case 'recent-posts':
      inner = await RecentPostsWidget({ count: Number(props.count) || 5, title: String(props.title ?? '') });
      break;
    case 'category-list':
      inner = await CategoryListWidget({ title: String(props.title ?? '') });
      break;
    case 'tag-cloud':
      inner = await TagCloudWidget({ limit: Number(props.limit) || 20, title: String(props.title ?? '') });
      break;
    case 'search-box':
      inner = SearchBoxWidget({ placeholder: String(props.placeholder ?? ''), title: String(props.title ?? '') });
      break;
    case 'rss-subscribe':
      inner = RssSubscribeWidget({ title: String(props.title ?? '') });
      break;
    case 'html-block':
      inner = HtmlBlockWidget({ content: String(props.content ?? ''), title: String(props.title ?? '') });
      break;
    case 'nav-links':
      inner = NavLinksWidget({
        useGlobalNav: props.useGlobalNav !== false,
        customLinks: String(props.customLinks ?? ''),
        title: String(props.title ?? ''),
        area,
      });
      break;
    case 'social-links':
      inner = SocialLinksWidget({ items: String(props.items ?? ''), title: String(props.title ?? ''), area });
      break;
    case 'site-name':
      inner = SiteNameWidget();
      break;
    case 'site-logo':
      inner = SiteLogoWidget();
      break;
    case 'copyright':
      inner = CopyrightWidget({ text: String(props.text ?? '') });
      break;
    case 'ad-slot':
      inner = AdSlotWidget({ slotId: String(props.slotId ?? '') });
      break;
    case 'mobile-toggle':
      // 헤더 전용 — Phase B 에서 박힐 예정. 현재는 미렌더.
      inner = null;
      break;
  }
  if (inner === null) return null;
  // visibility wrap — desktop-only / mobile-only class 적용
  if (visClass) {
    return <div className={visClass}>{inner}</div>;
  }
  return <>{inner}</>;
}

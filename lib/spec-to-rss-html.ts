/**
 * spec.body (render_* 컴포넌트 배열) → RSS content:encoded HTML 변환.
 *
 * RSS 2.0 의 content:encoded 항목은 CDATA 안 HTML 본문 — RSS reader 가 글 본문
 * 미리보기 표시. CDATA 사용으로 HTML escape 부담 없음 (단 ']]>' 시퀀스만 escape).
 *
 * 핵심 컴포넌트 (Header / Text / Table / List / Callout / Image / Divider / Html / Card / Grid /
 * Metric / KeyValue) 변환. 기타 시각화 컴포넌트 (Chart / StockChart / Timeline / Compare /
 * StatusBadge / Countdown 등) 은 RSS 텍스트 차원에 의미 없어 skip.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Block { type?: string; props?: Record<string, any> }

function renderBlock(block: Block): string {
  if (!block || typeof block !== 'object') return '';
  const t = block.type;
  const p = block.props || {};
  switch (t) {
    case 'Header': {
      const level = Math.min(Math.max(Number(p.level) || 2, 1), 6);
      return `<h${level}>${escapeHtml(String(p.text || ''))}</h${level}>`;
    }
    case 'Text':
      return `<p>${escapeHtml(String(p.content || ''))}</p>`;
    case 'Table': {
      const headers = Array.isArray(p.headers) ? p.headers : [];
      const rows = Array.isArray(p.rows) ? p.rows : [];
      const thead = headers.map((h: any) => `<th>${escapeHtml(String(h))}</th>`).join('');
      const tbody = rows.map((r: any[]) => '<tr>' + (Array.isArray(r) ? r : []).map((c: any) => `<td>${escapeHtml(String(c ?? ''))}</td>`).join('') + '</tr>').join('');
      return `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
    }
    case 'List': {
      const items = Array.isArray(p.items) ? p.items : [];
      const tag = p.ordered ? 'ol' : 'ul';
      return `<${tag}>${items.map((i: any) => `<li>${escapeHtml(String(i))}</li>`).join('')}</${tag}>`;
    }
    case 'Callout':
    case 'Alert': {
      const title = p.title ? `<strong>${escapeHtml(String(p.title))}</strong> ` : '';
      return `<blockquote>${title}${escapeHtml(String(p.message || ''))}</blockquote>`;
    }
    case 'Image':
      return p.src ? `<p><img src="${escapeHtml(String(p.src))}" alt="${escapeHtml(String(p.alt || ''))}"/></p>` : '';
    case 'Divider':
      return '<hr/>';
    case 'Html':
      // raw HTML — RSS reader 가 자체 sanitize 책임
      return String(p.content || '');
    case 'Card':
    case 'Grid': {
      const children = Array.isArray(p.children) ? p.children : [];
      return children.map(renderBlock).join('\n');
    }
    case 'Metric': {
      const label = escapeHtml(String(p.label || ''));
      const value = escapeHtml(String(p.value ?? ''));
      const unit = p.unit ? ' ' + escapeHtml(String(p.unit)) : '';
      const delta = p.delta != null ? ` (${escapeHtml(String(p.delta))})` : '';
      return `<p><strong>${label}</strong>: ${value}${unit}${delta}</p>`;
    }
    case 'KeyValue': {
      const items = Array.isArray(p.items) ? p.items : [];
      const dl = items.map((i: any) => `<dt>${escapeHtml(String(i?.key || ''))}</dt><dd>${escapeHtml(String(i?.value ?? ''))}</dd>`).join('');
      return `<dl>${dl}</dl>`;
    }
    default:
      // Chart / StockChart / Timeline / Compare / StatusBadge / Countdown / Progress / Badge 등 skip
      return '';
  }
}

/** spec.body → HTML string. 빈 배열·잘못된 입력은 '' 반환. */
export function specBodyToHtml(body: unknown): string {
  if (!Array.isArray(body)) return '';
  return body.map(renderBlock).filter(Boolean).join('\n');
}

/** CDATA 안에서 ']]>' 시퀀스 차단 (자체 escape — RSS 표준 패턴). */
export function wrapCdata(html: string): string {
  return `<![CDATA[${html.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

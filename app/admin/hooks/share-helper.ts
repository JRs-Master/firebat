'use client';

/**
 * 공유 링크 생성 헬퍼 — MessageBubble 단일턴 / Sidebar 전체대화 공용.
 * POST /api/share → URL 받아 클립보드 복사 + 토스트 알림.
 */

type ShareInput = {
  type: 'turn' | 'full';
  conversationId?: string;
  title?: string;
  messages: unknown[];
};

export async function createShareLink(input: ShareInput): Promise<{ url: string; expiresAt: number } | { error: string }> {
  try {
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const data = await res.json();
    if (!data.success) return { error: data.error || '공유 생성 실패' };
    return { url: data.url, expiresAt: data.expiresAt };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 클립보드 복사 — 공유 URL 등. secure context 우선, 실패 시 textarea fallback. */
export function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

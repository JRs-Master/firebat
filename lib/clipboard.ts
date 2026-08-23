// ── 클립보드 복사, 한 곳 ────────────────────────────────────────────────────────────────────────
// `navigator.clipboard` 는 보안 컨텍스트(HTTPS/localhost)에서만 **존재**한다. 이 서버는 아직
// HTTP 라 admin 화면에서는 undefined 이고, `if (navigator.clipboard)` 로 감싼 복사 버튼은
// 아무 일도 안 하면서 아무 말도 안 했다 — 사용자는 "복사됨" 대신 **직전 클립보드 내용이
// 붙는 것**을 본다(실측 2026-08-22). 같은 코드가 여섯 벌 있었고 셋만 폴백이 있었다.
//
// 그래서 규칙 둘:
//   1. 복사는 반드시 이 함수로 — API 가 없으면 textarea+execCommand 로 내려간다(HTTP 에서도
//      동작한다. deprecated 지만 브라우저들이 바로 이 용도로 남겨 두고 있다).
//   2. 결과(boolean)를 버리지 않는다 — 실패했으면 부르는 쪽이 그렇다고 말해야 한다.
//      침묵이 제일 나쁘다. 성공 배지가 있는 자리면 실패 배지도 있어야 한다.

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* 포커스 상실 등 — 아래 폴백이 한 번 더 시도한다 */ }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
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

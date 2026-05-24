/**
 * Hub 외부 위젯 JS — GET /api/hub/widget.js
 *
 * 외부 사이트 (워드프레스 등) 안 박히는 `<script src="...">` 영역 응답. self-contained vanilla JS —
 * 의존성 0, framework 0. data-slug / data-token / data-firebat-url 영역 script tag 자체 안 명시.
 *
 * snippet 예시 (admin HubInstanceDetail 안 자동 생성):
 *
 *   <script
 *     src="https://firebat.example.com/api/hub/widget.js"
 *     data-slug="lawassistant"
 *     data-token="32-byte-hex-token"
 *     data-firebat-url="https://firebat.example.com"
 *     async
 *   ></script>
 *
 * 위젯 동작:
 *   - 우측 하단 floating 버튼 → 클릭 시 chat panel 토글
 *   - localStorage 안 session_id (UUID) 보존 — 같은 방문자 대화 유지
 *   - POST /api/hub/<slug>/chat 의 SSE 응답 parse → 메시지 list 에 표시
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(WIDGET_JS, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

const WIDGET_JS = `(function() {
  'use strict';
  var SCRIPT = document.currentScript;
  if (!SCRIPT) {
    // legacy 브라우저 — async script 호환 영역
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf('/api/hub/widget.js') !== -1) {
        SCRIPT = scripts[i];
        break;
      }
    }
  }
  if (!SCRIPT) { console.error('[firebat-hub] script tag 추출 실패'); return; }

  var SLUG = SCRIPT.getAttribute('data-slug') || '';
  var TOKEN = SCRIPT.getAttribute('data-token') || '';
  var FIREBAT_URL = SCRIPT.getAttribute('data-firebat-url') ||
    (function() {
      var src = SCRIPT.src || '';
      var m = src.match(/^(https?:\\/\\/[^\\/]+)/);
      return m ? m[1] : '';
    })();
  // page mode (자기 사이트 /<slug> 풀스크린) — 토글 버튼 숨김 + 패널 전체 화면 + 자동 open.
  var FULLSCREEN = SCRIPT.getAttribute('data-fullscreen') === 'true';
  var TITLE_ATTR = SCRIPT.getAttribute('data-title') || '';
  var DESC_ATTR = SCRIPT.getAttribute('data-description') || '';

  if (!SLUG || !TOKEN || !FIREBAT_URL) {
    console.error('[firebat-hub] data-slug / data-token / data-firebat-url 필수');
    return;
  }

  // 같은 페이지 중복 로드 방지
  if (window.__firebatHubLoaded) return;
  window.__firebatHubLoaded = true;

  // 방문자 식별 session_id — localStorage 안 영구 (UUID v4)
  var SESSION_KEY = 'firebat-hub-session-' + SLUG;
  var sessionId = '';
  try { sessionId = localStorage.getItem(SESSION_KEY) || ''; } catch (e) {}
  if (!sessionId) {
    sessionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    try { localStorage.setItem(SESSION_KEY, sessionId); } catch (e) {}
  }

  // ─── 스타일 ─────────────────────────────────────────────────────────
  var STYLE = document.createElement('style');
  var commonStyle = [
    '#firebat-cb-header { padding: 14px 16px; border-bottom: 1px solid #e5e7eb; font-weight: 600; color: #1f2937; display: flex; align-items: center; justify-content: space-between; }',
    '#firebat-cb-close { background: transparent; border: none; cursor: pointer; color: #9ca3af; font-size: 20px; padding: 0; width: 24px; height: 24px; }',
    '#firebat-cb-messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; background: #f9fafb; }',
    '.firebat-cb-msg { padding: 8px 12px; border-radius: 12px; font-size: 14px; line-height: 1.5; max-width: 85%; word-wrap: break-word; white-space: pre-wrap; }',
    '.firebat-cb-msg.user { background: #2563eb; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }',
    '.firebat-cb-msg.ai { background: white; color: #1f2937; align-self: flex-start; border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; }',
    '.firebat-cb-msg.error { background: #fee2e2; color: #991b1b; align-self: stretch; max-width: 100%; }',
    '.firebat-cb-msg.loading { background: white; color: #9ca3af; align-self: flex-start; border: 1px solid #e5e7eb; font-style: italic; }',
    '#firebat-cb-form { padding: 12px; border-top: 1px solid #e5e7eb; display: flex; gap: 8px; }',
    '#firebat-cb-input { flex: 1; padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; font-family: inherit; }',
    '#firebat-cb-input:focus { border-color: #2563eb; }',
    '#firebat-cb-send { padding: 8px 16px; background: #2563eb; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; }',
    '#firebat-cb-send:disabled { background: #9ca3af; cursor: not-allowed; }',
  ];
  var widgetStyle = [
    '#firebat-cb-toggle { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%; background: #2563eb; color: white; border: none; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15); display: flex; align-items: center; justify-content: center; z-index: 99998; font-size: 24px; transition: transform 0.2s; }',
    '#firebat-cb-toggle:hover { transform: scale(1.05); }',
    '#firebat-cb-panel { position: fixed; right: 20px; bottom: 88px; width: 360px; height: 520px; max-height: calc(100vh - 120px); background: white; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); display: none; flex-direction: column; z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',
    '#firebat-cb-panel.open { display: flex; }',
    '@media (max-width: 480px) {',
    '  #firebat-cb-panel { right: 8px; left: 8px; bottom: 80px; width: auto; }',
    '}',
  ];
  // page mode: 토글 버튼 숨김 + 패널 전체 화면 + 콘텐츠 가운데 정렬 (Claude / ChatGPT 풀스크린 패턴).
  var fullscreenStyle = [
    '#firebat-cb-toggle { display: none !important; }',
    '#firebat-cb-close { display: none !important; }',
    '#firebat-cb-panel { position: fixed; inset: 0; width: 100vw; height: 100dvh; max-height: none; border-radius: 0; box-shadow: none; display: flex !important; flex-direction: column; z-index: 99999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: white; }',
    '#firebat-cb-messages { max-width: 760px; width: 100%; margin: 0 auto; padding: 16px 24px; box-sizing: border-box; }',
    '#firebat-cb-form { max-width: 760px; width: 100%; margin: 0 auto; padding: 16px 24px; box-sizing: border-box; }',
  ];
  STYLE.textContent = commonStyle.concat(FULLSCREEN ? fullscreenStyle : widgetStyle).join('\\n');
  document.head.appendChild(STYLE);

  // ─── DOM 영역 ──────────────────────────────────────────────────────
  // 헤더 타이틀 — page mode 면 instance.name, 위젯 모드면 기본 문구.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(ch) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch];
    });
  }
  var headerTitle = FULLSCREEN
    ? (TITLE_ATTR ? escapeHtml(TITLE_ATTR) : '챗봇')
    : '도움이 필요하신가요?';

  var toggle = document.createElement('button');
  toggle.id = 'firebat-cb-toggle';
  toggle.setAttribute('aria-label', '챗봇 열기');
  toggle.innerHTML = '\\u{1F4AC}';

  var panel = document.createElement('div');
  panel.id = 'firebat-cb-panel';
  panel.innerHTML = [
    '<div id="firebat-cb-header">',
    '  <span>' + headerTitle + '</span>',
    '  <button id="firebat-cb-close" aria-label="닫기">\\u2715</button>',
    '</div>',
    '<div id="firebat-cb-messages"></div>',
    '<form id="firebat-cb-form">',
    '  <input id="firebat-cb-input" type="text" placeholder="메시지를 입력하세요..." autocomplete="off" />',
    '  <button id="firebat-cb-send" type="submit">전송</button>',
    '</form>',
  ].join('');

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  var msgList = panel.querySelector('#firebat-cb-messages');
  var form = panel.querySelector('#firebat-cb-form');
  var input = panel.querySelector('#firebat-cb-input');
  var sendBtn = panel.querySelector('#firebat-cb-send');
  var closeBtn = panel.querySelector('#firebat-cb-close');

  // page mode: 패널 자동 open + input focus.
  if (FULLSCREEN) {
    panel.classList.add('open');
    setTimeout(function() { try { input.focus(); } catch (e) {} }, 100);
    // description 이 있으면 첫 메시지 자리에 안내문 — chat 시작 hint.
    if (DESC_ATTR) {
      var hint = document.createElement('div');
      hint.className = 'firebat-cb-msg ai';
      hint.style.alignSelf = 'center';
      hint.style.maxWidth = '100%';
      hint.style.textAlign = 'center';
      hint.style.background = 'transparent';
      hint.style.border = 'none';
      hint.style.color = '#6b7280';
      hint.textContent = DESC_ATTR;
      msgList.appendChild(hint);
    }
  }

  toggle.addEventListener('click', function() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) input.focus();
  });
  closeBtn.addEventListener('click', function() { panel.classList.remove('open'); });

  function appendMsg(role, text) {
    var el = document.createElement('div');
    el.className = 'firebat-cb-msg ' + role;
    el.textContent = text;
    msgList.appendChild(el);
    msgList.scrollTop = msgList.scrollHeight;
    return el;
  }

  // ─── SSE parse — fetch POST 응답 영역 streaming body parse ────────────
  function parseSseChunk(buf, onEvent) {
    var lines = buf.split('\\n');
    var keep = lines.pop() || '';
    var currentEvent = '';
    var dataLines = [];
    function flush() {
      if (dataLines.length === 0) return;
      var data = dataLines.join('\\n');
      try { onEvent(currentEvent, JSON.parse(data)); }
      catch (e) { /* JSON 영역 미정공 — 무시 */ }
      currentEvent = '';
      dataLines = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line === '') { flush(); continue; }
      if (line.indexOf(':') === 0) continue; // SSE comment (keepalive ping)
      var m = line.match(/^([^:]+):\\s?(.*)$/);
      if (!m) continue;
      var field = m[1];
      var value = m[2];
      if (field === 'event') currentEvent = value;
      else if (field === 'data') dataLines.push(value);
    }
    return keep;
  }

  async function sendUserMessage(text) {
    appendMsg('user', text);
    var loadingEl = appendMsg('loading', '응답 중...');
    sendBtn.disabled = true;

    try {
      var endpoint = FIREBAT_URL.replace(/\\/$/, '') + '/api/hub/' + encodeURIComponent(SLUG) + '/chat';
      var res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Token': TOKEN,
          'X-Session-Id': sessionId,
        },
        body: JSON.stringify({ message: text }),
      });

      if (!res.ok) {
        loadingEl.remove();
        var errText = '서버 오류 (HTTP ' + res.status + ')';
        try {
          var errJson = await res.json();
          if (errJson && errJson.error) errText = errJson.error;
        } catch (e) {}
        appendMsg('error', errText);
        return;
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      var gotResult = false;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        buf = parseSseChunk(buf, function(event, data) {
          if (event === 'result') {
            gotResult = true;
            loadingEl.remove();
            var reply = (data && data.reply) ? data.reply : '';
            if (data && data.error) appendMsg('error', String(data.error));
            else if (reply) appendMsg('ai', reply);
            else appendMsg('ai', '(응답 영역 비어있습니다)');
          } else if (event === 'error') {
            loadingEl.remove();
            appendMsg('error', (data && data.error) ? data.error : '오류');
          }
        });
      }

      if (!gotResult && loadingEl.parentNode) {
        loadingEl.remove();
        appendMsg('error', '응답 영역 받지 못했습니다.');
      }
    } catch (err) {
      loadingEl.remove();
      appendMsg('error', '네트워크 오류: ' + (err && err.message ? err.message : err));
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', function(e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    sendUserMessage(text);
  });
})();
`;

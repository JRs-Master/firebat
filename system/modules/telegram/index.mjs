/**
 * Firebat System Module: telegram (notification)
 * 텔레그램 봇 메시지·미디어 발송 (단방향, send only).
 *
 * 공식 문서: https://core.telegram.org/bots/api
 *
 * 액션:
 *   send-message   — 텍스트 메시지 (4096자 한도, parseMode 옵션)
 *   send-photo     — 이미지 + caption
 *   send-document  — 파일 + caption
 *   send-location  — 위도·경도
 *
 * 준비 (BotFather 흐름):
 *   1) Telegram 에서 @BotFather 검색 → /newbot → 봇 이름·username 입력 → token 발급.
 *   2) Vault 에 user:TELEGRAM_BOT_TOKEN 저장 (어드민 → 설정 → API 키 또는 모듈 설정).
 *   3) 봇한테 /start 보낸 후 https://api.telegram.org/bot<TOKEN>/getUpdates 호출 → result[0].message.chat.id 확인.
 *   4) Vault 에 user:TELEGRAM_CHAT_ID 저장.
 *
 * 양방향 webhook + 명령은 v1.x — 본 모듈은 알림 전용 단방향.
 */

const API_BASE = 'https://api.telegram.org';
const TIMEOUT = 15000;

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action || 'send-message';

    const token = process.env['TELEGRAM_BOT_TOKEN'];
    const defaultChatId = process.env['TELEGRAM_CHAT_ID'];

    if (!token) return outErr('error.bot_token_missing', {});

    const chatId = String(data?.chatId || defaultChatId || '').trim();
    if (!chatId) return outErr('error.chat_id_missing', {});

    switch (action) {
      case 'send-message':       return await handleSendMessage(token, chatId, data);
      case 'send-photo':         return await handleSendPhoto(token, chatId, data);
      case 'send-document':      return await handleSendDocument(token, chatId, data);
      case 'send-location':      return await handleSendLocation(token, chatId, data);
      default:                   return outErr('error.unknown_action', { action: String(action) });
    }
  } catch (err) {
    outErr('error.runtime', { message: err.message || String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
//  공통 fetch — timeout + 에러 메시지 정제
// ────────────────────────────────────────────────────────────────────────

async function tgRequest(token, method, payload) {
  const url = `${API_BASE}/bot${token}/${method}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) {
      if (json.description) return { ok: false, errorKey: 'error.api_description', errorParams: { description: json.description }, status: res.status };
      return { ok: false, errorKey: 'error.api_status', errorParams: { status: String(res.status) }, status: res.status };
    }
    return { ok: true, result: json.result };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, errorKey: 'error.timeout', errorParams: { seconds: String(TIMEOUT / 1000) } };
    return { ok: false, errorKey: 'error.runtime', errorParams: { message: err.message || String(err) } };
  } finally {
    clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────
//  Action 핸들러
// ────────────────────────────────────────────────────────────────────────

async function handleSendMessage(token, chatId, data) {
  const text = (data?.text ?? '').trim();
  if (!text) return outErr('error.text_empty', {});
  const payload = {
    chat_id: chatId,
    text,
    disable_notification: !!data.disableNotification,
  };
  if (data.parseMode) payload.parse_mode = data.parseMode;
  const r = await tgRequest(token, 'sendMessage', payload);
  return r.ok ? out(true, null, { messageId: r.result?.message_id }) : outErr(r.errorKey, r.errorParams);
}

async function handleSendPhoto(token, chatId, data) {
  const photo = (data?.photoUrl ?? '').trim();
  if (!photo) return outErr('error.photo_url_empty', {});
  const payload = {
    chat_id: chatId,
    photo,
    disable_notification: !!data.disableNotification,
  };
  if (data.text) payload.caption = data.text;
  if (data.parseMode) payload.parse_mode = data.parseMode;
  const r = await tgRequest(token, 'sendPhoto', payload);
  return r.ok ? out(true, null, { messageId: r.result?.message_id }) : outErr(r.errorKey, r.errorParams);
}

async function handleSendDocument(token, chatId, data) {
  const doc = (data?.documentUrl ?? '').trim();
  if (!doc) return outErr('error.document_url_empty', {});
  const payload = {
    chat_id: chatId,
    document: doc,
    disable_notification: !!data.disableNotification,
  };
  if (data.text) payload.caption = data.text;
  if (data.parseMode) payload.parse_mode = data.parseMode;
  const r = await tgRequest(token, 'sendDocument', payload);
  return r.ok ? out(true, null, { messageId: r.result?.message_id }) : outErr(r.errorKey, r.errorParams);
}

async function handleSendLocation(token, chatId, data) {
  if (typeof data?.latitude !== 'number' || typeof data?.longitude !== 'number') {
    return outErr('error.lat_lon_number_required', {});
  }
  const payload = {
    chat_id: chatId,
    latitude: data.latitude,
    longitude: data.longitude,
    disable_notification: !!data.disableNotification,
  };
  const r = await tgRequest(token, 'sendLocation', payload);
  return r.ok ? out(true, null, { messageId: r.result?.message_id }) : outErr(r.errorKey, r.errorParams);
}

// ────────────────────────────────────────────────────────────────────────
//  Output (Firebat ModuleOutput 규격)
// ────────────────────────────────────────────────────────────────────────

function out(success, error, data = null) {
  const result = success ? { success, data } : { success, error };
  process.stdout.write(JSON.stringify(result));
}

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.telegram.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  process.stdout.write(JSON.stringify(r));
}

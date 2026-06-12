/**
 * Firebat System Module: kakao-talk (notification)
 * 카카오톡 메시지 + 소셜 + 채널 + 캘린더 API
 *
 * 공식 문서: https://developers.kakao.com/docs/ko
 *
 * 액션:
 *   send-me        — 나에게 기본 템플릿 메시지 보내기
 *   send-me-scrap  — 나에게 스크랩 메시지 보내기
 *   send-friends   — 친구에게 기본 템플릿 메시지 보내기
 *   profile        — 내 카카오톡 프로필 조회
 *   friends        — 친구 목록 조회
 *   channels       — 카카오톡 채널 관계 확인
 *   calendars      — 캘린더 목록 조회
 *   create-event   — 캘린더 이벤트 생성
 *   list-events    — 캘린더 이벤트 목록 조회
 */

const KAPI = 'https://kapi.kakao.com';
const TIMEOUT = 15000;

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action || 'send-me';

    // 토큰 = 인프라(TokenProvider)가 refresh_token grant 로 발급·선제갱신해 env 로 주입한 raw access token.
    // 401 무효 시엔 인프라가 응답 data._apiStatus 를 보고 재발급 후 1회 재시도하고, 회전된 refresh_token 도
    // 인프라가 영속한다 — sysmod 는 받아쓰기만 한다 (토큰 코드 0).
    const accessToken = process.env['KAKAO_ACCESS_TOKEN'];
    if (!accessToken) return outErr('error.access_token_missing', {});

    // 핸들러 반환 규약:
    // - { _errorKey, _errorParams? } → 검증 에러 (i18n)
    // - { _status, _statusBody } → kapi 호출 실패. 401 은 data._apiStatus 로도 노출 → 인프라 reactive 가 재발급·재시도.
    // - { _ok: data } → 성공 데이터 (변환된 형태)
    // - 그 외 객체 → 원본 kapi 응답 (성공)
    const run = async (fn) => {
      const r = await fn(accessToken);
      if (!r) return outRaw({ success: false, errorKey: 'error.unknown', errorParams: {} });
      if (r._errorKey) return outRaw({ success: false, errorKey: r._errorKey, errorParams: r._errorParams || {} });
      if (r._status) return outRaw({ success: false, errorKey: 'error.api_status', errorParams: { status: String(r._status), body: r._statusBody || '' }, data: { _apiStatus: r._status } });
      return outRaw({ success: true, data: r._ok !== undefined ? r._ok : r });
    };

    switch (action) {
      case 'send-me': return await run(t => handleSendMe(t, data));
      case 'send-me-scrap': return await run(t => handleSendMeScrap(t, data));
      case 'send-friends': return await run(t => handleSendFriends(t, data));
      case 'profile': return await run(t => handleProfile(t));
      case 'friends': return await run(t => handleFriends(t, data));
      case 'channels': return await run(t => handleChannels(t, data));
      case 'calendars': return await run(t => handleCalendars(t, data));
      case 'create-event': return await run(t => handleCreateEvent(t, data));
      case 'list-events': return await run(t => handleListEvents(t, data));
      default: return outErr('error.unknown_action', { action: String(action) });
    }
  } catch (e) { outErr('error.runtime', { message: e.message }); }
});

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }
function outRaw(obj) { console.log(JSON.stringify(obj)); }

/** i18n 에러 응답 — errorKey + errorParams. resolve_sysmod_error 가 module.kakao-talk.{key} 로 변환. */
function outErr(key, params) {
  const r = { success: false, errorKey: key };
  if (params && Object.keys(params).length > 0) r.errorParams = params;
  console.log(JSON.stringify(r));
}

async function kapiPost(token, url, formBody) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: formBody,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { _status: resp.status, _statusBody: t };
  }
  return await resp.json();
}

async function kapiGet(token, url) {
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { _status: resp.status, _statusBody: t };
  }
  return await resp.json();
}

// kapi 응답이 에러면 그대로 통과(호출 쪽에서 _status / _errorKey 확인), 성공이면 null.
function kapiErr(result) { return result && (result._status || result._errorKey) ? result : null; }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  템플릿 빌더
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function buildTemplate(data) {
  const type = data.type || 'text';
  const link = data.link || '';
  const linkObj = { web_url: link, mobile_web_url: link };
  const buttons = data.buttons
    ? data.buttons.map(b => ({ title: b.title, link: { web_url: b.link, mobile_web_url: b.link } }))
    : (link ? [{ title: data.buttonTitle || '자세히 보기', link: linkObj }] : []);

  if (type === 'text') {
    const tmpl = { object_type: 'text', text: data.text || '', link: linkObj };
    if (data.buttonTitle) tmpl.button_title = data.buttonTitle;
    if (buttons.length) tmpl.buttons = buttons.slice(0, 2);
    return tmpl;
  }

  if (type === 'feed') {
    const content = {
      title: (data.title || data.text || '').slice(0, 200),
      description: data.description || data.text || '',
      image_url: data.imageUrl || '',
      link: linkObj,
    };
    if (data.imageWidth) content.image_width = data.imageWidth;
    if (data.imageHeight) content.image_height = data.imageHeight;
    const tmpl = { object_type: 'feed', content };
    if (data.itemContent) tmpl.item_content = data.itemContent;
    if (data.social) tmpl.social = data.social;
    if (buttons.length) tmpl.buttons = buttons.slice(0, 2);
    return tmpl;
  }

  if (type === 'list') {
    const headerTitle = data.listHeaderTitle || data.title || (data.text || '').slice(0, 50) || '알림';
    let contents;
    if (data.items && Array.isArray(data.items)) {
      contents = data.items.slice(0, 3).map(item => ({
        title: (item.title || '').slice(0, 200),
        description: item.description || '',
        image_url: item.imageUrl || '',
        link: { web_url: item.link || link, mobile_web_url: item.link || link },
      }));
    } else {
      const lines = (data.text || '').split('\n').filter(l => l.trim()).slice(0, 3);
      contents = lines.map(l => ({
        title: l.slice(0, 200), description: '', image_url: '', link: linkObj,
      }));
    }
    // list는 최소 2개 필요
    while (contents.length < 2) contents.push({ title: ' ', description: '', image_url: '', link: linkObj });
    const tmpl = { object_type: 'list', header_title: headerTitle, header_link: linkObj, contents };
    if (buttons.length) tmpl.buttons = buttons.slice(0, 2);
    return tmpl;
  }

  if (type === 'location') {
    if (!data.address) throw new TemplateError('error.template_location_address', {});
    const content = {
      title: (data.title || data.text || '').slice(0, 200),
      description: data.description || '',
      image_url: data.imageUrl || '',
      link: linkObj,
    };
    const tmpl = { object_type: 'location', address: data.address, content };
    if (data.addressTitle) tmpl.address_title = data.addressTitle;
    if (data.social) tmpl.social = data.social;
    if (buttons.length) tmpl.buttons = buttons.slice(0, 2);
    return tmpl;
  }

  if (type === 'commerce') {
    if (!data.regularPrice) throw new TemplateError('error.template_commerce_price', {});
    const content = {
      title: (data.title || data.text || '').slice(0, 200),
      description: data.description || '',
      image_url: data.imageUrl || '',
      link: linkObj,
    };
    const commerce = { regular_price: data.regularPrice };
    if (data.discountPrice !== undefined) commerce.discount_price = data.discountPrice;
    if (data.discountRate !== undefined) commerce.discount_rate = data.discountRate;
    if (data.fixedDiscountPrice !== undefined) commerce.fixed_discount_price = data.fixedDiscountPrice;
    if (data.productName) commerce.product_name = data.productName;
    if (data.currencyUnit) commerce.currency_unit = data.currencyUnit;
    if (data.currencyUnitPosition !== undefined) commerce.currency_unit_position = data.currencyUnitPosition;
    const tmpl = { object_type: 'commerce', content, commerce };
    if (buttons.length) tmpl.buttons = buttons.slice(0, 2);
    return tmpl;
  }

  if (type === 'calendar') {
    if (!data.calendarId || !data.calendarIdType) throw new TemplateError('error.template_calendar_required', {});
    const content = {
      title: (data.title || data.text || '').slice(0, 200),
      description: data.description || '',
      image_url: data.imageUrl || '',
      link: linkObj,
    };
    const tmpl = { object_type: 'calendar', id_type: data.calendarIdType, id: data.calendarId, content };
    if (buttons.length) tmpl.buttons = buttons.slice(0, 1); // calendar은 버튼 1개
    return tmpl;
  }

  throw new TemplateError('error.template_unknown_type', { type: String(type) });
}

/** buildTemplate 의 i18n 에러 — handle* 에서 catch 후 _errorKey 반환. */
class TemplateError extends Error {
  constructor(key, params) {
    super(key);
    this.errorKey = key;
    this.errorParams = params || {};
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  나에게 보내기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSendMe(token, data) {
  if (!data.text && !data.title) return { _errorKey: 'error.text_or_title_required', _errorParams: {} };
  let tmpl;
  try { tmpl = buildTemplate(data); }
  catch (e) { if (e instanceof TemplateError) return { _errorKey: e.errorKey, _errorParams: e.errorParams }; throw e; }
  const body = `template_object=${encodeURIComponent(JSON.stringify(tmpl))}`;
  const result = await kapiPost(token, `${KAPI}/v2/api/talk/memo/default/send`, body);
  const err = kapiErr(result); if (err) return err;
  return { _ok: { resultCode: result.result_code ?? 0 } };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  나에게 스크랩 메시지 보내기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSendMeScrap(token, data) {
  if (!data.requestUrl) return { _errorKey: 'error.request_url_required', _errorParams: {} };
  let body = `request_url=${encodeURIComponent(data.requestUrl)}`;
  if (data.templateId) body += `&template_id=${data.templateId}`;
  if (data.templateArgs) body += `&template_args=${encodeURIComponent(JSON.stringify(data.templateArgs))}`;
  const result = await kapiPost(token, `${KAPI}/v2/api/talk/memo/scrap/send`, body);
  const err = kapiErr(result); if (err) return err;
  return { _ok: { resultCode: result.result_code ?? 0 } };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  친구에게 보내기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSendFriends(token, data) {
  if (!data.receiverUuids || !Array.isArray(data.receiverUuids) || data.receiverUuids.length === 0) {
    return { _errorKey: 'error.receiver_uuids_required', _errorParams: {} };
  }
  if (!data.text && !data.title) return { _errorKey: 'error.text_or_title_required', _errorParams: {} };

  let tmpl;
  try { tmpl = buildTemplate(data); }
  catch (e) { if (e instanceof TemplateError) return { _errorKey: e.errorKey, _errorParams: e.errorParams }; throw e; }
  const uuids = JSON.stringify(data.receiverUuids.slice(0, 5));
  const body = `receiver_uuids=${encodeURIComponent(uuids)}&template_object=${encodeURIComponent(JSON.stringify(tmpl))}`;
  const result = await kapiPost(token, `${KAPI}/v1/api/talk/friends/message/default/send`, body);
  const err = kapiErr(result); if (err) return err;
  return { _ok: {
    successfulReceiverUuids: result.successful_receiver_uuids || [],
    failureInfo: result.failure_info || [],
  } };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  프로필 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleProfile(token) {
  const result = await kapiGet(token, `${KAPI}/v1/api/talk/profile`);
  const err = kapiErr(result); if (err) return err;
  return { _ok: {
    nickName: result.nickName || '',
    profileImageUrl: result.profileImageURL || '',
    thumbnailUrl: result.thumbnailURL || '',
  } };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  친구 목록 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleFriends(token, data) {
  const params = new URLSearchParams();
  if (data.offset !== undefined) params.set('offset', String(data.offset));
  if (data.limit !== undefined) params.set('limit', String(Math.min(data.limit, 100)));
  if (data.order) params.set('order', data.order);
  if (data.friendOrder) params.set('friend_order', data.friendOrder);
  const qs = params.toString();
  const result = await kapiGet(token, `${KAPI}/v1/api/talk/friends${qs ? '?' + qs : ''}`);
  const err = kapiErr(result); if (err) return err;
  return { _ok: {
    totalCount: result.total_count || 0,
    favoriteCount: result.favorite_count || 0,
    friends: (result.elements || []).map(f => ({
      uuid: f.uuid, nickname: f.profile_nickname, thumbnail: f.profile_thumbnail_image, favorite: f.favorite,
    })),
  } };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  채널 관계 확인
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleChannels(token, data) {
  const params = new URLSearchParams();
  if (data.channelIds) params.set('channel_ids', Array.isArray(data.channelIds) ? data.channelIds.join(',') : data.channelIds);
  const qs = params.toString();
  const result = await kapiGet(token, `${KAPI}/v2/api/talk/channels${qs ? '?' + qs : ''}`);
  const err = kapiErr(result); if (err) return err;
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  캘린더 목록 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleCalendars(token, data) {
  const params = new URLSearchParams();
  if (data.filter) params.set('filter', data.filter); // ALL, USER, SUBSCRIBE
  const qs = params.toString();
  const result = await kapiGet(token, `${KAPI}/v2/api/calendar/calendars${qs ? '?' + qs : ''}`);
  const err = kapiErr(result); if (err) return err;
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  캘린더 이벤트 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleCreateEvent(token, data) {
  if (!data.event) return { _errorKey: 'error.event_object_required', _errorParams: {} };
  const body = new URLSearchParams();
  if (data.calendarId) body.set('calendar_id', data.calendarId);
  body.set('event', JSON.stringify(data.event));

  const result = await kapiPost(token, `${KAPI}/v2/api/calendar/create/event`, body.toString());
  const err = kapiErr(result); if (err) return err;
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  캘린더 이벤트 목록 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleListEvents(token, data) {
  const params = new URLSearchParams();
  if (data.calendarId) params.set('calendar_id', data.calendarId);
  if (data.preset) params.set('preset', data.preset); // TODAY, THIS_WEEK, THIS_MONTH
  if (data.from) params.set('from', data.from);
  if (data.to) params.set('to', data.to);
  const qs = params.toString();
  const result = await kapiGet(token, `${KAPI}/v2/api/calendar/events${qs ? '?' + qs : ''}`);
  const err = kapiErr(result); if (err) return err;
  return result;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  토큰 갱신
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/** 토큰 발급·갱신(refresh_token grant)·회전 영속은 인프라 TokenProvider 가 config.json 의 oauth 스펙으로 처리.
 *  sysmod 는 env 로 주입된 raw access token 을 받아쓰기만 한다 (토큰 코드 0). */

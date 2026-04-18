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

    let accessToken = process.env['KAKAO_ACCESS_TOKEN'];
    const refreshToken = process.env['KAKAO_REFRESH_TOKEN'];
    const restApiKey = process.env['KAKAO_REST_API_KEY'];
    const clientSecret = process.env['KAKAO_CLIENT_SECRET'];

    if (!accessToken) return out(false, 'KAKAO_ACCESS_TOKEN이 설정되지 않았습니다.');

    // 토큰 자동 갱신 래퍼 — 핸들러가 undefined 반환(이미 out() 호출)이면 그대로 종료,
    // 객체 반환이면 _status=401 체크 후 갱신 재시도.
    const withRetry = async (fn) => {
      let result = await fn(accessToken);
      if (result && result._status === 401 && refreshToken && restApiKey) {
        process.stderr.write('[kakao-talk] 토큰 만료, 갱신 시도...\n');
        const newToken = await refreshAccessToken(restApiKey, refreshToken, clientSecret);
        if (newToken) {
          accessToken = newToken;
          result = await fn(accessToken);
        } else {
          return out(false, '토큰 갱신 실패. 카카오 연동을 다시 진행해주세요.');
        }
      }
      return result;
    };

    switch (action) {
      case 'send-me': return await withRetry(t => handleSendMe(t, data));
      case 'send-me-scrap': return await withRetry(t => handleSendMeScrap(t, data));
      case 'send-friends': return await withRetry(t => handleSendFriends(t, data));
      case 'profile': return await withRetry(t => handleProfile(t));
      case 'friends': return await withRetry(t => handleFriends(t, data));
      case 'channels': return await withRetry(t => handleChannels(t, data));
      case 'calendars': return await withRetry(t => handleCalendars(t, data));
      case 'create-event': return await withRetry(t => handleCreateEvent(t, data));
      case 'list-events': return await withRetry(t => handleListEvents(t, data));
      default: return out(false, `알 수 없는 action: ${action}`);
    }
  } catch (e) { out(false, e.message); }
});

function out(ok, d) { console.log(JSON.stringify(ok ? { success: true, data: d } : { success: false, error: d })); }

async function kapiPost(token, url, formBody) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: formBody,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { _status: resp.status, _error: `카카오 API ${resp.status}: ${t}` };
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
    return { _status: resp.status, _error: `카카오 API ${resp.status}: ${t}` };
  }
  return await resp.json();
}

function checkErr(result) {
  if (result._error) { out(false, result._error); return true; }
  return false;
}

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
    if (!data.address) throw new Error('location 타입에는 address가 필요합니다.');
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
    if (!data.regularPrice) throw new Error('commerce 타입에는 regularPrice가 필요합니다.');
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
    if (!data.calendarId || !data.calendarIdType) throw new Error('calendar 타입에는 calendarId, calendarIdType(event/calendar)이 필요합니다.');
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

  throw new Error(`알 수 없는 메시지 타입: ${type}. text/feed/list/location/commerce/calendar 중 하나를 사용하세요.`);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  나에게 보내기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSendMe(token, data) {
  if (!data.text && !data.title) return out(false, 'text 또는 title이 필요합니다.');
  const tmpl = buildTemplate(data);
  const body = `template_object=${encodeURIComponent(JSON.stringify(tmpl))}`;
  const result = await kapiPost(token, `${KAPI}/v2/api/talk/memo/default/send`, body);
  if (checkErr(result)) return;
  out(true, { resultCode: result.result_code ?? 0 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  나에게 스크랩 메시지 보내기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSendMeScrap(token, data) {
  if (!data.requestUrl) return out(false, 'requestUrl이 필요합니다.');
  let body = `request_url=${encodeURIComponent(data.requestUrl)}`;
  if (data.templateId) body += `&template_id=${data.templateId}`;
  if (data.templateArgs) body += `&template_args=${encodeURIComponent(JSON.stringify(data.templateArgs))}`;
  const result = await kapiPost(token, `${KAPI}/v2/api/talk/memo/scrap/send`, body);
  if (checkErr(result)) return;
  out(true, { resultCode: result.result_code ?? 0 });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  친구에게 보내기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleSendFriends(token, data) {
  if (!data.receiverUuids || !Array.isArray(data.receiverUuids) || data.receiverUuids.length === 0) {
    return out(false, 'receiverUuids 배열이 필요합니다. friends 액션으로 UUID를 조회하세요.');
  }
  if (!data.text && !data.title) return out(false, 'text 또는 title이 필요합니다.');

  const tmpl = buildTemplate(data);
  const uuids = JSON.stringify(data.receiverUuids.slice(0, 5));
  const body = `receiver_uuids=${encodeURIComponent(uuids)}&template_object=${encodeURIComponent(JSON.stringify(tmpl))}`;
  const result = await kapiPost(token, `${KAPI}/v1/api/talk/friends/message/default/send`, body);
  if (checkErr(result)) return;
  out(true, {
    successfulReceiverUuids: result.successful_receiver_uuids || [],
    failureInfo: result.failure_info || [],
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  프로필 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleProfile(token) {
  const result = await kapiGet(token, `${KAPI}/v1/api/talk/profile`);
  if (checkErr(result)) return;
  out(true, {
    nickName: result.nickName || '',
    profileImageUrl: result.profileImageURL || '',
    thumbnailUrl: result.thumbnailURL || '',
  });
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
  if (checkErr(result)) return;
  out(true, {
    totalCount: result.total_count || 0,
    favoriteCount: result.favorite_count || 0,
    friends: (result.elements || []).map(f => ({
      uuid: f.uuid, nickname: f.profile_nickname, thumbnail: f.profile_thumbnail_image, favorite: f.favorite,
    })),
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  채널 관계 확인
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleChannels(token, data) {
  const params = new URLSearchParams();
  if (data.channelIds) params.set('channel_ids', Array.isArray(data.channelIds) ? data.channelIds.join(',') : data.channelIds);
  const qs = params.toString();
  const result = await kapiGet(token, `${KAPI}/v2/api/talk/channels${qs ? '?' + qs : ''}`);
  if (checkErr(result)) return;
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  캘린더 목록 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleCalendars(token, data) {
  const params = new URLSearchParams();
  if (data.filter) params.set('filter', data.filter); // ALL, USER, SUBSCRIBE
  const qs = params.toString();
  const result = await kapiGet(token, `${KAPI}/v2/api/calendar/calendars${qs ? '?' + qs : ''}`);
  if (checkErr(result)) return;
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  캘린더 이벤트 생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function handleCreateEvent(token, data) {
  if (!data.event) return out(false, 'event 객체가 필요합니다. {title, time:{start_at, end_at, time_zone}}');
  const body = new URLSearchParams();
  if (data.calendarId) body.set('calendar_id', data.calendarId);
  body.set('event', JSON.stringify(data.event));

  const result = await kapiPost(token, `${KAPI}/v2/api/calendar/create/event`, body.toString());
  if (checkErr(result)) return;
  out(true, result);
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
  if (checkErr(result)) return;
  out(true, result);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  토큰 갱신
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function refreshAccessToken(restApiKey, refreshToken, clientSecret) {
  try {
    const params = { grant_type: 'refresh_token', client_id: restApiKey, refresh_token: refreshToken };
    if (clientSecret) params.client_secret = clientSecret;
    const resp = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.access_token || null;
  } catch { return null; }
}

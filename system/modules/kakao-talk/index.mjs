/**
 * Firebat System Module: kakao-talk
 * 카카오톡 나에게 보내기 API
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": {
 *             "type"?: "text" | "feed" | "list" (기본: text),
 *             "text": "메시지 본문",
 *             "link"?: "버튼 URL",
 *             "buttonTitle"?: "버튼 텍스트 (기본: 자세히 보기)"
 *           }
 *         }
 * [OUTPUT] stdout JSON: { "success": true, "data": { "resultCode": 0 } }
 *         또는 { "success": false, "error": "..." }
 *
 * 필요 시크릿:
 *  - KAKAO_ACCESS_TOKEN: 카카오 OAuth 액세스 토큰
 *  - KAKAO_REFRESH_TOKEN: 토큰 갱신용 (만료 시 자동 갱신)
 *  - KAKAO_REST_API_KEY: 앱의 플랫폼 키 (토큰 갱신 시 client_id로 사용)
 *
 * 카카오 디벨로퍼스 → 내 애플리케이션 → 카카오 로그인 → 동의항목에서
 * "talk_message" 권한 활성화 필요.
 */

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const text = data?.text;

    if (!text) {
      console.log(JSON.stringify({ success: false, error: 'data.text 필드가 필요합니다.' }));
      return;
    }

    let accessToken = process.env['KAKAO_ACCESS_TOKEN'];
    const refreshToken = process.env['KAKAO_REFRESH_TOKEN'];
    const restApiKey = process.env['KAKAO_REST_API_KEY'];
    const clientSecret = process.env['KAKAO_CLIENT_SECRET'];

    if (!accessToken) {
      console.log(JSON.stringify({ success: false, error: 'KAKAO_ACCESS_TOKEN 시크릿이 필요합니다. Vault에 등록해주세요.' }));
      return;
    }

    // 메시지 템플릿 구성
    const type = data.type || 'text';
    const link = data.link || '';
    const buttonTitle = data.buttonTitle || '자세히 보기';

    let templateObject;
    if (type === 'feed') {
      templateObject = {
        object_type: 'feed',
        content: {
          title: text.slice(0, 50),
          description: text,
          image_url: '',
          link: { web_url: link, mobile_web_url: link },
        },
        buttons: link ? [{ title: buttonTitle, link: { web_url: link, mobile_web_url: link } }] : [],
      };
    } else if (type === 'list') {
      // 리스트 타입: 텍스트를 줄바꿈으로 분리하여 항목 생성
      const items = text.split('\n').filter(l => l.trim()).slice(0, 3);
      templateObject = {
        object_type: 'list',
        header_title: items[0] || '알림',
        header_link: { web_url: link, mobile_web_url: link },
        contents: items.map(item => ({
          title: item.slice(0, 50),
          description: '',
          image_url: '',
          link: { web_url: link, mobile_web_url: link },
        })),
        buttons: link ? [{ title: buttonTitle, link: { web_url: link, mobile_web_url: link } }] : [],
      };
    } else {
      // text 타입 (기본)
      templateObject = {
        object_type: 'text',
        text,
        link: { web_url: link, mobile_web_url: link },
        ...(link ? { buttons: [{ title: buttonTitle, link: { web_url: link, mobile_web_url: link } }] } : {}),
      };
    }

    // 메시지 발송 시도
    let result = await sendMessage(accessToken, templateObject);

    // 401 에러 (토큰 만료) → 자동 갱신 후 재시도
    if (result.status === 401 && refreshToken && restApiKey) {
      process.stderr.write('[kakao-talk] 액세스 토큰 만료, 갱신 시도...\n');
      const newToken = await refreshAccessToken(restApiKey, refreshToken, clientSecret);
      if (newToken) {
        accessToken = newToken;
        result = await sendMessage(accessToken, templateObject);
      } else {
        console.log(JSON.stringify({ success: false, error: '토큰 갱신 실패. 카카오 디벨로퍼스에서 토큰을 재발급해주세요.' }));
        return;
      }
    }

    if (result.ok) {
      const body = await result.json();
      console.log(JSON.stringify({
        success: true,
        data: { resultCode: body.result_code ?? 0 },
      }));
    } else {
      const errBody = await result.text();
      console.log(JSON.stringify({ success: false, error: `카카오 API ${result.status}: ${errBody}` }));
    }
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

async function sendMessage(token, templateObject) {
  return fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `template_object=${encodeURIComponent(JSON.stringify(templateObject))}`,
    signal: AbortSignal.timeout(15000),
  });
}

async function refreshAccessToken(restApiKey, refreshToken, clientSecret) {
  try {
    const params = {
      grant_type: 'refresh_token',
      client_id: restApiKey,
      refresh_token: refreshToken,
    };
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
  } catch {
    return null;
  }
}

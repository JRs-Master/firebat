/**
 * Firebat System Module: naver-ads (keyword-analytics)
 * 네이버 광고 API — 키워드 검색량/CPC/경쟁도 조회
 *
 * API: https://api.naver.com/keywordstool
 * 인증: X-API-KEY, X-Customer, X-Timestamp, X-Signature (HMAC-SHA256)
 *
 * [INPUT]  stdin JSON: {
 *           "correlationId": "...",
 *           "data": { "keywords": ["키워드1", "키워드2"], "showDetail?": true }
 *         }
 * [OUTPUT] stdout JSON: {
 *           "success": true,
 *           "data": { "keywords": [...] }
 *         }
 */

import crypto from 'crypto';

function generateSignature(timestamp, method, uri, secretKey) {
  const message = `${timestamp}.${method}.${uri}`;
  return crypto.createHmac('sha256', secretKey).update(message).digest('base64');
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const keywords = data?.keywords;
    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      console.log(JSON.stringify({ success: false, error: 'data.keywords 배열이 필요합니다.' }));
      return;
    }

    const apiKey = process.env['NAVER_AD_API_KEY'];
    const secretKey = process.env['NAVER_AD_SECRET_KEY'];
    const customerId = process.env['NAVER_AD_CUSTOMER_ID'];
    if (!apiKey || !secretKey || !customerId) {
      console.log(JSON.stringify({ success: false, error: 'NAVER_AD_API_KEY / NAVER_AD_SECRET_KEY / NAVER_AD_CUSTOMER_ID가 설정되지 않았습니다. 설정 > 시스템 모듈 > naver-ads에서 등록해주세요.' }));
      return;
    }

    const timestamp = String(Date.now());
    const method = 'GET';
    const uri = '/keywordstool';
    const signature = generateSignature(timestamp, method, uri, secretKey);

    const showDetail = data.showDetail !== false ? '1' : '0';
    const params = new URLSearchParams({
      hintKeywords: keywords.slice(0, 5).join(','),
      showDetail,
    });

    const resp = await fetch(`https://api.naver.com${uri}?${params}`, {
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        'X-Customer': customerId,
        'X-Timestamp': timestamp,
        'X-Signature': signature,
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log(JSON.stringify({ success: false, error: `네이버 광고 API ${resp.status}: ${resp.statusText} ${errText}`.trim() }));
      return;
    }

    const json = await resp.json();
    // "< 10" 문자열 → 숫자 변환 헬퍼
    const toNum = (v) => (typeof v === 'string' ? (v.includes('<') ? 0 : Number(v)) : (v ?? 0));

    const allResults = (json.keywordList || []).map(item => {
      const entry = {
        keyword: item.relKeyword,
        monthlyPcQcCnt: toNum(item.monthlyPcQcCnt),
        monthlyMobileQcCnt: toNum(item.monthlyMobileQcCnt),
        monthlyAvePcClkCnt: item.monthlyAvePcClkCnt ?? 0,
        monthlyAveMobileClkCnt: item.monthlyAveMobileClkCnt ?? 0,
        monthlyAvePcCtr: item.monthlyAvePcCtr ?? 0,
        monthlyAveMobileCtr: item.monthlyAveMobileCtr ?? 0,
        plAvgDepth: item.plAvgDepth ?? 0,
        compIdx: item.compIdx || '',
      };
      // showDetail=1 시 월별 상세 데이터
      if (item.monthlyPcQcCntList) entry.monthlyPcQcCntList = item.monthlyPcQcCntList;
      if (item.monthlyMobileQcCntList) entry.monthlyMobileQcCntList = item.monthlyMobileQcCntList;
      return entry;
    });
    // 입력 키워드 우선, 나머지 연관 키워드 뒤에 배치
    const lowerKws = keywords.map(k => k.toLowerCase());
    const exact = allResults.filter(r => lowerKws.includes(r.keyword?.toLowerCase()));
    const related = allResults.filter(r => !lowerKws.includes(r.keyword?.toLowerCase()));

    console.log(JSON.stringify({
      success: true,
      data: { keywords: exact, relatedKeywords: related.slice(0, 20) },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

#!/usr/bin/env node
/**
 * Firebat System Module: upstage-ie — 문서 → 구조화 JSON (Upstage Information Extraction).
 *
 * 라이브러리 밖 일회성 문서(영수증·명함·청구서 등)를 URL 또는 base64 로 받아 스키마대로 추출.
 * 라이브러리에 업로드된 문서는 코어 도구 library_extract_structured 가 담당(원본 파일 직접 읽음).
 *
 * 계약(서버 키 라이브 검증 2026-07-22): POST /v1/information-extraction — OpenAI chat/completions
 * shape + model=information-extract + messages[].content[].image_url.url = "data:<mime>;base64,<b64>"
 * + response_format={type:"json_schema",json_schema:{name,schema}} (**필수** — 없으면 400).
 * 스키마 미지정 시 /v1/information-extraction/schema-generation 으로 문서에서 자동 생성 후 추출.
 */

const IE_ENDPOINT = 'https://api.upstage.ai/v1/information-extraction';
const SCHEMA_GEN_ENDPOINT = 'https://api.upstage.ai/v1/information-extraction/schema-generation';
const MAX_BYTES = 20 * 1024 * 1024; // 20MB — 과대 문서는 명시 에러 (조용한 절단 금지)

/** 문서 URL fetch → base64. 사설/내부 주소는 거부(SSRF 방어 — 모듈 자체 1차 가드). */
async function fetchDocument(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('url 형식이 올바르지 않습니다.');
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) URL 만 지원합니다.');
  const host = u.hostname.toLowerCase();
  const blocked =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.startsWith('metadata') ||
    /^(127\.|10\.|169\.254\.|0\.0\.0\.0|\[?::1)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host);
  if (blocked) throw new Error('내부/사설 주소는 요청할 수 없습니다.');

  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`문서 다운로드 실패: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`문서가 너무 큽니다 (${buf.length} bytes, 상한 ${MAX_BYTES}).`);
  const mime = (resp.headers.get('content-type') || 'application/pdf').split(';')[0].trim();
  return { b64: buf.toString('base64'), mime };
}

/** chat/completions POST. response_format 없으면 schema-generation 용도. */
async function postChat(apiKey, endpoint, dataUrl, responseFormat) {
  const body = {
    model: 'information-extract',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }],
  };
  if (responseFormat) body.response_format = responseFormat;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Upstage IE ${resp.status}: ${text.slice(0, 300)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Upstage IE 응답 파싱 실패');
  }
  const content = parsed?.choices?.[0]?.message?.content ?? '';
  if (!String(content).trim()) throw new Error('Upstage IE 결과가 비어 있습니다.');
  return content;
}

/** 받은 스키마를 response_format 형태로 정규화 — json_schema / {name,schema} / 순수 JSON schema 수용. */
function normalizeResponseFormat(v) {
  if (v && v.type === 'json_schema' && v.json_schema) return v;
  if (v && v.schema) return { type: 'json_schema', json_schema: { name: v.name || 'document_schema', schema: v.schema } };
  if (v && v.type === 'object') return { type: 'json_schema', json_schema: { name: 'document_schema', schema: v } };
  throw new Error('schema 형식을 인식하지 못했습니다 (JSON schema object / {name,schema} / json_schema).');
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다 (extract | generate-schema).' }));
      return;
    }
    const apiKey = process.env['UPSTAGE_API_KEY'];
    if (!apiKey) {
      console.log(JSON.stringify({ success: false, error: 'Upstage API 키가 없습니다. 설정 > AI > 어시스턴트에서 Upstage 키를 등록하세요.' }));
      return;
    }
    const params = data.params || {};
    let b64 = typeof params.base64 === 'string' ? params.base64.trim() : '';
    let mime = typeof params.mime === 'string' && params.mime ? params.mime : 'application/pdf';
    if (!b64) {
      if (!params.url) {
        console.log(JSON.stringify({ success: false, error: 'params.url 또는 params.base64 중 하나가 필요합니다.' }));
        return;
      }
      const got = await fetchDocument(String(params.url));
      b64 = got.b64;
      mime = got.mime;
    }
    const dataUrl = `data:${mime};base64,${b64}`;

    if (action === 'generate-schema') {
      const gen = await postChat(apiKey, SCHEMA_GEN_ENDPOINT, dataUrl, null);
      console.log(JSON.stringify({ success: true, data: { schema: JSON.parse(gen) } }));
      return;
    }
    if (action !== 'extract') {
      console.log(JSON.stringify({ success: false, error: `지원하지 않는 action: ${action} (extract | generate-schema)` }));
      return;
    }

    // response_format 확정 — 제공 스키마 정규화 or 문서에서 자동 생성.
    let responseFormat;
    if (params.schema && Object.keys(params.schema).length > 0) {
      responseFormat = normalizeResponseFormat(params.schema);
    } else {
      const gen = await postChat(apiKey, SCHEMA_GEN_ENDPOINT, dataUrl, null);
      responseFormat = normalizeResponseFormat(JSON.parse(gen));
    }
    const content = await postChat(apiKey, IE_ENDPOINT, dataUrl, responseFormat);
    let extracted;
    try {
      extracted = JSON.parse(content);
    } catch {
      extracted = content; // 모델이 순수 JSON 이 아닌 문자열을 준 경우 그대로
    }
    console.log(JSON.stringify({ success: true, data: { extracted } }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

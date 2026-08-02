#!/usr/bin/env node
/**
 * Firebat System Module: toss-invest (시세·차트)
 *
 * 토스증권 중 **공개 시세·차트만**. 계좌를 못 읽고 주문을 못 냅니다 — 그 액션이
 * 선언에 없고, 이 모듈은 자격증명을 선언하지 않아 샌드박스가 키를 주입하지 않습니다.
 *
 * The dialect itself is in `_runtime/toss-invest-api.mjs`, shared with the other half. What separates the two
 * modules is `config.json`: which actions it declares, and whether it declares the API keys at
 * all — a module that declares no secret is handed none by the sandbox.
 */
import { main } from '../_runtime/toss-invest-api.mjs';

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', async () => {
  try {
    const parsed = JSON.parse(raw);
    await main(parsed.data ?? parsed);
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: `입력을 읽지 못했습니다: ${err.message}` }));
    process.exit(1);
  }
});

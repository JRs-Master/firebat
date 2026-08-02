#!/usr/bin/env node
/**
 * Firebat System Module: korea-invest (계좌·주문)
 *
 * 한국투자증권 중 **계좌·잔고·주문·환전·이체** — 개인 자격증명이 필요한 절반입니다.
 * 시세·차트는 `korea-invest-quotes` 에 있고, hub 인스턴스에는 이 모듈을 허용하지 마십시오.
 *
 * The dialect itself is in `_runtime/korea-invest-api.mjs`, shared with the other half. What separates the two
 * modules is `config.json`: which actions it declares, and whether it declares the API keys at
 * all — a module that declares no secret is handed none by the sandbox.
 */
import { main } from '../_runtime/korea-invest-api.mjs';

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

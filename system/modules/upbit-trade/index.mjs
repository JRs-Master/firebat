/**
 * Firebat System Module: upbit (계좌·주문·입출금)
 *
 * 업비트 Open API 중 **개인 키가 필요한 절반** — 계좌·잔고·주문·입출금·환전.
 * 시세·차트는 `upbit` 에 있습니다. hub 인스턴스에는 이 모듈을 허용하지 마십시오.
 *
 * The dialect itself is in `_runtime/upbit-api.mjs`, shared with the other half. What separates
 * the two modules is `config.json`: which actions it declares, and whether it declares the API
 * keys at all.
 */
import { main } from '../_runtime/upbit-api.mjs';

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

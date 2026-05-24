/**
 * Node sysmod 공통 prelude — undici fetch 의 IPv4 우선 connection 강제.
 *
 * 박힌 이유:
 * - 일부 호스트 (예: api.telegram.org) DNS 가 IPv4+IPv6 양쪽 응답
 * - Node 빌트인 fetch (undici) 가 IPv6 우선 시도 후 IPv4 fallback 미박힘
 * - 운영 환경 IPv6 outbound 일시 미박힘 시점 → IPv6 connect timeout → fetch failed
 * - curl 은 IPv6 fail 후 즉시 IPv4 fallback = 정상 동작 → 차이 영역
 *
 * fix:
 * - undici Agent 의 connect.family=4 옵션으로 모든 fetch 호출이 IPv4 만 시도
 * - --dns-result-order=ipv4first 영역은 undici 자체 connection 영역에 영향 0 (검증 박음)
 *
 * 적용 영역:
 * - sandbox.rs 의 Node runtime spec 안 `--require <본 file>` flag 로 자동 inject
 * - 모든 Node sysmod (telegram / kakao-talk / naver-* / yfinance / 등) 일관 IPv4 강제
 * - 모듈 코드 수정 0
 *
 * 회귀 영역:
 * - IPv6 only 호스트 호출 sysmod 박혀있을 시 차단. 현재 없음 — 모든 외부 API IPv4 resolved
 * - 향후 IPv6 only 호스트 필요 시 본 prelude 옵션 (예: env FIREBAT_SYSMOD_NETWORK=dual) 으로 분기
 *
 * undici 패키지 영역:
 * - firebat root node_modules 의 undici (Next.js 가 의존성 박음) 자동 resolve
 * - sysmod 디렉토리 → 부모 → 부모 chain 으로 firebat root 의 node_modules 탐색
 */

const { Agent, setGlobalDispatcher } = require('undici');

setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

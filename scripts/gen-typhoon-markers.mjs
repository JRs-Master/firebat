// 태풍 마커 PNG 사전 생성 — 결정적·유한한 마커(등급 5/4/3/2/1/T/none)를 한 번 구워
// lib/markers/ 에 둔다. components.tsx 가 import → 번들러가 /_next/static/media/ 로 emit →
// 기존 frontend static 배포에 자동 포함(public/ standalone 미서빙 문제·DB·Caddy 설정 무관).
// 런타임(브라우저) SVG→canvas→PNG 재굽기 0. 디자인 변경 시 이 스크립트 재실행.
//   실행: node scripts/gen-typhoon-markers.mjs
import sharp from 'sharp';
import { mkdirSync, readdirSync, statSync } from 'fs';

// components.tsx 의 HURRICANE_PATH (mdi-weather-hurricane, 24×24 viewBox) 와 동일.
const HPATH = 'M15,6.79C16.86,7.86 18,9.85 18,12C18,22 6,22 6,22C7.25,21.06 8.38,19.95 9.34,18.71C9.38,18.66 9.41,18.61 9.44,18.55C9.69,18.06 9.5,17.46 9,17.21C7.14,16.14 6,14.15 6,12C6,2 18,2 18,2C16.75,2.94 15.62,4.05 14.66,5.29C14.62,5.34 14.59,5.39 14.56,5.45C14.31,5.94 14.5,6.54 15,6.79Z';

// 마커 최대 표시크기(large PC = markerPixelSize 29 × deviceScale 1.25 ≈ 36px) × 4 = 144.
// 원래 런타임 supersample(canvas size×4)의 4x 다운스케일 수준에 맞춤 — 256은 ~7x 과도 축소라 무름.
const SIZE = 144;
const k = SIZE / 24;       // 24-viewBox → SIZE 스케일.
const c = SIZE / 2;

// (key, 강도색, 등급표시) — typhoonColorByWind / typhoonGradeNum 임계와 1:1.
const VARIANTS = [
  ['5', '#ef4444', '5'],   // ws≥54 초강력
  ['4', '#f97316', '4'],   // ws≥44 매우강
  ['3', '#eab308', '3'],   // ws≥33 강
  ['2', '#3b82f6', '2'],   // ws≥25 중
  ['1', '#22c55e', '1'],   // ws≥17 약
  ['T', '#9ca3af', 'T'],   // ws<17 열대저압부
  ['none', '#dc2626', null], // 풍속 없음 — 번호 없는 빨강
];

function svg(color, grade) {
  const center = grade == null
    ? ''
    : `<circle cx="${c}" cy="${c}" r="${SIZE * 0.22}" fill="white"/>`
      + `<text x="${c}" y="${c}" text-anchor="middle" dy="0.35em" fill="${color}" font-size="${SIZE * 0.28}" font-weight="800" font-family="Arial, sans-serif">${grade}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`
    + `<g transform="scale(${k})"><path d="${HPATH}" fill="${color}" stroke="white" stroke-width="0.9" stroke-linejoin="round"/></g>`
    + center
    + `</svg>`;
}

const outdir = 'lib/markers';
mkdirSync(outdir, { recursive: true });
for (const [key, color, grade] of VARIANTS) {
  const file = `${outdir}/typhoon-${key}.png`;
  await sharp(Buffer.from(svg(color, grade))).png({ compressionLevel: 9 }).toFile(file);
}
console.log('생성 완료:', readdirSync(outdir).map(f => `${f} (${statSync(`${outdir}/${f}`).size}B)`));

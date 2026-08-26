---
name: visual-snippets
kind: tool-usage
description: 웹에서 복사한 셰이더(GLSL)·canvas·ECharts 코드를 snippets 모듈에 등록하고, 페이지에 얹거나(전 종류) 서버에서 이미지·스프라이트시트로 굽는(canvas 만) 방법 — 태그: 셰이더, 배경 이펙트, 성운, 플라즈마, 코드 복붙, 차트 페이지, 영상 배경. 등록·크레딧·래퍼 규약이 있으니 반드시 get_skill 로 본문을 읽고 쓸 것. 쓰지 말 것 — glsl/echarts 의 영상·문서 삽입(브라우저 전용).
---

# 시각 코드 조각 — 등록하고 페이지에 얹기 (snippets 모듈)

소비처가 종류로 갈린다:
- **전 종류** → 발행 페이지 Html 블록(보는 사람의 브라우저가 실행 — 아래 래퍼).
- **canvas 만** → 서버 렌더도 된다: `render`(PNG 스틸 한 장) / `sheet`(프레임 격자 —
  motion 씬의 spritesheet 레이어가 같은 `{grid, fps}` 로 루프 재생 = **영상 배경**).
  조건은 코드가 `draw(ctx, t, w, h)` 를 정의하는 것 — 등록할 때 그 계약으로 다듬는다.
- glsl·echarts·html 은 서버에서 못 굽는다(브라우저 전용) — 페이지로만.

## 1. 등록 — 사용자가 코드를 붙여넣거나 URL 을 주면

- **복붙**: 받은 코드를 그대로 `snippets add { name, kind, code, author?, source?, license?, note }`.
  코드를 고치거나 축약하지 말고 원문 그대로 저장한다. `note` 는 생김새 한 줄(검색어가 된다).
- **URL**: `network_request` 로 가져온다. CodePen 은 펜 주소 뒤에 `.js` 를 붙이면 원시 JS 가
  나온다(`https://codepen.io/<user>/pen/<slug>.js`). Shadertoy 페이지는 JS 렌더라 fetch 로
  코드가 안 나온다 — 실패하면 사용자에게 코드 복사를 부탁한다("Shadertoy 는 페이지에서 코드
  전문이 보이니 복사해서 주세요").
- **라이선스는 정직하게**: Shadertoy 기본 = `CC-BY-NC-SA-3.0`(셰이더 머리말에 다른 표시가
  없으면). CodePen 은 기본 라이선스가 없다 — 명시된 것만 적고, 없으면 `unknown`.
- kind 판별: `mainImage(`/`iTime` 이 보이면 `glsl`, `getContext('2d')`/`ctx.` 면 `canvas`,
  `setOption(`/`series:` 면 `echarts`, 그 외 완결 문서는 `html`.

## 2. 페이지에 얹기 — get 으로 꺼내 Html 블록에 래핑

`snippets get { name }` 으로 코드·크레딧을 받아, 아래 래퍼에 **코드를 인라인**으로 앉힌
Html 블록을 `save_page` 로 발행한다. **CC-BY 계열 라이선스면 크레딧 줄이 필수**다(래퍼에
포함돼 있다 — author·source 를 지우지 말 것).

### kind: glsl (Shadertoy 스타일 프래그먼트 셰이더)

iTime·iResolution·iMouse 만 쓰는 단일 패스는 그대로 돈다. Buffer A/B 멀티패스는 이 래퍼
밖이다 — 등록은 받아 주되 "멀티패스라 페이지 래퍼로는 못 돌린다"고 말한다.

```html
<div style="position:relative;width:100%;height:70vh;overflow:hidden;border-radius:12px">
<canvas id="glc" style="width:100%;height:100%;display:block"></canvas>
<div style="position:absolute;right:10px;bottom:8px;font:11px sans-serif;color:rgba(255,255,255,.55)">
  "NOTE" by AUTHOR (SOURCE, LICENSE)</div>
<script>
const FS = `
// ── 여기에 저장된 셰이더 코드 원문 ──
`;
const cv = document.getElementById('glc');
const gl = cv.getContext('webgl2', { antialias: false });
const VS = '#version 300 es\nvoid main(){vec2 p=vec2[](vec2(-1,-1),vec2(3,-1),vec2(-1,3))[gl_VertexID];gl_Position=vec4(p,0,1);}';
const HDR = '#version 300 es\nprecision highp float;uniform vec3 iResolution;uniform float iTime;uniform vec4 iMouse;out vec4 _o;\n';
const FTR = '\nvoid main(){mainImage(_o, gl_FragCoord.xy);}';
function sh(t, s) { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o);
  if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(o); return o; }
const pr = gl.createProgram();
gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, HDR + FS + FTR));
gl.linkProgram(pr); gl.useProgram(pr);
const uR = gl.getUniformLocation(pr, 'iResolution'), uT = gl.getUniformLocation(pr, 'iTime'),
      uM = gl.getUniformLocation(pr, 'iMouse');
let mx = 0, my = 0;
cv.addEventListener('pointermove', e => { const r = cv.getBoundingClientRect();
  mx = (e.clientX - r.left) * devicePixelRatio; my = (r.bottom - e.clientY) * devicePixelRatio; });
const t0 = performance.now();
(function frame() {
  const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
  gl.uniform3f(uR, w, h, 1); gl.uniform1f(uT, (performance.now() - t0) / 1000);
  gl.uniform4f(uM, mx, my, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  requestAnimationFrame(frame);
})();
</script></div>
```

셰이더가 `mainImage` 대신 `void main()` + `gl_FragColor` 를 쓰는 옛 GLSL(ES 1.0)이면 HDR 의
`#version 300 es` 대신 WebGL1(`getContext('webgl')`)로 바꾸고 FTR 를 빼는 게 정공 — 판단이
어려우면 `mainImage` 존재 여부로 가른다.

### kind: canvas (2D)

등록 시점에 코드를 `function draw(ctx, t, w, h)`(t = 초) 관례로 다듬어 저장하는 것을
권장한다 — rAF 루프·리사이즈는 래퍼가 쥔다. 원문이 자체 루프를 돌면(즉시실행 + 자체 rAF)
그대로 `html` 로 저장하는 편이 안전하다.

```html
<div style="position:relative;width:100%;height:70vh;overflow:hidden;border-radius:12px">
<canvas id="cv2" style="width:100%;height:100%;display:block"></canvas>
<div style="position:absolute;right:10px;bottom:8px;font:11px sans-serif;color:rgba(0,0,0,.45)">
  "NOTE" by AUTHOR (SOURCE, LICENSE)</div>
<script>
// ── 여기에 저장된 코드(draw(ctx,t,w,h) 정의) ──
const cv = document.getElementById('cv2'), ctx = cv.getContext('2d');
const t0 = performance.now();
(function frame() {
  const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  draw(ctx, (performance.now() - t0) / 1000, w, h);
  requestAnimationFrame(frame);
})();
</script></div>
```

### kind: echarts (차트)

```html
<div id="ec" style="width:100%;height:480px"></div>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<script>
const chart = echarts.init(document.getElementById('ec'));
// ── 저장된 코드가 만드는 option ──
chart.setOption(option);
addEventListener('resize', () => chart.resize());
</script>
```

데이터가 도구 응답에서 왔으면 option 의 data 에 그대로 앉힌다(손계산 금지 — 값은 캐시에서).

### kind: html

완결 문서 조각 — 그대로 Html 블록에 넣는다. 크레딧 줄만 확인해서 없으면 붙인다.

## 3. 하지 말 것

- 코드 원문을 "개선"하지 말 것 — 저장은 원문, 각색은 페이지 래퍼 쪽에서.
- 라이선스 미상 코드를 크레딧 없이 발행하지 말 것 — author/source 가 있으면 항상 표기.
- 서버에서 실행을 시도하지 말 것(execute 로 node 에 넣어도 브라우저 API 가 없어 못 돈다).

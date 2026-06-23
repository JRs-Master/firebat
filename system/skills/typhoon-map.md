---
name: typhoon-map
kind: tool-usage
description: 태풍 경로/위치/예상진로 질문 시 — Map 컴포넌트의 태풍 전용 기능으로 풀 렌더(허리케인 마커 icon=typhoon/forecast + windSpeed + 예측 cone + 강풍/폭풍반경 circles + 다줄 label 팝업). 활동 태풍이 여럿이면 한 지도에 전부. plain 색 점 + 별도 반경 표로 그리지 말 것.
---

# 태풍 지도 시각화 (kma_weather → Map)

태풍 경로·위치·예상진로 질문이면 **Map 컴포넌트를 풀로** 렌더한다. Map엔 태풍 전용 기능이
있으니 전부 쓴다. 흔한 실수 = plain 색 점만 찍고 반경을 별도 표에 넣는 것 — 반경·예측은
**지도 위(cone + circles + 허리케인 마커 + 팝업)** 에 올린다.

## 1. 데이터 수집 (kma_weather sysmod)

`kma_weather { action: "typhoon-info" }` → 최근 30일 통보문 `items`. **한 태풍의 여러 발표 회차 +
여러 태풍이 섞여 있다.** "최신 1개"만 집지 말고 정리한다:

- **태풍 식별 = 호수.** `other` 텍스트의 "제N호 태풍 NAME"(예 "제7호 태풍 메칼라") 또는 `typSeq` 필드(=7)에서 읽는다.
  ⚠️ **`tmSeq`는 발표 회차(예 13·14)지 태풍 번호가 아니다 — 절대 "제13호"로 쓰지 말 것.**
  (제7호의 13번째 발표 = tmSeq:13. 이걸 호수로 오독하면 없는 태풍을 지어낸다.)
- **호수별로 묶어 각 묶음의 최신 발표 = 그 태풍의 현재.** 오늘자(또는 가장 최근) 발표가 있는 호수 = 활동 중.
- 각 태풍 현재 필드: `typLat`·`typLon`(위치) / `typWs`(최대풍속 m/s) / `typPs`(중심기압 hPa) /
  `typDir`(진행방향) / `typSp`(이동속도 km/h) / `typ15`(강풍반경 km) / `typ25`(폭풍반경 km) / 이름·위치 문구.

각 활동 태풍마다 `kma_weather { action: "typhoon-forecast", typhoonNo: <호수, 예 7> }` → **예측** items(시점별).
각 item: `tm`(예상시각) / `lat`·`lon` / `ws`(m/s) / `ps`(hPa) / `dir` / `sp` /
`rad15`(강풍반경 km) / `rad25`(폭풍반경 km) / `radPr`(70% 확률반경 km).

**보고는 데이터에 실제 있는 태풍만.** typhoon-info에 든 호수만 "활동 중"으로 말하고, 데이터에 없는
호수를 일반지식으로 덧붙이거나 tmSeq를 호수로 오독하지 말 것.

## 2. Map 렌더 — 요청한 태풍만 (단일 / 다중 분리)

**무엇을 그릴지 = 사용자 요청 범위.** 활동 태풍 전부를 강제로 다 그리지 말 것:
- 특정 태풍 1개("제7호"·"메칼라") → **그 태풍 하나만**. Map 은 그 태풍에 맞게 줌, metric Grid 도 그 태풍.
- 복수 요청("7·8호 같이"·"둘 다"·"활동 태풍 모두") → **요청한 태풍들을 한 Map 에 같이**(전부 보이게 fit).
  태풍마다 아래 세트를 각 배열에 누적, 경로선·cone 색을 태풍별로 구분(예: 태풍A track `#64748b`,
  태풍B track `#f59e0b`)해 겹쳐도 알아보게. metric Grid 는 대표 1세트(나머지는 마커 팝업).
- 막연히 "태풍" → 주력(가장 강하거나 한국 근접) 1개로 그리고, 다른 활동 태풍이 데이터에 있으면
  "제N호 NAME 도 활동 중" 한 줄 언급(데이터에 있는 것만 — 만들어내지 말 것).

아래 markers + line + circles + cone 레시피는 **태풍 1개당** 세트 — 단일은 1세트, 다중 같이는 태풍마다 누적한다.

**markers** — 각 태풍의 현재 + 예측 시점마다 (plain `color` 점 금지):
- 현재: `{ lat: typLat, lon: typLon, icon: "typhoon", windSpeed: typWs, size: "large",
  label: "<제N호 NAME 현재 (MM/DD HH시)>\n중심기압: <typPs> hPa\n최대풍속: <typWs> m/s\n강풍반경: <typ15> km\n위치: <위치문구>" }`
- 예측 각 점: `{ lat, lon, icon: "forecast", windSpeed: ws,
  label: "<제N호 · MM/DD HH시> 예측\n중심기압: <ps> hPa\n최대풍속: <ws> m/s\n강풍반경: <rad15> km" }`
- `windSpeed`가 기상청 강도색 + 중앙 숫자(1~5)를 자동 부여하고, `icon`이 허리케인 소용돌이를 그린다.
  **다줄 `label`**(첫 줄=제목, 이후 `키: 값` 줄)이 리치 팝업 카드로 렌더된다.

**lines** — 각 태풍의 경로(현재 → 예측 체인). 태풍마다 한 줄:
`{ points: [{lat: typLat, lon: typLon}, ...예측 각 {lat, lon}], color: "<태풍별 색>", style: "dashed" }`

**circles** — 각 태풍 현재 강풍·폭풍반경 (m = km × 1000):
`{ lat: typLat, lon: typLon, radius: typ15*1000, color: "#06b6d4" }`,
`{ lat: typLat, lon: typLon, radius: typ25*1000, color: "#6366f1" }`

**cone** — 각 태풍 예측 영역, 2개 겹침(크기 cone + 70% 확률 cone):
`{ points: [{lat: typLat, lon: typLon, radius: typ15*1000}, ...예측 각 {lat, lon, radius: rad15*1000}], color: "#06b6d4" }`,
`{ points: [{lat: typLat, lon: typLon, radius: 0}, ...예측 각 {lat, lon, radius: radPr*1000}], color: "#6366f1" }`

지도 위 metric Grid는 **대표 태풍(가장 강하거나 한국에 가까운)** 기준 1세트(현재 위치 / 중심기압 /
최대풍속 / 이동)면 충분 — 강풍/폭풍반경을 **별도 표로 또 넣지 말 것**(반경은 지도 cone+circles+팝업에
산다). 여러 태풍이면 나머지 태풍 정보는 각 마커 팝업으로 본다.

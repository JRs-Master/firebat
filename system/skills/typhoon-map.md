---
name: typhoon-map
kind: tool-usage
description: 태풍 경로/위치/예상진로 질문 시 — Map 컴포넌트의 태풍 전용 기능으로 풀 렌더(허리케인 마커 icon=typhoon/forecast + windSpeed + 예측 cone + 강풍/폭풍반경 circles + 다줄 label 팝업). plain 색 점 + 별도 반경 표로 그리지 말 것.
---

# 태풍 지도 시각화 (kma_weather → Map)

태풍 경로·위치·예상진로 질문이면 **Map 컴포넌트를 풀로** 렌더한다. Map엔 태풍 전용 기능이
있으니 전부 쓴다. 흔한 실수 = plain 색 점만 찍고 반경을 별도 표에 넣는 것 — 반경·예측은
**지도 위(cone + circles + 허리케인 마커 + 팝업)** 에 올린다.

## 1. 데이터 수집 (kma_weather sysmod)
- `kma_weather { action: "typhoon-info" }` → 최신 item = **현재**. 필드:
  `typLat`·`typLon`(위치) / `typWs`(최대풍속 m/s) / `typPs`(중심기압 hPa) / `typDir`(진행방향) /
  `typSp`(이동속도 km/h) / `typ15`(강풍반경 km, 15m/s) / `typ25`(폭풍반경 km, 25m/s) /
  `typName`·`typEn`(이름) / `typLoc`(위치 문구) / `typTm`(시각) / `typSeq`(태풍 호수, 예 7).
- `kma_weather { action: "typhoon-forecast", typhoonNo: <typSeq, 예 7> }` → **예측** items(시점별).
  각 item: `tm`(예상시각) / `lat`·`lon` / `ws`(m/s) / `ps`(hPa) / `dir` / `sp` /
  `rad15`(강풍반경 km) / `rad25`(폭풍반경 km) / `radPr`(70% 확률반경 km).

## 2. Map 렌더 — markers + lines + circles + cone (전부)

**markers** — 현재 + 예측 시점마다 (plain `color` 점 금지):
- 현재: `{ lat: typLat, lon: typLon, icon: "typhoon", windSpeed: typWs, size: "large",
  label: "<제N호 NAME 현재 (MM/DD HH시)>\n중심기압: <typPs> hPa\n최대풍속: <typWs> m/s\n강풍반경: <typ15> km\n위치: <typLoc>" }`
- 예측 각 점: `{ lat, lon, icon: "forecast", windSpeed: ws,
  label: "<MM/DD HH시> 예측\n중심기압: <ps> hPa\n최대풍속: <ws> m/s\n강풍반경: <rad15> km" }`
- `windSpeed`가 기상청 강도색 + 중앙 숫자(1~5)를 자동 부여하고, `icon`이 허리케인 소용돌이를 그린다.
  **다줄 `label`**(첫 줄=제목, 이후 `키: 값` 줄)이 리치 팝업 카드로 렌더된다.

**lines** — 경로(현재 → 예측 체인):
`lines: [{ points: [{lat: typLat, lon: typLon}, ...예측 각 {lat, lon}], color: "#64748b", style: "dashed" }]`

**circles** — 현재 강풍·폭풍반경 (m = km × 1000):
`circles: [{ lat: typLat, lon: typLon, radius: typ15*1000, color: "#06b6d4" },
           { lat: typLat, lon: typLon, radius: typ25*1000, color: "#6366f1" }]`

**cone** — 예측 영역, 2개 겹침(크기 cone cyan + 70% 확률 cone indigo):
`cone: [
  { points: [{lat: typLat, lon: typLon, radius: typ15*1000}, ...예측 각 {lat, lon, radius: rad15*1000}], color: "#06b6d4" },
  { points: [{lat: typLat, lon: typLon, radius: 0}, ...예측 각 {lat, lon, radius: radPr*1000}], color: "#6366f1" }
]`

Map 위에 간단한 metric Grid(현재 위치 / 중심기압 / 최대풍속 / 이동)는 괜찮다. 단 강풍/폭풍반경을
**별도 표로 또 넣지 말 것** — 반경은 지도(cone + circles + 팝업)에 산다.

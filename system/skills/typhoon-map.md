---
name: typhoon-map
kind: tool-usage
description: 태풍 경로/위치/예상진로 질문 시 — Map 컴포넌트의 태풍 전용 기능으로 풀 렌더. Render a typhoon as a FULL Map (hurricane markers icon=typhoon/forecast + windSpeed, forecast cone, gale/storm radius circles, rich multi-line popups). Do NOT use plain colored dots + a separate radii table.
---

# Typhoon map visualization (kma_weather → Map)

For any typhoon path / position / forecast question, render a **full Map component** using its
dedicated typhoon features. The common failure is rendering plain colored dots + putting radii in a
separate table — the radii/forecast belong **on the map** (cone + circles + hurricane markers + popups).

## 1. Fetch (kma_weather sysmod)
- `kma_weather { action: "typhoon-info" }` → latest item = **current**. Fields:
  `typLat`,`typLon` (position) · `typWs` (max wind m/s) · `typPs` (pressure hPa) · `typDir` (heading) ·
  `typSp` (speed km/h) · `typ15` (gale radius km, 15m/s) · `typ25` (storm radius km, 25m/s) ·
  `typName`/`typEn` (name) · `typLoc` (text location) · `typTm` (time) · `typSeq` (태풍 호수, e.g. 7).
- `kma_weather { action: "typhoon-forecast", typhoonNo: <typSeq, e.g. 7> }` → **forecast** items (one per time).
  Per item: `tm` (forecast time) · `lat`,`lon` · `ws` (m/s) · `ps` (hPa) · `dir` · `sp` ·
  `rad15` (gale radius km) · `rad25` (storm radius km) · `radPr` (70% probability radius km).

## 2. Render the Map — use markers + lines + circles + cone (ALL)

**markers** — current + every forecast point (NOT plain `color` dots):
- current: `{ lat: typLat, lon: typLon, icon: "typhoon", windSpeed: typWs, size: "large",
  label: "<제N호 NAME 현재 (MM/DD HH시)>\n중심기압: <typPs> hPa\n최대풍속: <typWs> m/s\n강풍반경: <typ15> km\n위치: <typLoc>" }`
- each forecast: `{ lat, lon, icon: "forecast", windSpeed: ws,
  label: "<MM/DD HH시> 예측\n중심기압: <ps> hPa\n최대풍속: <ws> m/s\n강풍반경: <rad15> km" }`
- `windSpeed` auto-applies the KMA intensity color + center number (1–5); `icon` draws the hurricane
  swirl. The **multi-line `label`** (first line = title, then `키: 값` lines) renders the rich popup card.

**lines** — the track (current → forecast chain):
`lines: [{ points: [{lat: typLat, lon: typLon}, ...each forecast {lat, lon}], color: "#64748b", style: "dashed" }]`

**circles** — current gale + storm radius (meters = km × 1000):
`circles: [{ lat: typLat, lon: typLon, radius: typ15*1000, color: "#06b6d4" },
           { lat: typLat, lon: typLon, radius: typ25*1000, color: "#6366f1" }]`

**cone** — forecast area, two overlapping (size cone + probability cone):
`cone: [
  { points: [{lat: typLat, lon: typLon, radius: typ15*1000}, ...each forecast {lat, lon, radius: rad15*1000}], color: "#06b6d4" },
  { points: [{lat: typLat, lon: typLon, radius: 0}, ...each forecast {lat, lon, radius: radPr*1000}], color: "#6366f1" }
]`

A compact metric Grid (현재 위치 / 중심기압 / 최대풍속 / 이동) above the Map is fine. Do **not** also
dump the gale/storm radii into a separate Table — they live on the map (cone + circles + popups).

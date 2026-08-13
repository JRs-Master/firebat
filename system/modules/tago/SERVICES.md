# TAGO — the 13 services, transcribed from the vendor guides

Condensed from the official 오픈API활용가이드 .docx files (11 of them) plus the two portal pages for
국내선박운항정보 and 열차정보. Kept because re-reading eleven Word documents to answer "which list
does this id come from" is the cost this file exists to avoid.

**Read this before adding or changing an action.** Four things in here are not guessable from the
endpoint names, and each of them fails silently rather than erroring:

1. **Path case splits the family.** The four bus services (`BusRouteInfoInqireService`,
   `ArvlInfoInqireService`, `BusLcInfoInqireService`, `BusSttnInfoInqireService`) use
   lowercase-initial operations — `/getRouteNoList`. The other nine use uppercase —
   `/GetExpBusTmnList`. Wrong case is a 404.
2. **Response field case splits the same way.** The bus four answer `routeid`, `nodenm`, `gpslati`,
   `citycode`; everything else answers `terminalId`, `depPlandTime`, `cityCode`.
3. **`cityCode` is three different numberings.** Bus services: 도시코드 from their own
   `/getCtyCodeList` (Daejeon = 25). Express / suburbs / train: 도시코드 from `/GetCtyCodeList`.
   Personal mobility: a 지역번호 from `/GetPMProvider`, which is not a 도시코드 list at all.
4. **Express terminals have two id systems for the same terminals.** The arrival service takes
   `depTmnCd` = a bare `010` from `/GetExpBusTmnList`; the schedule service takes `depTerminalId` =
   a prefixed `NAEK010` from `/GetExpBusTrminlList`. Feeding one to the other returns zero rows.

Plus one spelling slip inside a single family: `getSttnThrghRouteList` spells the stop id `nodeid`
while its siblings spell it `nodeId`. The module renames it on the way out so callers never see it.

An empty `items` list has two causes and the response cannot tell them apart: the id came from the
wrong list, or TAGO holds no data for that entity. Nothing 404s either way. Coverage is uneven, so
a perfectly correct id can legitimately return nothing.

**Measured 2026-08-13 — subway timetable coverage.** Station ids were pulled for 20 place names,
grouped into the 32 distinct line families that came back, and one id per family was asked for a
timetable (`dailyTypeCode=01`, `upDownTypeCode=U`). Row counts:

| answers | empty |
|---|---|
| 서울 1호선 236 · 2호선 237 · 3호선 187 · 4호선 233 | **서울 6호선 0** |
| 서울 5호선 191 · 7호선 198 · 8호선 158 | 1호선 코레일 구간 (`MTRKR1*`) 0 |
| 신림선 178 | 부산 1·2·3호선 0 · 대구 1·2호선 0 |
| 수인분당 164 · 경강 59 · 동해 50 · 경춘 47 | 대전 0 · 인천 1·2호선 0 · 광주 0 |
| 대경선 46 · 경의중앙 29 · 서해선 83 | 신분당 0 · 공항철도 0 · GTX-A 0 |
| **부산김해경전철 189** | 에버라인 0 · 자기부상 0 |

**Do not turn this into a rule.** Three tries at one all failed. "서울교통공사 is complete" fails on
6호선; "capital region only" fails on 부산김해경전철; and "these lines have data" fails because the
gaps are not per line at all — see below.

**The empty cell is (station × day type × direction), not the line.** Two findings force this:

- `dailyTypeCode=02` (토요일) returned **zero on 8 of 8 lines**, including every line whose 평일 and
  일요일 tables are full — 서울역 1호선 236 / 0 / 227, 구로 2호선 228 / 0 / 190, 노량진 9호선
  231 / 0 / 179, 신림선 178 / 0 / 145, 수인분당 164 / 0 / 125, 경의중앙 29 / 0 / 18, 부산김해경전철
  189 / 0 / 174.

  **The documentation is not stale — the code space was checked.** Returned rows echo
  `dailyTypeCode` back as `01` and `03`, matching the guide, and no undocumented alternative
  answers: `1`, `2`, `3`, `02`, `00`, `04`, `05` and `SAT` all return zero, as do direction values
  other than `U`/`D`. So 02 is a valid, documented slot that was never populated — not a parameter
  that changed behind an unrevised document.

  **The portal's own worked example for this endpoint returns nothing.** 상세기능4 documents
  `subwayStationId=MTRARA1A01` (서울역 공항철도) with `dailyTypeCode=01`, `upDownTypeCode=D` — zero
  rows, in both directions. Its sibling examples all work: 상세기능1 finds 서울역 (5 rows, the
  first of which is that very id), 상세기능2 returns 62 exit bus routes for `MTRS12228` and
  상세기능3 returns 59 facilities. Only the timetable example is empty. `MTRS12228` itself reads
  232 / 0 / 186 across the three day types, which takes the Saturday count to 9 of 9 lines.

  That makes a support request easy to write and hard to argue with: calling the parameters printed
  in the provider's own guide returns an empty list, and the reproduction steps are the document.

  What that does NOT establish is whether 03 also covers Saturday. Korean subway timetables are
  variously published as 평일/토요일/일요일·공휴일 or as 평일/토·휴일, and the feed cannot tell us
  which one this is. So do not hand 03 over as a Saturday timetable — say the Saturday table is not
  published, and offer 03 as what it is labelled.
- 노량진 1호선 `MTRKR1136` is zero in **all six** day/direction combinations, so it is not a
  parameter mistake. And the station is not unknown to the service: its exit-bus list returns 64
  rows and its exit-facility list 16. Only the timetable is missing for it.

Station, exit and exit-facility lookups cover the whole country — only the timetable is patchy.

⚠️ **Read twice, hours apart, across an outage on the vendor's own site.** The first time,
tago.go.kr showed nothing for 노량진 1호선 either — consistent with a shared outage. Later the site
recovered and showed the timetable, and the open API still returned zero rows for the same station
id, while every line that had answered still answered with identical counts. So the site has data
the open API does not publish; it is a publishing gap, not an outage.

That is a concrete, demonstrable discrepancy — the same organisation serving a timetable on its own
site and an empty list through the API we are licensed against — which makes asking the provider
the sensible route. The guide's last page carries the 교통빅데이터센터 contact. Scraping the site
instead would mean reverse-engineering an undocumented SPA endpoint belonging to the same body whose
documented API we already use.

Still re-measure before treating any line as permanently absent: two readings on one day is evidence,
not a guarantee. The module says "came back empty" rather than "TAGO does not have it" for that
reason.

Two id caveats. The guide's own sample `MTRS11133` (서울역) **no longer exists**; the current 서울역
1호선 id is `MTRS11150`, so sample ids in these documents are not safe to test against. And the id
the API returns is the one to match on — GTX-A comes back as `MTRGXAX106`, which is not necessarily
how the same line is written on tago.go.kr.

---

## 고속버스도착정보v1.1
Base: `http://apis.data.go.kr/1613000/ExpBusArrInfo`
Refresh: 실시간(20분)

| # | op | path |
|---|---|---|
| 1 | 고속버스 터미널목록 조회 | `/GetExpBusTmnList` |
| 2 | 출발지기준 도착지목록 조회 | `/GetArrTmnFromDepTmn` |
| 3 | 고속버스 도착예정정보 조회 | `/GetExpBusArrPrdtInfo` |

### 1. 고속버스 터미널목록 조회
req: tmnNm=부산 (터미널명)
resp: tmnCd=터미널코드 · tmnNm=터미널명

### 2. 출발지기준 도착지목록 조회
req: depTmnCd*=010 (출발터미널코드)
resp: arrTmnCd=도착터미널코드 · arrTmnNm=도착터미널명

### 3. 고속버스 도착예정정보 조회
req: depTmnCd*=010 ([고속버스 터미널목록 조회]의 터미널코드) · arrTmnCd*=700 ([고속버스 터미널목록 조회]의 터미널코드)
resp: depTmnNm=출발터미널명 · arrTmnNm=도착터미널명 · depTm=출발시각 · corpNm=고속사명 · busGrdNm=버스등급명 · rmnTm=남은시간 · curLocNm=현위치명 · arrPrdtTm=도착예정시간

---

## 고속버스정보v1.1
Base: `http://apis.data.go.kr/1613000/ExpBusInfo`
Refresh: 일3회

| # | op | path |
|---|---|---|
| 1 | 출/도착지기반 고속버스정보 조회 | `/GetStrtpntAlocFndExpbusInfo` |
| 2 | 고속버스등급 목록 조회 | `/GetExpBusGradList` |
| 3 | 고속버스터미널 목록 조회 | `/GetExpBusTrminlList` |
| 4 | 도시코드 목록 조회 | `/GetCtyCodeList` |

### 1. 출/도착지기반 고속버스정보 조회
req: depTerminalId*=NAEK010 (출발터미널ID) · arrTerminalId*=NAEK300 (도착터미널ID) · depPlandTime*=20211201 (출발일(YYYYMMDD)) · busGradeId=1 (버스등급)
resp: routeId=노선ID · gradeNm=버스등급 · depPlandTime=출발시간 · arrPlandTime=도착시간 · depPlaceNm=출발지 · arrPlaceNm=도착지 · charge=운임

### 2. 고속버스등급 목록 조회
req: (common only)
resp: gradeId=고속버스등급ID · gradeNm=고속버스등급명

### 3. 고속버스터미널 목록 조회
req: terminalNm=센트럴 (터미널명)
resp: terminalId=터미널ID · terminalNm=터미널명

### 4. 도시코드 목록 조회
req: (common only)
resp: cityCode=도시코드 · cityName=도시명

---

## 국내항공운항정보v1.1
Base: `http://apis.data.go.kr/1613000/DmstcFlightNvgInfo`
Refresh: 실시간(1시간)

| # | op | path |
|---|---|---|
| 1 | 항공운항정보 목록 조회 | `/GetFlightOpratInfoList` |
| 2 | 공항 목록 조회 | `/GetArprtList` |
| 3 | 항공사 목록 조회 | `/GetAirmanList` |

### 1. 항공운항정보 목록 조회
req: depAirportId*=NAARKJJ (출발공항ID) · arrAirportId*=NAARKPC (도착공항ID) · depPlandTime*=20201201 (출발일(YYYYMMDD)) · airlineId=AAR (항공사ID)
resp: vihicleId=항공편명 · airlineNm=항공사명 · depPlandTime=출발시간 · arrPlandTime=도착시간 · economyCharge=일반석운임 · prestigeCharge=비즈니스석운임 · depAirportNm=출발공항 · arrAirportNm=도착공항

### 2. 공항 목록 조회
req: (common only)
resp: airportId=공항ID · airportNm=공항명

### 3. 항공사 목록 조회
req: (common only)
resp: airlineId=항공사ID · airlineNm=항공사명

---

## 버스노선정보v1.0
Base: `http://apis.data.go.kr/1613000/BusRouteInfoInqireService`
Refresh: 일 1회

| # | op | path |
|---|---|---|
| 1 | 노선번호목록 조회 | `/getRouteNoList` |
| 2 | 노선별경유정류소목록 조회 | `/getRouteAcctoThrghSttnList` |
| 3 | 노선정보항목 조회 | `/getRouteInfoIem` |
| 4 | 도시코드 목록 조회 | `/getCtyCodeList` |

### 1. 노선번호목록 조회
req: cityCode*=25 (도시코드[상세기능4. 도시코드 목록 조회]에서 조회 가능) · routeNo=5 (노선번호)
resp: routeid=노선ID · routeno=노선번호 · routetp=노선유형 · endnodenm=종점 · startnodenm=기점 · endvehicletime=막차시간 · startvehicletime=첫차시간

### 2. 노선별경유정류소목록 조회
req: cityCode*=25 (도시코드[상세기능4. 도시코드 목록 조회]에서 조회 가능) · routeId*=DJB30300004 (노선ID[상세기능1. 노선번호목록 조회]에서 조회 가능)
resp: routeid=노선ID · nodeid=정류소ID · nodenm=정류소명 · nodeno=정류소번호 · nodeord=정류소순번 · gpslati=정류소 Y좌표 · gpslong=정류소 X좌표 · updowncd=상하행구분코드

### 3. 노선정보항목 조회
req: cityCode*=25 (도시코드[상세기능4. 도시코드 목록 조회]에서 조회 가능) · routeId*=DJB30300004 (노선ID[상세기능1. 노선번호목록 조회]에서 조회 가능)
resp: routeid=노선ID · routeno=노선번호 · routetp=노선유형 · endnodenm=종점 · startnodenm=기점 · endvehicletime=막차시간 · startvehicletime=첫차시간 · intervaltime=배차간격(평일) · intervalsattime=배차간격(토요일) · intervalsuntime=배차간격(일요일)

### 4. 도시코드 목록 조회
req: (common only)
resp: citycode=도시코드 · cityname=도시명

---

## 버스도착정보v1.0
Base: `http://apis.data.go.kr/1613000/ArvlInfoInqireService`
Refresh: 실시간(10~20초)

| # | op | path |
|---|---|---|
| 1 | 정류소별 도착예정정보 목록 조회 | `/getSttnAcctoArvlPrearngeInfoList` |
| 2 | 정류소별 특정노선버스도착예정정보 목록 조회 | `/getSttnAcctoSpcifyRouteBusArvlPrearngeInfoList` |
| 3 | 도시코드 목록 조회 | `/getCtyCodeList` |

### 1. 정류소별도착예정정보 목록 조회
req: cityCode*=25 (도시코드[상세기능3 도시코드 목록 조회]에서 조회 가능) · nodeId*=DJB8001793 (정류소ID[국토교통부(TAGO)_버스정류소정보]에서 조회가능)
resp: nodeid=정류소ID · nodenm=정류소명 · routeid=노선ID · routeno=노선번호 · routetp=노선유형 · arrprevstationcnt=도착예정버스 남은 정류장 수 · vehicletp=도착예정버스 차량유형 · arrtime=도착예정버스 도착예상시간

### 2. 정류소별특정노선버스 도착예정정보 목록조회
req: cityCode*=25 (도시코드[상세기능3 도시코드 목록 조회]에서 조회 가능) · nodeId*=DJB8001793 (정류소ID[국토교통부(TAGO)_버스정류소정보]에서 조회가능) · routeId*=DJB30300002 (노선ID)
resp: nodeid=정류소ID · nodenm=정류소명 · routeid=노선ID · routeno=노선번호 · routetp=노선유형 · arrprevstationcnt=도착예정버스 남은 정류장 수 · vehicletp=도착예정버스 차량유형 · arrtime=도착예정버스 도착예상시간

### 3. 도시코드 목록 조회
req: (common only)
resp: citycode=도시코드 · cityname=도시명

---

## 버스위치정보v1.0
Base: `http://apis.data.go.kr/1613000/BusLcInfoInqireService`
Refresh: 실시간(10~20초)

| # | op | path |
|---|---|---|
| 1 | 노선별버스위치 목록조회 | `/getRouteAcctoBusLcList` |
| 2 | 노선별특정정류소접근 버스위치정보조회 | `/getRouteAcctoSpcifySttnAccesBusLcInfo` |
| 3 | 도시코드 목록 조회 | `/getCtyCodeList` |

### 1. 노선별버스위치 목록조회
req: cityCode*=25 (도시코드[상세기능3 도시코드 목록 조회]에서 조회 가능) · routeId*=DJB30300052 (노선ID[국토교통부(TAGO)_버스노선정보]에서 조회가능)
resp: routenm=노선번호 · gpslati=맵매칭 Y좌표 · gpslong=맵매칭 X좌표 · nodeord=정류소 순서 · nodenm=정류소명 · nodeid=정류소ID · routetp=노선유형 · vehicleno=차량번호

### 2. 노선별특정정류소접근 버스위치정보조회
req: routeId*=DJB30300037 (노선ID[국토교통부(TAGO)_버스노선정보]에서 조회가능) · nodeId*=DJB8007268 (정류소ID[국토교통부(TAGO)_버스정류소정보]에서 조회가능) · cityCode*=25 (도시코드[상세기능3 도시코드 목록 조회]에서 조회 가능)
resp: routenm=노선번호 · nodenm=정류소명 · gpslati=맵매칭 Y좌표 · gpslong=맵매칭 X좌표 · routetp=노선유형

### 3. 도시코드 목록 조회
req: (common only)
resp: citycode=도시코드 · cityname=도시명

---

## 버스정류소정보v1.0
Base: `http://apis.data.go.kr/1613000/BusSttnInfoInqireService`
Refresh: 일 1회

| # | op | path |
|---|---|---|
| 1 | 정류소번호 목록조회 | `/getSttnNoList` |
| 2 | 좌표기반근접정류소 목록조회 | `/getCrdntPrxmtSttnList` |
| 3 | 도시코드 목록 조회 | `/getCtyCodeList` |
| 4 | 정류소별경유노선 목록조회 | `/getSttnThrghRouteList` |

### 1. 정류소번호 목록조회
req: cityCode*=25 (도시코드) · nodeNm=전통시장 (정류소명) · nodeNo=44810 (정류소번호)
resp: gpslati=정류소 Y좌표 · gpslong=정류소 X좌표 · nodeid=정류소ID · nodenm=정류소명 · nodeno=정류소번호

### 2. 좌표기반근접정류소 목록조회
req: gpsLati*=36.3 (WGS84 위도 좌표) · gpsLong*=127.3 (WGS84 경도 좌표)
resp: gpslati=정류소 Y좌표 · gpslong=정류소 X좌표 · nodeid=정류소ID · nodenm=정류소명 · citycode=도시코드

### 3. 도시코드 목록 조회
req: (common only)
resp: citycode=도시코드 · cityname=도시명

### 4. 정류소별경유노선 목록조회
req: cityCode*=25 (도시코드) · nodeid*=DJB8002536 (정류소ID)
resp: routeid=노선ID · routeno=노선번호 · routetp=노선유형 · endnodenm=종점 · startnodenm=기점

---

## 시외버스정보v1.1
Base: `http://apis.data.go.kr/1613000/SuburbsBusInfo`
Refresh: 일1회

| # | op | path |
|---|---|---|
| 1 | 시외버스등급 목록 조회 | `/GetSuberbsBusGradList` |
| 2 | 시외버스 터미널 목록 조회 | `/GetSuberbsBusTrminlList` |
| 3 | 출/도착지기반 시외버스정보 조회 | `/GetStrtpntAlocFndSuberbsBusInfo` |
| 4 | 도시코드 목록 조회 | `/GetCtyCodeList` |

### 1. 시외버스등급 목록 조회
req: (common only)
resp: gradeId=시외버스등급ID · gradeNm=시외버스등급명

### 2. 시외버스 터미널 목록 조회
req: terminalNm=서울남부 (터미널명) · cityCode=11 (도시코드)
resp: terminalId=터미널ID · terminalNm=터미널명 · cityName=도시명

### 3. 출/도착지기반 시외버스정보 조회
req: depTerminalId*=NAI0671801 (출발터미널ID) · arrTerminalId*=NAI3214401 (도착터미널ID) · depPlandTime*=20211201 (출발일(YYYYMMDD)) · busGradeId=IDG (버스등급)
resp: routeId=노선ID · gradeNm=버스등급 · depPlandTime=출발시간 · arrPlandTime=도착시간 · depPlaceNm=출발지 · arrPlaceNm=도착지 · charge=운임

### 4. 도시코드 목록 조회
req: (common only)
resp: cityCode=도시코드 · cityName=도시명

---

## 지하철정보v1.1
Base: `http://apis.data.go.kr/1613000/SubwayInfo`
Refresh: 주1회

| # | op | path |
|---|---|---|
| 1 | 키워드기반 지하철역 목록 조회 | `/GetKwrdFndSubwaySttnList` |
| 2 | 지하철역출구별 버스노선 목록 조회 | `/GetSubwaySttnExitAcctoBusRouteList` |
| 3 | 지하철역출구별 주변 시설 목록 조회 | `/GetSubwaySttnExitAcctoCfrFcltyList` |
| 4 | 지하철역별 시간표 목록조회 | `/GetSubwaySttnAcctoSchdulList` |

### 1. 키워드기반 지하철역 목록 조회
req: subwayStationName=서울역 (지하철역명)
resp: subwayStationId=지하철역ID · subwayStationName=지하철역명 · subwayRouteName=노선명

### 2. 지하철역출구별 버스노선 목록 조회
req: subwayStationId*=MTRS11133 (지하철역ID[상세기능1. 지하철역 목록조회]에서 조회 가능)
resp: exitNo=출구번호 · busRouteNo=버스번호

### 3. 지하철역출구별 주변 시설 목록 조회
req: subwayStationId*=MTRS11133 (지하철역ID[상세기능1. 지하철역 목록조회]에서 조회 가능)
resp: exitNo=출구번호 · dirDesc=시설명

### 4. 지하철역별 시간표 목록조회
req: subwayStationId*=MTRS11133 (지하철역ID[상세기능1. 지하철역 목록조회]에서 조회 가능) · dailyTypeCode*=01 (요일구분코드(01:평일, 02:토요일, 03:일요일)) · upDownTypeCode*=D (상하행구분코드(U:상행, D:하행))
resp: subwayRouteId=지하철노선ID · subwayStationId=지하철역ID · subwayStationNm=지하철역명 · dailyTypeCode=요일구분코드 · upDownTypeCode=상하행구분코드 · depTime=출발시간 · arrTime=도착시간 · endSubwayStationId=종점지하철역ID · endSubwayStationNm=종점지하철역명

---

## 카셰어링정보v1.1
Base: `http://apis.data.go.kr/1613000/CarSharingInfo`
Refresh: 일1회

| # | op | path |
|---|---|---|
| 1 | 이름기반 차고지 목록 조회 | `/GetCarZoneListByName` |
| 2 | 주소기반 차고지 목록 조회 | `/GetCarZoneListByAddr` |
| 3 | 좌표기반 차고지 목록 조회 | `/GetCarZoneListByCoord` |

### 1. 이름기반 차고지 목록 조회
req: zoneName*=서울역 (차고지명)
resp: zoneId=차고지ID · zoneName=차고지명 · address=주소 · latitude=GPS위도 · longitude=GPS경도 · type=차고지타입

### 2. 주소기반 차고지 목록 조회
req: zoneAddr*=서울 중구 (주소)
resp: zoneId=차고지ID · zoneName=차고지명 · address=주소 · latitude=GPS위도 · longitude=GPS경도 · type=차고지타입

### 3. 좌표기반 차고지 목록 조회
req: latitude*=37.553638 (위도(WGS84)) · longitude*=126.975494 (경도(WGS84)) · radius=2 (반경(Km)[기본값:2,최댓값:10])
resp: zoneId=차고지ID · zoneName=차고지명 · address=주소 · latitude=GPS위도 · longitude=GPS경도 · type=차고지타입

---

## 퍼스널모빌리티정보v1.1
Base: `http://apis.data.go.kr/1613000/PersonalMobilityInfo`
Refresh: 10초

| # | op | path |
|---|---|---|
| 1 | 지역별 운영사기반 탑승가능 공유전동킥보드 목록 조회 | `/GetPMListByProvider` |
| 2 | 지역별 공유전동킥보드 운영사 목록 조회 | `/GetPMProvider` |

### 1. 지역별 운영사기반 공유전동킥보드 목록 조회
req: providerName*=SWING (운영사명) · cityCode*=12 (지역번호)
resp: providerName=운영사명 · vehicleID=장치ID · battery=베터리잔량 · cityCode=지역번호 · cityName=지역명 · latitude=GPS위도 · longitude=GPS경도

### 2. 지역별 공유전동킥보드 운영사 목록 조회
req: providerName=SWING (공유킥보드 운영사명* 미입력시 전체 조회) · cityName=세종 (시군단위 지역명* 미입력시 전체 조회)
resp: cityName=지역명 · cityCode=지역코드 · providerName=운영사명

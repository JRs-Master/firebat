# 국가법령정보 DRF — target 표

전사 원본 = 법제처 OPEN API 가이드(2026-08-13 사용자 제공분). **여기 없는 건 안 적은 것이지
없는 게 아니다** — 문서를 받은 target 만 있다.

두 엔드포인트뿐이고 모든 target 이 같은 모양을 쓴다:

- 목록 `lawSearch.do?target=X` — 공통 가족 `query · display(≤100) · page · sort · gana · popYn`
- 본문 `lawService.do?target=X` — `ID | MST` 중 하나 필수, + `LM · LD · LN`, 일부 `JO`

아래 표의 "고유"는 그 target 에만 있는 것. `구현` = 우리 모듈이 현재 다루는가.

## 법령 본체

| target | 뜻 | 목록 고유 | 본문 | 구현 |
|---|---|---|---|---|
| `law` | 현행법령(공포일 기준) | `search·date·efYd·ancYd·ancNo·rrClsCd·nb·org·knd·lsChapNo` | `ID\|MST` + `LM·LD·LN·JO·LANG` | ✅ |
| `eflaw` | 현행법령(시행일 기준) | `search·nw·LID·date·efYd·ancYd·ancNo·rrClsCd·nb·org·knd` | `ID\|MST` + **`efYd` (MST 와 함께면 필수, ID 면 무시)** + `JO·chrClsCd` | ✅ (명시 호출만) |
| `lsHistory` | 연혁법령 | `date·efYd·ancYd·ancNo·rrClsCd·org·knd·lsChapNo` | `ID\|MST` + `LM·LD·LN·chrClsCd` | ✅ |
| `elaw` | 영문법령 | `search·date·efYd·ancYd·ancNo·rrClsCd·nb·org·knd` | `ID\|MST` + `LM·LD·LN` | ⬜ |
| `lawjosub` | 조·항·호·목 (공포일) | — | `ID\|MST` + **`JO` 필수** + `HANG·HO·MOK` | ✅ (article) |
| `eflawjosub` | 조·항·호·목 (시행일) | — | `ID\|MST` + **`efYd`·`JO` 필수** + `HANG·HO·MOK` | ⬜ |

## 이력·비교·구조

| target | 뜻 | 목록 고유 | 본문 | 구현 |
|---|---|---|---|---|
| `lsHstInf` | 법령 변경이력 | **`regDt` 필수** + `org` | — | ⬜ |
| `lsJoHstInf` | 조문 개정이력 | `regDt \| fromRegDt+toRegDt` + `ID·JO·org` | **`ID`·`JO` 필수** + `display·page` | ⬜ |
| `oldAndNew` | 신구법 비교 | `efYd·ancYd·date·nb·ancNo·rrClsCd·org·knd` | `ID\|MST` + `LM·LD·LN` | ⬜ |
| `thdCmp` | 3단 비교 | 위와 동일 | **`knd` 필수(1=인용, 2=위임)** + `ID\|MST` + `LM·LD·LN` | ⬜ |
| `lsStmd` | 법령 체계도 | 위와 동일 | `ID\|MST` + `LM·LD·LN` | ⬜ |
| `lsDelegated` | 위임 법령 | — | `ID\|MST` | ⬜ |
| `lsAbrv` | 법령명 약칭 | `stdDt·endDt` (query 없음) | — | ⬜ |
| `delHst` | 삭제 데이터 | `knd(1법령/2행정규칙/3자치법규/13학칙공단)·delDt·frmDt·toDt` | — | ⬜ |
| `oneview` | 한눈보기 | `query·display·page` 뿐 | **`MST`** (ID 없음) + `LM·LD·LN·JO` | ⬜ |

## 행정규칙 · 자치법규

| target | 뜻 | 목록 고유 | 본문 | 구현 |
|---|---|---|---|---|
| `admrul` | 행정규칙 | `nw·search·org·knd(1훈령~6기타)·date·prmlYd·modYd·nb` | **`ID`=행정규칙일련번호 / `LID`=행정규칙ID** + `LM` — 법령과 이름이 반대다 | ✅ |
| `admrulOldAndNew` | 행정규칙 신구법 | `org·knd·date·prmlYd·nb` | — | ⬜ |
| `ordin` | 자치법규 | `nw·search·date·efYd·ancYd·ancNo·nb·org·sborg·knd(30001조례…)·rrClsCd·ordinFd·lsChapNo` | **`ID`=자치법규ID / `MST`=자치법규일련번호** | ✅ |
| `ordinfd` | 자치법규 분야 | **`org` 필수** (query 없음) | — | ⬜ |

## 연계

| target | 뜻 | 목록 고유 | 구현 |
|---|---|---|---|
| `lnkLs` | 법령↔자치법규 연계 법령 | `query` | ⬜ |
| `lnkLsOrdJo` | 법령별 조례 조문 | `knd` + **`JO` 4자리 · `JOBR` 2자리**(여기만 6자리가 아니다) | ⬜ |
| `lnkLsOrd` | 법령별 조례 | `knd`(법령ID 를 넣는다) | ⬜ |
| `lnkOrd` | 연계 조례 | `query` | ⬜ |
| `lnkOrg` | 지자체별 연계 조례 | `org` | ⬜ |
| `lnkDep` | 소관부처별 연계 법령 | `org` | ⬜ |
| `drlaw` | 연계 현황 | 없음(HTML 전용) | ⬜ |

## 판례·해석례

| target | 뜻 | 목록 고유 | 본문 | 구현 |
|---|---|---|---|---|
| `prec` | 판례 | `search·org(400201대법원/400202하위)·curt·**JO**·date·prncYd·nb·datSrcNm` | **`ID` 필수** + `LM` | ✅ |
| `detc` | 헌재결정례 | `search·date·edYd·nb` | **`ID` 필수** + `LM` | ✅ |
| `expc` | 법령해석례 | `search·inq·rpl·itmno·regYd·explYd` | **`ID` 필수** + `LM` | ✅ |
| `decc` | 행정심판례 | `search·cls·date·dpaYd·rslYd` | — | ⬜ |
| `trty` | 조약 | `eftYd·concYd·cls(1양자/2다자)·natCd` | `ID\|MST` + `chrClsCd` | ✅ |

## 위원회 결정문 — 한 가족, 한 모양

목록은 공통 가족(`search 1=사건/안건명 · 2=본문`, `query · display · page · gana · sort · popYn`)
뿐이고, 본문은 **`ID`(결정문 일련번호) 하나만** 받는다. MST 도 LM 도 없다.

| target | 뜻 | 구현 |
|---|---|---|
| `decc` | 행정심판례 (목록 고유 `cls · date · dpaYd · rslYd`, 본문 `ID` + `LM`) | ⬜ |
| `ppc` | 개인정보보호위원회 결정문 | ⬜ |
| `eiac` | 고용보험심사위원회 결정문 | ⬜ |
| `ftc` | 공정거래위원회 결정문 (본문이 **의결서/시정권고서 두 스키마**로 갈린다 — `문서유형` 이 구분) | ⬜ |
| `acr` | 국민권익위원회 결정문 (목록 `search 1=민원표시`) | ⬜ |
| `fsc` | 금융위원회 결정문 (정렬에 날짜옵션 없음 — `lasc/ldes/nasc/ndes` 뿐) | ⬜ |

`ppc`·`eiac`·`ftc`·`acr`·`fsc` 는 https 로 문서화돼 있다(나머지는 http). 같은 호스트라 스킴만 맞추면 된다.

## 이름이 겹치는데 뜻이 다른 것 (사고 지점)

- **`JO`** — 법령 본문에선 **조번호 6자리 = 조번호(4) + 조가지번호(2), 왼쪽 정렬**
  (제840조 = `084000`. 오른쪽 정렬로 읽어 `008400` 을 쓰면 제84조가 나온다 — 2026-08-13 실측).
  그런데 **`prec` 검색에선 참조법령명 문자열**("민법")이고, **`lnkLsOrdJo` 에선 4자리**다.
- **`ID` / `MST`** — 법령은 `ID`=법령ID, `MST`=법령일련번호. **admrul 은 반대**(`ID`=일련번호,
  `LID`=행정규칙ID), **ordin 은 `ID`=자치법규ID, `MST`=일련번호**. 검색 행에 둘이 나란히 오므로
  섞어 쓰면 "일치하는 법령이 없습니다" 가 돌아온다.
- **`knd`** — 대개 종류 코드인데 **`lnkLsOrd` 에서는 법령ID**, **`thdCmp` 에서는 1/2 비교유형**이다.
- **`nw`** — law/eflaw 는 1연혁·2예정·3현행, **admrul·ordin 은 1현행·2연혁**으로 뒤집혀 있다.

## 리팩터 메모

target 별 `if` 분기가 아니라 이 표를 데이터로 두면, 새 target 은 한 줄이고 `target` enum·설명·
ID 필드명·검증이 전부 한 곳에서 파생된다. 응답 파싱은 제네릭 + raw 폴백을 유지하고, 각 target
첫 실호출에서 루트 키를 확정한다(문서가 명세하는 건 요청 모양이라 요청 조립은 지금도 검증 가능).

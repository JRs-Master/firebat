#!/usr/bin/env node
/**
 * Firebat System Module: kiwoom — codegen 생성 (scripts/gen.mjs, index.mjs 전용).
 * 키움증권 OPEN API 통합 — 국내(/api/dostk/*) + 미국주식(/api/us/*).
 *
 * action 으로 API ID (ka10001 / ust20000 등) 직접 호출. URL_CATEGORY 가 서브경로를 결정
 * (dostk/* 국내, us/* 미국). 발견 = search_module_actions → get_action_schema.
 *
 * OAuth + callApi + throttle (초당 5회) 내장.
 */

const BASE_REAL = 'https://api.kiwoom.com';
const BASE_MOCK = 'https://mockapi.kiwoom.com';

// API ID → URL 서브경로 (POST /api/{서브경로} + api-id 헤더). dostk/* = 국내, us/* = 미국주식.
const URL_CATEGORY = {
  "ka00001": "dostk/acnt",
  "ka00198": "dostk/stkinfo",
  "ka01300": "dostk/watchlist",
  "ka01301": "dostk/watchlist",
  "ka01690": "dostk/acnt",
  "ka10001": "dostk/stkinfo",
  "ka10002": "dostk/stkinfo",
  "ka10003": "dostk/stkinfo",
  "ka10004": "dostk/mrkcond",
  "ka10005": "dostk/mrkcond",
  "ka10006": "dostk/mrkcond",
  "ka10007": "dostk/mrkcond",
  "ka10008": "dostk/frgnistt",
  "ka10009": "dostk/frgnistt",
  "ka10010": "dostk/sect",
  "ka10011": "dostk/mrkcond",
  "ka10013": "dostk/stkinfo",
  "ka10014": "dostk/shsa",
  "ka10015": "dostk/stkinfo",
  "ka10016": "dostk/stkinfo",
  "ka10017": "dostk/stkinfo",
  "ka10018": "dostk/stkinfo",
  "ka10019": "dostk/stkinfo",
  "ka10020": "dostk/rkinfo",
  "ka10021": "dostk/rkinfo",
  "ka10022": "dostk/rkinfo",
  "ka10023": "dostk/rkinfo",
  "ka10024": "dostk/stkinfo",
  "ka10025": "dostk/stkinfo",
  "ka10026": "dostk/stkinfo",
  "ka10027": "dostk/rkinfo",
  "ka10028": "dostk/stkinfo",
  "ka10029": "dostk/rkinfo",
  "ka10030": "dostk/rkinfo",
  "ka10031": "dostk/rkinfo",
  "ka10032": "dostk/rkinfo",
  "ka10033": "dostk/rkinfo",
  "ka10034": "dostk/rkinfo",
  "ka10035": "dostk/rkinfo",
  "ka10036": "dostk/rkinfo",
  "ka10037": "dostk/rkinfo",
  "ka10038": "dostk/rkinfo",
  "ka10039": "dostk/rkinfo",
  "ka10040": "dostk/rkinfo",
  "ka10042": "dostk/rkinfo",
  "ka10043": "dostk/stkinfo",
  "ka10044": "dostk/mrkcond",
  "ka10045": "dostk/mrkcond",
  "ka10046": "dostk/mrkcond",
  "ka10047": "dostk/mrkcond",
  "ka10048": "dostk/elw",
  "ka10050": "dostk/elw",
  "ka10051": "dostk/sect",
  "ka10052": "dostk/stkinfo",
  "ka10053": "dostk/rkinfo",
  "ka10054": "dostk/stkinfo",
  "ka10055": "dostk/stkinfo",
  "ka10058": "dostk/stkinfo",
  "ka10059": "dostk/stkinfo",
  "ka10060": "dostk/chart",
  "ka10061": "dostk/stkinfo",
  "ka10062": "dostk/rkinfo",
  "ka10063": "dostk/mrkcond",
  "ka10064": "dostk/chart",
  "ka10065": "dostk/rkinfo",
  "ka10066": "dostk/mrkcond",
  "ka10068": "dostk/slb",
  "ka10069": "dostk/slb",
  "ka10072": "dostk/acnt",
  "ka10073": "dostk/acnt",
  "ka10074": "dostk/acnt",
  "ka10075": "dostk/acnt",
  "ka10076": "dostk/acnt",
  "ka10077": "dostk/acnt",
  "ka10078": "dostk/mrkcond",
  "ka10079": "dostk/chart",
  "ka10080": "dostk/chart",
  "ka10081": "dostk/chart",
  "ka10082": "dostk/chart",
  "ka10083": "dostk/chart",
  "ka10084": "dostk/stkinfo",
  "ka10085": "dostk/acnt",
  "ka10086": "dostk/mrkcond",
  "ka10087": "dostk/mrkcond",
  "ka10088": "dostk/acnt",
  "ka10094": "dostk/chart",
  "ka10095": "dostk/stkinfo",
  "ka10098": "dostk/rkinfo",
  "ka10099": "dostk/stkinfo",
  "ka10100": "dostk/stkinfo",
  "ka10101": "dostk/stkinfo",
  "ka10102": "dostk/stkinfo",
  "ka10131": "dostk/frgnistt",
  "ka10170": "dostk/acnt",
  "ka20001": "dostk/sect",
  "ka20002": "dostk/sect",
  "ka20003": "dostk/sect",
  "ka20004": "dostk/chart",
  "ka20005": "dostk/chart",
  "ka20006": "dostk/chart",
  "ka20007": "dostk/chart",
  "ka20008": "dostk/chart",
  "ka20009": "dostk/sect",
  "ka20019": "dostk/chart",
  "ka20068": "dostk/slb",
  "ka30001": "dostk/elw",
  "ka30002": "dostk/elw",
  "ka30003": "dostk/elw",
  "ka30004": "dostk/elw",
  "ka30005": "dostk/elw",
  "ka30009": "dostk/elw",
  "ka30010": "dostk/elw",
  "ka30011": "dostk/elw",
  "ka30012": "dostk/elw",
  "ka40001": "dostk/etf",
  "ka40002": "dostk/etf",
  "ka40003": "dostk/etf",
  "ka40004": "dostk/etf",
  "ka40006": "dostk/etf",
  "ka40007": "dostk/etf",
  "ka40008": "dostk/etf",
  "ka40009": "dostk/etf",
  "ka40010": "dostk/etf",
  "ka50010": "dostk/mrkcond",
  "ka50012": "dostk/mrkcond",
  "ka50079": "dostk/chart",
  "ka50080": "dostk/chart",
  "ka50081": "dostk/chart",
  "ka50082": "dostk/chart",
  "ka50083": "dostk/chart",
  "ka50087": "dostk/mrkcond",
  "ka50091": "dostk/chart",
  "ka50092": "dostk/chart",
  "ka50100": "dostk/mrkcond",
  "ka50101": "dostk/mrkcond",
  "ka52301": "dostk/frgnistt",
  "ka90001": "dostk/thme",
  "ka90002": "dostk/thme",
  "ka90003": "dostk/stkinfo",
  "ka90004": "dostk/stkinfo",
  "ka90005": "dostk/mrkcond",
  "ka90006": "dostk/mrkcond",
  "ka90007": "dostk/mrkcond",
  "ka90008": "dostk/mrkcond",
  "ka90009": "dostk/rkinfo",
  "ka90010": "dostk/mrkcond",
  "ka90012": "dostk/slb",
  "ka90013": "dostk/mrkcond",
  "kt00001": "dostk/acnt",
  "kt00002": "dostk/acnt",
  "kt00003": "dostk/acnt",
  "kt00004": "dostk/acnt",
  "kt00005": "dostk/acnt",
  "kt00007": "dostk/acnt",
  "kt00008": "dostk/acnt",
  "kt00009": "dostk/acnt",
  "kt00010": "dostk/acnt",
  "kt00011": "dostk/acnt",
  "kt00012": "dostk/acnt",
  "kt00013": "dostk/acnt",
  "kt00015": "dostk/acnt",
  "kt00016": "dostk/acnt",
  "kt00017": "dostk/acnt",
  "kt00018": "dostk/acnt",
  "kt10000": "dostk/ordr",
  "kt10001": "dostk/ordr",
  "kt10002": "dostk/ordr",
  "kt10003": "dostk/ordr",
  "kt10006": "dostk/crdordr",
  "kt10007": "dostk/crdordr",
  "kt10008": "dostk/crdordr",
  "kt10009": "dostk/crdordr",
  "kt20016": "dostk/stkinfo",
  "kt20017": "dostk/stkinfo",
  "kt50000": "dostk/ordr",
  "kt50001": "dostk/ordr",
  "kt50002": "dostk/ordr",
  "kt50003": "dostk/ordr",
  "kt50020": "dostk/acnt",
  "kt50021": "dostk/acnt",
  "kt50030": "dostk/acnt",
  "kt50031": "dostk/acnt",
  "kt50032": "dostk/acnt",
  "kt50075": "dostk/acnt",
  "usa01980": "us/rkinfo",
  "usa01990": "us/rkinfo",
  "usa06010": "us/chart",
  "usa06011": "us/chart",
  "usa06012": "us/chart",
  "usa06013": "us/chart",
  "usa06014": "us/chart",
  "usa06015": "us/chart",
  "usa06016": "us/chart",
  "usa10098": "us/stkinfo",
  "usa10099": "us/stkinfo",
  "usa10100": "us/stkinfo",
  "usa10101": "us/stkinfo",
  "usa10102": "us/stkinfo",
  "usa10104": "us/stkinfo",
  "usa10105": "us/stkinfo",
  "usa20100": "us/mrkcond",
  "usa20101": "us/mrkcond",
  "usa20150": "us/mrkcond",
  "usa20151": "us/mrkcond",
  "usa20200": "us/watchlist",
  "usa20201": "us/watchlist",
  "usa20510": "us/rkinfo",
  "usa20511": "us/rkinfo",
  "usa20512": "us/rkinfo",
  "usa20520": "us/stkinfo",
  "usa20521": "us/stkinfo",
  "usa20530": "us/rkinfo",
  "usa20531": "us/rkinfo",
  "usa20540": "us/rkinfo",
  "usa20541": "us/rkinfo",
  "usa20550": "us/rkinfo",
  "usa20551": "us/rkinfo",
  "usa20570": "us/stkinfo",
  "usa20571": "us/stkinfo",
  "usa20590": "us/mrkcond",
  "usa20880": "us/rkinfo",
  "usa20881": "us/rkinfo",
  "usa20910": "us/rkinfo",
  "usa20911": "us/rkinfo",
  "usa20920": "us/rkinfo",
  "usa20921": "us/rkinfo",
  "usa20922": "us/rkinfo",
  "usa20930": "us/stkinfo",
  "usa20931": "us/stkinfo",
  "usa20932": "us/stkinfo",
  "usa20940": "us/rkinfo",
  "usa20941": "us/rkinfo",
  "usa20960": "us/rkinfo",
  "usa20961": "us/rkinfo",
  "usa20970": "us/stkinfo",
  "usa20971": "us/stkinfo",
  "usa20972": "us/stkinfo",
  "usa21670": "us/acnt",
  "usa21680": "us/acnt",
  "usa21690": "us/acnt",
  "usa21730": "us/acnt",
  "usa21731": "us/acnt",
  "usa21732": "us/acnt",
  "usa23000": "us/sect",
  "usa23100": "us/sect",
  "usa23400": "us/stkinfo",
  "usa23401": "us/stkinfo",
  "usa23402": "us/stkinfo",
  "usa24100": "us/stkinfo",
  "usa24101": "us/stkinfo",
  "usa24110": "us/rkinfo",
  "usa24111": "us/rkinfo",
  "usa24120": "us/rkinfo",
  "usa24121": "us/rkinfo",
  "usa24140": "us/stkinfo",
  "usa24141": "us/stkinfo",
  "usa24150": "us/rkinfo",
  "usa24151": "us/rkinfo",
  "usa24160": "us/rkinfo",
  "usa24161": "us/rkinfo",
  "usa24162": "us/rkinfo",
  "usa24200": "us/rkinfo",
  "usa24201": "us/rkinfo",
  "usa24210": "us/stkinfo",
  "usa24211": "us/stkinfo",
  "usa24220": "us/stkinfo",
  "usa24221": "us/stkinfo",
  "usa24290": "us/rkinfo",
  "usa24291": "us/rkinfo",
  "usa24300": "us/invtinfo",
  "usa26410": "us/stkinfo",
  "usa26411": "us/stkinfo",
  "usa26412": "us/stkinfo",
  "usa26413": "us/stkinfo",
  "usa26414": "us/stkinfo",
  "ust20000": "us/ordr",
  "ust20001": "us/ordr",
  "ust20002": "us/ordr",
  "ust20003": "us/ordr",
  "ust21050": "us/acnt",
  "ust21070": "us/acnt",
  "ust21100": "us/acnt",
  "ust21110": "us/acnt",
  "ust21111": "us/acnt",
  "ust21120": "us/acnt",
  "ust21121": "us/acnt",
  "ust21131": "us/acnt",
  "ust21132": "us/acnt",
  "ust21150": "us/acnt",
  "ust21160": "us/acnt",
  "ust21170": "us/acnt",
  "ust21180": "us/acnt",
  "ust21510": "us/acnt",
  "ust21530": "us/acnt",
  "ust21610": "us/acnt",
  "ust21620": "us/acnt",
  "ust21630": "us/acnt",
  "ust21640": "us/acnt",
  "ust21650": "us/acnt",
  "ust21660": "us/acnt",
  "ust21661": "us/acnt",
  "ust31300": "us/exchange",
  "ust31301": "us/exchange",
  "ust31302": "us/exchange",
  "ust31490": "us/ordr"
};
// API ID → 한글명 (에러 메시지 + 결과 enrichment)
const API_NAMES = {
  "au10001": "접근토큰 발급",
  "au10002": "접근토큰폐기",
  "ka00001": "계좌번호조회",
  "ka00198": "실시간종목조회순위",
  "ka01300": "관심종목 그룹 리스트 조회",
  "ka01301": "관심종목 그룹 상세 조회",
  "ka01690": "일별잔고수익률",
  "ka10001": "주식기본정보요청",
  "ka10002": "주식거래원요청",
  "ka10003": "체결정보요청",
  "ka10004": "주식호가요청",
  "ka10005": "주식일주월시분요청",
  "ka10006": "주식시분요청",
  "ka10007": "시세표성정보요청",
  "ka10008": "주식외국인종목별매매동향",
  "ka10009": "주식기관요청",
  "ka10010": "업종프로그램요청",
  "ka10011": "신주인수권전체시세요청",
  "ka10013": "신용매매동향요청",
  "ka10014": "공매도추이요청",
  "ka10015": "일별거래상세요청",
  "ka10016": "신고저가요청",
  "ka10017": "상하한가요청",
  "ka10018": "고저가근접요청",
  "ka10019": "가격급등락요청",
  "ka10020": "호가잔량상위요청",
  "ka10021": "호가잔량급증요청",
  "ka10022": "잔량율급증요청",
  "ka10023": "거래량급증요청",
  "ka10024": "거래량갱신요청",
  "ka10025": "매물대집중요청",
  "ka10026": "고저PER요청",
  "ka10027": "전일대비등락률상위요청",
  "ka10028": "시가대비등락률요청",
  "ka10029": "예상체결등락률상위요청",
  "ka10030": "당일거래량상위요청",
  "ka10031": "전일거래량상위요청",
  "ka10032": "거래대금상위요청",
  "ka10033": "신용비율상위요청",
  "ka10034": "외인기간별매매상위요청",
  "ka10035": "외인연속순매매상위요청",
  "ka10036": "외인한도소진율증가상위",
  "ka10037": "외국계창구매매상위요청",
  "ka10038": "종목별증권사순위요청",
  "ka10039": "증권사별매매상위요청",
  "ka10040": "당일주요거래원요청",
  "ka10042": "순매수거래원순위요청",
  "ka10043": "거래원매물대분석요청",
  "ka10044": "일별기관매매종목요청",
  "ka10045": "종목별기관매매추이요청",
  "ka10046": "체결강도추이시간별요청",
  "ka10047": "체결강도추이일별요청",
  "ka10048": "ELW일별민감도지표요청",
  "ka10050": "ELW민감도지표요청",
  "ka10051": "업종별투자자순매수요청",
  "ka10052": "거래원순간거래량요청",
  "ka10053": "당일상위이탈원요청",
  "ka10054": "변동성완화장치발동종목요청",
  "ka10055": "당일전일체결량요청",
  "ka10058": "투자자별일별매매종목요청",
  "ka10059": "종목별투자자기관별요청",
  "ka10060": "종목별투자자기관별차트요청",
  "ka10061": "종목별투자자기관별합계요청",
  "ka10062": "동일순매매순위요청",
  "ka10063": "장중투자자별매매요청",
  "ka10064": "장중투자자별매매차트요청",
  "ka10065": "장중투자자별매매상위요청",
  "ka10066": "장마감후투자자별매매요청",
  "ka10068": "대차거래추이요청",
  "ka10069": "대차거래상위10종목요청",
  "ka10072": "일자별종목별실현손익요청_일자",
  "ka10073": "일자별종목별실현손익요청_기간",
  "ka10074": "일자별실현손익요청",
  "ka10075": "미체결요청",
  "ka10076": "체결요청",
  "ka10077": "당일실현손익상세요청",
  "ka10078": "증권사별종목매매동향요청",
  "ka10079": "주식틱차트조회요청",
  "ka10080": "주식분봉차트조회요청",
  "ka10081": "주식일봉차트조회요청",
  "ka10082": "주식주봉차트조회요청",
  "ka10083": "주식월봉차트조회요청",
  "ka10084": "당일전일체결요청",
  "ka10085": "계좌수익률요청",
  "ka10086": "일별주가요청",
  "ka10087": "시간외단일가요청",
  "ka10088": "미체결 분할주문 상세",
  "ka10094": "주식년봉차트조회요청",
  "ka10095": "지정종목 정보요청",
  "ka10098": "시간외단일가등락율순위요청",
  "ka10099": "종목정보 리스트",
  "ka10100": "종목정보 조회",
  "ka10101": "업종코드 리스트",
  "ka10102": "회원사 리스트",
  "ka10131": "기관외국인연속매매현황요청",
  "ka10170": "당일매매일지요청",
  "ka10171": "조건검색 목록조회",
  "ka10172": "조건검색 요청 일반",
  "ka10173": "조건검색 요청 실시간",
  "ka10174": "조건검색 실시간 해제",
  "ka20001": "업종현재가요청",
  "ka20002": "업종별주가요청",
  "ka20003": "전업종지수요청",
  "ka20004": "업종틱차트조회요청",
  "ka20005": "업종분봉조회요청",
  "ka20006": "업종일봉조회요청",
  "ka20007": "업종주봉조회요청",
  "ka20008": "업종월봉조회요청",
  "ka20009": "업종현재가일별요청",
  "ka20019": "업종년봉조회요청",
  "ka20068": "대차거래추이요청(종목별)",
  "ka30001": "ELW가격급등락요청",
  "ka30002": "거래원별ELW순매매상위요청",
  "ka30003": "ELWLP보유일별추이요청",
  "ka30004": "ELW괴리율요청",
  "ka30005": "ELW조건검색요청",
  "ka30009": "ELW등락율순위요청",
  "ka30010": "ELW잔량순위요청",
  "ka30011": "ELW근접율요청",
  "ka30012": "ELW종목상세정보요청",
  "ka40001": "ETF수익율요청",
  "ka40002": "ETF종목정보요청",
  "ka40003": "ETF일별추이요청",
  "ka40004": "ETF전체시세요청",
  "ka40006": "ETF시간대별추이요청",
  "ka40007": "ETF시간대별체결요청",
  "ka40008": "ETF일자별체결요청",
  "ka40009": "ETF시간대별NAV현황",
  "ka40010": "ETF시간대별수급현황",
  "ka50010": "금현물체결추이",
  "ka50012": "금현물일별추이",
  "ka50079": "금현물틱차트조회요청",
  "ka50080": "금현물분봉차트조회요청",
  "ka50081": "금현물일봉차트조회요청",
  "ka50082": "금현물주봉차트조회요청",
  "ka50083": "금현물월봉차트조회요청",
  "ka50087": "금현물예상체결",
  "ka50091": "금현물당일틱차트조회요청",
  "ka50092": "금현물당일분봉차트조회요청",
  "ka50100": "금현물 시세정보",
  "ka50101": "금현물 호가",
  "ka52301": "금현물투자자현황",
  "ka90001": "테마그룹별요청",
  "ka90002": "테마구성종목요청",
  "ka90003": "프로그램순매수상위50요청",
  "ka90004": "종목별프로그램매매현황요청",
  "ka90005": "프로그램매매추이요청 시간대별",
  "ka90006": "프로그램매매차익잔고추이요청",
  "ka90007": "프로그램매매누적추이요청",
  "ka90008": "종목시간별프로그램매매추이요청",
  "ka90009": "외국인기관매매상위요청",
  "ka90010": "프로그램매매추이요청 일자별",
  "ka90012": "대차거래내역요청",
  "ka90013": "종목일별프로그램매매추이요청",
  "kt00001": "예수금상세현황요청",
  "kt00002": "일별추정예탁자산현황요청",
  "kt00003": "추정자산조회요청",
  "kt00004": "계좌평가현황요청",
  "kt00005": "체결잔고요청",
  "kt00007": "계좌별주문체결내역상세요청",
  "kt00008": "계좌별익일결제예정내역요청",
  "kt00009": "계좌별주문체결현황요청",
  "kt00010": "주문인출가능금액요청",
  "kt00011": "증거금율별주문가능수량조회요청",
  "kt00012": "신용보증금율별주문가능수량조회요청",
  "kt00013": "증거금세부내역조회요청",
  "kt00015": "위탁종합거래내역요청",
  "kt00016": "일별계좌수익률상세현황요청",
  "kt00017": "계좌별당일현황요청",
  "kt00018": "계좌평가잔고내역요청",
  "kt10000": "주식 매수주문",
  "kt10001": "주식 매도주문",
  "kt10002": "주식 정정주문",
  "kt10003": "주식 취소주문",
  "kt10006": "신용 매수주문",
  "kt10007": "신용 매도주문",
  "kt10008": "신용 정정주문",
  "kt10009": "신용 취소주문",
  "kt20016": "신용융자 가능종목요청",
  "kt20017": "신용융자 가능문의",
  "kt50000": "금현물 매수주문",
  "kt50001": "금현물 매도주문",
  "kt50002": "금현물 정정주문",
  "kt50003": "금현물 취소주문",
  "kt50020": "금현물 잔고확인",
  "kt50021": "금현물 예수금",
  "kt50030": "금현물 주문체결전체조회",
  "kt50031": "금현물 주문체결조회",
  "kt50032": "금현물 거래내역조회",
  "kt50075": "금현물 미체결조회",
  "usa01980": "미국주식 실시간 종목 조회 순위",
  "usa01990": "미국주식 관심종목 등록 상위",
  "usa06010": "미국주식 틱 차트",
  "usa06011": "미국주식 분 차트",
  "usa06012": "미국주식 일 차트",
  "usa06013": "미국주식 주 차트",
  "usa06014": "미국주식 월 차트",
  "usa06015": "미국주식 년 차트",
  "usa06016": "미국주식 분기 차트",
  "usa10098": "미국주식 거래소구분 조회",
  "usa10099": "미국주식 종목리스트",
  "usa10100": "미국주식 종목 조회",
  "usa10101": "미국주식 업종리스트",
  "usa10102": "미국지수 리스트",
  "usa10104": "미국 ETF,ETN 리스트",
  "usa10105": "미국 ETF 카테고리 리스트",
  "usa20100": "미국주식 현재가 종목정보",
  "usa20101": "미국주식 현재가 10호가",
  "usa20150": "미국주식 상세 체결내역",
  "usa20151": "미국주식 일별 체결내역",
  "usa20200": "미국주식 관심종목 그룹 리스트 조회",
  "usa20201": "미국주식 관심종목 그룹 상세 조회",
  "usa20280": "미국주식 조건검색 목록조회",
  "usa20281": "미국주식 조건검색 요청 일반",
  "usa20290": "미국주식 조건검색 요청 실시간",
  "usa20291": "미국주식 조건검색 실시간 해제",
  "usa20510": "미국주식 기간별 등락률상위(주식/업종)",
  "usa20511": "미국주식 기간별 등락률상위(ETF)",
  "usa20512": "미국주식 기간별 등락률상위(관심종목)",
  "usa20520": "미국주식 거래량급등락(주식/업종)",
  "usa20521": "미국주식 거래량급등락(ETF)",
  "usa20530": "미국주식 당일 거래량 상위(주식/업종)",
  "usa20531": "미국주식 당일 거래량 상위(ETF)",
  "usa20540": "미국주식 당일 거래대금 상위(주식/업종)",
  "usa20541": "미국주식 당일 거래대금 상위(ETF)",
  "usa20550": "미국주식 시가총액상위(주식/업종)",
  "usa20551": "미국주식 시가총액상위(ETF)",
  "usa20570": "미국주식 가격대별주가(주식/업종)",
  "usa20571": "미국주식 가격대별주가(ETF)",
  "usa20590": "미국주식 일별주가",
  "usa20880": "키움 거래 상위 종목(미국주식)",
  "usa20881": "키움 거래 상위 종목(미국 ETF)",
  "usa20910": "미국주식 전일대비 등락률상위(주식/업종)",
  "usa20911": "미국주식 전일대비 등락률상위(ETF)",
  "usa20920": "미국주식 시가대비 등락률상위(주식/업종)",
  "usa20921": "미국주식 시가대비 등락률상위(ETF)",
  "usa20922": "미국주식 시가대비 등락률상위(관심종목)",
  "usa20930": "미국주식 가격급등락(주식/업종)",
  "usa20931": "미국주식 가격급등락(ETF)",
  "usa20932": "미국주식 가격급등락(관심종목)",
  "usa20940": "미국주식 누적 등락률 상위(주식/업종)",
  "usa20941": "미국주식 누적 등락률 상위(ETF)",
  "usa20960": "미국주식 전일 거래상위(주식/업종)",
  "usa20961": "미국주식 전일 거래상위(ETF)",
  "usa20970": "미국주식 고가/저가 접근(주식/업종)",
  "usa20971": "미국주식 고가/저가 접근(ETF)",
  "usa20972": "미국주식 고가/저가 접근(관심종목)",
  "usa21670": "미국주식 일별계좌수익률현황",
  "usa21680": "미국주식 월별계좌수익률현황",
  "usa21690": "미국주식 연도별계좌수익률현황",
  "usa21730": "미국주식 일별종목수익률현황",
  "usa21731": "미국주식 월별종목수익률현황",
  "usa21732": "미국주식 연도별종목수익률현황",
  "usa23000": "미국주식 업종별 기간별 수익률 조회",
  "usa23100": "미국주식 업종별 등락률 상위/하위 조회",
  "usa23400": "미국주식 거래량갱신(주식/업종)",
  "usa23401": "미국주식 거래량갱신(ETF)",
  "usa23402": "미국주식 거래량갱신(관심종목)",
  "usa24100": "미국주식 신고가/신저가(주식/업종)",
  "usa24101": "미국주식 신고가/신저가(ETF)",
  "usa24110": "미국주식 최고최저가대비 상승하락(주식/업종)",
  "usa24111": "미국주식 최고최저가대비 상승하락(ETF)",
  "usa24120": "미국주식 특정일자 상승/하락 (주식/업종)",
  "usa24121": "미국주식 특정일자 상승/하락(ETF)",
  "usa24140": "미국주식 갭상승/갭하락(주식/업종)",
  "usa24141": "미국주식 갭상승/갭하락(ETF)",
  "usa24150": "미국주식 회전율 상위(주식/업종)",
  "usa24151": "미국주식 회전율 상위(ETF)",
  "usa24160": "미국주식 연속상승/하락 순위(주식/업종)",
  "usa24161": "미국주식 연속상승/하락 순위(ETF)",
  "usa24162": "미국주식 연속상승/하락 순위(관심종목)",
  "usa24200": "미국주식 호가잔량상위(주식/업종)",
  "usa24201": "미국주식 호가잔량상위(ETF)",
  "usa24210": "미국주식 잔량률급증(주식/업종)",
  "usa24211": "미국주식 잔량률급증(ETF)",
  "usa24220": "미국주식 매물대집중(주식/업종)",
  "usa24221": "미국주식 매물대집중(ETF)",
  "usa24290": "미국주식 주간거래 괴리율 상위(주식/업종)",
  "usa24291": "미국주식 주간거래 괴리율 상위(ETF)",
  "usa24300": "미국주식 리서치(미국주식/ETF)",
  "usa26410": "미국주식 연도별 등락률(종목)",
  "usa26411": "미국주식 연도별 업종별 종목등락률",
  "usa26412": "미국주식 연도별 ETF 카테고리별 종목등락률",
  "usa26413": "미국주식 연도별 등락률(업종)",
  "usa26414": "미국주식 연도별 등락률(ETF)",
  "ust20000": "미국주식 매수 주문",
  "ust20001": "미국주식 매도 주문",
  "ust20002": "미국주식 정정 주문",
  "ust20003": "미국주식 취소 주문",
  "ust21050": "미국주식 원장 미체결",
  "ust21070": "미국주식 원장잔고확인",
  "ust21100": "미국주식 거래내역",
  "ust21110": "해외주식 예수금",
  "ust21111": "원화출금가능 금액 조회(원화대용 포함)",
  "ust21120": "통화별 예수금 및 증권 평가금현황",
  "ust21121": "해외증권 원장 평가금액현황",
  "ust21131": "해외증권 특정일 평가금액",
  "ust21132": "특정일 통화별 예수금 및 증권 평가금",
  "ust21150": "미국주식 일별 주문체결내역",
  "ust21160": "미국주식 예수금 상세",
  "ust21170": "미국주식 당일 종목별 실현손익",
  "ust21180": "미국주식 기간별 주문내역",
  "ust21510": "미국주식 당일 주문체결 확인",
  "ust21530": "미국주식 실현손익",
  "ust21610": "미국주식 당일매매",
  "ust21620": "미국주식 당일매매정리",
  "ust21630": "미국주식 당일 실현손익",
  "ust21640": "미국주식 일별 종목별 실현손익",
  "ust21650": "미국주식 기간별 수익률 현황",
  "ust21660": "미국주식 일별 실현손익",
  "ust21661": "미국주식 월별 실현손익",
  "ust31300": "환전 예상 금액 조회",
  "ust31301": "환율 조회",
  "ust31302": "환전 신청",
  "ust31490": "미국주식 주문가능수량(종목/증거금률별)"
};

// 토큰 발급·갱신은 인프라 TokenProvider 가 config.json 의 oauth 스펙으로 처리한다.
// sysmod 는 env 로 주입된 raw 토큰(KIWOOM_ACCESS_TOKEN)을 받아쓰기만 한다 — 토큰 코드 0.

const RATE_LIMIT = 5;
const WINDOW_MS = 1000;
const _reqTimes = [];
async function acquireSlot() {
  while (true) {
    const now = Date.now();
    while (_reqTimes.length > 0 && now - _reqTimes[0] >= WINDOW_MS) _reqTimes.shift();
    if (_reqTimes.length < RATE_LIMIT) { _reqTimes.push(now); return; }
    await new Promise(r => setTimeout(r, WINDOW_MS - (now - _reqTimes[0]) + 5));
  }
}

async function callApi(base, token, apiId, params = {}, retry = 2) {
  const category = URL_CATEGORY[apiId];
  if (!category) throw new Error(`알 수 없는 API ID: ${apiId} — 이 값을 지어내지 마세요. search_module_actions(query) 로 맞는 액션을 찾고 get_action_schema('kiwoom', action) 으로 파라미터를 확인하세요. 단순 시세·차트·과거 데이터는 yfinance(action='history')가 더 쉽습니다.`);
  const url = `${base}/api/${category}`;
  await acquireSlot();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'authorization': `Bearer ${token}`,
      'api-id': apiId,
      'cont-yn': 'N',
      'next-key': '',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429 && retry > 0) {
    await new Promise(r => setTimeout(r, 1100));
    return callApi(base, token, apiId, params, retry - 1);
  }
  if (!resp.ok) {
    // 키움은 토큰 만료 등 일부 오류를 HTTP 4xx/5xx + JSON 바디(return_code/return_msg)로 준다.
    // 바디가 키움 에러 envelope 면 throw 말고 반환 → 상위 return_code 검사(인프라 reactive)가 토큰 무효를 감지.
    const errText = await resp.text().catch(() => '');
    try {
      const j = JSON.parse(errText);
      if (j && (j.return_code !== undefined || j.return_msg !== undefined)) return j;
    } catch { /* JSON 아님 — 아래 throw */ }
    throw new Error(`키움 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }
  // A 200 that is not JSON is usually the wrong host or an interstitial page, and
  // "Unexpected token '<'" says none of that. Report what came back instead.
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    const head = text.trim().slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`키움 API ${apiId}: 응답이 JSON 이 아닙니다 (HTTP ${resp.status}, ${url}) — ${head}`);
  }
}

// Standard OHLCV normalization — rename Kiwoom candle vocabulary (dt/cntr_tm/open_pric/high_pric/
// low_pric/cur_prc/trde_qty) to the cross-broker standard {date, open, high, low, close, volume} so
// stock_chart dataCacheKey injection, the timeseries store, and cache_grep all speak one vocabulary
// (yfinance already does). Field-signature detection (a row carrying a date field together with
// open_pric) — no per-action enum, so every chart/daily-price API normalizes uniformly.
// Values arrive as strings, sometimes signed ("+68000") — strip the sign (prices/volumes are absolute).
function kiwoomNum(v) {
  const n = Number(String(v ?? '').replace(/^[+\-]/, ''));
  return Number.isFinite(n) ? n : v;
}
function kiwoomDate(s) {
  s = String(s ?? '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{12,14}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12);
  return s;
}
const CANDLE_FIELD_MAP = [
  ['dt', 'date'], ['cntr_tm', 'date'],
  ['open_pric', 'open'], ['high_pric', 'high'], ['low_pric', 'low'],
  ['cur_prc', 'close'], ['trde_qty', 'volume'],
];
// Signed change against the previous session's close — `pred_pre` keeps its sign, unlike prices.
function kiwoomSigned(v) {
  const n = Number(String(v ?? '').replace(/^\+/, ''));
  return Number.isFinite(n) ? n : null;
}
function normalizeCandleRows(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 2) return;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const row of v) {
        if (!row || typeof row !== 'object') continue;
        if (!(('dt' in row || 'cntr_tm' in row) && 'open_pric' in row)) continue;
        // The previous session's official close, before the price keys are renamed.
        //
        // Every consumer wants this number and none of them can derive it: reading "the last bar of
        // the previous calendar day" out of a minute series gives an AFTER-HOURS print, because
        // `_AL` (SOR) covers NXT and NXT trades until 20:00. That is how SK Hynix came to show
        // +23.11% against 1,359,000 when the close was 1,322,000 (2026-07-31). The broker states it
        // on every candle as `pred_pre`; the module that knows that vocabulary converts it, so no
        // consumer has to guess at session hours.
        const chg = kiwoomSigned(row.pred_pre);
        const cur = Number(String(row.cur_prc ?? '').replace(/^[+\-]/, ''));
        if (chg !== null && Number.isFinite(cur)) {
          row.prevClose = cur - chg;
        }
        for (const [src, dst] of CANDLE_FIELD_MAP) {
          if (src in row) {
            row[dst] = dst === 'date' ? kiwoomDate(row[src]) : kiwoomNum(row[src]);
            if (src !== dst) delete row[src];
          }
        }
      }
    } else if (v && typeof v === 'object') {
      normalizeCandleRows(v, depth + 1);
    }
  }
}

// base_dt (chart endpoint's query end-date anchor) — the API semantics are "latest = today".
// Static bindings (page bake / scheduled pages) carry no date (a fixed one would go stale), so
// default an empty base_dt to today (KST) for chart-endpoint calls. Covers bake, rebake, and any
// model call that omits it — the module owns this "latest" dialect, not the caller.
function kstToday() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}


// ── Standard order contract ──────────────────────────────────────────────────────────────────
// One neutral shape every broker accepts, translated here into this broker's own vocabulary.
//
// The alternative is the caller knowing that a buy is kt10000, that the exchange goes in
// `dmst_stex_tp`, and that a market order is trde_tp "3" — at which point adding a broker stops
// being a declaration and becomes an edit to whoever places orders. The dialect belongs to the
// module that speaks it.
//
// A client id rides along so a retry cannot become a second order: Kiwoom has no idempotency key
// of its own, so the caller's ledger is the only thing that can tell "sent twice" from "filled
// twice", and it needs the same id back to do it.
const ORDER_TRADE_TYPE = { limit: '0', market: '3', conditional: '5', best: '6', priority: '7' };

function orderParams(data) {
  const symbol = String(data.symbol ?? '').trim();
  const qty = Number(data.qty);
  if (!symbol) throw new Error('place_order: symbol 이 필요합니다 (예: "005930").');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('place_order: qty 는 1 이상이어야 합니다.');
  const type = String(data.orderType ?? 'limit').toLowerCase();
  const trde_tp = ORDER_TRADE_TYPE[type];
  if (!trde_tp) {
    throw new Error(`place_order: orderType='${type}' 은 지원하지 않습니다 — ${Object.keys(ORDER_TRADE_TYPE).join(', ')} 중 하나.`);
  }
  const price = Number(data.price);
  if (type === 'limit' && (!Number.isFinite(price) || price <= 0)) {
    throw new Error('place_order: 지정가 주문에는 price 가 필요합니다.');
  }
  const params = {
    // KRX / NXT / SOR — SOR routes across both, which is what a plain "buy this" means.
    dmst_stex_tp: String(data.exchange ?? 'SOR').toUpperCase(),
    stk_cd: symbol,
    ord_qty: String(Math.trunc(qty)),
    trde_tp,
  };
  // A market order carries no unit price; sending one is rejected.
  if (type !== 'market' && Number.isFinite(price) && price > 0) params.ord_uv = String(Math.trunc(price));
  if (data.conditionPrice) params.cond_uv = String(Math.trunc(Number(data.conditionPrice)));
  return params;
}

function cancelParams(data) {
  const orderNo = String(data.brokerOrderNo ?? '').trim();
  if (!orderNo) throw new Error('cancel_order: brokerOrderNo 가 필요합니다 (주문 접수 응답의 주문번호).');
  const symbol = String(data.symbol ?? '').trim();
  if (!symbol) throw new Error('cancel_order: symbol 이 필요합니다.');
  return {
    dmst_stex_tp: String(data.exchange ?? 'SOR').toUpperCase(),
    orig_ord_no: orderNo,
    stk_cd: symbol,
    // "0" = whatever is left unfilled, which is what cancelling an order means.
    cncl_qty: data.qty ? String(Math.trunc(Number(data.qty))) : '0',
  };
}

/** Neutral action → { apiId, params }. Unknown side/action is refused rather than guessed. */
function standardOrder(action, data) {
  if (action === 'cancel_order') return { apiId: 'kt10003', params: cancelParams(data) };
  const side = String(data.side ?? '').toLowerCase();
  if (side !== 'buy' && side !== 'sell') {
    throw new Error("place_order: side 는 'buy' 또는 'sell' 이어야 합니다.");
  }
  return { apiId: side === 'buy' ? 'kt10000' : 'kt10001', params: orderParams(data) };
}


// ── Standard account queries ─────────────────────────────────────────────────────────────────
// The read half of the neutral contract. Placing an order through `place_order` and then reading
// it back through `ka10075 {all_stk_tp:'0', trde_tp:'0', stex_tp:'0'}` would put the dialect right
// back in the caller — and this broker uses two different exchange vocabularies depending on the
// action (`stex_tp` 0/1/2 for order queries, `dmst_stex_tp` KRX/NXT for the balance). Whoever
// reconciles should not have to know that.
//
// Side coding is inverted from the obvious reading — 1 is sell, 2 is buy — which is exactly the
// kind of thing that silently returns the wrong half of the account. It is written down once here.
const QUERY_SIDE = { sell: '1', buy: '2' };
const STEX_TP = { SOR: '0', KRX: '1', NXT: '2' };
const DMST_STEX = { SOR: 'KRX', KRX: 'KRX', NXT: 'NXT' };

function sideCode(data) {
  const side = String(data.side ?? '').toLowerCase();
  if (!side) return '0'; // no side given = both, which is what reconciling an account wants
  const code = QUERY_SIDE[side];
  if (!code) throw new Error("side 는 'buy' 또는 'sell' 이어야 합니다 (생략하면 매수·매도 전체).");
  return code;
}

function exchangeOf(data, table, name) {
  const ex = String(data.exchange ?? 'SOR').toUpperCase();
  const code = table[ex];
  if (!code) throw new Error(`${name}: exchange='${ex}' 는 지원하지 않습니다 — KRX, NXT, SOR 중 하나.`);
  return code;
}

/** Neutral query → { apiId, params }. */
function standardQuery(action, data) {
  const symbol = String(data.symbol ?? '').trim();
  if (action === 'list_open_orders') {
    const params = {
      all_stk_tp: symbol ? '1' : '0',
      trde_tp: sideCode(data),
      stex_tp: exchangeOf(data, STEX_TP, 'list_open_orders'),
    };
    if (symbol) params.stk_cd = symbol;
    return { apiId: 'ka10075', params };
  }
  if (action === 'list_fills') {
    const params = {
      qry_tp: symbol ? '1' : '0',
      sell_tp: sideCode(data),
      stex_tp: exchangeOf(data, STEX_TP, 'list_fills'),
    };
    if (symbol) params.stk_cd = symbol;
    // Paging runs backwards here: the broker returns executions OLDER than this order number.
    // Calling it `since` would read as "newer than", and a caller chasing new fills with it would
    // quietly get none of them.
    if (data.beforeOrderNo) params.ord_no = String(data.beforeOrderNo).trim();
    return { apiId: 'ka10076', params };
  }
  // Per-symbol rows, always: a summed balance cannot be compared against a per-symbol ledger.
  return {
    apiId: 'kt00018',
    params: { qry_tp: '2', dmst_stex_tp: exchangeOf(data, DMST_STEX, 'get_balance') },
  };
}

const STANDARD_QUERIES = ['list_open_orders', 'list_fills', 'get_balance'];

/** The one list in an account response, named by the response rather than by us.
 *
 * These endpoints answer with scalars plus a single row array, but the array's field name is not
 * documented and differs per endpoint. Taking the sole list needs no such name; when there is more
 * than one candidate nothing is picked and the names are reported, because a caller reconciling an
 * account would rather see "which of these two" than silently settle the wrong list.
 */
function pickRows(payload) {
  const arrays = Object.entries(payload).filter(([, v]) =>
    Array.isArray(v) && v.every(row => row && typeof row === 'object' && !Array.isArray(row)));
  if (!arrays.length) return null;
  const filled = arrays.filter(([, v]) => v.length > 0);
  const pick = filled.length === 1 ? filled[0] : (arrays.length === 1 ? arrays[0] : null);
  if (!pick) return { candidates: arrays.map(([k]) => k) };
  return { field: pick[0], rows: pick[1] };
}


// ── Candles, by interval ─────────────────────────────────────────────────────────────────────
// Every timeframe is its own API here — minute bars are ka10080 with a tic_scope, daily is
// ka10081, weekly ka10082, monthly ka10083 — and the US chart set is a different family again.
// A caller that has to know which is which cannot switch a strategy from 5-minute to hourly
// without editing the call, and a strategy measured on one timeframe and traded on another is
// measuring something else entirely. So the interval is the argument and the dialect stays here.
const MINUTE_SCOPES = { '1m': '1', '3m': '3', '5m': '5', '10m': '10', '15m': '15',
                        '30m': '30', '45m': '45', '60m': '60', '1h': '60' };
const PERIOD_APIS = { '1d': 'ka10081', '1w': 'ka10082', '1M': 'ka10083', '1y': 'ka10094' };
const US_PERIOD_APIS = { '1d': 'usa06012', '1w': 'usa06013', '1M': 'usa06014', '1y': 'usa06015' };

function candleParams(action, data) {
  const symbol = String(data.symbol ?? '').trim();
  if (!symbol) throw new Error('get_candles: symbol 이 필요합니다.');
  const interval = String(data.interval ?? '1d').trim();
  const us = String(data.market ?? '').toLowerCase() === 'us' || Boolean(data.stexTp);
  const params = { stk_cd: symbol, upd_stkpc_tp: String(data.adjusted === false ? '0' : '1') };
  if (us) params.stex_tp = String(data.stexTp ?? 'ND');
  // A tick chart counts trades, not time — `100t` is a hundred-trade bar.
  const tick = /^(\d+)t$/i.exec(interval);
  if (tick) {
    params.tic_scope = tick[1];
    return { apiId: us ? 'usa06010' : 'ka10079', params };
  }
  const scope = MINUTE_SCOPES[interval];
  if (scope) {
    params.tic_scope = scope;
    return { apiId: us ? 'usa06011' : 'ka10080', params };
  }
  const apiId = (us ? US_PERIOD_APIS : PERIOD_APIS)[interval];
  if (!apiId) {
    throw new Error(
      `get_candles: interval='${interval}' 은 지원하지 않습니다 — ` +
      `${[...Object.keys(MINUTE_SCOPES), ...Object.keys(PERIOD_APIS), '100t'].join(', ')} 중 하나.`);
  }
  if (data.baseDate) params.base_dt = String(data.baseDate).replace(/-/g, '');
  return { apiId, params };
}

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 키움 API ID (ka10001 등) 를 지정하세요.' }));
      return;
    }
    const appKey = process.env['KIWOOM_APP_KEY'];
    const appSecret = process.env['KIWOOM_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIWOOM_APP_KEY / KIWOOM_APP_SECRET 이 설정되지 않았습니다. 설정 > 시스템 모듈 > kiwoom 에서 등록하세요.' }));
      return;
    }
    // 토큰 = 인프라(TokenProvider)가 발급·선제갱신해 env 로 주입한 raw 토큰. 무효 시엔 인프라가
    // 응답의 return_code/return_msg 를 보고 재발급 후 1회 재시도하므로, sysmod 는 받아쓰기만 한다 (토큰 코드 0).
    const token = process.env['KIWOOM_ACCESS_TOKEN'];
    if (!token) {
      console.log(JSON.stringify({ success: false, error: '키움 접근 토큰 미발급 — 인프라 토큰 발급 실패 또는 앱키 미설정.' }));
      return;
    }
    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    let apiId = action;
    let params = data.params || {};
    if (action === 'place_order' || action === 'cancel_order') {
      const mapped = standardOrder(action, data);
      apiId = mapped.apiId;
      params = mapped.params;
    } else if (action === 'get_candles') {
      const mapped = candleParams(action, data);
      apiId = mapped.apiId;
      params = mapped.params;
    } else if (STANDARD_QUERIES.includes(action)) {
      const mapped = standardQuery(action, data);
      apiId = mapped.apiId;
      params = mapped.params;
    }
    if (URL_CATEGORY[apiId] === 'dostk/chart' && !params.base_dt) params.base_dt = kstToday();
    const result = await callApi(base, token, apiId, params);
    normalizeCandleRows(result);
    // 키움 API 자체 오류(return_code≠0)는 HTTP 200 이라 envelope success:true 로 가려졌었음 →
    // AI 가 실패를 못 알아채고 빈/거짓 데이터로 진행(fabricate). return_code 있으면 0 만 성공.
    const rc = result?.return_code;
    const ok = rc === undefined || rc === null || rc === 0;
    const output = { success: ok, data: { apiId, name: API_NAMES[apiId], ...result } };
    // Echo the caller's id and the request that went out — the ledger matches on the first and
    // the response schema is read off the second later, since it is not documented anywhere.
    if (action === 'place_order' || action === 'cancel_order') {
      output.data.clientOrderId = data.clientOrderId ?? null;
      output.data.sentParams = params;
    }
    if (STANDARD_QUERIES.includes(action) && ok) {
      // `rows` so the caller does not need the undocumented field name, `rowsField` so the name
      // becomes visible the first time a real response arrives.
      const picked = pickRows(result);
      if (picked?.field) {
        output.data.rows = picked.rows;
        output.data.rowsField = picked.field;
      } else if (picked?.candidates) {
        output.data.rowsCandidates = picked.candidates;
      }
      output.data.sentParams = params;
    }
    if (!ok) output.error = result?.return_msg || `키움 API 오류 (return_code=${rc})`;
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

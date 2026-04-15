/**
 * Firebat System Module: korea-invest (stock-trading)
 * 한국투자증권 Open API — 전체 API 지원 (300개+)
 *
 * API 문서: https://apiportal.koreainvestment.com
 * 인증: appkey + appsecret → OAuth access_token
 * 구조: {method} {url} + tr_id 헤더
 *
 * 편의 액션 → tr_id/url 자동 매핑, 또는 tr_id + url 직접 호출
 */

const BASE_REAL = 'https://openapi.koreainvestment.com:9443';
const BASE_MOCK = 'https://openapivts.koreainvestment.com:29443';

// ─── 편의 액션 → { trId, mockTrId, method, url } 매핑 ───
// 엑셀 문서 기준 trId 매핑 (한국투자증권_오픈API_전체문서)
const ACTION_MAP = {
  // ══ 국내주식 기본시세 ══
  'price':          { trId: 'FHKST01010100', mockTrId: 'FHKST01010100', url: '/uapi/domestic-stock/v1/quotations/inquire-price' },
  'price2':         { trId: 'FHPST01010000', url: '/uapi/domestic-stock/v1/quotations/inquire-price-2' },
  'quote':          { trId: 'FHKST01010200', mockTrId: 'FHKST01010200', url: '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn' },
  'execution':      { trId: 'FHKST01010300', mockTrId: 'FHKST01010300', url: '/uapi/domestic-stock/v1/quotations/inquire-ccnl' },
  'daily-price':    { trId: 'FHKST01010400', mockTrId: 'FHKST01010400', url: '/uapi/domestic-stock/v1/quotations/inquire-daily-price' },
  'investor':       { trId: 'FHKST01010900', mockTrId: 'FHKST01010900', url: '/uapi/domestic-stock/v1/quotations/inquire-investor' },
  'member':         { trId: 'FHKST01010600', mockTrId: 'FHKST01010600', url: '/uapi/domestic-stock/v1/quotations/inquire-member' },
  'time-ccnl':      { trId: 'FHPST01060000', mockTrId: 'FHPST01060000', url: '/uapi/domestic-stock/v1/quotations/inquire-time-itemconclusion' },
  'overtime-price':  { trId: 'FHPST02300000', url: '/uapi/domestic-stock/v1/quotations/inquire-overtime-price' },
  'overtime-quote':  { trId: 'FHPST02300400', url: '/uapi/domestic-stock/v1/quotations/inquire-overtime-asking-price' },
  'volume-rank':    { trId: 'FHPST01710000', url: '/uapi/domestic-stock/v1/quotations/volume-rank' },
  'vi-status':      { trId: 'FHPST01390000', url: '/uapi/domestic-stock/v1/quotations/inquire-vi-status' },
  'exp-closing':    { trId: 'FHKST117300C0', url: '/uapi/domestic-stock/v1/quotations/exp-closing-price' },
  'news-title':     { trId: 'FHKST01011800', url: '/uapi/domestic-stock/v1/quotations/news-title' },

  // ══ 국내주식 종목정보 ══
  'stock-info':     { trId: 'CTPF1002R', url: '/uapi/domestic-stock/v1/quotations/search-stock-info' },
  'product-info':   { trId: 'CTPF1604R', url: '/uapi/domestic-stock/v1/quotations/search-info' },
  'holiday':        { trId: 'CTCA0903R', url: '/uapi/domestic-stock/v1/quotations/chk-holiday' },
  'invest-opinion': { trId: 'FHKST663300C0', url: '/uapi/domestic-stock/v1/quotations/invest-opinion' },
  'invest-by-sec':  { trId: 'FHKST663400C0', url: '/uapi/domestic-stock/v1/quotations/invest-opbysec' },
  'estimate-perform':{ trId: 'HHKST668300C0', url: '/uapi/domestic-stock/v1/quotations/estimate-perform' },
  'credit-company': { trId: 'FHPST04770000', url: '/uapi/domestic-stock/v1/quotations/credit-by-company' },

  // ══ 국내주식 차트 ══
  'chart-daily':    { trId: 'FHKST03010100', mockTrId: 'FHKST03010100', url: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice' },
  'chart-minute':   { trId: 'FHKST03010200', mockTrId: 'FHKST03010200', url: '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice' },
  'chart-daily-tl': { trId: 'FHKST03010230', url: '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice' },
  'daily-trade-vol':{ trId: 'FHKST03010800', url: '/uapi/domestic-stock/v1/quotations/inquire-daily-trade-volume' },
  'overtime-daily':  { trId: 'FHPST02320000', mockTrId: 'FHPST02320000', url: '/uapi/domestic-stock/v1/quotations/inquire-daily-overtimeprice' },
  'overtime-time':   { trId: 'FHPST02310000', mockTrId: 'FHPST02310000', url: '/uapi/domestic-stock/v1/quotations/inquire-time-overtimeconclusion' },

  // ══ 국내주식 업종/지수 ══
  'index-price':    { trId: 'FHPUP02100000', url: '/uapi/domestic-stock/v1/quotations/inquire-index-price' },
  'index-daily':    { trId: 'FHPUP02120000', url: '/uapi/domestic-stock/v1/quotations/inquire-index-daily-price' },
  'index-chart':    { trId: 'FHKUP03500100', mockTrId: 'FHKUP03500100', url: '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice' },
  'index-time':     { trId: 'FHPUP02110200', url: '/uapi/domestic-stock/v1/quotations/inquire-index-timeprice' },
  'index-tick':     { trId: 'FHPUP02110100', url: '/uapi/domestic-stock/v1/quotations/inquire-index-tickprice' },
  'index-category': { trId: 'FHPUP02140000', url: '/uapi/domestic-stock/v1/quotations/inquire-index-category-price' },
  'index-minute':   { trId: 'FHKUP03500200', url: '/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice' },
  'exp-index':      { trId: 'FHPST01840000', url: '/uapi/domestic-stock/v1/quotations/exp-index-trend' },
  'exp-total-index':{ trId: 'FHKUP11750000', url: '/uapi/domestic-stock/v1/quotations/exp-total-index' },
  'market-time':    { trId: 'HHMCM000002C0', url: '/uapi/domestic-stock/v1/quotations/market-time' },
  'comp-interest':  { trId: 'FHPST07020000', url: '/uapi/domestic-stock/v1/quotations/comp-interest' },

  // ══ 국내주식 주문 ══ (엑셀 기준 trId)
  'order-buy':      { trId: 'TTTC0012U', mockTrId: 'VTTC0012U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-cash' },
  'order-sell':     { trId: 'TTTC0011U', mockTrId: 'VTTC0011U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-cash' },
  'order-modify':   { trId: 'TTTC0013U', mockTrId: 'VTTC0013U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-rvsecncl' },
  'order-reserve':  { trId: 'CTSC0008U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-resv' },
  'order-reserve-cancel':{ trId: 'CTSC0009U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-resv-rvsecncl' },
  'order-credit-buy':  { trId: 'TTTC0052U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-credit' },
  'order-credit-sell': { trId: 'TTTC0051U', method: 'POST', url: '/uapi/domestic-stock/v1/trading/order-credit' },

  // ══ 국내주식 계좌 ══
  'balance':        { trId: 'TTTC8434R', mockTrId: 'VTTC8434R', url: '/uapi/domestic-stock/v1/trading/inquire-balance' },
  'balance-pl':     { trId: 'TTTC8494R', url: '/uapi/domestic-stock/v1/trading/inquire-balance-rlz-pl' },
  'deposit':        { trId: 'CTRP6548R', url: '/uapi/domestic-stock/v1/trading/inquire-account-balance' },
  'psbl-order':     { trId: 'TTTC8908R', mockTrId: 'VTTC8908R', url: '/uapi/domestic-stock/v1/trading/inquire-psbl-order' },
  'psbl-sell':      { trId: 'TTTC8408R', url: '/uapi/domestic-stock/v1/trading/inquire-psbl-sell' },
  'daily-ccld':     { trId: 'TTTC0081R', mockTrId: 'VTTC0081R', url: '/uapi/domestic-stock/v1/trading/inquire-daily-ccld' },
  'psbl-rvsecncl':  { trId: 'TTTC0084R', url: '/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl' },
  'order-reserve-list':{ trId: 'CTSC0004R', url: '/uapi/domestic-stock/v1/trading/order-resv-ccnl' },
  'period-profit':  { trId: 'TTTC8708R', url: '/uapi/domestic-stock/v1/trading/inquire-period-profit' },
  'period-trade':   { trId: 'TTTC8715R', url: '/uapi/domestic-stock/v1/trading/inquire-period-trade-profit' },
  'period-rights':  { trId: 'CTRGA011R', url: '/uapi/domestic-stock/v1/trading/period-rights' },
  'credit-psamount':{ trId: 'TTTC8909R', url: '/uapi/domestic-stock/v1/trading/inquire-credit-psamount' },
  'intgr-margin':   { trId: 'TTTC0869R', url: '/uapi/domestic-stock/v1/trading/intgr-margin' },

  // ══ 국내주식 순위 ══
  'ranking-volume':     { trId: 'FHPST01710000', url: '/uapi/domestic-stock/v1/quotations/volume-rank' },
  'ranking-fluctuation':{ trId: 'FHPST01700000', url: '/uapi/domestic-stock/v1/ranking/fluctuation' },
  'ranking-profit':     { trId: 'FHPST01730000', url: '/uapi/domestic-stock/v1/ranking/profit-asset-index' },
  'ranking-marketcap':  { trId: 'FHPST01740000', url: '/uapi/domestic-stock/v1/ranking/market-cap' },
  'ranking-finance':    { trId: 'FHPST01750000', url: '/uapi/domestic-stock/v1/ranking/finance-ratio' },
  'ranking-quote-bal':  { trId: 'FHPST01720000', url: '/uapi/domestic-stock/v1/ranking/quote-balance' },
  'ranking-disparity':  { trId: 'FHPST01780000', url: '/uapi/domestic-stock/v1/ranking/disparity' },
  'ranking-credit':     { trId: 'FHKST17010000', url: '/uapi/domestic-stock/v1/ranking/credit-balance' },
  'ranking-short':      { trId: 'FHPST04820000', url: '/uapi/domestic-stock/v1/ranking/short-sale' },
  'ranking-dividend':   { trId: 'HHKDB13470100', url: '/uapi/domestic-stock/v1/ranking/dividend-rate' },
  'ranking-market-value':{ trId: 'FHPST01790000', url: '/uapi/domestic-stock/v1/ranking/market-value' },
  'ranking-volume-power':{ trId: 'FHPST01680000', url: '/uapi/domestic-stock/v1/ranking/volume-power' },
  'ranking-prefer':     { trId: 'FHPST01770000', url: '/uapi/domestic-stock/v1/ranking/prefer-disparate-ratio' },
  'ranking-near-hl':    { trId: 'FHPST01870000', url: '/uapi/domestic-stock/v1/ranking/near-new-highlow' },
  'ranking-bulk-trans':  { trId: 'FHKST190900C0', url: '/uapi/domestic-stock/v1/ranking/bulk-trans-num' },
  'ranking-top-interest':{ trId: 'FHPST01800000', url: '/uapi/domestic-stock/v1/ranking/top-interest-stock' },
  'ranking-by-company': { trId: 'FHPST01860000', url: '/uapi/domestic-stock/v1/ranking/traded-by-company' },
  'ranking-after-vol':  { trId: 'FHPST01760000', url: '/uapi/domestic-stock/v1/ranking/after-hour-balance' },
  'ranking-overtime-vol':{ trId: 'FHPST02350000', url: '/uapi/domestic-stock/v1/ranking/overtime-volume' },
  'ranking-overtime-fluct':{ trId: 'FHPST02340000', url: '/uapi/domestic-stock/v1/ranking/overtime-fluctuation' },
  'ranking-exp-trans':  { trId: 'FHPST01820000', url: '/uapi/domestic-stock/v1/ranking/exp-trans-updown' },
  'ranking-overtime-exp':{ trId: 'FHKST11860000', url: '/uapi/domestic-stock/v1/ranking/overtime-exp-trans-fluct' },
  'ranking-hts-top':    { trId: 'HHMCM000100C0', url: '/uapi/domestic-stock/v1/ranking/hts-top-view' },

  // ══ 국내주식 시세분석 ══
  'foreign-total':    { trId: 'FHPTJ04400000', url: '/uapi/domestic-stock/v1/quotations/foreign-institution-total' },
  'investor-daily':   { trId: 'FHPTJ04040000', url: '/uapi/domestic-stock/v1/quotations/inquire-investor-daily-by-market' },
  'investor-time':    { trId: 'FHPTJ04030000', url: '/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market' },
  'investor-by-stock':{ trId: 'FHPTJ04160001', url: '/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily' },
  'investor-trend':   { trId: 'HHPTJ04160200', url: '/uapi/domestic-stock/v1/quotations/investor-trend-estimate' },
  'program-today':    { trId: 'FHPPG04600101', url: '/uapi/domestic-stock/v1/quotations/comp-program-trade-today' },
  'program-daily':    { trId: 'FHPPG04600001', url: '/uapi/domestic-stock/v1/quotations/comp-program-trade-daily' },
  'program-by-stock': { trId: 'FHPPG04650101', url: '/uapi/domestic-stock/v1/quotations/program-trade-by-stock' },
  'program-by-stock-daily':{ trId: 'FHPPG04650201', url: '/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily' },
  'investor-program-today':{ trId: 'HHPPG046600C1', url: '/uapi/domestic-stock/v1/quotations/investor-program-trade-today' },
  'credit-daily':     { trId: 'FHPST04760000', url: '/uapi/domestic-stock/v1/quotations/daily-credit-balance' },
  'short-daily':      { trId: 'FHPST04830000', url: '/uapi/domestic-stock/v1/quotations/daily-short-sale' },
  'loan-daily':       { trId: 'HHPST074500C0', url: '/uapi/domestic-stock/v1/quotations/daily-loan-trans' },
  'cond-search-list': { trId: 'HHKST03900300', url: '/uapi/domestic-stock/v1/quotations/psearch-title' },
  'cond-search-result':{ trId: 'HHKST03900400', url: '/uapi/domestic-stock/v1/quotations/psearch-result' },
  'exp-price-trend':  { trId: 'FHPST01810000', url: '/uapi/domestic-stock/v1/quotations/exp-price-trend' },
  'pbar-tratio':      { trId: 'FHPST01130000', url: '/uapi/domestic-stock/v1/quotations/pbar-tratio' },
  'tradprt-byamt':    { trId: 'FHKST111900C0', url: '/uapi/domestic-stock/v1/quotations/tradprt-byamt' },
  'mktfunds':         { trId: 'FHKST649100C0', url: '/uapi/domestic-stock/v1/quotations/mktfunds' },
  'member-daily':     { trId: 'FHPST04540000', url: '/uapi/domestic-stock/v1/quotations/inquire-member-daily' },
  'capture-uplowprice':{ trId: 'FHKST130000C0', url: '/uapi/domestic-stock/v1/quotations/capture-uplowprice' },
  'frgnmem-trade':    { trId: 'FHKST644100C0', url: '/uapi/domestic-stock/v1/quotations/frgnmem-trade-estimate' },
  'frgnmem-pchs':     { trId: 'FHKST644400C0', url: '/uapi/domestic-stock/v1/quotations/frgnmem-pchs-trend' },

  // ══ 국내주식 재무 ══
  'finance-balance':  { trId: 'FHKST66430100', url: '/uapi/domestic-stock/v1/finance/balance-sheet' },
  'finance-income':   { trId: 'FHKST66430200', url: '/uapi/domestic-stock/v1/finance/income-statement' },
  'finance-ratio':    { trId: 'FHKST66430300', url: '/uapi/domestic-stock/v1/finance/financial-ratio' },
  'finance-profit':   { trId: 'FHKST66430400', url: '/uapi/domestic-stock/v1/finance/profit-ratio' },
  'finance-other':    { trId: 'FHKST66430500', url: '/uapi/domestic-stock/v1/finance/other-major-ratios' },
  'finance-stability':{ trId: 'FHKST66430600', url: '/uapi/domestic-stock/v1/finance/stability-ratio' },
  'finance-growth':   { trId: 'FHKST66430800', url: '/uapi/domestic-stock/v1/finance/growth-ratio' },

  // ══ 예탁원 정보 ══
  'ksd-bonus':      { trId: 'HHKDB669101C0', url: '/uapi/domestic-stock/v1/ksdinfo/bonus-issue' },
  'ksd-dividend':   { trId: 'HHKDB669102C0', url: '/uapi/domestic-stock/v1/ksdinfo/dividend' },
  'ksd-paidin':     { trId: 'HHKDB669100C0', url: '/uapi/domestic-stock/v1/ksdinfo/paidin-capin' },
  'ksd-purreq':     { trId: 'HHKDB669103C0', url: '/uapi/domestic-stock/v1/ksdinfo/purreq' },
  'ksd-merger':     { trId: 'HHKDB669104C0', url: '/uapi/domestic-stock/v1/ksdinfo/merger-split' },
  'ksd-revsplit':   { trId: 'HHKDB669105C0', url: '/uapi/domestic-stock/v1/ksdinfo/rev-split' },
  'ksd-capdcrs':    { trId: 'HHKDB669106C0', url: '/uapi/domestic-stock/v1/ksdinfo/cap-dcrs' },
  'ksd-listinfo':   { trId: 'HHKDB669107C0', url: '/uapi/domestic-stock/v1/ksdinfo/list-info' },
  'ksd-puboffer':   { trId: 'HHKDB669108C0', url: '/uapi/domestic-stock/v1/ksdinfo/pub-offer' },
  'ksd-forfeit':    { trId: 'HHKDB669109C0', url: '/uapi/domestic-stock/v1/ksdinfo/forfeit' },
  'ksd-manddeposit':{ trId: 'HHKDB669110C0', url: '/uapi/domestic-stock/v1/ksdinfo/mand-deposit' },
  'ksd-sharemeet':  { trId: 'HHKDB669111C0', url: '/uapi/domestic-stock/v1/ksdinfo/sharehld-meet' },

  // ══ ELW ══
  'elw-price':      { trId: 'FHKEW15010000', mockTrId: 'FHKEW15010000', url: '/uapi/domestic-stock/v1/quotations/inquire-elw-price' },
  'elw-search':     { trId: 'FHKEW15100000', url: '/uapi/elw/v1/quotations/cond-search' },
  'elw-updown':     { trId: 'FHPEW02770000', url: '/uapi/elw/v1/ranking/updown-rate' },
  'elw-volume':     { trId: 'FHPEW02780000', url: '/uapi/elw/v1/ranking/volume-rank' },
  'elw-indicator':  { trId: 'FHPEW02790000', url: '/uapi/elw/v1/ranking/indicator' },
  'elw-sensitivity':{ trId: 'FHPEW02850000', url: '/uapi/elw/v1/ranking/sensitivity' },
  'elw-quick-change':{ trId: 'FHPEW02870000', url: '/uapi/elw/v1/ranking/quick-change' },
  'elw-newly-listed':{ trId: 'FHKEW154800C0', url: '/uapi/elw/v1/quotations/newly-listed' },

  // ══ ETF/ETN ══
  'etf-price':      { trId: 'FHPST02400000', url: '/uapi/etfetn/v1/quotations/inquire-price' },
  'etf-nav-daily':  { trId: 'FHPST02440000', url: '/uapi/etfetn/v1/quotations/nav-comparison-trend' },
  'etf-nav-time':   { trId: 'FHPST02440100', url: '/uapi/etfetn/v1/quotations/nav-comparison-time-trend' },
  'etf-nav-day':    { trId: 'FHPST02440200', url: '/uapi/etfetn/v1/quotations/nav-comparison-daily-trend' },
  'etf-component':  { trId: 'FHKST121600C0', url: '/uapi/etfetn/v1/quotations/inquire-component-stock-price' },

  // ══ 선물옵션 ══
  'futures-price':  { trId: 'FHMIF10000000', url: '/uapi/domestic-futureoption/v1/quotations/inquire-price' },
  'futures-quote':  { trId: 'FHMIF10010000', url: '/uapi/domestic-futureoption/v1/quotations/inquire-asking-price' },
  'futures-chart':  { trId: 'FHKIF03020100', url: '/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice' },
  'futures-order':  { trId: 'TTTO1101U', mockTrId: 'VTTO1101U', method: 'POST', url: '/uapi/domestic-futureoption/v1/trading/order' },
  'futures-modify': { trId: 'TTTO1103U', mockTrId: 'VTTO1103U', method: 'POST', url: '/uapi/domestic-futureoption/v1/trading/order-rvsecncl' },
  'futures-balance':{ trId: 'CTFO6118R', mockTrId: 'VTFO6118R', url: '/uapi/domestic-futureoption/v1/trading/inquire-balance' },
  'futures-deposit':{ trId: 'CTRP6550R', url: '/uapi/domestic-futureoption/v1/trading/inquire-deposit' },
  'futures-margin': { trId: 'TTTO6032R', url: '/uapi/domestic-futureoption/v1/quotations/margin-rate' },

  // ══ 해외주식 시세 ══
  'overseas-price':      { trId: 'HHDFS00000300', url: '/uapi/overseas-price/v1/quotations/price' },
  'overseas-detail':     { trId: 'HHDFS76200200', url: '/uapi/overseas-price/v1/quotations/price-detail' },
  'overseas-daily':      { trId: 'HHDFS76240000', url: '/uapi/overseas-price/v1/quotations/dailyprice' },
  'overseas-chart':      { trId: 'FHKST03030100', url: '/uapi/overseas-price/v1/quotations/inquire-daily-chartprice' },
  'overseas-quote':      { trId: 'HHDFS76200100', url: '/uapi/overseas-price/v1/quotations/inquire-asking-price' },
  'overseas-ccnl':       { trId: 'HHDFS76200300', url: '/uapi/overseas-price/v1/quotations/inquire-ccnl' },
  'overseas-search':     { trId: 'HHDFS76410000', url: '/uapi/overseas-price/v1/quotations/inquire-search' },

  // ══ 해외주식 주문/계좌 ══
  'overseas-order-buy':  { trId: 'TTTT1002U', mockTrId: 'VTTT1002U', method: 'POST', url: '/uapi/overseas-stock/v1/trading/order' },
  'overseas-order-sell': { trId: 'TTTT1006U', mockTrId: 'VTTT1001U', method: 'POST', url: '/uapi/overseas-stock/v1/trading/order' },
  'overseas-order-modify':{ trId: 'TTTT1004U', mockTrId: 'VTTT1004U', method: 'POST', url: '/uapi/overseas-stock/v1/trading/order-rvsecncl' },
  'overseas-balance':    { trId: 'TTTS3012R', mockTrId: 'VTTS3012R', url: '/uapi/overseas-stock/v1/trading/inquire-balance' },
  'overseas-ccld':       { trId: 'TTTS3035R', mockTrId: 'VTTS3035R', url: '/uapi/overseas-stock/v1/trading/inquire-ccnl' },
  'overseas-psamount':   { trId: 'TTTS3007R', mockTrId: 'VTTS3007R', url: '/uapi/overseas-stock/v1/trading/inquire-psamount' },
};

/** OAuth 토큰 발급 */
async function getAccessToken(base, appKey, appSecret) {
  const resp = await fetch(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: appKey,
      appsecret: appSecret,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`토큰 발급 실패: ${resp.status}`);
  const json = await resp.json();
  if (!json.access_token) throw new Error(`토큰 응답 오류: ${JSON.stringify(json)}`);
  return json.access_token;
}

/** API 호출 (GET/POST 자동 분기) */
async function callApi(base, token, appKey, appSecret, trId, method, url, params = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'authorization': `Bearer ${token}`,
    'appkey': appKey,
    'appsecret': appSecret,
    'tr_id': trId,
  };

  let fullUrl = `${base}${url}`;
  const fetchOpts = { headers, signal: AbortSignal.timeout(15000) };

  if (method === 'POST') {
    fetchOpts.method = 'POST';
    fetchOpts.body = JSON.stringify(params);
  } else {
    fetchOpts.method = 'GET';
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) fullUrl += `?${qsStr}`;
  }

  const resp = await fetch(fullUrl, fetchOpts);
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`한투 API ${resp.status}: ${resp.statusText} ${errText}`.trim());
  }

  return await resp.json();
}

/** 편의 액션의 기본 파라미터 생성 */
function buildParams(action, data) {
  const p = { ...(data.params || {}) };

  // 종목코드 세팅
  if (data.symbol) {
    // 국내: FID_INPUT_ISCD, 해외: SYMB 등 — 액션에 따라 다름
    if (action.startsWith('overseas-')) {
      p.SYMB = p.SYMB || data.symbol;
      if (data.exchange) p.EXCD = p.EXCD || data.exchange;
    } else {
      p.FID_INPUT_ISCD = p.FID_INPUT_ISCD || data.symbol;
      p.FID_COND_MRKT_DIV_CODE = p.FID_COND_MRKT_DIV_CODE || 'J';
    }
  }

  // 주문 파라미터
  if (action.includes('order-buy') || action.includes('order-sell') || action.includes('order-modify') || action.includes('order-credit')) {
    if (data.symbol) p.PDNO = p.PDNO || data.symbol;
    if (data.quantity) p.ORD_QTY = p.ORD_QTY || String(data.quantity);
    if (data.price !== undefined) {
      p.ORD_UNPR = p.ORD_UNPR || String(data.price);
      p.ORD_DVSN = p.ORD_DVSN || (data.price === 0 ? '01' : '00');
    }
  }

  // 차트 기간
  if (action.startsWith('chart-') && data.period) {
    p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || data.period;
  }

  // 계좌 관련 API 기본 파라미터 (계좌번호는 API 키에 바인딩 — 빈 문자열이 기본)
  const accountActions = [
    'balance', 'balance-pl', 'deposit', 'psbl-order', 'psbl-sell',
    'daily-ccld', 'period-profit', 'period-trade', 'credit-psamount',
    'psbl-rvsecncl', 'order-reserve-list', 'intgr-margin', 'period-rights',
  ];
  if (accountActions.includes(action)) {
    p.CANO = p.CANO || data.accountNo || '';
    p.ACNT_PRDT_CD = p.ACNT_PRDT_CD || data.accountProductCode || '01';
  }

  // balance 전용 기본 파라미터
  if (action === 'balance') {
    p.AFHR_FLPR_YN = p.AFHR_FLPR_YN || 'N';
    p.OFL_YN = p.OFL_YN || '';
    p.INQR_DVSN = p.INQR_DVSN || '02';
    p.UNPR_DVSN = p.UNPR_DVSN || '01';
    p.FUND_STTL_ICLD_YN = p.FUND_STTL_ICLD_YN || 'N';
    p.FNCG_AMT_AUTO_RDPT_YN = p.FNCG_AMT_AUTO_RDPT_YN || 'N';
    p.PRCS_DVSN = p.PRCS_DVSN || '01';
    p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
    p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
  }

  return p;
}

// ─── Main ───
let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', async () => {
  try {
    const { data } = JSON.parse(raw);
    const action = data?.action;
    if (!action) {
      console.log(JSON.stringify({ success: false, error: 'data.action 필드가 필요합니다. 편의 액션(price, balance 등) 또는 trId를 url과 함께 지정하세요.' }));
      return;
    }

    const appKey = process.env['KIS_APP_KEY'];
    const appSecret = process.env['KIS_APP_SECRET'];
    if (!appKey || !appSecret) {
      console.log(JSON.stringify({ success: false, error: 'KIS_APP_KEY / KIS_APP_SECRET이 설정되지 않았습니다. 설정 > 시스템 모듈 > korea-invest에서 등록해주세요.' }));
      return;
    }

    const isMock = data.mock === true;
    const base = isMock ? BASE_MOCK : BASE_REAL;
    const token = await getAccessToken(base, appKey, appSecret);

    let trId, method, url, params;

    const mapped = ACTION_MAP[action];
    if (mapped) {
      // 편의 액션
      trId = (isMock && mapped.mockTrId) ? mapped.mockTrId : mapped.trId;
      method = mapped.method || 'GET';
      url = mapped.url;
      params = buildParams(action, data);
    } else if (data.trId && data.url) {
      // 직접 지정
      trId = data.trId;
      method = data.method || 'GET';
      url = data.url;
      params = data.params || {};
    } else {
      throw new Error(`알 수 없는 action: ${action}. 편의 액션이 아니면 trId와 url을 함께 지정하세요.`);
    }

    const result = await callApi(base, token, appKey, appSecret, trId, method, url, params);

    console.log(JSON.stringify({
      success: true,
      data: { trId, action, ...result },
    }));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

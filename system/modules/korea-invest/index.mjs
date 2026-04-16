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

/** OAuth 토큰 발급 (Vault 캐싱 — config.json tokenCache 기반) */
async function getAccessToken(base, appKey, appSecret) {
  // Vault에서 캐시된 토큰 (sandbox가 만료 체크 후 env 주입)
  const cached = process.env['KIS_ACCESS_TOKEN'];
  if (cached) return { token: cached, isNew: false };

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

  return { token: json.access_token, isNew: true };
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

// ─── 오늘 날짜 / 90일전 날짜 헬퍼 ───
function today() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function daysAgo(n) { const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10).replace(/-/g,''); }

// ─── 순위/분석 API FID_COND_SCR_DIV_CODE (엑셀 기준) ───
const SCR_CODES = {
  'volume-rank':'20171','ranking-volume':'20171',
  'ranking-fluctuation':'20170','ranking-profit':'20173','ranking-marketcap':'20174',
  'ranking-finance':'20175','ranking-quote-bal':'20172','ranking-disparity':'20178',
  'ranking-market-value':'20179','ranking-volume-power':'20168','ranking-prefer':'20177',
  'ranking-near-hl':'20187','ranking-top-interest':'20180','ranking-by-company':'20186',
  'ranking-after-vol':'20176','ranking-overtime-vol':'20235','ranking-overtime-fluct':'20234',
  'ranking-exp-trans':'20182','ranking-overtime-exp':'11186',
  'ranking-credit':'11701','ranking-short':'20482','ranking-bulk-trans':'11909',
  'vi-status':'20139','exp-closing':'11173',
  'credit-company':'20477','credit-daily':'20476','short-daily':'20483',
  'foreign-total':'20444','capture-uplowprice':'11130',
  'pbar-tratio':'20113','tradprt-byamt':'11119',
  'frgnmem-trade':'16441','frgnmem-pchs':'16444',
  'invest-opinion':'16633','invest-by-sec':'16634',
  'comp-interest':'20702',
  'exp-total-index':'11175','index-category':'20214',
  'elw-search':'15100',
  'elw-updown':'20277','elw-volume':'20278','elw-indicator':'20279',
  'elw-sensitivity':'20285','elw-quick-change':'20287','elw-newly-listed':'15480',
  'etf-component':'12160',
};

// ─── 계좌 관련 액션 목록 ───
const ACCOUNT_ACTIONS = new Set([
  'balance','balance-pl','deposit','psbl-order','psbl-sell','daily-ccld',
  'period-profit','period-trade','credit-psamount','psbl-rvsecncl',
  'order-reserve-list','intgr-margin','period-rights',
  'order-modify','order-reserve','order-reserve-cancel',
  'order-credit-buy','order-credit-sell',
  'futures-balance','futures-deposit',
  'overseas-balance','overseas-ccld','overseas-psamount',
]);

/** 편의 액션의 기본 파라미터 생성 (엑셀 Required 필드 기반) */
function buildParams(action, data) {
  const p = { ...(data.params || {}) };
  const sym = data.symbol || '';
  const exch = data.exchange || '';

  // ── 공통: 종목코드 (FID 기반 시세/순위 API만) ──
  if (action.startsWith('overseas-')) {
    if (sym) p.SYMB = p.SYMB || sym;
    if (exch) p.EXCD = p.EXCD || exch;
  } else if (!action.startsWith('ksd-') && !ACCOUNT_ACTIONS.has(action) && !action.includes('order-') && !['holiday','market-time','ranking-dividend','investor-program-today','cond-search-list','cond-search-result','mktfunds','loan-daily','investor-trend','estimate-perform','stock-info','product-info'].includes(action)) {
    p.FID_INPUT_ISCD = p.FID_INPUT_ISCD || sym;
    p.FID_COND_MRKT_DIV_CODE = p.FID_COND_MRKT_DIV_CODE || 'J';
  }

  // ── 주문 (POST) ──
  if (action.includes('order-buy') || action.includes('order-sell') || action.includes('order-modify') || action.includes('order-credit') || action === 'order-reserve') {
    if (sym) p.PDNO = p.PDNO || sym;
    if (data.quantity) p.ORD_QTY = p.ORD_QTY || String(data.quantity);
    if (data.price !== undefined) {
      p.ORD_UNPR = p.ORD_UNPR || String(data.price);
      p.ORD_DVSN = p.ORD_DVSN || (data.price === 0 ? '01' : '00');
    }
  }

  // ── 계좌 (CANO/ACNT_PRDT_CD) ──
  if (ACCOUNT_ACTIONS.has(action)) {
    p.CANO = p.CANO || data.accountNo || '';
    p.ACNT_PRDT_CD = p.ACNT_PRDT_CD || data.accountProductCode || '01';
  }

  // ── FID_COND_SCR_DIV_CODE (순위/분석 API 고유 코드) ──
  const scr = SCR_CODES[action];
  if (scr) p.FID_COND_SCR_DIV_CODE = p.FID_COND_SCR_DIV_CODE || scr;

  // ── 기간/차트 ──
  if (data.period) p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || data.period;

  // ── 액션별 Required 기본값 (엑셀 기준) ──
  switch (action) {

    // ═══ 기본시세 ═══
    case 'daily-price':
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      p.FID_ORG_ADJ_PRC = p.FID_ORG_ADJ_PRC || '0';
      break;
    case 'time-ccnl':
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      break;
    case 'volume-rank': case 'ranking-volume':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_BLNG_CLS_CODE = p.FID_BLNG_CLS_CODE || '0';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '111111111';
      p.FID_TRGT_EXLS_CLS_CODE = p.FID_TRGT_EXLS_CLS_CODE || '0000000000';
      p.FID_INPUT_PRICE_1 = p.FID_INPUT_PRICE_1 || '';
      p.FID_INPUT_PRICE_2 = p.FID_INPUT_PRICE_2 || '';
      p.FID_VOL_CNT = p.FID_VOL_CNT || '';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
      break;
    case 'vi-status':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '0';
      p.FID_TRGT_EXLS_CLS_CODE = p.FID_TRGT_EXLS_CLS_CODE || '0';
      break;
    case 'exp-closing':
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_BLNG_CLS_CODE = p.FID_BLNG_CLS_CODE || '0';
      break;
    case 'news-title':
      p.FID_NEWS_OFER_ENTP_CODE = p.FID_NEWS_OFER_ENTP_CODE || '';
      p.FID_COND_MRKT_CLS_CODE = p.FID_COND_MRKT_CLS_CODE || '0';
      p.FID_TITL_CNTT = p.FID_TITL_CNTT || '';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_INPUT_SRNO = p.FID_INPUT_SRNO || '';
      break;

    // ═══ 종목정보 ═══
    case 'stock-info': case 'product-info':
      p.PDNO = p.PDNO || sym;
      p.PRDT_TYPE_CD = p.PRDT_TYPE_CD || '300';
      break;
    case 'holiday':
      p.BASS_DT = p.BASS_DT || today();
      p.CTX_AREA_NK = p.CTX_AREA_NK || '';
      p.CTX_AREA_FK = p.CTX_AREA_FK || '';
      break;
    case 'invest-opinion':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(90);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      break;
    case 'invest-by-sec':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(90);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      break;
    case 'estimate-perform':
      p.SHT_CD = p.SHT_CD || sym;
      break;
    case 'credit-company':
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_slct_yn = p.fid_slct_yn || '';
      p.fid_input_iscd = p.fid_input_iscd || sym;
      p.fid_cond_mrkt_div_code = p.fid_cond_mrkt_div_code || 'J';
      break;

    // ═══ 차트 ═══
    case 'chart-daily':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(90);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      p.FID_ORG_ADJ_PRC = p.FID_ORG_ADJ_PRC || '0';
      break;
    case 'chart-minute':
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      p.FID_PW_DATA_INCU_YN = p.FID_PW_DATA_INCU_YN || 'N';
      p.FID_ETC_CLS_CODE = p.FID_ETC_CLS_CODE || '';
      break;
    case 'chart-daily-tl':
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_PW_DATA_INCU_YN = p.FID_PW_DATA_INCU_YN || 'N';
      break;
    case 'daily-trade-vol':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      break;
    case 'overtime-time':
      p.FID_HOUR_CLS_CODE = p.FID_HOUR_CLS_CODE || '';
      break;

    // ═══ 업종/지수 ═══
    case 'index-daily':
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      break;
    case 'index-chart':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(90);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      break;
    case 'index-time':
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      break;
    case 'index-category':
      p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
      p.FID_BLNG_CLS_CODE = p.FID_BLNG_CLS_CODE || '0';
      break;
    case 'index-minute':
      p.FID_ETC_CLS_CODE = p.FID_ETC_CLS_CODE || '';
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      p.FID_PW_DATA_INCU_YN = p.FID_PW_DATA_INCU_YN || 'N';
      break;
    case 'exp-index':
      p.FID_MKOP_CLS_CODE = p.FID_MKOP_CLS_CODE || '0';
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      break;
    case 'exp-total-index':
      p.fid_mrkt_cls_code = p.fid_mrkt_cls_code || '0';
      p.fid_mkop_cls_code = p.fid_mkop_cls_code || '0';
      break;
    case 'comp-interest':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_DIV_CLS_CODE1 = p.FID_DIV_CLS_CODE1 || '0';
      break;

    // ═══ 주문 (정정/예약) ═══
    case 'order-modify':
      p.KRX_FWDG_ORD_ORGNO = p.KRX_FWDG_ORD_ORGNO || '';
      p.RVSE_CNCL_DVSN_CD = p.RVSE_CNCL_DVSN_CD || '01';
      p.QTY_ALL_ORD_YN = p.QTY_ALL_ORD_YN || 'Y';
      break;
    case 'order-reserve':
      p.SLL_BUY_DVSN_CD = p.SLL_BUY_DVSN_CD || '02';
      p.ORD_DVSN_CD = p.ORD_DVSN_CD || '00';
      p.ORD_OBJT_CBLC_DVSN_CD = p.ORD_OBJT_CBLC_DVSN_CD || '10';
      break;

    // ═══ 계좌 ═══
    case 'balance':
      p.AFHR_FLPR_YN = p.AFHR_FLPR_YN || 'N';
      p.OFL_YN = p.OFL_YN || '';
      p.INQR_DVSN = p.INQR_DVSN || '02';
      p.UNPR_DVSN = p.UNPR_DVSN || '01';
      p.FUND_STTL_ICLD_YN = p.FUND_STTL_ICLD_YN || 'N';
      p.FNCG_AMT_AUTO_RDPT_YN = p.FNCG_AMT_AUTO_RDPT_YN || 'N';
      p.PRCS_DVSN = p.PRCS_DVSN || '01';
      p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
      p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
      break;
    case 'balance-pl':
      p.AFHR_FLPR_YN = p.AFHR_FLPR_YN || 'N';
      p.OFL_YN = p.OFL_YN || '';
      p.INQR_DVSN = p.INQR_DVSN || '02';
      p.UNPR_DVSN = p.UNPR_DVSN || '01';
      p.FUND_STTL_ICLD_YN = p.FUND_STTL_ICLD_YN || 'N';
      p.FNCG_AMT_AUTO_RDPT_YN = p.FNCG_AMT_AUTO_RDPT_YN || 'N';
      p.PRCS_DVSN = p.PRCS_DVSN || '01';
      p.COST_ICLD_YN = p.COST_ICLD_YN || 'Y';
      p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
      p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
      break;
    case 'deposit':
      p.INQR_DVSN_1 = p.INQR_DVSN_1 || '01';
      p.BSPR_BF_DT_APLY_YN = p.BSPR_BF_DT_APLY_YN || '';
      break;
    case 'psbl-order':
      p.PDNO = p.PDNO || sym;
      p.ORD_UNPR = p.ORD_UNPR || '0';
      p.ORD_DVSN = p.ORD_DVSN || '01';
      p.CMA_EVLU_AMT_ICLD_YN = p.CMA_EVLU_AMT_ICLD_YN || 'Y';
      p.OVRS_ICLD_YN = p.OVRS_ICLD_YN || 'N';
      break;
    case 'psbl-sell':
      p.PDNO = p.PDNO || sym;
      break;
    case 'psbl-rvsecncl':
      p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
      p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
      p.INQR_DVSN_1 = p.INQR_DVSN_1 || '0';
      p.INQR_DVSN_2 = p.INQR_DVSN_2 || '0';
      break;
    case 'order-reserve-list':
      p.RSVN_ORD_ORD_DT = p.RSVN_ORD_ORD_DT || daysAgo(30);
      p.RSVN_ORD_END_DT = p.RSVN_ORD_END_DT || today();
      p.RSVN_ORD_SEQ = p.RSVN_ORD_SEQ || '';
      p.TMNL_MDIA_KIND_CD = p.TMNL_MDIA_KIND_CD || '00';
      p.PRCS_DVSN_CD = p.PRCS_DVSN_CD || '0';
      p.CNCL_YN = p.CNCL_YN || '';
      p.PDNO = p.PDNO || '';
      p.SLL_BUY_DVSN_CD = p.SLL_BUY_DVSN_CD || '0';
      p.CTX_AREA_FK200 = p.CTX_AREA_FK200 || '';
      p.CTX_AREA_NK200 = p.CTX_AREA_NK200 || '';
      break;
    case 'period-profit':
      p.INQR_STRT_DT = p.INQR_STRT_DT || daysAgo(30);
      p.INQR_END_DT = p.INQR_END_DT || today();
      p.PDNO = p.PDNO || '';
      p.SORT_DVSN = p.SORT_DVSN || '00';
      p.INQR_DVSN = p.INQR_DVSN || '00';
      p.CBLC_DVSN = p.CBLC_DVSN || '00';
      p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
      p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
      break;
    case 'period-trade':
      p.PDNO = p.PDNO || '';
      p.INQR_STRT_DT = p.INQR_STRT_DT || daysAgo(30);
      p.INQR_END_DT = p.INQR_END_DT || today();
      p.SORT_DVSN = p.SORT_DVSN || '00';
      p.CBLC_DVSN = p.CBLC_DVSN || '00';
      p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
      p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
      break;
    case 'period-rights':
      p.INQR_DVSN = p.INQR_DVSN || '00';
      p.CUST_RNCNO25 = p.CUST_RNCNO25 || '';
      p.HMID = p.HMID || '';
      p.INQR_STRT_DT = p.INQR_STRT_DT || daysAgo(90);
      p.INQR_END_DT = p.INQR_END_DT || today();
      p.RGHT_TYPE_CD = p.RGHT_TYPE_CD || '';
      p.PDNO = p.PDNO || '';
      p.PRDT_TYPE_CD = p.PRDT_TYPE_CD || '';
      p.CTX_AREA_FK100 = p.CTX_AREA_FK100 || '';
      p.CTX_AREA_NK100 = p.CTX_AREA_NK100 || '';
      break;
    case 'credit-psamount':
      p.PDNO = p.PDNO || sym;
      p.ORD_UNPR = p.ORD_UNPR || '0';
      p.ORD_DVSN = p.ORD_DVSN || '01';
      p.CRDT_TYPE = p.CRDT_TYPE || '';
      p.CMA_EVLU_AMT_ICLD_YN = p.CMA_EVLU_AMT_ICLD_YN || 'Y';
      p.OVRS_ICLD_YN = p.OVRS_ICLD_YN || 'N';
      break;
    case 'intgr-margin':
      p.CMA_EVLU_AMT_ICLD_YN = p.CMA_EVLU_AMT_ICLD_YN || 'Y';
      p.WCRC_FRCR_DVSN_CD = p.WCRC_FRCR_DVSN_CD || '01';
      p.FWEX_CTRT_FRCR_DVSN_CD = p.FWEX_CTRT_FRCR_DVSN_CD || '01';
      break;

    // ═══ 순위 공통 FID 기본값 ═══
    case 'ranking-fluctuation':
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_input_cnt_1 = p.fid_input_cnt_1 || '0';
      p.fid_prc_cls_code = p.fid_prc_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_rsfl_rate1 = p.fid_rsfl_rate1 || '';
      p.fid_rsfl_rate2 = p.fid_rsfl_rate2 || '';
      break;
    case 'ranking-profit': case 'ranking-finance': case 'ranking-market-value':
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      p.fid_input_option_1 = p.fid_input_option_1 || '';
      p.fid_input_option_2 = p.fid_input_option_2 || '';
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_blng_cls_code = p.fid_blng_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      break;
    case 'ranking-marketcap':
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      break;
    case 'ranking-quote-bal':
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      break;
    case 'ranking-disparity':
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_hour_cls_code = p.fid_hour_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      break;
    case 'ranking-credit':
      p.FID_OPTION = p.FID_OPTION || '0';
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      break;
    case 'ranking-short':
      p.FID_APLY_RANG_VOL = p.FID_APLY_RANG_VOL || '';
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      p.FID_INPUT_CNT_1 = p.FID_INPUT_CNT_1 || '0';
      p.FID_TRGT_EXLS_CLS_CODE = p.FID_TRGT_EXLS_CLS_CODE || '0';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '0';
      p.FID_APLY_RANG_PRC_1 = p.FID_APLY_RANG_PRC_1 || '';
      p.FID_APLY_RANG_PRC_2 = p.FID_APLY_RANG_PRC_2 || '';
      break;
    case 'ranking-dividend':
      p.CTS_AREA = p.CTS_AREA || '';
      p.GB1 = p.GB1 || '0';
      p.UPJONG = p.UPJONG || '';
      p.GB2 = p.GB2 || '0';
      p.GB3 = p.GB3 || '0';
      p.F_DT = p.F_DT || daysAgo(365);
      p.T_DT = p.T_DT || today();
      p.GB4 = p.GB4 || '0';
      break;
    case 'ranking-volume-power':
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      break;
    case 'ranking-prefer':
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      break;
    case 'ranking-near-hl':
      p.fid_aply_rang_vol = p.fid_aply_rang_vol || '';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_input_cnt_1 = p.fid_input_cnt_1 || '0';
      p.fid_input_cnt_2 = p.fid_input_cnt_2 || '0';
      p.fid_prc_cls_code = p.fid_prc_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_aply_rang_prc_1 = p.fid_aply_rang_prc_1 || '';
      p.fid_aply_rang_prc_2 = p.fid_aply_rang_prc_2 || '';
      break;
    case 'ranking-bulk-trans':
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_aply_rang_prc_1 = p.fid_aply_rang_prc_1 || '';
      p.fid_aply_rang_prc_2 = p.fid_aply_rang_prc_2 || '';
      p.fid_input_iscd_2 = p.fid_input_iscd_2 || '';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      break;
    case 'ranking-top-interest':
      p.fid_input_iscd_2 = p.fid_input_iscd_2 || '';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_input_cnt_1 = p.fid_input_cnt_1 || '0';
      break;
    case 'ranking-by-company':
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_input_date_1 = p.fid_input_date_1 || today();
      p.fid_input_date_2 = p.fid_input_date_2 || today();
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_aply_rang_vol = p.fid_aply_rang_vol || '';
      p.fid_aply_rang_prc_1 = p.fid_aply_rang_prc_1 || '';
      p.fid_aply_rang_prc_2 = p.fid_aply_rang_prc_2 || '';
      break;
    case 'ranking-after-vol':
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_trgt_exls_cls_code = p.fid_trgt_exls_cls_code || '0';
      p.fid_trgt_cls_code = p.fid_trgt_cls_code || '0';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      p.fid_input_price_1 = p.fid_input_price_1 || '';
      p.fid_input_price_2 = p.fid_input_price_2 || '';
      break;
    case 'ranking-overtime-vol':
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_INPUT_PRICE_1 = p.FID_INPUT_PRICE_1 || '';
      p.FID_INPUT_PRICE_2 = p.FID_INPUT_PRICE_2 || '';
      p.FID_VOL_CNT = p.FID_VOL_CNT || '';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '0';
      p.FID_TRGT_EXLS_CLS_CODE = p.FID_TRGT_EXLS_CLS_CODE || '0';
      break;
    case 'ranking-overtime-fluct':
      p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_INPUT_PRICE_1 = p.FID_INPUT_PRICE_1 || '';
      p.FID_INPUT_PRICE_2 = p.FID_INPUT_PRICE_2 || '';
      p.FID_VOL_CNT = p.FID_VOL_CNT || '';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '0';
      p.FID_TRGT_EXLS_CLS_CODE = p.FID_TRGT_EXLS_CLS_CODE || '0';
      break;
    case 'ranking-exp-trans':
      p.fid_rank_sort_cls_code = p.fid_rank_sort_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || '0';
      p.fid_aply_rang_prc_1 = p.fid_aply_rang_prc_1 || '';
      p.fid_vol_cnt = p.fid_vol_cnt || '';
      p.fid_pbmn = p.fid_pbmn || '';
      p.fid_blng_cls_code = p.fid_blng_cls_code || '0';
      p.fid_mkop_cls_code = p.fid_mkop_cls_code || '0';
      break;
    case 'ranking-overtime-exp':
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_INPUT_PRICE_1 = p.FID_INPUT_PRICE_1 || '';
      p.FID_INPUT_PRICE_2 = p.FID_INPUT_PRICE_2 || '';
      p.FID_INPUT_VOL_1 = p.FID_INPUT_VOL_1 || '';
      break;

    // ═══ 시세분석 ═══
    case 'foreign-total':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_ETC_CLS_CODE = p.FID_ETC_CLS_CODE || '';
      break;
    case 'investor-daily':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_INPUT_ISCD_1 = p.FID_INPUT_ISCD_1 || '';
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_INPUT_ISCD_2 = p.FID_INPUT_ISCD_2 || '';
      break;
    case 'investor-time':
      p.fid_input_iscd = p.fid_input_iscd || sym;
      p.fid_input_iscd_2 = p.fid_input_iscd_2 || '';
      break;
    case 'investor-by-stock':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_ORG_ADJ_PRC = p.FID_ORG_ADJ_PRC || '0';
      p.FID_ETC_CLS_CODE = p.FID_ETC_CLS_CODE || '';
      break;
    case 'investor-trend':
      p.MKSC_SHRN_ISCD = p.MKSC_SHRN_ISCD || sym;
      break;
    case 'program-today':
      p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
      p.FID_SCTN_CLS_CODE = p.FID_SCTN_CLS_CODE || '0';
      p.FID_COND_MRKT_DIV_CODE1 = p.FID_COND_MRKT_DIV_CODE1 || '';
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      break;
    case 'program-daily':
      p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      break;
    case 'program-by-stock-daily':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      break;
    case 'investor-program-today':
      p.EXCH_DIV_CLS_CODE = p.EXCH_DIV_CLS_CODE || '0';
      p.MRKT_DIV_CLS_CODE = p.MRKT_DIV_CLS_CODE || '0';
      break;
    case 'credit-daily':
      p.fid_input_date_1 = p.fid_input_date_1 || daysAgo(30);
      break;
    case 'short-daily':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      break;
    case 'loan-daily':
      p.MRKT_DIV_CLS_CODE = p.MRKT_DIV_CLS_CODE || '0';
      p.MKSC_SHRN_ISCD = p.MKSC_SHRN_ISCD || sym;
      p.START_DATE = p.START_DATE || daysAgo(30);
      p.END_DATE = p.END_DATE || today();
      p.CTS = p.CTS || '';
      break;
    case 'cond-search-list':
      p.user_id = p.user_id || '';
      break;
    case 'cond-search-result':
      p.user_id = p.user_id || '';
      p.seq = p.seq || '';
      break;
    case 'exp-price-trend':
      p.fid_mkop_cls_code = p.fid_mkop_cls_code || '0';
      break;
    case 'pbar-tratio':
      p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
      break;
    case 'mktfunds':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      break;
    case 'member-daily':
      p.FID_INPUT_ISCD_2 = p.FID_INPUT_ISCD_2 || '';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(30);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_SCTN_CLS_CODE = p.FID_SCTN_CLS_CODE || '';
      break;
    case 'capture-uplowprice':
      p.FID_PRC_CLS_CODE = p.FID_PRC_CLS_CODE || '0';
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '0';
      p.FID_TRGT_EXLS_CLS_CODE = p.FID_TRGT_EXLS_CLS_CODE || '0';
      p.FID_INPUT_PRICE_1 = p.FID_INPUT_PRICE_1 || '';
      p.FID_INPUT_PRICE_2 = p.FID_INPUT_PRICE_2 || '';
      p.FID_VOL_CNT = p.FID_VOL_CNT || '';
      break;
    case 'frgnmem-trade':
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_RANK_SORT_CLS_CODE_2 = p.FID_RANK_SORT_CLS_CODE_2 || '0';
      break;
    case 'frgnmem-pchs':
      p.FID_INPUT_ISCD_2 = p.FID_INPUT_ISCD_2 || '';
      break;

    // ═══ 재무 ═══
    case 'finance-balance': case 'finance-income': case 'finance-ratio':
    case 'finance-profit': case 'finance-other': case 'finance-stability':
    case 'finance-growth':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || p.fid_div_cls_code || '0';
      p.fid_div_cls_code = p.fid_div_cls_code || p.FID_DIV_CLS_CODE || '0';
      p.fid_cond_mrkt_div_code = p.fid_cond_mrkt_div_code || 'J';
      p.fid_input_iscd = p.fid_input_iscd || sym;
      break;

    // ═══ 예탁원(KSD) ═══
    case 'ksd-bonus': case 'ksd-dividend': case 'ksd-paidin': case 'ksd-purreq':
    case 'ksd-merger': case 'ksd-revsplit': case 'ksd-capdcrs': case 'ksd-listinfo':
    case 'ksd-puboffer': case 'ksd-forfeit': case 'ksd-manddeposit': case 'ksd-sharemeet':
      p.SHT_CD = p.SHT_CD || sym;
      p.F_DT = p.F_DT || daysAgo(365);
      p.T_DT = p.T_DT || today();
      p.CTS = p.CTS || '';
      if (action === 'ksd-dividend') {
        p.GB1 = p.GB1 || '0';
        p.HIGH_GB = p.HIGH_GB || '0';
      }
      if (action === 'ksd-paidin') p.GB1 = p.GB1 || '0';
      if (action === 'ksd-revsplit') p.MARKET_GB = p.MARKET_GB || '0';
      break;

    // ═══ ELW ═══
    case 'elw-search':
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_INPUT_CNT_1 = p.FID_INPUT_CNT_1 || '0';
      p.FID_RANK_SORT_CLS_CODE_2 = p.FID_RANK_SORT_CLS_CODE_2 || '0';
      p.FID_INPUT_CNT_2 = p.FID_INPUT_CNT_2 || '0';
      p.FID_RANK_SORT_CLS_CODE_3 = p.FID_RANK_SORT_CLS_CODE_3 || '0';
      p.FID_INPUT_CNT_3 = p.FID_INPUT_CNT_3 || '0';
      p.FID_TRGT_CLS_CODE = p.FID_TRGT_CLS_CODE || '0';
      p.FID_UNAS_INPUT_ISCD = p.FID_UNAS_INPUT_ISCD || '';
      p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || '';
      p.FID_INPUT_ISCD_2 = p.FID_INPUT_ISCD_2 || '';
      p.FID_ETC_CLS_CODE = p.FID_ETC_CLS_CODE || '';
      p.FID_INPUT_RMNN_DYNU_1 = p.FID_INPUT_RMNN_DYNU_1 || '';
      p.FID_INPUT_RMNN_DYNU_2 = p.FID_INPUT_RMNN_DYNU_2 || '';
      p.FID_PRPR_CNT1 = p.FID_PRPR_CNT1 || '';
      p.FID_PRPR_CNT2 = p.FID_PRPR_CNT2 || '';
      p.FID_RSFL_RATE1 = p.FID_RSFL_RATE1 || '';
      p.FID_RSFL_RATE2 = p.FID_RSFL_RATE2 || '';
      p.FID_VOL1 = p.FID_VOL1 || '';
      p.FID_VOL2 = p.FID_VOL2 || '';
      p.FID_APLY_RANG_PRC_1 = p.FID_APLY_RANG_PRC_1 || '';
      p.FID_APLY_RANG_PRC_2 = p.FID_APLY_RANG_PRC_2 || '';
      p.FID_LVRG_VAL1 = p.FID_LVRG_VAL1 || '';
      p.FID_LVRG_VAL2 = p.FID_LVRG_VAL2 || '';
      p.FID_VOL3 = p.FID_VOL3 || '';
      p.FID_VOL4 = p.FID_VOL4 || '';
      p.FID_INTS_VLTL1 = p.FID_INTS_VLTL1 || '';
      p.FID_INTS_VLTL2 = p.FID_INTS_VLTL2 || '';
      p.FID_PRMM_VAL1 = p.FID_PRMM_VAL1 || '';
      p.FID_PRMM_VAL2 = p.FID_PRMM_VAL2 || '';
      p.FID_GEAR1 = p.FID_GEAR1 || '';
      p.FID_GEAR2 = p.FID_GEAR2 || '';
      p.FID_PRLS_QRYR_RATE1 = p.FID_PRLS_QRYR_RATE1 || '';
      p.FID_PRLS_QRYR_RATE2 = p.FID_PRLS_QRYR_RATE2 || '';
      p.FID_DELTA1 = p.FID_DELTA1 || '';
      p.FID_DELTA2 = p.FID_DELTA2 || '';
      p.FID_ACPR1 = p.FID_ACPR1 || '';
      p.FID_ACPR2 = p.FID_ACPR2 || '';
      p.FID_STCK_CNVR_RATE1 = p.FID_STCK_CNVR_RATE1 || '';
      p.FID_STCK_CNVR_RATE2 = p.FID_STCK_CNVR_RATE2 || '';
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_PRIT1 = p.FID_PRIT1 || '';
      p.FID_PRIT2 = p.FID_PRIT2 || '';
      p.FID_CFP1 = p.FID_CFP1 || '';
      p.FID_CFP2 = p.FID_CFP2 || '';
      p.FID_INPUT_NMIX_PRICE_1 = p.FID_INPUT_NMIX_PRICE_1 || '';
      p.FID_INPUT_NMIX_PRICE_2 = p.FID_INPUT_NMIX_PRICE_2 || '';
      p.FID_EGEA_VAL1 = p.FID_EGEA_VAL1 || '';
      p.FID_EGEA_VAL2 = p.FID_EGEA_VAL2 || '';
      p.FID_INPUT_DVDN_ERT = p.FID_INPUT_DVDN_ERT || '';
      p.FID_INPUT_HIST_VLTL = p.FID_INPUT_HIST_VLTL || '';
      p.FID_THETA1 = p.FID_THETA1 || '';
      p.FID_THETA2 = p.FID_THETA2 || '';
      break;
    case 'elw-updown': case 'elw-volume': case 'elw-indicator': case 'elw-sensitivity':
    case 'elw-quick-change':
      p.FID_UNAS_INPUT_ISCD = p.FID_UNAS_INPUT_ISCD || '';
      p.FID_INPUT_RMNN_DYNU_1 = p.FID_INPUT_RMNN_DYNU_1 || '';
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_INPUT_PRICE_1 = p.FID_INPUT_PRICE_1 || '';
      p.FID_INPUT_PRICE_2 = p.FID_INPUT_PRICE_2 || '';
      p.FID_INPUT_VOL_1 = p.FID_INPUT_VOL_1 || '';
      p.FID_INPUT_VOL_2 = p.FID_INPUT_VOL_2 || '';
      p.FID_RANK_SORT_CLS_CODE = p.FID_RANK_SORT_CLS_CODE || '0';
      p.FID_BLNG_CLS_CODE = p.FID_BLNG_CLS_CODE || '0';
      if (action === 'elw-updown' || action === 'elw-volume') {
        p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
        p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || '';
      }
      if (action === 'elw-volume') p.FID_INPUT_ISCD_2 = p.FID_INPUT_ISCD_2 || '';
      if (action === 'elw-sensitivity') p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
      if (action === 'elw-quick-change') {
        p.FID_MRKT_CLS_CODE = p.FID_MRKT_CLS_CODE || '0';
        p.FID_HOUR_CLS_CODE = p.FID_HOUR_CLS_CODE || '0';
        p.FID_INPUT_HOUR_1 = p.FID_INPUT_HOUR_1 || '';
        p.FID_INPUT_HOUR_2 = p.FID_INPUT_HOUR_2 || '';
      }
      break;
    case 'elw-newly-listed':
      p.FID_DIV_CLS_CODE = p.FID_DIV_CLS_CODE || '0';
      p.FID_UNAS_INPUT_ISCD = p.FID_UNAS_INPUT_ISCD || '';
      p.FID_INPUT_ISCD_2 = p.FID_INPUT_ISCD_2 || '';
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || '';
      p.FID_BLNC_CLS_CODE = p.FID_BLNC_CLS_CODE || '0';
      break;

    // ═══ ETF/ETN ═══
    case 'etf-nav-time':
      p.fid_hour_cls_code = p.fid_hour_cls_code || '';
      break;
    case 'etf-nav-day':
      p.fid_input_date_1 = p.fid_input_date_1 || daysAgo(30);
      p.fid_input_date_2 = p.fid_input_date_2 || today();
      break;
    case 'etf-component':
      break;

    // ═══ 선물옵션 ═══
    case 'futures-chart':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(90);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      break;
    case 'futures-balance':
      p.MGNA_DVSN = p.MGNA_DVSN || '01';
      p.EXCC_STAT_CD = p.EXCC_STAT_CD || '0';
      p.CTX_AREA_FK200 = p.CTX_AREA_FK200 || '';
      p.CTX_AREA_NK200 = p.CTX_AREA_NK200 || '';
      break;
    case 'futures-margin':
      p.BASS_DT = p.BASS_DT || today();
      p.BAST_ID = p.BAST_ID || '';
      p.CTX_AREA_NK200 = p.CTX_AREA_NK200 || '';
      break;

    // ═══ 해외주식 ═══
    case 'overseas-price': case 'overseas-detail': case 'overseas-quote':
      p.AUTH = p.AUTH || '';
      break;
    case 'overseas-daily':
      p.AUTH = p.AUTH || '';
      p.GUBN = p.GUBN || '0';
      p.BYMD = p.BYMD || '';
      p.MODP = p.MODP || '0';
      break;
    case 'overseas-chart':
      p.FID_INPUT_DATE_1 = p.FID_INPUT_DATE_1 || daysAgo(90);
      p.FID_INPUT_DATE_2 = p.FID_INPUT_DATE_2 || today();
      p.FID_PERIOD_DIV_CODE = p.FID_PERIOD_DIV_CODE || 'D';
      break;
    case 'overseas-ccnl':
      p.AUTH = p.AUTH || '';
      p.KEYB = p.KEYB || '';
      p.TDAY = p.TDAY || '';
      break;
    case 'overseas-search':
      p.AUTH = p.AUTH || '';
      break;
    case 'overseas-balance':
      p.OVRS_EXCG_CD = p.OVRS_EXCG_CD || exch;
      p.TR_CRCY_CD = p.TR_CRCY_CD || '';
      break;
    case 'overseas-ccld':
      p.PDNO = p.PDNO || '';
      p.ORD_STRT_DT = p.ORD_STRT_DT || daysAgo(7);
      p.ORD_END_DT = p.ORD_END_DT || today();
      p.SLL_BUY_DVSN = p.SLL_BUY_DVSN || '0';
      p.CCLD_NCCS_DVSN = p.CCLD_NCCS_DVSN || '0';
      p.OVRS_EXCG_CD = p.OVRS_EXCG_CD || exch;
      p.SORT_SQN = p.SORT_SQN || 'DS';
      p.ORD_DT = p.ORD_DT || '';
      p.ORD_GNO_BRNO = p.ORD_GNO_BRNO || '';
      p.ODNO = p.ODNO || '';
      p.CTX_AREA_NK200 = p.CTX_AREA_NK200 || '';
      p.CTX_AREA_FK200 = p.CTX_AREA_FK200 || '';
      break;
    case 'overseas-psamount':
      p.OVRS_EXCG_CD = p.OVRS_EXCG_CD || exch;
      p.OVRS_ORD_UNPR = p.OVRS_ORD_UNPR || '0';
      p.ITEM_CD = p.ITEM_CD || sym;
      break;
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
    const { token, isNew } = await getAccessToken(base, appKey, appSecret);

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

    const output = {
      success: true,
      data: { trId, action, ...result },
    };
    // 새 토큰 발급 시 Vault에 캐싱 요청 (TTL은 config.json tokenCache.ttlHours)
    if (isNew) output.__updateSecrets = { KIS_ACCESS_TOKEN: token };
    console.log(JSON.stringify(output));
  } catch (e) {
    console.log(JSON.stringify({ success: false, error: e.message }));
  }
});

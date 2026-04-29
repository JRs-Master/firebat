"""
Firebat System Module: yfinance
Yahoo Finance 무료 API — 글로벌 종목 분석·백테스트·재무 시계열·옵션.

[INPUT]  stdin JSON: { "correlationId": "...", "data": { "action": "...", "symbol": "...", ... } }
[OUTPUT] stdout JSON: { "success": true, "data": {...} } 또는 { "success": false, "error": "..." }

actions: quote / history / info / financials / dividends / splits / recommendations / options / holders / news / download
"""
import sys
import json
import math


def out(success, data=None, error=None):
    msg = {'success': success}
    if data is not None:
        msg['data'] = data
    if error:
        msg['error'] = error
    sys.stdout.write(json.dumps(msg, ensure_ascii=False, default=str))
    sys.stdout.flush()


def safe_float(v):
    """NaN / None / inf → None. 그 외 float."""
    try:
        if v is None:
            return None
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def safe_int(v):
    f = safe_float(v)
    return int(f) if f is not None else None


def df_to_records(df):
    """pandas DataFrame → JSON-friendly list of records. NaN → None, datetime → ISO."""
    import pandas as pd
    if df is None or len(df) == 0:
        return []
    records = []
    for idx, row in df.iterrows():
        rec = {'_index': idx.isoformat() if hasattr(idx, 'isoformat') else str(idx)}
        for col in df.columns:
            v = row[col]
            if pd.isna(v):
                rec[str(col)] = None
            elif hasattr(v, 'isoformat'):
                rec[str(col)] = v.isoformat()
            elif isinstance(v, (int, float)):
                rec[str(col)] = safe_float(v)
            else:
                rec[str(col)] = str(v)
        records.append(rec)
    return records


def history_records(df, limit):
    """yfinance Ticker.history() DataFrame → 표준 OHLCV records. limit 마지막 N개 cut."""
    import pandas as pd
    if df is None or len(df) == 0:
        return []
    result = []
    for idx, row in df.iterrows():
        result.append({
            'date': idx.isoformat() if hasattr(idx, 'isoformat') else str(idx),
            'open': safe_float(row.get('Open')),
            'high': safe_float(row.get('High')),
            'low': safe_float(row.get('Low')),
            'close': safe_float(row.get('Close')),
            'volume': safe_int(row.get('Volume')) or 0,
            'dividends': safe_float(row.get('Dividends')) or 0,
            'stockSplits': safe_float(row.get('Stock Splits')) or 0,
        })
    if limit and len(result) > limit:
        result = result[-limit:]
    return result


def main():
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw.decode('utf-8'))
    data = payload.get('data', {})
    action = data.get('action', '')
    symbol = data.get('symbol', '')

    import yfinance as yf

    # action='download' — 다종목 batch
    if action == 'download':
        symbols = data.get('symbols') or []
        if not symbols:
            return out(False, error="action='download' 에는 symbols 배열 필수")
        period = data.get('period', '1mo')
        interval = data.get('interval', '1d')
        limit = data.get('limit', 50)
        df = yf.download(' '.join(symbols), period=period, interval=interval, progress=False, group_by='ticker', auto_adjust=True)
        # 다종목이면 multi-index columns. 단일이면 single.
        result = {}
        if len(symbols) == 1:
            result[symbols[0]] = history_records(df, limit)
        else:
            for sym in symbols:
                try:
                    sub = df[sym] if sym in df.columns.levels[0] else None
                    result[sym] = history_records(sub, limit)
                except (KeyError, AttributeError):
                    result[sym] = []
        return out(True, result)

    if not symbol:
        return out(False, error='symbol 필수 (action=download 시 symbols 배열)')

    t = yf.Ticker(symbol)

    if action == 'quote':
        info = t.info
        if not info or len(info) < 3:
            return out(False, error=f'종목 정보 없음: {symbol} (코드 확인 또는 Yahoo 미지원)')
        return out(True, {
            'symbol': symbol,
            'shortName': info.get('shortName'),
            'longName': info.get('longName'),
            'price': safe_float(info.get('currentPrice') or info.get('regularMarketPrice')),
            'change': safe_float(info.get('regularMarketChange')),
            'changePct': safe_float(info.get('regularMarketChangePercent')),
            'previousClose': safe_float(info.get('previousClose') or info.get('regularMarketPreviousClose')),
            'open': safe_float(info.get('open') or info.get('regularMarketOpen')),
            'dayHigh': safe_float(info.get('dayHigh') or info.get('regularMarketDayHigh')),
            'dayLow': safe_float(info.get('dayLow') or info.get('regularMarketDayLow')),
            'currency': info.get('currency'),
            'marketCap': safe_int(info.get('marketCap')),
            'enterpriseValue': safe_int(info.get('enterpriseValue')),
            'peRatio': safe_float(info.get('trailingPE')),
            'forwardPE': safe_float(info.get('forwardPE')),
            'pegRatio': safe_float(info.get('pegRatio') or info.get('trailingPegRatio')),
            'pbRatio': safe_float(info.get('priceToBook')),
            'psRatio': safe_float(info.get('priceToSalesTrailing12Months')),
            'roe': safe_float(info.get('returnOnEquity')),
            'roa': safe_float(info.get('returnOnAssets')),
            'eps': safe_float(info.get('trailingEps')),
            'forwardEps': safe_float(info.get('forwardEps')),
            'dividendYield': safe_float(info.get('dividendYield')),
            'dividendRate': safe_float(info.get('dividendRate')),
            'fiftyTwoWeekHigh': safe_float(info.get('fiftyTwoWeekHigh')),
            'fiftyTwoWeekLow': safe_float(info.get('fiftyTwoWeekLow')),
            'volume': safe_int(info.get('volume') or info.get('regularMarketVolume')),
            'avgVolume': safe_int(info.get('averageVolume')),
            'avgVolume10Day': safe_int(info.get('averageVolume10days')),
            'sector': info.get('sector'),
            'industry': info.get('industry'),
            'country': info.get('country'),
            'beta': safe_float(info.get('beta')),
            'profitMargin': safe_float(info.get('profitMargins')),
            'operatingMargin': safe_float(info.get('operatingMargins')),
            'revenueGrowth': safe_float(info.get('revenueGrowth')),
            'earningsGrowth': safe_float(info.get('earningsGrowth')),
            'debtToEquity': safe_float(info.get('debtToEquity')),
            'currentRatio': safe_float(info.get('currentRatio')),
            'quickRatio': safe_float(info.get('quickRatio')),
            'recommendationKey': info.get('recommendationKey'),
            'recommendationMean': safe_float(info.get('recommendationMean')),
            'numberOfAnalystOpinions': safe_int(info.get('numberOfAnalystOpinions')),
            'targetMeanPrice': safe_float(info.get('targetMeanPrice')),
            'targetHighPrice': safe_float(info.get('targetHighPrice')),
            'targetLowPrice': safe_float(info.get('targetLowPrice')),
        })

    if action == 'history':
        period = data.get('period', '1mo')
        interval = data.get('interval', '1d')
        start = data.get('start')
        end = data.get('end')
        limit = data.get('limit', 50)
        if start or end:
            df = t.history(start=start, end=end, interval=interval)
        else:
            df = t.history(period=period, interval=interval)
        return out(True, history_records(df, limit))

    if action == 'info':
        info = t.info
        if not info or len(info) < 3:
            return out(False, error=f'종목 정보 없음: {symbol}')
        # NaN/inf 정제
        cleaned = {}
        for k, v in info.items():
            if isinstance(v, float):
                cleaned[k] = safe_float(v)
            elif isinstance(v, (str, int, bool, list, dict)) or v is None:
                cleaned[k] = v
            else:
                cleaned[k] = str(v)
        return out(True, cleaned)

    if action == 'financials':
        statement = data.get('statement', 'income')
        frequency = data.get('frequency', 'annual')
        is_q = (frequency == 'quarterly')
        if statement == 'income':
            df = t.quarterly_financials if is_q else t.financials
        elif statement == 'balance':
            df = t.quarterly_balance_sheet if is_q else t.balance_sheet
        elif statement == 'cashflow':
            df = t.quarterly_cashflow if is_q else t.cashflow
        else:
            return out(False, error=f"unknown statement: {statement} (income/balance/cashflow)")
        return out(True, df_to_records(df))

    if action == 'dividends':
        s = t.dividends
        limit = data.get('limit', 50)
        result = [{'date': idx.isoformat() if hasattr(idx, 'isoformat') else str(idx), 'dividend': safe_float(v)} for idx, v in s.items()]
        if limit and len(result) > limit:
            result = result[-limit:]
        return out(True, result)

    if action == 'splits':
        s = t.splits
        result = [{'date': idx.isoformat() if hasattr(idx, 'isoformat') else str(idx), 'ratio': safe_float(v)} for idx, v in s.items()]
        return out(True, result)

    if action == 'recommendations':
        df = t.recommendations
        limit = data.get('limit', 50)
        records = df_to_records(df)
        if limit and len(records) > limit:
            records = records[-limit:]
        return out(True, records)

    if action == 'options':
        opts = list(t.options or [])
        if not opts:
            return out(True, {'expirations': [], 'expiration': None, 'calls': [], 'puts': []})
        date_str = data.get('optionDate') or opts[0]
        chain = t.option_chain(date_str)
        return out(True, {
            'expirations': opts,
            'expiration': date_str,
            'calls': df_to_records(chain.calls),
            'puts': df_to_records(chain.puts),
        })

    if action == 'holders':
        major = df_to_records(t.major_holders) if hasattr(t, 'major_holders') else []
        institutional = df_to_records(t.institutional_holders) if hasattr(t, 'institutional_holders') else []
        return out(True, {'major': major, 'institutional': institutional})

    if action == 'news':
        news = t.news or []
        limit = data.get('limit', 10)
        result = []
        for n in news[:limit]:
            thumb = None
            if n.get('thumbnail') and isinstance(n['thumbnail'], dict):
                resolutions = n['thumbnail'].get('resolutions') or []
                if resolutions:
                    thumb = resolutions[0].get('url')
            result.append({
                'title': n.get('title'),
                'publisher': n.get('publisher'),
                'link': n.get('link'),
                'publishedAt': n.get('providerPublishTime'),
                'type': n.get('type'),
                'thumbnail': thumb,
            })
        return out(True, result)

    return out(False, error=f'unknown action: {action}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        out(False, error=f'{type(e).__name__}: {e}')

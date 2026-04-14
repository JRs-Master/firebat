"""
Firebat System Module: browser-scrape
Playwright 기반 JS 렌더링 웹 스크래퍼

[INPUT]  stdin JSON: {
           "correlationId": "...",
           "data": {
             "url": "string",
             "selector"?: "css selector — 지정하면 해당 요소의 html/text만 반환",
             "waitFor"?: "networkidle|load|domcontentloaded (기본: networkidle)",
             "excludeDomains"?: ["naver.com", ...] — links 필터링 시 제외할 도메인
           }
         }
[OUTPUT] stdout JSON: {
           "success": true,
           "data": {
             "url": "최종 URL",
             "title": "페이지 제목",
             "html": "전체 또는 selector 대상 HTML",
             "text": "전체 또는 selector 대상 텍스트",
             "links": [{ "href": "...", "text": "..." }, ...],  -- 페이지 내 모든 외부 링크
             "firstLink": { "href": "...", "text": "..." } | null  -- 첫 번째 외부 링크
           }
         }
         또는 { "success": false, "error": "..." }
"""
import sys
import json
import os
from urllib.parse import urlparse

def extract_domain(url):
    try:
        return urlparse(url).netloc
    except Exception:
        return ''


def main():
    try:
        raw = sys.stdin.buffer.read()
        payload = json.loads(raw.decode('utf-8'))
        data = payload.get('data', {})

        url             = data.get('url', '')
        selector        = data.get('selector', None)
        wait_for        = data.get('waitFor', 'networkidle')
        exclude_domains = data.get('excludeDomains', [])

        if not url:
            print(json.dumps({"success": False, "error": "data.url 필드가 필요합니다."}))
            return

        base_domain = extract_domain(url)

        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
            )
            page.goto(url, wait_until=wait_for, timeout=int(os.environ.get('MODULE_TIMEOUT', '30000')))

            title = page.title()

            if selector:
                el   = page.query_selector(selector)
                html = el.inner_html() if el else ''
                text = el.inner_text().strip() if el else ''
            else:
                html = page.content()
                text = page.evaluate("() => document.body.innerText") or ''

            # 외부 링크 수집 (base_domain 및 excludeDomains 제외)
            all_anchors = page.evaluate("""() =>
                Array.from(document.querySelectorAll('a[href]')).map(a => ({
                    href: a.href,
                    text: (a.innerText || a.textContent || '').trim()
                }))
            """)

            excluded = set(exclude_domains + [base_domain])
            links = []
            for a in all_anchors:
                href = a.get('href', '')
                if not href.startswith('http'):
                    continue
                domain = extract_domain(href)
                if any(domain == ex or domain.endswith('.' + ex) for ex in excluded):
                    continue
                if href not in [l['href'] for l in links]:
                    links.append({"href": href, "text": a.get('text', '')})

            browser.close()

        first_link = links[0] if links else None

        print(json.dumps({
            "success": True,
            "data": {
                "url":       url,
                "title":     title,
                "text":      text[:int(os.environ.get('MODULE_MAXTEXTLENGTH', '50000'))],
                "links":     links[:10],   # 최대 10개
                "firstLink": first_link
            }
        }, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    main()

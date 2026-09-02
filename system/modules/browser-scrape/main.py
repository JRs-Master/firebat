"""
Firebat System Module: browser-scrape
A headless Chromium (Playwright) that reads a JS-rendered page, or photographs one.

Two things come out of the same browser:

  text  (default)      url -> the rendered text, title and outbound links
  picture (screenshot) url OR inline html -> a PNG in the media store

The picture path is deliberately ignorant of what it is photographing: it takes
HTML and gives back an image. That is what makes it a mechanism rather than a
feature — a KaTeX formula, an ECharts plot, a styled table and a social card are
all just "some HTML" to it, and none of them costs this module a line of code.
The caller assembles the page (CDN links included; the browser has network).

[INPUT]  stdin JSON: {
           "correlationId": "...",
           "data": {
             "url"?:         "page to open — required unless `html` is given",
             "html"?:        "inline HTML to render instead of fetching a url",
             "selector"?:    "css selector — narrows both the text and the shot",
             "waitFor"?:     "networkidle|load|domcontentloaded|commit",
             "excludeDomains"?: ["naver.com", ...],
             "screenshot"?:  true -> return a PNG instead of text,
             "viewport"?:    "WxH" (default 1280x720),
             "scale"?:       device pixel ratio, 1..4 (default 2),
             "fullPage"?:    true -> the whole scrollable page,
             "transparent"?: true -> no page background painted
           }
         }
[OUTPUT] stdout JSON — text path:
           { "success": true, "data": { url, title, text, links, firstLink } }
         picture path:
           { "success": true, "data": { url, title, width, height,
                                        _mediaImport: {path, contentType, filenameHint} } }
         failure:
           { "success": false, "errorKey": "...", "errorParams": {...} }
"""
import sys
import json
import os
import time
from urllib.parse import urlparse

SHOT_DIR = os.path.join("data", "browser-shot")

def extract_domain(url):
    try:
        return urlparse(url).netloc
    except Exception:
        return ''


def parse_viewport(spec, fallback=(1280, 720)):
    """'WxH' -> (w, h), clamped. A bad string falls back rather than failing the call."""
    try:
        w, h = str(spec).lower().split('x')
        w, h = int(w), int(h)
        if 16 <= w <= 4096 and 16 <= h <= 4096:
            return w, h
    except Exception:
        pass
    return fallback


def sweep_shots(keep_sec=86400, keep_n=200):
    """Old shots are cache, not records — the media store holds anything worth keeping."""
    try:
        files = []
        for n in os.listdir(SHOT_DIR):
            p = os.path.join(SHOT_DIR, n)
            if os.path.isfile(p):
                files.append((os.path.getmtime(p), p))
        files.sort(reverse=True)
        now = time.time()
        for i, (mt, p) in enumerate(files):
            if i >= keep_n or now - mt > keep_sec:
                try:
                    os.remove(p)
                except OSError:
                    pass
    except OSError:
        pass


def take_shot(page, data, selector):
    """Photograph the page (or one element) and hand the file to the framework."""
    full_page   = bool(data.get('fullPage', False))
    transparent = bool(data.get('transparent', False))

    target = page
    if selector:
        el = page.query_selector(selector)
        if el is None:
            return None, 'error.selector_not_found'
        target = el

    os.makedirs(SHOT_DIR, exist_ok=True)
    path = os.path.join(SHOT_DIR, 'shot-%d.png' % int(time.time() * 1000)).replace('\\', '/')
    if target is page:
        page.screenshot(path=path, full_page=full_page, omit_background=transparent, type='png')
    else:
        # an element shot is already tight to the element; full_page does not apply
        target.screenshot(path=path, omit_background=transparent, type='png')
    return path, None


def main():
    try:
        raw = sys.stdin.buffer.read()
        payload = json.loads(raw.decode('utf-8'))
        data = payload.get('data', {})

        url             = data.get('url', '')
        html            = data.get('html', None)
        selector        = data.get('selector', None)
        wait_for        = data.get('waitFor', 'networkidle')
        exclude_domains = data.get('excludeDomains', [])
        want_shot       = bool(data.get('screenshot', False))

        if want_shot and not url and not html:
            print(json.dumps({"success": False, "errorKey": "error.target_required",
                              "errorParams": {}}, ensure_ascii=False))
            return
        if not want_shot and not url:
            print(json.dumps({"success": False, "errorKey": "error.url_required", "errorParams": {}}))
            return

        base_domain = extract_domain(url)
        vw, vh = parse_viewport(data.get('viewport', '1280x720'))
        try:
            scale = min(4.0, max(1.0, float(data.get('scale', 2))))
        except (TypeError, ValueError):
            scale = 2.0

        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
                viewport={"width": vw, "height": vh},
                device_scale_factor=scale,
            )
            timeout_ms = int(os.environ.get('MODULE_TIMEOUT', '30000'))
            if html:
                # set_content resolves once the document's own subresources settle, which is what
                # a CDN stylesheet and its webfonts need before anything is worth photographing.
                page.set_content(html, wait_until=wait_for, timeout=timeout_ms)
            else:
                page.goto(url, wait_until=wait_for, timeout=timeout_ms)

            if want_shot:
                path, err = take_shot(page, data, selector)
                title = page.title()
                browser.close()
                if err:
                    print(json.dumps({"success": False, "errorKey": err,
                                      "errorParams": {"selector": selector or ""}},
                                     ensure_ascii=False))
                    return
                sweep_shots()
                print(json.dumps({
                    "success": True,
                    "data": {
                        "url": url or "(inline html)",
                        "title": title,
                        "viewport": "%dx%d" % (vw, vh),
                        "scale": scale,
                        "_mediaImport": {"path": path, "contentType": "image/png",
                                         "filenameHint": "shot"},
                    }
                }, ensure_ascii=False))
                return

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
                "text":      text[:int(os.environ.get('MODULE_MAXTEXTLENGTH', '100000'))],
                "links":     links[:10],   # 최대 10개
                "firstLink": first_link
            }
        }, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({"success": False, "errorKey": "error.runtime", "errorParams": {"message": str(e)}}, ensure_ascii=False))

if __name__ == '__main__':
    main()

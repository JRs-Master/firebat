'use client';

import { useEffect } from 'react';

interface Props {
  headScripts: string;
  bodyScripts: string;
}

/** SEO 스크립트 주입 — head/body에 관리자가 설정한 HTML 삽입 */
export function SeoScripts({ headScripts, bodyScripts }: Props) {
  useEffect(() => {
    // head 스크립트 주입 (Google Analytics, 메타 픽셀 등)
    if (headScripts) {
      const container = document.createElement('div');
      container.innerHTML = headScripts;
      const nodes = Array.from(container.childNodes);
      for (const node of nodes) {
        if (node instanceof HTMLScriptElement) {
          // script 태그는 innerHTML로는 실행되지 않으므로 새로 생성
          const script = document.createElement('script');
          if (node.src) script.src = node.src;
          if (node.textContent) script.textContent = node.textContent;
          if (node.async) script.async = true;
          for (const attr of Array.from(node.attributes)) {
            if (!['src', 'async'].includes(attr.name)) {
              script.setAttribute(attr.name, attr.value);
            }
          }
          script.dataset.seoHead = '';
          document.head.appendChild(script);
        } else {
          const clone = node.cloneNode(true);
          if (clone instanceof HTMLElement) clone.dataset.seoHead = '';
          document.head.appendChild(clone);
        }
      }
    }

    // body 스크립트 주입 (채팅 위젯, 트래킹 등)
    if (bodyScripts) {
      const container = document.createElement('div');
      container.innerHTML = bodyScripts;
      const nodes = Array.from(container.childNodes);
      for (const node of nodes) {
        if (node instanceof HTMLScriptElement) {
          const script = document.createElement('script');
          if (node.src) script.src = node.src;
          if (node.textContent) script.textContent = node.textContent;
          if (node.async) script.async = true;
          for (const attr of Array.from(node.attributes)) {
            if (!['src', 'async'].includes(attr.name)) {
              script.setAttribute(attr.name, attr.value);
            }
          }
          script.dataset.seoBody = '';
          document.body.appendChild(script);
        } else {
          const clone = node.cloneNode(true);
          if (clone instanceof HTMLElement) clone.dataset.seoBody = '';
          document.body.appendChild(clone);
        }
      }
    }

    // 클린업 — 페이지 이동 시 제거
    return () => {
      document.querySelectorAll('[data-seo-head]').forEach(el => el.remove());
      document.querySelectorAll('[data-seo-body]').forEach(el => el.remove());
    };
  }, [headScripts, bodyScripts]);

  return null;
}

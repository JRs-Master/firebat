'use client';

import { useEffect, useRef } from 'react';
import { loadCdn } from '@/lib/util/load-cdn';

/**
 * Code block — highlight.js (github theme) syntax highlighting + optional line numbers / title.
 * Shared single source for the render `code` component AND chat/share markdown fenced blocks.
 */
export function CodeComp({ code, language, showLineNumbers, title }: {
  code: string; language: string; showLineNumbers: boolean; title?: string | null;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current || !code) return;
    const target = ref.current;
    loadCdn({
      js: ['https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js'],
      css: ['https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css'],
      globalCheck: () => !!(window as any).hljs,
    }).then(() => {
      const w = window as any;
      if (!w.hljs) return;
      try {
        const langClass = w.hljs.getLanguage(language) ? language : 'plaintext';
        const result = w.hljs.highlight(code, { language: langClass });
        target.innerHTML = result.value;
        target.className = `hljs language-${langClass}`;
      } catch {
        target.textContent = code;
      }
    });
  }, [code, language]);

  const lines = showLineNumbers ? code.split('\n') : [];
  return (
    <div className="my-3 rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      {title && (
        <div className="bg-gray-50 px-4 py-2 text-[12px] font-mono text-gray-600 border-b border-gray-100">
          {title}
        </div>
      )}
      <div className="flex">
        {showLineNumbers && (
          <div className="bg-gray-50 px-3 py-3 text-[12px] font-mono text-gray-400 select-none text-right border-r border-gray-100">
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
        )}
        <pre className="flex-1 p-3 text-[13px] overflow-x-auto" style={{ margin: 0 }}>
          <code ref={ref}>{code}</code>
        </pre>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { loadCdn } from '@/lib/util/load-cdn';
import { copyText } from '../../lib/clipboard';

/**
 * Code block — highlight.js syntax highlighting + optional line numbers / title.
 * Shared single source for the render `code` component AND chat/share markdown fenced blocks.
 *
 * The surface is one step deeper than the page rather than dark: a block on pure white sits at
 * the same brightness as the prose around it and reads as body text (2026-08-10 실측 — a JSON
 * dump did exactly that), while a dark panel would be the only dark thing on the screen. Slate
 * tones keep it inside the Firebat palette and still separate it at a glance. The language rides
 * in the corner so the reader knows what they are looking at, and a copy button, because a block
 * of code exists to be taken somewhere.
 */

/** Common aliases → the label people expect to see. Unknown languages show as written. */
const LANG_LABEL: Record<string, string> = {
  plaintext: 'TEXT', text: 'TEXT', txt: 'TEXT',
  js: 'JS', javascript: 'JS', jsx: 'JSX',
  ts: 'TS', typescript: 'TS', tsx: 'TSX',
  py: 'PY', python: 'PY',
  md: 'MD', markdown: 'MD',
  sh: 'SH', bash: 'SH', shell: 'SH', zsh: 'SH',
  yml: 'YAML', yaml: 'YAML',
  json: 'JSON', html: 'HTML', css: 'CSS', sql: 'SQL', rust: 'RUST', rs: 'RUST',
  java: 'JAVA', go: 'GO', c: 'C', cpp: 'C++', csharp: 'C#', php: 'PHP', ruby: 'RUBY',
};

export function CodeComp({ code, language, showLineNumbers, title }: {
  code: string; language: string; showLineNumbers: boolean; title?: string | null;
}) {
  const ref = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
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

  const copy = async () => {
    // 옛 `if (!navigator.clipboard) return` — HTTP 에서 버튼이 조용히 죽는 그 분기였다.
    const ok = await copyText(code);
    setCopied(ok ? 'ok' : 'fail');
    setTimeout(() => setCopied(null), 1500);
  };

  const lines = showLineNumbers ? code.split('\n') : [];
  const raw = (language || '').trim().toLowerCase();
  const label = LANG_LABEL[raw] ?? (raw ? raw.toUpperCase() : 'TEXT');

  return (
    <div className="my-3 rounded-xl border border-slate-200 shadow-sm overflow-hidden bg-slate-100">
      <div className="flex items-center gap-2 bg-slate-200/70 px-3 py-1.5 border-b border-slate-200">
        <span className="text-[10px] font-bold tracking-wider text-slate-500">{label}</span>
        {title && <span className="text-[12px] font-mono text-slate-500 truncate">{title}</span>}
        <button
          onClick={copy}
          className="ml-auto shrink-0 text-[11px] font-bold text-slate-500 hover:text-slate-800 px-2 py-0.5 rounded transition-colors hover:bg-slate-300/60"
        >
          {copied === 'ok' ? '복사됨' : copied === 'fail' ? '복사 실패' : '복사'}
        </button>
      </div>
      <div className="flex">
        {showLineNumbers && (
          <div className="px-3 py-3 text-[12px] font-mono text-slate-400 select-none text-right border-r border-slate-200">
            {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          </div>
        )}
        {/* hljs themes paint their own background; the wrapper already supplies it, so the code
            element stays transparent to avoid a second, slightly different panel. */}
        <pre className="flex-1 p-3 text-[13px] overflow-x-auto" style={{ margin: 0, background: 'transparent' }}>
          <code ref={ref} style={{ background: 'transparent', padding: 0 }}>{code}</code>
        </pre>
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Plug, KeyRound, CheckCircle2 } from 'lucide-react';

/** MCP 결과 접기/펼치기 컴포넌트 */
export function McpResultCollapsible({ data }: { data: any[] }) {
  const [open, setOpen] = useState(false);
  const toolLabels = data.map((d: any) => {
    const r = d.mcpResult;
    return r ? `${r.server}/${r.tool}` : 'MCP';
  }).join(', ');
  return (
    <div className="mt-2 border border-slate-700 rounded-xl overflow-hidden bg-slate-900">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-[13px] text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Plug size={13} className="text-blue-400" />
        <span className="font-medium">MCP 실행 데이터</span>
        <span className="text-slate-500 text-[12px] ml-1 truncate">{toolLabels}</span>
      </button>
      {open && (
        <pre className="px-5 pb-4 text-green-300 text-[12px] font-mono overflow-x-auto leading-relaxed border-t border-slate-800">
          {JSON.stringify(data.length === 1 ? data[0].mcpResult : data.map((d: any) => d.mcpResult), null, 2)}
        </pre>
      )}
    </div>
  );
}

/** 시크릿 입력 인라인 컴포넌트 — AI의 REQUEST_SECRET 액션 응답용 */
export function SecretInput({ name, prompt, helpUrl }: { name: string; prompt: string; helpUrl?: string }) {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSave = async () => {
    if (!value.trim()) return;
    setStatus('saving');
    try {
      const res = await fetch('/api/vault/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value: value.trim() }),
      });
      const data = await res.json();
      if (data.success) {
        setStatus('saved');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  };

  if (status === 'saved') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700 text-sm font-medium">
        <CheckCircle2 size={16} />
        <span><strong>{name}</strong> 키가 저장되었습니다.</span>
      </div>
    );
  }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-3">
      <div className="flex items-start gap-2">
        <KeyRound size={18} className="text-amber-600 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-900">
          <p className="font-medium">{prompt}</p>
          {helpUrl && (
            <a href={helpUrl} target="_blank" rel="noopener noreferrer"
              className="text-blue-600 hover:underline text-xs mt-1 inline-block">
              API 키 발급 안내 →
            </a>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSave()}
          placeholder={`${name} 입력...`}
          className="flex-1 px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
        />
        <button
          onClick={handleSave}
          disabled={!value.trim() || status === 'saving'}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-300 text-white text-sm font-bold rounded-lg transition-colors">
          {status === 'saving' ? '저장 중...' : '저장'}
        </button>
      </div>
      {status === 'error' && (
        <p className="text-xs text-red-600">저장에 실패했습니다. 다시 시도해주세요.</p>
      )}
    </div>
  );
}

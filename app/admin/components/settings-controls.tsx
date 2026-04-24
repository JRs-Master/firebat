/**
 * 설정 모달 공용 컴포넌트 세트
 *
 * SettingsModal / SystemModuleSettings 등에서 반복되는 UI 요소를 표준화.
 * 스타일 변경 시 여기 한 곳만 수정하면 전체에 반영.
 */
'use client';
import { Tooltip } from './Tooltip';

import React from 'react';

// ── Field / Section ────────────────────────────────────────────────

export function FieldLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <label className={`text-xs sm:text-sm font-bold text-slate-700 ${className}`}>{children}</label>;
}

export function HelpText({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-[10px] sm:text-xs text-slate-400 font-medium ${className}`}>{children}</p>;
}

export function Field({ label, help, children }: { label?: React.ReactNode; help?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {label && <FieldLabel>{label}</FieldLabel>}
      {children}
      {help && <HelpText>{help}</HelpText>}
    </div>
  );
}

// ── Text input / password / textarea ───────────────────────────────

type TextKind = 'text' | 'password' | 'email';

export function TextInput({
  value, onChange, placeholder, type = 'text', className = '', disabled = false,
}: { value: string; onChange: (v: string) => void; placeholder?: string; type?: TextKind; className?: string; disabled?: boolean }) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-50 ${className}`}
    />
  );
}

export function Textarea({
  value, onChange, placeholder, rows = 4, mono = false, className = '',
}: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; mono?: boolean; className?: string }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={`w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg ${mono ? 'text-[12px] font-mono' : 'text-[13px] sm:text-[14px]'} focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y ${className}`}
    />
  );
}

// ── Select ─────────────────────────────────────────────────────────

export function SelectInput<T extends string>({
  value, onChange, options, placeholder,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; placeholder?: string }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value as T)}
      className="w-full px-2.5 py-1.5 sm:px-3 sm:py-2 bg-white border border-slate-300 rounded-lg text-[13px] sm:text-[14px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ── Segmented buttons (stdio/sse, mode/provider 등) ──────────────

export function SegButtons<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-2 flex-wrap">
      {options.map(o => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`flex-1 min-w-[80px] px-3 py-1.5 text-[12px] sm:text-[13px] font-bold rounded-lg border transition-colors flex items-center justify-center gap-1.5 ${active ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-300 text-slate-400 hover:text-slate-600'}`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Toggle switch (모듈 on/off 스타일) ────────────────────────────

export function Toggle({ checked, onChange, title }: { checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <Tooltip label={title ?? (checked ? '활성' : '비활성')}>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${checked ? 'bg-blue-500' : 'bg-slate-300'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </button>
    </Tooltip>
  );
}

// ── Primary button ────────────────────────────────────────────────

export function PrimaryButton({
  onClick, disabled, children, className = '',
}: { onClick: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 text-[13px] sm:text-[14px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

// ── Section header + divider ──────────────────────────────────────

export function SectionDivider({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
      {children && <span className="text-xs sm:text-sm font-bold text-slate-700">{children}</span>}
    </div>
  );
}

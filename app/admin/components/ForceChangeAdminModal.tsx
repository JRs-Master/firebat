'use client';

/**
 * ForceChangeAdminModal — 첫 부팅 시 admin/admin 디폴트 검출 시 강제 노출.
 *
 * - 닫기 버튼 X / backdrop 클릭 X / ESC X — 변경 완료 전 어드민 사용 차단
 * - 변경 완료 시 페이지 reload (세션 쿠키 갱신)
 * - 비밀번호 일치 검증 + 최소 8자 + 디폴트 'admin' 재사용 차단
 */
import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';

interface Props {
  onChanged: () => void;
}

export function ForceChangeAdminModal({ onChanged }: Props) {
  const [newId, setNewId] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!newId.trim()) { setError('새 ID를 입력해주세요.'); return; }
    if (newId.trim() === 'admin') { setError('보안상 ID는 admin 외 다른 값으로.'); return; }
    if (newPassword.length < 8) { setError('비밀번호는 8자 이상이어야 합니다.'); return; }
    if (newPassword === 'admin') { setError('보안상 비밀번호는 admin 외 다른 값으로.'); return; }
    if (newPassword !== confirmPassword) { setError('비밀번호 확인이 일치하지 않습니다.'); return; }

    setSaving(true);
    try {
      const res = await fetch('/api/auth', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: 'admin',
          newId: newId.trim(),
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || '변경 실패');
        setSaving(false);
        return;
      }
      onChanged();
    } catch (err: any) {
      setError(err?.message || '네트워크 오류');
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      // 닫기 차단 — backdrop 클릭 무시
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl border border-amber-200 max-w-md w-full overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 헤더 — amber 톤 (경고이지만 destructive 아님) */}
        <div className="px-5 py-4 border-b border-amber-100 bg-amber-50 flex items-center gap-2">
          <ShieldAlert size={18} className="text-amber-600" />
          <h3 className="text-sm font-bold text-amber-900">초기 관리자 계정 변경 필수</h3>
        </div>

        {/* 본문 */}
        <div className="px-5 py-4 text-[13px] text-slate-700 leading-relaxed">
          <p className="mb-3">
            현재 <code className="px-1 py-0.5 bg-slate-100 rounded text-[12px] font-mono">admin / admin</code> 디폴트 계정이 박혀있습니다.
            외부 접속 가능한 환경에서 보안 위험이 큽니다 — 변경 후 어드민 사용이 가능합니다.
          </p>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-[12px] font-medium text-slate-600 mb-1">새 ID</label>
              <input
                type="text"
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                autoFocus
                disabled={saving}
                className="w-full border border-slate-300 rounded px-3 py-2 text-[13px] focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
                placeholder="예: myname"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-600 mb-1">새 비밀번호 (8자+)</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                disabled={saving}
                className="w-full border border-slate-300 rounded px-3 py-2 text-[13px] focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-slate-600 mb-1">비밀번호 확인</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={saving}
                className="w-full border border-slate-300 rounded px-3 py-2 text-[13px] focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50"
              />
            </div>
            {error && (
              <p className="text-[12px] text-red-600 font-medium">{error}</p>
            )}
            <button
              type="submit"
              disabled={saving}
              className="w-full bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold rounded-lg py-2 text-[13px] transition-colors"
            >
              {saving ? '변경 중...' : '변경하고 어드민 시작'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

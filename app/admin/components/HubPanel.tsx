'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { Bot, Plus, Trash2, Loader2 } from 'lucide-react';
import { RowActions, InteractiveRow } from './InteractiveRow';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { useTranslations } from '../../../lib/i18n';
import { logger } from '../../../lib/util/logger';
import { apiPost } from '../../../lib/api-fetch';
import type { HubInstancePb } from '../../../lib/proto-gen/firebat_pb';
import { HubInstanceDetail } from './HubInstanceDetail';

type HubApiResponse<T> = { success: boolean; data?: T; error?: string };

/**
 * HubPanel — Hub Phase 1 (2026-05-17). system service hub.
 *
 * 외부 워드프레스 사이트 연결용 챗봇 인스턴스 관리. 매 instance 별 slug, 시스템 prompt,
 * 허용 Library Reference + sysmod 영역 분리 설정.
 */
export function HubPanel() {
  const t = useTranslations();
  const [instances, setInstances] = useState<HubInstancePb[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  // instance kind — 'widget'(임베드 챗봇, 기본) | 'tenant'(풀 워크스페이스). 도구 게이트가 instance.kind 를 읽음.
  const [newKind, setNewKind] = useState<'widget' | 'tenant'>('widget');
  const [selectedInstance, setSelectedInstance] = useState<HubInstancePb | null>(null);
  const slugId = useId();
  const nameId = useId();

  const loadInstances = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiPost<HubApiResponse<HubInstancePb[]>>(
        '/api/hub/list-instances',
        {},
        { category: 'hub' },
      );
      if (res.success && res.data) setInstances(res.data ?? []);
    } catch (e) {
      logger.debug('hub', 'list_instances 실패', { error: e });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInstances();
  }, [loadInstances]);

  const handleCreate = useCallback(async () => {
    if (!newSlug.trim() || !newName.trim()) return;
    try {
      const res = await apiPost<HubApiResponse<{ id: string }>>(
        '/api/hub/create-instance',
        {
          slug: newSlug.trim(),
          name: newName.trim(),
          enabled: true,
          kind: newKind,
        },
        { category: 'hub' },
      );
      if (res.success) {
        setNewSlug('');
        setNewName('');
        setNewKind('widget');
        setCreating(false);
        await loadInstances();
      } else {
        await alertDialog({ title: '생성 실패', message: res.error ?? '오류가 발생했습니다.' });
      }
    } catch (e) {
      logger.debug('hub', 'create_instance 실패', { error: e });
    }
  }, [newSlug, newName, newKind, loadInstances]);

  const handleDelete = useCallback(async (instance: HubInstancePb) => {
    const ok = await confirmDialog({
      title: 'Hub 삭제',
      message: `"${instance.name}" (slug: ${instance.slug}) 의 모든 대화와 메시지가 같이 삭제됩니다. 진행하시겠습니까?`,
      okLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiPost<HubApiResponse<void>>(
        '/api/hub/delete-instance',
        { id: instance.id },
        { category: 'hub' },
      );
      if (res.success) await loadInstances();
    } catch (e) {
      logger.debug('hub', 'delete_instance 실패', { error: e });
    }
  }, [loadInstances]);

  // instance 선택 시 = settings 편집 화면
  if (selectedInstance) {
    return (
      <HubInstanceDetail
        instance={selectedInstance}
        onBack={() => { setSelectedInstance(null); loadInstances(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 bg-slate-50/60 shrink-0">
        <div className="flex items-center gap-1.5 text-[12px] font-bold text-slate-700">
          <Bot size={13} className="text-emerald-500" />
          Hub
          <span className="text-[11px] font-medium text-slate-400">({instances.length})</span>
        </div>
        <button
          onClick={() => setCreating(c => !c)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
        >
          <Plus size={11} /> {creating ? '취소' : '새 Hub'}
        </button>
      </div>

      {/* 새 Hub 생성 form */}
      {creating && (
        <div className="px-3 py-3 border-b border-slate-100 bg-blue-50/40 flex flex-col gap-2 shrink-0">
          <div className="flex flex-col gap-1">
            <label htmlFor={slugId} className="text-[11px] font-bold text-slate-600">slug (URL)</label>
            <input
              id={slugId}
              type="text"
              value={newSlug}
              onChange={e => setNewSlug(e.target.value.replace(/[\s/?#&=]/g, ''))}
              placeholder="영숫자 / 한글 / 하이픈 / 언더스코어"
              className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              name="newHubSlug"
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={nameId} className="text-[11px] font-bold text-slate-600">이름</label>
            <input
              id={nameId}
              type="text"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="Hub 이름"
              className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              name="newHubName"
              autoComplete="off"
            />
          </div>
          {/* 종류 — widget(임베드 챗봇) / tenant(풀 워크스페이스). 상세 화면에서도 변경 가능. */}
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-bold text-slate-600">종류</div>
            <div className="flex flex-col gap-1">
              <label className="flex items-start gap-2 text-[12px] text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="newHubKind"
                  value="widget"
                  checked={newKind === 'widget'}
                  onChange={() => setNewKind('widget')}
                  className="w-3.5 h-3.5 mt-0.5 border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div className="flex flex-col">
                  <span className="font-semibold">위젯 (임베드 챗봇)</span>
                  <span className="text-[10px] text-slate-400">익명 방문자용. 허용 자료·모듈만 노출되는 제한 세트.</span>
                </div>
              </label>
              <label className="flex items-start gap-2 text-[12px] text-slate-700 cursor-pointer">
                <input
                  type="radio"
                  name="newHubKind"
                  value="tenant"
                  checked={newKind === 'tenant'}
                  onChange={() => setNewKind('tenant')}
                  className="w-3.5 h-3.5 mt-0.5 border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <div className="flex flex-col">
                  <span className="font-semibold">테넌트 (풀 워크스페이스)</span>
                  <span className="text-[10px] text-slate-400">admin 과 같은 도구 세트 (설정 관리 제외). 실주문 등 승인 필요 액션은 계속 차단됩니다.</span>
                </div>
              </label>
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={!newSlug.trim() || !newName.trim()}
            className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300"
          >
            생성
          </button>
          <p className="text-[10px] text-slate-400">생성 후 상세 화면에서 system prompt / 허용 자료 / 허용 모듈 / 허용 도메인 설정</p>
        </div>
      )}

      {/* instance 목록 */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={18} className="animate-spin text-slate-400" />
          </div>
        ) : instances.length === 0 ? (
          <p className="text-[12px] text-slate-400 italic text-center py-8 px-3">
            Hub 가 없습니다.<br />
            "새 Hub" 버튼으로 인스턴스를 만들어주세요.
          </p>
        ) : (
          <RowActions>
            <div className="flex flex-col">
              {instances.map(inst => (
                <InteractiveRow
                  key={inst.id}
                  id={String(inst.id)}
                  kind="enter"
                  onActivate={() => setSelectedInstance(inst)}
                  rowClassName="px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 transition-colors"
                  actions={
                    <Tooltip label={t('common.delete')}>
                      <button
                        onClick={() => handleDelete(inst)}
                        className="p-1 text-slate-400 hover:text-red-600 transition-all"
                      >
                        <Trash2 size={13} />
                      </button>
                    </Tooltip>
                  }
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${inst.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className="text-[13px] font-semibold text-slate-700 truncate">{inst.name}</span>
                    {inst.kind === 'tenant' && (
                      <span className="shrink-0 px-1 py-px text-[9px] font-bold rounded bg-blue-50 border border-blue-200 text-blue-600">테넌트</span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5 font-mono">{inst.slug}</div>
                </InteractiveRow>
              ))}
            </div>
          </RowActions>
        )}
      </div>
    </div>
  );
}

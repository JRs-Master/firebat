'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { Bot, Plus, Trash2, ChevronRight, Loader2 } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog, alertDialog } from './Dialog';
import { logger } from '../../../lib/util/logger';
import { apiPost } from '../../../lib/api-fetch';
import type { ChatbotInstancePb } from '../../../lib/proto-gen/firebat_pb';
import { ChatbotInstanceDetail } from './ChatbotInstanceDetail';

type ChatbotApiResponse<T> = { success: boolean; data?: T; error?: string };

/**
 * ChatbotPanel — Chatbot Phase 1 (2026-05-17). system service chatbot.
 *
 * 외부 워드프레스 사이트 연결용 챗봇 인스턴스 관리. 매 instance 별 slug, 시스템 prompt,
 * 허용 Library Reference + sysmod 영역 분리 설정.
 */
export function ChatbotPanel() {
  const [instances, setInstances] = useState<ChatbotInstancePb[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [newName, setNewName] = useState('');
  const [selectedInstance, setSelectedInstance] = useState<ChatbotInstancePb | null>(null);
  const slugId = useId();
  const nameId = useId();

  const loadInstances = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiPost<ChatbotApiResponse<ChatbotInstancePb[]>>(
        '/api/chatbot/list-instances',
        {},
        { category: 'chatbot' },
      );
      if (res.success && res.data) setInstances(res.data ?? []);
    } catch (e) {
      logger.debug('chatbot', 'list_instances 실패', { error: e });
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
      const res = await apiPost<ChatbotApiResponse<{ id: string }>>(
        '/api/chatbot/create-instance',
        {
          slug: newSlug.trim(),
          name: newName.trim(),
          enabled: true,
        },
        { category: 'chatbot' },
      );
      if (res.success) {
        setNewSlug('');
        setNewName('');
        setCreating(false);
        await loadInstances();
      } else {
        await alertDialog({ title: '생성 실패', message: res.error ?? '오류가 발생했습니다.' });
      }
    } catch (e) {
      logger.debug('chatbot', 'create_instance 실패', { error: e });
    }
  }, [newSlug, newName, loadInstances]);

  const handleDelete = useCallback(async (instance: ChatbotInstancePb) => {
    const ok = await confirmDialog({
      title: '챗봇 삭제',
      message: `"${instance.name}" (slug: ${instance.slug}) 영역 모든 대화와 메시지가 같이 삭제됩니다. 진행하시겠습니까?`,
      okLabel: '삭제',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiPost<ChatbotApiResponse<void>>(
        '/api/chatbot/delete-instance',
        { id: instance.id },
        { category: 'chatbot' },
      );
      if (res.success) await loadInstances();
    } catch (e) {
      logger.debug('chatbot', 'delete_instance 실패', { error: e });
    }
  }, [loadInstances]);

  // instance 선택 시 = settings 편집 화면
  if (selectedInstance) {
    return (
      <ChatbotInstanceDetail
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
          Chatbot
          <span className="text-[11px] font-medium text-slate-400">({instances.length})</span>
        </div>
        <button
          onClick={() => setCreating(c => !c)}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors"
        >
          <Plus size={11} /> {creating ? '취소' : '새 챗봇'}
        </button>
      </div>

      {/* 새 챗봇 생성 form */}
      {creating && (
        <div className="px-3 py-3 border-b border-slate-100 bg-blue-50/40 flex flex-col gap-2 shrink-0">
          <div className="flex flex-col gap-1">
            <label htmlFor={slugId} className="text-[11px] font-bold text-slate-600">slug (URL)</label>
            <input
              id={slugId}
              type="text"
              value={newSlug}
              onChange={e => setNewSlug(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase())}
              placeholder="영숫자 / 하이픈 / 언더스코어"
              className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              name="newChatbotSlug"
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
              placeholder="챗봇 이름"
              className="w-full px-2 py-1.5 text-[12px] border border-slate-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
              name="newChatbotName"
              autoComplete="off"
            />
          </div>
          <button
            onClick={handleCreate}
            disabled={!newSlug.trim() || !newName.trim()}
            className="px-3 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:bg-slate-300"
          >
            생성
          </button>
          <p className="text-[10px] text-slate-400">생성 후 상세 화면에서 system prompt / 허용 자료 / 허용 모듈 / 허용 도메인 영역 설정</p>
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
            챗봇이 없습니다.<br />
            "새 챗봇" 버튼으로 인스턴스를 만들어주세요.
          </p>
        ) : (
          <div className="flex flex-col">
            {instances.map(inst => (
              <div
                key={inst.id}
                className="group flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 hover:bg-slate-50 cursor-pointer transition-colors"
                onClick={() => setSelectedInstance(inst)}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-1.5 h-1.5 rounded-full ${inst.enabled ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className="text-[13px] font-semibold text-slate-700 truncate">{inst.name}</span>
                  </div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5 font-mono">{inst.slug}</div>
                </div>
                <Tooltip label="삭제">
                  <button
                    onClick={e => { e.stopPropagation(); handleDelete(inst); }}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </Tooltip>
                <ChevronRight size={14} className="text-slate-300 group-hover:text-slate-500 transition-colors shrink-0" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

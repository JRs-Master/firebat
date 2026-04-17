'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Message, Conversation, INIT_MESSAGE, makeConv } from '../types';
import { ConversationMeta } from '../components/Sidebar';

// 저장된 대화 복원 시 진행 중 상태 정리
function cleanMessages(msgs: Message[]): Message[] {
  return msgs.map(m => m.isThinking || m.executing
    ? { ...m, isThinking: false, executing: false, content: m.content || '중단되었습니다.' }
    : m
  );
}

// SSE 이벤트 파서 — buffer에서 완성된 이벤트만 파싱, 나머지는 반환
function parseSSE(buffer: string): { events: { event: string; data: any }[]; remaining: string } {
  const events: { event: string; data: any }[] = [];
  const parts = buffer.split('\n\n');
  const remaining = parts.pop() || '';
  for (const block of parts) {
    if (!block.trim()) continue;
    const eventMatch = block.match(/^event:\s*(.+)$/m);
    const dataMatch = block.match(/^data:\s*(.+)$/m);
    if (eventMatch && dataMatch) {
      try { events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) }); } catch {}
    }
  }
  return { events, remaining };
}

export function useChat(aiModel: string, onRefresh: () => void) {
  const [messages, setMessages] = useState<Message[]>([INIT_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  // chunk-flow 애니메이션 관리 (도구 사용 흐름에서 최종 text가 흐르듯 등장)
  const chunkAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelChunkAnim = () => {
    if (chunkAnimRef.current) { clearInterval(chunkAnimRef.current); chunkAnimRef.current = null; }
  };

  // ── 초기화: 대화 목록 복원 ─────────────────────────────────────────────────
  useEffect(() => {
    const raw = localStorage.getItem('firebat_conversations');
    let convs: Conversation[] = raw ? JSON.parse(raw) : [];

    if (convs.length === 0) {
      const oldChat = localStorage.getItem('firebat_chat_history');
      if (oldChat) {
        try {
          const msgs: Message[] = JSON.parse(oldChat);
          if (msgs.length > 0) convs = [makeConv(msgs)];
        } catch {}
      }
    }

    setConversations(convs);

    if (convs.length > 0) {
      const savedActiveId = localStorage.getItem('firebat_active_conv') ?? '';
      const active = convs.find(c => c.id === savedActiveId) ?? convs[convs.length - 1];
      setActiveConvId(active.id);
      setMessages(cleanMessages(active.messages));
    }
  }, []);

  // ── 대화 저장 (메시지 변경 시) ─────────────────────────────────────────────
  useEffect(() => {
    if (!activeConvId || conversations.length === 0) return;
    setConversations(prev => {
      const firstUser = messages.find(m => m.role === 'user');
      const title = firstUser?.content
        ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
        : '새 대화';
      const updated = prev.map(c => c.id === activeConvId ? { ...c, messages, title } : c);
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      return updated;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // ── 스크롤 — 하단 근처에 있을 때만 자동 스크롤 ──────────────────────────────
  const isNearBottomRef = useRef(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // 새 메시지 추가 시에만 스크롤 (스트리밍 중 자동 스크롤 안 함 — 사용자가 직접 내려서 봄)
  const prevMsgCountRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current && isNearBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  // ── 대화 관리 ──────────────────────────────────────────────────────────────
  const handleNewConv = useCallback(() => {
    const newConv = makeConv();
    setConversations(prev => {
      const updated = [...prev, newConv];
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      return updated;
    });
    setActiveConvId(newConv.id);
    setMessages([INIT_MESSAGE]);
    localStorage.setItem('firebat_active_conv', newConv.id);
  }, []);

  const handleSelectConv = useCallback((id: string) => {
    if (id === activeConvId) return;
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setActiveConvId(id);
    setMessages(cleanMessages(conv.messages));
    localStorage.setItem('firebat_active_conv', id);
  }, [activeConvId, conversations]);

  const handleDeleteConv = useCallback((id: string) => {
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== id);
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      if (id === activeConvId) {
        if (updated.length === 0) {
          setActiveConvId('');
          setMessages([INIT_MESSAGE]);
          localStorage.removeItem('firebat_active_conv');
        } else {
          const last = updated[updated.length - 1];
          setActiveConvId(last.id);
          setMessages(last.messages);
          localStorage.setItem('firebat_active_conv', last.id);
        }
      }
      return updated;
    });
  }, [activeConvId]);

  // ── 전송 ───────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (overrideText?: string, isSuggestion?: boolean) => {
    const text = overrideText ?? input;
    if (!text.trim() || loading) return;
    const userPrompt = text;
    const imageData = attachedImage;
    setInput('');
    setAttachedImage(null);
    const id = Date.now().toString();

    if (!activeConvId) {
      const newConv = makeConv();
      setConversations(prev => {
        const updated = [...prev, newConv];
        localStorage.setItem('firebat_conversations', JSON.stringify(updated));
        return updated;
      });
      setActiveConvId(newConv.id);
      localStorage.setItem('firebat_active_conv', newConv.id);
    }

    if (!isSuggestion) {
      setMessages(prev => [...prev, { id: `u-${id}`, role: 'user', content: userPrompt, image: imageData || undefined }]);
    }
    setMessages(prev => [...prev, { id: `s-${id}`, role: 'system', isThinking: true }]);
    setLoading(true);

    try {
      const chatHistory = messages
        .filter(m => m.id !== 'system-init' && !m.isThinking)
        .map(m => {
          const role = m.role === 'system' ? 'model' : 'user';
          let content = m.content || '';
          if (m.executedActions?.length) content += `\n[이전 턴 실행 액션: ${m.executedActions.join(', ')}]`;
          if (m.data) content += `\n[이전 턴 실행 결과: ${JSON.stringify(m.data)}]`;
          return { role, content: content.trim() || JSON.stringify(m) };
        });

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userPrompt, config: { model: aiModel }, history: chatHistory, mode: 'tools', ...(imageData ? { image: imageData } : {}) }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림을 읽을 수 없습니다.');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        if (done) {
          // 스트림 종료 시 잔여 버퍼 flush (마지막 \n\n 없는 이벤트 처리)
          if (buffer.trim()) buffer += '\n\n';
        }

        const parsed = parseSSE(buffer);
        buffer = parsed.remaining;

        for (const ev of parsed.events) {
          if (ev.event === 'chunk') {
            const chunkType = ev.data.type as 'text' | 'thinking';
            const chunkContent = ev.data.content as string;
            if (chunkType === 'thinking') {
              setMessages(prev => prev.map(msg => {
                if (msg.id !== `s-${id}`) return msg;
                return { ...msg, isThinking: true, streaming: false, statusText: undefined, thinkingText: (msg.thinkingText || '') + chunkContent };
              }));
            } else {
              setMessages(prev => prev.map(msg => {
                if (msg.id !== `s-${id}`) return msg;
                return { ...msg, isThinking: false, statusText: undefined, content: (msg.content || '') + chunkContent, streaming: true };
              }));
            }
          } else if (ev.event === 'plan') {
            const needsConfirm = ev.data.actions?.some((a: any) => ['SAVE_PAGE', 'DELETE_PAGE', 'DELETE_FILE', 'SCHEDULE_TASK'].includes(a.type));
            setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? { ...msg, isThinking: !needsConfirm, thoughts: ev.data.thoughts, content: ev.data.reply, plan: ev.data, planPending: needsConfirm, suggestions: ev.data.suggestions?.length ? ev.data.suggestions : undefined }
                : msg
            ));
          } else if (ev.event === 'step') {
            const stepStart = ev.data.status === 'start';
            const stepDone = !stepStart;
            setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? { ...msg, planPending: false, executing: true, isThinking: true, streaming: false,
                    statusText: stepDone ? '결과 정리 중...' : (ev.data.description || msg.statusText),
                    steps: [...(msg.steps || []), ev.data] }
                : msg
            ));
          } else if (ev.event === 'result') {
            const pendingActions = ev.data.data?.pendingActions as { planId: string; name: string; summary: string; args?: any }[] | undefined;
            const hadExecutedActions = !!ev.data.executedActions?.length;
            const fullReply: string = ev.data.reply || (ev.data.error ? '' : '실행이 완료되었습니다.');
            const blocksData = ev.data.data?.blocks as Array<{ type: string; text?: string }> | undefined;
            const hasBlocks = Array.isArray(blocksData) && blocksData.length > 0;
            // 도구 실행이 있었던 경우만 chunk-flow — Fast Path(도구 0개)는 이미 실시간 스트리밍됐으므로 즉시 세팅
            const shouldAnimate = !!fullReply && !ev.data.error && hadExecutedActions;

            cancelChunkAnim();

            if (shouldAnimate) {
              // 최종 text block을 찾아 animatedTextIdx 결정 — 있으면 blocks 내부를 animate, 없으면 content를 animate
              const lastTextIdx = hasBlocks ? (() => {
                for (let i = blocksData!.length - 1; i >= 0; i--) if (blocksData![i].type === 'text') return i;
                return -1;
              })() : -1;
              // 초기 상태: 텍스트 빈 상태로 세팅
              setMessages(prev => prev.map(msg => {
                if (msg.id !== `s-${id}`) return msg;
                let newBlocks = blocksData;
                if (hasBlocks && lastTextIdx >= 0) {
                  newBlocks = blocksData!.map((b, i) => i === lastTextIdx ? { ...b, text: '' } : b);
                }
                return {
                  ...msg, isThinking: false, executing: false, streaming: false, statusText: undefined,
                  thinkingText: msg.thinkingText ? '답변 완료' : undefined, thoughts: ev.data.thoughts,
                  content: lastTextIdx >= 0 ? msg.content : '', // blocks 쓰면 msg.content 건들지 않음
                  executedActions: ev.data.executedActions || [],
                  data: hasBlocks ? { ...ev.data.data, blocks: newBlocks } : ev.data.data,
                  error: ev.data.error, planPending: false,
                  suggestions: ev.data.suggestions?.length ? ev.data.suggestions : undefined,
                  pendingActions: pendingActions?.map(p => ({ ...p, status: 'pending' as const })),
                };
              }));
              // 청크 단위 점진 append (50자 / 25ms → ~2000자/초)
              const CHUNK = 50;
              const TICK = 25;
              let pos = 0;
              chunkAnimRef.current = setInterval(() => {
                pos = Math.min(pos + CHUNK, fullReply.length);
                const partial = fullReply.slice(0, pos);
                setMessages(prev => prev.map(msg => {
                  if (msg.id !== `s-${id}`) return msg;
                  if (hasBlocks && lastTextIdx >= 0 && msg.data && Array.isArray((msg.data as any).blocks)) {
                    const blocks = ((msg.data as any).blocks as any[]).slice();
                    blocks[lastTextIdx] = { ...blocks[lastTextIdx], text: partial };
                    return { ...msg, data: { ...(msg.data as any), blocks } };
                  }
                  return { ...msg, content: partial };
                }));
                if (pos >= fullReply.length) cancelChunkAnim();
              }, TICK);
            } else {
              // 즉시 세팅 (Fast Path 또는 에러)
              setMessages(prev => prev.map(msg =>
                msg.id === `s-${id}`
                  ? {
                      ...msg, isThinking: false, executing: false, streaming: false, statusText: undefined,
                      thinkingText: msg.thinkingText ? '답변 완료' : undefined, thoughts: ev.data.thoughts,
                      content: fullReply || msg.content,
                      executedActions: ev.data.executedActions || [], data: ev.data.data, error: ev.data.error, planPending: false,
                      suggestions: ev.data.suggestions?.length ? ev.data.suggestions : undefined,
                      pendingActions: pendingActions?.map(p => ({ ...p, status: 'pending' as const })),
                    }
                  : msg
              ));
            }
            if (hadExecutedActions) { onRefresh(); window.dispatchEvent(new Event('firebat-refresh')); }
          } else if (ev.event === 'error') {
            cancelChunkAnim();
            setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? { ...msg, isThinking: false, executing: false, error: ev.data.error, content: msg.content || '' }
                : msg
            ));
          }
        }
        if (done) break;
      }
    } catch (err: any) {
      setMessages(prev => prev.map(msg =>
        msg.id === `s-${id}`
          ? { ...msg, isThinking: false, executing: false, streaming: false, error: err.message, content: msg.content || '서버 네트워크 연결이 끊어졌습니다.' }
          : msg
      ));
    } finally {
      // 스트림 종료 후에도 isThinking이 풀리지 않은 경우 강제 해제
      setMessages(prev => prev.map(msg =>
        msg.id === `s-${id}` && (msg.isThinking || msg.executing || msg.streaming)
          ? { ...msg, isThinking: false, executing: false, streaming: false, content: msg.content || msg.error || '응답을 받지 못했습니다.' }
          : msg
      ));
      setLoading(false);
    }
  }, [input, loading, activeConvId, messages, aiModel, onRefresh, attachedImage]);

  // Plan 실행 확인
  const handleConfirmPlan = useCallback(async (msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg?.plan) return;

    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, planPending: false, executing: true, isThinking: true, steps: [] } : m
    ));
    setLoading(true);

    try {
      const res = await fetch('/api/chat/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corrId: msg.plan.corrId, config: { model: aiModel } }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error('스트림을 읽을 수 없습니다.');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: !done });
        if (done) {
          if (buffer.trim()) buffer += '\n\n';
        }

        const parsed = parseSSE(buffer);
        buffer = parsed.remaining;

        for (const ev of parsed.events) {
          if (ev.event === 'step') {
            setMessages(prev => prev.map(m =>
              m.id === msgId ? { ...m, steps: [...(m.steps || []), ev.data] } : m
            ));
          } else if (ev.event === 'result') {
            setMessages(prev => prev.map(m =>
              m.id === msgId
                ? {
                    ...m, executing: false, isThinking: false, executedActions: ev.data.executedActions || [],
                    data: ev.data.data, error: ev.data.error, content: ev.data.reply || m.content || '실행이 완료되었습니다.',
                  }
                : m
            ));
            if (ev.data.executedActions?.length) { onRefresh(); window.dispatchEvent(new Event('firebat-refresh')); }
          }
        }
        if (done) break;
      }
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === msgId ? { ...m, executing: false, error: err.message } : m
      ));
    } finally {
      setLoading(false);
    }
  }, [messages, aiModel, onRefresh]);

  // Plan 거부
  const handleRejectPlan = useCallback((msgId: string) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId
        ? { ...m, planPending: false, content: (m.content || '') + '\n\n(사용자가 실행을 취소했습니다.)' }
        : m
    ));
  }, []);

  // Pending tool 개별 승인
  const handleApprovePending = useCallback(async (msgId: string, planId: string) => {
    try {
      const res = await fetch(`/api/plan/commit?planId=${encodeURIComponent(planId)}`, { method: 'POST' });
      const data = await res.json();
      setMessages(prev => prev.map(m => m.id !== msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p => p.planId === planId ? { ...p, status: data.success ? 'approved' : 'pending' } : p),
      }));
      if (data.success) { onRefresh(); window.dispatchEvent(new Event('firebat-refresh')); }
    } catch {}
  }, [onRefresh]);

  // Pending tool 개별 거부
  const handleRejectPending = useCallback(async (msgId: string, planId: string) => {
    try {
      await fetch(`/api/plan/reject?planId=${encodeURIComponent(planId)}`, { method: 'POST' });
      setMessages(prev => prev.map(m => m.id !== msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p => p.planId === planId ? { ...p, status: 'rejected' } : p),
      }));
    } catch {}
  }, []);

  const convMetas: ConversationMeta[] = conversations.map(({ id, title, createdAt }) => ({ id, title, createdAt }));

  return {
    messages, input, setInput, loading,
    attachedImage, setAttachedImage,
    conversations: convMetas, activeConvId,
    chatEndRef, chatContainerRef, handleScroll,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit, handleConfirmPlan, handleRejectPlan,
    handleApprovePending, handleRejectPending,
  };
}

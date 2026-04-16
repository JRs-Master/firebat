'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { flushSync } from 'react-dom';
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

  useEffect(() => {
    if (isNearBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
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
            // 스트리밍 텍스트 청크 — 타이핑 효과
            const chunkType = ev.data.type as 'text' | 'thinking';
            const chunkContent = ev.data.content as string;
            setMessages(prev => prev.map(msg => {
              if (msg.id !== `s-${id}`) return msg;
              if (chunkType === 'text') {
                return { ...msg, isThinking: false, statusText: undefined, thinkingText: undefined, content: (msg.content || '') + chunkContent, streaming: true };
              }
              // thinking 청크 — thinkingText에 누적 (statusText는 유지 — 도구 실행 중이면 설명 표시 우선)
              return { ...msg, isThinking: true, thinkingText: (msg.thinkingText || '') + chunkContent };
            }));
          } else if (ev.event === 'plan') {
            const needsConfirm = ev.data.actions?.some((a: any) => ['SAVE_PAGE', 'DELETE_PAGE', 'DELETE_FILE', 'SCHEDULE_TASK'].includes(a.type));
            flushSync(() => setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? { ...msg, isThinking: !needsConfirm, thoughts: ev.data.thoughts, content: ev.data.reply, plan: ev.data, planPending: needsConfirm, suggestions: ev.data.suggestions?.length ? ev.data.suggestions : undefined }
                : msg
            )));
          } else if (ev.event === 'step') {
            const stepDone = ev.data.status !== 'start';
            flushSync(() => setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? { ...msg, planPending: false, executing: true, isThinking: true, streaming: false,
                    // start: 도구명 표시, done/error: statusText 제거 → thinking 표시로 전환
                    statusText: stepDone ? undefined : (ev.data.description || msg.statusText),
                    steps: [...(msg.steps || []), ev.data] }
                : msg
            )));
          } else if (ev.event === 'result') {
            flushSync(() => setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? {
                    ...msg, isThinking: false, executing: false, streaming: false, statusText: undefined, thinkingText: undefined, thoughts: ev.data.thoughts,
                    content: ev.data.reply || msg.content || (ev.data.error ? '' : '실행이 완료되었습니다.'),
                    executedActions: ev.data.executedActions || [], data: ev.data.data, error: ev.data.error, planPending: false,
                    suggestions: ev.data.suggestions?.length ? ev.data.suggestions : undefined,
                  }
                : msg
            )));
            if (ev.data.executedActions?.length) { onRefresh(); window.dispatchEvent(new Event('firebat-refresh')); }
          } else if (ev.event === 'error') {
            flushSync(() => setMessages(prev => prev.map(msg =>
              msg.id === `s-${id}`
                ? { ...msg, isThinking: false, executing: false, error: ev.data.error, content: msg.content || '' }
                : msg
            )));
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
            flushSync(() => setMessages(prev => prev.map(m =>
              m.id === msgId
                ? {
                    ...m, executing: false, isThinking: false, executedActions: ev.data.executedActions || [],
                    data: ev.data.data, error: ev.data.error, content: ev.data.reply || m.content || '실행이 완료되었습니다.',
                  }
                : m
            )));
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

  const convMetas: ConversationMeta[] = conversations.map(({ id, title, createdAt }) => ({ id, title, createdAt }));

  return {
    messages, input, setInput, loading,
    attachedImage, setAttachedImage,
    conversations: convMetas, activeConvId,
    chatEndRef, chatContainerRef, handleScroll,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit, handleConfirmPlan, handleRejectPlan,
  };
}

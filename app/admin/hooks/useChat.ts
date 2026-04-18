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

export function useChat(aiModel: string, onRefresh: () => void, isDemo: boolean = false) {
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
  // 요청 중단용 AbortController — 전송 중 중지 버튼 누르면 abort
  const abortRef = useRef<AbortController | null>(null);
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ── 초기화: 대화 목록 복원 (로컬 즉시 + admin은 DB 백그라운드 동기화) ──────
  useEffect(() => {
    const raw = localStorage.getItem('firebat_conversations');
    let convs: Conversation[] = [];
    if (raw) {
      try { convs = JSON.parse(raw); }
      catch (e) {
        console.warn('[useChat] firebat_conversations 파싱 실패 — 빈 상태로 시작:', e);
        localStorage.removeItem('firebat_conversations'); // 손상된 데이터 제거
      }
    }

    if (convs.length === 0) {
      const oldChat = localStorage.getItem('firebat_chat_history');
      if (oldChat) {
        try {
          const msgs: Message[] = JSON.parse(oldChat);
          if (msgs.length > 0) convs = [makeConv(msgs)];
        } catch (e) {
          console.warn('[useChat] firebat_chat_history 파싱 실패:', e);
        }
      }
    }

    setConversations(convs);

    if (convs.length > 0) {
      const savedActiveId = localStorage.getItem('firebat_active_conv') ?? '';
      const active = convs.find(c => c.id === savedActiveId) ?? convs[convs.length - 1];
      setActiveConvId(active.id);
      setMessages(cleanMessages(active.messages));
    }

    // admin이면 DB에서 최신 대화 목록 풀 (localStorage → DB 마이그레이션 포함)
    if (isDemo) return;
    (async () => {
      try {
        const res = await fetch('/api/conversations');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success) return;
        const remote: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = data.conversations ?? [];

        // localStorage에만 있는 대화 → DB로 업로드 (1회 마이그레이션)
        const remoteIds = new Set(remote.map(r => r.id));
        for (const local of convs) {
          if (!remoteIds.has(local.id)) {
            await fetch('/api/conversations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: local.id, title: local.title, messages: local.messages, createdAt: local.createdAt }),
            }).catch(() => {});
          }
        }

        // DB 목록을 풀 로드 — 메시지 포함
        const fullList: Conversation[] = [];
        for (const r of remote) {
          const localMatch = convs.find(c => c.id === r.id);
          // 로컬이 현재 활성 대화이고 타이핑 중일 수 있으면 유지. 그 외엔 DB 버전 우선.
          // (이전: localMatch.createdAt >= r.updatedAt 비교는 필드 의미가 달라 논리 오류)
          const currentActiveId = typeof window !== 'undefined' ? localStorage.getItem('firebat_active_conv') : null;
          if (localMatch && localMatch.id === currentActiveId) {
            fullList.push(localMatch);
            continue;
          }
          try {
            const one = await fetch(`/api/conversations?id=${encodeURIComponent(r.id)}`).then(x => x.json());
            if (one.success && one.conversation) {
              fullList.push({ id: r.id, title: r.title, createdAt: r.createdAt, messages: one.conversation.messages });
            }
          } catch {}
        }
        // 로컬에만 있는 신규 대화도 합치기
        for (const local of convs) {
          if (!fullList.find(c => c.id === local.id)) fullList.push(local);
        }
        // 최신 대화가 뒤로 가도록 오름차순 정렬 (Sidebar가 배열 순서대로 렌더링)
        fullList.sort((a, b) => a.createdAt - b.createdAt);

        if (fullList.length > 0) {
          setConversations(fullList);
          localStorage.setItem('firebat_conversations', JSON.stringify(fullList));
          // 현재 활성 대화가 DB에 더 최신이면 메시지 교체
          const savedActiveId = localStorage.getItem('firebat_active_conv') ?? '';
          const activeFromRemote = fullList.find(c => c.id === savedActiveId);
          if (activeFromRemote) {
            setMessages(cleanMessages(activeFromRemote.messages));
          }
        }
      } catch {}
    })();
  }, [isDemo]);

  // ── 대화 저장 (메시지 변경 시) — localStorage 즉시 + admin이면 DB에 debounce 저장 ──
  const dbSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 타이머가 fire될 때의 컨텍스트(대화 ID)를 기억해, 저장 직전에 아직 같은 대화가 활성인지 재확인
  useEffect(() => {
    if (!activeConvId || conversations.length === 0) return;
    let titleToSave = '새 대화';
    setConversations(prev => {
      const firstUser = messages.find(m => m.role === 'user');
      const title = firstUser?.content
        ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
        : '새 대화';
      titleToSave = title;
      const updated = prev.map(c => c.id === activeConvId ? { ...c, messages, title } : c);
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      return updated;
    });

    // admin → 500ms debounce로 DB 저장
    if (!isDemo) {
      if (dbSaveTimerRef.current) clearTimeout(dbSaveTimerRef.current);
      const convMeta = conversations.find(c => c.id === activeConvId);
      const createdAt = convMeta?.createdAt ?? Date.now();
      // 클로저에 바인딩 — fire 시점에 activeConvId가 바뀌어도 이 호출은 원래 대화를 저장
      const snapshotId = activeConvId;
      const snapshotMessages = messages;
      const snapshotTitle = titleToSave;
      dbSaveTimerRef.current = setTimeout(() => {
        fetch('/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: snapshotId, title: snapshotTitle, messages: snapshotMessages, createdAt }),
        }).catch(() => {});
        dbSaveTimerRef.current = null;
      }, 500);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // 언마운트 시 debounce 타이머 정리 (누수 방지)
  useEffect(() => () => {
    if (dbSaveTimerRef.current) {
      clearTimeout(dbSaveTimerRef.current);
      dbSaveTimerRef.current = null;
    }
  }, []);

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
    // admin은 DB에서도 삭제
    if (!isDemo) {
      fetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    }
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
  }, [activeConvId, isDemo]);

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

      // 이전 응답의 responseId 찾기 — OpenAI Responses API multi-turn state (history 재전송 대체)
      const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'system' && m.data && typeof (m.data as any).responseId === 'string');
      const previousResponseId = lastAssistantMsg ? (lastAssistantMsg.data as any).responseId as string : undefined;

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          prompt: userPrompt,
          config: { model: aiModel },
          history: chatHistory,
          mode: 'tools',
          ...(imageData ? { image: imageData } : {}),
          ...(previousResponseId ? { previousResponseId } : {}),
        }),
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
            const pendingActions = ev.data.data?.pendingActions as { planId: string; name: string; summary: string; args?: any; status?: 'past-runat'; originalRunAt?: string }[] | undefined;
            const hadExecutedActions = !!ev.data.executedActions?.length;
            // 빈 응답 판정: reply 없음 + 에러 없음 + 실행된 도구도 없음 + blocks/pending도 없음 → AI가 아무것도 안 한 것
            const hasAnyOutput = !!(ev.data.executedActions?.length) || !!(ev.data.data?.blocks?.length) || !!(ev.data.data?.pendingActions?.length);
            const fullReply: string = ev.data.reply
              || (ev.data.error ? ''
                : hasAnyOutput ? '실행이 완료되었습니다.'
                : '응답을 받지 못했습니다. 다시 요청해주세요.');
            const blocksData = ev.data.data?.blocks as Array<{ type: string; text?: string }> | undefined;
            const hasBlocks = Array.isArray(blocksData) && blocksData.length > 0;
            // 스트리밍 제거 후 모든 응답이 result에 한 번에 도착 → 항상 chunk-flow 애니메이션
            const shouldAnimate = !!fullReply && !ev.data.error;

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
                  pendingActions: pendingActions?.map(p => ({ ...p, status: p.status ?? 'pending' })),
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
                      pendingActions: pendingActions?.map(p => ({ ...p, status: p.status ?? 'pending' })),
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
      cancelChunkAnim();
      const aborted = err?.name === 'AbortError';
      setMessages(prev => prev.map(msg =>
        msg.id === `s-${id}`
          ? { ...msg, isThinking: false, executing: false, streaming: false,
              error: aborted ? undefined : err.message,
              content: msg.content || (aborted ? '중단되었습니다.' : '서버 네트워크 연결이 끊어졌습니다.') }
          : msg
      ));
    } finally {
      // 스트림 종료 후에도 isThinking이 풀리지 않은 경우 강제 해제
      setMessages(prev => prev.map(msg =>
        msg.id === `s-${id}` && (msg.isThinking || msg.executing || msg.streaming)
          ? { ...msg, isThinking: false, executing: false, streaming: false, content: msg.content || msg.error || '응답을 받지 못했습니다.' }
          : msg
      ));
      abortRef.current = null;
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

  // Pending tool 개별 승인 — action: 'now'(즉시 실행) / 'reschedule'(새 시간) 지원
  const handleApprovePending = useCallback(async (msgId: string, planId: string, action?: 'now' | 'reschedule', newRunAt?: string) => {
    try {
      const qs = new URLSearchParams({ planId });
      if (action) qs.set('action', action);
      const res = await fetch(`/api/plan/commit?${qs.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newRunAt ? { runAt: newRunAt } : {}),
      });
      const data = await res.json();
      setMessages(prev => prev.map(m => m.id !== msgId ? m : {
        ...m,
        pendingActions: m.pendingActions?.map(p => {
          if (p.planId !== planId) return p;
          if (data.success) return { ...p, status: 'approved' as const, errorMessage: undefined };
          if (data.code === 'PAST_RUNAT') return { ...p, status: 'past-runat' as const, originalRunAt: data.originalRunAt };
          return { ...p, status: 'error' as const, errorMessage: data.error || '실행 실패' };
        }),
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
    handleStop,
  };
}

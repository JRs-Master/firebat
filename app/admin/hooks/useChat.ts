/**
 * useChat — Chat UI 훅 (ChatManager reducer + SettingsManager 활용)
 *
 * 상태 전이 모두 `chatReducer` 에 위임 (chat-manager.ts). 이 훅은 side effect 만 담당:
 *   - DB / localStorage 동기화
 *   - SSE /api/chat/stream 수신 → ChatAction 디스패치
 *   - AbortController / watchdog / chunk 애니메이션 ref
 *   - 스크롤 / visibilitychange / focus / pagehide
 *
 * 로봇 사라짐 버그는 reducer 의 `enforceInvariant` 가 구조적으로 차단.
 */

'use client';

import { useReducer, useState, useRef, useEffect, useCallback } from 'react';
import { Message, Conversation, INIT_MESSAGE, makeConv, PendingAction } from '../types';
import { ConversationMeta } from '../components/Sidebar';
import { chatReducer, cleanMessages, FALLBACK } from './chat-manager';
import { useSetting } from './settings-manager';
import { useWakeLock } from './use-wake-lock';

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
  const [messages, dispatch] = useReducer(chatReducer, [INIT_MESSAGE]);
  // 최신 messages ref — queueMicrotask / async 콜백에서 stale closure 회피
  const messagesRef = useRef<Message[]>([INIT_MESSAGE]);
  messagesRef.current = messages;
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  // 모바일 화면 자동 잠금 방지 — AI 응답 중 SSE 끊김 / "로봇 사라짐" 방지.
  // loading=true 동안 wake lock 유지, 끝나면 자동 해제.
  useWakeLock(loading);
  const [attachedImage, setAttachedImage] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvIdState] = useState('');
  const [planMode, setPlanMode] = useSetting('firebat_plan_mode');

  // activeConvId 는 훅 밖 useSetting 초기화 타이밍 race 가 있어 useState + 수동 동기화 유지
  const setActiveConvId = useCallback((id: string) => {
    setActiveConvIdState(id);
    if (typeof window !== 'undefined') {
      if (id) localStorage.setItem('firebat_active_conv', id);
      else localStorage.removeItem('firebat_active_conv');
    }
  }, []);

  const chatEndRef = useRef<HTMLDivElement>(null);
  // chunk-flow 애니메이션
  const chunkAnimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelChunkAnim = () => {
    if (chunkAnimRef.current) { clearInterval(chunkAnimRef.current); chunkAnimRef.current = null; }
  };
  // 요청 중단용 AbortController
  const abortRef = useRef<AbortController | null>(null);
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
  // Watchdog — N분 넘게 무응답이면 강제 터미널 + 에러 뱃지
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogOnFireRef = useRef<(() => void) | null>(null);
  const cancelWatchdog = () => {
    if (watchdogRef.current) { clearTimeout(watchdogRef.current); watchdogRef.current = null; }
    watchdogOnFireRef.current = null;
  };
  // idle timeout — SSE 이벤트가 이 시간 동안 안 오면 죽은 연결로 간주.
  // 이미지 생성은 20~30초/장, 3장이면 ~90초 → 여유롭게 120초.
  // 총 응답 시간 제한이 아니라 "조용한 시간" 제한이므로 이벤트만 꾸준히 오면 계속 연장됨.
  const WATCHDOG_IDLE_MS = 2 * 60_000;
  const resetWatchdog = () => {
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    const onFire = watchdogOnFireRef.current;
    if (!onFire) return;
    watchdogRef.current = setTimeout(onFire, WATCHDOG_IDLE_MS);
  };

  // ── 초기화: DB 우선 로드 (다기기 동기화 보장). 실패 시에만 localStorage 폴백 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const listRes = await fetch('/api/conversations');
        if (listRes.ok) {
          const listData = await listRes.json();
          if (listData.success && !cancelled) {
            const remote: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> = listData.conversations ?? [];
            remote.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));

            const savedActiveId = localStorage.getItem('firebat_active_conv') ?? '';
            const activeId = remote.find(r => r.id === savedActiveId)?.id ?? remote[0]?.id ?? '';

            let activeMessages: Message[] = [];
            if (activeId) {
              try {
                const one = await fetch(`/api/conversations?id=${encodeURIComponent(activeId)}`).then(x => x.json());
                if (one.success && one.conversation) activeMessages = one.conversation.messages ?? [];
              } catch {}
            }
            // cleanMessages 적용 후 conversations + dispatch LOAD 에 동일 값 주입.
            // 두 곳이 다른 값이면 직후 save effect 가 "바뀜" 판정해 updatedAt bump → 목록 최상단으로 올라감 (의도치 않음).
            const cleanedActive = cleanMessages(activeMessages);

            const fullList: Conversation[] = remote.map(r => ({
              id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt,
              messages: r.id === activeId ? cleanedActive : [],
            }));

            setConversations(fullList);
            localStorage.setItem('firebat_conversations', JSON.stringify(fullList));
            if (activeId) {
              setActiveConvId(activeId);
              dispatch({ type: 'LOAD', messages: cleanedActive });
            }
            return;
          }
        }
      } catch { /* DB 실패 → offline 폴백 */ }

      if (cancelled) return;
      const raw = localStorage.getItem('firebat_conversations');
      if (!raw) return;
      try {
        const convs: Conversation[] = JSON.parse(raw);
        if (convs.length === 0) return;
        setConversations(convs);
        const savedActiveId = localStorage.getItem('firebat_active_conv') ?? '';
        const mostRecent = convs.reduce((a, b) => ((b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt) ? b : a));
        const active = convs.find(c => c.id === savedActiveId) ?? mostRecent;
        setActiveConvId(active.id);
        dispatch({ type: 'LOAD', messages: cleanMessages(active.messages) });
      } catch (e) {
        console.warn('[useChat] localStorage 폴백 파싱 실패:', e);
        localStorage.removeItem('firebat_conversations');
      }
    })();
    return () => { cancelled = true; };
  }, [setActiveConvId]);

  // ── 대화 저장 — localStorage 는 messages 변경마다, DB 는 확정 시점에만 ──
  useEffect(() => {
    if (!activeConvId || conversations.length === 0) return;
    const cleanMsgs = cleanMessages(messages);
    const firstUser = cleanMsgs.find(m => m.role === 'user');
    const title = firstUser?.content
      ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
      : '새 대화';
    const now = Date.now();
    setConversations(prev => {
      const cur = prev.find(c => c.id === activeConvId);
      if (!cur) return prev;
      const prevSerialized = JSON.stringify(cur.messages ?? []);
      const newSerialized = JSON.stringify(cleanMsgs);
      const contentChanged = prevSerialized !== newSerialized;
      // 메시지·제목 모두 동일하면 early return — 불필요한 re-render + 사이드바 깜빡임 방지
      if (!contentChanged && cur.title === title) return prev;
      const updated = prev.map(c =>
        c.id === activeConvId
          ? { ...c, messages: cleanMsgs, title, ...(contentChanged ? { updatedAt: now } : {}) }
          : c,
      );
      updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      return updated;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // DB 저장 — 명시 호출. union merge 로 안전.
  const saveToDbRef = useRef<(convId: string, msgs: Message[]) => void>(() => {});
  saveToDbRef.current = (convId: string, msgs: Message[]) => {
    if (!convId) return;
    const cleanMsgs = cleanMessages(msgs);
    const firstUser = cleanMsgs.find(m => m.role === 'user');
    const title = firstUser?.content
      ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
      : '새 대화';
    const convMeta = conversations.find(c => c.id === convId);
    const createdAt = convMeta?.createdAt ?? Date.now();
    fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: convId, title, messages: cleanMsgs, createdAt }),
      keepalive: true,
    }).then(res => {
      if (res.status === 409) {
        setConversations(prev => {
          const updated = prev.filter(c => c.id !== convId);
          localStorage.setItem('firebat_conversations', JSON.stringify(updated));
          return updated;
        });
        if (activeConvId === convId) {
          setActiveConvId('');
          dispatch({ type: 'LOAD', messages: [INIT_MESSAGE] });
        }
      }
    }).catch(() => {});
  };

  // DB 재조회 — 사이드바 펼침·탭 전환·visibility change 등 여러 지점에서 호출
  const refreshConversations = useCallback(async () => {
    // 스트리밍·도구 실행 중 여부 — 이 경우 로컬 우선이지만, 모바일 백그라운드 throttling 으로
    // SSE 가 조용히 끊어진 경우 DB 쪽이 진짜 응답 보유. 아래 per-message 비교로 판단.
    const hasInflight = messagesRef.current.some(m => m.isThinking || m.executing || m.streaming);
    // 로컬 메시지에 에러·빈 응답 fallback 이 박혀있는지 — 있으면 DB 가 진짜 응답일 가능성 높음
    const hasFallback = messagesRef.current.some(m =>
      m.role === 'system' && !m.isThinking && typeof m.content === 'string'
      && (m.content === FALLBACK.EMPTY_REPLY || m.content === FALLBACK.INVISIBLE || m.content === FALLBACK.NETWORK || m.content === FALLBACK.TIMEOUT),
    );
    // 1) 대화 목록 재조회 — 타기기에서 삭제된 대화를 로컬에서도 제거
    try {
      const listRes = await fetch('/api/conversations');
      if (listRes.ok) {
        const listData = await listRes.json();
        if (listData.success && Array.isArray(listData.conversations)) {
          const remoteIds = new Set<string>(listData.conversations.map((r: { id: string }) => r.id));
          setConversations(prev => {
            const filtered = prev.filter(c => {
              if (remoteIds.has(c.id)) return true;
              if (c.id === activeConvId) return true;
              const hasRealMessages = c.messages && c.messages.some(m => m.id !== 'system-init' && m.role === 'user');
              return !hasRealMessages;
            });
            if (filtered.length === prev.length) return prev;
            localStorage.setItem('firebat_conversations', JSON.stringify(filtered));
            return filtered;
          });
        }
      }
    } catch {}
    // 2) 현재 활성 conv 단일 갱신 — 다른 기기에서 이어 쓴 메시지 반영 / 백엔드 최종 응답 복구
    if (!activeConvId) return;
    const convMeta = conversations.find(c => c.id === activeConvId);
    if (!convMeta) return;
    const localUpdatedAt = convMeta.updatedAt ?? convMeta.createdAt ?? 0;
    try {
      const res = await fetch(`/api/conversations?id=${encodeURIComponent(activeConvId)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success || !data.conversation) return;
      const remoteUpdatedAt = data.conversation.updatedAt ?? 0;
      const remoteMsgs = cleanMessages(data.conversation.messages ?? []);
      // per-message 보강 체크 — 로컬이 fallback/inflight 이고 DB 에 완료본 있으면 force LOAD
      //  - 모바일 백그라운드 throttling 으로 프론트가 에러 박제 / SSE 누락했지만 백엔드는 완주한 케이스 복구
      const shouldForceLoad = (hasInflight || hasFallback) && remoteMsgs.some(rm => {
        const local = messagesRef.current.find(lm => lm.id === rm.id);
        if (!local) return false;
        const localEmpty = !local.content?.trim() && !(local.data as any)?.blocks?.length;
        const localIsError = typeof local.content === 'string'
          && (local.content === FALLBACK.EMPTY_REPLY || local.content === FALLBACK.INVISIBLE || local.content === FALLBACK.NETWORK || local.content === FALLBACK.TIMEOUT);
        const localInflight = local.isThinking || local.executing || local.streaming;
        const remoteHasContent = (typeof rm.content === 'string' && rm.content.trim().length > 0) || ((rm.data as any)?.blocks?.length ?? 0) > 0;
        return (localEmpty || localIsError || localInflight) && remoteHasContent;
      });
      // 스트리밍 진행 중인데 DB 에 완료본이 없으면 스킵 (현재 로컬 state 보존 — LOAD 시 in-flight 메시지 유실 방지)
      if (hasInflight && !shouldForceLoad) {
        dispatch({ type: 'LOAD', messages: messagesRef.current.map(m => ({ ...m })) });
        return;
      }
      if (!shouldForceLoad && remoteUpdatedAt <= localUpdatedAt) return;
      dispatch({ type: 'LOAD', messages: remoteMsgs });
      setConversations(prev => {
        const updated = prev.map(c => c.id === activeConvId
          ? { ...c, messages: remoteMsgs, updatedAt: remoteUpdatedAt }
          : c);
        updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
        localStorage.setItem('firebat_conversations', JSON.stringify(updated));
        return updated;
      });
    } catch {}
  }, [activeConvId, conversations]);

  // visibilitychange=hidden 안전망 / visible 재조회
  useEffect(() => {
    const flush = () => {
      if (!activeConvId || messagesRef.current.length === 0) return;
      const cleanMsgs = cleanMessages(messagesRef.current);
      if (cleanMsgs.length === 0) return;
      const firstUser = cleanMsgs.find(m => m.role === 'user');
      const title = firstUser?.content
        ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
        : '새 대화';
      const convMeta = conversations.find(c => c.id === activeConvId);
      const createdAt = convMeta?.createdAt ?? Date.now();
      const body = JSON.stringify({ id: activeConvId, title, messages: cleanMsgs, createdAt });
      const blob = new Blob([body], { type: 'application/json' });
      try { navigator.sendBeacon('/api/conversations', blob); } catch {}
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else if (document.visibilityState === 'visible') void refreshConversations();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('focus', refreshConversations);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('focus', refreshConversations);
    };
  }, [activeConvId, conversations, refreshConversations]);

  // ── 스크롤 ─────────────────────────────────────────────────────────────────
  const isNearBottomRef = useRef(true);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  const handleScroll = useCallback(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

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
    dispatch({ type: 'LOAD', messages: [INIT_MESSAGE] });
  }, [setActiveConvId]);

  const handleSelectConv = useCallback((id: string) => {
    if (id === activeConvId) return;
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    setActiveConvId(id);
    dispatch({ type: 'LOAD', messages: cleanMessages(conv.messages) });

    // 다기기 동기화: 선택 시 DB 최신 버전 fetch
    const localUpdatedAt = conv.updatedAt ?? conv.createdAt ?? 0;
    const localRealMsgCount = conv.messages.filter(m => m.id !== 'system-init').length;
    (async () => {
      try {
        const res = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !data.conversation) return;
        const remoteUpdatedAt = data.conversation.updatedAt ?? 0;
        const remoteMsgs = cleanMessages(data.conversation.messages ?? []);
        const remoteRealMsgCount = remoteMsgs.filter(m => m.id !== 'system-init').length;
        const shouldUseRemote = localRealMsgCount === 0
          || remoteUpdatedAt > localUpdatedAt
          || remoteRealMsgCount > localRealMsgCount;
        if (!shouldUseRemote) return;
        dispatch({ type: 'LOAD', messages: remoteMsgs });
        setConversations(prev => {
          // 실제로 업데이트 필요한 경우만 새 array 생성 — 사이드바 재렌더 최소화
          const cur = prev.find(c => c.id === id);
          if (cur) {
            const prevSer = JSON.stringify(cur.messages ?? []);
            const newSer = JSON.stringify(remoteMsgs);
            const newUpdatedAt = Math.max(remoteUpdatedAt, localUpdatedAt);
            if (prevSer === newSer && cur.updatedAt === newUpdatedAt) return prev;
          }
          const updated = prev.map(c => c.id === id
            ? { ...c, messages: remoteMsgs, updatedAt: Math.max(remoteUpdatedAt, localUpdatedAt) }
            : c);
          updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
          localStorage.setItem('firebat_conversations', JSON.stringify(updated));
          return updated;
        });
      } catch {}
    })();
  }, [activeConvId, conversations, setActiveConvId]);

  const handleDeleteConv = useCallback((id: string) => {
    fetch(`/api/conversations?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    setConversations(prev => {
      const updated = prev.filter(c => c.id !== id);
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      if (id === activeConvId) {
        if (updated.length === 0) {
          setActiveConvId('');
          dispatch({ type: 'LOAD', messages: [INIT_MESSAGE] });
        } else {
          const last = updated[updated.length - 1];
          setActiveConvId(last.id);
          dispatch({ type: 'LOAD', messages: last.messages });
        }
      }
      return updated;
    });
  }, [activeConvId, setActiveConvId]);

  // ── 전송 ───────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async (overrideText?: string, isSuggestion?: boolean, meta?: { planExecuteId?: string; planReviseId?: string }) => {
    const text = overrideText ?? input;
    if (!text.trim() || loading) return;
    const userPrompt = text;
    const imageData = attachedImage;
    setInput('');
    setAttachedImage(null);
    const id = Date.now().toString();
    const systemId = `s-${id}`;

    if (!activeConvId) {
      const newConv = makeConv();
      setConversations(prev => {
        const updated = [...prev, newConv];
        localStorage.setItem('firebat_conversations', JSON.stringify(updated));
        return updated;
      });
      setActiveConvId(newConv.id);
    }

    if (isSuggestion) {
      dispatch({ type: 'SEND_SUGGESTION', systemId });
    } else {
      dispatch({ type: 'SEND_USER', userId: `u-${id}`, systemId, content: userPrompt, image: imageData || undefined });
    }

    // 명령 전송 직후엔 무조건 하단으로
    isNearBottomRef.current = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }));

    // 저장 시점 1: 유저 메시지 DB 즉시 반영 (다음 프레임에 최신 messages ref 로)
    const convIdForSave = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem('firebat_active_conv') : null);
    if (convIdForSave) {
      queueMicrotask(() => saveToDbRef.current(convIdForSave, messagesRef.current));
    }
    setLoading(true);

    try {
      const chatHistory = messages
        .filter(m => m.id !== 'system-init' && !m.isThinking)
        .map(m => {
          const role = m.role === 'system' ? 'model' : 'user';
          let content = (m.content || '').trim();
          if (!content && m.data && Array.isArray(m.data.blocks)) {
            const texts = m.data.blocks
              .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b: any) => b.text as string);
            content = texts.join('\n').trim();
          }
          return { role, content: content || '(빈 응답)' };
        })
        .filter(h => h.content && h.content !== '(빈 응답)');

      const previousResponseId: string | undefined = undefined;

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      cancelWatchdog();
      // onFire 핸들러 등록 — SSE 이벤트 올 때마다 resetWatchdog 가 이걸로 재스케줄
      watchdogOnFireRef.current = () => {
        ctrl.abort();
        cancelChunkAnim();
        dispatch({ type: 'TIMEOUT', id: systemId });
        setLoading(false);
      };
      resetWatchdog();

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          prompt: userPrompt,
          config: { model: aiModel },
          history: chatHistory,
          mode: 'tools',
          planMode,
          systemId, // 백엔드 주도 저장용 — 스트림 완료 시 서버가 같은 ID 로 DB 에 upsert
          userId: `u-${id}`, // 같이 저장 (user 메시지도 백엔드 저장으로 통일)
          ...(meta?.planExecuteId ? { planExecuteId: meta.planExecuteId } : {}),
          ...(meta?.planReviseId ? { planReviseId: meta.planReviseId } : {}),
          ...(activeConvId ? { conversationId: activeConvId } : {}),
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
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          // SSE chunk 도착 = 살아있음 → watchdog 재스케줄 (idle timeout 방식)
          resetWatchdog();
        }
        if (done && buffer.trim()) buffer += '\n\n';

        const parsed = parseSSE(buffer);
        buffer = parsed.remaining;

        for (const ev of parsed.events) {
          if (ev.event === 'chunk') {
            const chunkType = ev.data.type as 'text' | 'thinking';
            const chunkContent = (ev.data.content as string) ?? '';
            if (!chunkContent) continue;
            if (chunkType === 'thinking') dispatch({ type: 'CHUNK_THINKING', id: systemId, content: chunkContent });
            else dispatch({ type: 'CHUNK_TEXT', id: systemId, content: chunkContent });
          } else if (ev.event === 'step') {
            const stepStart = ev.data.status === 'start';
            dispatch({ type: 'STEP', id: systemId, step: ev.data, isLast: !stepStart });
          } else if (ev.event === 'result') {
            const pendingActions = ev.data.data?.pendingActions as PendingAction[] | undefined;
            const blocksData = ev.data.data?.blocks as Array<{ type: string; text?: string }> | undefined;
            const hasBlocks = Array.isArray(blocksData) && blocksData.length > 0;
            const hasAnyOutput = !!(ev.data.executedActions?.length) || hasBlocks || !!(pendingActions?.length);
            const fullReply: string = ev.data.reply
              || (ev.data.error ? ''
                : hasAnyOutput ? '실행이 완료되었습니다.'
                : FALLBACK.EMPTY_REPLY);
            const shouldAnimate = !!fullReply && !ev.data.error;
            const lastTextIdx = hasBlocks ? (() => {
              for (let i = blocksData!.length - 1; i >= 0; i--) if (blocksData![i].type === 'text') return i;
              return -1;
            })() : -1;

            cancelChunkAnim();

            // 기존에 RESULT 도착 후 setInterval(25ms) 로 text 를 progressive append 하던 애니메이션이 있었으나:
            //   - 백그라운드 탭 브라우저가 타이머를 1초로 throttle → 25ms 기대 tick 이 사실상 느려짐
            //   - 그 사이 FINALIZE + DB 저장이 blocks[0].text='' 상태로 박제 → 복귀 시 빈 버블
            //   - CLI 모드는 어차피 10~100초 대기 후 한 번에 도착 — "타이핑 느낌" 효과 실익도 적음
            // → 애니메이션 제거. RESULT 도착 즉시 최종 text 박음. chunk 이벤트 기반 실시간 스트리밍은 유지 (OpenAI API 등).
            dispatch({
              type: 'RESULT',
              id: systemId,
              payload: {
                reply: fullReply,
                thoughts: ev.data.thoughts,
                executedActions: ev.data.executedActions,
                data: ev.data.data,
                error: ev.data.error,
                suggestions: ev.data.suggestions,
                pendingActions,
              },
              hasAnimation: false, // 항상 full reply 즉시 세팅
              lastTextIdx,
            });
            if (ev.data.executedActions?.length) {
              onRefresh();
              window.dispatchEvent(new Event('firebat-refresh'));
            }
          } else if (ev.event === 'error') {
            cancelChunkAnim();
            dispatch({ type: 'ERROR', id: systemId, error: ev.data.error });
          }
        }
        if (done) break;
      }
    } catch (err: any) {
      cancelChunkAnim();
      cancelWatchdog();
      if (err?.name === 'AbortError') dispatch({ type: 'ABORTED', id: systemId });
      else dispatch({ type: 'NETWORK_ERROR', id: systemId, message: err.message });
    } finally {
      cancelWatchdog();
      // 스트림 종료 안전망 — 여전히 in-flight 면 reducer 의 FINALIZE + enforceInvariant 가 자동 복구
      dispatch({ type: 'FINALIZE', id: systemId });
      abortRef.current = null;
      setLoading(false);
      // 저장 시점 2: AI 응답 완료 직후 DB 반영 (최신 messages ref 로)
      const convIdForSave2 = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem('firebat_active_conv') : null);
      if (convIdForSave2) {
        queueMicrotask(() => saveToDbRef.current(convIdForSave2, messagesRef.current));
      }
    }
  }, [input, loading, activeConvId, messages, aiModel, onRefresh, attachedImage, planMode, setActiveConvId]);

  // 레거시 JSON 모드의 handleConfirmPlan / handleRejectPlan 은 v0.1, 2026-04-22 제거됨.
  // 현재는 propose_plan 도구 → PlanCard (render_* blocks) → suggestions 의 plan-confirm 버튼으로
  // handleSubmit(text, true, { planExecuteId }) 호출 — 모두 Function Calling 경로.

  // Pending tool 개별 승인
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
      if (data.success) {
        dispatch({ type: 'PENDING_APPROVED', msgId, planId });
        onRefresh();
        window.dispatchEvent(new Event('firebat-refresh'));
      } else if (data.code === 'PAST_RUNAT') {
        dispatch({ type: 'PENDING_PAST_RUNAT', msgId, planId, originalRunAt: data.originalRunAt });
      } else {
        dispatch({ type: 'PENDING_ERROR', msgId, planId, errorMessage: data.error || '실행 실패' });
      }
    } catch {}
  }, [onRefresh]);

  // Pending tool 개별 거부
  const handleRejectPending = useCallback(async (msgId: string, planId: string) => {
    try {
      await fetch(`/api/plan/reject?planId=${encodeURIComponent(planId)}`, { method: 'POST' });
      dispatch({ type: 'PENDING_REJECTED', msgId, planId });
    } catch {}
  }, []);

  const convMetas: ConversationMeta[] = conversations.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }));

  return {
    messages, input, setInput, loading,
    attachedImage, setAttachedImage,
    conversations: convMetas, activeConvId,
    chatEndRef, chatContainerRef, handleScroll,
    handleNewConv, handleSelectConv, handleDeleteConv,
    handleSubmit,
    handleApprovePending, handleRejectPending,
    handleStop,
    planMode, setPlanMode,
    refreshConversations, // 사이드바 펼침·탭 전환 등 on-demand 동기화용
  };
}

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Message, Conversation, INIT_MESSAGE, makeConv } from '../types';
import { ConversationMeta } from '../components/Sidebar';

// 저장된 대화 복원 시 진행 중 상태(좀비 메시지) 제거
// 유저가 Stop 버튼으로 중단한 메시지는 catch 블록에서 이미 content="중단되었습니다." + isThinking=false 상태로 확정됨.
// 여기서 걸리는 건 스트림이 이상하게 끊겨 복원된 미완 메시지 → 드롭해야 DB 오염 안 됨.
function cleanMessages(msgs: Message[]): Message[] {
  return msgs.filter(m => !m.isThinking && !m.executing && !m.streaming);
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
      // 폴백: 최근 활동 대화(updatedAt 최대). 정렬이 아직 안 된 상태일 수 있어 직접 reduce.
      const mostRecent = convs.reduce((a, b) => ((b.updatedAt ?? b.createdAt) > (a.updatedAt ?? a.createdAt) ? b : a));
      const active = convs.find(c => c.id === savedActiveId) ?? mostRecent;
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

        // DB 목록을 풀 로드 — 메시지 포함. 초기 로드는 DB가 authoritative.
        // (이전 로직은 activeConvId 매칭 시 무조건 로컬 → 다른 기기에서 이어 쓴 내용이
        //  PC에서 사라지던 버그. 이제는 항상 DB 버전 우선, fetch 실패 시에만 로컬 폴백.)
        const fullList: Conversation[] = [];
        for (const r of remote) {
          const localMatch = convs.find(c => c.id === r.id);
          try {
            const one = await fetch(`/api/conversations?id=${encodeURIComponent(r.id)}`).then(x => x.json());
            if (one.success && one.conversation) {
              fullList.push({ id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, messages: one.conversation.messages });
            } else if (localMatch) {
              fullList.push(localMatch);
            }
          } catch {
            if (localMatch) fullList.push(localMatch);
          }
        }
        // 로컬에만 있는 대화 처리:
        //  - 실 메시지가 있는 대화가 DB 에 없으면 = 다른 기기에서 삭제된 것 → 로컬에서도 제거
        //  - 메시지가 없거나 INIT 만 있는 신규 대화는 아직 DB 동기화 전 상태 → 로컬 유지
        for (const local of convs) {
          if (fullList.find(c => c.id === local.id)) continue;
          const hasRealMessages = local.messages && local.messages.some(m =>
            m.id !== 'system-init' && m.role === 'user'
          );
          if (!hasRealMessages) {
            // 신규 미동기화 대화 → 유지
            fullList.push(local);
          }
          // 실 메시지 있는데 DB 에 없음 → 삭제된 것으로 판단, 로컬에서도 제거 (push 안 함)
        }
        // 최신 활동 순 (updatedAt 내림차순) — Sidebar 에서 위쪽이 최신
        fullList.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));

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

  // ── 대화 저장 — localStorage는 messages 변경마다, DB는 확정 시점에만 명시 호출 ──
  // (이전 debounce 기반 → 500ms 창에 데이터 잃는 문제. 서버가 union merge 하므로 명시 호출이 안전)
  //
  // localStorage 저장: 완료된 메시지만 캐시. 스트리밍 중(isThinking/executing/streaming)은 제외해
  //   ─ 탭 닫기 / 새로고침 중 멈춘 좀비 상태를 다음 로드 때 "중단되었습니다"로 박제하는 경로를 차단.
  useEffect(() => {
    if (!activeConvId || conversations.length === 0) return;
    const cleanMsgs = messages.filter(m => !m.isThinking && !m.executing && !m.streaming);
    const firstUser = cleanMsgs.find(m => m.role === 'user');
    const title = firstUser?.content
      ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
      : '새 대화';
    const now = Date.now();
    setConversations(prev => {
      // 메시지 내용이 실제로 달라진 경우에만 updatedAt 갱신 → 대화 클릭만 해도 맨 위로 올라가던 버그 수정
      const cur = prev.find(c => c.id === activeConvId);
      const prevSerialized = JSON.stringify(cur?.messages ?? []);
      const newSerialized = JSON.stringify(cleanMsgs);
      const contentChanged = prevSerialized !== newSerialized;
      const updated = prev.map(c =>
        c.id === activeConvId
          ? { ...c, messages: cleanMsgs, title, ...(contentChanged ? { updatedAt: now } : {}) }
          : c,
      );
      // 사이드바 최신 순 유지 (UI 즉시 반영)
      updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
      localStorage.setItem('firebat_conversations', JSON.stringify(updated));
      return updated;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // DB 저장 — 명시 호출용. handleSubmit·스트림 완료·visibilitychange=hidden 3개 시점에서만.
  // 서버의 union merge 덕에 여러 번 호출해도 안전. 모바일-PC 동시 편집도 양쪽 다 보존됨.
  // 서버가 409 (deleted tombstone) 반환하면 로컬에서도 제거 — 다른 기기의 삭제를 반영.
  const saveToDbRef = useRef<(convId: string, msgs: Message[]) => void>(() => {});
  saveToDbRef.current = (convId: string, msgs: Message[]) => {
    if (isDemo || !convId) return;
    // in-progress 메시지는 DB 에 저장하지 않음 — 저장 후 세션 끊기면 "thinking" 상태가
    // 다른 기기에서 "중단되었습니다" 로 오해되어 표시되는 문제 방지
    const cleanMsgs = msgs.filter(m => !m.isThinking && !m.executing && !m.streaming);
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
      keepalive: true, // navigate 중에도 요청 유지
    }).then(res => {
      if (res.status === 409) {
        // 서버가 삭제된 대화라고 알려줌 → 로컬에서도 제거
        setConversations(prev => {
          const updated = prev.filter(c => c.id !== convId);
          localStorage.setItem('firebat_conversations', JSON.stringify(updated));
          return updated;
        });
        if (activeConvId === convId) {
          setActiveConvId('');
          setMessages([INIT_MESSAGE]);
          localStorage.removeItem('firebat_active_conv');
        }
      }
    }).catch(() => {});
  };

  // visibilitychange=hidden 안전망 — 탭 전환·앱 전환·닫기 직전 현재 상태 flush (sendBeacon)
  // visibilitychange=visible — 탭 복귀 시 다른 기기의 갱신을 반영하기 위해 active conv 재조회
  useEffect(() => {
    if (isDemo) return;
    const flush = () => {
      if (!activeConvId || messages.length === 0) return;
      // in-progress 상태는 DB 에 저장하지 않음 (타기기에서 "중단되었습니다" 로 오해되는 문제 방지)
      const cleanMsgs = messages.filter(m => !m.isThinking && !m.executing && !m.streaming);
      if (cleanMsgs.length === 0) return;
      const firstUser = cleanMsgs.find(m => m.role === 'user');
      const title = firstUser?.content
        ? firstUser.content.slice(0, 28) + (firstUser.content.length > 28 ? '…' : '')
        : '새 대화';
      const convMeta = conversations.find(c => c.id === activeConvId);
      const createdAt = convMeta?.createdAt ?? Date.now();
      const body = JSON.stringify({ id: activeConvId, title, messages: cleanMsgs, createdAt });
      // sendBeacon은 JSON body 지원 불완전 → Blob 으로 래핑
      const blob = new Blob([body], { type: 'application/json' });
      try { navigator.sendBeacon('/api/conversations', blob); } catch {}
    };
    const refresh = async () => {
      // 스트리밍·도구 실행 중이면 스킵
      if (messages.some(m => m.isThinking || m.executing || m.streaming)) return;

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
                // 활성 대화는 절대 제거 금지 — 방금 만들고 아직 DB 저장 안 된 상태거나
                // 응답 막 받고 POST 진행 중인 타이밍일 수 있음. 자동 삭제 시 화면 통째로 날아감
                if (c.id === activeConvId) return true;
                // 로컬에만 있는 비활성 대화: 실 메시지 있으면 타기기에서 삭제된 것 → 제거
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

      // 2) 현재 활성 conv 단일 갱신 — 다른 기기에서 이어 쓴 메시지 반영
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
        if (remoteUpdatedAt <= localUpdatedAt) return;
        const remoteMsgs = cleanMessages(data.conversation.messages ?? []);
        setMessages(remoteMsgs);
        setConversations(prev => {
          const updated = prev.map(c => c.id === activeConvId
            ? { ...c, messages: remoteMsgs, updatedAt: remoteUpdatedAt }
            : c);
          updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
          localStorage.setItem('firebat_conversations', JSON.stringify(updated));
          return updated;
        });
      } catch {}
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('focus', refresh);
    };
  }, [activeConvId, messages, conversations, isDemo]);

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
    // 다기기 동기화: 선택 시 DB 최신 버전이 로컬보다 최근이면 메시지 교체
    if (isDemo) return;
    const localUpdatedAt = conv.updatedAt ?? conv.createdAt ?? 0;
    (async () => {
      try {
        const res = await fetch(`/api/conversations?id=${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !data.conversation) return;
        const remoteUpdatedAt = data.conversation.updatedAt ?? 0;
        if (remoteUpdatedAt <= localUpdatedAt) return;
        const remoteMsgs = cleanMessages(data.conversation.messages ?? []);
        setMessages(remoteMsgs);
        setConversations(prev => {
          const updated = prev.map(c => c.id === id
            ? { ...c, messages: remoteMsgs, updatedAt: remoteUpdatedAt }
            : c);
          updated.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
          localStorage.setItem('firebat_conversations', JSON.stringify(updated));
          return updated;
        });
      } catch {}
    })();
  }, [activeConvId, conversations, isDemo]);

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

    // 유저 메시지 push + pending system 메시지 push (atomic)
    let msgsAfterUserPush: Message[] = [];
    setMessages(prev => {
      const next: Message[] = isSuggestion
        ? [...prev, { id: `s-${id}`, role: 'system' as const, isThinking: true }]
        : [...prev, { id: `u-${id}`, role: 'user' as const, content: userPrompt, image: imageData || undefined }, { id: `s-${id}`, role: 'system' as const, isThinking: true }];
      msgsAfterUserPush = next;
      return next;
    });
    // 저장 시점 1: 유저 메시지 DB 즉시 반영 (스트리밍 끊겨도 유저 입력은 남음)
    const convIdForSave = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem('firebat_active_conv') : null);
    if (convIdForSave) {
      // setMessages updater가 돌고 난 다음 프레임에 호출되도록 microtask 지연
      queueMicrotask(() => saveToDbRef.current(convIdForSave, msgsAfterUserPush));
    }
    setLoading(true);

    try {
      const chatHistory = messages
        .filter(m => m.id !== 'system-init' && !m.isThinking)
        .map(m => {
          const role = m.role === 'system' ? 'model' : 'user';
          // 순수 텍스트만 사용. content 비었으면 blocks에서 text 블록만 추출.
          // JSON.stringify(m) 폴백 금지 — m.data.blocks(컴포넌트 props, 분석 원문)가 통째로
          // 유입돼 AI가 이전 턴을 재현(환각) 원인이 됨.
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

      // 이전 응답의 responseId 찾기 — OpenAI Responses API multi-turn state (history 재전송 대체)
      // previousResponseId는 userd turn 간 이어받지 않음 — OpenAI 서버측 reasoning 트레이스가
      // 턴마다 누적되어 출력 토큰(과금)이 과도해지는 것을 방지. 각 user 입력마다 새 chain.
      // (같은 요청 내의 멀티턴 도구 루프는 ai-manager 내부에서 자체 관리)
      const previousResponseId: string | undefined = undefined;

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
                  thinkingText: '답변 완료', thoughts: ev.data.thoughts,
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
                      thinkingText: '답변 완료', thoughts: ev.data.thoughts,
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
                ? { ...msg, isThinking: false, executing: false, streaming: false,
                    thinkingText: '답변 완료', // 에러여도 완료 표시 유지 (로봇·글자 사라지는 문제 방지)
                    error: ev.data.error, content: msg.content || '' }
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
              thinkingText: '답변 완료',
              error: aborted ? undefined : err.message,
              content: msg.content || (aborted ? '중단되었습니다.' : '서버 네트워크 연결이 끊어졌습니다.') }
          : msg
      ));
    } finally {
      // 스트림 종료 후에도 isThinking이 풀리지 않은 경우 강제 해제
      let finalMsgs: Message[] = [];
      setMessages(prev => {
        const next = prev.map(msg =>
          msg.id === `s-${id}` && (msg.isThinking || msg.executing || msg.streaming)
            ? { ...msg, isThinking: false, executing: false, streaming: false, thinkingText: '답변 완료', content: msg.content || msg.error || '응답을 받지 못했습니다.' }
            : msg
        );
        finalMsgs = next;
        return next;
      });
      abortRef.current = null;
      setLoading(false);
      // 저장 시점 2: AI 응답 완료 직후 DB 반영
      const convIdForSave = activeConvId || (typeof window !== 'undefined' ? localStorage.getItem('firebat_active_conv') : null);
      if (convIdForSave) {
        queueMicrotask(() => saveToDbRef.current(convIdForSave, finalMsgs));
      }
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

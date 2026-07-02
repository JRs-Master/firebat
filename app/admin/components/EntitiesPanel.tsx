'use client';

/**
 * EntitiesPanel — Recall 어드민 UI (Phase 1.5 + 2.6).
 *
 * 사이드바 메모리 탭 통합 — Entity (영속 추적 대상) + Event (시간순 사건) 두 sub-tab.
 * Entity tab: list / 검색 / 추가 / 삭제 / timeline 조회.
 * Event tab: 시간순 events list, type/who 필터, click → 상세 모달.
 *
 * Phase 6 어드민 UI 전체 강화 시 entity 그래프 + episode timeline + memory health
 * dashboard 로 발전.
 */
import { useState, useEffect, useCallback, useId, useMemo } from 'react';
import { Search, Plus, Trash2, X, Clock, Tag, Activity, Network, ChevronRight } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';
import { useTranslations } from '../../../lib/i18n';
import { apiGet, apiPost, apiDelete } from '../../../lib/api-fetch';
import { hubFetch } from '../../../lib/hub-fetch';
import { RowActions, InteractiveRow } from './InteractiveRow';
import { z } from 'zod';
import { validateForm } from '../../../lib/form-validation';
import { SaveButton, type SaveButtonState } from './SaveButton';

interface Entity {
  id: number;
  name: string;
  type: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  factCount?: number;
  createdAt: number;
  updatedAt: number;
}

interface Fact {
  id: number;
  entityId: number;
  content: string;
  factType?: string;
  tags: string[];
  occurredAt?: number;
  createdAt: number;
}

interface EventItem {
  id: number;
  type: string;
  title: string;
  description?: string;
  who?: string;
  context?: Record<string, unknown>;
  occurredAt: number;
  entityIds?: number[];
}

function formatDate(ms: number | string | bigint | undefined | null): string {
  // proto i64 가 number / BigInt / string 어느 형태로 와도 안전하게 — new Date 가 Invalid 안 나게 Number 강제.
  if (ms == null) return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

interface MemoryStats {
  entities: { total: number; byType: Array<{ type: string; count: number }> };
  facts: { total: number; byType: Array<{ factType: string; count: number }> };
  events: { total: number; byType: Array<{ type: string; count: number }> };
}

export type EntitiesHubContext = { slug: string; apiToken: string; sessionId: string };

export function EntitiesPanel({
  hubContext,
}: {
  hubMode?: boolean;   // accepted for caller compat; owner is derived from hubContext (backend object).
  hubContext?: EntitiesHubContext;
} = {}) {
  const t = useTranslations();
  const entitySearchId = useId();
  const [subTab, setSubTab] = useState<'entities' | 'events'>('entities');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<Record<number, Fact[]>>({});
  const [entityEvents, setEntityEvents] = useState<Record<number, EventItem[]>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [stats, setStats] = useState<MemoryStats | null>(null);

  // owner-injected backend — admin REST(/api/entities) vs hub op-dispatch(/api/hub/<slug>/entities) 가
  // 각 메서드 *안에서만* 갈림. 패널 body 는 owner-agnostic (convBackend 패턴, test 한쪽=양쪽).
  const backend = useMemo(() => ({
    async search(q: string): Promise<Entity[]> {
      if (hubContext) {
        const d = await hubFetch(hubContext, 'entities', 'search', { query: q.trim(), limit: 100 });
        return d?.success ? (d.entities ?? []) : [];
      }
      const params = new URLSearchParams();
      if (q.trim()) params.set('query', q.trim());
      params.set('limit', '100');
      const d = await apiGet<{ success: boolean; entities?: Entity[] }>(`/api/entities?${params.toString()}`, { category: 'entities' }).catch(() => null);
      return d?.success ? (d.entities ?? []) : [];
    },
    async timeline(entityId: number): Promise<Fact[]> {
      if (hubContext) {
        const d = await hubFetch(hubContext, 'entities', 'timeline', { entityId, limit: 50 });
        return d?.success ? (d.facts ?? []) : [];
      }
      const d = await apiGet<{ success: boolean; facts?: Fact[] }>(`/api/entities/${entityId}/timeline?limit=50`, { category: 'entities' }).catch(() => null);
      return d?.success ? (d.facts ?? []) : [];
    },
    async events(entityId: number): Promise<EventItem[]> {
      if (hubContext) {
        const d = await hubFetch(hubContext, 'entities', 'events', { entityId, limit: 50 });
        return d?.success ? (d.events ?? []) : [];
      }
      const d = await apiGet<{ success: boolean; events?: EventItem[] }>(`/api/episodic?entityId=${entityId}&limit=50`, { category: 'entities' }).catch(() => null);
      return d?.success ? (d.events ?? []) : [];
    },
    async remove(entity: Entity): Promise<void> {
      if (hubContext) {
        const r = await hubFetch(hubContext, 'entities', 'delete', { id: entity.id });
        if (!r?.success) throw new Error(r?.error || 'delete 실패');
      } else {
        await apiDelete(`/api/entities/${entity.id}`, { category: 'entities' });
      }
    },
    async stats(): Promise<MemoryStats | null> {
      // Stats = owner-scoped (admin=admin / hub=session). pb returns flat counts, wrapped into {total, byType}.
      const d: { success?: boolean; entities?: number; facts?: number; events?: number } | null = hubContext
        ? await hubFetch(hubContext, 'entities', 'stats', {})
        : await apiGet<{ success: boolean; entities: number; facts: number; events: number }>('/api/memory/stats', { category: 'entities' }).catch(() => null);
      if (!d?.success) return null;
      return {
        entities: { total: d.entities ?? 0, byType: [] },
        facts: { total: d.facts ?? 0, byType: [] },
        events: { total: d.events ?? 0, byType: [] },
      };
    },
    async save(payload: { name: string; aliases?: string[] }): Promise<{ success: boolean; error?: string; created?: boolean }> {
      if (hubContext) {
        return (await hubFetch(hubContext, 'entities', 'save', payload)) ?? { success: false };
      }
      return apiPost<{ success: boolean; error?: string; created?: boolean }>('/api/entities', payload, { category: 'entities' });
    },
    async saveFact(entityId: number, payload: { content: string; factType?: string; tags?: string[] }): Promise<{ success: boolean; error?: string }> {
      if (hubContext) {
        return (await hubFetch(hubContext, 'entities', 'save-fact', { entityId, ...payload })) ?? { success: false };
      }
      return apiPost<{ success: boolean; error?: string }>(`/api/entities/${entityId}/timeline`, payload, { category: 'entities' });
    },
  }), [hubContext]);

  const fetchEntities = useCallback(async (q: string) => {
    setLoading(true);
    try {
      setEntities(await backend.search(q));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    fetchEntities('');
    backend.stats().then(s => { if (s) setStats(s); }).catch(() => {});
  }, [fetchEntities, backend]);

  // Debounced search
  useEffect(() => {
    const handle = setTimeout(() => fetchEntities(query), 250);
    return () => clearTimeout(handle);
  }, [query, fetchEntities]);

  // AI 채팅이 도구로 엔티티/사실을 저장하면 useChat 이 'firebat-refresh' 를 쏜다 → 사이드바 자동 재조회
  // (저장은 됐는데 수동 새로고침 전까지 안 뜨던 문제 차단).
  useEffect(() => {
    const onRefresh = () => fetchEntities(query);
    window.addEventListener('firebat-refresh', onRefresh);
    return () => window.removeEventListener('firebat-refresh', onRefresh);
  }, [fetchEntities, query]);

  const fetchTimeline = async (entityId: number) => {
    if (timeline[entityId]) return;
    const facts = await backend.timeline(entityId);
    setTimeline(prev => ({ ...prev, [entityId]: facts }));
  };

  const fetchEntityEvents = async (entityId: number) => {
    if (entityEvents[entityId]) return;
    const events = await backend.events(entityId); // hub: [] (no episodic endpoint)
    setEntityEvents(prev => ({ ...prev, [entityId]: events }));
  };

  const handleExpand = (id: number) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    fetchTimeline(id);
    fetchEntityEvents(id);
  };

  const handleDelete = async (entity: Entity) => {
    const ok = await confirmDialog({
      title: '엔티티 삭제',
      message: `"${entity.name}" 와 관련 fact ${entity.factCount ?? 0}개 모두 삭제됩니다. 계속하시겠습니까?`,
      okLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    try {
      await backend.remove(entity);
      setEntities(prev => prev.filter(e => e.id !== entity.id));
      setTimeline(prev => {
        const next = { ...prev };
        delete next[entity.id];
        return next;
      });
    } catch {
      // silent — UI 가 그대로 노출 (다음 fetch 에서 정정)
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Stats — 작은 dashboard (Phase 6.2) */}
      {stats && (
        <div className="grid grid-cols-3 gap-1 px-2 pt-2 pb-1.5">
          <div className="bg-blue-50 border border-blue-100 rounded px-1.5 py-1 text-center">
            <div className="text-[9px] text-blue-600 font-bold">엔티티</div>
            <div className="text-[14px] text-blue-700 font-extrabold tabular-nums">{stats.entities.total}</div>
          </div>
          <div className="bg-purple-50 border border-purple-100 rounded px-1.5 py-1 text-center">
            <div className="text-[9px] text-purple-600 font-bold">사실</div>
            <div className="text-[14px] text-purple-700 font-extrabold tabular-nums">{stats.facts.total}</div>
          </div>
          <div className="bg-amber-50 border border-amber-100 rounded px-1.5 py-1 text-center">
            <div className="text-[9px] text-amber-600 font-bold">사건</div>
            <div className="text-[14px] text-amber-700 font-extrabold tabular-nums">{stats.events.total}</div>
          </div>
        </div>
      )}

      {/* Sub-tabs — Entities / Events */}
      <div className="flex items-center px-2 pt-2 gap-1 border-b border-slate-200/80">
        <button
          onClick={() => setSubTab('entities')}
          className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-bold rounded-t-md transition-colors ${
            subTab === 'entities' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          <Network size={11} /> 엔티티
        </button>
        {/* Events (episodic) — shared by admin and hub (owner-scoped). hub isolates via events/delete-event ops. */}
        <button
          onClick={() => setSubTab('events')}
          className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-bold rounded-t-md transition-colors ${
            subTab === 'events' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'
          }`}
        >
          <Activity size={11} /> 사건
        </button>
      </div>

      {subTab === 'events' ? (
        <EventsPanel hubContext={hubContext} />
      ) : (
        <>
      {/* 헤더 — 검색 + 추가 */}
      <div className="px-2 py-2 border-b border-slate-200/80 flex items-center gap-1">
        <div className="flex-1 relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <label htmlFor={entitySearchId} className="sr-only">엔티티 검색</label>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="검색 (자연어 OK)"
            aria-label="엔티티 검색"
            className="w-full pl-6 pr-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500" name="entitySearch" autoComplete="off" id={entitySearchId}
          />
        </div>
        <Tooltip label={t('entity.add')}>
          <button
            onClick={() => setShowCreate(true)}
            className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded-md"
          >
            <Plus size={13} />
          </button>
        </Tooltip>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && entities.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400">로드 중...</p>
        ) : entities.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400 italic">
            {query ? '매칭 없음' : '등록된 엔티티 없음. + 버튼으로 추가'}
          </p>
        ) : (
          <RowActions>
          <ul className="list-none p-0 m-0">
            {entities.map(e => {
              const isExpanded = expandedId === e.id;
              const facts = timeline[e.id] ?? [];
              return (
                <li key={e.id} className="border-b border-slate-100">
                  <InteractiveRow
                    id={String(e.id)}
                    kind="expand"
                    expanded={isExpanded}
                    onActivate={() => handleExpand(e.id)}
                    rowClassName="px-2 py-1.5 hover:bg-slate-50"
                    className="flex items-center gap-2"
                    actions={
                      <Tooltip label={t('common.delete')}>
                        <button
                          onClick={() => handleDelete(e)}
                          className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                        >
                          <Trash2 size={10} />
                        </button>
                      </Tooltip>
                    }
                  >
                    <span className="text-[11px] font-bold text-slate-700 truncate">{e.name}</span>
                    {(e.factCount ?? 0) > 0 && (
                      <span className="text-[9px] text-slate-400 tabular-nums shrink-0">{e.factCount}</span>
                    )}
                  </InteractiveRow>
                  {isExpanded && (
                    <div className="px-3 py-2 bg-slate-50/50 border-t border-slate-100">
                      {e.aliases && e.aliases.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap items-center gap-1">
                          <span className="text-[9px] text-slate-500">별칭:</span>
                          {e.aliases.map((a, i) => (
                            <span key={i} className="text-[9px] px-1 py-0.5 rounded bg-white border border-slate-200 text-slate-600">{a}</span>
                          ))}
                        </div>
                      )}
                      <div className="text-[9px] text-slate-400 mb-2 flex items-center gap-2">
                        <Clock size={9} /> {formatDate(e.updatedAt)}
                      </div>
                      {/* Timeline — 사실을 type 별로 묶고 태그로 교차 필터 */}
                      <div className="text-[10px] font-bold text-slate-500 mb-1">Timeline ({facts.length})</div>
                      <EntityTimeline facts={facts} />
                      <CreateFactInline
                        entityId={e.id}
                        saveFact={backend.saveFact}
                        onCreated={async () => {
                          // refetch timeline + factCount (owner-주입 backend)
                          const facts = await backend.timeline(e.id);
                          setTimeline(prev => ({ ...prev, [e.id]: facts }));
                          fetchEntities(query);
                        }}
                      />
                      {/* Events — entity 와 link 된 사건 (Phase 6.2 entity ↔ event 시각화) */}
                      {(() => {
                        const evs = entityEvents[e.id] ?? [];
                        if (evs.length === 0) return null;
                        return (
                          <div className="mt-2 pt-2 border-t border-slate-200">
                            <div className="text-[10px] font-bold text-slate-500 mb-1">관련 사건 ({evs.length})</div>
                            <ul className="list-none p-0 m-0 space-y-1">
                              {evs.slice(0, 10).map(ev => (
                                <li key={ev.id} className="bg-amber-50/50 border border-amber-100 rounded p-1.5">
                                  <div className="flex items-center gap-1 mb-0.5">
                                    <span className="text-[8px] px-1 rounded bg-amber-100 text-amber-700 font-bold">{ev.type}</span>
                                    <span className="text-[10px] text-slate-700 font-medium truncate flex-1">{ev.title}</span>
                                  </div>
                                  <div className="text-[9px] text-slate-400 tabular-nums">
                                    {formatDate(ev.occurredAt)}
                                    {ev.who && ` · ${ev.who}`}
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          </RowActions>
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateEntityModal
          save={backend.save}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            fetchEntities(query);
          }}
        />
      )}
        </>
      )}
    </div>
  );
}

// ── Events sub-panel ──

function EventsPanel({ hubContext }: { hubContext?: EntitiesHubContext }) {
  const t = useTranslations();
  const queryId = useId();
  const typeFilterId = useId();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      // admin=/api/episodic / hub=events op (owner-scoped). Both list recent events (type/query filter).
      if (hubContext) {
        const d = await hubFetch(hubContext, 'entities', 'events', {
          type: typeFilter.trim() || undefined,
          query: query.trim() || undefined,
          limit: 100,
        });
        if (d?.success) setEvents(d.events ?? []);
        return;
      }
      const params = new URLSearchParams();
      if (typeFilter.trim()) params.set('type', typeFilter.trim());
      if (query.trim()) params.set('query', query.trim());
      params.set('limit', '100');
      const data = await apiGet<{ success: boolean; events?: EventItem[] }>(
        `/api/episodic?${params.toString()}`,
        { category: 'entities' },
      ).catch(() => null);
      if (data?.success) setEvents(data.events ?? []);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, query, hubContext]);

  useEffect(() => {
    const handle = setTimeout(fetchEvents, 250);
    return () => clearTimeout(handle);
  }, [fetchEvents]);

  const handleDelete = async (id: number) => {
    const ok = await confirmDialog({
      title: '사건 삭제',
      message: '이 사건을 삭제하시겠습니까?',
      okLabel: '삭제',
      cancelLabel: '취소',
      danger: true,
    });
    if (!ok) return;
    try {
      if (hubContext) {
        const r = await hubFetch(hubContext, 'entities', 'delete-event', { id });
        if (r?.success) setEvents(prev => prev.filter(e => e.id !== id));
        return;
      }
      await apiDelete(`/api/episodic/${id}`, { category: 'entities' });
      setEvents(prev => prev.filter(e => e.id !== id));
    } catch {
      // silent
    }
  };

  return (
    <>
      {/* Filter row */}
      <div className="px-2 py-2 border-b border-slate-200/80 flex items-center gap-1">
        <div className="flex-1 relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="검색"
            aria-label="사건 검색"
            className="w-full pl-6 pr-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500" name="query" autoComplete="off" id={queryId}
          />
        </div>
        <input
          type="text"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          placeholder="type"
          aria-label="type 필터"
          className="w-20 px-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500" name="typeFilter" autoComplete="off" id={typeFilterId}
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400">로드 중...</p>
        ) : events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400 italic">사건 없음</p>
        ) : (
          <RowActions>
          <ul className="list-none p-0 m-0">
            {events.map(e => (
              <li key={e.id} className="border-b border-slate-100">
                <InteractiveRow
                  id={String(e.id)}
                  kind="none"
                  rowClassName="px-2 py-1.5 hover:bg-slate-50"
                  actions={
                    <Tooltip label={t('common.delete')}>
                      <button
                        onClick={() => handleDelete(e.id)}
                        className="p-0.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={9} />
                      </button>
                    </Tooltip>
                  }
                >
                  <div className="flex items-center gap-1 mb-1">
                    <span className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 shrink-0 font-bold">{e.type}</span>
                    <span className="text-[10px] text-slate-700 font-medium truncate flex-1">{e.title}</span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[9px] text-slate-400">
                    <Clock size={8} />
                    <span className="tabular-nums">{formatDate(e.occurredAt)}</span>
                    {e.who && <span>· {e.who}</span>}
                    {e.entityIds && e.entityIds.length > 0 && (
                      <span>· {e.entityIds.length} entities</span>
                    )}
                  </div>
                  {e.description && (
                    <div className="text-[10px] text-slate-600 mt-0.5 line-clamp-2">{e.description}</div>
                  )}
                </InteractiveRow>
              </li>
            ))}
          </ul>
          </RowActions>
        )}
      </div>
    </>
  );
}

// 사실 타임라인 — type 별 그룹(접기/펴기) + 태그 교차 필터. 엔티티 = 정체성, 분류는 여기서.
function EntityTimeline({ facts }: { facts: Fact[] }) {
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const allTags = useMemo(() => {
    const s = new Set<string>();
    facts.forEach(f => (f.tags ?? []).forEach(t => { if (t.trim()) s.add(t); }));
    return [...s];
  }, [facts]);

  const groups = useMemo(() => {
    const shown = tagFilter ? facts.filter(f => (f.tags ?? []).includes(tagFilter)) : facts;
    const m = new Map<string, Fact[]>();
    shown.forEach(f => {
      const key = (f.factType ?? '').trim() || '기타';
      (m.get(key) ?? m.set(key, []).get(key)!).push(f);
    });
    return [...m.entries()];
  }, [facts, tagFilter]);

  if (facts.length === 0) return <p className="text-[10px] text-slate-400 italic">기록 없음</p>;

  return (
    <div>
      {allTags.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          {allTags.map(t => (
            <button
              key={t}
              onClick={() => setTagFilter(tagFilter === t ? null : t)}
              className={`inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded border ${tagFilter === t ? 'bg-blue-600 text-white border-blue-600' : 'bg-blue-50 text-blue-600 border-blue-100 hover:bg-blue-100'}`}
            >
              <Tag size={8} />{t}
            </button>
          ))}
          {tagFilter && (
            <button onClick={() => setTagFilter(null)} className="text-[9px] text-slate-400 hover:text-slate-600">필터 해제</button>
          )}
        </div>
      )}
      <div className="space-y-1">
        {groups.map(([type, fs]) => {
          const isCollapsed = collapsed.has(type);
          return (
            <div key={type}>
              <button
                onClick={() => setCollapsed(prev => { const n = new Set(prev); if (n.has(type)) n.delete(type); else n.add(type); return n; })}
                className="w-full flex items-center gap-1 text-[10px] font-bold text-slate-600 hover:text-slate-800 py-0.5"
              >
                <ChevronRight size={10} className={`transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                <span>{type}</span>
                <span className="text-[9px] text-slate-400 tabular-nums">{fs.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="list-none p-0 m-0 space-y-1 pl-3">
                  {fs.map(f => (
                    <li key={f.id} className="bg-white border border-slate-200 rounded p-1.5">
                      <div className="text-[10px] text-slate-700 leading-snug whitespace-pre-wrap break-words">{f.content}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-slate-400">
                        {(f.tags ?? []).map((tag, i) => (
                          <span key={i} className="inline-flex items-center gap-0.5 px-1 rounded bg-blue-50 text-blue-600">
                            <Tag size={8} />{tag}
                          </span>
                        ))}
                        <span className="ml-auto tabular-nums">{formatDate(f.occurredAt ?? f.createdAt)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CreateFactInline({ entityId, saveFact, onCreated }: {
  entityId: number;
  saveFact: (entityId: number, payload: { content: string; factType?: string; tags?: string[] }) => Promise<{ success: boolean; error?: string }>;
  onCreated: () => void;
}) {
  const contentId = useId();
  const factTypeId = useId();
  const tagsId = useId();
  const [content, setContent] = useState('');
  const [factType, setFactType] = useState('');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const tagList = tags.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      await saveFact(entityId, { content, factType: factType.trim() || undefined, tags: tagList.length > 0 ? tagList : undefined });
      setContent('');
      setFactType('');
      setTags('');
      onCreated();
    } catch {
      // silent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-slate-200">
      <label className="text-[10px] font-bold text-slate-500 mb-1 block" htmlFor={contentId}>+ 사실 추가</label>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        placeholder="자연어 1-2 문장 (시간·수치 명시 권장)"
        className="w-full text-[10px] px-1.5 py-1 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" name="content" autoComplete="off" id={contentId}
      />
      <div className="flex items-center gap-1 mt-1">
        <input
          type="text"
          value={factType}
          onChange={(e) => setFactType(e.target.value)}
          placeholder="type (선택)"
          aria-label="사실 type"
          className="flex-1 text-[10px] px-1.5 py-1 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="factType" autoComplete="off" id={factTypeId}
        />
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="태그 (콤마, 선택)"
          aria-label="태그"
          className="flex-1 text-[10px] px-1.5 py-1 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500" name="factTags" autoComplete="off" id={tagsId}
        />
      </div>
      <div className="flex justify-end mt-1">
        <SaveButton
          state={(submitting ? 'saving' : 'idle') as SaveButtonState}
          disabled={!content.trim()}
          onClick={submit}
        />
      </div>
    </div>
  );
}

function CreateEntityModal({ save, onClose, onCreated }: {
  save: (payload: { name: string; aliases?: string[] }) => Promise<{ success: boolean; error?: string; created?: boolean }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const nameId = useId();
  const aliasesId = useId();
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [merged, setMerged] = useState(false);

  // 엔티티 = 이름 + 별칭(정체성). 분류는 사실 type/태그에 — 만들 때 type 안 받음.
  const entitySchema = z.object({
    name: z.string().trim().min(1, '이름 필수'),
  });

  const submit = async () => {
    const parsed = validateForm(entitySchema, { name });
    if (!parsed.success) {
      setError(Object.values(parsed.errors)[0] ?? '이름 필수');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const aliasList = aliases.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      const data = await save({
        name: parsed.data.name,
        aliases: aliasList.length > 0 ? aliasList : undefined,
      });
      if (!data?.success) {
        setError(data?.error || '실패');
        return;
      }
      // created === false → 같은 이름·별칭의 엔티티가 이미 있어 그쪽에 병합됨. 직접 등록일 때만 안내(AI 경로는 무관).
      if (data.created === false) {
        setMerged(true);
        return;
      }
      onCreated();
    } catch (e: any) {
      setError(e?.message || '실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-lg shadow-xl w-full max-w-sm mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
          <h3 className="text-sm font-bold text-slate-800">엔티티 추가</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-600 rounded">
            <X size={14} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={nameId}>이름</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 회사명, 봇 v1"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              name="name" autoComplete="off" id={nameId}
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1" htmlFor={aliasesId}>별칭 (선택)</label>
            <textarea
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              rows={2}
              placeholder="줄바꿈 또는 콤마로 분리"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none" name="aliases" autoComplete="off" id={aliasesId}
            />
          </div>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          {merged ? (
            <>
              <p className="flex-1 text-[10px] text-blue-700 leading-snug">기존 항목에 합쳐졌습니다 (별칭 추가됨).</p>
              <button
                onClick={onCreated}
                className="px-3 py-1 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded shrink-0"
              >
                확인
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onClose}
                className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded"
              >
                취소
              </button>
              <SaveButton
                state={(submitting ? 'saving' : 'idle') as SaveButtonState}
                label="추가"
                disabled={!name.trim()}
                onClick={submit}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

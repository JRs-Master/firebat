'use client';

/**
 * EntitiesPanel — 메모리 시스템 어드민 UI (Phase 1.5 + 2.6).
 *
 * 사이드바 메모리 탭 통합 — Entity (영속 추적 대상) + Event (시간순 사건) 두 sub-tab.
 * Entity tab: list / 검색 / 추가 / 삭제 / timeline 조회.
 * Event tab: 시간순 events list, type/who 필터, click → 상세 모달.
 *
 * Phase 6 어드민 UI 전체 강화 시 entity 그래프 + episode timeline + memory health
 * dashboard 로 발전.
 */
import { useState, useEffect, useCallback } from 'react';
import { Search, Plus, Trash2, X, Clock, Tag, Activity, Network } from 'lucide-react';
import { Tooltip } from './Tooltip';
import { confirmDialog } from './Dialog';

interface Entity {
  id: number;
  name: string;
  type: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
  factCount?: number;
  firstSeen: number;
  lastUpdated: number;
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

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
}

interface MemoryStats {
  entities: { total: number; byType: Array<{ type: string; count: number }> };
  facts: { total: number; byType: Array<{ factType: string; count: number }> };
  events: { total: number; byType: Array<{ type: string; count: number }> };
}

export function EntitiesPanel() {
  const [subTab, setSubTab] = useState<'entities' | 'events'>('entities');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [timeline, setTimeline] = useState<Record<number, Fact[]>>({});
  const [entityEvents, setEntityEvents] = useState<Record<number, EventItem[]>>({});
  const [showCreate, setShowCreate] = useState(false);
  const [stats, setStats] = useState<MemoryStats | null>(null);

  const fetchEntities = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const url = new URL('/api/entities', window.location.origin);
      if (q.trim()) url.searchParams.set('query', q.trim());
      url.searchParams.set('limit', '100');
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) setEntities(data.entities ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEntities('');
    fetch('/api/memory/stats').then(r => r.ok ? r.json() : null).then(d => {
      if (d?.success) setStats({ entities: d.entities, facts: d.facts, events: d.events });
    }).catch(() => {});
  }, [fetchEntities]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => fetchEntities(query), 250);
    return () => clearTimeout(t);
  }, [query, fetchEntities]);

  const fetchTimeline = async (entityId: number) => {
    if (timeline[entityId]) return;
    const res = await fetch(`/api/entities/${entityId}/timeline?limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      setTimeline(prev => ({ ...prev, [entityId]: data.facts ?? [] }));
    }
  };

  const fetchEntityEvents = async (entityId: number) => {
    if (entityEvents[entityId]) return;
    const res = await fetch(`/api/episodic?entityId=${entityId}&limit=50`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      setEntityEvents(prev => ({ ...prev, [entityId]: data.events ?? [] }));
    }
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
    const res = await fetch(`/api/entities/${entity.id}`, { method: 'DELETE' });
    if (res.ok) {
      setEntities(prev => prev.filter(e => e.id !== entity.id));
      setTimeline(prev => {
        const next = { ...prev };
        delete next[entity.id];
        return next;
      });
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
        <EventsPanel />
      ) : (
        <>
      {/* 헤더 — 검색 + 추가 */}
      <div className="px-2 py-2 border-b border-slate-200/80 flex items-center gap-1">
        <div className="flex-1 relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="검색 (자연어 OK)"
            className="w-full pl-6 pr-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <Tooltip label="엔티티 추가">
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
          <ul className="list-none p-0 m-0">
            {entities.map(e => {
              const isExpanded = expandedId === e.id;
              const facts = timeline[e.id] ?? [];
              return (
                <li key={e.id} className="border-b border-slate-100">
                  <div className="flex items-center gap-1 px-2 py-1.5 hover:bg-slate-50">
                    <button
                      onClick={() => handleExpand(e.id)}
                      className="flex-1 text-left flex items-center gap-2 cursor-pointer bg-transparent border-0 p-0"
                    >
                      <span className="text-[11px] font-bold text-slate-700 truncate">{e.name}</span>
                      <span className="text-[9px] px-1 py-0.5 rounded bg-slate-100 text-slate-500 shrink-0">{e.type}</span>
                      {(e.factCount ?? 0) > 0 && (
                        <span className="text-[9px] text-slate-400 tabular-nums shrink-0">{e.factCount}</span>
                      )}
                    </button>
                    <Tooltip label="삭제">
                      <button
                        onClick={() => handleDelete(e)}
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={10} />
                      </button>
                    </Tooltip>
                  </div>
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
                        <Clock size={9} /> {formatDate(e.lastUpdated)}
                      </div>
                      {/* Timeline */}
                      <div className="text-[10px] font-bold text-slate-500 mb-1">Timeline ({facts.length})</div>
                      {facts.length === 0 ? (
                        <p className="text-[10px] text-slate-400 italic">기록 없음</p>
                      ) : (
                        <ul className="list-none p-0 m-0 space-y-1.5">
                          {facts.map(f => (
                            <li key={f.id} className="bg-white border border-slate-200 rounded p-1.5">
                              <div className="text-[10px] text-slate-700 leading-snug whitespace-pre-wrap break-words">{f.content}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-1 text-[9px] text-slate-400">
                                {f.factType && <span className="px-1 rounded bg-slate-100 text-slate-600">{f.factType}</span>}
                                {f.tags.map((t, i) => (
                                  <span key={i} className="inline-flex items-center gap-0.5 px-1 rounded bg-blue-50 text-blue-600">
                                    <Tag size={8} />{t}
                                  </span>
                                ))}
                                <span className="ml-auto tabular-nums">
                                  {formatDate(f.occurredAt ?? f.createdAt)}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      <CreateFactInline
                        entityId={e.id}
                        onCreated={async () => {
                          // refetch timeline + factCount
                          const r = await fetch(`/api/entities/${e.id}/timeline?limit=50`);
                          if (r.ok) {
                            const d = await r.json();
                            if (d.success) setTimeline(prev => ({ ...prev, [e.id]: d.facts ?? [] }));
                          }
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
        )}
      </div>

      {/* Create modal */}
      {showCreate && (
        <CreateEntityModal
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

function EventsPanel() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const url = new URL('/api/episodic', window.location.origin);
      if (typeFilter.trim()) url.searchParams.set('type', typeFilter.trim());
      if (query.trim()) url.searchParams.set('query', query.trim());
      url.searchParams.set('limit', '100');
      const res = await fetch(url.toString());
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) setEvents(data.events ?? []);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, query]);

  useEffect(() => {
    const t = setTimeout(fetchEvents, 250);
    return () => clearTimeout(t);
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
    const res = await fetch(`/api/episodic/${id}`, { method: 'DELETE' });
    if (res.ok) setEvents(prev => prev.filter(e => e.id !== id));
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
            className="w-full pl-6 pr-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <input
          type="text"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          placeholder="type"
          className="w-20 px-2 py-1.5 text-[11px] border border-slate-300 rounded-md focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading && events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400">로드 중...</p>
        ) : events.length === 0 ? (
          <p className="px-3 py-4 text-[11px] text-slate-400 italic">사건 없음</p>
        ) : (
          <ul className="list-none p-0 m-0">
            {events.map(e => (
              <li key={e.id} className="border-b border-slate-100 px-2 py-1.5 hover:bg-slate-50">
                <div className="flex items-center gap-1 mb-1">
                  <span className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-700 shrink-0 font-bold">{e.type}</span>
                  <span className="text-[10px] text-slate-700 font-medium truncate flex-1">{e.title}</span>
                  <Tooltip label="삭제">
                    <button
                      onClick={() => handleDelete(e.id)}
                      className="p-0.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 size={9} />
                    </button>
                  </Tooltip>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function CreateFactInline({ entityId, onCreated }: { entityId: number; onCreated: () => void }) {
  const [content, setContent] = useState('');
  const [factType, setFactType] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!content.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/entities/${entityId}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, factType: factType.trim() || undefined }),
      });
      if (res.ok) {
        setContent('');
        setFactType('');
        onCreated();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-2 pt-2 border-t border-slate-200">
      <div className="text-[10px] font-bold text-slate-500 mb-1">+ 사실 추가</div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        placeholder="자연어 1-2 문장 (시간·수치 명시 권장)"
        className="w-full text-[10px] px-1.5 py-1 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
      />
      <div className="flex items-center gap-1 mt-1">
        <input
          type="text"
          value={factType}
          onChange={(e) => setFactType(e.target.value)}
          placeholder="type (선택, 예: transaction)"
          className="flex-1 text-[10px] px-1.5 py-1 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button
          onClick={submit}
          disabled={!content.trim() || submitting}
          className="px-2 py-1 text-[10px] font-bold bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
        >
          저장
        </button>
      </div>
    </div>
  );
}

function CreateEntityModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('stock');
  const [aliases, setAliases] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim() || !type.trim()) {
      setError('이름과 type 필수');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const aliasList = aliases.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
      const res = await fetch('/api/entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          type: type.trim(),
          aliases: aliasList.length > 0 ? aliasList : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || '실패');
        return;
      }
      onCreated();
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
            <label className="text-[11px] font-bold text-slate-600 block mb-1">이름</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 삼성전자, 자동매매봇v1"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">Type</label>
            <input
              type="text"
              value={type}
              onChange={(e) => setType(e.target.value)}
              placeholder="stock / company / person / project / concept / event 등"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="text-[11px] font-bold text-slate-600 block mb-1">별칭 (선택)</label>
            <textarea
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              rows={2}
              placeholder="줄바꿈 또는 콤마 분리. 예: 005930, 삼전"
              className="w-full text-xs px-2 py-1.5 border border-slate-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>
          {error && <p className="text-[11px] text-red-600">{error}</p>}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-200 bg-slate-50">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-slate-600 hover:bg-slate-200 rounded"
          >
            취소
          </button>
          <button
            onClick={submit}
            disabled={submitting || !name.trim() || !type.trim()}
            className="px-3 py-1 text-xs font-bold bg-blue-500 hover:bg-blue-600 text-white rounded disabled:opacity-40 disabled:cursor-not-allowed"
          >
            추가
          </button>
        </div>
      </div>
    </div>
  );
}

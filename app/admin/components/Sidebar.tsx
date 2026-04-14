'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderTree, MessageSquare, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, Plus, Trash2, Loader2, Globe, Pencil, ExternalLink, Settings, Package, Cpu, Blocks, FileCode, Clock, Wrench, Server } from 'lucide-react';
import { FileEditor } from './FileEditor';
import { CronPanel, ScheduleModal } from './CronPanel';

interface Project { name: string; paths: string[]; pageSlugs?: string[]; }
interface PageInfo { slug: string; title: string; status: string; updatedAt: string; project?: string | null; }
interface MergedProject { name: string; paths: string[]; pages: PageInfo[]; }
interface SystemModule { name: string; description: string; runtime: string; type?: string; }

export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: number;
};

interface SidebarProps {
  onRefreshTree: () => void;
  conversations: ConversationMeta[];
  activeConvId: string;
  onSelectConv: (id: string) => void;
  onNewConv: () => void;
  onDeleteConv: (id: string) => void;
  isDemo?: boolean;
  onOpenSettings?: () => void;
  onEditFile?: (filePath: string) => void;
  onOpenModuleSettings?: (moduleName: string) => void;
}

export function Sidebar({
  onRefreshTree,
  conversations, activeConvId,
  onSelectConv, onNewConv, onDeleteConv,
  isDemo, onOpenSettings, onEditFile, onOpenModuleSettings,
}: SidebarProps) {
  const [tab, setTab] = useState<'workspace' | 'chats'>('workspace');
  const [collapsed, setCollapsed] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const checkMobile = () => window.innerWidth < 768;
    setCollapsed(checkMobile());
    setIsMobile(checkMobile());
    const handler = () => { setCollapsed(checkMobile()); setIsMobile(checkMobile()); };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // ── 시스템 모듈 ──
  const [sysModules, setSysModules] = useState<SystemModule[]>([]);
  const fetchSysModules = useCallback(async () => {
    try {
      const res = await fetch('/api/fs/system-modules');
      const data = await res.json();
      if (data.success) setSysModules(data.modules ?? []);
    } catch {}
  }, []);

  // ── 프로젝트 & 페이지 ──
  const [projects, setProjects] = useState<Project[]>([]);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);
  const [editingPageSlug, setEditingPageSlug] = useState<string | null>(null);
  // 스케줄 모달용 상태
  const [schedulingModule, setSchedulingModule] = useState<{ jobId: string; targetPath: string; pageSlugs?: string[] } | null>(null);
  // 모듈 경로 → 엔트리 파일명 캐시 (예: "user/modules/weather" → "main.py")
  const [moduleEntries, setModuleEntries] = useState<Record<string, string>>({});

  const ENTRY_FILES = ['main.py', 'index.js', 'index.mjs', 'main.php', 'main.sh'];

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/fs/projects');
      const data = await res.json();
      if (data.success) {
        setProjects(data.projects);
        // 각 모듈의 엔트리 파일 탐색
        const allPaths = (data.projects as Project[]).flatMap(p => p.paths);
        const entries: Record<string, string> = {};
        await Promise.all(allPaths.map(async (p) => {
          try {
            const treeRes = await fetch(`/api/fs/tree?root=${encodeURIComponent(p)}`);
            const treeData = await treeRes.json();
            const files: string[] = [];
            if (treeData.success && treeData.tree?.[0]?.children) {
              for (const n of treeData.tree[0].children) {
                if (!n.isDirectory) files.push(n.name);
              }
            }
            const entry = ENTRY_FILES.find(e => files.includes(e));
            entries[p] = entry || files.find(f => f !== 'config.json') || 'config.json';
          } catch {}
        }));
        setModuleEntries(entries);
      }
    } catch {}
  }, []);

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [deletingPage, setDeletingPage] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  const fetchPages = useCallback(async () => {
    try {
      const res = await fetch('/api/pages');
      const data = await res.json();
      if (data.success) setPages(data.pages ?? []);
    } catch {}
  }, []);

  const refreshAllRef = useRef(() => {});
  const refreshAll = useCallback(() => {
    fetchSysModules();
    fetchProjects();
    fetchPages();
  }, [fetchSysModules, fetchProjects, fetchPages]);
  refreshAllRef.current = refreshAll;

  // 최초 workspace 탭 진입 시 1회 로드
  const initialLoaded = useRef(false);
  useEffect(() => {
    if (tab === 'workspace' && !initialLoaded.current) {
      initialLoaded.current = true;
      refreshAll();
    }
  }, [tab, refreshAll]);

  // AI 액션 완료 시 자동 갱신 (ref로 안정 참조)
  useEffect(() => {
    const handler = () => refreshAllRef.current();
    window.addEventListener('firebat-refresh', handler);
    return () => window.removeEventListener('firebat-refresh', handler);
  }, []);

  // SSE 실시간 이벤트 — Core가 보내는 sidebar:refresh 수신
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/events');
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'sidebar:refresh') {
            refreshAllRef.current();
          }
        } catch {}
      };
    } catch {}
    return () => { es?.close(); };
  }, []);

  // 모듈 엔트리 파일 열기 (캐시된 엔트리 정보 활용)
  const handleOpenModule = (modulePath: string) => {
    if (!onEditFile) return;
    const entry = moduleEntries[modulePath] || 'main.py';
    onEditFile(`${modulePath}/${entry}`);
  };

  const handleDeleteModule = async (modulePath: string) => {
    const name = modulePath.replace(/^user\/modules\//, '');
    if (!confirm(`모듈 "${name}" 폴더 전체를 삭제하시겠습니까?`)) return;
    try {
      await fetch(`/api/fs?path=${encodeURIComponent(modulePath)}`, { method: 'DELETE' });
      onRefreshTree();
      refreshAll();
    } catch {}
  };

  const handleDeleteProject = async (name: string) => {
    if (!confirm(`프로젝트 "${name}"의 모든 파일을 삭제하시겠습니까?\n관련 페이지와 모듈이 모두 삭제됩니다.`)) return;
    setDeletingProject(name);
    try {
      await fetch(`/api/fs/projects?project=${encodeURIComponent(name)}`, { method: 'DELETE' });
      onRefreshTree();
      refreshAll();
    } finally {
      setDeletingProject(null);
    }
  };

  const handleDeletePage = async (slug: string) => {
    if (!confirm(`페이지 "${slug}"을(를) 삭제하시겠습니까?`)) return;
    setDeletingPage(slug);
    try {
      await fetch(`/api/pages?slug=${encodeURIComponent(slug)}`, { method: 'DELETE' });
      fetchPages();
    } finally {
      setDeletingPage(null);
    }
  };

  const handleEditPage = (slug: string) => {
    setEditingPageSlug(slug);
  };

  const toggleProject = (name: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  // ── 프로젝트 + 페이지 통합 목록 ──
  const mergedProjects: MergedProject[] = (() => {
    const map = new Map<string, MergedProject>();
    for (const p of projects) {
      map.set(p.name, { name: p.name, paths: p.paths, pages: [] });
    }
    const orphanPages: PageInfo[] = [];
    for (const pg of pages) {
      if (pg.project && map.has(pg.project)) {
        map.get(pg.project)!.pages.push(pg);
      } else if (pg.project) {
        if (!map.has(pg.project)) map.set(pg.project, { name: pg.project, paths: [], pages: [] });
        map.get(pg.project)!.pages.push(pg);
      } else {
        orphanPages.push(pg);
      }
    }
    const result = Array.from(map.values());
    for (const pg of orphanPages) {
      result.push({ name: pg.slug, paths: [], pages: [pg] });
    }
    return result;
  })();

  // ── 모바일 body 스크롤 방지 ──
  useEffect(() => {
    if (isMobile && !collapsed) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [isMobile, collapsed]);

  const expand = (t: 'workspace' | 'chats') => {
    setTab(t);
    setCollapsed(false);
  };

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
    if (diffDays === 0) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return '어제';
    if (diffDays < 7) return `${diffDays}일 전`;
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  };

  /* ── 아이콘만 보이는 접힌 모드 ── */
  if (collapsed) {
    return (
      <>
      <div className="w-12 border-r border-slate-200 bg-white flex flex-col items-center py-3 gap-3 shrink-0 z-20 shadow-lg">
        <button
          onClick={() => expand('workspace')}
          className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
          title="Workspace"
        >
          <FolderTree size={18} />
        </button>
        <button
          onClick={() => expand('chats')}
          className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors relative"
          title="대화 목록"
        >
          <MessageSquare size={18} />
          {conversations.length > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-blue-500 text-white text-[8px] font-black rounded-full flex items-center justify-center">
              {Math.min(conversations.length, 9)}
            </span>
          )}
        </button>
        <div className="flex-1" />
        {!isDemo && onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
            title="설정"
          >
            <Settings size={18} />
          </button>
        )}
        <button
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-lg text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors"
          title="사이드바 열기"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </>
    );
  }

  /* ── 펼쳐진 모드 ── */
  return (
    <>
    {/* 모바일 backdrop */}
    {isMobile && (
      <div
        className="fixed top-[3.5rem] inset-x-0 bottom-0 bg-black/30 z-10 md:hidden touch-none"
        onClick={() => setCollapsed(true)}
      />
    )}
    <div className={`${isMobile ? 'fixed top-[3.5rem] left-0 bottom-0 z-20' : 'relative'} w-72 border-r border-slate-200 bg-white flex flex-col shrink-0 shadow-lg overscroll-contain`}>

      {/* 탭 헤더 */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-slate-200/80">
        <button
          onClick={() => setTab('workspace')}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-extrabold tracking-widest transition-colors ${
            tab === 'workspace' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
          }`}
        >
          <FolderTree size={12} /> WORKSPACE
        </button>
        <button
          onClick={() => setTab('chats')}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-extrabold tracking-widest transition-colors ${
            tab === 'chats' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
          }`}
        >
          <MessageSquare size={12} /> CHATS
        </button>
        <div className="flex-1" />
        {tab === 'workspace' && (
          <button
            onClick={refreshAll}
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-md transition-colors"
            title="새로고침"
          >
            <RefreshCw size={13} />
          </button>
        )}
        <button
          onClick={() => setCollapsed(true)}
          className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
          title="사이드바 접기"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      {/* 패널 컨텐츠 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === 'workspace' ? (
          <div className="flex flex-col h-full overflow-y-auto overscroll-contain">

            {/* ── SYSTEM 섹션 ── */}
            <div className="shrink-0">
              <div className="px-3 py-2 text-[10px] font-extrabold tracking-widest text-slate-400 flex items-center gap-1.5">
                <Cpu size={11} /> SYSTEM
              </div>

              {/* 서비스 */}
              {sysModules.filter(m => m.type === 'service').length > 0 && (
                <div className="pb-1 px-2">
                  <p className="px-2 pb-1 text-[9px] font-bold tracking-wider text-slate-300 uppercase flex items-center gap-1"><Wrench size={9} /> 서비스</p>
                  <div className="space-y-0.5">
                    {sysModules.filter(m => m.type === 'service').map(m => {
                      const sysSelected = selectedItem === `sys:${m.name}`;
                      return (
                      <div
                        key={m.name}
                        className={`group flex items-start gap-2 px-2 py-1.5 rounded-lg text-slate-600 transition-colors ${
                          isMobile ? 'cursor-pointer' : ''
                        } ${
                          sysSelected ? 'bg-blue-50 border border-blue-100' : 'hover:bg-slate-100 border border-transparent'
                        }`}
                        onClick={() => {
                          if (isMobile) {
                            setSelectedItem(sysSelected ? null : `sys:${m.name}`);
                          }
                        }}
                      >
                        <Server size={12} className="text-emerald-400 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-semibold text-slate-700 truncate">{m.name}</p>
                          <p className="text-[10px] text-slate-400 leading-tight truncate">{m.description}</p>
                        </div>
                        <span className={`flex items-center shrink-0 mt-0.5 transition-opacity ${
                          isMobile ? (sysSelected ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                        }`}>
                          <button
                            onClick={(e) => { e.stopPropagation(); onOpenModuleSettings?.(m.name); setSelectedItem(null); }}
                            className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                            title="설정"
                          >
                            <Settings size={12} />
                          </button>
                        </span>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 모듈 */}
              {sysModules.filter(m => m.type !== 'service').length > 0 && (
                <div className="pb-2 px-2">
                  <p className="px-2 pb-1 text-[9px] font-bold tracking-wider text-slate-300 uppercase flex items-center gap-1"><Blocks size={9} /> 모듈</p>
                  <div className="space-y-0.5">
                    {sysModules.filter(m => m.type !== 'service').map(m => {
                      const sysSelected = selectedItem === `sys:${m.name}`;
                      return (
                      <div
                        key={m.name}
                        className={`group flex items-start gap-2 px-2 py-1.5 rounded-lg text-slate-600 transition-colors ${
                          isMobile ? 'cursor-pointer' : ''
                        } ${
                          sysSelected ? 'bg-blue-50 border border-blue-100' : 'hover:bg-slate-100 border border-transparent'
                        }`}
                        onClick={() => {
                          if (isMobile) {
                            setSelectedItem(sysSelected ? null : `sys:${m.name}`);
                          }
                        }}
                      >
                        <Blocks size={12} className="text-indigo-400 shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] font-semibold text-slate-700 truncate">{m.name}</p>
                          <p className="text-[10px] text-slate-400 leading-tight truncate">{m.description}</p>
                        </div>
                        <span className={`flex items-center shrink-0 mt-0.5 transition-opacity ${
                          isMobile ? (sysSelected ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                        }`}>
                          <button
                            onClick={(e) => { e.stopPropagation(); onOpenModuleSettings?.(m.name); setSelectedItem(null); }}
                            className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                            title="설정"
                          >
                            <Settings size={12} />
                          </button>
                        </span>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {sysModules.length === 0 && (
                <p className="px-3 pb-2 text-[11px] text-slate-400 italic">항목 없음</p>
              )}
            </div>

            {/* ── CRON JOBS 섹션 ── */}
            <CronPanel />

            {/* ── PROJECTS 섹션 ── */}
            <div className="border-t border-slate-200/80 flex-shrink-0">
              <div className="px-3 py-2 text-[10px] font-extrabold tracking-widest text-slate-400 flex items-center gap-1.5">
                <Package size={11} /> PROJECTS
              </div>
              {mergedProjects.length === 0 ? (
                <p className="px-3 pb-2 text-[11px] text-slate-400 italic">프로젝트 없음</p>
              ) : (
                <div className="pb-2 space-y-0.5 px-2">
                  {mergedProjects.map(mp => {
                    const isSingle = mp.pages.length <= 1 && mp.paths.length === 0;
                    const isExpanded = expandedProjects.has(mp.name);
                    const isSelected = selectedItem === `proj:${mp.name}`;
                    const mainSlug = mp.pages[0]?.slug;

                    return (
                      <div key={mp.name}>
                        {/* 프로젝트 헤더 */}
                        <div
                          className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                            isSelected ? 'bg-blue-50 border border-blue-100' : 'hover:bg-slate-100 border border-transparent'
                          }`}
                          onClick={() => {
                            if (isMobile) {
                              setSelectedItem(isSelected ? null : `proj:${mp.name}`);
                            } else if (!isSingle) {
                              toggleProject(mp.name);
                            }
                          }}
                        >
                          {!isSingle ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleProject(mp.name); }}
                              className="p-0.5 text-slate-400 shrink-0"
                            >
                              {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </button>
                          ) : (
                            <Globe size={12} className="text-blue-500 shrink-0" />
                          )}

                          <span className="flex-1 text-[12px] font-semibold text-slate-700 truncate" title={mp.name}>
                            {isSingle ? (mainSlug ?? mp.name) : mp.name}
                          </span>

                          {/* 액션 아이콘: PC=호버, 모바일=선택 시 표시 */}
                          <span className={`flex items-center gap-0.5 shrink-0 justify-end transition-opacity ${
                            isMobile ? (isSelected ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                          }`}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                let target = '';
                                if (mp.paths.length > 0) {
                                  const modPath = mp.paths[0];
                                  const entry = moduleEntries[modPath] || 'main.py';
                                  target = `${modPath}/${entry}`;
                                }
                                setSchedulingModule({ jobId: mp.name, targetPath: target, pageSlugs: mp.pages.map(p => p.slug) });
                                setSelectedItem(null);
                              }}
                              className="p-1 rounded text-slate-400 hover:text-amber-500 hover:bg-amber-50 active:bg-amber-100 transition-colors"
                              title="스케줄"
                            >
                              <Clock size={11} />
                            </button>
                            {mainSlug && (
                              <button
                                onClick={(e) => { e.stopPropagation(); window.open(`/${mainSlug}`, '_blank'); setSelectedItem(null); }}
                                className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                title="열기"
                              >
                                <ExternalLink size={11} />
                              </button>
                            )}
                            {!isMobile && isSingle && mainSlug && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleEditPage(mainSlug); setSelectedItem(null); }}
                                className="p-1 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 active:bg-amber-100 transition-colors"
                                title="편집"
                              >
                                <Pencil size={11} />
                              </button>
                            )}
                            {isSingle && mainSlug ? (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeletePage(mainSlug); setSelectedItem(null); }}
                                disabled={deletingPage === mainSlug}
                                className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors disabled:opacity-40"
                                title="삭제"
                              >
                                {deletingPage === mainSlug ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                              </button>
                            ) : (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteProject(mp.name); setSelectedItem(null); }}
                                disabled={deletingProject === mp.name}
                                className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors disabled:opacity-40"
                                title="프로젝트 삭제"
                              >
                                {deletingProject === mp.name ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                              </button>
                            )}
                          </span>
                        </div>

                        {/* 하위 페이지 목록 */}
                        {!isSingle && isExpanded && (
                          <div className="ml-4 pl-2 border-l border-slate-200 mt-0.5 space-y-0.5">
                            {mp.pages.map(pg => {
                              const pgSelected = selectedItem === `page:${pg.slug}`;
                              return (
                                <div key={pg.slug}>
                                  <div
                                    className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer transition-colors ${
                                      pgSelected ? 'bg-blue-50 border border-blue-100' : 'hover:bg-slate-100 border border-transparent'
                                    }`}
                                    onClick={() => {
                                      if (isMobile) {
                                        setSelectedItem(pgSelected ? null : `page:${pg.slug}`);
                                      } else {
                                        window.open(`/${pg.slug}`, '_blank');
                                      }
                                    }}
                                  >
                                    <Globe size={11} className="text-blue-400 shrink-0" />
                                    <span className="flex-1 text-[11px] font-medium text-slate-600 truncate" title={pg.title}>
                                      {pg.slug}
                                    </span>
                                    <span className={`flex items-center gap-0.5 shrink-0 transition-opacity ${
                                      isMobile ? (pgSelected ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                                    }`}>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); window.open(`/${pg.slug}`, '_blank'); setSelectedItem(null); }}
                                        className="p-0.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                        title="열기"
                                      >
                                        <ExternalLink size={10} />
                                      </button>
                                      {!isMobile && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleEditPage(pg.slug); setSelectedItem(null); }}
                                          className="p-0.5 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 active:bg-amber-100 transition-colors"
                                          title="편집"
                                        >
                                          <Pencil size={10} />
                                        </button>
                                      )}
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleDeletePage(pg.slug); setSelectedItem(null); }}
                                        disabled={deletingPage === pg.slug}
                                        className="p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors disabled:opacity-40"
                                        title="삭제"
                                      >
                                        {deletingPage === pg.slug ? <Loader2 size={10} className="animate-spin" /> : <Trash2 size={10} />}
                                      </button>
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                            {mp.paths.map(p => {
                              const entryFile = moduleEntries[p] || 'main.py';
                              const modSelected = selectedItem === `mod:${p}`;
                              return (
                                <div key={p}>
                                  <div
                                    className={`group flex items-center gap-1.5 px-2 py-1 rounded-lg cursor-pointer transition-colors ${
                                      modSelected ? 'bg-blue-50 border border-blue-100' : 'hover:bg-slate-100 border border-transparent'
                                    }`}
                                    onClick={() => {
                                      if (isMobile) {
                                        setSelectedItem(modSelected ? null : `mod:${p}`);
                                      }
                                    }}
                                  >
                                    <FileCode size={11} className="text-emerald-500 shrink-0" />
                                    <span className="flex-1 text-[11px] font-medium text-slate-500 truncate" title={p}>
                                      {entryFile}
                                    </span>
                                    <span className={`flex items-center gap-0.5 shrink-0 transition-opacity ${
                                      isMobile ? (modSelected ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                                    }`}>
                                      {!isMobile && (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleOpenModule(p); setSelectedItem(null); }}
                                          className="p-0.5 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 active:bg-amber-100 transition-colors"
                                          title="편집"
                                        >
                                          <Pencil size={10} />
                                        </button>
                                      )}
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleDeleteModule(p); setSelectedItem(null); }}
                                        className="p-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 transition-colors"
                                        title="삭제"
                                      >
                                        <Trash2 size={10} />
                                      </button>
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ── 대화 목록 ── */
          <div className="flex flex-col h-full">
            <div className="p-2 border-b border-slate-200/60">
              <button
                onClick={() => { onNewConv(); if (isMobile) setCollapsed(true); }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[12px] font-bold transition-colors shadow-sm"
              >
                <Plus size={13} /> 새 대화
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain p-1.5 space-y-0.5 scrolltext">
              {conversations.length === 0 && (
                <p className="text-[12px] text-slate-400 text-center py-6">대화 내역이 없습니다.</p>
              )}
              {[...conversations].reverse().map(conv => {
                const convSelected = selectedItem === `conv:${conv.id}`;
                return (
                  <div key={conv.id}>
                    <div
                      onClick={() => {
                        if (isMobile) {
                          setSelectedItem(convSelected ? null : `conv:${conv.id}`);
                        }
                        onSelectConv(conv.id);
                      }}
                      className={`group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
                        conv.id === activeConvId
                          ? 'bg-blue-50 border border-blue-100'
                          : convSelected
                            ? 'bg-slate-100 border border-slate-200'
                            : 'hover:bg-slate-100 border border-transparent'
                      }`}
                    >
                      <MessageSquare
                        size={12}
                        className={`mt-0.5 shrink-0 ${conv.id === activeConvId ? 'text-blue-500' : 'text-slate-400'}`}
                      />
                      <div className="flex-1 min-w-0">
                        <p className={`text-[12px] font-semibold truncate ${conv.id === activeConvId ? 'text-blue-700' : 'text-slate-700'}`}>
                          {conv.title}
                        </p>
                        <p className="text-[10px] text-slate-400 mt-0.5">{formatDate(conv.createdAt)}</p>
                      </div>
                      {/* 삭제 아이콘: PC=호버, 모바일=선택 시 */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteConv(conv.id); setSelectedItem(null); }}
                        className={`p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 rounded transition-all shrink-0 ${
                          isMobile ? ((convSelected || conv.id === activeConvId) ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                        }`}
                        title="삭제"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 설정 버튼 — 사이드바 하단 */}
      {!isDemo && onOpenSettings && (
        <div className="shrink-0 border-t border-slate-200/80 px-3 py-2">
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors text-[12px] font-semibold"
          >
            <Settings size={14} /> Settings
          </button>
        </div>
      )}
    </div>

    {/* PageSpec 에디터 모달 — PC에서만 표시 */}
    {editingPageSlug && !isMobile && (
      <FileEditor
        pageSlug={editingPageSlug}
        onClose={() => setEditingPageSlug(null)}
        onSaved={fetchPages}
      />
    )}

    {/* 스케줄 등록/수정 모달 */}
    {schedulingModule && (
      <ScheduleModal
        job={schedulingModule}
        onClose={() => setSchedulingModule(null)}
        onSaved={() => { setSchedulingModule(null); window.dispatchEvent(new Event('firebat-refresh')); }}
      />
    )}
  </>
  );
}

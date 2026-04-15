'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderTree, MessageSquare, RefreshCw, ChevronLeft, ChevronRight, ChevronDown, Plus, Trash2, Loader2, Globe, Pencil, ExternalLink, Settings, Package, FileCode, Clock, MoreHorizontal, Eye, EyeOff, Lock } from 'lucide-react';
import { FileEditor } from './FileEditor';
import { CronPanel, ScheduleModal } from './CronPanel';

interface Project { name: string; paths: string[]; pageSlugs?: string[]; visibility?: string; }
interface PageInfo { slug: string; title: string; status: string; updatedAt: string; project?: string | null; visibility?: string; }
interface MergedProject { name: string; paths: string[]; pages: PageInfo[]; visibility?: string; }

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


  // ── 프로젝트 & 페이지 ──
  const [projects, setProjects] = useState<Project[]>([]);
  const [deletingProject, setDeletingProject] = useState<string | null>(null);
  const [editingPageSlug, setEditingPageSlug] = useState<string | null>(null);
  // 스케줄 모달용 상태
  const [schedulingModule, setSchedulingModule] = useState<{ jobId: string; targetPath: string; pageSlugs?: string[] } | null>(null);
  // 모듈 경로 → 엔트리 파일명 캐시 (예: "user/modules/weather" → "main.py")
  const [moduleEntries, setModuleEntries] = useState<Record<string, string>>({});
  // ⋯ 더보기 드롭다운 열린 항목 ID
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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
    fetchProjects();
    fetchPages();
  }, [fetchProjects, fetchPages]);
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

  // ⋯ 메뉴 외부 클릭 닫기
  useEffect(() => {
    if (!openMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openMenu]);

  // 페이지 visibility 변경
  const handleSetPageVisibility = async (slug: string, vis: 'public' | 'password' | 'private') => {
    let password: string | undefined;
    if (vis === 'password') {
      const pw = prompt('비밀번호를 입력하세요');
      if (!pw) return; // 취소
      password = pw;
    }
    try {
      await fetch(`/api/pages/${encodeURIComponent(slug)}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: vis, ...(password ? { password } : {}) }),
      });
      fetchPages();
    } catch {}
    setOpenMenu(null);
    setSelectedItem(null);
  };

  // 프로젝트 visibility 변경
  const handleSetProjectVisibility = async (name: string, vis: 'public' | 'password' | 'private') => {
    let password: string | undefined;
    if (vis === 'password') {
      const pw = prompt('비밀번호를 입력하세요');
      if (!pw) return;
      password = pw;
    }
    try {
      await fetch('/api/fs/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: name, visibility: vis, ...(password ? { password } : {}) }),
      });
      refreshAll();
    } catch {}
    setOpenMenu(null);
    setSelectedItem(null);
  };

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
      map.set(p.name, { name: p.name, paths: p.paths, pages: [], visibility: p.visibility });
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

            {/* ── CRON JOBS 섹션 ── */}
            <CronPanel />

            {/* ── PROJECTS 섹션 ── */}
            <div className="flex-shrink-0">
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

                          {/* 액션 아이콘: 열기 + ⋯ 더보기 */}
                          <span className={`flex items-center gap-0.5 shrink-0 justify-end transition-opacity ${
                            isMobile ? (isSelected ? 'opacity-100' : 'opacity-0 pointer-events-none') : 'opacity-0 group-hover:opacity-100'
                          }`}>
                            {/* visibility 아이콘 (비공개/비밀번호일 때만) */}
                            {(mp.visibility === 'private' || (isSingle && mainSlug && mp.pages[0]?.visibility === 'private')) && (
                              <EyeOff size={10} className="text-slate-400 shrink-0" />
                            )}
                            {(mp.visibility === 'password' || (isSingle && mainSlug && mp.pages[0]?.visibility === 'password')) && (
                              <Lock size={10} className="text-slate-400 shrink-0" />
                            )}
                            {mainSlug && (
                              <button
                                onClick={(e) => { e.stopPropagation(); window.open(`/${mainSlug}`, '_blank'); setSelectedItem(null); }}
                                className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                title="열기"
                              >
                                <ExternalLink size={11} />
                              </button>
                            )}
                            <div className="relative" ref={openMenu === `proj:${mp.name}` ? menuRef : undefined}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenMenu(openMenu === `proj:${mp.name}` ? null : `proj:${mp.name}`);
                                }}
                                className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                title="더보기"
                              >
                                <MoreHorizontal size={11} />
                              </button>
                              {openMenu === `proj:${mp.name}` && (
                                <div className="absolute right-0 top-full mt-1 w-36 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50">
                                  {isSingle && mainSlug && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleEditPage(mainSlug); setOpenMenu(null); setSelectedItem(null); }}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                    >
                                      <Pencil size={11} /> 편집
                                    </button>
                                  )}
                                  {/* visibility 서브메뉴 */}
                                  {(() => {
                                    const curVis = isSingle && mainSlug ? (mp.pages[0]?.visibility ?? 'public') : (mp.visibility ?? 'public');
                                    const setVis = (vis: 'public' | 'password' | 'private') => (e: React.MouseEvent) => {
                                      e.stopPropagation();
                                      if (isSingle && mainSlug) handleSetPageVisibility(mainSlug, vis);
                                      else handleSetProjectVisibility(mp.name, vis);
                                    };
                                    return (
                                      <>
                                        <button onClick={setVis('public')} className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-50 transition-colors ${curVis === 'public' ? 'text-blue-600 font-bold' : 'text-slate-600'}`}>
                                          <Eye size={11} /> 공개
                                        </button>
                                        <button onClick={setVis('password')} className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-50 transition-colors ${curVis === 'password' ? 'text-blue-600 font-bold' : 'text-slate-600'}`}>
                                          <Lock size={11} /> 비밀번호
                                        </button>
                                        <button onClick={setVis('private')} className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-50 transition-colors ${curVis === 'private' ? 'text-blue-600 font-bold' : 'text-slate-600'}`}>
                                          <EyeOff size={11} /> 비공개
                                        </button>
                                      </>
                                    );
                                  })()}
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
                                      setOpenMenu(null);
                                      setSelectedItem(null);
                                    }}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                  >
                                    <Clock size={11} /> 스케줄
                                  </button>
                                  <div className="border-t border-slate-100 my-0.5" />
                                  {isSingle && mainSlug ? (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleDeletePage(mainSlug); setOpenMenu(null); setSelectedItem(null); }}
                                      disabled={deletingPage === mainSlug}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                                    >
                                      <Trash2 size={11} /> 삭제
                                    </button>
                                  ) : (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleDeleteProject(mp.name); setOpenMenu(null); setSelectedItem(null); }}
                                      disabled={deletingProject === mp.name}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                                    >
                                      <Trash2 size={11} /> 프로젝트 삭제
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
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
                                      {pg.visibility === 'private' && <EyeOff size={9} className="text-slate-400 shrink-0" />}
                                      {pg.visibility === 'password' && <Lock size={9} className="text-slate-400 shrink-0" />}
                                      <button
                                        onClick={(e) => { e.stopPropagation(); window.open(`/${pg.slug}`, '_blank'); setSelectedItem(null); }}
                                        className="p-0.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                        title="열기"
                                      >
                                        <ExternalLink size={10} />
                                      </button>
                                      <div className="relative" ref={openMenu === `page:${pg.slug}` ? menuRef : undefined}>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenMenu(openMenu === `page:${pg.slug}` ? null : `page:${pg.slug}`);
                                          }}
                                          className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                          title="더보기"
                                        >
                                          <MoreHorizontal size={10} />
                                        </button>
                                        {openMenu === `page:${pg.slug}` && (
                                          <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50">
                                            <button
                                              onClick={(e) => { e.stopPropagation(); handleEditPage(pg.slug); setOpenMenu(null); setSelectedItem(null); }}
                                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                            >
                                              <Pencil size={10} /> 편집
                                            </button>
                                            {/* visibility 서브메뉴 */}
                                            {(['public', 'password', 'private'] as const).map(vis => {
                                              const curVis = pg.visibility ?? 'public';
                                              const icon = vis === 'public' ? <Eye size={10} /> : vis === 'password' ? <Lock size={10} /> : <EyeOff size={10} />;
                                              const label = vis === 'public' ? '공개' : vis === 'password' ? '비밀번호' : '비공개';
                                              return (
                                                <button key={vis} onClick={(e) => { e.stopPropagation(); handleSetPageVisibility(pg.slug, vis); }}
                                                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-slate-50 transition-colors ${curVis === vis ? 'text-blue-600 font-bold' : 'text-slate-600'}`}
                                                >
                                                  {icon} {label}
                                                </button>
                                              );
                                            })}
                                            <div className="border-t border-slate-100 my-0.5" />
                                            <button
                                              onClick={(e) => { e.stopPropagation(); handleDeletePage(pg.slug); setOpenMenu(null); setSelectedItem(null); }}
                                              disabled={deletingPage === pg.slug}
                                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
                                            >
                                              <Trash2 size={10} /> 삭제
                                            </button>
                                          </div>
                                        )}
                                      </div>
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
                                      <div className="relative" ref={openMenu === `mod:${p}` ? menuRef : undefined}>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenMenu(openMenu === `mod:${p}` ? null : `mod:${p}`);
                                          }}
                                          className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                          title="더보기"
                                        >
                                          <MoreHorizontal size={10} />
                                        </button>
                                        {openMenu === `mod:${p}` && (
                                          <div className="absolute right-0 top-full mt-1 w-28 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50">
                                            {isMobile && (
                                              <button
                                                onClick={(e) => { e.stopPropagation(); handleOpenModule(p); setOpenMenu(null); setSelectedItem(null); }}
                                                className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                              >
                                                <Pencil size={10} /> 편집
                                              </button>
                                            )}
                                            <button
                                              onClick={(e) => { e.stopPropagation(); handleDeleteModule(p); setOpenMenu(null); setSelectedItem(null); }}
                                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-red-500 hover:bg-red-50 transition-colors"
                                            >
                                              <Trash2 size={10} /> 삭제
                                            </button>
                                          </div>
                                        )}
                                      </div>
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

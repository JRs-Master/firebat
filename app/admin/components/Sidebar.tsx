'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { FolderTree, MessageSquare, ChevronRight, ChevronDown, Plus, Trash2, Globe, Pencil, ExternalLink, Settings, Package, FileCode, Clock, MoreHorizontal, Eye, EyeOff, Lock, PanelLeftClose, Share2, CheckCheck, Image as ImageIcon, LayoutTemplate } from 'lucide-react';
import { FileEditor } from './FileEditor';
import { CronPanel, ScheduleModal } from './CronPanel';
import { GalleryPanel } from './GalleryPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { Tooltip } from './Tooltip';
import { FeedbackBadge } from './FeedbackBadge';
import { confirmDialog, alertDialog } from './Dialog';
import { useSidebarRefresh } from '../hooks/events-manager';
import { createShareLink, copyToClipboard } from '../hooks/share-helper';
import { rowActionsClass } from '../utils/row-actions';

interface Project { name: string; paths: string[]; pageSlugs?: string[]; visibility?: string; }
interface PageInfo { slug: string; title: string; status: string; updatedAt: string; project?: string | null; visibility?: string; }
interface MergedProject { name: string; paths: string[]; pages: PageInfo[]; visibility?: string; }

export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: number;
  /** 최근 활동 순 정렬 기준. 없으면 createdAt 폴백 */
  updatedAt?: number;
};

interface SidebarProps {
  onRefreshTree: () => void;
  conversations: ConversationMeta[];
  activeConvId: string;
  /** 활성 대화의 실시간 messages (useChat state). 비활성 대화는 server fetch 만, 활성 대화는
   *  이 prop 우선 사용 — 500ms debounce DB sync race 회피 (채팅 추가 직후 share 시 stale 방지). */
  activeMessages?: unknown[];
  onSelectConv: (id: string) => void;
  onNewConv: () => void;
  onDeleteConv: (id: string) => void;
  /** 다기기 동기화용 — DB 에서 대화 목록·활성 대화 재조회. Sidebar 펼침·채팅 탭 전환 시 호출. */
  onRefreshChats?: () => void;
  aiModel?: string;
  onOpenSettings?: () => void;
  onEditFile?: (filePath: string) => void;
  onOpenModuleSettings?: (moduleName: string) => void;
  /** 외부에서 사이드바 열기 요청 (모바일 햄버거) */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}

export function Sidebar({
  onRefreshTree,
  conversations, activeConvId, activeMessages,
  onSelectConv, onNewConv, onDeleteConv,
  onRefreshChats,
  aiModel, onOpenSettings, onEditFile, onOpenModuleSettings,
  mobileOpen, onMobileOpenChange,
}: SidebarProps) {
  const [tab, setTab] = useState<'workspace' | 'chats' | 'gallery' | 'templates'>('workspace');
  const [collapsed, setCollapsed] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  // 사이드바 펼칠 때 + chats 탭 선택 시 DB 에서 대화 재조회 (모바일↔PC 동기화)
  const refreshChatsRef = useRef(onRefreshChats);
  refreshChatsRef.current = onRefreshChats;
  useEffect(() => {
    if (!collapsed && tab === 'chats') {
      refreshChatsRef.current?.();
    }
  }, [collapsed, tab]);

  useEffect(() => {
    const checkMobile = () => window.innerWidth < 768;
    // PC/모바일 모두 기본 접힘으로 시작
    setIsMobile(checkMobile());
    const handler = () => { setIsMobile(checkMobile()); };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // 모바일 햄버거 버튼 외부 제어
  useEffect(() => {
    if (isMobile && mobileOpen !== undefined) {
      setCollapsed(!mobileOpen);
    }
  }, [mobileOpen, isMobile]);


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
  // 비밀번호 입력 모달
  const [pwModal, setPwModal] = useState<{ type: 'page' | 'project'; target: string } | null>(null);
  const [pwInput, setPwInput] = useState('');

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

  // AI 액션 완료 (window 'firebat-refresh') + SSE (sidebar:refresh / cron:complete) 통합 수신
  // EventsManager 싱글톤이 EventSource 1개만 유지 — CronPanel 과 공유.
  useSidebarRefresh(() => refreshAllRef.current());

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
    if (vis === 'password') {
      setPwModal({ type: 'page', target: slug });
      setPwInput('');
      setOpenMenu(null);
      setSelectedItem(null);
      return;
    }
    try {
      await fetch(`/api/pages/${encodeURIComponent(slug)}/visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility: vis }),
      });
      fetchPages();
    } catch {}
    setOpenMenu(null);
    setSelectedItem(null);
  };

  // 프로젝트 visibility 변경
  const handleSetProjectVisibility = async (name: string, vis: 'public' | 'password' | 'private') => {
    if (vis === 'password') {
      setPwModal({ type: 'project', target: name });
      setPwInput('');
      setOpenMenu(null);
      setSelectedItem(null);
      return;
    }
    try {
      await fetch('/api/fs/projects', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: name, visibility: vis }),
      });
      refreshAll();
    } catch {}
    setOpenMenu(null);
    setSelectedItem(null);
  };

  // 비밀번호 모달 확인
  const handlePwConfirm = async () => {
    if (!pwModal || !pwInput.trim()) return;
    try {
      if (pwModal.type === 'page') {
        await fetch(`/api/pages/${encodeURIComponent(pwModal.target)}/visibility`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility: 'password', password: pwInput }),
        });
        fetchPages();
      } else {
        await fetch('/api/fs/projects', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: pwModal.target, visibility: 'password', password: pwInput }),
        });
        refreshAll();
      }
    } catch {}
    setPwModal(null);
    setPwInput('');
  };

  // 모듈 엔트리 파일 열기 (캐시된 엔트리 정보 활용)
  const handleOpenModule = (modulePath: string) => {
    if (!onEditFile) return;
    const entry = moduleEntries[modulePath] || 'main.py';
    onEditFile(`${modulePath}/${entry}`);
  };

  const handleDeleteModule = async (modulePath: string) => {
    const name = modulePath.replace(/^user\/modules\//, '');
    if (!await confirmDialog({ title: '모듈 삭제', message: `모듈 "${name}" 폴더 전체를 삭제하시겠습니까?`, danger: true, okLabel: '삭제' })) return;
    try {
      await fetch(`/api/fs?path=${encodeURIComponent(modulePath)}`, { method: 'DELETE' });
      onRefreshTree();
      refreshAll();
    } catch {}
  };

  const handleDeleteProject = async (name: string) => {
    if (!await confirmDialog({ title: '프로젝트 삭제', message: `프로젝트 "${name}"의 모든 파일을 삭제하시겠습니까?\n관련 페이지와 모듈이 모두 삭제됩니다.`, danger: true, okLabel: '삭제' })) return;
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
    if (!await confirmDialog({ title: '페이지 삭제', message: `페이지 "${slug}"을(를) 삭제하시겠습니까?`, danger: true, okLabel: '삭제' })) return;
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

  // URL 변경 모달 상태 — type: page (단일 slug) / project (일괄 이름 변경)
  const [renameTarget, setRenameTarget] = useState<{ type: 'page' | 'project'; current: string } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [renameSetRedirect, setRenameSetRedirect] = useState(true);
  const [renaming, setRenaming] = useState(false);

  const openRenamePage = (slug: string) => { setRenameTarget({ type: 'page', current: slug }); setRenameInput(slug); setRenameSetRedirect(true); };
  const openRenameProject = (name: string) => { setRenameTarget({ type: 'project', current: name }); setRenameInput(name); setRenameSetRedirect(true); };

  // slug 자동 정규화: 앞뒤 공백·선행·후행 슬래시 제거 + 연속 슬래시 축약
  const normalizeSlug = (s: string) => s.trim().replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');

  const submitRename = async () => {
    if (!renameTarget) return;
    const normalized = normalizeSlug(renameInput);
    if (!normalized || normalized === renameTarget.current) return;
    setRenaming(true);
    try {
      if (renameTarget.type === 'page') {
        const res = await fetch(`/api/pages/${encodeURIComponent(renameTarget.current)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newSlug: normalized, setRedirect: renameSetRedirect }),
        });
        const data = await res.json();
        if (!data.success) { await alertDialog({ title: '변경 실패', message: data.error || '변경 실패', danger: true }); return; }
      } else {
        const res = await fetch(`/api/fs/projects`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rename', project: renameTarget.current, newName: normalized, setRedirect: renameSetRedirect }),
        });
        const data = await res.json();
        if (!data.success) { await alertDialog({ title: '변경 실패', message: data.error || '변경 실패', danger: true }); return; }
      }
      setRenameTarget(null);
      fetchPages();
      fetchProjects();
    } finally {
      setRenaming(false);
    }
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
    // ABC 정렬 (생성·수정 시 순서 변경 방지). 대소문자 무시 + 한/영 locale-aware.
    result.sort((a, b) => a.name.localeCompare(b.name, 'ko', { sensitivity: 'base' }));
    return result;
  })();

  // ── 오버레이 body 스크롤 방지 ──
  useEffect(() => {
    if (!collapsed) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [collapsed]);

  const closeSidebar = () => {
    setCollapsed(true);
    onMobileOpenChange?.(false);
  };

  const expand = (t: 'workspace' | 'chats' | 'gallery' | 'templates') => {
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
    // 모바일에서는 아이콘 바 숨김 (햄버거 버튼이 page.tsx에서 표시됨)
    if (isMobile) return null;
    return (
      <>
      <div className="w-12 border-r border-slate-200 bg-white flex flex-col items-center py-3 gap-3 shrink-0 z-20 shadow-lg">
        <Tooltip label="Workspace" side="right">
          <button
            onClick={() => expand('workspace')}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
          >
            <FolderTree size={18} />
          </button>
        </Tooltip>
        <Tooltip label="대화 목록" side="right">
          <button
            onClick={() => expand('chats')}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors relative"
          >
            <MessageSquare size={18} />
            {conversations.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 bg-blue-500 text-white text-[8px] font-black rounded-full flex items-center justify-center">
                {conversations.length > 9 ? '9+' : conversations.length}
              </span>
            )}
          </button>
        </Tooltip>
        <Tooltip label="갤러리" side="right">
          <button
            onClick={() => expand('gallery')}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
          >
            <ImageIcon size={18} />
          </button>
        </Tooltip>
        <Tooltip label="템플릿" side="right">
          <button
            onClick={() => expand('templates')}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
          >
            <LayoutTemplate size={18} />
          </button>
        </Tooltip>
        <div className="flex-1" />
        {onOpenSettings && (
          <Tooltip label="설정" side="right">
            <button
              onClick={onOpenSettings}
              className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
            >
              <Settings size={18} />
            </button>
          </Tooltip>
        )}
      </div>
    </>
    );
  }

  /* ── 펼쳐진 모드 ── */
  return (
    <>
    {/* PC: 아이콘 바 자리 유지 (사이드바 펼침/접힘 시 대화 영역 움직임 방지) */}
    {!isMobile && <div className="w-12 shrink-0" />}
    {/* backdrop */}
    <div
      className="fixed top-12 inset-x-0 bottom-0 bg-black/30 z-30 touch-none"
      onClick={closeSidebar}
    />
    <div className="fixed top-12 bottom-0 left-0 z-40 w-72 border-r border-slate-200 bg-white flex flex-col shrink-0 shadow-lg overflow-hidden">

      {/* 탭 헤더 — 아이콘 전용 (PC·모바일 공통, 공간 절약) */}
      <div className="flex items-center gap-1.5 px-2 py-2 border-b border-slate-200/80">
        <Tooltip label="Workspace">
          <button
            onClick={() => setTab('workspace')}
            className={`p-2 rounded-md transition-colors ${
              tab === 'workspace' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            <FolderTree size={15} />
          </button>
        </Tooltip>
        <Tooltip label="대화 목록">
          <button
            onClick={() => setTab('chats')}
            className={`relative p-2 rounded-md transition-colors ${
              tab === 'chats' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            <MessageSquare size={15} />
            {conversations.length > 0 && tab !== 'chats' && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3 h-3 px-1 bg-blue-500 text-white text-[8px] font-black rounded-full flex items-center justify-center">
                {conversations.length > 9 ? '9+' : conversations.length}
              </span>
            )}
          </button>
        </Tooltip>
        <Tooltip label="갤러리">
          <button
            onClick={() => setTab('gallery')}
            className={`p-2 rounded-md transition-colors ${
              tab === 'gallery' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            <ImageIcon size={15} />
          </button>
        </Tooltip>
        <Tooltip label="템플릿">
          <button
            onClick={() => setTab('templates')}
            className={`p-2 rounded-md transition-colors ${
              tab === 'templates' ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
            }`}
          >
            <LayoutTemplate size={15} />
          </button>
        </Tooltip>
        <div className="flex-1" />
        {onOpenSettings ? (
          <Tooltip label="설정">
            <button
              onClick={() => { onOpenSettings(); if (isMobile) closeSidebar(); }}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
            >
              <Settings size={15} />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip label="사이드바 접기">
          <button
            onClick={closeSidebar}
            className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
          >
            <PanelLeftClose size={15} />
          </button>
        </Tooltip>
      </div>

      {/* 패널 컨텐츠 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {tab === 'gallery' ? (
          <GalleryPanel />
        ) : tab === 'templates' ? (
          <TemplatesPanel onEditFile={onEditFile} />
        ) : tab === 'workspace' ? (
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

                          <Tooltip label={mp.name}>
                            <span className="flex-1 text-[12px] font-semibold text-slate-700 truncate">
                              {isSingle ? (mainSlug ?? mp.name) : mp.name}
                            </span>
                          </Tooltip>

                          {/* 액션 아이콘: 열기 + ⋯ 더보기 */}
                          <span className={`${rowActionsClass(isSelected)} justify-end`}>
                            {/* visibility 아이콘 (비공개/비밀번호일 때만) */}
                            {(mp.visibility === 'private' || (isSingle && mainSlug && mp.pages[0]?.visibility === 'private')) && (
                              <EyeOff size={10} className="text-slate-400 shrink-0" />
                            )}
                            {(mp.visibility === 'password' || (isSingle && mainSlug && mp.pages[0]?.visibility === 'password')) && (
                              <Lock size={10} className="text-slate-400 shrink-0" />
                            )}
                            {mainSlug && (
                              <Tooltip label="열기">
                                <button
                                  onClick={(e) => { e.stopPropagation(); window.open(`/${mainSlug}`, '_blank'); setSelectedItem(null); }}
                                  className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                >
                                  <ExternalLink size={11} />
                                </button>
                              </Tooltip>
                            )}
                            <div className="relative" ref={openMenu === `proj:${mp.name}` ? menuRef : undefined}>
                              <Tooltip label="더보기">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenu(openMenu === `proj:${mp.name}` ? null : `proj:${mp.name}`);
                                  }}
                                  className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                >
                                  <MoreHorizontal size={11} />
                                </button>
                              </Tooltip>
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
                                  {/* URL 변경 — 단일 페이지는 slug 편집, 프로젝트는 이름 일괄 변경 */}
                                  {isSingle && mainSlug ? (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openRenamePage(mainSlug); setOpenMenu(null); setSelectedItem(null); }}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                    >
                                      <Globe size={11} /> URL 변경
                                    </button>
                                  ) : (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); openRenameProject(mp.name); setOpenMenu(null); setSelectedItem(null); }}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                    >
                                      <Globe size={11} /> 프로젝트 이름 변경
                                    </button>
                                  )}
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
                                    <Tooltip label={pg.title}>
                                      <span className="flex-1 text-[11px] font-medium text-slate-600 truncate">
                                        {pg.slug}
                                      </span>
                                    </Tooltip>
                                    <span className={rowActionsClass(pgSelected)}>
                                      {pg.visibility === 'private' && <EyeOff size={9} className="text-slate-400 shrink-0" />}
                                      {pg.visibility === 'password' && <Lock size={9} className="text-slate-400 shrink-0" />}
                                      <Tooltip label="열기">
                                        <button
                                          onClick={(e) => { e.stopPropagation(); window.open(`/${pg.slug}`, '_blank'); setSelectedItem(null); }}
                                          className="p-0.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                        >
                                          <ExternalLink size={10} />
                                        </button>
                                      </Tooltip>
                                      <div className="relative" ref={openMenu === `page:${pg.slug}` ? menuRef : undefined}>
                                        <Tooltip label="더보기">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setOpenMenu(openMenu === `page:${pg.slug}` ? null : `page:${pg.slug}`);
                                            }}
                                            className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                          >
                                            <MoreHorizontal size={10} />
                                          </button>
                                        </Tooltip>
                                        {openMenu === `page:${pg.slug}` && (
                                          <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-50">
                                            <button
                                              onClick={(e) => { e.stopPropagation(); handleEditPage(pg.slug); setOpenMenu(null); setSelectedItem(null); }}
                                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                            >
                                              <Pencil size={10} /> 편집
                                            </button>
                                            <button
                                              onClick={(e) => { e.stopPropagation(); openRenamePage(pg.slug); setOpenMenu(null); setSelectedItem(null); }}
                                              className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-slate-600 hover:bg-slate-50 transition-colors"
                                            >
                                              <Globe size={10} /> URL 변경
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
                                    <Tooltip label={p}>
                                      <span className="flex-1 text-[11px] font-medium text-slate-500 truncate">
                                        {entryFile}
                                      </span>
                                    </Tooltip>
                                    <span className={rowActionsClass(modSelected)}>
                                      {!isMobile && (
                                        <Tooltip label="편집">
                                          <button
                                            onClick={(e) => { e.stopPropagation(); handleOpenModule(p); setSelectedItem(null); }}
                                            className="p-0.5 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 active:bg-amber-100 transition-colors"
                                          >
                                            <Pencil size={10} />
                                          </button>
                                        </Tooltip>
                                      )}
                                      <div className="relative" ref={openMenu === `mod:${p}` ? menuRef : undefined}>
                                        <Tooltip label="더보기">
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setOpenMenu(openMenu === `mod:${p}` ? null : `mod:${p}`);
                                            }}
                                            className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                          >
                                            <MoreHorizontal size={10} />
                                          </button>
                                        </Tooltip>
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
                onClick={() => { onNewConv(); closeSidebar(); }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-[12px] font-bold transition-colors shadow-sm"
              >
                <Plus size={13} /> 새 대화
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain p-1.5 space-y-0.5 scrolltext">
              {conversations.length === 0 && (
                <p className="text-[12px] text-slate-400 text-center py-6">대화 내역이 없습니다.</p>
              )}
              {[...conversations].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)).map(conv => {
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
                      {/* 공유·삭제 아이콘 묶음: PC=호버, 모바일=선택 시 (활성 대화도 force visible) */}
                      <span className={rowActionsClass(convSelected || conv.id === activeConvId)}>
                        <ShareConvButton
                          convId={conv.id}
                          title={conv.title}
                          liveMessages={conv.id === activeConvId ? activeMessages : undefined}
                        />
                        <Tooltip label="삭제">
                          <button
                            onClick={(e) => { e.stopPropagation(); onDeleteConv(conv.id); setSelectedItem(null); }}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 active:bg-red-100 rounded transition-colors"
                          >
                            <Trash2 size={11} />
                          </button>
                        </Tooltip>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

    </div>

    {/* PageSpec 에디터 모달 — PC에서만 표시 */}
    {editingPageSlug && !isMobile && (
      <FileEditor
        pageSlug={editingPageSlug}
        aiModel={aiModel}
        onClose={() => setEditingPageSlug(null)}
        onSaved={fetchPages}
      />
    )}

    {/* URL / 프로젝트 이름 변경 모달 */}
    {renameTarget && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
        // 드래그 후 바깥에서 놓여도 모달 닫히지 않도록 — mousedown 이 backdrop 자체에서 시작된 경우에만 닫기
        onMouseDown={(e) => {
          if (renaming) return;
          if (e.target === e.currentTarget) setRenameTarget(null);
        }}
      >
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden" onMouseDown={e => e.stopPropagation()}>
          <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
            <h3 className="text-sm font-bold text-slate-800">
              {renameTarget.type === 'page' ? 'URL (slug) 변경' : '프로젝트 이름 변경'}
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {renameTarget.type === 'page'
                ? `현재: /${renameTarget.current}`
                : `현재 프로젝트: ${renameTarget.current} — 소속 페이지 slug 전부 일괄 변경`}
            </p>
          </div>
          <div className="px-5 py-4 flex flex-col gap-3">
            <input
              type="text"
              value={renameInput}
              onChange={e => setRenameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !renaming) submitRename(); }}
              placeholder={renameTarget.type === 'page' ? '새 slug (예: bitcoin/2026-04-20-review)' : '새 프로젝트 이름 (예: bitcoin-reviews)'}
              autoFocus
              disabled={renaming}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100"
            />
            <label className="flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer">
              <input type="checkbox" checked={renameSetRedirect} onChange={e => setRenameSetRedirect(e.target.checked)} disabled={renaming} />
              <span>구 URL → 새 URL 리디렉트 등록 (권장, 외부 공유된 링크 유지)</span>
            </label>
            <p className="text-[10px] text-slate-400">
              {renameTarget.type === 'page'
                ? 'slug 는 kebab-case + 슬래시 중첩 허용. 공백/선행후행슬래시/연속슬래시 금지.'
                : '소속 페이지의 slug 첫 세그먼트가 일괄 교체됩니다. 모듈 폴더명은 영향 받지 않음.'}
            </p>
          </div>
          <div className="px-5 py-3 border-t border-slate-200 bg-slate-50 flex justify-end gap-2">
            <button onClick={() => setRenameTarget(null)} disabled={renaming} className="px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-40">취소</button>
            <button onClick={submitRename} disabled={renaming || !renameInput.trim() || renameInput === renameTarget.current} className="px-3 py-1.5 text-[12px] bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg disabled:bg-slate-300">
              {renaming ? '변경 중...' : '변경'}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* 스케줄 등록/수정 모달 */}
    {schedulingModule && (
      <ScheduleModal
        job={schedulingModule}
        onClose={() => setSchedulingModule(null)}
        onSaved={() => { setSchedulingModule(null); window.dispatchEvent(new Event('firebat-refresh')); }}
      />
    )}

    {/* 비밀번호 설정 모달 */}
    {pwModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => setPwModal(null)}>
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-xs overflow-hidden" onClick={e => e.stopPropagation()}>
          <div className="px-5 py-3 border-b border-slate-200 bg-slate-50">
            <h3 className="text-sm font-bold text-slate-800">비밀번호 설정</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {pwModal.type === 'page' ? `"${pwModal.target}"` : `프로젝트 "${pwModal.target}"`} 접근 비밀번호
            </p>
          </div>
          <div className="px-5 py-4 flex flex-col gap-3">
            <input
              type="password"
              value={pwInput}
              onChange={e => setPwInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handlePwConfirm()}
              placeholder="비밀번호 입력"
              autoFocus
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-[13px] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setPwModal(null)}
                className="px-3 py-1.5 text-[12px] font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
              >
                취소
              </button>
              <button
                onClick={handlePwConfirm}
                disabled={!pwInput.trim()}
                className="px-4 py-1.5 text-[12px] font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg transition-colors"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
  </>
  );
}

/** 대화 전체 공유 버튼 — 클릭 시 DB 에서 메시지 fetch → 공유 생성 → 클립보드 복사 */
function ShareConvButton({ convId, title, liveMessages }: { convId: string; title: string; liveMessages?: unknown[] }) {
  const [status, setStatus] = useState<'idle' | 'sharing' | 'done' | 'error'>('idle');
  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'sharing') return;
    setStatus('sharing');
    try {
      // 1) 메시지 source 결정 — 활성 대화면 client state (실시간) 우선, 비활성 대화면 server fetch.
      //    이전: 항상 server fetch → 500ms debounce DB sync race 로 채팅 추가 직후 stale messages.
      let messages: Array<{ id?: string; [k: string]: unknown }>;
      if (liveMessages && liveMessages.length > 0) {
        messages = (liveMessages as Array<{ id?: string }>).filter((m) => m.id !== 'system-init');
      } else {
        const convRes = await fetch(`/api/conversations?id=${encodeURIComponent(convId)}`);
        const convData = await convRes.json();
        if (!convData.success || !convData.conversation) {
          setStatus('error');
          setTimeout(() => setStatus('idle'), 2200);
          return;
        }
        messages = (convData.conversation.messages || []).filter((m: { id?: string }) => m.id !== 'system-init');
      }
      if (messages.length === 0) {
        setStatus('error');
        setTimeout(() => setStatus('idle'), 2200);
        return;
      }
      // 2) 공유 생성 — dedupKey 에 메시지 개수 + 마지막 메시지 id 포함.
      //    이전: dedupKey: `full:${convId}` 만 → 채팅 추가돼도 옛 share record 재사용 (사용자 마찰).
      //    현재: 메시지 추가/변경 감지되면 새 dedupKey → 새 snapshot + 새 link.
      //    동일 시점 여러 device 에서 같은 turn 공유 시도하면 같은 length+lastId → 재사용 OK.
      const lastMsg = messages[messages.length - 1] as { id?: string } | undefined;
      const dedupKey = `full:${convId}:${messages.length}:${lastMsg?.id ?? ''}`;
      const shareRes = await createShareLink({ type: 'full', conversationId: convId, title, messages, dedupKey });
      if ('error' in shareRes) {
        setStatus('error');
        setTimeout(() => setStatus('idle'), 2200);
        return;
      }
      // 3) 클립보드 복사
      const ok = await copyToClipboard(shareRes.url);
      setStatus(ok ? 'done' : 'error');
      setTimeout(() => setStatus('idle'), 2200);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2200);
    }
  };
  const badgeState: 'ok' | 'err' | 'loading' | null =
    status === 'done' ? 'ok' : status === 'error' ? 'err' : status === 'sharing' ? 'loading' : null;
  return (
    <div className="relative inline-flex">
      <Tooltip label="이 대화 공유 (24h)">
        <button
          onClick={handleShare}
          disabled={status === 'sharing'}
          className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 rounded transition-colors disabled:opacity-50"
        >
          {status === 'done' ? <CheckCheck size={11} className="text-emerald-500" /> : <Share2 size={11} />}
        </button>
      </Tooltip>
      <FeedbackBadge state={badgeState} okLabel="링크 복사됨" errLabel="공유 실패" loadingLabel="생성 중" absolute />
    </div>
  );
}

'use client';

import { useId, useState, useEffect, useCallback, useRef } from 'react';
import { FolderTree, MessageSquare, ChevronRight, ChevronDown, Plus, Trash2, Globe, Pencil, ExternalLink, Settings, Package, FileCode, Clock, MoreHorizontal, Eye, EyeOff, Lock, PanelLeftClose, Share2, CheckCheck, Image as ImageIcon, LayoutTemplate, Brain, NotebookText, Calendar as CalendarIcon, Sparkles, RotateCcw, X, BookOpen } from 'lucide-react';
import { FileEditor } from './FileEditor';
import { AnchoredMenu } from './Menu';
import { CronPanel, ScheduleModal } from './CronPanel';
import { GalleryPanel } from './GalleryPanel';
import { EntitiesPanel } from './EntitiesPanel';
import { NotesPanel } from './NotesPanel';
import { CalendarPanel } from './CalendarPanel';
import { TemplatesPanel } from './TemplatesPanel';
import { LibraryPanel } from './LibraryPanel';
import { Tooltip } from './Tooltip';
import { useTranslations } from '../../../lib/i18n';
import { FeedbackBadge } from './FeedbackBadge';
import { confirmDialog, alertDialog } from './Dialog';
import { useSidebarRefresh } from '../hooks/events-manager';
import { createShareLink, copyToClipboard } from '../hooks/share-helper';
import { rowActionsClass } from '../utils/row-actions';
import { useRowActions } from '../hooks/useRowActions';
import { logger } from '../../../lib/util/logger';
import { apiGet, apiPost, apiPatch, apiDelete } from '../../../lib/api-fetch';
import { TIME } from '../../../lib/util/time';
import { findModuleEntryWithFallback } from '../../../lib/util/module';

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

type TabId = 'workspace' | 'chats' | 'gallery' | 'templates' | 'entities' | 'notes' | 'calendar' | 'library';

const TABS: { id: TabId; label: string; Icon: typeof FolderTree; tooltip: string }[] = [
  { id: 'workspace', label: '워크스페이스', Icon: FolderTree, tooltip: 'Workspace' },
  { id: 'chats', label: '대화', Icon: MessageSquare, tooltip: '대화 목록' },
  { id: 'gallery', label: '갤러리', Icon: ImageIcon, tooltip: '갤러리' },
  { id: 'templates', label: '템플릿', Icon: LayoutTemplate, tooltip: '템플릿' },
  { id: 'library', label: 'Library', Icon: BookOpen, tooltip: 'Library — 자료 영역 + RAG 검색' },
  { id: 'entities', label: 'Recall', Icon: Sparkles, tooltip: 'Recall (엔티티 + 사건)' },
  { id: 'notes', label: '노트', Icon: NotebookText, tooltip: '노트' },
  { id: 'calendar', label: '캘린더', Icon: CalendarIcon, tooltip: '캘린더' },
];

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
  /** Hub page mode — anonymous 방문자라 settings / workspace / templates / gallery 등 admin 전용 탭 hide. */
  hubMode?: boolean;
  /** Hub page mode 이면 share-helper 의 createShareLink 분기 인자. */
  hubShareContext?: { slug: string; apiToken: string; sessionId: string };
}

export function Sidebar({
  onRefreshTree,
  conversations, activeConvId, activeMessages,
  onSelectConv, onNewConv, onDeleteConv,
  onRefreshChats,
  aiModel, onOpenSettings, onEditFile, onOpenModuleSettings,
  mobileOpen, onMobileOpenChange,
  hubMode,
  hubShareContext,
}: SidebarProps) {
  const t = useTranslations();
  const renameInputId = useId();
  const renameSetRedirectId = useId();
  const [tab, setTab] = useState<TabId>('workspace');
  const [collapsed, setCollapsed] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  // 행 인터랙션용 터치 판정 — 레이아웃용 isMobile(폭<768)과 분리. 패널(useRowActions)·버튼 가시성
  // (rowActionsClass 의 hover:none)과 동일 기준으로 통일 — 터치 태블릿(폭≥768)에서도 탭=선택 정상.
  const { hoverNone } = useRowActions();

  // ── 휴지통 — chats 탭 안 토글 섹션 ──
  // 30일 retention 후 internal cron 자동 삭제. 복원 / 영구 삭제 가능.
  const [trashConvs, setTrashConvs] = useState<ConversationMeta[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);

  // 휴지통 fetch 헬퍼 — hub mode 면 익명 hub session endpoint 호출, 아니면 admin endpoint.
  // hub mode 휴지통은 (instance_id, session_id) scope 으로 backend 자동 격리.
  const hubFetchJson = useCallback(async (op: string, payload?: Record<string, unknown>) => {
    if (!hubShareContext) return null;
    const res = await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Token': hubShareContext.apiToken,
        'X-Session-Id': hubShareContext.sessionId,
      },
      body: JSON.stringify({ op, ...(payload ?? {}) }),
    });
    return res.json().catch(() => null);
  }, [hubShareContext]);

  const reloadTrash = useCallback(async () => {
    if (hubMode) {
      if (!hubShareContext) { setTrashConvs([]); return; }
      try {
        const data = await hubFetchJson('list-deleted-conversations');
        if (data?.success && Array.isArray(data.conversations)) {
          const mapped: ConversationMeta[] = data.conversations.map((c: any) => ({
            id: c.id,
            title: c.title || '새 대화',
            createdAt: typeof c.createdAt === 'number' ? c.createdAt : Number(c.createdAt ?? 0),
            updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Number(c.updatedAt ?? 0),
          }));
          setTrashConvs(mapped);
        } else {
          setTrashConvs([]);
        }
      } catch { /* silent — 다음 trigger 시 재시도 */ }
      return;
    }
    try {
      const data = await apiGet<{ success?: boolean; conversations?: ConversationMeta[] }>(
        '/api/conversations/trash',
        { category: 'sidebar' },
      );
      if (data?.success && Array.isArray(data.conversations)) {
        setTrashConvs(data.conversations);
      }
    } catch { /* silent — 다음 trigger 시 재시도 */ }
  }, [hubMode, hubShareContext, hubFetchJson]);

  const handleRestoreConv = useCallback(async (id: string) => {
    try {
      const data = hubMode
        ? await hubFetchJson('restore-conversation', { id })
        : await apiPost<{ success?: boolean; error?: string }>(
            '/api/conversations/restore',
            { id },
            { category: 'sidebar' },
          );
      if (!data?.success) {
        await alertDialog({ title: '복원 실패', message: data?.error ?? '알 수 없는 오류', danger: true });
        return;
      }
      await reloadTrash();
      onRefreshChats?.();
    } catch (e: any) {
      await alertDialog({ title: '복원 실패', message: e?.message ?? String(e), danger: true });
    }
  }, [hubMode, hubFetchJson, reloadTrash, onRefreshChats]);

  const handlePermanentDeleteConv = useCallback(async (id: string, title: string) => {
    const ok = await confirmDialog({
      title: '영구 삭제',
      message: `"${title}" 대화를 영구 삭제합니다. 복원할 수 없습니다.`,
      danger: true,
      okLabel: '영구 삭제',
    });
    if (!ok) return;
    try {
      const data = hubMode
        ? await hubFetchJson('permanent-delete-conversation', { id })
        : await apiPost<{ success?: boolean; error?: string }>(
            '/api/conversations/permanent-delete',
            { id },
            { category: 'sidebar' },
          );
      if (!data?.success) {
        await alertDialog({ title: '영구 삭제 실패', message: data?.error ?? '알 수 없는 오류', danger: true });
        return;
      }
      await reloadTrash();
    } catch (e: any) {
      await alertDialog({ title: '영구 삭제 실패', message: e?.message ?? String(e), danger: true });
    }
  }, [hubMode, hubFetchJson, reloadTrash]);

  // 사이드바 펼칠 때 + chats 탭 선택 시 DB 에서 대화 재조회 (모바일↔PC 동기화) + 휴지통 reload
  const refreshChatsRef = useRef(onRefreshChats);
  refreshChatsRef.current = onRefreshChats;
  useEffect(() => {
    if (!collapsed && tab === 'chats') {
      refreshChatsRef.current?.();
      reloadTrash();
    }
  }, [collapsed, tab, reloadTrash]);

  // 휴지통 토글 펼침 시 자동 fresh — 옛 = 사이드바 열린 시점 1회만 로드해서 삭제 직후 빈 상태.
  useEffect(() => {
    if (trashOpen) reloadTrash();
  }, [trashOpen, reloadTrash]);

  // 외부 trigger — useChat.handleDeleteConv 안 backend delete 완료 후 emit. 휴지통 즉시 fresh.
  useEffect(() => {
    const onRefreshTrash = () => { reloadTrash(); };
    window.addEventListener('firebat-refresh-trash', onRefreshTrash);
    return () => window.removeEventListener('firebat-refresh-trash', onRefreshTrash);
  }, [reloadTrash]);

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

  // PC: 채팅창 클릭 시 사이드바 접기 (page.tsx 가 'firebat-collapse-sidebar' 발화). 모바일은 mobileOpen 이 제어하므로 제외.
  useEffect(() => {
    const collapse = () => { if (!isMobile) setCollapsed(true); };
    window.addEventListener('firebat-collapse-sidebar', collapse);
    return () => window.removeEventListener('firebat-collapse-sidebar', collapse);
  }, [isMobile]);


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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // 비밀번호 입력 모달
  const [pwModal, setPwModal] = useState<{ type: 'page' | 'project'; target: string } | null>(null);
  const [pwInput, setPwInput] = useState('');

  const fetchProjects = useCallback(async () => {
    // hub mode = 익명 hub endpoint 호출. owner = `hub:<instance.id>` 인 자료만.
    if (hubMode) {
      if (!hubShareContext) { setProjects([]); setModuleEntries({}); return; }
      try {
        const res = await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/fs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Token': hubShareContext.apiToken,
            'X-Session-Id': hubShareContext.sessionId,
          },
          body: JSON.stringify({ op: 'projects' }),
        });
        const data = await res.json().catch(() => null);
        if (data?.success) {
          const projectList = (data.projects ?? []) as Project[];
          setProjects(projectList);
          const allPaths = projectList.flatMap(p => p.paths);
          const entries: Record<string, string> = {};
          await Promise.all(allPaths.map(async (p) => {
            try {
              const treeRes = await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/fs`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Api-Token': hubShareContext.apiToken,
                  'X-Session-Id': hubShareContext.sessionId,
                },
                body: JSON.stringify({ op: 'tree', root: p }),
              });
              const tree = await treeRes.json().catch(() => null);
              const files: string[] = [];
              if (tree?.success && tree.tree?.[0]?.children) {
                for (const n of tree.tree[0].children) {
                  if (!n.isDirectory) files.push(n.name);
                }
              }
              entries[p] = findModuleEntryWithFallback(files);
            } catch (e) { logger.debug('sidebar', 'hub tree 실패', { error: e }); }
          }));
          setModuleEntries(entries);
        } else {
          setProjects([]); setModuleEntries({});
        }
      } catch (e) { logger.debug('sidebar', 'hub projects 실패', { error: e }); }
      return;
    }
    try {
      const data = await apiGet<{ success: boolean; projects?: Project[] }>(
        '/api/fs/projects',
        { category: 'sidebar' },
      );
      if (data.success) {
        const projectList = data.projects ?? [];
        setProjects(projectList);
        const allPaths = projectList.flatMap(p => p.paths);
        const entries: Record<string, string> = {};
        await Promise.all(allPaths.map(async (p) => {
          try {
            const treeData = await apiGet<{ success?: boolean; tree?: Array<{ children?: Array<{ name: string; isDirectory: boolean }> }> }>(
              `/api/fs/tree?root=${encodeURIComponent(p)}`,
              { category: 'sidebar' },
            );
            const files: string[] = [];
            if (treeData.success && treeData.tree?.[0]?.children) {
              for (const n of treeData.tree[0].children) {
                if (!n.isDirectory) files.push(n.name);
              }
            }
            entries[p] = findModuleEntryWithFallback(files);
          } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
        }));
        setModuleEntries(entries);
      }
    } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
  }, [hubMode, hubShareContext]);

  const [pages, setPages] = useState<PageInfo[]>([]);
  const [deletingPage, setDeletingPage] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [selectedItem, setSelectedItem] = useState<string | null>(null);

  const fetchPages = useCallback(async () => {
    // hub mode = 익명 hub endpoint 호출. visitor 가 chat save_page 도구로 만든 hub-scoped page 영역만 노출.
    // admin endpoint 차단 (admin 자료 노출 금지).
    if (hubMode) {
      if (!hubShareContext) { setPages([]); return; }
      try {
        const res = await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/pages`, {
          headers: {
            'X-Api-Token': hubShareContext.apiToken,
            'X-Session-Id': hubShareContext.sessionId,
          },
        });
        const data = await res.json().catch(() => null);
        if (data?.success) setPages(data.pages ?? []);
        else setPages([]);
      } catch (e) { logger.debug('sidebar', 'hub pages 실패', { error: e }); }
      return;
    }
    try {
      const data = await apiGet<{ success: boolean; pages?: PageInfo[] }>(
        '/api/pages',
        { category: 'sidebar' },
      );
      if (data.success) setPages(data.pages ?? []);
    } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
  }, [hubMode, hubShareContext]);

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
      // hub 모드 = hub 라우트(project-scoped visibility). owner scoping 은 Rust core 가 강제.
      if (hubMode && hubShareContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/pages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
          body: JSON.stringify({ op: 'visibility', slug, visibility: vis }),
        });
      } else {
        await apiPatch(`/api/pages/${encodeURIComponent(slug)}/visibility`, { visibility: vis }, { category: 'sidebar' });
      }
      fetchPages();
    } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
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
      // hub 모드 = hub 라우트(hub-scoped visibility). owner scoping 은 Rust core 가 hub_id 로 강제.
      if (hubMode && hubShareContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/fs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
          body: JSON.stringify({ op: 'set-project-visibility', project: name, visibility: vis }),
        });
      } else {
        await apiPatch('/api/fs/projects', { project: name, visibility: vis }, { category: 'sidebar' });
      }
      refreshAll();
    } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
    setOpenMenu(null);
    setSelectedItem(null);
  };

  // 비밀번호 모달 확인
  const handlePwConfirm = async () => {
    if (!pwModal || !pwInput.trim()) return;
    try {
      // hub 모드 = hub 라우트(scoped). owner scoping 은 Rust core 가 강제.
      if (pwModal.type === 'page') {
        if (hubMode && hubShareContext) {
          await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/pages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
            body: JSON.stringify({ op: 'visibility', slug: pwModal.target, visibility: 'password', password: pwInput }),
          });
        } else {
          await apiPatch(`/api/pages/${encodeURIComponent(pwModal.target)}/visibility`, { visibility: 'password', password: pwInput }, { category: 'sidebar' });
        }
        fetchPages();
      } else {
        if (hubMode && hubShareContext) {
          await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/fs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
            body: JSON.stringify({ op: 'set-project-visibility', project: pwModal.target, visibility: 'password', password: pwInput }),
          });
        } else {
          await apiPatch('/api/fs/projects', { project: pwModal.target, visibility: 'password', password: pwInput }, { category: 'sidebar' });
        }
        refreshAll();
      }
    } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
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
    const name = modulePath.replace(/^user\/(hub\/[^/]+\/)?modules\//, '');
    if (!await confirmDialog({ title: '모듈 삭제', message: `모듈 "${name}" 폴더 전체를 삭제하시겠습니까?`, danger: true, okLabel: '삭제' })) return;
    try {
      // 옛엔 admin·hub 모두 존재하지 않는 /api/fs 를 호출해 404 였음. admin = /api/fs/delete,
      // hub = owner-scoped hub fs route(path 가 자기 hub dir 안인지 route 가 강제).
      if (hubMode && hubShareContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/fs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
          body: JSON.stringify({ op: 'delete', path: modulePath }),
        });
      } else {
        await apiDelete(`/api/fs/delete?path=${encodeURIComponent(modulePath)}`, { category: 'sidebar' });
      }
      onRefreshTree();
      refreshAll();
    } catch (e) { logger.debug('sidebar', 'operation 실패', { error: e }); }
  };

  const handleDeleteProject = async (name: string) => {
    if (!await confirmDialog({ title: '프로젝트 삭제', message: `프로젝트 "${name}"의 모든 파일을 삭제하시겠습니까?\n관련 페이지와 모듈이 모두 삭제됩니다.`, danger: true, okLabel: '삭제' })) return;
    setDeletingProject(name);
    try {
      // hub 모드 = hub 라우트(hub-scoped delete). owner scoping 은 Rust core 가 hub_id 로 강제.
      if (hubMode && hubShareContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/fs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
          body: JSON.stringify({ op: 'delete-project', project: name }),
        });
      } else {
        await apiDelete(`/api/fs/projects?project=${encodeURIComponent(name)}`, { category: 'sidebar' });
      }
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
      // hub 모드 = hub 라우트(project-scoped delete). 옛엔 admin /api/pages 무조건 호출이라 hub 페이지 삭제가 admin 영역에 박혔음.
      if (hubMode && hubShareContext) {
        await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/pages?slug=${encodeURIComponent(slug)}`, {
          method: 'DELETE',
          headers: {
            'X-Api-Token': hubShareContext.apiToken,
            'X-Session-Id': hubShareContext.sessionId,
          },
        });
      } else {
        await apiDelete(`/api/pages?slug=${encodeURIComponent(slug)}`, { category: 'sidebar' });
      }
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
      // hub 모드 = hub 라우트(scoped). owner scoping 은 Rust core 가 강제.
      if (renameTarget.type === 'page') {
        if (hubMode && hubShareContext) {
          const res = await fetch(`/api/hub/${encodeURIComponent(hubShareContext.slug)}/pages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': hubShareContext.apiToken, 'X-Session-Id': hubShareContext.sessionId },
            body: JSON.stringify({ op: 'rename', slug: renameTarget.current, newSlug: normalized, setRedirect: renameSetRedirect }),
          });
          const data = await res.json().catch(() => ({ success: false, error: '네트워크 오류' }));
          if (!data.success) { await alertDialog({ title: '변경 실패', message: data.error || '변경 실패', danger: true }); return; }
        } else {
          const data = await apiPatch<{ success: boolean; error?: string }>(
            `/api/pages/${encodeURIComponent(renameTarget.current)}`,
            { newSlug: normalized, setRedirect: renameSetRedirect },
            { category: 'sidebar' },
          );
          if (!data.success) { await alertDialog({ title: '변경 실패', message: data.error || '변경 실패', danger: true }); return; }
        }
      } else {
        // 프로젝트 이름 변경은 hub 인스턴스 프로젝트(hub:<id>)에는 적용할 수 없음 — 인스턴스 식별자라 변경 시 자료 연결이 끊깁니다.
        if (hubMode) {
          await alertDialog({ title: '변경 불가', message: '허브 프로젝트 이름은 변경할 수 없습니다.', danger: true });
          return;
        }
        const data = await apiPatch<{ success: boolean; error?: string }>(
          '/api/fs/projects',
          { action: 'rename', project: renameTarget.current, newName: normalized, setRedirect: renameSetRedirect },
          { category: 'sidebar' },
        );
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

  /** VSCode 활동 바 패턴 — 같은 탭 재클릭 시 panel 닫힘 (활동 바만 유지),
   *  다른 탭 클릭 시 그 탭으로 변경 + panel 열림. */
  const toggleTab = (t: TabId) => {
    if (tab === t && !collapsed) {
      setCollapsed(true);
    } else {
      setTab(t);
      setCollapsed(false);
    }
  };
  const activeTab = TABS.find(item => item.id === tab) ?? TABS[0];
  const ActiveIcon = activeTab.Icon;

  const formatDate = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - d.getTime()) / TIME.DAY_MS);
    if (diffDays === 0) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 1) return '어제';
    if (diffDays < 7) return `${diffDays}일 전`;
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  };

  /* ── VSCode activity bar — 항상 표시 (PC: inline, 모바일: slide-in 안). ── */
  // 모든 탭 노출. 각 panel 컴포넌트가 hubMode prop 받아 hub_scope 분리 (별도 RPC scope 사용).
  const visibleTabs = TABS;
  const renderActivityBar = () => (
    // z-50 — 펼친 panel(z-40) 위로. 활동 바 항상 클릭 가능 + 다른 탭 즉시 전환.
    <div className="w-12 bg-white flex flex-col items-center py-3 gap-2 shrink-0 border-r border-slate-200 relative z-50">
      {visibleTabs.map(t => {
        const isActive = tab === t.id && !collapsed;
        const Icon = t.Icon;
        const button = (
          <button
            key={t.id}
            type="button"
            onClick={() => toggleTab(t.id)}
            className={`relative p-2 rounded-lg transition-colors ${
              isActive
                ? 'bg-slate-800 text-white'
                : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'
            }`}
            aria-label={t.tooltip}
          >
            <Icon size={18} className="w-[18px] h-[18px] shrink-0" />
            {t.id === 'chats' && conversations.length > 0 && !isActive && (
              <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 bg-blue-500 text-white text-[8px] font-black rounded-full flex items-center justify-center">
                {conversations.length > 9 ? '9+' : conversations.length}
              </span>
            )}
          </button>
        );
        // 활성 탭(panel 펼친 상태)은 tooltip 표시하지 않음 — 헤더에 라벨 이미 노출 + 펼침 상태에서 hover 시 잔영 회피.
        return isActive ? button : (
          <Tooltip key={t.id} label={t.tooltip} side="right">
            {button}
          </Tooltip>
        );
      })}
      <div className="flex-1" />
      {/* Hub page mode = 익명 방문자 → settings 진입 금지 */}
      {onOpenSettings && !hubMode && (
        <Tooltip label={t('common.settings')} side="right">
          <button
            type="button"
            onClick={() => { onOpenSettings(); if (isMobile) closeSidebar(); }}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
          >
            <Settings size={18} />
          </button>
        </Tooltip>
      )}
      {isMobile && (
        <Tooltip label={t('sidebar_actions.close_sidebar')} side="right">
          <button
            type="button"
            onClick={closeSidebar}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
          >
            <PanelLeftClose size={18} />
          </button>
        </Tooltip>
      )}
    </div>
  );

  /* ── Panel 헤더 — 활성 탭 아이콘 + 타이틀 + 접기 (PC 한정). ── */
  const renderPanelHeader = () => (
    <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200/80 shrink-0">
      {/* width/height fixed — svg path 따라 폭 변동 + 옆 텍스트 layout shift (떨림) 방지 */}
      <ActiveIcon size={15} className="w-[15px] h-[15px] text-slate-700 shrink-0" />
      <span className="text-sm font-semibold text-slate-800 truncate flex-1 antialiased">{activeTab.label}</span>
      {!isMobile && (
        <Tooltip label={t('sidebar_actions.collapse_panel')}>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
            aria-label="패널 접기"
          >
            <PanelLeftClose size={15} />
          </button>
        </Tooltip>
      )}
    </div>
  );

  /* ── Panel 본문 — 탭별 컨텐츠. PC·모바일 공통으로 재사용. ── */
  const panelBody = (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      {tab === 'gallery' ? (
        <GalleryPanel hubMode={hubMode} hubContext={hubShareContext} />
      ) : tab === 'templates' ? (
        <TemplatesPanel onEditFile={onEditFile} hubMode={hubMode} hubContext={hubShareContext} />
      ) : tab === 'library' ? (
        <LibraryPanel hubContext={hubShareContext} />
      ) : tab === 'entities' ? (
        <EntitiesPanel hubMode={hubMode} hubContext={hubShareContext} />
      ) : tab === 'notes' ? (
        <NotesPanel hubMode={hubMode} hubContext={hubShareContext} />
      ) : tab === 'calendar' ? (
        <CalendarPanel hubMode={hubMode} hubContext={hubShareContext} />
      ) : tab === 'workspace' ? (
        <div className="flex flex-col h-full overflow-y-auto overscroll-contain">

          {/* ── CRON JOBS 섹션 ── */}
          <CronPanel hubMode={hubMode} hubContext={hubShareContext} />

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
                          if (hoverNone) {
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
                            <Tooltip label={t('common.open')}>
                              <button
                                onClick={(e) => { e.stopPropagation(); window.open(`/${mainSlug}`, '_blank'); setSelectedItem(null); }}
                                className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                              >
                                <ExternalLink size={11} />
                              </button>
                            </Tooltip>
                          )}
                          <div className="relative">
                            <Tooltip label={t('common.more')}>
                              <button
                                ref={openMenu === `proj:${mp.name}` ? triggerRef : undefined}
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
                              <AnchoredMenu anchorRef={triggerRef} onClose={() => setOpenMenu(null)} minWidth={144}>
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
                              </AnchoredMenu>
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
                                    if (hoverNone) {
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
                                    <Tooltip label={t('common.open')}>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); window.open(`/${pg.slug}`, '_blank'); setSelectedItem(null); }}
                                        className="p-0.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors"
                                      >
                                        <ExternalLink size={10} />
                                      </button>
                                    </Tooltip>
                                    <div className="relative">
                                      <Tooltip label={t('common.more')}>
                                        <button
                                          ref={openMenu === `page:${pg.slug}` ? triggerRef : undefined}
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
                                        <AnchoredMenu anchorRef={triggerRef} onClose={() => setOpenMenu(null)} minWidth={128}>
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
                                        </AnchoredMenu>
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
                                    if (hoverNone) {
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
                                    {!hoverNone && (
                                      <Tooltip label={t('common.edit')}>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleOpenModule(p); setSelectedItem(null); }}
                                          className="p-0.5 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 active:bg-amber-100 transition-colors"
                                        >
                                          <Pencil size={10} />
                                        </button>
                                      </Tooltip>
                                    )}
                                    <div className="relative">
                                      <Tooltip label={t('common.more')}>
                                        <button
                                          ref={openMenu === `mod:${p}` ? triggerRef : undefined}
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
                                        <AnchoredMenu anchorRef={triggerRef} onClose={() => setOpenMenu(null)} minWidth={112}>
                                          {hoverNone && (
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
                                        </AnchoredMenu>
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
                      if (hoverNone) {
                        setSelectedItem(convSelected ? null : `conv:${conv.id}`);
                      }
                      onSelectConv(conv.id);
                      if (isMobile) closeSidebar(); // 모바일: 대화 선택 시 사이드바 접힘
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
                    {/* 공유·정리·삭제 아이콘 묶음: PC=호버, 모바일=선택 시 (활성 대화도 force visible) */}
                    <span className={rowActionsClass(convSelected || conv.id === activeConvId)}>
                      <ShareConvButton
                        convId={conv.id}
                        title={conv.title}
                        liveMessages={conv.id === activeConvId ? activeMessages : undefined}
                        hubShareContext={hubShareContext}
                      />
                      <Tooltip label="Recall 에 정리하기 (entity / fact / event 추출)">
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              const data = await apiPost<{ success?: boolean; saved?: { entities: unknown[]; facts: unknown[]; events: unknown[] }; skipped?: number; error?: string }>(
                                '/api/consolidate',
                                { conversationId: conv.id },
                                { category: 'sidebar' },
                              );
                              if (!data?.success) {
                                await alertDialog({ title: '정리 실패', message: data?.error ?? '알 수 없는 오류', danger: true });
                                return;
                              }
                              const s = data.saved!;
                              const lines = [
                                `엔티티 ${s.entities.length}개`,
                                `사실 ${s.facts.length}개`,
                                `사건 ${s.events.length}개`,
                              ];
                              if (data.skipped) lines.push(`(skipped ${data.skipped})`);
                              await alertDialog({ title: '정리 완료', message: lines.join('\n') });
                            } catch (err: any) {
                              await alertDialog({ title: '정리 실패', message: err?.message ?? String(err), danger: true });
                            }
                          }}
                          className="p-1 text-slate-400 hover:text-purple-600 hover:bg-purple-50 active:bg-purple-100 rounded transition-colors"
                          aria-label="Recall 에 정리하기"
                        >
                          <Sparkles size={11} />
                        </button>
                      </Tooltip>
                      <Tooltip label={t('common.delete')}>
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
            {/* ── 휴지통 섹션 — 30일 retention. 복원 / 영구 삭제 가능. ── */}
            <div className="mt-2 border-t border-slate-200/60 pt-1">
              <button
                onClick={() => setTrashOpen(o => !o)}
                className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-bold tracking-widest text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded transition-colors"
              >
                <span className="flex items-center gap-1.5">
                  <Trash2 size={11} /> 휴지통
                  {trashConvs.length > 0 && (
                    <span className="px-1.5 py-0.5 bg-slate-200 text-slate-600 text-[9px] font-black rounded-full">
                      {trashConvs.length > 9 ? '9+' : trashConvs.length}
                    </span>
                  )}
                </span>
                {trashOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              </button>
              {trashOpen && (
                <div className="px-1 pb-2 space-y-0.5">
                  {trashConvs.length === 0 && (
                    <p className="text-[11px] text-slate-400 text-center py-3">휴지통이 비어있습니다.</p>
                  )}
                  {trashConvs.map(conv => (
                    <div
                      key={conv.id}
                      className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-50 border border-transparent"
                    >
                      <Trash2 size={11} className="mt-0.5 shrink-0 text-slate-400" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium truncate text-slate-600">{conv.title}</p>
                        <p className="text-[10px] text-slate-400 mt-0.5">30일 후 자동 삭제</p>
                      </div>
                      <span className={rowActionsClass(true)}>
                        <Tooltip label={t('common.restore')}>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleRestoreConv(conv.id); }}
                            className="p-1 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 active:bg-emerald-100 rounded transition-colors"
                          >
                            <RotateCcw size={11} />
                          </button>
                        </Tooltip>
                        <Tooltip label={t('sidebar_actions.permanent_delete')}>
                          <button
                            onClick={(e) => { e.stopPropagation(); handlePermanentDeleteConv(conv.id, conv.title); }}
                            className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 rounded transition-colors"
                          >
                            <X size={11} />
                          </button>
                        </Tooltip>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  /* ── 외부 모달들 (FileEditor, ScheduleModal, 이름변경, 비밀번호) — PC·모바일 공통. ── */
  const externalModals = (
    <>
      {/* PageSpec 에디터 모달 — 모바일도 마운트(FileEditor 내부 isMobileDevice 가 PC 안내 표시) — 템플릿 편집과 일관 */}
      {editingPageSlug && (
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
              <label htmlFor={renameInputId} className="sr-only">{renameTarget.type === 'page' ? '새 slug' : '새 프로젝트 이름'}</label>
              <input
                type="text"
                value={renameInput}
                onChange={e => setRenameInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !renaming) submitRename(); }}
                placeholder={renameTarget.type === 'page' ? '새 slug' : '새 프로젝트 이름'}
                autoFocus
                disabled={renaming}
                aria-label={renameTarget.type === 'page' ? '새 slug' : '새 프로젝트 이름'}
                className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-100" name="renameInput" autoComplete="off" id={renameInputId}
              />
              <label className="flex items-center gap-2 text-[12px] text-slate-700 cursor-pointer" htmlFor={renameSetRedirectId}>
                <input type="checkbox" checked={renameSetRedirect} onChange={e => setRenameSetRedirect(e.target.checked)} disabled={renaming} name="renameSetRedirect" autoComplete="off" id={renameSetRedirectId} />
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

  /* ── 모바일: mobileOpen=false → 아무것도 렌더 X (activity bar 도 숨김). ── */
  if (isMobile && !mobileOpen) return null;

  /* ── 모바일: activity bar + panel 같이 fixed slide-in. ── */
  if (isMobile) {
    return (
      <>
        <div
          className="fixed top-12 inset-x-0 bottom-0 bg-black/30 z-30 touch-none"
          onClick={closeSidebar}
        />
        <div className="fixed top-12 bottom-0 left-0 z-40 flex shadow-lg">
          {renderActivityBar()}
          {!collapsed && (
            <div className="w-72 bg-white flex flex-col shrink-0 overflow-hidden border-r border-slate-200">
              {renderPanelHeader()}
              {panelBody}
            </div>
          )}
        </div>
        {externalModals}
      </>
    );
  }

  /* ── PC: activity bar inline + panel fixed. invisible backdrop — chat 영역 click 시 close. ── */
  return (
    <>
      {renderActivityBar()}
      {/* PC: 패널이 열려 있어도 채팅 스크롤·입력 가능 — 옛 invisible click-catcher(채팅 영역 전체를
          fixed 로 덮어 외부클릭 자동닫힘)가 채팅 스크롤·입력을 가로채던 것 제거. 패널 닫기는 활동 바 탭 재클릭. */}
      {!collapsed && (
        <div className="fixed top-12 bottom-0 left-12 z-40 w-72 bg-white flex flex-col shrink-0 overflow-hidden border-r border-slate-200 shadow-lg">
          {renderPanelHeader()}
          {panelBody}
        </div>
      )}
      {externalModals}
    </>
  );
}

/** 대화 전체 공유 버튼 — 클릭 시 DB 에서 메시지 fetch → 공유 생성 → 클립보드 복사 */
function ShareConvButton({ convId, title, liveMessages, hubShareContext }: { convId: string; title: string; liveMessages?: unknown[]; hubShareContext?: { slug: string; apiToken: string; sessionId: string } }) {
  const t = useTranslations();
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
        const convData = await apiGet<{ success: boolean; conversation?: { messages?: Array<{ id?: string }> } }>(
          `/api/conversations?id=${encodeURIComponent(convId)}`,
          { category: 'sidebar' },
        ).catch(() => null);
        if (!convData?.success || !convData.conversation) {
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
      const shareRes = await createShareLink({ type: 'full', conversationId: convId, title, messages, dedupKey, hubContext: hubShareContext });
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
      <Tooltip label={t('sidebar_actions.share_conversation')}>
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

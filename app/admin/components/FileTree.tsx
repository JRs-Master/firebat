'use client';
import React, { useState } from 'react';
import {
  Folder, FolderOpen, FileText,
  ChevronRight, ChevronDown,
  ExternalLink, Trash2, Loader2, Pencil,
} from 'lucide-react';

export interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

interface FileTreeProps {
  data: TreeNode[];
  onRefresh?: () => void;
  onEdit?: (path: string) => void;
}

// app/(user)/bmi-calculator/page.tsx → /bmi-calculator
function toPageUrl(filePath: string): string | null {
  const m = filePath.match(/^app\/\(user\)\/([^/]+)\/page\.tsx$/);
  return m ? `/${m[1]}` : null;
}

// 삭제 가능 여부: app/(user)/ 또는 user/ 하위만
function isDeletable(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return n.startsWith('app/(user)/') || n.startsWith('user/');
}

interface NodeProps {
  node: TreeNode;
  depth: number;
  onRefresh?: () => void;
  onEdit?: (path: string) => void;
}

const TreeNodeComponent = ({ node, depth, onRefresh, onEdit }: NodeProps) => {
  const [isOpen, setIsOpen] = useState(depth < 2);
  const [deleting, setDeleting] = useState(false);

  const pageUrl = !node.isDirectory ? toPageUrl(node.path) : null;
  const canDelete = isDeletable(node.path);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const label = node.isDirectory ? `폴더 "${node.name}"` : `파일 "${node.name}"`;
    if (!confirm(`${label}을(를) 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/fs/delete?path=${encodeURIComponent(node.path)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) onRefresh?.();
      else alert(`삭제 실패: ${data.error}`);
    } catch (err: any) {
      alert(`삭제 실패: ${err.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pageUrl) window.open(pageUrl, '_blank');
  };

  return (
    <div className="text-[13px] font-sans font-medium whitespace-nowrap">
      <div
        className="flex items-center py-1.5 px-2 hover:bg-slate-200/50 rounded cursor-pointer text-slate-700 transition-colors select-none group"
        onClick={() => node.isDirectory && setIsOpen(!isOpen)}
      >
        {/* 화살표 */}
        <span className="w-4 h-4 mr-1 flex-shrink-0 flex items-center justify-center opacity-60 text-slate-500">
          {node.isDirectory
            ? (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
            : null}
        </span>

        {/* 아이콘 */}
        <span className="mr-2 text-blue-500 flex-shrink-0">
          {node.isDirectory
            ? (isOpen
                ? <FolderOpen size={16} className="fill-blue-100" />
                : <Folder size={16} className="fill-blue-50" />)
            : <FileText size={15} className="text-slate-400 group-hover:text-blue-500 transition-colors" />}
        </span>

        {/* 이름 */}
        <span className="truncate flex-1 group-hover:text-slate-900 transition-colors min-w-0">
          {node.name}
        </span>

        {/* 액션 버튼 — 호버 시 노출 */}
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-1 flex-shrink-0">
          {/* 열기 (page.tsx만) */}
          {pageUrl && (
            <button
              onClick={handleOpen}
              className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title="브라우저에서 열기"
            >
              <ExternalLink size={12} />
            </button>
          )}

          {/* 편집 (파일만) */}
          {!node.isDirectory && canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit?.(node.path); }}
              className="p-1 rounded text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
              title="편집"
            >
              <Pencil size={12} />
            </button>
          )}

          {/* 삭제 */}
          {canDelete && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
              title="삭제"
            >
              {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            </button>
          )}
        </span>
      </div>

      {node.isDirectory && isOpen && node.children && (
        <div className="pl-4 ml-2 border-l border-slate-200 mt-0.5 space-y-0.5">
          {node.children.map((child, idx) => (
            <TreeNodeComponent
              key={`${child.path}-${idx}`}
              node={child}
              depth={depth + 1}
              onRefresh={onRefresh}
              onEdit={onEdit}
            />
          ))}
          {node.children.length === 0 && (
            <div className="py-1.5 px-2 text-[12px] text-slate-400 italic">Empty</div>
          )}
        </div>
      )}
    </div>
  );
};

export const FileTree = ({ data, onRefresh, onEdit }: FileTreeProps) => (
  <div className="w-full h-full overflow-auto bg-transparent p-3 text-slate-800 custom-scrollbar">
    {data.length === 0 ? (
      <div className="p-4 text-center text-slate-400 text-sm">No files found.</div>
    ) : (
      data.map((node, i) => (
        <TreeNodeComponent key={i} node={node} depth={0} onRefresh={onRefresh} onEdit={onEdit} />
      ))
    )}
  </div>
);

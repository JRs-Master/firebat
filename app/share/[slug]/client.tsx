'use client';

import { Ghost } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { ComponentRenderer } from '../../(user)/[...slug]/components';

// 공유 페이지 전용 읽기 전용 메시지 리스트. 어드민 MessageBubble 의 인터랙티브 요소
// (plan-confirm, pendingActions, suggestions, 복사·공유 버튼) 는 모두 제거 — 읽기만.

type ShareMessage = {
  id?: string;
  role?: 'user' | 'system';
  content?: string;
  image?: string;
  data?: { blocks?: Array<{ type: 'text' | 'html' | 'component'; text?: string; htmlContent?: string; htmlHeight?: string; name?: string; props?: Record<string, unknown> }> };
};

const mdComponents = {
  h1: (props: any) => <h1 className="text-[18px] font-bold text-slate-800 mt-5 mb-2" {...props} />,
  h2: (props: any) => <h2 className="text-[16px] font-bold text-slate-800 mt-4 mb-1.5" {...props} />,
  h3: (props: any) => <h3 className="text-[15px] font-bold text-slate-800 mt-3 mb-1" {...props} />,
  h4: (props: any) => <h4 className="text-[14px] font-bold text-slate-700 mt-2 mb-1" {...props} />,
  p: (props: any) => <p className="mb-2 last:mb-0" {...props} />,
  ul: (props: any) => <ul className="list-disc list-outside ml-5 mb-2 space-y-1" {...props} />,
  ol: (props: any) => <ol className="list-decimal list-outside ml-5 mb-2 space-y-1" {...props} />,
  li: (props: any) => <li className="pl-0.5" {...props} />,
  strong: (props: any) => <strong className="font-bold text-slate-900" {...props} />,
  a: (props: any) => <a className="text-blue-600 hover:text-blue-800 underline" target="_blank" rel="noopener noreferrer" {...props} />,
  code: ({ inline, className, children, ...props }: any) => {
    if (inline) return <code className="px-1.5 py-0.5 bg-slate-100 text-slate-700 rounded text-[13px] font-mono" {...props}>{children}</code>;
    return <pre className="bg-slate-50 text-slate-800 p-4 overflow-x-auto text-[13px] font-mono rounded-xl border border-slate-200"><code {...props}>{children}</code></pre>;
  },
  blockquote: (props: any) => <blockquote className="border-l-3 border-slate-300 pl-3 text-slate-600 italic mb-2" {...props} />,
  table: (props: any) => (
    <div className="overflow-auto mb-2 rounded-xl border border-slate-200">
      <table className="min-w-full text-[13px] border-separate border-spacing-0" {...props} />
    </div>
  ),
  th: (props: any) => <th className="bg-slate-50 px-3 py-1.5 text-left font-bold text-slate-700 sticky top-0 z-10 border-b border-slate-200 min-w-[120px]" {...props} />,
  td: (props: any) => <td className="px-3 py-1.5 text-slate-600 border-b border-slate-100 min-w-[120px] align-top break-words" {...props} />,
};

function MessageRow({ msg }: { msg: ShareMessage }) {
  if (msg.role === 'user') {
    return (
      <div className="flex w-full gap-4 items-start justify-end">
        <div className="flex flex-col gap-2 max-w-[75%] items-end">
          {msg.image && (
            <img src={msg.image} alt="첨부" className="max-w-[240px] max-h-[180px] rounded-2xl border border-slate-300 shadow-md object-cover" />
          )}
          <div className="bg-slate-800 text-white px-4 py-3 sm:px-6 sm:py-4 rounded-3xl rounded-tr-sm shadow-md text-[14px] sm:text-[15.5px] leading-relaxed break-words border border-slate-700 w-fit">
            {msg.content}
          </div>
        </div>
      </div>
    );
  }
  // system (AI) 메시지 — blocks 우선, 없으면 content
  const blocks = msg.data?.blocks;
  return (
    <div className="flex w-full gap-2 sm:gap-4 items-start">
      <div className="hidden sm:flex w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-50 to-blue-100 border border-blue-200 items-center justify-center shadow-sm shrink-0">
        <Ghost size={22} className="text-blue-600" />
      </div>
      <div className="flex flex-col gap-3 flex-1 min-w-0 sm:pt-3">
        {Array.isArray(blocks) && blocks.length > 0 ? (
          blocks.map((b, i) => {
            if (b.type === 'text' && b.text) {
              return (
                <div key={i} className="text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={mdComponents}>{b.text}</ReactMarkdown>
                </div>
              );
            }
            if (b.type === 'html' && b.htmlContent) {
              // iframe 렌더 — 공유 페이지에서도 동일 sandbox 적용
              return (
                <iframe
                  key={i}
                  srcDoc={b.htmlContent}
                  sandbox="allow-scripts"
                  className="w-full border border-slate-200 rounded-xl bg-white block"
                  style={{ height: b.htmlHeight || '400px' }}
                  title="Shared HTML"
                />
              );
            }
            if (b.type === 'component' && b.name) {
              return <ComponentRenderer key={i} components={[{ type: b.name, props: b.props || {} }]} />;
            }
            return null;
          })
        ) : msg.content ? (
          <div className="text-slate-800 text-[14px] sm:text-[15px] leading-relaxed space-y-1">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={mdComponents}>{msg.content}</ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SharedMessageList({ messages }: { messages: unknown[] }) {
  const msgs = (messages as ShareMessage[]).filter(m => m && m.id !== 'system-init' && (m.role === 'user' || m.role === 'system'));
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-10">
      {msgs.map((m, i) => <MessageRow key={m.id || i} msg={m} />)}
    </div>
  );
}

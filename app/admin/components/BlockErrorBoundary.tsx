'use client';

/**
 * BlockErrorBoundary — 메시지 본문의 단일 block 렌더링 throw 격리.
 *
 * 배경: 한 메시지에 20+ render_* blocks (Table / Chart / Grid / Compare / Timeline 등 nested)
 * 가 박힐 수 있고, AI 가 발행한 props 의 invalid 값 (NaN / null array / type mismatch 등) 으로
 * 한 block 이 throw 하면 React 가 부모 tree 통째 unmount → admin 전역이 error.tsx 로 fallback →
 * 사용자가 admin 접근 불능. 격리 박아 그 block 만 inline 에러 카드로 표시.
 *
 * Class component (componentDidCatch 가 hook 미지원) 이지만 'use client' 환경이라 정상 작동.
 */
import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: ReactNode;
  /** 디버깅용 라벨 — block name / index 등. 에러 카드에 표시 + 콘솔 출력. */
  label?: string;
}

interface State {
  error: Error | null;
}

export class BlockErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 진단용 — 콘솔에 label / error / componentStack 출력. root cause 추적 시 활용.
    console.error('[BlockErrorBoundary]', this.props.label ?? 'block', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 text-[12px] text-amber-800 flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="flex-1 min-w-0">
          <div className="font-bold">이 항목 표시 중 문제 발생</div>
          <div className="text-[11px] text-amber-700 mt-0.5 truncate">
            {this.props.label ? `${this.props.label} — ` : ''}
            {this.state.error.message || String(this.state.error)}
          </div>
        </div>
        <button
          onClick={this.reset}
          className="text-[11px] font-bold text-amber-700 hover:text-amber-900 underline shrink-0"
        >
          재시도
        </button>
      </div>
    );
  }
}

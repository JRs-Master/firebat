'use client';

/**
 * ErrorBoundary — React class component 기반 자체 boundary.
 *
 * SettingsModal 같은 sub-tree throw 가 admin tree 통째로 reset 박지 않게 격리.
 * `app/admin/error.tsx` (admin route boundary) 보다 우선 catch — 자식 throw 시
 * 자체 fallback UI 표시 + 사이드바 영향 0.
 *
 * 사용:
 *   <ErrorBoundary>
 *     <SettingsModalInner {...props} />
 *   </ErrorBoundary>
 *
 * fallback prop 으로 커스텀 UI 가능. reset 호출 시 자식 재마운트.
 */
import React from 'react';

interface State {
  hasError: boolean;
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
  /** throw 발생 시 호출 — Sentry / 로그 전송 등. */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    if (typeof console !== 'undefined') {
      console.error('[ErrorBoundary]', error, info.componentStack);
    }
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }
      // Default fallback — 작은 영역 친화 (modal 안 등)
      return (
        <div className="p-6 text-center bg-red-50 border border-red-200 rounded-lg m-4">
          <div className="text-3xl font-extrabold text-red-600 mb-2">!</div>
          <h2 className="text-base font-bold text-slate-800 mb-1">문제가 발생했습니다</h2>
          <p className="text-xs text-slate-600 mb-3 break-all">{this.state.error.message}</p>
          <button
            type="button"
            onClick={this.reset}
            className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm font-medium transition-colors"
          >
            다시 시도
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

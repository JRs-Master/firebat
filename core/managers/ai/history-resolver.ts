/**
 * HistoryResolver — Function Calling 멀티턴 히스토리 조립 + 자동 search_history 주입.
 *
 * AiManager 의 내부 collaborator (외부 import 금지).
 *
 * 책임:
 *   - 사용자 발화 + 대화 컨텍스트 → 벡터 검색 spread 판정.
 *   - 신호 강하면 (top1 vs top5 spread ≥ MIN_SPREAD): 매칭 메시지 contextSummary 로 주입.
 *   - 신호 약하면: 빈 contextSummary 반환 → AI 가 명시적 search_history 호출 또는 사용자에게 역질문.
 *
 * 분리 이유: 검색 spread 판정 + 주입 결정 로직이 prompt build 와 독립. 단위 테스트 용이.
 *
 * 일반 로직: query·history·owner 받아 결정 — 도메인별 분기 0.
 */
import type { FirebatCore } from '../../index';
import type { ChatMessage } from '../../ports';

const MIN_SPREAD = 0.030;       // top1 vs top5 차이 — 이 이하면 신호 없음
const CLUSTER_GAP = 0.020;      // top1 에서 떨어져도 함께 picked 되는 거리
const SEARCH_LIMIT = 10;        // 후보 수
const PICK_MAX = 5;             // 최종 picked 최대

export interface HistoryResolveResult {
  recentHistory: ChatMessage[];
  contextSummary: string;
}

export class HistoryResolver {
  constructor(private readonly core: FirebatCore) {}

  /**
   * Function Calling 용 히스토리 조립 — 벡터 검색 단일 경로.
   *
   * 기본: recent window 0 (이전 턴 메시지 안 남김). 모든 문맥은 벡터 검색으로 인출.
   *
   * 효과:
   *   - topic-shift 쿼리("하이", "다른 거") → 이전 턴 흔적 0
   *   - 의미 연속 쿼리("이어서 삼성전자", "또 그거") → 벡터 검색 원문 인출
   *   - 중복 주입 방지 (recent + HistorySearch 이중 유입 차단)
   *
   * 모호한 쿼리("또", "이어서"만)는 spread 약함 → 주입 0 → AI 가 유저에게 역질문.
   */
  async compressHistoryWithSearch(
    history: ChatMessage[],
    userPrompt: string,
    opts: { owner?: string; currentConvId?: string },
  ): Promise<HistoryResolveResult> {
    const recentHistory: ChatMessage[] = [];
    if (!userPrompt.trim() || !opts.owner) return { recentHistory, contextSummary: '' };

    // 벡터 검색 — minScore=0 으로 전체 받아 spread 판정
    const searchRes = await this.core.searchConversationHistory(opts.owner, userPrompt, {
      currentConvId: opts.currentConvId,
      limit: SEARCH_LIMIT,
      minScore: 0,
    });

    if (!searchRes.success || !searchRes.data || searchRes.data.length === 0) {
      return { recentHistory, contextSummary: '' };
    }

    // 상대 스코어링: top1 - top5 spread 미만이면 신호 없음
    const matches = searchRes.data;
    const top1 = matches[0]?.score ?? 0;
    const refIdx = Math.min(4, matches.length - 1);
    const refScore = matches[refIdx]?.score ?? top1;
    const spread = top1 - refScore;

    if (spread < MIN_SPREAD) {
      process.stderr.write(`[HistorySearch] query="${userPrompt.slice(0, 40)}" matches=${matches.length} spread=${spread.toFixed(3)} → 신호없음\n`);
      return { recentHistory, contextSummary: '' };
    }

    const cutoff = top1 - CLUSTER_GAP;
    const picked = matches.filter(m => m.score >= cutoff).slice(0, PICK_MAX);
    if (picked.length === 0) return { recentHistory, contextSummary: '' };

    process.stderr.write(`[HistorySearch] query="${userPrompt.slice(0, 40)}" spread=${spread.toFixed(3)} pick=${picked.length}개\n`);

    const contextSummary = `[관련 과거 대화 (${picked.length}개 매칭)]\n` +
      picked.map(m => {
        const roleLabel = m.role === 'user' ? '사용자' : 'AI';
        const preview = (m.contentPreview || '').slice(0, 200);
        return `[${roleLabel}]: ${preview}`;
      }).join('\n');

    return { recentHistory, contextSummary };
  }
}

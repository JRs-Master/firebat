/**
 * CostManager — LLM 호출의 token 사용량·비용 누적 추적.
 *
 * 일반 인프라 (도메인 무관) — 어떤 LLM 호출이든 같은 형식으로 기록.
 *
 * 데이터 구조:
 *   - 메모리: 일별·모델별 합계 (Map<dateKey, Map<model, AggregateRecord>>)
 *   - Vault 영속: 매 호출 시 또는 주기적 flush. 키 = `system:llm-cost:YYYY-MM-DD` JSON
 *   - 누적은 ISO 일자 단위 (KST 기준) — 사용자 타임존 따라 변환 후 dateKey
 *
 * 가격 산정:
 *   - 어댑터가 costUsd 직접 계산해서 보내면 그대로 사용 (정확)
 *   - 미설정 시 model 의 pricing config 으로 산정 (input·output per 1M tokens)
 *   - 가격 정보 없는 모델 = cost 0 으로 기록 (token 만 추적)
 *
 * 통계:
 *   - 일별 합계 (특정 기간)
 *   - 모델별 합계 (특정 기간)
 *   - 전체 합계
 *
 * BIBLE 준수:
 *   - 매니저 SSE 발행 X — Core facade 가 호출 시점에 발행
 *   - Vault 직접 주입받음 (cross-domain 불필요)
 */
import type { IVaultPort, ILogPort, LlmTokenUsage } from '../ports';

/** 일일·모델 단위 누적 레코드 */
export interface CostAggregateRecord {
  /** ISO 일자 (YYYY-MM-DD) */
  date: string;
  /** 모델 식별자 */
  model: string;
  /** 호출 횟수 */
  calls: number;
  /** 누적 입력 토큰 */
  inputTokens: number;
  /** 누적 출력 토큰 */
  outputTokens: number;
  /** 누적 비용 USD (가격 정보 있는 모델만) */
  costUsd: number;
  /** 마지막 호출 시각 (epoch ms) — 디버깅·정렬 */
  lastCallAt: number;
}

/** 통계 조회 옵션 */
export interface CostStatsFilter {
  /** ISO 일자 (포함) */
  fromDate?: string;
  /** ISO 일자 (포함) */
  toDate?: string;
  /** 특정 모델만 */
  model?: string;
}

/** 기간 합계 */
export interface CostStatsSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** 일자별 + 모델별 raw 레코드 (UI 차트용) */
  records: CostAggregateRecord[];
}

const VAULT_KEY_PREFIX = 'system:llm-cost:';

export class CostManager {
  /** 메모리 캐시: dateKey → modelKey → record. Vault 가 영속 source. */
  private cache: Map<string, Map<string, CostAggregateRecord>> = new Map();
  /** 일자별 dirty 플래그 — flush 효율 */
  private dirtyDates = new Set<string>();
  /** 주기적 flush timer */
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** flush 간격 — 60초마다 메모리 → Vault */
  private static readonly FLUSH_INTERVAL_MS = 60_000;

  constructor(
    private vault: IVaultPort,
    private logger: ILogPort,
    /** Pricing lookup — 모델 식별자 → { inputPer1M, outputPer1M }.
     *  외부 (Core) 에서 LLM config 기반으로 주입. null 이면 cost 산정 불가. */
    private pricingLookup: (model: string) => { inputPer1M: number; outputPer1M: number } | null,
    /** dateKey 함수 — 사용자 타임존 기준 ISO 일자. 외부 주입 (timezone 의존성 회피). */
    private getDateKey: () => string,
  ) {
    // 주기적 flush — 60초마다 dirty 일자만 Vault 에 기록
    this.flushTimer = setInterval(() => this.flushDirty(), CostManager.FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      (this.flushTimer as { unref?: () => void }).unref?.();
    }
  }

  /** LLM 호출 1건 기록. 어댑터가 LlmToolResponse.usage 채우면 Core 가 이걸 호출. */
  recordCall(usage: LlmTokenUsage): void {
    if (!usage.model) return;  // model 없으면 추적 불가
    const date = this.getDateKey();
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    const cost = this.computeCost(usage);

    // 메모리 누적
    let dayMap = this.cache.get(date);
    if (!dayMap) { dayMap = new Map(); this.cache.set(date, dayMap); }
    let record = dayMap.get(usage.model);
    if (!record) {
      record = { date, model: usage.model, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastCallAt: 0 };
      dayMap.set(usage.model, record);
    }
    record.calls += 1;
    record.inputTokens += inputTokens;
    record.outputTokens += outputTokens;
    record.costUsd += cost;
    record.lastCallAt = Date.now();
    this.dirtyDates.add(date);
  }

  /** 통계 조회 — 메모리 + Vault 양쪽에서 모음. fromDate~toDate 범위 ISO 일자. */
  getStats(filter?: CostStatsFilter): CostStatsSummary {
    const records: CostAggregateRecord[] = [];
    // 1) 메모리 (가장 최신)
    for (const [date, dayMap] of this.cache) {
      if (!this.matchesDateFilter(date, filter)) continue;
      for (const rec of dayMap.values()) {
        if (filter?.model && rec.model !== filter.model) continue;
        records.push({ ...rec });
      }
    }
    // 2) Vault — 메모리에 없는 과거 일자
    if (filter?.fromDate || filter?.toDate) {
      const dates = this.iterateDateRange(filter.fromDate, filter.toDate);
      for (const date of dates) {
        if (this.cache.has(date)) continue;  // 메모리 우선
        const fromVault = this.loadFromVault(date);
        for (const rec of fromVault) {
          if (filter?.model && rec.model !== filter.model) continue;
          records.push(rec);
        }
      }
    }

    const summary: CostStatsSummary = {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
      records: records.sort((a, b) => b.date.localeCompare(a.date) || a.model.localeCompare(b.model)),
    };
    for (const r of records) {
      summary.totalCalls += r.calls;
      summary.totalInputTokens += r.inputTokens;
      summary.totalOutputTokens += r.outputTokens;
      summary.totalCostUsd += r.costUsd;
    }
    return summary;
  }

  /** 즉시 flush — 어드민 종료 또는 수동 호출 */
  async flushNow(): Promise<void> {
    this.flushDirty();
  }

  // ── Budget cap ────────────────────────────────────────────────────────

  /** 한도 조회 — Vault `system:cost:budget` JSON. 미설정 시 한도 없음 (모두 0).
   *  USD 한도는 API 모드 (pay-per-token) 차단용. calls 한도는 모든 모드 (CLI 구독 포함) 차단용. */
  async getBudget(): Promise<{ dailyUsd: number; monthlyUsd: number; dailyCalls: number; monthlyCalls: number; alertAtPercent: number }> {
    try {
      const raw = await this.vault.getSecret('system:cost:budget');
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          dailyUsd: Number(parsed.dailyUsd) || 0,
          monthlyUsd: Number(parsed.monthlyUsd) || 0,
          dailyCalls: Number(parsed.dailyCalls) || 0,
          monthlyCalls: Number(parsed.monthlyCalls) || 0,
          alertAtPercent: Number(parsed.alertAtPercent) || 80,
        };
      }
    } catch (e) {
      this.logger.debug(`[CostManager] budget Vault 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { dailyUsd: 0, monthlyUsd: 0, dailyCalls: 0, monthlyCalls: 0, alertAtPercent: 80 };
  }

  /** 한도 저장 — 0 = 무제한. */
  async setBudget(budget: { dailyUsd: number; monthlyUsd: number; dailyCalls: number; monthlyCalls: number; alertAtPercent: number }): Promise<void> {
    await this.vault.setSecret('system:cost:budget', JSON.stringify({
      dailyUsd: Math.max(0, Number(budget.dailyUsd) || 0),
      monthlyUsd: Math.max(0, Number(budget.monthlyUsd) || 0),
      dailyCalls: Math.max(0, Math.floor(Number(budget.dailyCalls) || 0)),
      monthlyCalls: Math.max(0, Math.floor(Number(budget.monthlyCalls) || 0)),
      alertAtPercent: Math.min(100, Math.max(1, Number(budget.alertAtPercent) || 80)),
    }));
  }

  /** 오늘·이달 누적 비용 + 호출 수 (메모리 + Vault). CLI 모드는 cost 0 이지만 calls 카운트. */
  async getCurrentSpend(): Promise<{ dailyUsd: number; monthlyUsd: number; dailyCalls: number; monthlyCalls: number; today: string; month: string }> {
    const today = this.getDateKey();  // YYYY-MM-DD
    const month = today.slice(0, 7);    // YYYY-MM
    const monthFrom = `${month}-01`;
    const monthTo = `${month}-31`;
    const stats = this.getStats({ fromDate: monthFrom, toDate: monthTo });
    let dailyUsd = 0;
    let monthlyUsd = 0;
    let dailyCalls = 0;
    let monthlyCalls = 0;
    for (const r of stats.records) {
      monthlyUsd += r.costUsd;
      monthlyCalls += r.calls;
      if (r.date === today) {
        dailyUsd += r.costUsd;
        dailyCalls += r.calls;
      }
    }
    return { dailyUsd, monthlyUsd, dailyCalls, monthlyCalls, today, month };
  }

  /** 한도 체크 — LLM 호출 직전. allowed=false 면 호출 거부. USD/calls 한도 중 하나라도 초과 시 차단. */
  async checkBudget(): Promise<{
    allowed: boolean;
    reason?: string;
    dailyUsd: number;
    monthlyUsd: number;
    dailyCalls: number;
    monthlyCalls: number;
    dailyLimitUsd: number;
    monthlyLimitUsd: number;
    dailyLimitCalls: number;
    monthlyLimitCalls: number;
  }> {
    const budget = await this.getBudget();
    const spend = await this.getCurrentSpend();
    const baseRet = {
      dailyUsd: spend.dailyUsd, monthlyUsd: spend.monthlyUsd,
      dailyCalls: spend.dailyCalls, monthlyCalls: spend.monthlyCalls,
      dailyLimitUsd: budget.dailyUsd, monthlyLimitUsd: budget.monthlyUsd,
      dailyLimitCalls: budget.dailyCalls, monthlyLimitCalls: budget.monthlyCalls,
    };
    // 한도 모두 0 = 무제한 → allowed
    if (budget.dailyUsd === 0 && budget.monthlyUsd === 0 && budget.dailyCalls === 0 && budget.monthlyCalls === 0) {
      return { allowed: true, ...baseRet };
    }
    if (budget.dailyUsd > 0 && spend.dailyUsd >= budget.dailyUsd) {
      return { allowed: false, reason: `일일 비용 한도 초과 ($${spend.dailyUsd.toFixed(2)} / $${budget.dailyUsd.toFixed(2)}). 한도 늘리거나 자정까지 대기.`, ...baseRet };
    }
    if (budget.monthlyUsd > 0 && spend.monthlyUsd >= budget.monthlyUsd) {
      return { allowed: false, reason: `월간 비용 한도 초과 ($${spend.monthlyUsd.toFixed(2)} / $${budget.monthlyUsd.toFixed(2)}). 한도 늘리거나 다음 달 대기.`, ...baseRet };
    }
    if (budget.dailyCalls > 0 && spend.dailyCalls >= budget.dailyCalls) {
      return { allowed: false, reason: `일일 호출 수 한도 초과 (${spend.dailyCalls} / ${budget.dailyCalls}). 한도 늘리거나 자정까지 대기.`, ...baseRet };
    }
    if (budget.monthlyCalls > 0 && spend.monthlyCalls >= budget.monthlyCalls) {
      return { allowed: false, reason: `월간 호출 수 한도 초과 (${spend.monthlyCalls} / ${budget.monthlyCalls}). 한도 늘리거나 다음 달 대기.`, ...baseRet };
    }
    return { allowed: true, ...baseRet };
  }

  /** 테스트·셧다운용 — flush timer 정리 */
  shutdown(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushDirty();  // 종료 직전 마지막 flush
  }

  // ── Private ────────────────────────────────────────────────────────────

  private computeCost(usage: LlmTokenUsage): number {
    if (typeof usage.costUsd === 'number') return usage.costUsd;
    if (!usage.model) return 0;
    const pricing = this.pricingLookup(usage.model);
    if (!pricing) return 0;
    const input = (usage.inputTokens ?? 0) * pricing.inputPer1M / 1_000_000;
    const output = (usage.outputTokens ?? 0) * pricing.outputPer1M / 1_000_000;
    return input + output;
  }

  private matchesDateFilter(date: string, filter?: CostStatsFilter): boolean {
    if (!filter) return true;
    if (filter.fromDate && date < filter.fromDate) return false;
    if (filter.toDate && date > filter.toDate) return false;
    return true;
  }

  /** ISO 일자 fromDate ~ toDate 사이 모든 일자 yield (둘 다 포함) */
  private iterateDateRange(from?: string, to?: string): string[] {
    const today = this.getDateKey();
    const start = from ?? today;
    const end = to ?? today;
    if (start > end) return [];
    const dates: string[] = [];
    let cur = start;
    while (cur <= end) {
      dates.push(cur);
      cur = this.addOneDay(cur);
      if (dates.length > 366) break;  // 1년 cap (방어)
    }
    return dates;
  }

  private addOneDay(isoDate: string): string {
    const d = new Date(isoDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  /** Vault 에서 일자별 records 로드 */
  private loadFromVault(date: string): CostAggregateRecord[] {
    const raw = this.vault.getSecret(`${VAULT_KEY_PREFIX}${date}`);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as CostAggregateRecord[];
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      this.logger.warn(`[CostManager] Vault 파싱 실패: ${date}`);
      return [];
    }
  }

  /** Dirty 일자만 Vault 에 기록 */
  private flushDirty(): void {
    if (this.dirtyDates.size === 0) return;
    for (const date of this.dirtyDates) {
      const dayMap = this.cache.get(date);
      if (!dayMap) continue;
      const records = Array.from(dayMap.values());
      try {
        this.vault.setSecret(`${VAULT_KEY_PREFIX}${date}`, JSON.stringify(records));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`[CostManager] Vault flush 실패 ${date}: ${msg}`);
      }
    }
    this.dirtyDates.clear();
  }
}

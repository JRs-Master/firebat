/**
 * ToolManager — 도구 등록·dispatch 단일 source.
 *
 * 배경 (CLAUDE.md "ToolManager 도입 — v1.0 계획"):
 *   현재 도구 정의가 4 곳 분산:
 *     - AiManager.buildToolDefinitions (Function Calling 용)
 *     - mcp/server.ts (외부 LLM 용 MCP 서버)
 *     - SDK in sandbox (향후 — 자동 reflection 대상)
 *     - AiManager.executeToolCall (300줄 switch dispatch)
 *
 *   ToolManager 가 한 곳에 응집:
 *     1. registry: Map<name, ToolDefinition> — 도구 정의 source of truth
 *     2. buildAiToolDefinitions / buildMcpToolDescriptions / buildSdkTypes — transport 별 빌드
 *     3. execute(name, args, ctx) — 통합 dispatch (Strategy 패턴)
 *     4. 자동 reflection — config.json 변경 감지 → registry 갱신
 *
 * Step 1 (현재): backbone 만 — registry + register/unregister/get/list/execute + Core facade.
 *   기존 AiManager.executeToolCall 은 무수정 (마이그레이션은 Step 4).
 *
 * Step 2~4 (후속):
 *   - Step 2: 정적 render_* / Core 도구 등록
 *   - Step 3: 동적 sysmod_* + mcp_* 자동 reflection
 *   - Step 4: AiManager.executeToolCall switch 분산 → ToolManager.execute 위임
 *
 * BIBLE 준수:
 *   - SSE 발행 X (Core facade 의 책임)
 *   - 매니저 직접 호출 X — handler 안에서 Core 참조 통해 다른 매니저 접근
 */
import type { ILogPort } from '../ports';

/** 도구 카테고리 — AI 프롬프트 생성·UI 그루핑·필터에 활용 */
export type ToolSource = 'static' | 'sysmod' | 'mcp' | 'render' | 'meta';

/** 도구 호출 컨텍스트 — handler 가 사용 (대화 ID·owner·요청 옵션 등) */
export interface ToolExecuteContext {
  /** 현재 대화 ID (search_history·complete_plan 등에서 사용) */
  conversationId?: string;
  /** 대화 소유자 (search_history 권한) */
  owner?: string;
  /** AI 요청 원본 옵션 (모델·thinking 강도 등) */
  requestOpts?: Record<string, unknown>;
  /** 그 외 도메인별 컨텍스트 — handler 가 자유 활용 */
  meta?: Record<string, unknown>;
}

/** 도구 호출 결과 — Record 형태 (LLM 에 그대로 전달 가능). 실패는 success:false + error */
export type ToolExecuteResult = Record<string, unknown>;

/** 도구 핸들러 — 인자·컨텍스트 받아 결과 반환 */
export type ToolHandler = (args: Record<string, unknown>, ctx: ToolExecuteContext) => Promise<ToolExecuteResult>;

/** 도구 정의 — registry 의 entry */
export interface ToolDefinition {
  /** 도구 이름 (Function Calling tool name + MCP tool name 동일) */
  name: string;
  /** 카테고리 — 라우팅·UI 그루핑 */
  source: ToolSource;
  /** AI·MCP description (도구 선택 시 LLM 에 노출) */
  description: string;
  /** JSON Schema 형태 인자 정의 — Function Calling 의 parameters */
  parameters: Record<string, unknown>;
  /** dispatch 호출 시 실행 함수 */
  handler: ToolHandler;
  /** 비활성 가능 (모듈 on/off 토글 등) — false 면 list/execute 에서 자동 제외 */
  enabled?: boolean;
  /** 추가 메타 — 도메인별 활용 (예: sysmod 의 path, mcp 의 server 명 등) */
  meta?: Record<string, unknown>;
}

/** list 필터 */
export interface ToolListFilter {
  source?: ToolSource | ToolSource[];
  /** 이름 prefix 매칭 (예: 'render_' / 'sysmod_') */
  namePrefix?: string;
  /** enabled !== false 만 (기본 true) */
  enabledOnly?: boolean;
}

export class ToolManager {
  /** name → ToolDefinition. 중복 register 시 덮어씀 (자동 reflection 시 갱신 가능) */
  private registry = new Map<string, ToolDefinition>();

  constructor(private logger: ILogPort) {}

  /** 도구 등록 (정적·동적 모두). 같은 이름 재등록 = 덮어씀. */
  register(def: ToolDefinition): void {
    if (this.registry.has(def.name)) {
      this.logger.debug(`[ToolManager] 도구 재등록 (덮어씀): ${def.name}`);
    }
    this.registry.set(def.name, { ...def, enabled: def.enabled ?? true });
  }

  /** 일괄 등록 — Step 2~3 에서 정적·동적 도구를 batch 로 추가 */
  registerMany(defs: ToolDefinition[]): void {
    for (const def of defs) this.register(def);
  }

  /** 도구 등록 해제 */
  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  /** 도구 정의 단일 조회 */
  get(name: string): ToolDefinition | null {
    return this.registry.get(name) ?? null;
  }

  /** 등록된 도구 목록 (필터 가능). 순서: 등록 순서 유지 */
  list(filter?: ToolListFilter): ToolDefinition[] {
    const all = Array.from(this.registry.values());
    const enabledOnly = filter?.enabledOnly !== false;  // default true
    const sources = filter?.source
      ? (Array.isArray(filter.source) ? filter.source : [filter.source])
      : null;
    return all.filter(def => {
      if (enabledOnly && def.enabled === false) return false;
      if (sources && !sources.includes(def.source)) return false;
      if (filter?.namePrefix && !def.name.startsWith(filter.namePrefix)) return false;
      return true;
    });
  }

  /** 도구 실행 — name·args·ctx 받아 handler 호출.
   *  registry 에 없으면 success:false. handler throw 도 catch. */
  async execute(name: string, args: Record<string, unknown>, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    const def = this.registry.get(name);
    if (!def) {
      return { success: false, error: `[ToolManager] 등록되지 않은 도구: ${name}` };
    }
    if (def.enabled === false) {
      return { success: false, error: `[ToolManager] 비활성 도구: ${name}` };
    }
    try {
      return await def.handler(args ?? {}, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[ToolManager] handler 실행 실패 (${name}): ${msg}`);
      return { success: false, error: msg };
    }
  }

  /** AI Function Calling 용 도구 정의 — askWithTools 에 그대로 전달 가능.
   *  handler 는 제외 (LLM 에 노출 X), name·description·parameters 만. */
  buildAiToolDefinitions(filter?: ToolListFilter): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    return this.list(filter).map(def => ({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    }));
  }

  /** MCP 서버 도구 description 빌드 — mcp/server.ts 등록 시 활용.
   *  Step 5 에서 mcp/server.ts 가 이 메서드 사용해 등록. */
  buildMcpToolDescriptions(filter?: ToolListFilter): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
    // 같은 형태 — 분리 가능성 대비 별도 메서드 (예: 향후 transport 별 schema 차이 대응)
    return this.buildAiToolDefinitions(filter);
  }

  /** 디버깅 — 등록된 도구 수 + 카테고리별 카운트 */
  getStats(): { total: number; bySource: Record<ToolSource, number>; disabled: number } {
    const bySource: Record<ToolSource, number> = { static: 0, sysmod: 0, mcp: 0, render: 0, meta: 0 };
    let disabled = 0;
    for (const def of this.registry.values()) {
      bySource[def.source] = (bySource[def.source] ?? 0) + 1;
      if (def.enabled === false) disabled++;
    }
    return { total: this.registry.size, bySource, disabled };
  }
}

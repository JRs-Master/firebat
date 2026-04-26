/**
 * ToolDispatcher — 도구 호출 사전 검증 + dispatch.
 *
 * AiManager 의 내부 collaborator (외부 import 금지).
 *
 * 책임:
 *   1. resolveCallTarget — AI 가 호출한 identifier (변형 포함) → 실제 dispatch target.
 *      MCP 서버명·system/user 모듈 경로 매칭. Core.resolveCallTarget 도 이 메서드 위임.
 *   2. executeToolCall — ToolManager 등록 도구 → render_* 변형 정규화 → resolveCallTarget 분기.
 *   3. checkNeedsApproval — schedule_task / write_file / save_page 등 사전 승인 필요 도구 식별.
 *   4. preValidatePendingArgs — 승인 대기 도구 인자 검증 (필수 필드 누락·잘못된 평면 인자 등).
 *
 * 분리 이유: dispatch 결정이 멀티턴 루프 본체와 독립. Core facade 가 직접 호출하는 resolveCallTarget 도 포함.
 *
 * 일반 로직: 도구별 enumerate 가 아닌 패턴 매칭 + 자동 정규화.
 */
import type { FirebatCore } from '../../index';
import type { AiRequestOpts } from '../../index';
import type { ToolCall } from '../../ports';
import { RENDER_TOOL_MAP, normalizeRenderName } from '../../../lib/render-map';

const CALL_TARGET_TTL = 60_000;

type CallTarget = { kind: 'mcp'; server: string } | { kind: 'execute'; path: string };

export class ToolDispatcher {
  private callTargetCache: { map: Map<string, CallTarget>; ts: number } | null = null;

  constructor(private readonly core: FirebatCore) {}

  /** Core.resolveCallTarget 이 위임 — AI 가 다양한 변형으로 호출해도 자동 매칭.
   *  매칭 우선순위: 정확한 이름 → snake/kebab 변형 → sysmod_ 접두사 / full path → null.
   *  60초 캐시 — listDir / listMcpServers 호출 비용 절감. */
  async resolveCallTarget(identifier: string): Promise<CallTarget | null> {
    if (!identifier) return null;
    const lookup = (id: string, map: Map<string, CallTarget>) =>
      map.get(id) ?? map.get(id.replace(/_/g, '-')) ?? map.get(id.replace(/-/g, '_'));
    if (this.callTargetCache && (Date.now() - this.callTargetCache.ts) < CALL_TARGET_TTL) {
      const hit = lookup(identifier, this.callTargetCache.map);
      if (hit !== undefined) return hit;
    }
    const map = new Map<string, CallTarget>();
    // 1) 외부 MCP 서버
    try {
      const mcpServers = this.core.listMcpServers();
      if (Array.isArray(mcpServers)) {
        for (const s of mcpServers) {
          if (!s?.name) continue;
          const target: CallTarget = { kind: 'mcp', server: s.name };
          map.set(s.name, target);
          map.set(s.name.replace(/-/g, '_'), target);
          map.set(s.name.replace(/_/g, '-'), target);
        }
      }
    } catch { /* MCP 미설정 무시 */ }
    // 2) system + user modules
    for (const dir of ['system/modules', 'user/modules']) {
      try {
        const ls = await this.core.listDir(dir);
        if (!ls.success || !ls.data) continue;
        for (const e of ls.data.filter(x => x.isDirectory)) {
          const path = `${dir}/${e.name}/index.mjs`;
          const target: CallTarget = { kind: 'execute', path };
          map.set(e.name, target);
          map.set(e.name.replace(/-/g, '_'), target);
          map.set(e.name.replace(/_/g, '-'), target);
          map.set(`sysmod_${e.name}`, target);
          map.set(`sysmod_${e.name.replace(/-/g, '_')}`, target);
          map.set(path, target);
        }
      } catch { /* 폴더 없음 무시 */ }
    }
    this.callTargetCache = { map, ts: Date.now() };
    return lookup(identifier, map) ?? null;
  }

  /** 단일 도구 호출 실행 — 결과를 Record<string, unknown>로 반환.
   *  순서: ToolManager 등록 도구 → render_* 변형 정규화 → resolveCallTarget (sysmod/mcp 자동 분기) → 알 수 없는 도구 에러. */
  async executeToolCall(tc: ToolCall, opts?: AiRequestOpts): Promise<Record<string, unknown>> {
    try {
      // 1) ToolManager 등록 도구 — 정적·동적 모두 단일 dispatch.
      if (this.core.getToolDefinition(tc.name)) {
        return await this.core.executeTool(tc.name, tc.args as Record<string, unknown>, {
          conversationId: opts?.conversationId,
          owner: opts?.owner,
          requestOpts: opts as Record<string, unknown> | undefined,
        });
      }
      // 2) render_* 변형 정규화 — AI 가 'table' / 'render-chart' 등으로 불러도 매칭.
      const renderName = normalizeRenderName(tc.name);
      if (renderName && RENDER_TOOL_MAP[renderName]) {
        return { success: true, component: RENDER_TOOL_MAP[renderName], props: tc.args as Record<string, unknown> };
      }
      // 3) 통합 resolver — sysmod / mcp 자동 분기.
      const target = await this.resolveCallTarget(tc.name);
      if (target?.kind === 'execute') {
        const res = await this.core.sandboxExecute(target.path, tc.args);
        if (!res.success) return { success: false, error: res.error };
        if (res.data?.success === false) return { success: false, error: JSON.stringify(res.data) };
        return { success: true, data: res.data };
      }
      // mcp_{server}_{tool} 접두사 — server/tool 분리.
      if (tc.name.startsWith('mcp_')) {
        const parts = tc.name.slice(4).split('_');
        const server = parts[0];
        const tool = parts.slice(1).join('_');
        const res = await this.core.callMcpTool(server, tool, tc.args);
        return res.success ? { success: true, data: res.data } : { success: false, error: res.error };
      }
      if (target?.kind === 'mcp') {
        return { success: false, error: `MCP 서버 '${target.server}' 호출 시 도구 이름 명시 필요 (예: mcp_${target.server}_{tool} 형태).` };
      }
      return { success: false, error: `알 수 없는 도구: ${tc.name}` };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /** 사전 승인 필요 여부 판정 — 되돌리기 어려운 작업만 user confirmation. 일반 로직, 도구별 분기 X.
   *  null 반환 = 즉시 실행 OK. { summary } = pending action 으로 UI 표시. */
  async checkNeedsApproval(tc: ToolCall): Promise<{ summary: string } | null> {
    switch (tc.name) {
      case 'write_file': {
        const path = (tc.args as { path?: string }).path;
        if (!path) return null;
        const exists = await this.core.readFile(path);
        if (!exists.success) return null; // 새 파일은 즉시 작성
        return { summary: `파일 수정: ${path}` };
      }
      case 'save_page': {
        const slug = (tc.args as { slug?: string }).slug;
        if (!slug) return null;
        const exists = await this.core.getPage(slug);
        if (!exists.success) return null; // 새 페이지는 즉시 저장
        return { summary: `페이지 수정: /${slug}` };
      }
      case 'delete_file': {
        const path = (tc.args as { path?: string }).path;
        return { summary: `파일 삭제: ${path ?? '(unknown)'}` };
      }
      case 'delete_page': {
        const slug = (tc.args as { slug?: string }).slug;
        return { summary: `페이지 삭제: /${slug ?? '(unknown)'}` };
      }
      case 'schedule_task': {
        const args = tc.args as { title?: string; cronTime?: string; runAt?: string; delaySec?: number };
        const when = args.cronTime ?? args.runAt ?? (args.delaySec != null ? `${args.delaySec}초 후` : '');
        return { summary: `예약 등록: ${args.title ?? '(제목 없음)'} (${when})` };
      }
      default:
        return null;
    }
  }

  /** 승인 대기 도구 인자 사전 검증 — 실패 시 에러 메시지 반환 (pending 생성 전 거부).
   *  잘못된 인자로 pending 만드는 걸 차단 — UI 가 무조건 "승인" 버튼 보여주는 헛발질 방지. */
  preValidatePendingArgs(tc: ToolCall): string | null {
    const args = tc.args as Record<string, unknown>;
    switch (tc.name) {
      case 'schedule_task': {
        const isAgent = args.executionMode === 'agent';
        const hasTarget = typeof args.targetPath === 'string' && (args.targetPath as string).trim() !== '';
        const hasPipeline = Array.isArray(args.pipeline) && (args.pipeline as unknown[]).length > 0;
        const hasAgentPrompt = typeof args.agentPrompt === 'string' && (args.agentPrompt as string).trim() !== '';
        // agent 모드: agentPrompt 필수. pipeline 모드: targetPath/pipeline 중 하나 필수.
        if (isAgent) {
          if (!hasAgentPrompt) {
            return 'schedule_task 인자 누락: agent 모드는 agentPrompt 필수입니다. 트리거 시 AI 에 전달할 자연어 instruction (잡 목적·필요 데이터·출력 형식·알림) 작성하세요.';
          }
        } else if (!hasTarget && !hasPipeline) {
          return 'schedule_task 인자 누락: targetPath 또는 pipeline 중 하나는 반드시 지정해야 합니다. (agent 모드면 executionMode:"agent" + agentPrompt)';
        }
        const hasWhen = !!args.cronTime || !!args.runAt || args.delaySec != null;
        if (!hasWhen) return 'schedule_task 인자 누락: cronTime / runAt / delaySec 중 하나는 반드시 지정해야 합니다.';
        if (hasPipeline) {
          const pipeline = args.pipeline as unknown[];
          for (let i = 0; i < pipeline.length; i++) {
            const step = pipeline[i] as Record<string, unknown> | null;
            if (!step || typeof step !== 'object') return `[Step ${i + 1}] step이 객체가 아닙니다.`;
            const t = step.type;
            if (!t || typeof t !== 'string') return `[Step ${i + 1}] type 누락 — EXECUTE/MCP_CALL/NETWORK_REQUEST/LLM_TRANSFORM/CONDITION 중 하나를 지정하세요.`;
            if (!['EXECUTE', 'MCP_CALL', 'NETWORK_REQUEST', 'LLM_TRANSFORM', 'CONDITION'].includes(t)) {
              return `[Step ${i + 1}] 알 수 없는 type: ${t}`;
            }
            if (t === 'EXECUTE') {
              if (!step.path) return `[Step ${i + 1}] EXECUTE에 path 필수 (예: system/modules/kakao-talk/index.mjs).`;
              const id = step.inputData as Record<string, unknown> | undefined;
              if (!id || typeof id !== 'object' || Object.keys(id).length === 0) {
                return `[Step ${i + 1}] EXECUTE 인자 오류: 모듈 실행 파라미터는 step 평면이 아니라 inputData 객체에 넣어야 합니다. 잘못: {type:"EXECUTE",path:"...",action:"price",symbol:"..."} · 올바름: {type:"EXECUTE",path:"...",inputData:{action:"price",symbol:"..."}}`;
              }
            }
            if (t === 'MCP_CALL' && (!step.server || !step.tool)) return `[Step ${i + 1}] MCP_CALL에 server, tool 필수.`;
            if (t === 'NETWORK_REQUEST' && !step.url) return `[Step ${i + 1}] NETWORK_REQUEST에 url 필수.`;
            if (t === 'LLM_TRANSFORM' && !step.instruction) return `[Step ${i + 1}] LLM_TRANSFORM에 instruction 필수.`;
            if (t === 'CONDITION' && (!step.field || !step.op)) return `[Step ${i + 1}] CONDITION에 field, op 필수.`;
          }
        }
        return null;
      }
      case 'write_file': {
        if (typeof args.path !== 'string' || !(args.path as string).trim()) return 'write_file 인자 누락: path 필수.';
        if (args.content == null) return 'write_file 인자 누락: content 필수.';
        return null;
      }
      case 'save_page': {
        if (typeof args.slug !== 'string' || !(args.slug as string).trim()) return 'save_page 인자 누락: slug 필수.';
        if (!args.spec || typeof args.spec !== 'object') return 'save_page 인자 누락: spec 필수.';
        return null;
      }
      default:
        return null;
    }
  }
}

import type { FirebatCore } from '../index';
import type { ILlmPort, ILogPort, ChatMessage } from '../ports';
import { CoreResult } from '../types';

/**
 * Core AI가 분석 후 반환하는 구조체.
 * 직접 실행 명령 없이 오직 판단과 제안만 포함한다.
 */
interface CoreAiAnalysis {
  intent: 'build' | 'debug' | 'automate' | 'query' | 'system_check' | 'conversation';
  analysis: string;
  systemContext: string;
  enrichedPrompt: string;
  directReply?: string;
}

/**
 * Core AI Manager — 내부 시스템 분석 도구 (진입점 아님)
 *
 * TODO: v1+ 삼위일체 AI 구현 예정
 * 현재(v0.x)는 미사용 상태. AiManager가 모든 AI 요청을 직접 처리.
 * v1+에서 Core AI(내부 감사, 손발 없음) 역할로 활성화 예정.
 *
 * 인프라: ILlmPort (자체 도메인), ILogPort (횡단 관심사)
 * Core 참조: 크로스 도메인 호출 (listDir, requestAction)
 */
export class CoreAiManager {
  constructor(
    private readonly core: FirebatCore,
    private readonly llm: ILlmPort,
    private readonly logger: ILogPort,
  ) {}

  private async gatherSystemContext(): Promise<string> {
    const lines: string[] = [];

    const userModules = await this.core.listDir('user/modules');
    if (userModules.success && userModules.data) {
      const names = userModules.data.filter(e => e.isDirectory).map(e => e.name);
      lines.push(`[사용자 모듈] ${names.length > 0 ? names.join(', ') : '없음'}`);
    }

    const sysModules = await this.core.listDir('system/modules');
    if (sysModules.success && sysModules.data) {
      const names = sysModules.data.filter(e => e.isDirectory).map(e => e.name);
      lines.push(`[시스템 모듈] ${names.length > 0 ? names.join(', ') : '없음'}`);
    }

    const userApps = await this.core.listDir('app/(user)');
    if (userApps.success && userApps.data) {
      const names = userApps.data.filter(e => e.isDirectory).map(e => e.name);
      lines.push(`[사용자 앱] ${names.length > 0 ? names.join(', ') : '없음'}`);
    }

    return lines.join('\n') || '[시스템 상태 조회 실패]';
  }

  private async analyze(prompt: string, history: ChatMessage[], systemContext: string): Promise<CoreAiAnalysis | null> {
    const systemPrompt = `당신은 Firebat의 Core AI다.
역할은 시스템 분석과 의도 판단뿐이며, 직접 실행하거나 시스템을 수정하는 일은 절대 하지 않는다.

## 현재 시스템 상태
${systemContext}

## intent 분류 기준
- build: 새 모듈·앱 생성 요청
- debug: 기존 모듈·앱 오류 수정 요청
- automate: 크론·스케줄·자동화 설정 요청
- query: 현황 조회·정보 요청
- system_check: 시스템 상태 점검 요청
- conversation: 단순 대화·질문 (실행 불필요)

## 응답 규칙
1. 아래 JSON 형식으로만 응답. \`\`\`json 마크다운 감싸기 절대 금지.
2. enrichedPrompt: 실행 AI가 받을 개선된 프롬프트. 시스템 컨텍스트 포함.
3. directReply: conversation intent일 때만 채움. 그 외는 반드시 null.
4. directReply 작성 시 자신이 무엇인지(Core AI, Firebat 등) 절대 밝히지 말 것.

{
  "intent": "build | debug | automate | query | system_check | conversation",
  "analysis": "요청 분석 (한국어, 2-3문장 이내)",
  "systemContext": "이 요청과 관련된 현재 시스템 상태 (한국어)",
  "enrichedPrompt": "시스템 컨텍스트가 반영된 개선 프롬프트 (한국어)",
  "directReply": null
}`;

    const result = await this.llm.ask(prompt, systemPrompt, history);
    if (!result.success) return null;

    try {
      if (!result.data) return null;
      const data = result.data;
      // LlmJsonResponse를 CoreAiAnalysis로 변환 시도
      const raw = data as unknown as Record<string, unknown>;
      if (raw.intent && raw.analysis && raw.systemContext && raw.enrichedPrompt) {
        return raw as unknown as CoreAiAnalysis;
      }
      // reply 필드에 JSON이 들어있을 수 있음
      if (data.reply) {
        const parsed = JSON.parse(data.reply.replace(/^```json\n?/m, '').replace(/\n?```$/m, '').trim());
        return parsed as CoreAiAnalysis;
      }
      return null;
    } catch {
      return null;
    }
  }

  private trainingLog(entry: object): void {
    this.logger.info(`[CORE_AI_TRAINING] ${JSON.stringify(entry)}`);
  }

  async process(prompt: string, history: ChatMessage[] = []): Promise<CoreResult> {
    const timestamp = new Date().toISOString();
    const systemContext = await this.gatherSystemContext();
    this.logger.info('[CoreAiManager] System context gathered.');

    const analysis = await this.analyze(prompt, history, systemContext);

    if (!analysis) {
      this.logger.error('[CoreAiManager] Analysis failed — falling back to AiManager.');
      return this.core.requestAction(prompt, history);
    }

    this.logger.info(`[CoreAiManager] Intent: ${analysis.intent}`);

    this.trainingLog({
      timestamp,
      type: 'analysis',
      input: { promptPreview: prompt.slice(0, 200), historyLength: history.length },
      output: { intent: analysis.intent, analysis: analysis.analysis, systemContext: analysis.systemContext },
    });

    this.logger.info('[CoreAiManager] Delegating to AiManager.');
    const result = await this.core.requestAction(analysis.enrichedPrompt, history);

    this.trainingLog({
      timestamp,
      type: 'outcome',
      method: 'delegated',
      intent: analysis.intent,
      enrichedPromptPreview: analysis.enrichedPrompt.slice(0, 300),
      success: result.success,
      executedActions: result.executedActions,
    });

    return result;
  }
}

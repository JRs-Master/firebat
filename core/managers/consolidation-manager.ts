/**
 * Consolidation Manager — 메모리 시스템 4-tier 의 자동 누적 엔진 (Phase 4).
 *
 * 대화 1개 → LLM 후처리 → entity / fact / event JSON 추출 → 자동 save.
 * 사용자가 명시 호출 안 해도 메모리 자동 채워짐 — 핵심 가치.
 *
 * 호출 시점 (단계적):
 *   1. Manual trigger (이 phase): 사용자 어드민에서 "이 대화 정리하기" 클릭
 *   2. AI 자율 (이 phase): consolidate_conversation 도구로 AI 가 turn 끝에 호출
 *   3. Cron 자동 (다음 세션): 매 N시간 비활성 대화 자동 처리
 *
 * 비용: AI assistant 모델 사용 (gpt-5-nano / gemini-flash-lite). 대화 1개당 ~$0.001.
 *
 * 중복 방지: 추출된 entity/fact/event 가 이미 존재하면 skip — saveEntity 가 upsert,
 * fact/event 는 content 임베딩 cosine 매칭으로 유사도 체크 (Phase 4.2 다음 세션 박음).
 * 현재는 단순 — entity 만 upsert (Phase 1 의 saveEntity 가 자동 처리), fact/event 는
 * 매번 새로 박음 (사용자가 어드민에서 수동 정리).
 *
 * 인프라: ILlmPort (LLM call), IEntityPort + IEpisodicPort (자동 save) — Core 경유.
 */
import type { FirebatCore } from '../index';
import type { ChatMessage } from '../ports';

interface ExtractedEntity {
  name: string;
  type: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

interface ExtractedFact {
  entityName: string;
  content: string;
  factType?: string;
  occurredAt?: string;        // ISO 8601
  tags?: string[];
}

interface ExtractedEvent {
  type: string;
  title: string;
  description?: string;
  occurredAt?: string;
  entityNames?: string[];
}

interface ExtractionResult {
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  events: ExtractedEvent[];
}

export interface ConsolidationOutcome {
  /** LLM 추출 결과 raw */
  extracted: ExtractionResult;
  /** 실제 저장된 ID 들 */
  saved: {
    entities: Array<{ id: number; name: string; created: boolean }>;
    facts: Array<{ id: number; entityId: number; content: string }>;
    events: Array<{ id: number; type: string; title: string }>;
  };
  /** 비용 (USD) — LLM 호출 비용. 기록·표시용. */
  costUsd?: number;
  /** Skipped — 형식 오류 / 이미 존재 등 */
  skipped: number;
}

const EXTRACTION_PROMPT = `당신은 대화 메모리 정리 도우미입니다. 다음 대화를 읽고 추적할 가치 있는 정보를 JSON 으로 추출하세요.

추출 카테고리:
1. **entities** (추적 대상): 종목·인물·프로젝트·개념·이벤트. 대화에 명시 등장한 것만.
   - name: 정식 명칭 (한국어 / 영어 OK)
   - type: stock / company / person / project / concept / event 자유
   - aliases: 별칭·약자 (선택, 배열)
   - metadata: ticker / industry / sector 같은 부가 (선택, 객체)

2. **facts** (사실): entity 에 link 된 시간 stamped 사실.
   - entityName: 어느 entity 의 fact (entities 의 name 과 일치)
   - content: 자연어 1-2 문장 — 시간·수치·결과 명시
   - factType: recommendation / transaction / analysis / observation / event / report 자유
   - occurredAt: ISO 8601 (대화에서 명확한 시간 언급 시. 미박혀있으면 미포함)
   - tags: 자유 태그 (배열)

3. **events** (사건): 시간순 사건. 사용자 액션·자동매매·발행·트리거 등.
   - type: cron_trigger / page_publish / transaction / user_action / analysis 자유
   - title: 짧은 요약
   - description: 상세 (선택)
   - occurredAt: ISO 8601
   - entityNames: link 할 entity 이름 배열

추출 안 할 것:
- 잡담·인사·기술 질문 (예: "Firebat 어떻게 박지?")
- 추측·가정 (확인 안 된)
- 메타 발화 (모델 변경·설정 같은 시스템 운영)

JSON 응답 형식 (정확히 이 구조, 그 외 텍스트 금지):
{
  "entities": [...],
  "facts": [...],
  "events": [...]
}

빈 카테고리는 빈 배열 \`[]\`.

대화:
`;

export class ConsolidationManager {
  constructor(private readonly core: FirebatCore) {}

  /** 대화 1개 정리 — LLM 추출 후 자동 save.
   *  modelId 미박힘 시 AI assistant 모델 사용 (저렴). */
  async consolidateConversation(opts: {
    owner: string;
    convId: string;
    modelId?: string;
  }): Promise<ConsolidationOutcome> {
    const empty: ConsolidationOutcome = {
      extracted: { entities: [], facts: [], events: [] },
      saved: { entities: [], facts: [], events: [] },
      skipped: 0,
    };

    // 1. 대화 fetch
    const convRes = await this.core.getConversation(opts.owner, opts.convId);
    if (!convRes.success || !convRes.data) {
      throw new Error(`대화 없음: ${opts.convId}`);
    }
    const messages = (convRes.data.messages ?? []) as ChatMessage[];
    if (messages.length < 2) return empty;

    // 2. 대화 → 텍스트 변환 (LLM 입력)
    const transcript = this.formatTranscript(messages);
    if (!transcript || transcript.length < 50) return empty;

    // 3. LLM 호출 — AI assistant 모델 (저렴). modelId 박혀있으면 그것 사용.
    const modelId = opts.modelId ?? this.core.getAiAssistantModel?.() ?? undefined;
    const fullPrompt = EXTRACTION_PROMPT + '\n' + transcript;
    let llmResponse = '';
    let costUsd: number | undefined;
    try {
      const res = await this.core.askLlmText(fullPrompt, {
        model: modelId,
        thinkingLevel: 'minimal',
      });
      llmResponse = res?.text ?? '';
      costUsd = res?.costUsd;
    } catch (err: any) {
      throw new Error(`LLM 호출 실패: ${err?.message ?? err}`);
    }

    // 4. JSON 파싱 — 코드 블록 fence 제거
    const cleaned = this.stripJsonFence(llmResponse);
    let extracted: ExtractionResult;
    try {
      const parsed = JSON.parse(cleaned);
      extracted = {
        entities: Array.isArray(parsed.entities) ? parsed.entities : [],
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch {
      return { ...empty, costUsd };
    }

    // 5. 저장 — entity 먼저 (fact/event 가 entityName 으로 reference)
    const savedEntities: Array<{ id: number; name: string; created: boolean }> = [];
    const savedFacts: Array<{ id: number; entityId: number; content: string }> = [];
    const savedEvents: Array<{ id: number; type: string; title: string }> = [];
    let skipped = 0;

    // entityName → id 캐시
    const entityIdByName = new Map<string, number>();

    // 5a. Entities — saveEntity 가 upsert (UNIQUE name+type) 라 중복 자연 처리
    for (const e of extracted.entities) {
      if (!e?.name || !e?.type) { skipped++; continue; }
      const r = await this.core.saveEntity({
        name: e.name,
        type: e.type,
        aliases: e.aliases,
        metadata: e.metadata,
        sourceConvId: opts.convId,
      });
      if (r.success && r.data) {
        savedEntities.push({ id: r.data.id, name: e.name, created: r.data.created });
        entityIdByName.set(e.name, r.data.id);
      } else {
        skipped++;
      }
    }

    // 5b. Facts — entityName 으로 entity 조회 (캐시 우선, 없으면 findEntityByName)
    for (const f of extracted.facts) {
      if (!f?.entityName || !f?.content) { skipped++; continue; }
      let entityId = entityIdByName.get(f.entityName);
      if (!entityId) {
        const found = await this.core.findEntityByName(f.entityName);
        if (found.success && found.data) {
          entityId = found.data.id;
          entityIdByName.set(f.entityName, entityId);
        }
      }
      if (!entityId) { skipped++; continue; }

      let occurredAtMs: number | undefined;
      if (f.occurredAt) {
        const t = new Date(f.occurredAt).getTime();
        if (Number.isFinite(t)) occurredAtMs = t;
      }
      const r = await this.core.saveEntityFact({
        entityId,
        content: f.content,
        factType: f.factType,
        occurredAt: occurredAtMs,
        tags: f.tags,
        sourceConvId: opts.convId,
        dedupThreshold: 0.92, // 같은 entity 의 기존 fact 와 92%+ 유사하면 skip — 중복 누적 방지
      });
      if (r.success && r.data) {
        if (r.data.skipped) {
          skipped++; // 중복으로 skip
        } else {
          savedFacts.push({ id: r.data.id, entityId, content: f.content });
        }
      } else {
        skipped++;
      }
    }

    // 5c. Events — entityNames → entityIds 변환
    for (const ev of extracted.events) {
      if (!ev?.type || !ev?.title) { skipped++; continue; }
      const entityIds: number[] = [];
      if (Array.isArray(ev.entityNames)) {
        for (const name of ev.entityNames) {
          const id = entityIdByName.get(name);
          if (id) {
            entityIds.push(id);
          } else {
            const found = await this.core.findEntityByName(name);
            if (found.success && found.data) {
              entityIds.push(found.data.id);
              entityIdByName.set(name, found.data.id);
            }
          }
        }
      }
      let occurredAtMs: number | undefined;
      if (ev.occurredAt) {
        const t = new Date(ev.occurredAt).getTime();
        if (Number.isFinite(t)) occurredAtMs = t;
      }
      const r = await this.core.saveEvent({
        type: ev.type,
        title: ev.title,
        description: ev.description,
        occurredAt: occurredAtMs,
        entityIds: entityIds.length > 0 ? entityIds : undefined,
        sourceConvId: opts.convId,
        dedupThreshold: 0.92, // 같은 type + 7일 이내 기존 event 와 92%+ 유사하면 skip
      });
      if (r.success && r.data) {
        if (r.data.skipped) {
          skipped++;
        } else {
          savedEvents.push({ id: r.data.id, type: ev.type, title: ev.title });
        }
      } else {
        skipped++;
      }
    }

    return {
      extracted,
      saved: { entities: savedEntities, facts: savedFacts, events: savedEvents },
      costUsd,
      skipped,
    };
  }

  /** 대화 메시지 → LLM 입력용 transcript */
  private formatTranscript(messages: ChatMessage[]): string {
    const lines: string[] = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      const role = m.role === 'user' ? '사용자' : m.role === 'assistant' ? 'AI' : null;
      if (!role) continue;
      const content = typeof m.content === 'string' ? m.content : '';
      if (!content.trim()) continue;
      // 너무 긴 메시지 truncate (각 1500자)
      const truncated = content.length > 1500 ? content.slice(0, 1500) + '...(생략)' : content;
      lines.push(`${role}: ${truncated}`);
    }
    return lines.join('\n\n');
  }

  /** ```json ... ``` fence 제거 */
  private stripJsonFence(raw: string): string {
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
    if (fenceMatch) return fenceMatch[1].trim();
    return trimmed;
  }
}

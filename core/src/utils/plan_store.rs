//! Plan Store — propose_plan 의 steps 보관소.
//!
//! 옛 TS `lib/plan-store.ts` 1:1 port (Phase B-19 / AiManager A8 step 3).
//!
//! AI 가 propose_plan 호출 → planId 발급 + steps 저장. 사용자가 ✓실행 누르면 다음 chat 요청에
//! `planExecuteId` 동봉 → AiManager 가 조회 후 시스템 프롬프트에 강제 주입.
//!
//! **파일 영속화** (`data/plan-store.json`) — systemd 재시작·서버 재부팅 후에도 plan 유지.
//! - in-memory `Mutex<HashMap>` 1차 캐시 + 파일 영속.
//! - `get_plan` 도 파일 폴백 (멀티 isolate 안전망).
//! - 옛 TS 와 동일 — TTL 3시간, max 50.
//!
//! 옛 TS 와 차이: TypeScript 의 `setInterval` 기반 cleanup → Rust 는 매 호출 시 inline expire 처리
//! (별도 background task 없음).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const PLAN_EXPIRE: Duration = Duration::from_secs(30 * 24 * 60 * 60); // 30일 (pending_tools 와 통일 — 검토 중·자리 비움 후 만료 방지)
const MAX_SIZE: usize = 50;

/// propose_plan steps 의 한 단계.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// Compiled call arguments — filled by the planning turn AFTER it verified them
    /// (get_action_schema + any name→code lookups). `tool` + `args` together make the step
    /// mechanically replayable on ✓실행: the execution turn runs it through the normal gated
    /// dispatch without re-discovery (2026-07-11: execution turns burned their whole budget
    /// re-searching identifiers the plan turn had already found).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
}

/// 보관된 plan 1건.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlan {
    #[serde(rename = "planId")]
    pub plan_id: String,
    pub title: String,
    pub steps: Vec<PlanStep>,
    #[serde(rename = "estimatedTime", default, skip_serializing_if = "Option::is_none")]
    pub estimated_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risks: Option<Vec<String>>,
    /// epoch ms — 영속 시 JS 의 `Date.now()` 와 동일 단위.
    #[serde(rename = "createdAt")]
    pub created_at: u64,
}

/// `store_plan` 인자 — `created_at` 자동 설정.
#[derive(Debug, Clone)]
pub struct PlanInsert {
    pub plan_id: String,
    pub title: String,
    pub steps: Vec<PlanStep>,
    pub estimated_time: Option<String>,
    pub risks: Option<Vec<String>>,
}

fn now_ms() -> u64 {
    crate::utils::time::now_ms_u64()
}

fn store_file_path() -> PathBuf {
    let dir = std::env::var("FIREBAT_DATA_DIR").unwrap_or_else(|_| "data".to_string());
    PathBuf::from(dir).join("plan-store.json")
}

fn store_lock() -> &'static Mutex<HashMap<String, StoredPlan>> {
    static STORE: OnceLock<Mutex<HashMap<String, StoredPlan>>> = OnceLock::new();
    STORE.get_or_init(|| {
        let mut map = HashMap::new();
        if let Ok(raw) = std::fs::read_to_string(store_file_path()) {
            if let Ok(arr) = serde_json::from_str::<Vec<StoredPlan>>(&raw) {
                let now = now_ms();
                let expired_ms = PLAN_EXPIRE.as_millis() as u64;
                for p in arr {
                    if !p.plan_id.is_empty() && now.saturating_sub(p.created_at) <= expired_ms {
                        map.insert(p.plan_id.clone(), p);
                    }
                }
            }
        }
        Mutex::new(map)
    })
}

fn flush(map: &HashMap<String, StoredPlan>) {
    let path = store_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let arr: Vec<&StoredPlan> = map.values().collect();
    if let Ok(json) = serde_json::to_string_pretty(&arr) {
        let _ = std::fs::write(&path, json);
    }
}

fn cleanup_expired(map: &mut HashMap<String, StoredPlan>) -> bool {
    let now = now_ms();
    let expired_ms = PLAN_EXPIRE.as_millis() as u64;
    let to_remove: Vec<String> = map
        .iter()
        .filter(|(_, p)| now.saturating_sub(p.created_at) > expired_ms)
        .map(|(k, _)| k.clone())
        .collect();
    let changed = !to_remove.is_empty();
    for k in to_remove {
        map.remove(&k);
    }
    changed
}

/// 옛 TS `storePlan(plan)` 1:1 — created_at 자동 설정.
pub fn store_plan(plan: PlanInsert) {
    let Ok(mut map) = store_lock().lock() else {
        return;
    };
    cleanup_expired(&mut map);

    // MAX_SIZE 도달 시 가장 오래된 entry 제거 (LRU 근사)
    if map.len() >= MAX_SIZE {
        let oldest = map
            .iter()
            .min_by_key(|(_, p)| p.created_at)
            .map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            map.remove(&k);
        }
    }

    map.insert(
        plan.plan_id.clone(),
        StoredPlan {
            plan_id: plan.plan_id,
            title: plan.title,
            steps: plan.steps,
            estimated_time: plan.estimated_time,
            risks: plan.risks,
            created_at: now_ms(),
        },
    );
    flush(&map);
}

/// propose_plan 도구 결과 빌더 — plan 저장 + PlanCard component 응답.
///
/// ToolManager(FC 모델 = Gemini/Vertex) + MCP(hosted = CLI/Anthropic/OpenAI) 핸들러 공용 단일 소스.
/// AiManager result_processor 가 `component="PlanCard"` → blocks 안 PlanCard 자동 변환 +
/// suggestions = ✓실행(plan-confirm) / ⚙수정(plan-revise) UI 버튼.
pub fn build_propose_plan_result(args: &serde_json::Value) -> serde_json::Value {
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let steps: Vec<PlanStep> = args
        .get("steps")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    // Empty-args guard — a `propose_plan {}` call used to mint a planId and render a BLANK
    // card whose ✓실행 replays nothing (14차 실측: Solar 가 빈 인자로 호출 → 유령 플랜 카드).
    // A plan without a title and at least one step is not a plan; reject with the shape hint
    // so the model retries with real content or acts directly.
    if title.trim().is_empty() || steps.is_empty() {
        return serde_json::json!({
            "success": false,
            "error": "propose_plan needs {\"title\": \"...\", \"steps\": [{\"title\": \"...\", \"description\"?, \"tool\"?, \"args\"?}, ...]} — an empty call renders a blank card that executes nothing. If the task doesn't need a multi-step plan, skip propose_plan and act directly.",
        });
    }
    let plan_id = format!("plan_{}", uuid::Uuid::new_v4().simple());
    let estimated_time = args
        .get("estimatedTime")
        .and_then(|v| v.as_str())
        .map(String::from);
    let risks: Option<Vec<String>> = args
        .get("risks")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    store_plan(PlanInsert {
        plan_id: plan_id.clone(),
        title: title.clone(),
        steps: steps.clone(),
        estimated_time: estimated_time.clone(),
        risks: risks.clone(),
    });
    let steps_json =
        serde_json::to_value(&steps).unwrap_or(serde_json::Value::Array(vec![]));
    let risks_json = risks
        .as_ref()
        .map(|r| serde_json::to_value(r).unwrap_or(serde_json::Value::Array(vec![])))
        .unwrap_or(serde_json::Value::Null);
    let est_time_json = estimated_time
        .as_ref()
        .map(|s| serde_json::Value::String(s.clone()))
        .unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "success": true,
        "planId": plan_id,
        "component": "PlanCard",
        "props": {
            "planId": plan_id,
            "title": title,
            "steps": steps_json,
            "estimatedTime": est_time_json,
            "risks": risks_json,
        },
        "suggestions": [
            { "type": "plan-confirm", "planId": plan_id, "label": "✓ 실행" },
            { "type": "plan-revise", "planId": plan_id, "label": "⚙ 수정 제안", "placeholder": "예: 1단계 빼고, 차트도 추가해줘" },
            "✕ 취소"
        ]
    })
}

/// 옛 TS `getPlan` 1:1 — 메모리 → 파일 폴백.
pub fn get_plan(plan_id: &str) -> Option<StoredPlan> {
    let mut map = store_lock().lock().ok()?;
    cleanup_expired(&mut map);
    if let Some(p) = map.get(plan_id) {
        return Some(p.clone());
    }
    drop(map);
    let raw = std::fs::read_to_string(store_file_path()).ok()?;
    let arr: Vec<StoredPlan> = serde_json::from_str(&raw).ok()?;
    let now = now_ms();
    let expired_ms = PLAN_EXPIRE.as_millis() as u64;
    let mut found = None;
    let mut map = store_lock().lock().ok()?;
    for p in arr {
        if p.plan_id.is_empty() || now.saturating_sub(p.created_at) > expired_ms {
            continue;
        }
        let is_target = p.plan_id == plan_id;
        let cloned = p.clone();
        map.insert(p.plan_id.clone(), p);
        if is_target {
            found = Some(cloned);
        }
    }
    found
}

/// 옛 TS `deletePlan` 1:1.
pub fn delete_plan(plan_id: &str) {
    if let Ok(mut map) = store_lock().lock() {
        if map.remove(plan_id).is_some() {
            flush(&map);
        }
    }
}

/// plan steps + 사용자 수정 요청 → propose_plan 재호출 강제 시스템 프롬프트.
/// 옛 TS `planToReviseInstruction` 1:1.
pub fn plan_to_revise_instruction(plan: &StoredPlan, user_feedback: &str) -> String {
    let steps_text = plan
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let desc = s.description.as_deref().map(|d| format!(" — {}", d)).unwrap_or_default();
            let tool = s.tool.as_deref().map(|t| format!(" [{}]", t)).unwrap_or_default();
            format!("[{}] {}{}{}", i + 1, s.title, desc, tool)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "사용자가 직전 plan 에 대한 수정 요청을 했습니다. 사용자 피드백을 반영해 propose_plan 도구를 **재호출**하세요.\n\n## 직전 plan: {}\n{}\n\n## 사용자 수정 요청\n\"{}\"\n\n## 재작성 규칙\n- 사용자 요청대로 단계 추가/삭제/수정 후 propose_plan 도구를 다시 호출.\n- title, steps, estimatedTime, risks 모두 갱신.\n- propose_plan 호출 후 **즉시 턴 종료** — 다른 도구·텍스트 응답 금지. 사용자가 새 plan card 보고 다시 ✓실행 누름.\n- 텍스트 답변·설명 금지 — 오직 propose_plan tool_use 만.",
        plan.title, steps_text, user_feedback
    )
}

/// Compiled (mechanically replayable) steps of a plan: `tool` + `args` both present.
/// propose_plan / suggest are never replayable (they re-open consultation), and args must be
/// an object (the shape every tool handler takes).
pub fn compiled_calls(plan: &StoredPlan) -> Vec<(String, serde_json::Value)> {
    plan.steps
        .iter()
        .filter_map(|s| {
            let tool = s.tool.as_deref()?.trim();
            if tool.is_empty() || matches!(tool, "propose_plan" | "suggest") {
                return None;
            }
            let args = s.args.as_ref()?;
            if !args.is_object() {
                return None;
            }
            Some((tool.to_string(), args.clone()))
        })
        .collect()
}

/// plan steps 를 LLM 이 따라 실행할 수 있게 한국어 텍스트로 직렬화.
/// 옛 TS `planToInstruction` 1:1 + compiled args 노출(있으면 그대로 사용 = 재발견 0).
pub fn plan_to_instruction(plan: &StoredPlan, original_request: Option<&str>) -> String {
    let steps_text = plan
        .steps
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let desc = s.description.as_deref().map(|d| format!(" — {}", d)).unwrap_or_default();
            let tool = s.tool.as_deref().map(|t| format!(" [{}]", t)).unwrap_or_default();
            let args = s
                .args
                .as_ref()
                .and_then(|a| serde_json::to_string(a).ok())
                .map(|a| format!(" args={}", a))
                .unwrap_or_default();
            format!("[{}] {}{}{}{}", i + 1, s.title, desc, tool, args)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let original_section = original_request
        .map(|r| format!("\n## 사용자 원래 요청 (참고 — 시각·예약·조건 등이 plan steps 에 없으면 여기서 인식)\n\"{}\"\n", r))
        .unwrap_or_default();
    format!(
        "사용자가 직전 plan 을 ✓실행으로 승인했습니다. 아래 단계를 그대로 따라 실행하세요.\n\n## 승인된 plan: {}\n{}\n{}\n## 실행 규칙\n- 위 단계들을 순서대로 모두 실행. 단계 임의 변경·생략 금지.\n- propose_plan 도구 **재호출 금지** (이미 승인됨).\n- **args= 가 명시된 단계는 그 인자를 한 글자도 바꾸지 말고 그대로 사용해 그 도구를 호출** — 재검색·재발견·인자 재구성 금지.\n- 일부 args= 단계는 시스템이 이미 실행해 결과가 도구 결과로 제공될 수 있음 — 그 단계는 재호출하지 말고 결과를 그대로 사용.\n- **사용자 원래 요청에 시각·예약 표현 (X시 X분, X분 후, 매일 등) 이 있으면 → `schedule_task` 도구로 wrap.** 단계들은 schedule_task 의 pipeline 인자로 들어감. 즉시 실행 금지.\n- 시각·예약 표현 없으면 → `run_task` 또는 단계별 직접 도구 호출로 즉시 실행.\n- 각 단계의 tool 명시가 있으면 그 도구를 사용. 명시 없으면 단계 내용에 적합한 도구 선택.\n- 마지막 단계 종료 후 결과를 사용자에게 시각화 컴포넌트로 보고.",
        plan.title, steps_text, original_section
    )
}

/// 디버깅·테스트용.
pub fn clear_plan_store_in_memory() {
    if let Ok(mut map) = store_lock().lock() {
        map.clear();
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// `pending_tools` 와 같은 `FIREBAT_DATA_DIR` env var 사용 — `utils::shared_test_lock` 으로
    /// cross-module 직렬화.
    fn fresh_state(temp_dir: &std::path::Path) {
        unsafe {
            std::env::set_var("FIREBAT_DATA_DIR", temp_dir);
        }
        clear_plan_store_in_memory();
        let _ = std::fs::remove_file(temp_dir.join("plan-store.json"));
    }

    fn sample_plan(id: &str) -> PlanInsert {
        PlanInsert {
            plan_id: id.to_string(),
            title: "테스트 plan".to_string(),
            steps: vec![
                PlanStep {
                    title: "1단계".to_string(),
                    description: Some("desc1".to_string()),
                    tool: Some("save_page".to_string()),
                    args: None,
                },
                PlanStep {
                    title: "2단계".to_string(),
                    description: None,
                    tool: None,
                    args: None,
                },
            ],
            estimated_time: Some("10분".to_string()),
            risks: Some(vec!["risk1".to_string()]),
        }
    }

    #[test]
    fn store_and_get_round_trip() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        store_plan(sample_plan("plan-test-1"));
        let p = get_plan("plan-test-1").unwrap();
        assert_eq!(p.title, "테스트 plan");
        assert_eq!(p.steps.len(), 2);
        assert_eq!(p.estimated_time.as_deref(), Some("10분"));
    }

    #[test]
    fn delete_removes_plan() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        store_plan(sample_plan("plan-del"));
        delete_plan("plan-del");
        assert!(get_plan("plan-del").is_none());
    }

    #[test]
    fn nonexistent_plan_returns_none() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        assert!(get_plan("plan-nonexistent").is_none());
    }

    #[test]
    fn file_persistence_survives_memory_clear() {
        let _g = crate::utils::shared_test_lock();
        let dir = tempfile::tempdir().unwrap();
        fresh_state(dir.path());

        store_plan(sample_plan("plan-persist"));
        assert!(dir.path().join("plan-store.json").exists());

        clear_plan_store_in_memory();
        let p = get_plan("plan-persist");
        assert!(p.is_some());
    }

    #[test]
    fn plan_to_instruction_includes_steps_and_original() {
        let plan = StoredPlan {
            plan_id: "p1".to_string(),
            title: "주식 시황 발행".to_string(),
            steps: vec![
                PlanStep {
                    title: "데이터 수집".to_string(),
                    description: Some("kiwoom".to_string()),
                    tool: Some("sysmod_kiwoom_quote".to_string()),
                    args: None,
                },
            ],
            estimated_time: None,
            risks: None,
            created_at: 0,
        };
        let inst = plan_to_instruction(&plan, Some("매일 오전 9시에 시황 발행"));
        assert!(inst.contains("주식 시황 발행"));
        assert!(inst.contains("데이터 수집"));
        assert!(inst.contains("sysmod_kiwoom_quote"));
        assert!(inst.contains("매일 오전 9시에 시황 발행"));
        assert!(inst.contains("schedule_task"));
    }

    #[test]
    fn compiled_calls_extracts_only_tool_plus_args_steps() {
        let plan = StoredPlan {
            plan_id: "pc".to_string(),
            title: "compiled".to_string(),
            steps: vec![
                // compiled — tool + object args
                PlanStep {
                    title: "일봉".to_string(),
                    description: None,
                    tool: Some("sysmod_kiwoom".to_string()),
                    args: Some(serde_json::json!({"action":"ka10081","stk_cd":"373220"})),
                },
                // prose — no args
                PlanStep {
                    title: "요약".to_string(),
                    description: None,
                    tool: Some("sysmod_telegram".to_string()),
                    args: None,
                },
                // never replayable
                PlanStep {
                    title: "재계획".to_string(),
                    description: None,
                    tool: Some("propose_plan".to_string()),
                    args: Some(serde_json::json!({"title":"x"})),
                },
                // non-object args = not compiled
                PlanStep {
                    title: "이상한 args".to_string(),
                    description: None,
                    tool: Some("sysmod_kiwoom".to_string()),
                    args: Some(serde_json::json!("373220")),
                },
            ],
            estimated_time: None,
            risks: None,
            created_at: 0,
        };
        let calls = compiled_calls(&plan);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "sysmod_kiwoom");
        assert_eq!(calls[0].1["stk_cd"], "373220");
        // 인스트럭션에는 args 가 verbatim 노출 (모델이 그대로 복사해 호출).
        let inst = plan_to_instruction(&plan, None);
        assert!(inst.contains("args={\"action\":\"ka10081\""));
    }

    #[test]
    fn plan_to_revise_instruction_includes_feedback() {
        let plan = StoredPlan {
            plan_id: "p2".to_string(),
            title: "원래 plan".to_string(),
            steps: vec![PlanStep {
                title: "step1".to_string(),
                description: None,
                tool: None,
                args: None,
            }],
            estimated_time: None,
            risks: None,
            created_at: 0,
        };
        let inst = plan_to_revise_instruction(&plan, "1단계 빼주세요");
        assert!(inst.contains("원래 plan"));
        assert!(inst.contains("1단계 빼주세요"));
        assert!(inst.contains("재호출"));
    }
}

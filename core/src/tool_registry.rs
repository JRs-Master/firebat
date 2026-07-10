//! 정적 도구 등록 — 옛 TS AiManager.registerStaticToolsToManager Rust port (Phase B-17a).
//!
//! 매니저 reference 받아 ToolManager 에 핸들러 closure 등록. AiManager 가 dispatch 호출 시
//! 매니저 메서드 호출 → 결과 JSON 으로 반환. LLM stub 위에서도 도구 호출 e2e 검증 가능.
//!
//! Phase B-17+ 후속:
//! - 정적 도구 27 개 전체 (옛 TS register_static_tools 1:1)
//! - 동적 sysmod_* / mcp_* / render_* 등록 — buildToolDefinitions (60초 캐시)
//! - 도구 schema 메타데이터 (description / input_schema) 등록 — LLM 도구 전달용

use std::sync::Arc;

use crate::managers::consolidation::ConsolidationManager;
use crate::managers::conversation::ConversationManager;
use crate::managers::entity::EntityManager;
use crate::managers::episodic::EpisodicManager;
use crate::managers::event::EventManager;
use crate::managers::library::LibraryManager;
use crate::managers::memory_file::{MemoryEntry, MemoryFileManager};
use crate::managers::skill_file::{SkillEntry, SkillFileManager};
use crate::managers::template::{apply_placeholders, TemplateConfig, TemplateManager};
use crate::managers::mcp::McpManager;
use crate::managers::media::MediaManager;
use crate::managers::module::ModuleManager;
use crate::managers::page::PageManager;
use crate::managers::schedule::ScheduleManager;
use crate::managers::secret::SecretManager;
use crate::managers::task::{PipelineStep, TaskManager};
use crate::managers::tool::{make_handler, ToolDefinition, ToolManager};
use crate::ports::{
    CronScheduleOptions, EntitySearchOpts, EventSearchOpts, FactSearchOpts, INetworkPort,
    IStoragePort, ITtsPort, IVaultPort, ListRecentOpts, MediaListOpts, MediaScope, NetworkRequest,
    SandboxExecuteOpts, SaveEntityInput, SaveEventInput, SaveFactInput, TimelineOpts,
};
use crate::utils::sysmod_cache::SysmodCacheAdapter;
use crate::utils::timezone::resolve_user_tz;
use chrono::{TimeZone, Utc};

pub struct CoreToolHandlers {
    pub page: Arc<PageManager>,
    pub schedule: Arc<ScheduleManager>,
    pub media: Arc<MediaManager>,
    pub conversation: Arc<ConversationManager>,
    pub storage: Arc<dyn IStoragePort>,
    pub entity: Arc<EntityManager>,
    pub episodic: Arc<EpisodicManager>,
    pub consolidation: Arc<ConsolidationManager>,
    pub module: Arc<ModuleManager>,
    pub mcp: Arc<McpManager>,
    /// SSE 알림 — save_page / delete_page / save_module 등 사이드바 갱신 자동 발행
    /// (옛 TS core/index.ts:734+ notifySidebar 패턴 1:1).
    pub event: Arc<EventManager>,
    /// 큰 sysmod 응답 (yfinance / 한투 / 키움 / DART 등 50행+ 시계열) 의 `_cache` envelope
    /// 자동 저장 + AI 가 cache_read / cache_grep / cache_aggregate / cache_drop 도구로 조회.
    /// sandbox 가 envelope 변환 후 cacheKey 만 AI 에게 전달 — main context 토큰 절약.
    pub cache: Arc<SysmodCacheAdapter>,
    /// 파이프라인 즉시 실행 (run_task). task=파이프라인 도메인 (cron=스케줄과 구분).
    pub task: Arc<TaskManager>,
    /// 자료 라이브러리 하이브리드 검색 (search_library).
    pub library: Arc<LibraryManager>,
    /// 시크릿 조회 (request_secret) — 옛 MCP 전용이라 FC 모델이 못 쓰던 것 대칭화.
    pub secret: Arc<SecretManager>,
    /// HTTP 요청 (network_request) — 옛 MCP 전용 대칭화.
    pub network: Arc<dyn INetworkPort>,
    /// 페이지 템플릿 CRUD (list/get/save_template). get_template 시 placeholder 치환.
    pub template: Arc<TemplateManager>,
    /// 템플릿 placeholder 치환의 날짜/시간 tz resolve 용.
    pub vault: Arc<dyn IVaultPort>,
    /// 운영 메모리 (data/memory 파일) — memory_save / memory_read / memory_list / memory_delete.
    /// owner-scoped (hub_context 활성 시 AiManager 가 owner 주입).
    pub memory_file: Arc<MemoryFileManager>,
    /// 스킬 (case 매뉴얼, */skills 파일) — list/get/save/delete/search_skill. 인덱스 상시주입 +
    /// 본문 온디맨드. owner-scoped (hub_context 활성 시 owner 주입). system∪user 병합.
    pub skill_file: Arc<SkillFileManager>,
    /// TTS 합성 (tts 도구) — LC 오디오 생성. provider/voice 는 어댑터가 설정·키에서 해석.
    pub tts: Arc<dyn ITtsPort>,
}

/// 정적 도구 N개 등록. ToolManager.register (메타) + register_handler (closure).
/// AiManager.process_with_tools 가 dispatch 호출 시 매니저 메서드 자동 호출.
pub fn register_core_tools(tools: &Arc<ToolManager>, h: CoreToolHandlers) {
    register_page_tools(tools, &h);
    register_storage_tools(tools, &h);
    register_schedule_tools(tools, &h);
    register_media_tools(tools, &h);
    register_conversation_tools(tools, &h);
    register_entity_tools(tools, &h);
    register_episodic_tools(tools, &h);
    register_consolidation_tools(tools, &h);
    register_memory_file_tools(tools, &h);
    register_skill_tools(tools, &h);
    register_module_tools(tools, &h);
    register_mcp_tools(tools, &h);
    register_cache_tools(tools, &h);
    register_task_library_tools(tools, &h);
    register_meta_render_tools(tools, &h);
    register_infra_parity_tools(tools, &h);
    register_template_tools(tools, &h);
    register_tts_tool(tools, &h);
    register_build_tools(tools);
}

/// TTS 도구 — 스크립트 + 화자 억양으로 LC 오디오 생성. provider/voice 는 설정·자동배정(AI 는 억양만).
/// 캐시: 같은 (provider+script+화자+style) = 같은 파일 재사용(switch-back 재생성 0). conv-scoped 저장(대화 삭제 시 cascade).
fn register_tts_tool(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "tts".to_string(),
        description: "Generate listening audio (TTS) from a script and return a playable URL — for \
            listening-comprehension practice (put the url in a `listening` component's audioUrl). You \
            choose only the script and, for dialogues, each speaker's accent + gender (inferred from the \
            dialogue); the provider and concrete voices come from settings / auto-assignment. Assign \
            per-speaker accents realistic to the target test or context. Multi-speaker: write the script \
            as 'Name: line' per turn and list \
            those names in `speakers`. Put `[pause: N]` on its own line to insert N seconds of silence \
            at that point (e.g. the marking gap between timed exam items, or a repeat-after-me pause). \
            Cached — the same script+voice is reused without re-generating. Returns { url }."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "script": {"type": "string", "description": "Spoken text. Multi-speaker dialogue = one 'Name: line' per line (names match speakers[].name)."},
                "speakers": {
                    "type": "array",
                    "description": "Dialogue speakers (omit for single-voice monologue). Each = {name, accent?, gender?}.",
                    "items": {"type": "object", "properties": {
                        "name": {"type": "string", "description": "Speaker name as written in the script 'Name:' lines."},
                        "accent": {"type": "string", "description": "Accent, free text (e.g. 'American accent', 'British accent')."},
                        "gender": {"type": "string", "description": "'male' or 'female' — infer from the dialogue/role; picks a matching voice."}
                    }}
                },
                "style": {"type": "string", "description": "Global accent/delivery instruction (single voice or common to all)."}
            },
            "required": ["script"]
        }),
        source: "core".to_string(),
    });
    let tts = h.tts.clone();
    let media = h.media.clone();
    tools.register_handler(
        "tts",
        make_handler(move |args| {
            let tts = tts.clone();
            let media = media.clone();
            async move {
                use std::hash::{Hash, Hasher};
                let script = args
                    .get("script")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "script")])
                    })?;
                let style = args
                    .get("style")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let speakers: Vec<crate::ports::TtsSpeaker> = args
                    .get("speakers")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|s| {
                                let o = s.as_object()?;
                                let name = o
                                    .get("name")
                                    .or_else(|| o.get("speaker"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty())?;
                                let st = o
                                    .get("accent")
                                    .or_else(|| o.get("style"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty());
                                let voice = o
                                    .get("voice")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .trim()
                                    .to_string();
                                let gender = o
                                    .get("gender")
                                    .or_else(|| o.get("sex"))
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty());
                                Some(crate::ports::TtsSpeaker { speaker: name, voice, style: st, gender })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                // conv 스코프(저장 + 대화삭제 cascade). FC=ai.rs 가 convId 자동주입 / CLI(MCP)=AI 가
                // [Conversation id] 힌트로 convId 전달 / 둘 다 없으면 공유(_shared — 캐시는 동작,
                // cascade 만 skip = best-effort).
                let conv = args
                    .get("convId")
                    .or_else(|| args.get("currentConvId"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or("_shared")
                    .to_string();
                // effective provider → 캐시키·확장자. provider 바뀌면 키 달라져 새 파일(switch-back=캐시히트).
                let (provider, model) = tts.effective_config();
                // browser = 키 없음/브라우저 선택 → 서버 파일 생성 0. listening 컴포넌트가 클라 Web Speech 로 낭독.
                if provider == "browser" {
                    return Ok(serde_json::json!({ "browser": true }));
                }
                let ext = if provider == "openai" { "mp3" } else { "wav" };
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                provider.hash(&mut hasher);
                script.hash(&mut hasher);
                for sp in &speakers {
                    sp.speaker.hash(&mut hasher);
                    sp.style.hash(&mut hasher);
                    sp.gender.hash(&mut hasher);
                }
                style.hash(&mut hasher);
                let name = format!("tts-{:016x}.{ext}", hasher.finish());
                if let Some(url) = media.conv_attachment_url(&conv, &name).await? {
                    return Ok(serde_json::json!({ "url": url, "cached": true }));
                }
                let req = crate::ports::TtsRequest {
                    provider,
                    model,
                    text: script,
                    voice: String::new(),
                    speakers,
                    style,
                    align: true, // listening 오디오 — LRC 정렬(노래방·단어 seek)
                };
                let result = tts.synthesize(&req).await?;
                let url = media.save_conv_attachment(&conv, &name, &result.audio).await?;
                // LRC sidecar — 단어별 타임스탬프(정독 노래방 fill·단어 클릭 seek). 컴포넌트가
                // audioUrl + ".lrc.json" 으로 유도해 fetch. best-effort(정렬 실패 시 줄 0 → 미저장).
                if !result.lines.is_empty() {
                    if let Ok(json) = serde_json::to_vec(&result.lines) {
                        let lrc_name = format!("{name}.lrc.json");
                        let _ = media.save_conv_attachment(&conv, &lrc_name, &json).await;
                    }
                }
                Ok(serde_json::json!({ "url": url, "cached": false }))
            }
        }),
    );
}

/// Operational memory tools (data/memory files): save / read / list (index) / delete.
/// This is the curated, always-relevant operational knowledge — distinct from Recall
/// (entity/fact semantic store). The index is injected into the system prompt every turn;
/// use memory_read to pull a full entry on demand. `owner` is injected by AiManager when a
/// hub context is active (visitor isolation); admin omits it.
fn register_memory_file_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // memory_save — create or update one operational-memory entry (overwrites same name).
    tools.register(ToolDefinition {
        name: "memory_save".to_string(),
        description: "Save a durable operational-memory entry (reusable lesson / how-to / preference). \
            Overwrites an entry with the same name. description = one-line summary (shown in the index). \
            content = full body. category: user|feedback|project|reference = operational knowledge \
            (injected into your context every turn — what you should always follow). \
            category 'idea' = a developer-facing Firebat improvement suggestion you log while operating \
            (friction/missing feature/awkward flow); it is NOT injected back, the operator reviews it. \
            Use this for stable knowledge & ideas, not transient facts (use save_entity_fact for facts)."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "short slug, also the filename"},
                "category": {"type": "string", "enum": ["user", "feedback", "project", "reference", "idea"]},
                "description": {"type": "string", "description": "one-line summary for the index"},
                "content": {"type": "string", "description": "full body"}
            },
            "required": ["name", "content"]
        }),
        source: "core".to_string(),
    });
    let mf = h.memory_file.clone();
    tools.register_handler(
        "memory_save",
        make_handler(move |args| {
            let mf = mf.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct SaveArgs {
                    name: String,
                    #[serde(default)]
                    category: String,
                    #[serde(default)]
                    description: String,
                    #[serde(default)]
                    content: String,
                    #[serde(default)]
                    owner: Option<String>,
                }
                let a: SaveArgs = serde_json::from_value(args)
                    .map_err(|e| format!("memory_save args: {e}"))?;
                let entry = MemoryEntry {
                    category: a.category,
                    name: a.name,
                    description: a.description,
                    content: a.content,
                    // In-turn memory_save = explicit request or MEMORY_WRITE_MODE-gated judgment
                    // (F1-scoped) — treated as promoted; only cron extraction stages at 0.5.
                    confidence: 1.0,
                };
                mf.save(a.owner.as_deref(), &entry).await?;
                Ok(serde_json::json!({"ok": true, "name": entry.name}))
            }
        }),
    );

    // memory_read — full entry by name.
    tools.register(ToolDefinition {
        name: "memory_read".to_string(),
        description: "Read one operational-memory entry by name (full body). \
            Names come from the index (the <OPERATIONAL_MEMORY> block or memory_list)."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "name": {"type": "string"} },
            "required": ["name"]
        }),
        source: "core".to_string(),
    });
    let mf = h.memory_file.clone();
    tools.register_handler(
        "memory_read",
        make_handler(move |args| {
            let mf = mf.clone();
            async move {
                let name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "memory_read: name required".to_string())?;
                let owner = args.get("owner").and_then(|v| v.as_str());
                let entry = mf.read(owner, name).await?;
                serde_json::to_value(entry).map_err(|e| e.to_string())
            }
        }),
    );

    // memory_list — the index (one line per entry, grouped by category).
    tools.register(ToolDefinition {
        name: "memory_list".to_string(),
        description: "List operational memory as an index (name + one-line description per entry, \
            grouped by category). Use memory_read for a full entry."
            .to_string(),
        parameters: serde_json::json!({ "type": "object", "properties": {} }),
        source: "core".to_string(),
    });
    let mf = h.memory_file.clone();
    tools.register_handler(
        "memory_list",
        make_handler(move |args| {
            let mf = mf.clone();
            async move {
                let owner = args.get("owner").and_then(|v| v.as_str());
                let index = mf.get_index(owner).await?;
                Ok(serde_json::json!({"index": index}))
            }
        }),
    );

    // memory_delete — remove one entry by name.
    tools.register(ToolDefinition {
        name: "memory_delete".to_string(),
        description: "Delete one operational-memory entry by name.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "name": {"type": "string"} },
            "required": ["name"]
        }),
        source: "core".to_string(),
    });
    let mf = h.memory_file.clone();
    tools.register_handler(
        "memory_delete",
        make_handler(move |args| {
            let mf = mf.clone();
            async move {
                let name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "memory_delete: name required".to_string())?;
                let owner = args.get("owner").and_then(|v| v.as_str());
                mf.delete(owner, name).await?;
                Ok(serde_json::json!({"ok": true}))
            }
        }),
    );

    // memory_grep — substring search over entry bodies (+ name/description).
    tools.register(ToolDefinition {
        name: "memory_grep".to_string(),
        description: "Search operational-memory bodies by substring (case-insensitive). \
            Returns matching entries with only the matching lines. Use when the index \
            (<OPERATIONAL_MEMORY>) hints an entry is relevant and you want the detail \
            without reading the whole file."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "query": {"type": "string"} },
            "required": ["query"]
        }),
        source: "core".to_string(),
    });
    let mf = h.memory_file.clone();
    tools.register_handler(
        "memory_grep",
        make_handler(move |args| {
            let mf = mf.clone();
            async move {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "memory_grep: query required".to_string())?;
                let owner = args.get("owner").and_then(|v| v.as_str());
                let hits = mf.grep(owner, query).await?;
                serde_json::to_value(hits).map_err(|e| e.to_string())
            }
        }),
    );
}

/// Skill tools (*/skills files): get / list (index) / save / delete / search. Skills are on-demand
/// case manuals (how to use tools/templates for a case). The index (<SKILLS_AVAILABLE>) is injected
/// every turn; get_skill pulls a full manual on demand. `owner` is injected by AiManager for hub.
fn register_skill_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // get_skill — full manual by slug. The main on-demand load (slug from the <SKILLS_AVAILABLE> index).
    tools.register(ToolDefinition {
        name: "get_skill".to_string(),
        description: "Load the full manual for a skill by slug. Slugs come from the \
            <SKILLS_AVAILABLE> index. Before doing a task that matches an available skill, get it and \
            follow it. A skill is a case manual — how to use tools/templates for that case (design \
            themes, tool-usage procedures, response styles, etc.)."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "slug": {"type": "string"} },
            "required": ["slug"]
        }),
        source: "core".to_string(),
    });
    let sf = h.skill_file.clone();
    tools.register_handler(
        "get_skill",
        make_handler(move |args| {
            let sf = sf.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "get_skill: slug required".to_string())?;
                let owner = args.get("owner").and_then(|v| v.as_str());
                let entry = sf.read(owner, slug).await?;
                serde_json::to_value(entry).map_err(|e| e.to_string())
            }
        }),
    );

    // list_skills — the index (slug + description per skill, grouped by kind).
    tools.register(ToolDefinition {
        name: "list_skills".to_string(),
        description: "List available skills as an index (slug + one-line description, grouped by \
            kind). Same content as the always-injected <SKILLS_AVAILABLE> block; use get_skill for a \
            full manual."
            .to_string(),
        parameters: serde_json::json!({ "type": "object", "properties": {} }),
        source: "core".to_string(),
    });
    let sf = h.skill_file.clone();
    tools.register_handler(
        "list_skills",
        make_handler(move |args| {
            let sf = sf.clone();
            async move {
                let owner = args.get("owner").and_then(|v| v.as_str());
                let index = sf.get_index(owner).await?;
                Ok(serde_json::json!({"index": index}))
            }
        }),
    );

    // save_skill — create or update one skill (overwrites same slug). Authoring.
    tools.register(ToolDefinition {
        name: "save_skill".to_string(),
        description: "Save a skill (case manual) — overwrites the same slug. kind = design | \
            tool-usage | procedure | persona | policy. description = one-line 'when to use' + \
            trigger keywords/tags ONLY — never summarize HOW (a recipe-flavored description \
            makes models act from the index line and skip the manual). content = the manual \
            (markdown: which tools/templates, steps, output, pitfalls). Use when you've worked \
            out a reusable way to handle a recurring case. Context-conditional guidance belongs \
            here (a skill), not always-on memory_save."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "slug": {"type": "string", "description": "short slug, also the filename"},
                "name": {"type": "string"},
                "kind": {"type": "string", "enum": ["design", "tool-usage", "procedure", "persona", "policy"]},
                "description": {"type": "string", "description": "one-line 'when to use' trigger"},
                "content": {"type": "string", "description": "the manual (markdown)"}
            },
            "required": ["slug", "content"]
        }),
        source: "core".to_string(),
    });
    let sf = h.skill_file.clone();
    tools.register_handler(
        "save_skill",
        make_handler(move |args| {
            let sf = sf.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct SaveArgs {
                    slug: String,
                    #[serde(default)]
                    name: String,
                    #[serde(default)]
                    kind: String,
                    #[serde(default)]
                    description: String,
                    #[serde(default)]
                    content: String,
                    #[serde(default)]
                    owner: Option<String>,
                }
                let a: SaveArgs =
                    serde_json::from_value(args).map_err(|e| format!("save_skill args: {e}"))?;
                let name = if a.name.trim().is_empty() {
                    a.slug.clone()
                } else {
                    a.name
                };
                let entry = SkillEntry {
                    slug: a.slug,
                    name,
                    kind: a.kind,
                    description: a.description,
                    content: a.content,
                    source: "user".to_string(),
                    overrides_system: false,
                };
                sf.save(a.owner.as_deref(), &entry).await?;
                Ok(serde_json::json!({"ok": true, "slug": entry.slug}))
            }
        }),
    );

    // delete_skill — remove one skill by slug (writable owner dir; system skills are repo-managed).
    tools.register(ToolDefinition {
        name: "delete_skill".to_string(),
        description: "Delete one skill by slug (your own; shipped system skills are managed in the repo)."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "slug": {"type": "string"} },
            "required": ["slug"]
        }),
        source: "core".to_string(),
    });
    let sf = h.skill_file.clone();
    tools.register_handler(
        "delete_skill",
        make_handler(move |args| {
            let sf = sf.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "delete_skill: slug required".to_string())?;
                let owner = args.get("owner").and_then(|v| v.as_str());
                sf.delete(owner, slug).await?;
                Ok(serde_json::json!({"ok": true}))
            }
        }),
    );

    // search_skills — substring search over skill manuals (+ name/description).
    tools.register(ToolDefinition {
        name: "search_skills".to_string(),
        description: "Search skill manuals by substring (case-insensitive). Returns matching skills \
            with only the matching lines. Use to find a relevant skill when the <SKILLS_AVAILABLE> \
            index slug isn't obvious."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "query": {"type": "string"} },
            "required": ["query"]
        }),
        source: "core".to_string(),
    });
    let sf = h.skill_file.clone();
    tools.register_handler(
        "search_skills",
        make_handler(move |args| {
            let sf = sf.clone();
            async move {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "search_skills: query required".to_string())?;
                let owner = args.get("owner").and_then(|v| v.as_str());
                let hits = sf.grep(owner, query).await?;
                serde_json::to_value(hits).map_err(|e| e.to_string())
            }
        }),
    );
}

/// 옛 MCP 전용이라 FC 모델(Gemini/Vertex)이 못 쓰던 도구를 ToolManager 에도 등록 — 양 경로 대칭.
/// execute(user 모듈) / run_cron_job(예약 잡 즉시 실행) / request_secret(시크릿 조회) /
/// network_request(HTTP). MCP 핸들러(ExecuteHandler/RunCronJobHandler/RequestSecretHandler/
/// NetworkRequestHandler)와 같은 매니저 메서드 위임 = 동작 일치.
fn register_infra_parity_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // execute — run a user-defined module in user/modules. System modules use their sysmod_* tools.
    let module = h.module.clone();
    tools.register_tool(
        ToolDefinition {
            name: "execute".to_string(),
            description: "Run a user-defined module under user/modules only. NOT for system modules — call the module's own sysmod_<name> tool for those (e.g. weather, stocks, search). Args: {path: 'user/modules/<name>', inputData: {…module input fields}}.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "user/modules/<name> path of a user-defined module. System modules are NOT reachable here — use sysmod_<name>."},
                    "inputData": {"type": "object", "description": "The module's input fields."}
                },
                "required": ["path"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let module = module.clone();
            async move {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "execute: 'path' is required (user/modules/<name>). To call a system module (weather, stocks, search, …) use its sysmod_<name> tool instead of execute.".to_string())?
                    .to_string();
                // execute = user/modules only (system modules via sysmod_*). Confine like file tools.
                let path = crate::utils::hub_context::confine_hub_path(&args, &path)?;
                let input = args.get("inputData").cloned().unwrap_or(serde_json::json!({}));
                if input.is_object() && input.as_object().map(|m| m.is_empty()).unwrap_or(false) {
                    return Ok(serde_json::json!({"success": false, "error": "execute: 'inputData' must not be an empty object — fill the module's input fields. If this was meant to be a system module (weather, stocks, …), call its sysmod_<name> tool instead."}));
                }
                match module.execute(&path, &input, &SandboxExecuteOpts::default()).await {
                    Ok(output) => Ok(if output.success {
                        serde_json::json!({"success": true, "data": output.data})
                    } else {
                        serde_json::json!({"success": false, "error": output.error.unwrap_or_default()})
                    }),
                    Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
                }
            }
        },
    );

    // run_cron_job — 예약된 jobId 즉시 1회 실행 (cron 도메인). run_task(파이프라인)와 구분.
    let schedule = h.schedule.clone();
    tools.register_tool(
        ToolDefinition {
            name: "run_cron_job".to_string(),
            description: "예약된 cron 잡을 jobId 로 즉시 1회 실행. (파이프라인 즉시 실행은 run_task.)".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "jobId": {"type": "string"} },
                "required": ["jobId"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let schedule = schedule.clone();
            async move {
                let job_id = args
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "run_cron_job: jobId 필수".to_string())?
                    .to_string();
                // 주입된 owner 로 스코프 (admin=None=무검사, hub=자기 잡만). 지금 hub 차단이라 미도달이나 latent 방어.
                let owner = args.get("owner").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
                match schedule.trigger_now_owned(&job_id, owner).await {
                    Ok(()) => Ok(serde_json::json!({"success": true})),
                    Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
                }
            }
        },
    );

    // stream_watch_* — persistent realtime watches (config `ws.streams` declarative).
    let module_stream = h.module.clone();
    tools.register_tool(
        ToolDefinition {
            name: "stream_watch_start".to_string(),
            description: "Start a persistent realtime watch declared in a module's config ws.streams. Events flow to the event bus (topic in the result) and, with notify:'telegram', as Telegram messages. To SHOW events live in chat, render a live_feed (events) or live_chart (numeric tick, valueField dot-path) component with the returned topic. Idempotent: the same module+stream+args returns the existing watch. Survives server restarts until stream_watch_stop.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "module": {"type": "string", "description": "module name (e.g. kiwoom)"},
                    "stream": {"type": "string", "description": "stream key declared under the module's ws.streams"},
                    "args": {"type": "object", "description": "stream template params (e.g. {seq})"},
                    "notify": {"type": "string", "enum": ["telegram", "none"], "description": "notification channel on realtime events (default none = event bus only)"},
                    "label": {"type": "string", "description": "human-readable label used in notifications"},
                    "mock": {"type": "boolean"}
                },
                "required": ["module", "stream"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let module = module_stream.clone();
            async move {
                let m = args
                    .get("module")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "stream_watch_start: module required".to_string())?
                    .to_string();
                let stream = args
                    .get("stream")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "stream_watch_start: stream required".to_string())?
                    .to_string();
                let wargs = args.get("args").cloned().unwrap_or(serde_json::json!({}));
                let notify = args
                    .get("notify")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty() && *s != "none")
                    .map(String::from);
                let label = args.get("label").and_then(|v| v.as_str()).map(String::from);
                let mock = args.get("mock").and_then(|v| v.as_bool()).unwrap_or(false);
                match module.start_stream(&m, &stream, &wargs, notify, label, mock).await {
                    Ok(v) => Ok(serde_json::json!({"success": true, "watch": v})),
                    Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
                }
            }
        },
    );

    let module_stream = h.module.clone();
    tools.register_tool(
        ToolDefinition {
            name: "stream_watch_stop".to_string(),
            description: "Stop a realtime watch by watchId (sends the declared unsubscribe frame best-effort).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "watchId": {"type": "string"} },
                "required": ["watchId"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let module = module_stream.clone();
            async move {
                let id = args
                    .get("watchId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "stream_watch_stop: watchId required".to_string())?
                    .to_string();
                match module.stop_stream(&id).await {
                    Ok(removed) => Ok(serde_json::json!({"success": true, "removed": removed})),
                    Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
                }
            }
        },
    );

    let module_stream = h.module.clone();
    tools.register_tool(
        ToolDefinition {
            name: "stream_watch_list".to_string(),
            description: "List active realtime watches with live status (state/lastEvent/eventCount).".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {}
            }),
            source: "core".to_string(),
        },
        move |_args| {
            let module = module_stream.clone();
            async move {
                Ok(serde_json::json!({"success": true, "watches": module.list_streams()}))
            }
        },
    );

    // request_secret — 시크릿 등록 여부만 (present). 값은 절대 AI 에 반환 안 함(인젝션 유출 방지 — 모듈은 sandbox env 로 받음). AI 는 키 저장 불가 — 사용자만 등록.
    let secret = h.secret.clone();
    tools.register_tool(
        ToolDefinition {
            name: "request_secret".to_string(),
            description: "시크릿 등록 여부 조회 (present). 값 자체는 반환하지 않음. AI 는 키 저장 불가 — 사용자가 설정에서 직접 등록.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "name": {"type": "string"} },
                "required": ["name"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let secret = secret.clone();
            async move {
                let name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "request_secret: name 필수".to_string())?
                    .to_string();
                let present = !secret.get_user(&name).unwrap_or_default().is_empty();
                Ok(serde_json::json!({"success": true, "name": name, "present": present}))
            }
        },
    );

    // network_request — 가벼운 HTTP 요청.
    let network = h.network.clone();
    tools.register_tool(
        ToolDefinition {
            name: "network_request".to_string(),
            description: "HTTP 요청. {url, method?, headers?, body?, timeoutMs?}.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "method": {"type": "string"},
                    "headers": {"type": "object"},
                    "body": {},
                    "timeoutMs": {"type": "integer"}
                },
                "required": ["url"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let network = network.clone();
            async move {
                let url = args
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "network_request: url 필수".to_string())?
                    .to_string();
                // SSRF guard — block internal/private/metadata targets (prompt-injection defense).
                if let Some(reason) = crate::utils::net_guard::is_blocked_fetch_url(&url) {
                    tracing::warn!(target: "network", url = %url, %reason, "[network_request] SSRF blocked");
                    return Ok(serde_json::json!({"success": false, "error": format!("network_request blocked ({reason}) — internal/private addresses are not allowed")}));
                }
                let method = args
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GET")
                    .to_string();
                let headers: Option<std::collections::HashMap<String, String>> = args
                    .get("headers")
                    .and_then(|v| serde_json::from_value(v.clone()).ok());
                let body = args.get("body").cloned();
                let timeout_ms = args.get("timeoutMs").and_then(|v| v.as_i64()).unwrap_or(30_000) as u64;
                // MCP NetworkRequestHandler 와 동일 진단 로깅 (관찰성 대칭).
                tracing::info!(target: "network", url = %url, method = %method, timeout_ms = timeout_ms, "[network_request] start");
                let req = NetworkRequest { url: url.clone(), method, headers, body, timeout_ms };
                match network.fetch(req).await {
                    Ok(resp) => {
                        tracing::info!(target: "network", url = %url, status = resp.status, ok = resp.ok, "[network_request] response received");
                        Ok(serde_json::json!({"success": true, "data": resp}))
                    }
                    Err(e) => {
                        tracing::warn!(target: "network", url = %url, error = %e, "[network_request] failed");
                        Ok(serde_json::json!({"success": false, "error": e}))
                    }
                }
            }
        },
    );
}

/// task(파이프라인 즉시 실행) + library(자료 하이브리드 검색) 도구.
/// 옛엔 MCP 에만 있어 FC 모델(Gemini/Vertex)이 못 불렀다 (drift). MCP RunTaskHandler /
/// SearchLibraryHandler 와 같은 매니저 메서드 위임 → 동작 일치.
fn register_task_library_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // run_task — 파이프라인 즉시 실행. task=파이프라인 / cron=스케줄(schedule_task) 구분.
    let task = h.task.clone();
    tools.register_tool(
        ToolDefinition {
            name: "run_task".to_string(),
            description: "파이프라인 즉시 실행 (예약 아님). pipeline = step 배열. 예약·반복은 schedule_task 사용.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "pipeline": { "type": "array" } },
                "required": ["pipeline"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let task = task.clone();
            async move {
                let pipeline = args
                    .get("pipeline")
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(vec![]));
                let steps: Vec<PipelineStep> =
                    serde_json::from_value(pipeline).map_err(|e| format!("pipeline: {e}"))?;
                let result = task.execute_pipeline(&steps).await;
                Ok(if result.success {
                    serde_json::json!({"success": true, "data": result.data})
                } else {
                    serde_json::json!({"success": false, "error": result.error.unwrap_or_default()})
                })
            }
        },
    );

    // search_library — 하이브리드 RAG (dense E5 + sparse BM25 + RRF). MCP SearchLibraryHandler 1:1.
    let library = h.library.clone();
    tools.register_tool(
        ToolDefinition {
            name: "search_library".to_string(),
            description: "자료 라이브러리 하이브리드 검색 (dense + sparse). 질문이 업로드 자료와 관련될 가능성이 있으면 명시 지시 없이 호출하라. query 필수. referenceIds 로 특정 자료 그룹만 (빈 배열/미지정 = 전체). limit 기본 5.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "owner": { "type": "string" },
                    "referenceIds": { "type": "array", "items": { "type": "string" } },
                    "limit": { "type": "integer" }
                },
                "required": ["query"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let library = library.clone();
            async move {
                let owner = args
                    .get("owner")
                    .and_then(|v| v.as_str())
                    .unwrap_or("admin")
                    .to_string();
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "search_library: query 필수".to_string())?
                    .to_string();
                let limit = args
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize)
                    .unwrap_or(5)
                    .clamp(1, 20);
                let reference_ids: Vec<String> = args
                    .get("referenceIds")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                match library.search_scoped(&owner, &reference_ids, &query, limit).await {
                    Ok(hits) if hits.is_empty() => Ok(serde_json::json!({
                        "success": true,
                        "data": [],
                        "hint": "매치된 자료가 없습니다. 동의어·핵심 명사·상위어 등 다른 키워드로 재검색하거나, referenceIds 를 비워 전체 자료를 검색해 보세요."
                    })),
                    Ok(hits) => Ok(serde_json::json!({"success": true, "data": hits})),
                    Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
                }
            }
        },
    );
}

/// 템플릿 도구 — list/get/save. get_template 은 placeholder 치환(apply_placeholders) 적용.
/// owner: 인자 없거나 "admin" = admin scope(None), 그 외 = hub_id. chat·cron 양쪽 AI 사용.
fn register_template_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // list_templates — 사용 가능한 템플릿 목록(메타). 반복 형식 페이지 만들 때 먼저 확인.
    let template = h.template.clone();
    tools.register_tool(
        ToolDefinition {
            name: "list_templates".to_string(),
            description: "사용 가능한 페이지 템플릿 목록(slug·name·description·tags). 반복 형식의 페이지(일일 리포트 등)를 만들 땐 먼저 호출해 맞는 틀이 있는지 확인하라.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "owner": { "type": "string" } }
            }),
            source: "core".to_string(),
        },
        move |args| {
            let template = template.clone();
            async move {
                let owner = template_owner_opt(&args);
                let entries = template.list(owner.as_deref()).await;
                Ok(serde_json::json!({"success": true, "data": entries}))
            }
        },
    );

    // get_template — 1건 조회 + placeholder({date}/{time} 등) 현재 값 치환.
    let template = h.template.clone();
    let vault = h.vault.clone();
    tools.register_tool(
        ToolDefinition {
            name: "get_template".to_string(),
            description: "템플릿 1건 조회 — spec(head+body)의 {date}/{time}/{datetime}/{year}/{month}/{day} 가 현재 값으로 치환돼 반환된다. 이 spec.body 를 save_page 의 body 골격으로 쓰고 동적 내용만 채워라. {slug}.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "slug": { "type": "string" }, "owner": { "type": "string" } },
                "required": ["slug"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let template = template.clone();
            let vault = vault.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "get_template: slug 필수".to_string())?
                    .to_string();
                let owner = template_owner_opt(&args);
                match template.get(owner.as_deref(), &slug).await {
                    Some(mut config) => {
                        let tz = resolve_user_tz(&vault);
                        let now = tz.from_utc_datetime(&Utc::now().naive_utc());
                        apply_placeholders(&mut config, now);
                        Ok(serde_json::json!({"success": true, "data": config}))
                    }
                    None => Ok(serde_json::json!({
                        "success": false,
                        "error": format!("템플릿 '{slug}' 을(를) 찾을 수 없습니다.")
                    })),
                }
            }
        },
    );

    // save_template — 생성/수정(upsert). config = {name, description?, tags?, spec:{head, body}}.
    let template = h.template.clone();
    tools.register_tool(
        ToolDefinition {
            name: "save_template".to_string(),
            description: "페이지 템플릿 생성/수정. {slug, config:{name, description, tags, spec:{head, body}}}. spec.body 는 컴포넌트 배열(save_page 와 동일 형식). 날짜처럼 매번 바뀌는 값은 {date}/{time} placeholder 로 두면 발행 시 치환됨.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "slug": { "type": "string" },
                    "config": { "type": "object" },
                    "owner": { "type": "string" }
                },
                "required": ["slug", "config"]
            }),
            source: "core".to_string(),
        },
        move |args| {
            let template = template.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "save_template: slug 필수".to_string())?
                    .to_string();
                let owner = template_owner_opt(&args);
                let config_val = args
                    .get("config")
                    .cloned()
                    .ok_or_else(|| "save_template: config 필수".to_string())?;
                let config: TemplateConfig = serde_json::from_value(config_val)
                    .map_err(|e| format!("save_template: config 형식 오류 — {e}"))?;
                match template.save(owner.as_deref(), &slug, &config).await {
                    Ok(()) => Ok(serde_json::json!({"success": true, "data": {"slug": slug}})),
                    Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
                }
            }
        },
    );
}

/// owner 결정 — 템플릿은 **per-instance scope**(hub 방문자끼리 공유, route.ts 와 동일).
/// hub: ai.rs 가 주입한 hubOwner(`<inst>:<sid>`)에서 instance id 만 추출. admin: None.
/// (per-visitor 가 아니라 instance 단위 — owner=`hub:<scope>` 접두형은 무시)
fn template_owner_opt(args: &serde_json::Value) -> Option<String> {
    if let Some(ho) = args
        .get("hubOwner")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return Some(ho.to_string()); // 전체 세션 스코프(`<inst>:<sid>`) — 옛 split(':').next() 는 instance 만 추출 → 같은 위젯 세션끼리 템플릿 공유 버그
    }
    args.get("owner")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty() && *s != "admin" && !s.starts_with("hub:"))
        .map(String::from)
}

/// Project Builder tools — start_build / advance_build / cancel_build. Call the build_session engine
/// directly (no manager dependency). For building apps/pages via the standard steps
/// (requirements→design→refine→implement); the engine enforces the order via the advance gate.
/// Independent of plan mode — app builds go through PB regardless of on/off (the prompt triggers it).
fn register_build_tools(tools: &Arc<ToolManager>) {
    use crate::utils::build_session::{self, BuildStep, BuildTier};

    tools.register_tool(
        ToolDefinition {
            name: "start_build".to_string(),
            description: "Call when building an app/page via the standard steps (requirements→design→refine→implement) — returns a new build session + the step-1 (requirements) instruction. Use this to start any multi-step build, regardless of plan mode. (A simple one-off page is fine with just save_page.)".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "request": { "type": "string", "description": "the user's build request" },
                    "convId": { "type": "string", "description": "current conversation id (from the [Build tracking] hint). On the CLI path it is NOT auto-injected, so pass it — it keys the build to THIS conversation for cross-turn continuation, so concurrent builds in other conversations/devices never mix up." }
                },
                "required": ["request"]
            }),
            source: "core".to_string(),
        },
        move |args| async move {
            let request = args.get("request").and_then(|v| v.as_str()).unwrap_or("");
            // scope key — prefer hub (hubOwner=inst:sid, visitor isolation), else convId.
            // Injected by ai.rs (FC dispatch) · inject_hub_owner (MCP) — not set by the AI directly (not in the schema).
            let scope = args.get("hubOwner").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
                .or_else(|| args.get("convId").and_then(|v| v.as_str()));
            let id = build_session::create_session(scope, request);
            Ok(serde_json::json!({
                "success": true,
                "data": {
                    "sessionId": id,
                    "step": BuildStep::Requirements.key(),
                    "stepPrompt": build_session::step_prompt(BuildStep::Requirements, None)
                }
            }))
        },
    );

    tools.register_tool(
        ToolDefinition {
            name: "advance_build".to_string(),
            description: "Save the current build step's output + advance to the next step. {sessionId, output, tier?(S1), auto?}. Returns the next step's instruction. The engine advances only one step per turn — present the step's options via suggest and call this AFTER the user responds (calling before the user selects is rejected). auto=true (user picked 'just do it all') runs to the end without further pauses.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string" },
                    "convId": { "type": "string", "description": "current conversation id (optional, from the [Build tracking] hint) — accepted for consistency; sessionId already identifies the build." },
                    "output": { "description": "the current step's output (summary/design/result, etc.)" },
                    "tier": { "type": "string", "enum": ["T1", "T2", "T3"], "description": "complexity classified in S1 (requirements)" },
                    "auto": { "type": "boolean", "description": "true when the user picks 'just do it all' — runs to the end with no further pauses" }
                },
                "required": ["sessionId", "output"]
            }),
            source: "core".to_string(),
        },
        move |args| async move {
            let session_id = args
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "advance_build: sessionId required".to_string())?
                .to_string();
            let output = args.get("output").cloned().unwrap_or(serde_json::Value::Null);
            if let Some(t) = args.get("tier").and_then(|v| v.as_str()) {
                let tier = match t {
                    "T1" => Some(BuildTier::T1),
                    "T2" => Some(BuildTier::T2),
                    "T3" => Some(BuildTier::T3),
                    _ => None,
                };
                if let Some(tier) = tier {
                    build_session::set_tier(&session_id, tier);
                }
            }
            if args.get("auto").and_then(|v| v.as_bool()) == Some(true) {
                build_session::set_auto_advance(&session_id, true); // user picked 'just do it all' → bypass the gate (one-shot).
            }
            build_session::set_step_output(&session_id, output);
            match build_session::advance_step(&session_id) {
                Ok(next) => {
                    let tier = build_session::get_session(&session_id).and_then(|s| s.tier);
                    Ok(serde_json::json!({
                        "success": true,
                        "data": {
                            "sessionId": session_id,
                            "step": next.key(),
                            "done": next == BuildStep::Done,
                            "stepPrompt": build_session::step_prompt(next, tier)
                        }
                    }))
                }
                Err(e) => Ok(serde_json::json!({"success": false, "error": e})),
            }
        },
    );

    tools.register_tool(
        ToolDefinition {
            name: "cancel_build".to_string(),
            description: "Cancel (abandon) an in-progress build session. Call when the user wants to stop the build or switch to another task. {sessionId}.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "sessionId": { "type": "string" },
                    "convId": { "type": "string", "description": "current conversation id (optional, from the [Build tracking] hint) — accepted for consistency; sessionId already identifies the build." }
                },
                "required": ["sessionId"]
            }),
            source: "core".to_string(),
        },
        move |args| async move {
            let session_id = args
                .get("sessionId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "cancel_build: sessionId required".to_string())?;
            build_session::finish_session(session_id, false);
            Ok(serde_json::json!({ "success": true, "data": { "sessionId": session_id, "status": "abandoned" } }))
        },
    );
}

/// 메타 도구 — render / suggest / propose_plan. ToolManager(FC 모델) 노출용.
/// 옛엔 MCP 에만 있어 Gemini/Vertex 가 시각화·플랜카드·제안칩을 전혀 못 불렀다 (drift).
/// 실행 본체는 core 공유 소스(render_exec / plan_store) — MCP 핸들러와 동작 일치.
/// 결과(blocks / component=PlanCard / suggestions)는 AiManager 멀티턴 루프가 자동 변환.
fn register_meta_render_tools(tools: &Arc<ToolManager>, _h: &CoreToolHandlers) {
    use crate::managers::ai::render_exec;

    // render 도구 schema enum = 런타임 tool_mode 허용 타입(code/math/diagram)과 **동일 소스**.
    // 옛 버그: enum 이 component_names()(42개 전체)라 스키마↔런타임 드리프트 — 모델이 스키마 믿고
    // table/chart 를 도구로 보냄 → tool_mode 거부 → fence 안내 왕복. enum 을 3종으로 좁혀 애초에 못 고르게.
    // (그 외 컴포넌트는 reply 텍스트 firebat-render fence 로 — 한국어 인자 깨짐 방지.)
    let names: Vec<serde_json::Value> = render_exec::TOOL_ALLOWED_TYPES
        .iter()
        .map(|n| serde_json::Value::String((*n).to_string()))
        .collect();
    tools.register_tool(
        ToolDefinition {
            name: "render".to_string(),
            description: "코드/마크업 계열 컴포넌트(code / math / diagram) 전용 렌더링 도구. blocks 배열, 각 block = `type` + `props`. **그 외 모든 컴포넌트(table / callout / text / chart / quiz / … )는 이 도구로 만들지 말고 reply 텍스트에 ```firebat-render``` fence 로 직접 쓰세요** — 도구 인자에 넣으면 한국어 철자가 깨집니다. 도구가 code/math/diagram 외 type 을 받으면 거부합니다.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "blocks": {
                        "type": "array",
                        "minItems": 1,
                        "items": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": names },
                                "props": { "type": "object" }
                            },
                            "required": ["type", "props"],
                            "additionalProperties": false
                        }
                    }
                },
                "required": ["blocks"],
                "additionalProperties": false
            }),
            source: "core".to_string(),
        },
        // tool_mode=true: reject components other than code/math/diagram (force fence, block Korean corruption).
        |args| async move { render_exec::render_blocks(&args, true, None) },
    );

    // suggest — 다음 행동 제안 칩 (AiManager 가 응답 suggestions 로 변환).
    tools.register_tool(
        ToolDefinition {
            name: "suggest".to_string(),
            description: "사용자에게 다음 행동 제안 칩 제시. suggestions = 짧은 문자열 배열.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "suggestions": { "type": "array", "items": { "type": "string" } } },
                "required": ["suggestions"]
            }),
            source: "core".to_string(),
        },
        |args| async move {
            Ok(serde_json::json!({
                "success": true,
                "suggestions": args.get("suggestions").cloned().unwrap_or(serde_json::Value::Array(vec![]))
            }))
        },
    );

    // propose_plan — plan 카드 제시 + ✓실행/⚙수정. 실행 본체 = plan_store 공유 소스.
    tools.register_tool(
        ToolDefinition {
            name: "propose_plan".to_string(),
            description: "복합·파괴적 작업 전 plan 카드 제시 (사용자 ✓실행 승인 후 실행). title + steps[] (각 {title, description?, tool?}) + estimatedTime? + risks?.".to_string(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "description": { "type": "string" },
                                "tool": { "type": "string" }
                            },
                            "required": ["title"]
                        }
                    },
                    "estimatedTime": { "type": "string" },
                    "risks": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title", "steps"]
            }),
            source: "core".to_string(),
        },
        |args| async move { Ok(crate::utils::plan_store::build_propose_plan_result(&args)) },
    );
}

fn register_cache_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // cache_read — pagination 으로 records 가져오기
    tools.register(ToolDefinition {
        name: "cache_read".to_string(),
        description: "sysmod `_cacheKey` 의 records 페이지네이션 조회. 큰 시계열 응답에서 일부만 가져올 때 사용. offset/limit 으로 자르기.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "cacheKey": {"type": "string", "description": "sysmod 응답의 `_cacheKey` 값"},
                "offset": {"type": "integer", "description": "시작 인덱스 (기본 0)"},
                "limit": {"type": "integer", "description": "최대 행 수 (기본 50)"}
            },
            "required": ["cacheKey"]
        }),
        source: "core".to_string(),
    });
    let cache = h.cache.clone();
    tools.register_handler(
        "cache_read",
        make_handler(move |args| {
            let cache = cache.clone();
            async move {
                let key = args
                    .get("cacheKey")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_read: cacheKey 필수".to_string())?
                    .to_string();
                let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
                cache.read(&key, offset, limit)
            }
        }),
    );

    // cache_grep — 조건 필터 (9 op)
    tools.register(ToolDefinition {
        name: "cache_grep".to_string(),
        description: "Filter rows inside a cached sysmod result (`_cacheKey`) by condition — large results are cached instead of inlined, so use this to find matching rows without re-fetching. field=dot notation (e.g. `close`, `meta.symbol`), op=eq/ne/gt/gte/lt/lte/contains/in, value=comparison value. For rendering full data use dataCacheKey in the fence; for aggregates use cache_aggregate.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "cacheKey": {"type": "string"},
                "field": {"type": "string", "description": "필드 경로 (점 표기)"},
                "op": {"type": "string", "enum": ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"]},
                "value": {"description": "비교값 (op 따라 타입 다름)"}
            },
            "required": ["cacheKey", "field", "op", "value"]
        }),
        source: "core".to_string(),
    });
    let cache = h.cache.clone();
    tools.register_handler(
        "cache_grep",
        make_handler(move |args| {
            let cache = cache.clone();
            async move {
                let key = args
                    .get("cacheKey")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_grep: cacheKey 필수".to_string())?
                    .to_string();
                let field = args
                    .get("field")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_grep: field 필수".to_string())?
                    .to_string();
                let op = args
                    .get("op")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_grep: op 필수".to_string())?
                    .to_string();
                let value = args
                    .get("value")
                    .cloned()
                    .ok_or_else(|| "cache_grep: value 필수".to_string())?;
                cache.grep(&key, &field, &op, &value)
            }
        }),
    );

    // cache_aggregate — 집계 (count/sum/avg/min/max)
    tools.register(ToolDefinition {
        name: "cache_aggregate".to_string(),
        description: "sysmod `_cacheKey` records 집계. op=count/sum/avg/min/max. field=숫자 필드 경로 (count 는 무시).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "cacheKey": {"type": "string"},
                "field": {"type": "string", "description": "숫자 필드 경로 (점 표기)"},
                "op": {"type": "string", "enum": ["count", "sum", "avg", "min", "max"]}
            },
            "required": ["cacheKey", "field", "op"]
        }),
        source: "core".to_string(),
    });
    let cache = h.cache.clone();
    tools.register_handler(
        "cache_aggregate",
        make_handler(move |args| {
            let cache = cache.clone();
            async move {
                let key = args
                    .get("cacheKey")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_aggregate: cacheKey 필수".to_string())?
                    .to_string();
                let field = args
                    .get("field")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let op = args
                    .get("op")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_aggregate: op 필수".to_string())?
                    .to_string();
                cache.aggregate(&key, &field, &op)
            }
        }),
    );

    // cache_drop — 단일 key 삭제
    tools.register(ToolDefinition {
        name: "cache_drop".to_string(),
        description: "sysmod `_cacheKey` 삭제 (재발급 강제 또는 LRU 정리).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "cacheKey": {"type": "string"}
            },
            "required": ["cacheKey"]
        }),
        source: "core".to_string(),
    });
    let cache = h.cache.clone();
    tools.register_handler(
        "cache_drop",
        make_handler(move |args| {
            let cache = cache.clone();
            async move {
                let key = args
                    .get("cacheKey")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "cache_drop: cacheKey 필수".to_string())?
                    .to_string();
                cache.drop_key(&key)?;
                Ok(serde_json::json!({"dropped": key}))
            }
        }),
    );
}

fn register_page_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "list_pages".to_string(),
        description: "공개 + 비공개 페이지 목록 조회. 인자 없음.".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let page = h.page.clone();
    tools.register_handler(
        "list_pages",
        make_handler(move |args| {
            let page = page.clone();
            async move {
                // project (hub: injected) → hub visitor sees only their own pages. admin = full list.
                Ok(serde_json::to_value(page.list_scoped(args.get("project").and_then(|v| v.as_str())))
                    .unwrap_or_default())
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "get_page".to_string(),
        description: "특정 slug 페이지 spec 조회.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"]
        }),
        source: "core".to_string(),
    });
    let page = h.page.clone();
    tools.register_handler(
        "get_page",
        make_handler(move |args| {
            let page = page.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "slug")]))?
                    .to_string();
                match page.get_scoped(&slug, args.get("project").and_then(|v| v.as_str())) {
                    Some(record) => Ok(serde_json::to_value(record).unwrap_or_default()),
                    None => Ok(serde_json::Value::Null),
                }
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "delete_page".to_string(),
        description: "특정 slug 페이지 삭제.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"slug": {"type": "string"}},
            "required": ["slug"]
        }),
        source: "core".to_string(),
    });
    let page = h.page.clone();
    let event_for_delete_page = h.event.clone();
    tools.register_handler(
        "delete_page",
        make_handler(move |args| {
            let page = page.clone();
            let event = event_for_delete_page.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "slug")]))?
                    .to_string();
                // project (hub: injected by ai.rs hub owner injection) scopes the delete — hub visitor
                // can only delete their own page. admin (no project) = unscoped. Cross-tenant guard.
                page.delete(&slug, args.get("project").and_then(|v| v.as_str()))?;
                // AI 미개입 자동 hook — 사이드바 SSE 갱신 (옛 TS notifySidebar 패턴).
                event.notify_sidebar();
                Ok(serde_json::json!({"deleted": slug}))
            }
        }),
    );

    // save_page — PageSpec JSON 저장 (publish / draft / private). AdSense 글 발행 핵심.
    // (옛 page_publish 자동 event hook 제거 2026-06-14 — 매 발행 = 사건 노이즈, 페이지 자체가 기록.
    //  사이드바 SSE 갱신 hook 만 유지. Recall events = 의미 있는 happening 만, 루틴 운영 제외.)
    tools.register(ToolDefinition {
        name: "save_page".to_string(),
        description: "페이지 spec 저장 (upsert). slug + spec 필수. status / project / visibility / password 옵션.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "spec": {"type": "object"},
                "status": {"type": "string", "enum": ["published", "draft"]},
                "project": {"type": "string"},
                "visibility": {"type": "string", "enum": ["public", "password", "private"]},
                "password": {"type": "string"}
            },
            "required": ["slug", "spec"]
        }),
        source: "core".to_string(),
    });
    let page = h.page.clone();
    let event_for_save_page = h.event.clone();
    tools.register_handler(
        "save_page",
        make_handler(move |args| {
            let page = page.clone();
            let event = event_for_save_page.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "slug")]))?
                    .to_string();
                let spec = args
                    .get("spec")
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "spec")]))?;
                let spec_str = serde_json::to_string(spec).map_err(|e| {
                    crate::i18n::t(
                        "core.error.page.spec_serialize_failed",
                        None,
                        &[("detail", &e.to_string())],
                    )
                })?;
                let status = args
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("published");
                let project = args.get("project").and_then(|v| v.as_str());
                let visibility = args.get("visibility").and_then(|v| v.as_str());
                let password = args.get("password").and_then(|v| v.as_str());
                page.save(&slug, &spec_str, status, project, visibility, password)?;

                // AI 미개입 자동 hook: 사이드바 SSE 갱신 (옛 TS core/index.ts:858 notifySidebar).
                event.notify_sidebar();
                Ok(serde_json::json!({"slug": slug, "saved": true}))
            }
        }),
    );
}

fn register_storage_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "read_file".to_string(),
        description: "workspace 안 파일 read (UTF-8 텍스트).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }),
        source: "core".to_string(),
    });
    let storage = h.storage.clone();
    tools.register_handler(
        "read_file",
        make_handler(move |args| {
            let storage = storage.clone();
            async move {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "path")]))?
                    .to_string();
                let path = crate::utils::hub_context::confine_hub_path(&args, &path)?;
                let content = storage.read(&path).await?;
                Ok(serde_json::json!({"path": path, "content": content}))
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "write_file".to_string(),
        description: "workspace 안 파일 write (디렉토리 자동 생성).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"}
            },
            "required": ["path", "content"]
        }),
        source: "core".to_string(),
    });
    let storage = h.storage.clone();
    tools.register_handler(
        "write_file",
        make_handler(move |args| {
            let storage = storage.clone();
            async move {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "path")]))?
                    .to_string();
                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "content")]))?
                    .to_string();
                let path = crate::utils::hub_context::confine_hub_path(&args, &path)?;
                storage.write(&path, &content).await?;
                Ok(serde_json::json!({"path": path, "written": content.len()}))
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "list_dir".to_string(),
        description: "workspace 디렉토리 entry 나열.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }),
        source: "core".to_string(),
    });
    let storage = h.storage.clone();
    tools.register_handler(
        "list_dir",
        make_handler(move |args| {
            let storage = storage.clone();
            async move {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "path")]))?
                    .to_string();
                let path = crate::utils::hub_context::confine_hub_path(&args, &path)?;
                let entries = storage.list_dir(&path).await?;
                let json: Vec<serde_json::Value> = entries
                    .into_iter()
                    .map(|e| serde_json::json!({"name": e.name, "isDirectory": e.is_directory}))
                    .collect();
                Ok(serde_json::json!({"path": path, "entries": json}))
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "delete_file".to_string(),
        description: "workspace 안 파일 또는 디렉토리 삭제 (recursive).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"]
        }),
        source: "core".to_string(),
    });
    let storage = h.storage.clone();
    tools.register_handler(
        "delete_file",
        make_handler(move |args| {
            let storage = storage.clone();
            async move {
                let path = args
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "path")]))?
                    .to_string();
                let path = crate::utils::hub_context::confine_hub_path(&args, &path)?;
                storage.delete(&path).await?;
                Ok(serde_json::json!({"deleted": path}))
            }
        }),
    );
}

/// cron(스케줄) 도메인 도구 — schedule_task(등록) / list_cron_jobs(목록) / cancel_cron_job(해제).
/// 도메인 구분: **cron = 스케줄**(ScheduleManager, 예약·반복) ↔ **task = 파이프라인**
/// (run_task = TaskManager.execute_pipeline, 즉시 1회). MCP 서버도 같은 이름으로 통일됨
/// (옛 MCP 의 list_tasks/cancel_task 는 ScheduleManager 백엔드인데 task 이름을 쓴 오명 → cron 통일).
fn register_schedule_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "list_cron_jobs".to_string(),
        description: "등록된 cron / 1회 예약 / delay 잡 목록.".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let schedule = h.schedule.clone();
    tools.register_handler(
        "list_cron_jobs",
        make_handler(move |args| {
            let schedule = schedule.clone();
            async move {
                // hub 면 주입된 owner 로 스코프(args-based, CURRENT_HUB 아님) — owner 버리고 list() 호출해 전 테넌트 크론 노출하던 누수(CRON-1) fix
                let owner = args.get("owner").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
                let jobs = match owner { Some(o) => schedule.list_by_owner(Some(o)), None => schedule.list() };
                Ok(serde_json::to_value(jobs).unwrap_or_default())
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "cancel_cron_job".to_string(),
        description: "cron 잡 해제.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {"jobId": {"type": "string"}},
            "required": ["jobId"]
        }),
        source: "core".to_string(),
    });
    let schedule = h.schedule.clone();
    tools.register_handler(
        "cancel_cron_job",
        make_handler(move |args| {
            let schedule = schedule.clone();
            async move {
                let job_id = args
                    .get("jobId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "jobId")]))?
                    .to_string();
                // 주입된 owner 로 스코프 (admin=None=무검사, hub=자기 잡만). latent 방어 (지금 hub 차단이라 미도달).
                let owner = args.get("owner").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
                schedule.cancel_owned(&job_id, owner).await?;
                Ok(serde_json::json!({"cancelled": job_id}))
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "schedule_task".to_string(),
        description: "cron 잡 등록 — 특정 시각·주기에 작업을 자동 실행(스케줄). 날짜만 기록할 거면 sysmod_calendar(캘린더)를 써라. cronTime (반복) / runAt (1회 예약) / delaySec (N초 후) 중 하나 필수.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "jobId": {"type": "string"},
                "targetPath": {"type": "string", "description": "executionMode=agent 면 'agent'. 인라인 파이프라인은 pipeline 필드 사용(targetPath 는 라벨)"},
                "cronTime": {"type": "string"},
                "runAt": {"type": "string"},
                "delaySec": {"type": "integer"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "executionMode": {"type": "string", "enum": ["pipeline", "agent"], "description": "매 trigger 같은 절차=pipeline(권장 — 런타임 LLM 0 또는 합성 1회) / 매 trigger 런타임 판단 필요=agent"},
                "pipeline": {"type": "array", "items": {"type": "object"}, "description": "executionMode=pipeline deterministic steps (EXECUTE/MCP_CALL/NETWORK_REQUEST/CONDITION/LLM_TRANSFORM/SAVE_PAGE/TOOL_CALL). Cross-step reference: $prev IS the previous step's output itself (module {success,data} envelopes auto-unwrap to data) — path from there, e.g. $prev.result[0].accountSeq. Never invent wrappers like .output[]; an unresolved path fails the step. If you already know a value from a lookup this turn, bake the literal instead of a reference. Synthesis (summary/report) = one LLM_TRANSFORM step (format directives go in instruction)"},
                "agentPrompt": {"type": "string", "description": "executionMode=agent 일 때 매 trigger 받는 자연어 지시문"}
            },
            "required": ["jobId", "targetPath"]
        }),
        source: "core".to_string(),
    });
    let schedule = h.schedule.clone();
    tools.register_handler(
        "schedule_task",
        make_handler(move |args| {
            let schedule = schedule.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Args {
                    #[serde(rename = "jobId")]
                    job_id: String,
                    #[serde(rename = "targetPath")]
                    target_path: String,
                    #[serde(flatten)]
                    opts: CronScheduleOptions,
                }
                let parsed: Args = serde_json::from_value(args)
                    .map_err(|e| format!("schedule_task args: {e}"))?;
                schedule
                    .schedule(&parsed.job_id, &parsed.target_path, parsed.opts)
                    .await?;
                Ok(serde_json::json!({"scheduled": parsed.job_id}))
            }
        }),
    );
}

fn register_media_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "search_media".to_string(),
        description: "갤러리 미디어 검색 (slug / filenameHint / prompt / model 매칭). 최신순.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "scope": {"type": "string", "enum": ["user", "system"]},
                "limit": {"type": "integer"},
                "offset": {"type": "integer"}
            }
        }),
        source: "core".to_string(),
    });
    let media = h.media.clone();
    tools.register_handler(
        "search_media",
        make_handler(move |args| {
            let media = media.clone();
            async move {
                let scope = args.get("scope").and_then(|v| v.as_str()).and_then(|s| {
                    match s {
                        "user" => Some(MediaScope::User),
                        "system" => Some(MediaScope::System),
                        _ => None,
                    }
                });
                let opts = MediaListOpts {
                    search: args.get("query").and_then(|v| v.as_str()).map(String::from),
                    scope,
                    limit: args
                        .get("limit")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as usize),
                    offset: args
                        .get("offset")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as usize),
                    // AiManager 가 hub_context 가 있을 때 자동 주입 (camelCase 'hubOwner').
                    hub_owner: args.get("hubOwner").and_then(|v| v.as_str()).map(String::from),
                };
                let result = media.list(opts).await?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // image_gen — AI 가 호출하는 비동기 이미지 생성 도구.
    // start_generate 호출 → 즉시 placeholder slug/url 반환 → AI 가 즉시 save_page 설정할 수 있음.
    // 사용자 페이지 reload 시 placeholder → 실제 이미지로 자동 swap (디스크 파일 교체).
    // 옛 TS image_gen 도구 1:1 — referenceImage (slug/url/base64) image-to-image 자동 활성.
    tools.register(ToolDefinition {
        name: "image_gen".to_string(),
        description: "AI 이미지 생성 (비동기). 즉시 placeholder URL 반환 → AI 가 save_page 설정할 수 있음. \
                      사용자 페이지 reload 시 실제 이미지로 swap. \
                      referenceImage (slug/url/base64) 설정하면 image-to-image 변환 (OpenAI gpt-image / Gemini 지원).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "required": ["prompt"],
            "properties": {
                "prompt": {"type": "string", "description": "이미지 설명 (영어 권장). 스타일·구도·색감·텍스트 힌트 포함."},
                "size": {"type": "string", "enum": ["1024x1024", "1536x1024", "1024x1536", "auto"]},
                "quality": {"type": "string", "enum": ["low", "medium", "high"]},
                "filenameHint": {"type": "string", "description": "파일명 힌트"},
                "aspectRatio": {"type": "string", "description": "16:9 / 1:1 / 4:5 / 3:2 등 — 지정 시 sharp 가 focusPoint 전략으로 crop"},
                "focusPoint": {"description": "'attention' / 'entropy' / 'center' 또는 {x, y} 객체"},
                "referenceImage": {
                    "type": "object",
                    "description": "image-to-image 변환용 참조 이미지. slug/url/base64 중 하나",
                    "properties": {
                        "slug": {"type": "string", "description": "갤러리 미디어 slug (search_media 결과)"},
                        "url": {"type": "string", "description": "미디어 URL 또는 외부 https URL"},
                        "base64": {"type": "string", "description": "base64 또는 data URI"}
                    }
                }
            }
        }),
        source: "core".to_string(),
    });
    let media = h.media.clone();
    tools.register_handler(
        "image_gen",
        make_handler(move |args| {
            let media = media.clone();
            async move {
                let input = parse_generate_image_input(&args)?;
                let (slug, url) = media.start_generate(input).await?;
                Ok(serde_json::json!({
                    "slug": slug,
                    "url": url,
                    "status": "rendering",
                    "message": "이미지 생성 시작됨 — placeholder URL 반환. 페이지 reload 시 실제 이미지로 자동 swap."
                }))
            }
        }),
    );

    // regenerate_image — 갤러리 슬러그의 메타 (prompt/model/size/aspectRatio) 그대로 재실행.
    // 옛 TS regenerateImageBySlug 1:1 — sync (existing_slug 미사용, 새 slug 발급).
    tools.register(ToolDefinition {
        name: "regenerate_image".to_string(),
        description: "갤러리 이미지 재생성 — 기존 slug 의 prompt/model/size/aspectRatio 메타 그대로 재실행. \
                      prompt 미설정된 레거시 레코드는 재생성 불가 (error 반환).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "required": ["slug"],
            "properties": {
                "slug": {"type": "string", "description": "재생성 대상 슬러그 (search_media 결과)"}
            }
        }),
        source: "core".to_string(),
    });
    let media = h.media.clone();
    tools.register_handler(
        "regenerate_image",
        make_handler(move |args| {
            let media = media.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "slug")]))?
                    .to_string();
                // hubOwner (injected for hub turns) → owner-scoped regen. admin (None) = unscoped.
                let (result, regen_from) =
                    media.regenerate_image_owned(&slug, args.get("hubOwner").and_then(|v| v.as_str())).await?;
                let mut value = serde_json::to_value(&result).unwrap_or_default();
                if let serde_json::Value::Object(ref mut map) = value {
                    map.insert(
                        "regenFrom".to_string(),
                        serde_json::Value::String(regen_from),
                    );
                }
                Ok(value)
            }
        }),
    );
}

/// JSON args → GenerateImageInput. image_gen / regenerate 공통.
fn parse_generate_image_input(
    args: &serde_json::Value,
) -> Result<crate::managers::media::GenerateImageInput, String> {
    use crate::managers::media::{GenerateImageInput, ReferenceImageInput};
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "prompt")]))?
        .to_string();
    let size = args.get("size").and_then(|v| v.as_str()).map(String::from);
    let quality = args
        .get("quality")
        .and_then(|v| v.as_str())
        .map(String::from);
    let filename_hint = args
        .get("filenameHint")
        .and_then(|v| v.as_str())
        .map(String::from);
    let aspect_ratio = args
        .get("aspectRatio")
        .and_then(|v| v.as_str())
        .map(String::from);
    let focus_point = args.get("focusPoint").cloned();
    let model = args.get("model").and_then(|v| v.as_str()).map(String::from);
    let reference_image = args.get("referenceImage").and_then(|r| r.as_object()).map(|obj| {
        ReferenceImageInput {
            slug: obj.get("slug").and_then(|v| v.as_str()).map(String::from),
            url: obj.get("url").and_then(|v| v.as_str()).map(String::from),
            base64: obj.get("base64").and_then(|v| v.as_str()).map(String::from),
        }
    });
    let hub_owner = args.get("hubOwner").and_then(|v| v.as_str()).map(String::from);
    Ok(GenerateImageInput {
        prompt,
        size,
        quality,
        model,
        filename_hint,
        scope: None,
        aspect_ratio,
        focus_point,
        reference_image,
        hub_owner,
    })
}

fn register_conversation_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "search_history".to_string(),
        description: "Search prior conversations (semantic, owner-scoped) — returns matching Q&A from the caller's own history.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"}
            }
        }),
        source: "core".to_string(),
    });
    let conversation = h.conversation.clone();
    tools.register_handler(
        "search_history",
        make_handler(move |args| {
            let conversation = conversation.clone();
            async move {
                // owner injected by ai.rs hub injection ("hub:<inst>:<sess>") → scopes the semantic
                // search to the visitor's own conversations. admin = "admin". Mirrors the MCP
                // SearchHistoryHandler (no drift). Old code hardcoded list("admin") = cross-tenant leak.
                let owner = args.get("owner").and_then(|v| v.as_str()).unwrap_or("admin").to_string();
                let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let opts = crate::managers::conversation::SearchHistoryOpts {
                    current_conv_id: args.get("currentConvId").and_then(|v| v.as_str()).map(String::from),
                    limit: args.get("limit").and_then(|v| v.as_u64()).map(|n| n as usize),
                    within_days: args.get("withinDays").and_then(|v| v.as_i64()),
                    min_score: args.get("minScore").and_then(|v| v.as_f64()).map(|v| v as f32),
                    include_blocks: args.get("includeBlocks").and_then(|v| v.as_bool()).unwrap_or(false),
                };
                let matches = conversation.search_history(&owner, &query, opts).await?;
                Ok(serde_json::to_value(matches).unwrap_or_default())
            }
        }),
    );

    // search_memory — unified recall across history + Recall (entities/facts/events) + Library in
    // one call (RetrievalEngine — the same merge that auto-injects when the AI-assistant toggle is
    // on). Built here from the handler's own managers so the AI can trigger it on demand; no shared
    // state with AiManager's instance.
    let engine = Arc::new(
        crate::managers::ai::retrieval_engine::RetrievalEngine::new()
            .with_conversation(h.conversation.clone())
            .with_entity(h.entity.clone())
            .with_episodic(h.episodic.clone())
            .with_library(h.library.clone()),
    );
    tools.register(ToolDefinition {
        name: "search_memory".to_string(),
        description: "Unified recall — searches conversation history + Recall (entities/facts/events) \
            + Library in one call and returns the merged relevant context for a query. Use this to \
            look up what you know across all memory sources at once (same retrieval that auto-injects \
            when the AI-assistant toggle is on). For a single source, use search_history / \
            search_entities / search_library instead."
            .to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": { "query": {"type": "string"} },
            "required": ["query"]
        }),
        source: "core".to_string(),
    });
    tools.register_handler(
        "search_memory",
        make_handler(move |args| {
            let engine = engine.clone();
            async move {
                let query = args
                    .get("query")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "search_memory: query required".to_string())?;
                let opts = crate::managers::ai::retrieval_engine::RetrieveOpts {
                    query: query.to_string(),
                    owner: args.get("owner").and_then(|v| v.as_str()).map(String::from),
                    current_conv_id: args
                        .get("currentConvId")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    ..Default::default()
                };
                let result = engine.retrieve(&opts).await;
                Ok(serde_json::json!({
                    "context": result.context_summary,
                    "stats": serde_json::to_value(result.stats).unwrap_or_default(),
                }))
            }
        }),
    );
}

fn register_entity_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // save_entity — name+type upsert
    tools.register(ToolDefinition {
        name: "save_entity".to_string(),
        description: "Save the identity of a tracked subject — one thing you'll want to recall later. The `name` is the BARE NOUN for the thing itself (it answers 'what is it?') — NOT what it's doing, its current state, a plan/strategy/method applied to it, a time period, or any other qualifier. All of those go in facts (save_entity_fact), never in the name. Self-check: if the name reads as 'THING + descriptor' (a thing plus a method/activity/status/attribute), keep ONLY the thing as the entity and move the descriptor to a fact. Merges into an existing entity when the name or any alias matches, so the same subject never duplicates — a qualifier baked into the name silently splits one subject into separate entities and breaks recall.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Full canonical name of the subject — never an abbreviation, code/ticker, or the subject combined with an attribute. Name + aliases is the dedup key, so keep it stable across mentions."},
                "aliases": {"type": "array", "items": {"type": "string"}, "description": "Every alternative form of the same subject — abbreviations, codes, alternate spellings, language variants. Listing them here merges later mentions into one entity instead of creating duplicates."},
                "metadata": {"type": "object"}
            },
            "required": ["name"]
        }),
        source: "core".to_string(),
    });
    let entity = h.entity.clone();
    tools.register_handler(
        "save_entity",
        make_handler(move |args| {
            let entity = entity.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Args {
                    name: String,
                    // 엔티티 type 은 휴면(선택) — 스키마에서 뺐으므로 보통 미전송, 와도 받되 기본은 빈 문자열.
                    #[serde(rename = "type", default)]
                    entity_type: String,
                    #[serde(default)]
                    aliases: Vec<String>,
                    #[serde(default)]
                    metadata: Option<serde_json::Value>,
                    // AiManager 안에서 hub_context 가 있을 때 자동 주입 (visitor 자료 격리).
                    #[serde(default)]
                    owner: Option<String>,
                }
                let parsed: Args = serde_json::from_value(args)
                    .map_err(|e| format!("save_entity args: {e}"))?;
                let (id, created) = entity
                    .save_entity(SaveEntityInput {
                        name: parsed.name,
                        entity_type: parsed.entity_type,
                        aliases: parsed.aliases,
                        metadata: parsed.metadata,
                        source_conv_id: None,
                        dedup_threshold: Some(0.92),
                        owner: parsed.owner,
                    })
                    .await?;
                Ok(serde_json::json!({"id": id, "created": created}))
            }
        }),
    );

    // save_entity_fact — entity timeline 저장
    tools.register(ToolDefinition {
        name: "save_entity_fact".to_string(),
        description: "Record a durable statement about a tracked entity — something that stays true about it OUTSIDE this conversation (state, attribute, decision, position, goal). NEVER log conversation activity ('the user asked/requested/wants to see X') — the conversation itself is already stored elsewhere; a fact must stand on its own when read later. Include figures/dates in content when present. factType groups the entity's facts: REUSE the label you see in <TRACKED_ENTITIES> or the entity's timeline for the same kind of statement — stable labels are what make value updates supersede cleanly. Set supersede=true when this is a NEW VALUE of a state the entity already has (an updated figure/level/status) so the old value retires into history instead of coexisting. Set explicit=true ONLY when the user explicitly asked to remember it; autonomous saves omit it and start at lower confidence until repeated observations promote them. Numeric time-series (price history, chart data) do NOT belong here.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "entityId": {"type": "integer"},
                "content": {"type": "string", "description": "1-2 natural sentences, self-sufficient later (state figures/dates/outcome when present)"},
                "factType": {"type": "string", "description": "kind of statement — reuse the entity's existing labels so the same kind groups together"},
                "occurredAt": {"type": "integer"},
                "tags": {"type": "array", "items": {"type": "string"}},
                "supersede": {"type": "boolean", "description": "true = new value of a state this entity already has (same factType) — retire the previous value into history"},
                "explicit": {"type": "boolean", "description": "true ONLY when the user explicitly asked to remember this"},
                "confidence": {"type": "number", "description": "0-1 promotion score override (omit normally)"}
            },
            "required": ["entityId", "content"]
        }),
        source: "core".to_string(),
    });
    let entity = h.entity.clone();
    tools.register_handler(
        "save_entity_fact",
        make_handler(move |args| {
            let entity = entity.clone();
            async move {
                let parsed: SaveFactInput = SaveFactInput {
                    entity_id: args
                        .get("entityId")
                        .and_then(|v| v.as_i64())
                        .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "entityId")]))?,
                    content: args
                        .get("content")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "content")]))?
                        .to_string(),
                    fact_type: args
                        .get("factType")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    occurred_at: args.get("occurredAt").and_then(|v| v.as_i64()),
                    tags: args
                        .get("tags")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                    source_conv_id: None,
                    ttl_days: args.get("ttlDays").and_then(|v| v.as_i64()),
                    dedup_threshold: args.get("dedupThreshold").and_then(|v| v.as_f64()),
                    owner: args.get("owner").and_then(|v| v.as_str()).map(String::from),
                    supersede: args.get("supersede").and_then(|v| v.as_bool()).unwrap_or(false),
                    explicit: args.get("explicit").and_then(|v| v.as_bool()).unwrap_or(false),
                    confidence: args.get("confidence").and_then(|v| v.as_f64()),
                };
                let (id, skipped, sim) = entity.save_fact(parsed).await?;
                Ok(serde_json::json!({"id": id, "skipped": skipped, "similarity": sim}))
            }
        }),
    );

    // search_entities
    tools.register(ToolDefinition {
        name: "search_entities".to_string(),
        description: "Search tracked entities (subjects the user asked to remember or the system observed — people, companies, stocks, projects) by name/alias/type, semantic. Use when the user references a subject you might already know. Next step: search_entity_facts for its durable facts, search_events for related events.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "type": {"type": "string"},
                "limit": {"type": "integer"}
            }
        }),
        source: "core".to_string(),
    });
    let entity = h.entity.clone();
    tools.register_handler(
        "search_entities",
        make_handler(move |args| {
            let entity = entity.clone();
            async move {
                let opts: EntitySearchOpts = serde_json::from_value(args)
                    .map_err(|e| format!("search_entities args: {e}"))?;
                let result = entity.search_entities(opts).await?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // get_entity_timeline
    tools.register(ToolDefinition {
        name: "get_entity_timeline".to_string(),
        description: "Entity 의 fact timeline (occurredAt 또는 createdAt 순).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "entityId": {"type": "integer"},
                "limit": {"type": "integer"},
                "orderBy": {"type": "string", "enum": ["occurredAt", "createdAt"]}
            },
            "required": ["entityId"]
        }),
        source: "core".to_string(),
    });
    let entity = h.entity.clone();
    tools.register_handler(
        "get_entity_timeline",
        make_handler(move |args| {
            let entity = entity.clone();
            async move {
                let entity_id = args
                    .get("entityId")
                    .and_then(|v| v.as_i64())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "entityId")]))?;
                let opts = TimelineOpts {
                    limit: args
                        .get("limit")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as usize),
                    offset: args
                        .get("offset")
                        .and_then(|v| v.as_u64())
                        .map(|n| n as usize),
                    order_by: args
                        .get("orderBy")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                    owner: args.get("owner").and_then(|v| v.as_str()).map(String::from),
                    include_inactive: false, // tools see promoted, active facts only
                };
                let result = entity.get_entity_timeline(entity_id, opts)?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // search_entity_facts
    tools.register(ToolDefinition {
        name: "search_entity_facts".to_string(),
        description: "Search durable facts attached to entities (states, attributes, decisions — e.g. an average purchase price) — query + entityId/factType/tags/time-range filters. Use to look up what is known about a subject BEFORE answering from memory; superseded/low-confidence facts are filtered automatically.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "entityId": {"type": "integer"},
                "factType": {"type": "string"},
                "limit": {"type": "integer"}
            }
        }),
        source: "core".to_string(),
    });
    let entity = h.entity.clone();
    tools.register_handler(
        "search_entity_facts",
        make_handler(move |args| {
            let entity = entity.clone();
            async move {
                let opts: FactSearchOpts = serde_json::from_value(args)
                    .map_err(|e| format!("search_entity_facts args: {e}"))?;
                let result = entity.search_facts(opts).await?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );
}

fn register_episodic_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // save_event
    tools.register(ToolDefinition {
        name: "save_event".to_string(),
        description: "Record something that happened (or is scheduled) in the WORLD at a point in time and is worth recalling later — a trade executed, a release/announcement, a decision the user made, a project/life milestone. NEVER log conversation activity ('user asked about X', 'analysis was requested') — requests and Q&A already live in conversation history, not here. Reuse the same type label for the same kind of occurrence. Link entityIds so the event shows on those entities' timelines. Set explicit=true only when the user explicitly asked to remember it.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"type": "string", "description": "kind of occurrence — reuse existing labels"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "occurredAt": {"type": "integer"},
                "entityIds": {"type": "array", "items": {"type": "integer"}},
                "explicit": {"type": "boolean", "description": "true ONLY when the user explicitly asked to remember this"},
                "confidence": {"type": "number", "description": "0-1 promotion score override (omit normally)"}
            },
            "required": ["type", "title"]
        }),
        source: "core".to_string(),
    });
    let episodic = h.episodic.clone();
    tools.register_handler(
        "save_event",
        make_handler(move |args| {
            let episodic = episodic.clone();
            async move {
                #[derive(serde::Deserialize)]
                struct Args {
                    #[serde(rename = "type")]
                    event_type: String,
                    title: String,
                    #[serde(default)]
                    description: Option<String>,
                    #[serde(rename = "occurredAt", default)]
                    occurred_at: Option<i64>,
                    #[serde(rename = "entityIds", default)]
                    entity_ids: Vec<i64>,
                    #[serde(rename = "ttlDays", default)]
                    ttl_days: Option<i64>,
                    #[serde(rename = "dedupThreshold", default)]
                    dedup_threshold: Option<f64>,
                    // AiManager 가 hub_context 가 있으면 자동 주입.
                    #[serde(default)]
                    owner: Option<String>,
                    #[serde(default)]
                    explicit: bool,
                    #[serde(default)]
                    confidence: Option<f64>,
                }
                let parsed: Args = serde_json::from_value(args)
                    .map_err(|e| format!("save_event args: {e}"))?;
                let (id, skipped, sim) = episodic
                    .save_event(SaveEventInput {
                        event_type: parsed.event_type,
                        title: parsed.title,
                        description: parsed.description,
                        who: None,
                        context: None,
                        occurred_at: parsed.occurred_at,
                        entity_ids: parsed.entity_ids,
                        source_conv_id: None,
                        ttl_days: parsed.ttl_days,
                        dedup_threshold: parsed.dedup_threshold,
                        owner: parsed.owner,
                        explicit: parsed.explicit,
                        confidence: parsed.confidence,
                    })
                    .await?;
                Ok(serde_json::json!({"id": id, "skipped": skipped, "similarity": sim}))
            }
        }),
    );

    // search_events
    tools.register(ToolDefinition {
        name: "search_events".to_string(),
        description: "Search recorded events (things that happened or are scheduled in the world — announcements, fills, user life events) — query + type/who/entityId/time-range filters. Use for when-did-X-happen questions about tracked subjects.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "type": {"type": "string"},
                "entityId": {"type": "integer"},
                "limit": {"type": "integer"}
            }
        }),
        source: "core".to_string(),
    });
    let episodic = h.episodic.clone();
    tools.register_handler(
        "search_events",
        make_handler(move |args| {
            let episodic = episodic.clone();
            async move {
                let opts: EventSearchOpts = serde_json::from_value(args)
                    .map_err(|e| format!("search_events args: {e}"))?;
                let result = episodic.search_events(opts).await?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // list_recent_events
    tools.register(ToolDefinition {
        name: "list_recent_events".to_string(),
        description: "최근 사건 목록 (occurredAt DESC). type / who 필터 옵션.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "who": {"type": "string"},
                "limit": {"type": "integer"}
            }
        }),
        source: "core".to_string(),
    });
    let episodic = h.episodic.clone();
    tools.register_handler(
        "list_recent_events",
        make_handler(move |args| {
            let episodic = episodic.clone();
            async move {
                let opts: ListRecentOpts = serde_json::from_value(args)
                    .map_err(|e| format!("list_recent_events args: {e}"))?;
                let result = episodic.list_recent_events(opts)?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );
}

fn register_consolidation_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // get_memory_stats — 4-tier 통계 (어드민 health stats)
    tools.register(ToolDefinition {
        name: "get_memory_stats".to_string(),
        description: "Recall 통계 (entities / facts / events 총수 + byType 분포).".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let consolidation = h.consolidation.clone();
    tools.register_handler(
        "get_memory_stats",
        make_handler(move |args| {
            let consolidation = consolidation.clone();
            async move {
                // owner-scoped: under hub context, inject_hub_owner sets args.owner (hub scope);
                // for admin, absent means admin scope. Not a global sum.
                let owner = args.get("owner").and_then(|v| v.as_str());
                let stats = consolidation.get_memory_stats(owner)?;
                Ok(serde_json::to_value(stats).unwrap_or_default())
            }
        }),
    );

    // consolidate_conversation — LLM 자동 추출 (entity/fact/event 추가).
    // ConsolidationManager.set_ai_hook 설정된 후 활성.
    tools.register(ToolDefinition {
        name: "consolidate_conversation".to_string(),
        description: "대화 1개 LLM 후처리 → entity/fact/event 자동 추출 + 저장. Recall 자동 누적용.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "owner": {"type": "string", "default": "admin"},
                "conversationId": {"type": "string"},
                "modelId": {"type": "string", "description": "(옵션) AI Assistant 모델 override"}
            },
            "required": ["conversationId"]
        }),
        source: "core".to_string(),
    });
    let consolidation = h.consolidation.clone();
    tools.register_handler(
        "consolidate_conversation",
        make_handler(move |args| {
            let consolidation = consolidation.clone();
            async move {
                let owner = args
                    .get("owner")
                    .and_then(|v| v.as_str())
                    .unwrap_or("admin")
                    .to_string();
                let conv_id = args
                    .get("conversationId")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "conversationId")]))?
                    .to_string();
                let model_id = args
                    .get("modelId")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let outcome = consolidation
                    .consolidate_conversation(&owner, &conv_id, model_id.as_deref())
                    .await?;
                Ok(serde_json::to_value(outcome).unwrap_or_default())
            }
        }),
    );
}

fn register_module_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // list_system_modules
    tools.register(ToolDefinition {
        name: "list_system_modules".to_string(),
        description: "system/modules/ 디렉토리 스캔 → config.json 기반 시스템 모듈 목록.".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let module = h.module.clone();
    tools.register_handler(
        "list_system_modules",
        make_handler(move |_args| {
            let module = module.clone();
            async move {
                let result = module.list_system_modules().await;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // list_user_modules
    tools.register(ToolDefinition {
        name: "list_user_modules".to_string(),
        description: "user/modules/ 디렉토리 스캔 → 사용자 모듈 목록.".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let module = h.module.clone();
    tools.register_handler(
        "list_user_modules",
        make_handler(move |_args| {
            let module = module.clone();
            async move {
                let result = module.list_user_modules().await;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // get_module_config — 특정 모듈의 config.json 반환
    tools.register(ToolDefinition {
        name: "get_module_config".to_string(),
        description: "특정 모듈의 config.json 조회 (system/modules/<name>/config.json 또는 user/modules/<name>/config.json).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "scope": {"type": "string", "enum": ["system", "user"]}
            },
            "required": ["name"]
        }),
        source: "core".to_string(),
    });
    let module = h.module.clone();
    tools.register_handler(
        "get_module_config",
        make_handler(move |args| {
            let module = module.clone();
            async move {
                let name = args
                    .get("name")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "name")]))?
                    .to_string();
                let scope = args
                    .get("scope")
                    .and_then(|v| v.as_str())
                    .unwrap_or("system");
                let result = module.get_module_config(scope, &name).await;
                Ok(result.unwrap_or(serde_json::Value::Null))
            }
        }),
    );
}

fn register_mcp_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // list_mcp_servers
    tools.register(ToolDefinition {
        name: "list_mcp_servers".to_string(),
        description: "등록된 외부 MCP 서버 목록.".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let mcp = h.mcp.clone();
    tools.register_handler(
        "list_mcp_servers",
        make_handler(move |_args| {
            let mcp = mcp.clone();
            async move { Ok(serde_json::to_value(mcp.list_servers()).unwrap_or_default()) }
        }),
    );

    // mcp_call — 외부 MCP 서버 도구 호출 (stdio + SSE 설정, 2026-05-07).
    // MCP 서버 핸들러(McpCallHandler)와 이름 통일 — 옛 call_mcp_tool 명칭 폐기 (양 경로 mcp_call).
    tools.register(ToolDefinition {
        name: "mcp_call".to_string(),
        description: "외부 MCP 서버의 도구 호출 (stdio 또는 SSE transport).".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "server": {"type": "string"},
                "tool": {"type": "string"},
                "arguments": {"type": "object"}
            },
            "required": ["server", "tool"]
        }),
        source: "core".to_string(),
    });
    let mcp = h.mcp.clone();
    tools.register_handler(
        "mcp_call",
        make_handler(move |args| {
            let mcp = mcp.clone();
            async move {
                let server = args
                    .get("server")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "server")]))?
                    .to_string();
                let tool = args
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| crate::i18n::t("core.error.ai.tool_arg_missing", None, &[("name", "tool")]))?
                    .to_string();
                let arguments = args
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                let result = mcp.call_tool(&server, &tool, &arguments).await?;
                Ok(result)
            }
        }),
    );
}

// Tests 이관 — `infra/tests/tool_registry_test.rs` (integration test).

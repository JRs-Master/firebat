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
use crate::managers::mcp::McpManager;
use crate::managers::media::MediaManager;
use crate::managers::module::ModuleManager;
use crate::managers::page::PageManager;
use crate::managers::schedule::ScheduleManager;
use crate::managers::tool::{make_handler, ToolDefinition, ToolManager};
use crate::ports::{
    CronScheduleOptions, EntitySearchOpts, EventSearchOpts, FactSearchOpts, IStoragePort,
    ListRecentOpts, MediaListOpts, MediaScope, SaveEntityInput, SaveEventInput, SaveFactInput,
    TimelineOpts,
};

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
    register_module_tools(tools, &h);
    register_mcp_tools(tools, &h);
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
        make_handler(move |_args| {
            let page = page.clone();
            async move { Ok(serde_json::to_value(page.list()).unwrap_or_default()) }
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
                    .ok_or_else(|| "slug 누락".to_string())?
                    .to_string();
                match page.get(&slug) {
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
    tools.register_handler(
        "delete_page",
        make_handler(move |args| {
            let page = page.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "slug 누락".to_string())?
                    .to_string();
                page.delete(&slug)?;
                Ok(serde_json::json!({"deleted": slug}))
            }
        }),
    );

    // save_page — PageSpec JSON 저장 (publish / draft / private). AdSense 글 발행 핵심.
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
    tools.register_handler(
        "save_page",
        make_handler(move |args| {
            let page = page.clone();
            async move {
                let slug = args
                    .get("slug")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "slug 누락".to_string())?
                    .to_string();
                let spec = args
                    .get("spec")
                    .ok_or_else(|| "spec 누락".to_string())?;
                let spec_str = serde_json::to_string(spec)
                    .map_err(|e| format!("spec 직렬화: {e}"))?;
                let status = args
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("published");
                let project = args.get("project").and_then(|v| v.as_str());
                let visibility = args.get("visibility").and_then(|v| v.as_str());
                let password = args.get("password").and_then(|v| v.as_str());
                page.save(&slug, &spec_str, status, project, visibility, password)?;
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
                    .ok_or_else(|| "path 누락".to_string())?
                    .to_string();
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
                    .ok_or_else(|| "path 누락".to_string())?
                    .to_string();
                let content = args
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "content 누락".to_string())?
                    .to_string();
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
                    .ok_or_else(|| "path 누락".to_string())?
                    .to_string();
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
                    .ok_or_else(|| "path 누락".to_string())?
                    .to_string();
                storage.delete(&path).await?;
                Ok(serde_json::json!({"deleted": path}))
            }
        }),
    );
}

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
        make_handler(move |_args| {
            let schedule = schedule.clone();
            async move { Ok(serde_json::to_value(schedule.list()).unwrap_or_default()) }
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
                    .ok_or_else(|| "jobId 누락".to_string())?
                    .to_string();
                schedule.cancel(&job_id).await?;
                Ok(serde_json::json!({"cancelled": job_id}))
            }
        }),
    );

    tools.register(ToolDefinition {
        name: "schedule_task".to_string(),
        description: "cron 잡 등록. cronTime (반복) / runAt (1회 예약) / delaySec (N초 후) 중 하나 필수.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "jobId": {"type": "string"},
                "targetPath": {"type": "string"},
                "cronTime": {"type": "string"},
                "runAt": {"type": "string"},
                "delaySec": {"type": "integer"},
                "title": {"type": "string"},
                "description": {"type": "string"}
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
                };
                let result = media.list(opts).await?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );
}

fn register_conversation_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    tools.register(ToolDefinition {
        name: "search_history".to_string(),
        description: "이전 대화 검색. Phase B-17+ 임베딩 박힌 후 의미 검색 활성. 현재는 owner='admin' 의 모든 대화 list.".to_string(),
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
                let _query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let list = conversation.list("admin");
                let limit = args
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as usize)
                    .unwrap_or(20)
                    .min(100);
                let trimmed: Vec<_> = list.into_iter().take(limit).collect();
                Ok(serde_json::to_value(trimmed).unwrap_or_default())
            }
        }),
    );
}

fn register_entity_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // save_entity — name+type upsert
    tools.register(ToolDefinition {
        name: "save_entity".to_string(),
        description: "Entity 저장 (name+type upsert). 종목·인물·프로젝트 추적 대상.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "type": {"type": "string"},
                "aliases": {"type": "array", "items": {"type": "string"}},
                "metadata": {"type": "object"}
            },
            "required": ["name", "type"]
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
                    #[serde(rename = "type")]
                    entity_type: String,
                    #[serde(default)]
                    aliases: Vec<String>,
                    #[serde(default)]
                    metadata: Option<serde_json::Value>,
                }
                let parsed: Args = serde_json::from_value(args)
                    .map_err(|e| format!("save_entity args: {e}"))?;
                let (id, created) = entity.save_entity(SaveEntityInput {
                    name: parsed.name,
                    entity_type: parsed.entity_type,
                    aliases: parsed.aliases,
                    metadata: parsed.metadata,
                    source_conv_id: None,
                })?;
                Ok(serde_json::json!({"id": id, "created": created}))
            }
        }),
    );

    // save_entity_fact — entity timeline 박음
    tools.register(ToolDefinition {
        name: "save_entity_fact".to_string(),
        description: "Entity 의 fact 박음 (entityId + content). occurredAt / tags / dedupThreshold 옵션.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "entityId": {"type": "integer"},
                "content": {"type": "string"},
                "factType": {"type": "string"},
                "occurredAt": {"type": "integer"},
                "tags": {"type": "array", "items": {"type": "string"}}
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
                        .ok_or_else(|| "entityId 누락".to_string())?,
                    content: args
                        .get("content")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| "content 누락".to_string())?
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
                };
                let (id, skipped, sim) = entity.save_fact(parsed)?;
                Ok(serde_json::json!({"id": id, "skipped": skipped, "similarity": sim}))
            }
        }),
    );

    // search_entities
    tools.register(ToolDefinition {
        name: "search_entities".to_string(),
        description: "Entity 검색 (query + type 필터). Phase B-15+ 임베딩 박힌 후 cosine.".to_string(),
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
                let result = entity.search_entities(opts)?;
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
                    .ok_or_else(|| "entityId 누락".to_string())?;
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
                };
                let result = entity.get_entity_timeline(entity_id, opts)?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );

    // search_entity_facts
    tools.register(ToolDefinition {
        name: "search_entity_facts".to_string(),
        description: "Fact 검색 (query + entityId/factType/tags/시간범위 필터).".to_string(),
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
                let result = entity.search_facts(opts)?;
                Ok(serde_json::to_value(result).unwrap_or_default())
            }
        }),
    );
}

fn register_episodic_tools(tools: &Arc<ToolManager>, h: &CoreToolHandlers) {
    // save_event
    tools.register(ToolDefinition {
        name: "save_event".to_string(),
        description: "사건 박음 (type + title 필수). entityIds 박으면 m2m link 자동.".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "occurredAt": {"type": "integer"},
                "entityIds": {"type": "array", "items": {"type": "integer"}}
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
                }
                let parsed: Args = serde_json::from_value(args)
                    .map_err(|e| format!("save_event args: {e}"))?;
                let (id, skipped, sim) = episodic.save_event(SaveEventInput {
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
                })?;
                Ok(serde_json::json!({"id": id, "skipped": skipped, "similarity": sim}))
            }
        }),
    );

    // search_events
    tools.register(ToolDefinition {
        name: "search_events".to_string(),
        description: "사건 검색 (query + type/who/entityId/시간범위 필터).".to_string(),
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
                let result = episodic.search_events(opts)?;
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
        description: "메모리 4-tier 통계 (entities / facts / events 총수 + byType 분포).".to_string(),
        parameters: serde_json::json!({"type": "object", "properties": {}}),
        source: "core".to_string(),
    });
    let consolidation = h.consolidation.clone();
    tools.register_handler(
        "get_memory_stats",
        make_handler(move |_args| {
            let consolidation = consolidation.clone();
            async move {
                let stats = consolidation.get_memory_stats()?;
                Ok(serde_json::to_value(stats).unwrap_or_default())
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
                    .ok_or_else(|| "name 누락".to_string())?
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

    // call_mcp_tool — Phase B-15+ rmcp 박힌 후 진짜 호출 (현재 stub error 반환)
    tools.register(ToolDefinition {
        name: "call_mcp_tool".to_string(),
        description: "외부 MCP 서버의 도구 호출. Phase B-15+ rmcp 박힌 후 활성.".to_string(),
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
        "call_mcp_tool",
        make_handler(move |args| {
            let mcp = mcp.clone();
            async move {
                let server = args
                    .get("server")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "server 누락".to_string())?
                    .to_string();
                let tool = args
                    .get("tool")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "tool 누락".to_string())?
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::cron::TokioCronAdapter;
    use crate::adapters::database::SqliteDatabaseAdapter;
    use crate::adapters::mcp_client::McpClientFileAdapter;
    use crate::adapters::media::LocalMediaAdapter;
    use crate::adapters::memory::SqliteMemoryAdapter;
    use crate::adapters::sandbox::ProcessSandboxAdapter;
    use crate::adapters::storage::LocalStorageAdapter;
    use crate::ports::{
        IDatabasePort, IEntityPort, IEpisodicPort, IMcpClientPort, IMediaPort, ISandboxPort,
        IVaultPort,
    };
    use crate::adapters::vault::SqliteVaultAdapter;
    use tempfile::tempdir;

    async fn make_setup() -> (Arc<ToolManager>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db: Arc<dyn IDatabasePort> =
            Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let vault: Arc<dyn IVaultPort> =
            Arc::new(SqliteVaultAdapter::new(dir.path().join("vault.db")).unwrap());
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
        let media: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));
        let sandbox: Arc<dyn ISandboxPort> =
            Arc::new(ProcessSandboxAdapter::new(dir.path().to_path_buf()));
        let mcp_client: Arc<dyn IMcpClientPort> =
            Arc::new(McpClientFileAdapter::new(dir.path().join("mcp.json")).unwrap());
        let memory_adapter = Arc::new(SqliteMemoryAdapter::new_in_memory().unwrap());
        let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
        let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter;

        let page_mgr = Arc::new(PageManager::new(db.clone(), storage.clone()));
        let conv_mgr = Arc::new(ConversationManager::new(db));
        let media_mgr = Arc::new(MediaManager::new(media));
        let module_mgr = Arc::new(ModuleManager::new(
            sandbox,
            storage.clone(),
            vault.clone(),
        ));
        let mcp_mgr = Arc::new(McpManager::new(mcp_client));
        let entity_mgr = Arc::new(EntityManager::new(entity_port));
        let episodic_mgr = Arc::new(EpisodicManager::new(episodic_port));
        let consolidation_mgr = Arc::new(ConsolidationManager::new(
            entity_mgr.clone(),
            episodic_mgr.clone(),
        ));

        let cron = TokioCronAdapter::new(
            dir.path().join("cron.json"),
            dir.path().join("cron-logs.json"),
            dir.path().join("cron-notes.json"),
            "Asia/Seoul",
        )
        .unwrap();
        let schedule_mgr = Arc::new(ScheduleManager::new(cron));

        let tools = Arc::new(ToolManager::new());
        register_core_tools(
            &tools,
            CoreToolHandlers {
                page: page_mgr,
                schedule: schedule_mgr,
                media: media_mgr,
                conversation: conv_mgr,
                storage,
                entity: entity_mgr,
                episodic: episodic_mgr,
                consolidation: consolidation_mgr,
                module: module_mgr,
                mcp: mcp_mgr,
            },
        );
        (tools, dir)
    }

    #[tokio::test]
    async fn dispatch_list_pages_returns_array() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("list_pages", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(result.is_array());
    }

    #[tokio::test]
    async fn dispatch_write_then_read_file() {
        let (tools, dir) = make_setup().await;
        let test_path = "test.txt";
        tools
            .dispatch(
                "write_file",
                &serde_json::json!({"path": test_path, "content": "hello"}),
            )
            .await
            .unwrap();
        let result = tools
            .dispatch("read_file", &serde_json::json!({"path": test_path}))
            .await
            .unwrap();
        assert_eq!(result["content"], "hello");
        let abs = dir.path().join(test_path);
        assert!(abs.exists());
    }

    #[tokio::test]
    async fn dispatch_get_page_missing_returns_null() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("get_page", &serde_json::json!({"slug": "missing"}))
            .await
            .unwrap();
        assert_eq!(result, serde_json::Value::Null);
    }

    #[tokio::test]
    async fn dispatch_search_media_empty_returns_zero() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("search_media", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(result["total"], 0);
    }

    #[tokio::test]
    async fn dispatch_list_cron_jobs_empty() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("list_cron_jobs", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(result.is_array());
        assert_eq!(result.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn dispatch_unknown_tool_returns_error() {
        let (tools, _dir) = make_setup().await;
        let result = tools.dispatch("nonexistent", &serde_json::json!({})).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn registered_tool_count() {
        let (tools, _dir) = make_setup().await;
        let stats = tools.stats();
        // page: 4 (list/get/delete/save) + storage: 4 + schedule: 3 + media: 1 +
        // conversation: 1 + entity: 5 + episodic: 3 + consolidation: 1 + module: 3 + mcp: 2 = 27
        assert_eq!(stats.total, 27);
        assert_eq!(stats.by_source.get("core").copied(), Some(27));
    }

    #[tokio::test]
    async fn dispatch_save_page_persists_to_db() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch(
                "save_page",
                &serde_json::json!({
                    "slug": "ad-test-1",
                    "spec": {"body": [{"type": "Text", "props": {"content": "AdSense 글"}}]},
                    "status": "published"
                }),
            )
            .await
            .unwrap();
        assert_eq!(result["slug"], "ad-test-1");
        // 실 DB 저장 검증 — list_pages 호출
        let list = tools
            .dispatch("list_pages", &serde_json::json!({}))
            .await
            .unwrap();
        let arr = list.as_array().unwrap();
        assert!(arr.iter().any(|p| p["slug"] == "ad-test-1"));
    }

    #[tokio::test]
    async fn dispatch_save_entity_then_search() {
        let (tools, _dir) = make_setup().await;
        tools
            .dispatch(
                "save_entity",
                &serde_json::json!({"name": "삼성전자", "type": "stock", "aliases": ["005930"]}),
            )
            .await
            .unwrap();
        let result = tools
            .dispatch(
                "search_entities",
                &serde_json::json!({"query": "삼성"}),
            )
            .await
            .unwrap();
        let arr = result.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["name"], "삼성전자");
    }

    #[tokio::test]
    async fn dispatch_save_event_and_recent() {
        let (tools, _dir) = make_setup().await;
        tools
            .dispatch(
                "save_event",
                &serde_json::json!({"type": "page_publish", "title": "글 발행 완료"}),
            )
            .await
            .unwrap();
        let recent = tools
            .dispatch(
                "list_recent_events",
                &serde_json::json!({"type": "page_publish", "limit": 10}),
            )
            .await
            .unwrap();
        let arr = recent.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["title"], "글 발행 완료");
    }

    #[tokio::test]
    async fn dispatch_get_memory_stats_returns_zero() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("get_memory_stats", &serde_json::json!({}))
            .await
            .unwrap();
        assert_eq!(result["entities"], 0);
        assert_eq!(result["events"], 0);
    }

    #[tokio::test]
    async fn dispatch_list_mcp_servers_empty() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("list_mcp_servers", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(result.is_array());
        assert_eq!(result.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn dispatch_list_user_modules_returns_array() {
        let (tools, _dir) = make_setup().await;
        let result = tools
            .dispatch("list_user_modules", &serde_json::json!({}))
            .await
            .unwrap();
        assert!(result.is_array());
    }
}

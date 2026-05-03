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

use crate::adapters::cron::TokioCronAdapter;
use crate::managers::conversation::ConversationManager;
use crate::managers::media::MediaManager;
use crate::managers::page::PageManager;
use crate::managers::schedule::ScheduleManager;
use crate::managers::tool::{make_handler, ToolDefinition, ToolManager};
use crate::ports::{CronScheduleOptions, IStoragePort, MediaListOpts, MediaScope};

pub struct CoreToolHandlers {
    pub page: Arc<PageManager>,
    pub schedule: Arc<ScheduleManager>,
    pub media: Arc<MediaManager>,
    pub conversation: Arc<ConversationManager>,
    pub storage: Arc<dyn IStoragePort>,
}

/// 정적 도구 N개 등록. ToolManager.register (메타) + register_handler (closure).
/// AiManager.process_with_tools 가 dispatch 호출 시 매니저 메서드 자동 호출.
pub fn register_core_tools(tools: &Arc<ToolManager>, h: CoreToolHandlers) {
    register_page_tools(tools, &h);
    register_storage_tools(tools, &h);
    register_schedule_tools(tools, &h);
    register_media_tools(tools, &h);
    register_conversation_tools(tools, &h);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::database::SqliteDatabaseAdapter;
    use crate::adapters::media::LocalMediaAdapter;
    use crate::adapters::storage::LocalStorageAdapter;
    use crate::ports::{IDatabasePort, IMediaPort};
    use tempfile::tempdir;

    async fn make_setup() -> (Arc<ToolManager>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db: Arc<dyn IDatabasePort> =
            Arc::new(SqliteDatabaseAdapter::new_in_memory().unwrap());
        let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(dir.path()));
        let media: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(dir.path()));

        let page_mgr = Arc::new(PageManager::new(db.clone(), storage.clone()));
        let conv_mgr = Arc::new(ConversationManager::new(db));
        let media_mgr = Arc::new(MediaManager::new(media));

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
        // page: 3 + storage: 4 + schedule: 3 + media: 1 + conversation: 1 = 12
        assert_eq!(stats.total, 12);
        assert_eq!(stats.by_source.get("core").copied(), Some(12));
    }
}

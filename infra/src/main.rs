//! Firebat Core — gRPC server entry (self-hosted distribution).
//!
//! Phase B 진행하며 21 매니저 + cross-cutting service 등록.
//! Phase B-17b: SIGTERM + SIGINT 통합 graceful shutdown — Docker / systemd 운영 시 SQLite WAL
//! 손상 방지. anyhow Context 로 부팅 실패 원인 역추적 가능.

use anyhow::{Context, Result};
use std::path::PathBuf;
use std::sync::Arc;
use tonic::transport::Server;

use firebat_infra::adapters::{
    auth::VaultAuthAdapter, cron::TokioCronAdapter, database::SqliteDatabaseAdapter,
    embedder::{ArcticLocalEmbedderAdapter, E5LocalEmbedderAdapter, StubEmbedderAdapter},
    image_gen::StubImageGenAdapter,
    image_processor::{ImageRsProcessorAdapter, StubImageProcessorAdapter},
    mcp_client::McpClientFileAdapter, media::LocalMediaAdapter,
    memory::SqliteMemoryAdapter, network::ReqwestNetworkAdapter,
    sandbox::ProcessSandboxAdapter, storage::LocalStorageAdapter,
    tracing_log::{init_tracing, TracingLogAdapter}, vault::SqliteVaultAdapter,
};
use firebat_core::{
    managers::{
        ai::AiManager, auth::AuthManager, capability::CapabilityManager,
        consolidation::ConsolidationManager, conversation::ConversationManager,
        cost::CostManager, entity::EntityManager, episodic::EpisodicManager, event::EventManager,
        mcp::McpManager, media::MediaManager, memory_facade::MemoryFacade, module::ModuleManager,
        page::PageManager, project::ProjectManager, schedule::ScheduleManager,
        secret::SecretManager, status::StatusManager,
        task::{TaskExecutor, TaskManager}, template::TemplateManager,
        tool::ToolManager,
    },
    ports::{
        IAuthPort, ICronPort, IDatabasePort, IEmbedderPort, IEntityPort, IEpisodicPort,
        IImageGenPort, IImageProcessorPort, ILlmPort, ILogPort, IMcpClientPort, IMediaPort,
        IMemoryFacadePort, INetworkPort, ISandboxPort, IStoragePort, IVaultPort,
    },
    proto::{
        ai_service_server::AiServiceServer,
        auth_service_server::AuthServiceServer,
        memory_service_server::MemoryServiceServer,
        capability_service_server::CapabilityServiceServer,
        cache_service_server::CacheServiceServer,
        database_service_server::DatabaseServiceServer,
        lifecycle_service_server::LifecycleServiceServer,
        network_service_server::NetworkServiceServer,
        settings_service_server::SettingsServiceServer,
        storage_service_server::StorageServiceServer,
        telegram_service_server::TelegramServiceServer,
        consolidation_service_server::ConsolidationServiceServer,
        conversation_service_server::ConversationServiceServer,
        cost_service_server::CostServiceServer,
        entity_service_server::EntityServiceServer,
        episodic_service_server::EpisodicServiceServer,
        event_service_server::EventServiceServer,
        mcp_service_server::McpServiceServer,
        module_service_server::ModuleServiceServer,
        media_service_server::MediaServiceServer,
        page_service_server::PageServiceServer,
        project_service_server::ProjectServiceServer,
        schedule_service_server::ScheduleServiceServer,
        secret_service_server::SecretServiceServer,
        status_service_server::StatusServiceServer,
        task_service_server::TaskServiceServer,
        template_service_server::TemplateServiceServer,
        tool_service_server::ToolServiceServer,
    },
    grpc,
};

#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    // Phase B-17.5c — tracing 초기화 (env RUST_LOG / FIREBAT_LOG_FORMAT=json 토글)
    init_tracing();
    tracing::info!(version = firebat_core::version(), "Firebat Core 부팅");

    // Phase 5 정공 — LLM model registry JSON 로드. 옛 builtin_models() Rust 하드코드 폐기.
    // 파일 미발견 시 stub 폴백 (panic X). FIREBAT_LLM_MODELS_PATH env 으로 위치 override.
    firebat_infra::llm::registry_loader::init_from_file();

    // 환경 변수 — workspace root + listen address + vault DB path
    let workspace_root: PathBuf = std::env::var("FIREBAT_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap());

    // i18n loader — language/{lang}.json + system/modules/*/lang + system/services/*/lang + system/prompts/*/lang 자동 scan.
    firebat_core::i18n::init(&workspace_root);

    let listen_addr = std::env::var("FIREBAT_CORE_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:50051".to_string());
    let vault_db_path = std::env::var("FIREBAT_VAULT_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("vault.db"));
    let app_db_path = std::env::var("FIREBAT_APP_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("app.db"));
    let mcp_servers_path = std::env::var("FIREBAT_MCP_SERVERS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("mcp-servers.json"));
    let memory_db_path = std::env::var("FIREBAT_MEMORY_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("memory.db"));
    let cron_jobs_path = std::env::var("FIREBAT_CRON_JOBS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("cron-jobs.json"));
    let cron_logs_path = std::env::var("FIREBAT_CRON_LOGS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("cron-logs.json"));
    let cron_notifications_path = std::env::var("FIREBAT_CRON_NOTIFICATIONS")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("cron-notifications.json"));
    // 옛 FIREBAT_TIMEZONE env 박은 분기 폐기 → vault single source (아래 vault 선언 후 결정).
    // 옛 위치 (L108) 의 결정은 vault 미선언 → vault.get_secret 호출 불가. cron adapter (L215)
    // 직전으로 이동.
    let addr = listen_addr.parse().with_context(|| {
        format!("FIREBAT_CORE_LISTEN '{}' 파싱 실패 — host:port 형식 필요", listen_addr)
    })?;

    eprintln!(
        "Firebat Core v{} — gRPC server starting on {}",
        firebat_core::version(),
        listen_addr
    );
    eprintln!(
        "  workspace: {}\n  vault DB:  {}",
        workspace_root.display(),
        vault_db_path.display()
    );

    // 어댑터 wiring — InfraResult<T,String> 을 anyhow::Error 로 변환 (with_context 로 원인 역추적).
    // Phase B-17.5c — TracingLogAdapter 로 swap (옛 ConsoleLogAdapter 는 tests/dev 용 보존).
    let logger: Arc<dyn ILogPort> = Arc::new(TracingLogAdapter::new());
    let storage: Arc<dyn IStoragePort> = Arc::new(LocalStorageAdapter::new(&workspace_root));
    let vault: Arc<dyn IVaultPort> = Arc::new(
        SqliteVaultAdapter::new(&vault_db_path)
            .map_err(anyhow::Error::msg)
            .context("Vault DB open 실패")?,
    );
    let auth_port: Arc<dyn IAuthPort> = Arc::new(VaultAuthAdapter::new(vault.clone()));

    // i18n default lang — vault `system:ui-lang` setting 박은 server 부팅 시점 단일 lookup.
    // 사용자 SettingsModal 박은 lang 변경 시점 = settings RPC handler 박은 set_default_lang 호출
    // (별도 step) 박은 즉시 반영. multi-user 환경 시점 = 매 RPC metadata propagation 별도 sprint.
    let default_lang = firebat_infra::grpc_interceptor::resolve_default_lang(&vault);
    firebat_core::i18n::set_default_lang(&default_lang);
    tracing::info!(default_lang, "i18n: default lang from vault");
    let db: Arc<dyn IDatabasePort> = Arc::new(
        SqliteDatabaseAdapter::new(&app_db_path)
            .map_err(anyhow::Error::msg)
            .context("App DB open 실패")?,
    );
    // Sandbox 어댑터는 status_manager 의존 (heavy 패키지 background install 진행 상태 노출) —
    // event_manager + status_manager wiring 박은 후 생성.
    let mcp_client: Arc<dyn IMcpClientPort> = Arc::new(
        McpClientFileAdapter::new(mcp_servers_path)
            .map_err(anyhow::Error::msg)
            .context("MCP servers 파일 open 실패")?,
    );
    // IEmbedderPort — env `FIREBAT_EMBEDDER` 으로 swap:
    //   - `arctic` (운영 default 권장, 2026-05-17): candle + Snowflake/snowflake-arctic-embed-l-v2.0
    //          (XLM-RoBERTa-large 기반, 1024-dim, max_length 8192, ~1.1GB safetensors).
    //          MTEB 다국어 65.8 + 한국어 매우 우수 + 긴 자료 영역 자연 (Library Phase 1 영역 정공).
    //          첫 실행 시 자동 다운로드 (HuggingFace Hub, hf-hub 캐싱).
    //   - `e5`: 옛 영역 — candle + intfloat/multilingual-e5-small (384-dim, max_length 512, ~470MB).
    //          가벼운 환경 / 옛 데이터 호환 영역.
    //   - `stub` (CI / dev): FNV-1a hash 결정론, 의미 검색 X. 모델 다운로드 없이 wiring 검증 + 단위 테스트.
    // 추후 cloud provider (Gemini / OpenAI / Voyage 등) 추가 시 같은 env 패턴.
    let embedder_kind = std::env::var("FIREBAT_EMBEDDER").unwrap_or_else(|_| "arctic".to_string());
    let embedder: Arc<dyn IEmbedderPort> = match embedder_kind.as_str() {
        "arctic" => {
            tracing::info!(
                "Embedder: Arctic Embed L v2.0 (Snowflake/snowflake-arctic-embed-l-v2.0, 1024-dim, max_length 8192, 첫 호출 시 ~1.1GB 다운로드)"
            );
            Arc::new(ArcticLocalEmbedderAdapter::new())
        }
        "e5" => {
            tracing::info!(
                "Embedder: E5 local (intfloat/multilingual-e5-small, 384-dim, 첫 호출 시 모델 다운로드)"
            );
            Arc::new(E5LocalEmbedderAdapter::new())
        }
        _ => {
            tracing::info!("Embedder: stub (FNV-1a hash, 의미 검색 X — env FIREBAT_EMBEDDER=arctic 으로 활성)");
            Arc::new(StubEmbedderAdapter::new())
        }
    };

    // Phase B-18 Step 1.5 — SqliteMemoryAdapter 에 embedder 주입 →
    // saveEntity / saveFact / saveEvent 자동 임베딩 + searchEntities/Facts/Events cosine 활성.
    let memory_adapter = Arc::new(
        SqliteMemoryAdapter::new(&memory_db_path)
            .map_err(anyhow::Error::msg)
            .context("Memory DB open 실패")?
            .with_embedder(embedder.clone()),
    );
    let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter.clone();
    // Timezone single source — vault (SetupWizard 박은 값) 우선, env fallback, default Asia/Seoul.
    // 2026-05-14: 옛 systemd unit 의 FIREBAT_TIMEZONE env 박은 패턴 폐기 가능 → vault single source.
    // child sysmod 가 process.env.FIREBAT_TZ / TZ 자동 inherit (sandbox spawn 시 부모 env 전달).
    // 변경 시점에 systemctl restart 필요 (env 변경은 부팅 시점에만 박힘 — main thread 안전).
    let default_timezone = vault
        .get_secret(firebat_core::vault_keys::VK_SYSTEM_TIMEZONE)
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("FIREBAT_TIMEZONE").ok())
        .unwrap_or_else(|| "Asia/Seoul".to_string());
    // SAFETY: main 부팅 시점 single-thread — std::env::set_var multi-thread race 0.
    unsafe {
        std::env::set_var("FIREBAT_TZ", &default_timezone);
        std::env::set_var("TZ", &default_timezone);
    }
    let cron_adapter: Arc<dyn ICronPort> = TokioCronAdapter::new(
        cron_jobs_path,
        cron_logs_path,
        cron_notifications_path,
        &default_timezone,
    )
    .map_err(anyhow::Error::msg)
    .context("Cron 어댑터 초기화 실패")?;
    let media: Arc<dyn IMediaPort> = Arc::new(LocalMediaAdapter::new(&workspace_root));

    // Phase B-18 Step 2 — IImageProcessorPort + IImageGenPort.
    // env `FIREBAT_IMAGE_PROCESSOR`:
    //   - `image-rs` (default 권장) — image-rs + fast_image_resize + blurhash crate. 옛 TS sharp 1:1.
    //   - `stub` — 단위 테스트 용 no-op (1x1 grey PNG / no-op resize).
    // env `FIREBAT_IMAGE_GEN`:
    //   - `stub` (default — Step 2c 설정될 ConfigDrivenImageGenAdapter 박히기 전 placeholder)
    //   - Step 2c 설정될 어댑터: ConfigDrivenImageGenAdapter (4 format — openai/gemini/codex CLI)
    // 어댑터 swap 시 매니저 / tool_registry 코드 변경 0건 (인터페이스 동일).
    let processor_kind = std::env::var("FIREBAT_IMAGE_PROCESSOR")
        .unwrap_or_else(|_| "image-rs".to_string());
    let image_processor: Arc<dyn IImageProcessorPort> = match processor_kind.as_str() {
        "stub" => {
            tracing::info!("Image processor: stub (no-op, 단위 테스트 용)");
            Arc::new(StubImageProcessorAdapter::new())
        }
        _ => {
            tracing::info!("Image processor: image-rs (variants/blurhash/placeholder 활성)");
            Arc::new(ImageRsProcessorAdapter::new())
        }
    };
    // Image gen — env `FIREBAT_IMAGE_GEN`:
    //   - `config-driven` (default 권장) — ConfigDrivenImageGenAdapter (3 format: openai-image /
    //     gemini-native-image / cli-codex-image). Vault `system:image:model` 으로 swap.
    //     builtin 3 모델 + `system/image/configs/*.json` 사용자 추가 자동 로드.
    //   - `stub` — 단위 테스트 / 1x1 grey PNG.
    // 디폴트 빈 문자열 — 사용자가 어드민 설정에서 명시 선택 설정할 때까지 호출 거부.
    // (옛 `gpt-image-1` 폴백 제거 — OPENAI_API_KEY 미설정 사용자에게 silent fail 회피).
    let image_default_model = std::env::var("FIREBAT_DEFAULT_IMAGE_MODEL")
        .unwrap_or_default();
    let image_configs_dir = workspace_root.join("system").join("image").join("configs");
    let image_gen_kind = std::env::var("FIREBAT_IMAGE_GEN")
        .unwrap_or_else(|_| "config-driven".to_string());
    let image_gen: Arc<dyn IImageGenPort> = match image_gen_kind.as_str() {
        "stub" => {
            tracing::info!("Image gen: stub (1x1 grey PNG)");
            Arc::new(StubImageGenAdapter::new())
        }
        _ => {
            tracing::info!(
                default_model = %image_default_model,
                "Image gen: ConfigDrivenImageGenAdapter (openai-image / gemini-native-image / cli-codex-image)"
            );
            Arc::new(
                firebat_infra::image_gen::ConfigDrivenImageGenAdapter::with_configs_dir(
                    vault.clone(),
                    image_default_model,
                    Some(&image_configs_dir),
                ),
            )
        }
    };
    // Phase B-17 — ConfigDrivenAdapter. 8 format (5 API + 3 CLI) 핸들러 설정.
    // 모델 carousel: builtin 8개 + system/llm/configs/*.json 자동 로드 (사용자 모델 추가).
    // 새 모델 = JSON 파일 1개 추가 (옛 TS infra/llm/configs/*.json 동등). 코드 변경 0.
    // Vault `system:llm:model` 으로 활성 모델 동적 swap.
    // 디폴트 빈 문자열 — frontend 가 사용자 명시 선택 설정할 때까지 호출 거부.
    // (cron 등 backend-only 호출 시 명시 모델 ID 전달 의무 — silent 폴백 회피).
    let default_model = std::env::var("FIREBAT_DEFAULT_MODEL").unwrap_or_default();
    let llm_configs_dir = workspace_root.join("system").join("llm").join("configs");
    let llm: Arc<dyn ILlmPort> = Arc::new(
        firebat_infra::llm::adapter::ConfigDrivenAdapter::with_configs_dir(
            vault.clone(),
            default_model,
            Some(&llm_configs_dir),
        ),
    );

    // 매니저 wiring
    let template_manager = Arc::new(TemplateManager::new(storage.clone()));
    let secret_manager = Arc::new(SecretManager::new(vault.clone(), storage.clone()));
    // INotifierPort — Telegram 어댑터. AuthManager 가 brute force lock 발생 시 호출.
    // 어댑터 자체가 module settings 의 bruteForceAlert 토글 검사 → OFF 시 silent skip.
    let notifier: Arc<dyn firebat_core::ports::INotifierPort> =
        Arc::new(firebat_infra::adapters::notifier_telegram::TelegramNotifierAdapter::new(vault.clone()));
    let auth_manager = Arc::new(
        AuthManager::new(auth_port, vault.clone()).with_notifier(notifier.clone()),
    );
    let event_manager = Arc::new(EventManager::new(logger.clone()));
    let capability_manager = Arc::new(CapabilityManager::new(
        storage.clone(),
        vault.clone(),
        logger.clone(),
    ));
    let status_manager = Arc::new(StatusManager::new(Some(event_manager.clone())));

    // Sandbox 어댑터 — BasicProcessSandbox 단일 (path containment + timeout 만).
    // 옛 LinuxCgroupsSandbox (cgroup v2 + seccomp + network namespace) 폐기 (2026-05-15) —
    // 단일 사용자 / 단일 운영자 환경에서 격리 가치 0 (사용자 본인 = 운영자 = trust). multi-tenant
    // 시점 = docker / firecracker / gvisor 같은 표준 도구 도입 별도 sprint.
    //
    // status_manager 주입 = config.json packages 의 heavy:true 엔트리 (playwright / pandas-large 등)
    // 자동 background install + frontend ActiveJobsIndicator 진행 상태 노출. 일반 string entry
    // 또는 heavy:false = 옛 동작 (foreground install).
    let sandbox: Arc<dyn ISandboxPort> = Arc::new(
        ProcessSandboxAdapter::new(workspace_root.clone())
            .with_vault(vault.clone())
            .with_status(status_manager.clone()),
    );

    let tool_manager = Arc::new(ToolManager::new());
    let cost_manager = Arc::new(CostManager::new(db.clone(), vault.clone()));
    let project_manager = Arc::new(ProjectManager::new(
        storage.clone(),
        db.clone(),
        vault.clone(),
    ));
    let module_manager = Arc::new(ModuleManager::new(
        sandbox.clone(),
        storage.clone(),
        vault.clone(),
    ));
    let page_manager = Arc::new(PageManager::new(db.clone(), storage.clone()));
    // Phase B-18 Step 1.5 — ConversationManager 에 embedder + log 주입 →
    // save() 시 메시지 단위 임베딩 자동 sync + search_history cosine 검색 활성.
    let conversation_manager = Arc::new(
        ConversationManager::new(db.clone())
            .with_embedder(embedder.clone())
            .with_log(logger.clone()),
    );
    let mcp_manager = Arc::new(McpManager::new(mcp_client));
    let entity_manager = Arc::new(EntityManager::new(entity_port));
    let episodic_manager = Arc::new(EpisodicManager::new(episodic_port));
    // 메모리 4-tier facade — ConsolidationManager 가 EntityManager + EpisodicManager 를 직접
    // 의존하던 BIBLE 위반 (매니저 간 직접 호출) 정정 (2026-05-06).
    let memory_facade: Arc<dyn IMemoryFacadePort> = Arc::new(MemoryFacade::new(
        entity_manager.clone(),
        episodic_manager.clone(),
    ));
    let consolidation_manager = Arc::new(ConsolidationManager::new(memory_facade));
    let schedule_manager = Arc::new(ScheduleManager::new(cron_adapter.clone()));
    // MediaManager — Step 2d 설정. 이미지 파이프라인 (generate/regenerate/variants/blurhash) 활성.
    // Step 2 마무리 audit — cross-call hooks (cost/status/event/episodic) 등록 (옛 TS Core facade 1:1):
    //   - cost: 이미지 cost_usd 자동 record (image_gen purpose)
    //   - status: rendering → done/error 가시화 (어드민 ActiveJobsIndicator)
    //   - event: 갤러리 SSE refresh (placeholder 등장 + 백그라운드 swap 시점 모두)
    //   - episodic: image_gen 사건 자동 리콜 누적 (AI 미개입)
    let media_manager = Arc::new(
        MediaManager::new(media)
            .with_image_gen(image_gen.clone())
            .with_processor(image_processor.clone())
            .with_vault(vault.clone())
            .with_log(logger.clone())
            .with_cost(cost_manager.clone())
            .with_status(status_manager.clone())
            .with_event(event_manager.clone())
            .with_episodic(episodic_manager.clone()),
    );
    // PromptBuilder + SystemContextGatherer + HistoryResolver + CostManager 설정된 채로:
    // - 시스템 프롬프트 자동 주입
    // - sysmod/MCP 동적 description
    // - opts.conversation_id 설정되어 있을 시 recent N 메시지 자동 prepend
    // - LLM 호출마다 자동 비용 누적 (옛 TS recordLlmCost 1:1)
    // DynamicToolRegistry — sysmod_* / mcp_* 동적 도구 자동 등록 (60초 cache).
    // Phase B-post audit E3 (2026-05-06) 설정 — 옛 TS buildToolDefinitions 1:1 port.
    let dynamic_tools_registry = Arc::new(
        firebat_core::managers::ai::dynamic_tools::DynamicToolRegistry::new(
            tool_manager.clone(),
            module_manager.clone(),
            mcp_manager.clone(),
        ),
    );
    // 시스템 prompt 본문 — `system/prompts/{name}/lang/{lang}.md` 위치. 부팅 시점 `i18n::init`
    // (main.rs:87) 의 통합 다국어 loader 가 자동 scan + `prompt.{name}` namespace 안 cache.
    // PromptBuilder 가 매 build 시점 `i18n::prompt(name, None)` 직접 lookup — adapter wiring 0
    // (2026-05-16 옛 IPromptLoaderPort / FilePromptLoader 폐기).
    // EnvConfigAdapter — std::env::var 직접 호출 추상화 (2026-05-13 Hexagonal 정공).
    let config_port: Arc<dyn firebat_core::ports::IConfigPort> = Arc::new(
        firebat_infra::adapters::config::EnvConfigAdapter::new(),
    );
    // RetrievalEngine — 매 사용자 query 시점 4-tier 통합 검색 (history + entities + facts + events).
    // AiManager 가 vault `system:ai-router:enabled` 토글 검사 — true 시점만 호출 → 시스템 프롬프트
    // `<MEMORY_CONTEXT>` 영역 prepend. ConsolidationManager 와 동일 토글 통합 제어 (사용자 결정
    // 2026-05-17). 옛 Node 영역 의 자동 prepend path 1:1 복원 + 통합 정공.
    let retrieval_engine = Arc::new(
        firebat_core::managers::ai::retrieval_engine::RetrievalEngine::new()
            .with_conversation(conversation_manager.clone())
            .with_entity(entity_manager.clone())
            .with_episodic(episodic_manager.clone()),
    );

    let ai_manager = Arc::new(
        AiManager::new(llm.clone(), tool_manager.clone(), logger.clone())
            .with_prompt_builder(vault.clone())
            .with_config_port(config_port.clone())
            .with_system_context(module_manager.clone(), mcp_manager.clone())
            .with_history_resolver(conversation_manager.clone())
            .with_cost_manager(cost_manager.clone())
            .with_dynamic_tools(dynamic_tools_registry)
            .with_vault(vault.clone())
            .with_retrieval_engine(retrieval_engine),
    );

    // ConsolidationManager 의 LLM 자동 추출 활성 — AiManager + ConversationManager + Vault 설정된 후.
    // consolidate_conversation 자동 호출 시 AI Assistant 토글 (Vault `system:ai-router:enabled`)
    // 검사 → 비활성 시 skip. 활성 시 AI Assistant model (default `vault_keys::AI_ASSISTANT_DEFAULT_MODEL`,
    // fast/cheap, 메인 채팅 모델 X).
    // cost 저장 — 6시간 cron LLM 호출 전 check_budget → 한도 초과 시 즉시 skip
    // (백그라운드 무한 재시도 / 환각 폭주 차단)
    consolidation_manager.set_ai_hook(
        ai_manager.clone(),
        conversation_manager.clone(),
        vault.clone(),
        Some(cost_manager.clone()),
    );

    // Phase B-17a/c — 정적 도구 dispatch 등록 (27 도구). LLM stub 위에서도 도구 호출 e2e 동작.
    firebat_core::tool_registry::register_core_tools(
        &tool_manager,
        firebat_core::tool_registry::CoreToolHandlers {
            page: page_manager.clone(),
            schedule: schedule_manager.clone(),
            media: media_manager.clone(),
            conversation: conversation_manager.clone(),
            storage: storage.clone(),
            entity: entity_manager.clone(),
            episodic: episodic_manager.clone(),
            consolidation: consolidation_manager.clone(),
            module: module_manager.clone(),
            mcp: mcp_manager.clone(),
            event: event_manager.clone(),
        },
    );

    // Phase B-17a — TaskManager 의 step executor 를 RealTaskExecutor 로 wiring.
    // AiManager (ToolManager 위) → RealTaskExecutor (Sandbox/Mcp/Ai/Page/Tool 위) → TaskManager.
    // 의존성 단방향 트리 (AiManager 가 TaskManager 의존 X — cycle 없음).
    // Capability fallback 저장 — pipeline EXECUTE 실패 시 같은 capability 의 다른 활성 provider
    // 자동 시도 (옛 TS tryFallbackProvider 패턴).
    let task_executor: Arc<dyn TaskExecutor> = Arc::new(
        firebat_core::task_executor_impl::RealTaskExecutor::new(
            sandbox.clone(),
            mcp_manager.clone(),
            ai_manager.clone(),
            page_manager.clone(),
            tool_manager.clone(),
            logger.clone(),
        )
        .with_capability(capability_manager.clone()),
    );
    // ToolManager 설정된 채로 TaskManager 부팅 — validate_pipeline 의 LLM_TRANSFORM 환각 방어 활성.
    // 등록된 정적 도구 27개 + 동적 sysmod_* / mcp_* 자동으로 hint 매칭.
    // StatusManager 저장 — pipeline 실행 가시화 (어드민 ActiveJobsIndicator 자동 표시).
    let task_manager = Arc::new(
        TaskManager::new(task_executor, logger.clone())
            .with_tools(tool_manager.clone())
            .with_status(status_manager.clone()),
    );

    // ScheduleManager 에 hooks 저장 — handle_trigger 의 4 모드 (agent/pipeline/page url/sandbox)
    // + runWhen 평가 + retry loop + notify hook + oneShot 자동 취소 활성.
    // - episodic: cron 발화 사실 자동 리콜 누적 (AI 미개입)
    // - status: cron job 가시화 (어드민 UI ActiveJobsIndicator 표시)
    let schedule_manager_with_hooks = Arc::new(
        ScheduleManager::new(cron_adapter.clone()).with_hooks(
            firebat_core::managers::schedule::ScheduleHooks {
                task: task_manager.clone(),
                ai: ai_manager.clone(),
                sandbox: sandbox.clone(),
                tools: tool_manager.clone(),
                log: logger.clone(),
                episodic: episodic_manager.clone(),
                status: status_manager.clone(),
                event: event_manager.clone(),
            },
        ),
    );

    // cron 발화 콜백 등록 — 매 trigger 시 schedule_manager.handle_trigger 호출.
    let schedule_arc = schedule_manager_with_hooks.clone();
    let trigger_callback: firebat_core::ports::CronTriggerCallback = std::sync::Arc::new(move |info| {
        let mgr = schedule_arc.clone();
        Box::pin(async move { mgr.handle_trigger(info).await })
    });
    schedule_manager_with_hooks.on_trigger(trigger_callback);

    // 부팅 시 영속 잡 복원 (cron / once 만 — delay 잡은 시각 부재로 복원 불가)
    schedule_manager_with_hooks.restore().await;

    // schedule_manager 변수 alias — 이후 wiring 동일 이름으로 사용
    let schedule_manager = schedule_manager_with_hooks;

    // service impls
    let template_service = grpc::template::TemplateServiceImpl::new(template_manager);
    let secret_service = grpc::secret::SecretServiceImpl::new(secret_manager.clone());
    let auth_service = grpc::auth::AuthServiceImpl::new(auth_manager.clone());
    let event_service = grpc::event::EventServiceImpl::new(event_manager);
    let capability_service = grpc::capability::CapabilityServiceImpl::new(capability_manager);
    let status_service = grpc::status::StatusServiceImpl::new(status_manager);
    let tool_service = grpc::tool::ToolServiceImpl::new(tool_manager.clone());
    let cost_service = grpc::cost::CostServiceImpl::new(cost_manager);
    let project_service = grpc::project::ProjectServiceImpl::new(project_manager);
    let module_service = grpc::module::ModuleServiceImpl::new(module_manager.clone());
    let page_service = grpc::page::PageServiceImpl::new(page_manager.clone());
    // ConversationService — IDatabasePort 설정하여 create_share / get_share / cleanup_expired_shares 활성.
    // .clone() — internal 30d cleanup cron (Server::builder 직전) 도 같은 manager 참조.
    let conversation_service =
        grpc::conversation::ConversationServiceImpl::new(conversation_manager.clone())
            .with_db(db.clone());
    let mcp_service = grpc::mcp::McpServiceImpl::new(mcp_manager.clone());
    let entity_service = grpc::entity::EntityServiceImpl::new(entity_manager.clone());
    let episodic_service = grpc::episodic::EpisodicServiceImpl::new(episodic_manager.clone());
    let consolidation_service =
        grpc::consolidation::ConsolidationServiceImpl::new(consolidation_manager);
    // ScheduleService — TaskManager 설정하여 validate_pipeline 정밀 검증 활성
    let schedule_service = grpc::schedule::ScheduleServiceImpl::new(schedule_manager.clone())
        .with_task_manager(task_manager.clone());
    let task_service = grpc::task::TaskServiceImpl::new(task_manager.clone());
    // .clone() — internal 30d cleanup cron 박은 거 같은 manager 참조.
    let media_service = grpc::media::MediaServiceImpl::new(media_manager.clone());
    let ai_service = grpc::ai::AiServiceImpl::new(ai_manager.clone());

    // Phase B-17.5 — cross-cutting services (Storage / Settings / Network / Lifecycle).
    // Phase B-post audit A5 (2026-05-06): INetworkPort 저장 — services 의 reqwest 직접 의존 제거.
    let network_port: Arc<dyn INetworkPort> = Arc::new(ReqwestNetworkAdapter::new());
    let storage_service = grpc::storage::StorageServiceImpl::new(storage.clone());
    let settings_service = grpc::settings::SettingsServiceImpl::new(vault.clone());
    let network_service = grpc::network::NetworkServiceImpl::new(network_port.clone());
    // Phase B-17.5b — Cache / Telegram / Database 추가.
    let cache_dir = workspace_root.join("data").join("cache").join("sysmod-results");
    let cache_adapter = std::sync::Arc::new(
        firebat_core::utils::sysmod_cache::SysmodCacheAdapter::new(cache_dir)
            .map_err(anyhow::Error::msg)
            .context("Cache 디렉토리 초기화 실패")?,
    );
    let cache_service = grpc::cache::CacheServiceImpl::new(cache_adapter);
    // TelegramService — AiManager + ModuleManager 설정하여 process_message webhook → AI → reply 활성
    let telegram_service = grpc::telegram::TelegramServiceImpl::new(vault.clone(), network_port.clone())
        .with_ai_and_module(ai_manager.clone(), module_manager.clone());
    // DatabaseService — raw SELECT escape hatch. 옛 raw rusqlite::Connection 직접 의존
    // (BIBLE Core 순수성 위반) → IDatabasePort port 위임으로 정정 (2026-05-06).
    let database_service = grpc::database::DatabaseServiceImpl::new(db.clone());
    let memory_file_service = grpc::memory_file::MemoryServiceImpl::new(storage.clone());

    let lifecycle_service = grpc::lifecycle::LifecycleServiceImpl::new(vec![
        "AiManager".to_string(),
        "PageManager".to_string(),
        "ProjectManager".to_string(),
        "ModuleManager".to_string(),
        "TaskManager".to_string(),
        "ScheduleManager".to_string(),
        "SecretManager".to_string(),
        "McpManager".to_string(),
        "CapabilityManager".to_string(),
        "AuthManager".to_string(),
        "ConversationManager".to_string(),
        "MediaManager".to_string(),
        "EventManager".to_string(),
        "StatusManager".to_string(),
        "CostManager".to_string(),
        "ToolManager".to_string(),
        "EntityManager".to_string(),
        "EpisodicManager".to_string(),
        "ConsolidationManager".to_string(),
        "TemplateManager".to_string(),
    ]);

    // graceful shutdown — SIGINT (Ctrl+C) + SIGTERM (Docker / systemd 종료) 통합 listen.
    // Phase B-17b: 옛 ctrl_c() 만 listen 시 SIGTERM 무시 → 즉시 강제 종료 → SQLite WAL 손상 위험.
    // tokio::select! 로 둘 중 먼저 도착하는 시그널 처리. Windows 는 SIGTERM 미지원 → ctrl_c 만.
    let shutdown = async {
        let ctrl_c = async {
            let _ = tokio::signal::ctrl_c().await;
            "SIGINT (Ctrl+C)"
        };
        #[cfg(unix)]
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut sig) => {
                    sig.recv().await;
                    "SIGTERM"
                }
                Err(_) => {
                    // SIGTERM handler 등록 실패 시 영원히 pending — ctrl_c 만 작동
                    std::future::pending::<&str>().await
                }
            }
        };
        #[cfg(not(unix))]
        let terminate = std::future::pending::<&str>();

        let signal_name = tokio::select! {
            n = ctrl_c => n,
            n = terminate => n,
        };
        eprintln!(
            "Firebat Core — {} 수신 → graceful shutdown 시작 (활성 요청 완료 대기)",
            signal_name
        );
    };

    // ── 30일 retention internal cron — 6h 마다 휴지통 + 임시 첨부 cascade cleanup ──
    // 사용자 cron 과 별개 (ScheduleManager 의 cron-jobs.json 무관). main binary 의 background task.
    // 첫 tick = 부팅 직후 즉시 발화 → 다음부터 6h interval.
    {
        let conv_mgr = conversation_manager.clone();
        let media_mgr = media_manager.clone();
        tokio::spawn(async move {
            const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
            const INTERVAL_SECS: u64 = 6 * 60 * 60;
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(INTERVAL_SECS));
            loop {
                ticker.tick().await;
                let removed_convs = conv_mgr.cleanup_old_deleted(RETENTION_MS);
                let removed_atts = media_mgr
                    .cleanup_old_attachments(RETENTION_MS)
                    .await
                    .unwrap_or(0);
                if removed_convs > 0 || removed_atts > 0 {
                    tracing::info!(
                        removed_convs,
                        removed_atts,
                        "[30d cleanup] 휴지통 + 임시 첨부 cascade 삭제 완료"
                    );
                }
            }
        });
    }

    // MCP HTTP server (Phase E, 2026-05-12) — firebat-core binary 안 별도 axum endpoint.
    // 2026-05-14 default true 박힘 — 옛 dual-run 의도 (Node mcp/internal-server.ts 와 같이)
    // Phase E 완전 cutover 후 의미 사라짐. 매 운영 unit 마다 env 박는 부담 + 신규 설치 누락
    // silent 발생 (자체 sysmod LLM 노출 안 됨) 해소. FIREBAT_MCP_ENABLED=false 명시 시만 비활성.
    let mcp_enabled = std::env::var("FIREBAT_MCP_ENABLED")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);
    // stdio MCP 모드 — 외부 사용자 (Claude desktop / Cursor / npm run mcp) 진입.
    // argv 에 `--mcp-stdio` 박혀있으면 gRPC server 부팅 X, stdio MCP server 만 실행 후 종료.
    if std::env::args().any(|a| a == "--mcp-stdio") {
        let mcp_state = std::sync::Arc::new(
            firebat_infra::mcp_server::McpServerState::new(vault.clone())
                .with_auth(auth_manager.clone()),
        );
        firebat_infra::mcp_server::register_sysmod_tools(&mcp_state, module_manager.clone()).await;
        firebat_infra::mcp_server::register_render_tools(&mcp_state).await;
        let storage_manager_stdio = Arc::new(firebat_core::managers::storage::StorageManager::new(
            storage.clone(),
        ));
        firebat_infra::mcp_server::register_builtin_tools(
            &mcp_state,
            firebat_infra::mcp_server::BuiltinDeps {
                page: page_manager.clone(),
                storage: storage_manager_stdio,
                module: module_manager.clone(),
                schedule: schedule_manager.clone(),
                task: task_manager.clone(),
                secret: secret_manager.clone(),
                mcp: mcp_manager.clone(),
                entity: entity_manager.clone(),
                episodic: episodic_manager.clone(),
                conversation: conversation_manager.clone(),
                media: media_manager.clone(),
                network: network_port.clone(),
            },
        )
        .await;
        firebat_infra::mcp_server::serve_stdio(mcp_state)
            .await
            .map_err(|e| anyhow::anyhow!(e))?;
        return Ok(());
    }

    if mcp_enabled {
        let mcp_state = std::sync::Arc::new(
            firebat_infra::mcp_server::McpServerState::new(vault.clone())
                .with_auth(auth_manager.clone()),
        );
        // sysmod 자동 등록 — system/modules/*/config.json 스캔 → sysmod_<name>.
        firebat_infra::mcp_server::register_sysmod_tools(&mcp_state, module_manager.clone()).await;
        // render_* 도구 등록 — ToolManager 의 source=render 자동 dispatch.
        firebat_infra::mcp_server::register_render_tools(&mcp_state).await;
        // 30+ builtin 도구 일괄 등록 (page / storage / module / schedule / task / secret /
        // mcp / entity / episodic / conversation / media / network / AI 메타).
        // 옛 mcp/internal-server.ts 의 server.tool 1:1 port.
        let storage_manager = Arc::new(firebat_core::managers::storage::StorageManager::new(
            storage.clone(),
        ));
        firebat_infra::mcp_server::register_builtin_tools(
            &mcp_state,
            firebat_infra::mcp_server::BuiltinDeps {
                page: page_manager.clone(),
                storage: storage_manager,
                module: module_manager.clone(),
                schedule: schedule_manager.clone(),
                task: task_manager.clone(),
                secret: secret_manager.clone(),
                mcp: mcp_manager.clone(),
                entity: entity_manager.clone(),
                episodic: episodic_manager.clone(),
                conversation: conversation_manager.clone(),
                media: media_manager.clone(),
                network: network_port.clone(),
            },
        )
        .await;
        tokio::spawn(async move {
            if let Err(e) = firebat_infra::mcp_server::serve(mcp_state).await {
                tracing::error!("MCP server 종료: {e}");
            }
        });
    }

    // gRPC reflection service — grpcurl / grpcui 등 도구가 schema inspection (dev ergonomics).
    // file_descriptor_set 는 core/build.rs 가 OUT_DIR 에 생성.
    let reflection_service = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(firebat_core::FILE_DESCRIPTOR_SET)
        .build_v1()
        .context("gRPC reflection service 설정 실패")?;

    Server::builder()
        .add_service(reflection_service)
        .add_service(TemplateServiceServer::new(template_service))
        .add_service(SecretServiceServer::new(secret_service))
        .add_service(AuthServiceServer::new(auth_service))
        .add_service(EventServiceServer::new(event_service))
        .add_service(CapabilityServiceServer::new(capability_service))
        .add_service(StatusServiceServer::new(status_service))
        .add_service(ToolServiceServer::new(tool_service))
        .add_service(CostServiceServer::new(cost_service))
        .add_service(ProjectServiceServer::new(project_service))
        .add_service(ModuleServiceServer::new(module_service))
        .add_service(PageServiceServer::new(page_service))
        .add_service(ConversationServiceServer::new(conversation_service))
        .add_service(McpServiceServer::new(mcp_service))
        .add_service(EntityServiceServer::new(entity_service))
        .add_service(EpisodicServiceServer::new(episodic_service))
        .add_service(ConsolidationServiceServer::new(consolidation_service))
        .add_service(ScheduleServiceServer::new(schedule_service))
        .add_service(TaskServiceServer::new(task_service))
        .add_service(MediaServiceServer::new(media_service))
        .add_service(AiServiceServer::new(ai_service))
        .add_service(StorageServiceServer::new(storage_service))
        .add_service(SettingsServiceServer::new(settings_service))
        .add_service(NetworkServiceServer::new(network_service))
        .add_service(LifecycleServiceServer::new(lifecycle_service))
        .add_service(CacheServiceServer::new(cache_service))
        .add_service(TelegramServiceServer::new(telegram_service))
        .add_service(DatabaseServiceServer::new(database_service))
        .add_service(MemoryServiceServer::new(memory_file_service))
        // Phase B-17.5 cross-cutting 8개 모두 설정. 남은 건 Phase D Tauri.
        .serve_with_shutdown(addr, shutdown)
        .await
        .context("gRPC server 종료 중 에러")?;

    eprintln!("Firebat Core — shutdown 완료");
    Ok(())
}

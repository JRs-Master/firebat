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
    embedder_cache::FileEmbedderCacheAdapter,
    image_gen::StubImageGenAdapter,
    image_processor::{ImageRsProcessorAdapter, StubImageProcessorAdapter},
    mcp_client::McpClientFileAdapter, media::LocalMediaAdapter,
    memory::SqliteMemoryAdapter, network::ReqwestNetworkAdapter,
    sandbox::ProcessSandboxAdapter, token_provider::OAuthTokenProvider, storage::LocalStorageAdapter,
    tracing_log::{init_tracing, TracingLogAdapter}, vault::SqliteVaultAdapter,
    ws_api::WsApiAdapter, ws_stream::WsStreamAdapter,
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
        IAuthPort, ICronPort, IDatabasePort, IEmbedderCachePort, IEmbedderPort, IEntityPort,
        IEpisodicPort,
        IImageGenPort, IImageProcessorPort, ILlmPort, ILogPort, IMcpClientPort, IMediaPort,
        IMemoryFacadePort, INetworkPort, ISandboxPort, IStoragePort, IVaultPort,
    },
    proto::{
        ai_service_server::AiServiceServer,
        library_service_server::LibraryServiceServer,
        hub_service_server::HubServiceServer,
        log_service_server::LogServiceServer,
        auth_service_server::AuthServiceServer,
        memory_service_server::MemoryServiceServer,
        skill_service_server::SkillServiceServer,
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
    // workspace root — init_tracing 의 logs.db 경로 결정에 필요해 tracing 전에 선언.
    let workspace_root: PathBuf = std::env::var("FIREBAT_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap());

    // Phase B-17.5c — tracing 초기화 (env RUST_LOG / FIREBAT_LOG_FORMAT=json 토글)
    // 로그 시스템 (2026-05-21) — reload handle (SIGHUP 런타임 filter) + sqlite ring layer
    // (data/logs.db, admin 로그 탭 조회용) fan-out.
    let log_db_path = std::env::var("FIREBAT_LOGS_DB")
        .map(PathBuf::from)
        .unwrap_or_else(|_| workspace_root.join("data").join("logs.db"));
    let log_reload_handle = init_tracing(log_db_path.clone());
    tracing::info!(version = firebat_core::version(), "Firebat Core booting");

    // 옛 commit `3418b4b` 의 HF_ENDPOINT env 자동 default 설정 fix = 잘못된 진단 — hf-hub 0.3
    // 은 env 를 안 읽음 + default endpoint = "https://huggingface.co" 자체에 있음. 사용자 환경
    // 에서 동일 에러 여전히 발생. 진짜 fix = hf-hub 0.4 upgrade + 각 어댑터에서 `with_endpoint`
    // 명시 호출 (e5_local.rs / arctic_local.rs). 본 위치의 env set 폐기.

    // Phase 5 정공 — LLM model registry JSON 로드. 옛 builtin_models() Rust 하드코드 폐기.
    // 파일 미발견 시 stub 폴백 (panic X). FIREBAT_LLM_MODELS_PATH env 으로 위치 override.
    firebat_infra::llm::registry_loader::init_from_file();

    // i18n loader — language/{lang}.json + system/modules/*/lang + system/services/*/lang 자동 scan (UI/error i18n).
    firebat_core::i18n::init(&workspace_root);
    // System prompts (AI instructions) — single-file English, separate from i18n: system/prompts/{name}.md.
    firebat_core::prompt_store::init(&workspace_root.join("system").join("prompts"));

    // 로그 필터 런타임 reload — SIGHUP 시 data/log-filter.txt 읽어서 EnvFilter 재적용.
    // ssh 에서 `echo "info,law-search=debug" > data/log-filter.txt && systemctl kill -s HUP firebat`
    // → 즉시 반영 (재빌드 / 재시작 0). 진단 로그는 코드 곳곳 tracing::debug! 로 이미 들어가 있어서
    // 평소엔 info 두고 진단 시 해당 카테고리만 켜는 흐름. (로그 시스템 1단계, 2026-05-21)
    #[cfg(unix)]
    {
        let wr = workspace_root.clone();
        let handle = log_reload_handle.clone();
        tokio::spawn(async move {
            let mut sighup = match tokio::signal::unix::signal(
                tokio::signal::unix::SignalKind::hangup(),
            ) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(error = %e, "[log] SIGHUP handler registration failed");
                    return;
                }
            };
            loop {
                sighup.recv().await;
                let path = wr.join("data").join("log-filter.txt");
                let filter_str = std::fs::read_to_string(&path)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|_| "info".to_string());
                match firebat_infra::adapters::tracing_log::reload_log_filter(
                    &handle,
                    &filter_str,
                ) {
                    Ok(_) => {
                        tracing::info!(filter = %filter_str, "[log] filter reloaded (SIGHUP)")
                    }
                    Err(e) => tracing::warn!(
                        error = %e,
                        filter = %filter_str,
                        "[log] filter reload failed — keeping current"
                    ),
                }
            }
        });
    }
    let _ = &log_reload_handle; // non-unix 빌드 안 unused 경고 회피

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
    // 옛 FIREBAT_TIMEZONE env 분기 폐기 → vault single source (아래 vault 선언 후 결정).
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

    // i18n default lang — vault `system:ui-lang` setting 을 server 부팅 시점에 단일 lookup.
    // 사용자가 SettingsModal 에서 lang 변경 시점 = settings RPC handler 가 set_default_lang 호출
    // (별도 step) 로 즉시 반영. multi-user 환경 도입 시점 = 매 RPC metadata propagation 별도 sprint.
    let default_lang = firebat_infra::grpc_interceptor::resolve_default_lang(&vault);
    firebat_core::i18n::set_default_lang(&default_lang);
    tracing::info!(default_lang, "i18n: default lang from vault");
    let db: Arc<dyn IDatabasePort> = Arc::new(
        SqliteDatabaseAdapter::new(&app_db_path)
            .map_err(anyhow::Error::msg)
            .context("failed to open app DB")?,
    );
    // Sandbox 어댑터는 status_manager 의존 (heavy 패키지 background install 진행 상태 노출) —
    // event_manager + status_manager wiring 후 생성.
    let mcp_client: Arc<dyn IMcpClientPort> = Arc::new(
        McpClientFileAdapter::new(mcp_servers_path)
            .map_err(anyhow::Error::msg)
            .context("failed to open MCP servers file")?,
    );
    // IEmbedderPort — env `FIREBAT_EMBEDDER` 으로 swap:
    //   - `e5` (운영 default, 2026-05-17 정정): candle + intfloat/multilingual-e5-small
    //          (BertModel 기반, 384-dim, max_length 512, ~470MB safetensors).
    //          MTEB 다국어 56.9 / 한국어 retrieval 충분. Vultr 1vCPU + 1GB RAM 환경 안정.
    //          본인 사용 시나리오 (자료 5개 미만) 정확도 체감 영역 작음.
    //   - `arctic`: candle + Snowflake/snowflake-arctic-embed-l-v2.0
    //          (XLM-RoBERTa-large, 1024-dim, max_length 8192, ~1.1GB safetensors).
    //          MTEB 다국어 65.8 + 한국어 매우 우수 + 긴 자료 단일 chunk 가능.
    //          단 Vultr 1vCPU 환경에서 inference CPU 95% 폭주 + heap 2.5GB swap thrashing.
    //          외부 사이트 운영 (lawassistant 등, 자료 100+, 외부 트래픽) + Vultr 4GB+ vCPU 2+ 환경 권장.
    //   - `stub` (CI / dev): FNV-1a hash 결정론, 의미 검색 X. 모델 다운로드 없이 wiring 검증 + 단위 테스트.
    // 추후 cloud provider (Gemini / OpenAI / Voyage 등) 추가 시 같은 env 패턴.
    let embedder_kind = std::env::var("FIREBAT_EMBEDDER").unwrap_or_else(|_| "e5".to_string());
    let embedder: Arc<dyn IEmbedderPort> = match embedder_kind.as_str() {
        "arctic" => {
            tracing::info!(
                "Embedder: Arctic Embed L v2.0 (1024-dim)"
            );
            Arc::new(ArcticLocalEmbedderAdapter::new())
        }
        "e5" => {
            tracing::info!(
                "Embedder: E5 local (intfloat/multilingual-e5-small, 384-dim)"
            );
            Arc::new(E5LocalEmbedderAdapter::new())
        }
        _ => {
            tracing::info!("Embedder: stub (FNV-1a hash, no semantic search)");
            Arc::new(StubEmbedderAdapter::new())
        }
    };

    // search_components(query) E5 인덱스 캐시 — 컴포넌트 semanticText 임베딩을 data/ 에 영속(첫 호출 빌드).
    let component_cache_port: Arc<dyn IEmbedderCachePort> =
        Arc::new(FileEmbedderCacheAdapter::discover());

    // Phase B-18 Step 1.5 — SqliteMemoryAdapter 에 embedder 주입 →
    // saveEntity / saveFact / saveEvent 자동 임베딩 + searchEntities/Facts/Events cosine 활성.
    let memory_adapter = Arc::new(
        SqliteMemoryAdapter::new(&memory_db_path)
            .map_err(anyhow::Error::msg)
            .context("failed to open memory DB")?
            .with_embedder(embedder.clone()),
    );
    let entity_port: Arc<dyn IEntityPort> = memory_adapter.clone();
    let episodic_port: Arc<dyn IEpisodicPort> = memory_adapter.clone();
    // Timezone single source — vault (SetupWizard 에서 설정한 값) 우선, env fallback, default Asia/Seoul.
    // 2026-05-14: 옛 systemd unit 의 FIREBAT_TIMEZONE env 패턴 폐기 가능 → vault single source.
    // child sysmod 가 process.env.FIREBAT_TZ / TZ 자동 inherit (sandbox spawn 시 부모 env 전달).
    // 변경 시점에 systemctl restart 필요 (env 변경은 부팅 시점에만 적용 — main thread 안전).
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
    //   - `stub` (default — Step 2c 설정될 ConfigDrivenImageGenAdapter 적용되기 전 placeholder)
    //   - Step 2c 설정될 어댑터: ConfigDrivenImageGenAdapter (4 format — openai/gemini/codex CLI)
    // 어댑터 swap 시 매니저 / tool_registry 코드 변경 0건 (인터페이스 동일).
    let processor_kind = std::env::var("FIREBAT_IMAGE_PROCESSOR")
        .unwrap_or_else(|_| "image-rs".to_string());
    let image_processor: Arc<dyn IImageProcessorPort> = match processor_kind.as_str() {
        "stub" => {
            tracing::info!("Image processor: stub (no-op)");
            Arc::new(StubImageProcessorAdapter::new())
        }
        _ => {
            tracing::info!("Image processor: image-rs (variants/blurhash/placeholder)");
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

    // SysmodCacheAdapter — sysmod 응답 안 `_cache` envelope (50행+ 큰 시계열) 자동 저장.
    // sandbox 가 envelope 인식 → cacheKey 가 들어간 응답으로 변환 → AI 가 cache_read / cache_grep /
    // cache_aggregate gRPC 도구 호출. yfinance / 한투 / 키움 / DART 등 큰 응답 토큰 절약.
    let cache_dir = workspace_root.join("data").join("cache").join("sysmod-results");
    let cache_adapter = Arc::new(
        firebat_core::utils::sysmod_cache::SysmodCacheAdapter::new(cache_dir)
            .map_err(anyhow::Error::msg)
            .context("Cache 디렉토리 초기화 실패")?,
    );

    // Sandbox 어댑터 — BasicProcessSandbox 단일 (path containment + timeout 만).
    // 옛 LinuxCgroupsSandbox (cgroup v2 + seccomp + network namespace) 폐기 (2026-05-15) —
    // 단일 사용자 / 단일 운영자 환경에서 격리 가치 0 (사용자 본인 = 운영자 = trust). multi-tenant
    // 시점 = docker / firecracker / gvisor 같은 표준 도구 도입 별도 sprint.
    //
    // status_manager 주입 = config.json packages 의 heavy:true 엔트리 (playwright / pandas-large 등)
    // 자동 background install + frontend ActiveJobsIndicator 진행 상태 노출. 일반 string entry
    // 또는 heavy:false = 옛 동작 (foreground install).
    // cache_adapter 주입 = sysmod 응답 안 `_cache` envelope 자동 인식.
    // OAuthTokenProvider — sandbox 와 WS transport 가 한 인스턴스를 공유 (per-secret 락이
    // 두 경로에 걸쳐 유효해야 토큰 엔드포인트 thundering herd 가 안 생긴다).
    let token_provider = Arc::new(OAuthTokenProvider::new(vault.clone()));
    // 시계열 영구 store — range-coverage 캐시 (config `timeseries` 선언 모듈의 증분 fetch).
    // 실패 시 None = 옛 동작 (부팅 블로킹 금지).
    let timeseries_store: Option<Arc<dyn firebat_core::ports::ITimeseriesStorePort>> =
        match firebat_infra::adapters::timeseries::TimeseriesStoreAdapter::new(
            workspace_root.join("data/timeseries.db"),
        ) {
            Ok(a) => Some(Arc::new(a)),
            Err(e) => {
                tracing::warn!(error = %e, "timeseries store init failed — ephemeral cache only");
                None
            }
        };
    let sandbox: Arc<dyn ISandboxPort> = Arc::new({
        let mut adapter = ProcessSandboxAdapter::new(workspace_root.clone())
            .with_vault(vault.clone())
            .with_token_provider(token_provider.clone())
            .with_status(status_manager.clone())
            .with_cache(cache_adapter.clone());
        if let Some(store) = &timeseries_store {
            adapter = adapter.with_timeseries(store.clone());
        }
        adapter
    });
    // WS API transport — config.json `ws` 선언 액션(조건검색 등 WebSocket-only)의 공통 인프라.
    // 토큰·auto-cache 를 sandbox 경로와 공유 (선언형 config = 모듈별 WS 코드 0).
    let ws_api: Arc<dyn firebat_core::ports::IWsApiPort> = Arc::new(
        WsApiAdapter::new(workspace_root.clone())
            .with_token_provider(token_provider.clone())
            .with_cache(cache_adapter.clone()),
    );
    // WS stream transport — persistent realtime subscriptions (config `ws.streams`).
    // Sink(event bus + notify)는 module_manager 생성 뒤 배선 (아래).
    let ws_stream_adapter = Arc::new(
        WsStreamAdapter::new(workspace_root.clone()).with_token_provider(token_provider.clone()),
    );

    let tool_manager = Arc::new(ToolManager::new());
    let cost_manager = Arc::new(CostManager::new(db.clone(), vault.clone()));
    let project_manager = Arc::new(ProjectManager::new(
        storage.clone(),
        db.clone(),
        vault.clone(),
    ));
    let module_manager = Arc::new(
        ModuleManager::new(sandbox.clone(), storage.clone(), vault.clone())
            .with_ws_api(ws_api.clone())
            .with_ws_stream(ws_stream_adapter.clone()),
    );
    // Stream sink — realtime frames → event bus(SSE /api/events) + per-watch notify.
    // (adapter 생성 뒤에 배선하는 이유 = closure 가 module_manager 를 잡아야 notify 라우팅 가능.)
    {
        let event_manager = event_manager.clone();
        let mm = module_manager.clone();
        ws_stream_adapter.set_sink(std::sync::Arc::new(move |spec, frame| {
            event_manager.emit(firebat_core::managers::event::FirebatEvent {
                event_type: spec.topic.clone(),
                data: frame.clone(),
            });
            if let Some(meta) = mm.stream_watch_meta(&spec.watch_id) {
                if meta.notify.as_deref() == Some("telegram") {
                    let mm = mm.clone();
                    let label = meta
                        .label
                        .clone()
                        .unwrap_or_else(|| format!("{}/{}", meta.module, meta.stream));
                    let compact: String = frame.to_string().chars().take(600).collect();
                    tokio::spawn(async move {
                        let text = format!("[Firebat 감시] {label}\n{compact}");
                        if let Err(e) = mm
                            .run(
                                "telegram",
                                &serde_json::json!({"action": "send-message", "text": text}),
                            )
                            .await
                        {
                            tracing::warn!(target: "ws_stream", error = %e, "watch telegram notify failed");
                        }
                    });
                }
            }
        }));
        let restored = module_manager.restore_streams().await;
        if restored > 0 {
            tracing::info!(target: "ws_stream", count = restored, "persisted watches restored");
        }
    }
    let page_manager = Arc::new(PageManager::new(db.clone(), storage.clone()));
    // Phase B-18 Step 1.5 — ConversationManager 에 embedder + log 주입 →
    // save() 시 메시지 단위 임베딩 자동 sync + search_history cosine 검색 활성.
    let conversation_manager = Arc::new(
        ConversationManager::new(db.clone())
            .with_embedder(embedder.clone())
            .with_log(Arc::new(firebat_core::utils::category_logger::CategoryLogger::new(
                logger.clone(),
                "conversation",
            ))),
    );
    let mcp_manager = Arc::new(McpManager::new(mcp_client));
    let entity_manager = Arc::new(EntityManager::new(entity_port));
    let episodic_manager = Arc::new(EpisodicManager::new(episodic_port));
    // Recall facade — ConsolidationManager 가 EntityManager + EpisodicManager 를 직접
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
    let media_manager = Arc::new(
        MediaManager::new(media.clone())
            .with_image_gen(image_gen.clone())
            .with_processor(image_processor.clone())
            .with_vault(vault.clone())
            .with_log(Arc::new(firebat_core::utils::category_logger::CategoryLogger::new(
                logger.clone(),
                "media",
            )))
            .with_cost(cost_manager.clone())
            .with_status(status_manager.clone())
            .with_event(event_manager.clone()),
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
    // Library — Phase 1 (2026-05-17). NotebookLM 같은 RAG. memory.db 자연 활용 (schema 가 이미 정의됨).
    // 매 Reference / Source / Chunk CRUD + Arctic 임베딩 + cosine 검색.
    let library_port: Arc<dyn firebat_core::ports::ILibraryPort> = Arc::new(
        firebat_infra::adapters::library::SqliteLibraryAdapter::new(&memory_db_path)
            .map_err(anyhow::Error::msg)
            .context("Library DB open 실패")?,
    );
    let library_manager = Arc::new(
        firebat_core::managers::library::LibraryManager::new(library_port, embedder.clone()),
    );

    // Hub — Phase 1 (2026-05-17). system service hub. 외부 워드프레스 사이트 영역 연결용.
    // memory.db 통합 (schema = SqliteMemoryAdapter::initialize 안에 정의되어 있음).
    let hub_port: Arc<dyn firebat_core::ports::IHubPort> = Arc::new(
        firebat_infra::adapters::hub::SqliteHubAdapter::new(&memory_db_path)
            .map_err(anyhow::Error::msg)
            .context("Hub DB open 실패")?,
    );
    // 대화 영속 = ConversationManager 단일 매니저(admin·hub 동일 로직, owner-keyed). HubManager 는
    // 인스턴스(위젯) + send 오케스트레이션만 담당.
    let hub_manager = Arc::new(
        firebat_core::managers::hub::HubManager::new(hub_port)
            .with_page(page_manager.clone())
            .with_conversation(conversation_manager.clone()),
    );

    // RetrievalEngine — 매 사용자 query 시점 5-tier 통합 검색 (history + entities + facts + events + library).
    // AiManager 가 vault `system:ai-router:enabled` 토글 검사 — true 시점만 호출 → 시스템 프롬프트
    // `<RETRIEVED_CONTEXT>` 영역 prepend. ConsolidationManager 와 동일 토글 통합 제어 (사용자 결정
    // 2026-05-17). 옛 Node 영역 의 자동 prepend path 1:1 복원 + 통합 정공.
    let mut retrieval_engine_b =
        firebat_core::managers::ai::retrieval_engine::RetrievalEngine::new()
            .with_conversation(conversation_manager.clone())
            .with_entity(entity_manager.clone())
            .with_episodic(episodic_manager.clone())
            .with_library(library_manager.clone());
    // 섀도우 임베딩 A/B (2026-07, 7/20 무료) — vault 에 Upstage 키 + 토글 `system:embed-shadow` 활성 시만.
    // 운영 임베딩(E5)엔 영향 0, history 회상 결과를 Upstage 로 병렬 재임베딩해 순위·점수 비교 로그.
    {
        let key = vault.get_secret("system:upstage:api-key").unwrap_or_default();
        let on = vault
            .get_secret("system:embed-shadow")
            .map(|v| matches!(v.trim(), "1" | "true" | "on" | "yes"))
            .unwrap_or(false);
        if on && !key.trim().is_empty() {
            retrieval_engine_b = retrieval_engine_b.with_shadow(Arc::new(
                firebat_infra::adapters::embedder::UpstageEmbedderAdapter::new(key),
            ));
            tracing::info!(target: "embed_shadow", "Upstage shadow embedding A/B enabled (history recall compare)");
        }
    }
    let retrieval_engine = Arc::new(retrieval_engine_b);

    // ToolDispatcher — approval gate (check_needs_approval + pre_validate_pending_args) 활성.
    // 옛에 wiring 누락 상태로 있어 save_page 수정 시 승인 UI 안 나오던 fix (사용자 보고 2026-05-19).
    // page / schedule / mcp 가 연결되어 있어 destructive 도구 (save_page 덮어쓰기 / delete_page /
    // delete_file / schedule_task / cancel_cron_job) 호출 시 pending action 생성.
    let tool_dispatcher = Arc::new(
        firebat_core::managers::ai::tool_dispatcher::ToolDispatcher::new(storage.clone())
            .with_page(page_manager.clone())
            .with_schedule(schedule_manager.clone())
            .with_mcp(mcp_manager.clone()),
    );

    // MemoryFileManager — data/memory 파일 운영 메모리. 어드민 탭 gRPC + memory_* AI 도구 +
    // AiManager 인덱스 주입이 같은 인스턴스 공유.
    let memory_file_manager = Arc::new(
        firebat_core::managers::memory_file::MemoryFileManager::new(storage.clone()),
    );

    // SkillFileManager — */skills 케이스 매뉴얼. skill_* AI 도구 + (추후) 어드민 탭 gRPC +
    // AiManager 인덱스 주입이 같은 인스턴스 공유. system∪user 병합, hub owner-scope.
    let skill_file_manager = Arc::new(
        firebat_core::managers::skill_file::SkillFileManager::new(storage.clone()),
    );

    // #search-tool 카탈로그 임베더 — assistant 탭 설정(`system:embed:catalog-provider`)이 소스.
    // "solar" + Upstage 키 존재 = primary Upstage solar-embedding-2 + secondary E5 (dual-embed:
    // 엔트리를 양쪽 공간에 임베딩해 두고, primary 장애 시 로컬 세트로 통째 폴백 — 공간 혼합 0).
    // 그 외 = E5 단독 (기존 동작). 저장 벡터(히스토리·라이브러리·메모리)는 항상 E5 — 별개 공간.
    let action_catalog = {
        let provider = vault
            .get_secret(firebat_core::vault_keys::VK_SYSTEM_EMBED_CATALOG_PROVIDER)
            .unwrap_or_default();
        let upstage_key = vault.get_secret("system:upstage:api-key").unwrap_or_default();
        let use_solar = provider == "solar" && !upstage_key.trim().is_empty();
        let cat = if use_solar {
            tracing::info!(
                target: "semantic_catalog",
                "module-action catalog embedder = upstage solar-embedding-2 (secondary = local E5 fallback)"
            );
            firebat_core::managers::ai::action_catalog::ModuleActionCatalog::new(
                module_manager.clone(),
                Arc::new(firebat_infra::adapters::embedder::UpstageEmbedderAdapter::new(
                    upstage_key,
                )),
                component_cache_port.clone(),
            )
            .with_secondary(embedder.clone())
        } else {
            firebat_core::managers::ai::action_catalog::ModuleActionCatalog::new(
                module_manager.clone(),
                embedder.clone(),
                component_cache_port.clone(),
            )
        };
        Arc::new(cat)
    };
    // Boot warm-up — API 임베더의 첫 전체 빌드(~600 entry)가 첫 검색을 막지 않게 백그라운드 선빌드.
    // 해시 디스크 캐시(슬롯별) 덕에 이후 재빌드는 변경분만 임베딩.
    {
        let cat = action_catalog.clone();
        tokio::spawn(async move { cat.warm().await });
    }

    let ai_manager = Arc::new(
        AiManager::new(
            llm.clone(),
            tool_manager.clone(),
            Arc::new(firebat_core::utils::category_logger::CategoryLogger::new(
                logger.clone(),
                "ai",
            )),
        )
            .with_prompt_builder(vault.clone())
            .with_memory_file(memory_file_manager.clone())
            .with_skill_file(skill_file_manager.clone())
            .with_config_port(config_port.clone())
            .with_system_context(module_manager.clone(), mcp_manager.clone())
            .with_history_resolver(conversation_manager.clone())
            // CLI session resume — AiManager must hold the ConversationManager to read/persist the per-conv
            // cli_session_id (get_cli_session / set_cli_session). Without this the resume + persist gates both
            // skip silently → --resume never fires (0/N sessions stored) → multi-turn continuity breaks for CLI.
            .with_conversation_manager(conversation_manager.clone())
            .with_cost_manager(cost_manager.clone())
            .with_dynamic_tools(dynamic_tools_registry.clone())
            .with_vault(vault.clone())
            .with_media(media.clone())
            .with_tool_dispatcher(tool_dispatcher.clone())
            .with_retrieval_engine(retrieval_engine)
            // fence `dataCacheKey` → 서버측 캐시 records 주입 (모델 손 복사 truncation·날조 차단)
            .with_sysmod_cache(cache_adapter.clone())
            // search_components(query) 도구 등록 — 옛 production 배선 누락(테스트만 호출)이라
            // CLI(MCP)·FC 모델 둘 다 컴포넌트 propsSchema 검색 불가였음. ToolManager 등록 →
            // register_builtin_tools auto-sync 가 MCP(hosted) 에도 자동 노출(source="core").
            .register_search_components_tool(embedder.clone(), component_cache_port.clone())
            // #search-tool S2 — 모듈 액션 카탈로그(search_module_actions / get_action_schema).
            // config `actionCatalog` 선언 모듈(한투 275·키움 200+)의 액션 레벨 progressive disclosure.
            // 임베더 = 설정 게이트 action_catalog_embedder(아래) — solar 선택 시 dual-embed 폴백.
            .register_action_catalog_tools(action_catalog.clone())
            // #search-tool 확장 — skills/templates/pages/media 시맨틱 카탈로그.
            // search_skills·search_media 는 core substring 판 오버라이드(신규 = templates/pages).
            .register_discovery_search_tools(
                skill_file_manager.clone(),
                template_manager.clone(),
                page_manager.clone(),
                media_manager.clone(),
                embedder.clone(),
                component_cache_port.clone(),
            ),
    );

    // spawn_subagent — post-Arc registration (the handler re-enters AiManager via a Weak self
    // reference, so a builder step can't register it — no Arc yet). Must run BEFORE
    // register_builtin_tools so the MCP auto-sync picks it up (registration order is a
    // contract — 2026-07-11 search_skills shadowing lesson). Exposure is gated at runtime
    // (vault toggle + sub-agent/hub context), not here.
    ai_manager.register_spawn_subagent_tool();

    // ConsolidationManager 의 LLM 자동 추출 활성 — AiManager + ConversationManager + Vault 설정된 후.
    // consolidate_conversation 자동 호출 시 AI Assistant 토글 (Vault `system:ai-router:enabled`)
    // 검사 → 비활성 시 skip. 활성 시 AI Assistant model (default `vault_keys::AI_ASSISTANT_DEFAULT_MODEL`,
    // fast/cheap, 메인 채팅 모델 X).
    // cost 저장 — 6시간 cron LLM 호출 전 check_budget → 한도 초과 시 즉시 skip
    // (백그라운드 무한 재시도 / 환각 폭주 차단)
    // LlmService — leaf 도메인 서비스(ILlmPort 위 plain ask_text). 오케스트레이터(Consolidation 추출 /
    // Task 파이프라인 LlmTransform)가 AiManager(오케스트레이터) 대신 이 leaf 를 의존 → orchestrator→
    // orchestrator 결합 제거 (Hexagonal+DDD+Mediator decomposition, 2026-06-26).
    let llm_service = Arc::new(firebat_core::managers::llm_service::LlmService::new(llm.clone()));

    consolidation_manager.set_ai_hook(
        llm_service.clone(),
        conversation_manager.clone(),
        vault.clone(),
        Some(cost_manager.clone()),
    );

    // 메모리 자동 추출의 Memory(운영 교훈) 저장 대상 연결 — ConsolidationManager.save_extracted 가
    // lessons 를 data/memory 로 저장. consolidate_conversation(6h cron 백스톱)이 이 경로로 implicit
    // 교훈을 보강(주 경로는 메인 모델 inline memory_save). set_ai_hook 뒤 늦게 바인딩.
    consolidation_manager.set_memory_file(memory_file_manager.clone());

    // 정적 도구 dispatch 등록은 task_manager 생성 뒤로 이동 (run_task = TaskManager 의존).
    // tool_manager 는 dispatch 시점(부팅 후)에만 읽히므로 등록을 미뤄도 안전.

    // Phase B-17a — TaskManager 의 step executor 를 RealTaskExecutor 로 wiring.
    // AiManager (ToolManager 위) → RealTaskExecutor (Sandbox/Mcp/Ai/Page/Tool 위) → TaskManager.
    // 의존성 단방향 트리 (AiManager 가 TaskManager 의존 X — cycle 없음).
    // Capability fallback 저장 — pipeline EXECUTE 실패 시 같은 capability 의 다른 활성 provider
    // 자동 시도 (옛 TS tryFallbackProvider 패턴).
    let task_executor: Arc<dyn TaskExecutor> = Arc::new(
        firebat_core::task_executor_impl::RealTaskExecutor::new(
            sandbox.clone(),
            mcp_manager.clone(),
            llm_service.clone(),
            page_manager.clone(),
            tool_manager.clone(),
            logger.clone(),
        )
        .with_capability(capability_manager.clone())
        // 무인(파이프라인) 정책 게이트 — EXECUTE 가 sandbox 직행이라 FC/MCP 디스패치 계층의
        // 비활성·requiresApproval 게이트를 우회하던 것을 executor 에서 동일 강제.
        .with_module_manager(module_manager.clone()),
    );
    // ToolManager 설정된 채로 TaskManager 부팅 — validate_pipeline 의 LLM_TRANSFORM 환각 방어 활성.
    // 등록된 정적 도구 27개 + 동적 sysmod_* / mcp_* 자동으로 hint 매칭.
    // StatusManager 저장 — pipeline 실행 가시화 (어드민 ActiveJobsIndicator 자동 표시).
    let task_manager = Arc::new(
        TaskManager::new(
            task_executor,
            Arc::new(firebat_core::utils::category_logger::CategoryLogger::new(
                logger.clone(),
                "task",
            )),
        )
            .with_tools(tool_manager.clone())
            .with_status(status_manager.clone()),
    );

    // INetworkPort — network_request 도구가 의존. 어댑터는 무의존이라 register_core_tools 앞에서 생성
    // (아래 network_service / BuiltinDeps 도 이 인스턴스 공유).
    let network_port: Arc<dyn INetworkPort> = Arc::new(ReqwestNetworkAdapter::new());

    // ITtsPort — tts 도구 + MediaService 보이스 샘플 미리듣기 공유 인스턴스.
    let tts_adapter: Arc<dyn firebat_core::ports::ITtsPort> =
        Arc::new(firebat_infra::tts::TtsAdapter::new(vault.clone()));

    // Phase B-17a/c — 정적 도구 dispatch 등록. LLM stub 위에서도 도구 호출 e2e 동작.
    // task_manager 생성 뒤 — run_task(파이프라인)·search_library 가 각각 TaskManager·LibraryManager 의존.
    // schedule_manager 는 여기서 아직 pre-hooks 버전이나, schedule/list/cancel 는 hooks 무관이라 안전
    // (트리거 콜백은 shared cron_adapter 에 등록되므로 어느 인스턴스로 schedule 해도 발화).
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
            cache: cache_adapter.clone(),
            task: task_manager.clone(),
            library: library_manager.clone(),
            secret: secret_manager.clone(),
            network: network_port.clone(),
            template: template_manager.clone(),
            vault: vault.clone(),
            memory_file: memory_file_manager.clone(),
            skill_file: skill_file_manager.clone(),
            tts: tts_adapter.clone(),
        },
    );

    // ScheduleManager 에 hooks 저장 — handle_trigger 의 4 모드 (agent/pipeline/page url/sandbox)
    // + runWhen 평가 + retry loop + notify hook + oneShot 자동 취소 활성.
    // - episodic: cron 발화 사실 자동 리콜 누적 (AI 미개입)
    // - status: cron job 가시화 (어드민 UI ActiveJobsIndicator 표시)
    let schedule_manager_with_hooks = Arc::new(
        ScheduleManager::new(cron_adapter.clone()).with_hooks(
            firebat_core::managers::schedule::ScheduleHooks {
                sandbox: sandbox.clone(),
                tools: tool_manager.clone(),
                log: Arc::new(firebat_core::utils::category_logger::CategoryLogger::new(
                    logger.clone(),
                    "cron",
                )),
                status: status_manager.clone(),
                event: event_manager.clone(),
            },
        ),
    );

    // cron 발화 콜백 등록 — 매 trigger 시 schedule_manager.handle_trigger 호출.
    // + 실행 결과를 캘린더(sysmod_calendar)에 영속 기록 — cron 로그 버퍼(휘발/clear)·cron 잡 삭제와
    //   무관하게 남는 실행 이력. 캘린더에서 개별 삭제 가능. best-effort(실패해도 cron 결과 영향 0).
    // Core Mediator — cron 콜백이 agent(Ai)/pipeline(Task) 를 Core 경유로 실행 → ScheduleManager 가
    // Ai/Task(오케스트레이터)를 직접 안 부름 (Hexagonal+DDD+Mediator, #1a Schedule→Ai/Task 해소).
    let core = std::sync::Arc::new(firebat_core::core_facade::Core::new(
        ai_manager.clone(),
        task_manager.clone(),
        schedule_manager_with_hooks.clone(),
    ));
    let core_cb = core.clone();

    let schedule_arc = schedule_manager_with_hooks.clone();
    let cal_modmgr = module_manager.clone();
    // 시스템 스케줄 내장 실행 + 캘린더 gating 용 clone.
    let vault_cb = vault.clone();
    let consolidation_cb = consolidation_manager.clone();
    let conv_cb = conversation_manager.clone();
    let media_cb = media_manager.clone();
    let hub_cb = hub_manager.clone();
    let cost_cb = cost_manager.clone();
    let auth_cb = auth_manager.clone();
    let trigger_callback: firebat_core::ports::CronTriggerCallback = std::sync::Arc::new(move |info| {
        let mgr = schedule_arc.clone();
        let core_b = core_cb.clone();
        let modmgr = cal_modmgr.clone();
        let vault_b = vault_cb.clone();
        let consolidation_b = consolidation_cb.clone();
        let conv_b = conv_cb.clone();
        let media_b = media_cb.clone();
        let hub_b = hub_cb.clone();
        let cost_b = cost_cb.clone();
        let auth_b = auth_cb.clone();
        Box::pin(async move {
            // handle_trigger 가 info 를 소비하므로 기록 메타를 먼저 추출.
            let builtin = info.builtin_kind.clone();
            let show_cal = info.show_in_calendar == Some(true);
            let title = info
                .title
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| info.job_id.clone());
            let job_id = info.job_id.clone();
            let target_path = info.target_path.clone();
            let trigger = info.trigger.clone();

            // 시스템 스케줄(내장 작업) — handle_trigger 우회 + 캘린더 제외.
            if let Some(kind) = builtin {
                let start = std::time::Instant::now();
                let (success, error): (bool, Option<String>) = match kind.as_str() {
                    "consolidation" => {
                        // AI assistant 토글 OFF 면 inert(=UI 회색). ON 이면 비활성 대화에서 회상·교훈 추출.
                        let on = vault_b
                            .get_secret(firebat_core::vault_keys::VK_SYSTEM_AI_ROUTER_ENABLED)
                            .map(|v| v == "true" || v == "1")
                            .unwrap_or(false);
                        if on {
                            let _ = consolidation_b
                                .consolidate_inactive_conversations(None, None, None)
                                .await;
                        }
                        (true, None)
                    }
                    "retention" => {
                        // Settings gate — assistant tab "휴지통 정리" toggle. Default ON
                        // (`v != "false"` — retention is the safe default; NOTE this is the
                        // OPPOSITE polarity of the consolidation gate's unwrap_or(false)).
                        // The system job stays registered (undeletable) — OFF = runtime no-op,
                        // and lastrun still stamps below so re-enabling doesn't storm catch-up.
                        let retention_on = vault_b
                            .get_secret(firebat_core::vault_keys::VK_SYSTEM_RETENTION_ENABLED)
                            .map(|v| v != "false")
                            .unwrap_or(true);
                        if !retention_on {
                            tracing::info!(target: "cron", "retention: skipped (disabled in settings)");
                            (true, None)
                        } else {
                        const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
                        conv_b.cleanup_old_deleted(RETENTION_MS);
                        let _ = media_b.cleanup_old_attachments(RETENTION_MS).await;
                        let _ = hub_b.cleanup_old_deleted_conversations(RETENTION_MS).await;
                        // Auth hygiene — expired session rows only vanish via list_sessions'
                        // lazy sweep, and nothing called it periodically (rows accumulated;
                        // validation was safe — expiry is enforced at read).
                        let _ = auth_b.sweep_expired_sessions();
                        // Cost rows — llm_costs was INSERT-only (the lone unbounded table).
                        // 12-month retention keeps a year of stats for the cost tab.
                        let pruned = cost_b.prune_older_than(365);
                        if pruned > 0 {
                            tracing::info!(target: "cron", rows = pruned, "retention: old llm_costs rows pruned");
                        }
                        // Recall sweep — TTL-expired facts/events + stale staging (autonomous
                        // observations never re-observed within 30d = natural forgetting).
                        // cleanup_all_expired existed but had ZERO callers — ttl_days expiry
                        // never actually ran until wired here.
                        match consolidation_b.cleanup_all_expired() {
                            Ok((f, e)) if f + e > 0 => tracing::info!(
                                target: "consolidation",
                                facts = f,
                                events = e,
                                "retention: expired/stale-staging recall rows removed"
                            ),
                            Ok(_) => {}
                            Err(e) => tracing::warn!(target: "consolidation", error = %e, "retention recall sweep failed"),
                        }
                        (true, None)
                        }
                    }
                    other => (false, Some(format!("unknown system schedule kind: {other}"))),
                };
                // 마지막 실행 시각 기록 — 부팅 시 overdue 캐치업 판단용.
                let _ = vault_b.set_secret(
                    &format!("system:cron:lastrun:{kind}"),
                    &chrono::Utc::now().timestamp_millis().to_string(),
                );
                // 캘린더 표시 체크 시 시스템 잡도 실행기록을 캘린더에 남긴다(사용자 cron 과 동일).
                if show_cal {
                    let cal_input = serde_json::json!({
                        "action": "add",
                        "title": title,
                        "startAt": chrono::Utc::now().to_rfc3339(),
                        "tags": ["실행기록", if success { "완료" } else { "실패" }],
                        "linkedJobId": job_id,
                        "description": serde_json::Value::String(error.clone().unwrap_or_default()),
                    });
                    let _ = modmgr.run("calendar", &cal_input).await;
                }
                return firebat_core::ports::CronJobResult {
                    job_id,
                    target_path,
                    trigger,
                    success,
                    duration_ms: start.elapsed().as_millis() as i64,
                    error,
                    output: None,
                    steps_executed: None,
                    steps_total: None,
                };
            }

            let result = mgr.handle_trigger(info, &core_b).await;
            // 캘린더 기록 — 사용자가 "캘린더에 표시" 체크한 잡만 (시스템·미체크 잡 제외).
            // 진단: show_cal 값 + add 결과를 남긴다(옛 silent `let _` 라 실패/미실행이 안 보였음).
            if show_cal {
                // description 은 항상 string — calendar add 스키마가 string 요구(null 거부 → 성공 잡이 기록 안 됨).
                let desc = serde_json::Value::String(
                    if result.success { String::new() } else { result.error.clone().unwrap_or_default() },
                );
                let cal_input = serde_json::json!({
                    "action": "add",
                    "title": title,
                    "startAt": chrono::Utc::now().to_rfc3339(),
                    "tags": ["실행기록", if result.success { "완료" } else { "실패" }],
                    "linkedJobId": job_id,
                    "description": desc,
                });
                // sysmod_calendar add — admin scope(_hubScope 없음). hub cron 별도 scope 는 추후.
                match modmgr.run("calendar", &cal_input).await {
                    Ok(_) => tracing::info!(target: "cron", job = %job_id, "[cron-cal] run record added to calendar"),
                    Err(e) => tracing::warn!(target: "cron", job = %job_id, error = %e, "[cron-cal] calendar add failed"),
                }
            } else {
                tracing::info!(target: "cron", job = %job_id, "[cron-cal] show_cal=false — calendar record skipped");
            }
            result
        })
    });
    schedule_manager_with_hooks.on_trigger(trigger_callback);

    // 부팅 시 영속 잡 복원 (cron / once 만 — delay 잡은 시각 부재로 복원 불가)
    schedule_manager_with_hooks.restore().await;

    // ── 시스템 스케줄 보장 — 인프라 관리 내장 작업(consolidation/retention) 멱등 등록 + overdue 캐치업 ──
    // 고정 cron(6h: 00·06·12·18시, retention 은 :30 오프셋). 이미 있으면 건너뜀(사용자 주기 편집 보존).
    // 삭제 불가(ScheduleManager.cancel 가드). consolidation 은 AI 토글 OFF 면 발화해도 inert(UI 회색).
    {
        let sched = schedule_manager_with_hooks.clone();
        let vault_sj = vault.clone();
        let existing: std::collections::HashSet<String> =
            sched.list().into_iter().map(|j| j.job_id).collect();
        // (job_id, cron, builtin_kind, title)
        let sys_jobs = [
            ("__sys_consolidation", "0 0 */6 * * *", "consolidation", "Intelligence 통합 (회상·교훈 추출)"),
            ("__sys_retention", "0 30 */6 * * *", "retention", "30일 정리 (휴지통·임시파일)"),
        ];
        let mut overdue_jids: Vec<String> = Vec::new();
        for (jid, cron, kind, title) in sys_jobs {
            if !existing.contains(jid) {
                let opts = firebat_core::ports::CronScheduleOptions {
                    cron_time: Some(cron.to_string()),
                    title: Some(title.to_string()),
                    system: Some(true),
                    builtin_kind: Some(kind.to_string()),
                    ..Default::default()
                };
                match sched.schedule(jid, &format!("builtin:{kind}"), opts).await {
                    Ok(_) => tracing::info!(job = jid, "[system-cron] system schedule registered"),
                    Err(e) => tracing::warn!(job = jid, error = %e, "[system-cron] registration failed"),
                }
            }
            // overdue 캐치업 대상 수집 — 과거에 실행된 적이 있고(lastrun 존재) 그게 6h 초과 = 진짜 놓친
            // 실행이므로 1회 보충. 기록이 없으면(첫 배포/한 번도 안 돎) 놓친 게 없으니 캐치업 안 함 —
            // 다음 정기 발화가 첫 실행이 된다(첫 부팅 불필요 실행·부하 방지).
            if let Some(last) = vault_sj
                .get_secret(&format!("system:cron:lastrun:{kind}"))
                .and_then(|v| v.parse::<i64>().ok())
            {
                if chrono::Utc::now().timestamp_millis() - last >= 6 * 60 * 60 * 1000 {
                    overdue_jids.push(jid.to_string());
                }
            }
        }
        // overdue 캐치업은 백그라운드로 분리 — trigger_now 가 콜백(consolidation→claude --print 등)을
        // inline await 하므로 startup(serve 전)에서 돌리면 gRPC listening 까지 블록돼 서버 기동이 수 분
        // 지연된다. 등록(schedule)은 빠르니 동기 유지, 무거운 실행만 spawn 으로 떼어 서버부터 띄운다.
        if !overdue_jids.is_empty() {
            let sched_bg = schedule_manager_with_hooks.clone();
            tokio::spawn(async move {
                for jid in overdue_jids {
                    if let Err(e) = sched_bg.trigger_now(&jid).await {
                        tracing::warn!(job = %jid, error = %e, "[system-cron] overdue catch-up failed");
                    }
                }
            });
        }
    }

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
    let module_service = grpc::module::ModuleServiceImpl::new(module_manager.clone())
        .with_dynamic_tools(dynamic_tools_registry.clone());
    let page_service = grpc::page::PageServiceImpl::new(page_manager.clone());
    // ConversationService — IDatabasePort 설정하여 create_share / get_share / cleanup_expired_shares 활성.
    // .clone() — internal 30d cleanup cron (Server::builder 직전) 도 같은 manager 참조.
    let conversation_service =
        grpc::conversation::ConversationServiceImpl::new(conversation_manager.clone())
            .with_db(db.clone())
            .with_media(media_manager.clone());
    let mcp_service = grpc::mcp::McpServiceImpl::new(mcp_manager.clone());
    let entity_service = grpc::entity::EntityServiceImpl::new(entity_manager.clone());
    let episodic_service = grpc::episodic::EpisodicServiceImpl::new(episodic_manager.clone());
    let consolidation_service =
        grpc::consolidation::ConsolidationServiceImpl::new(consolidation_manager);
    // Library — Phase 1 (2026-05-17). infra/grpc/library.rs 영역 (extractor 영역 의존 — pdf-extract / extract_text_file).
    let library_service =
        firebat_infra::grpc::library::LibraryServiceImpl::new(library_manager.clone(), llm.clone(), vault.clone());
    // Hub — Phase 1 (2026-05-17). core/grpc/hub.rs 영역. SendMessage RPC 안 AiManager 의존
    // (외부 endpoint 통합 entry — 인증 + 대화 ensure + AI 호출 + 가드 + 영속화 한 RPC 안 흐름).
    let hub_service =
        grpc::hub::HubServiceImpl::new(hub_manager.clone(), ai_manager.clone())
            .with_media(media_manager.clone());
    // ScheduleService — TaskManager 설정하여 validate_pipeline 정밀 검증 활성
    let schedule_service = grpc::schedule::ScheduleServiceImpl::new(schedule_manager.clone())
        .with_task_manager(task_manager.clone());
    let task_service = grpc::task::TaskServiceImpl::new(task_manager.clone());
    // .clone() — internal 30d cleanup cron 과 같은 manager 참조 공유.
    let media_service = grpc::media::MediaServiceImpl::new(media_manager.clone())
        .with_tts(tts_adapter.clone());
    let ai_service = grpc::ai::AiServiceImpl::new(ai_manager.clone());

    // Phase B-17.5 — cross-cutting services (Storage / Settings / Network / Lifecycle).
    // Phase B-post audit A5 (2026-05-06): INetworkPort — 위 register_core_tools 앞에서 생성한 인스턴스 공유.
    let storage_service = grpc::storage::StorageServiceImpl::new(storage.clone());
    let settings_service = grpc::settings::SettingsServiceImpl::new(vault.clone());
    let network_service = grpc::network::NetworkServiceImpl::new(network_port.clone());
    // Phase B-17.5b — Cache / Telegram / Database 추가.
    // cache_adapter 는 sandbox 생성 시점에 만들어 있음 (L325). 같은 인스턴스 공유 — gRPC CacheService
    // 의 read / grep / aggregate / drop 호출이 sandbox 가 저장한 cache 와 동일 디렉토리 접근.
    let cache_service = grpc::cache::CacheServiceImpl::new(cache_adapter.clone());
    // TelegramService — AiManager + ModuleManager 설정하여 process_message webhook → AI → reply 활성
    let telegram_service = grpc::telegram::TelegramServiceImpl::new(vault.clone(), network_port.clone())
        .with_ai_and_module(ai_manager.clone(), module_manager.clone());
    // DatabaseService — raw SELECT escape hatch. 옛 raw rusqlite::Connection 직접 의존
    // (BIBLE Core 순수성 위반) → IDatabasePort port 위임으로 정정 (2026-05-06).
    let database_service = grpc::database::DatabaseServiceImpl::new(db.clone());
    let memory_file_service = grpc::memory_file::MemoryServiceImpl::new(memory_file_manager.clone());
    let skill_file_service = grpc::skill::SkillServiceImpl::new(skill_file_manager.clone());

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

    // 30일 retention cleanup 은 위 "시스템 스케줄"(builtin "retention", 6h)로 이전 — 옛 숨은 tokio 타이머 폐기.
    // 이제 스케줄 목록에 보이고(삭제 잠금) 실행기록도 남는다. 로직 동일(conv/media/hub cleanup_old_*).

    // MCP HTTP server (Phase E, 2026-05-12) — firebat-core binary 안 별도 axum endpoint.
    // 2026-05-14 default true — 옛 dual-run 의도 (Node mcp/internal-server.ts 와 동시 운영)
    // Phase E 완전 cutover 후 의미 사라짐. 매 운영 unit 마다 env 설정 부담 + 신규 설치 누락
    // silent 발생 (자체 sysmod LLM 노출 안 됨) 해소. FIREBAT_MCP_ENABLED=false 명시 시만 비활성.
    let mcp_enabled = std::env::var("FIREBAT_MCP_ENABLED")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);
    // stdio MCP 모드 — 외부 사용자 (Claude desktop / Cursor / npm run mcp) 진입.
    // argv 에 `--mcp-stdio` 가 있으면 gRPC server 부팅 X, stdio MCP server 만 실행 후 종료.
    if std::env::args().any(|a| a == "--mcp-stdio") {
        let mcp_state = std::sync::Arc::new(
            firebat_infra::mcp_server::McpServerState::new(vault.clone())
                .with_auth(auth_manager.clone())
                .with_module_manager(module_manager.clone()),
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
                library: library_manager.clone(),
                network: network_port.clone(),
                cache: cache_adapter.clone(),
                tool_manager: tool_manager.clone(),
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
                .with_auth(auth_manager.clone())
                .with_module_manager(module_manager.clone()),
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
                library: library_manager.clone(),
                network: network_port.clone(),
                cache: cache_adapter.clone(),
                tool_manager: tool_manager.clone(),
            },
        )
        .await;
        tokio::spawn(async move {
            if let Err(e) = firebat_infra::mcp_server::serve(mcp_state).await {
                tracing::error!("MCP server exited: {e}");
            }
        });
    }

    // gRPC reflection service — grpcurl / grpcui 등 도구가 schema inspection (dev ergonomics).
    // file_descriptor_set 는 core/build.rs 가 OUT_DIR 에 생성.
    let reflection_service = tonic_reflection::server::Builder::configure()
        .register_encoded_file_descriptor_set(firebat_core::FILE_DESCRIPTOR_SET)
        .build_v1()
        .context("failed to set up gRPC reflection service")?;

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
        .add_service(LibraryServiceServer::new(library_service))
        .add_service(HubServiceServer::new(hub_service))
        .add_service(StorageServiceServer::new(storage_service))
        .add_service(SettingsServiceServer::new(settings_service))
        .add_service(NetworkServiceServer::new(network_service))
        .add_service(LifecycleServiceServer::new(lifecycle_service))
        .add_service(CacheServiceServer::new(cache_service))
        .add_service(TelegramServiceServer::new(telegram_service))
        .add_service(DatabaseServiceServer::new(database_service))
        .add_service(MemoryServiceServer::new(memory_file_service))
        .add_service(SkillServiceServer::new(skill_file_service))
        .add_service(LogServiceServer::new(
            firebat_infra::log_service::LogServiceImpl::new(log_db_path, log_reload_handle.clone()),
        ))
        // Phase B-17.5 cross-cutting 8개 모두 설정. 남은 건 Phase D Tauri.
        .serve_with_shutdown(addr, shutdown)
        .await
        .context("gRPC server 종료 중 에러")?;

    eprintln!("Firebat Core — shutdown 완료");
    Ok(())
}

//! FilePromptLoader — IPromptLoaderPort 의 .md 파일 매 호출 read 구현 (2026-05-13).
//!
//! 운영자가 `infra/data/prompts/{tool_system,cron_agent}.md` 직접 편집 + 다음 LLM 호출 시 즉시 반영.
//! systemctl restart 0. 옛 `include_str!` 컴파일 시점 박힘 패턴 폐기.
//!
//! 경로 우선순위:
//!   1. `FIREBAT_PROMPTS_DIR` env override (개발 + 테스트 명시)
//!   2. `infra/data/prompts/` (개발 환경 — workspace root 기준)
//!   3. `/opt/firebat/infra/data/prompts/` (Vultr 운영)
//!
//! 파일 부재 시 fallback stub (옛 include_str! 의 hardcoded baseline). 운영 중 실수로 .md 삭제 시
//! AI 가 stub 으로 동작 → 사용자가 어색함 보고 → 운영자 .md 복원.

use firebat_core::ports::IPromptLoaderPort;
use std::path::PathBuf;

const STUB_TOOL_SYSTEM: &str = "(prompt 파일 미발견 — infra/data/prompts/tool_system.md 박혀있는지 확인)";
const STUB_CRON_AGENT: &str = "(prompt 파일 미발견 — infra/data/prompts/cron_agent.md 박혀있는지 확인)";
const STUB_PLAN_MODE_ALWAYS: &str = "(prompt 파일 미발견 — infra/data/prompts/plan_mode_always.md 박혀있는지 확인)";
const STUB_PLAN_MODE_AUTO: &str = "(prompt 파일 미발견 — infra/data/prompts/plan_mode_auto.md 박혀있는지 확인)";

pub struct FilePromptLoader {
    /// resolve 된 prompt 디렉토리 — startup 에서 1회 결정. 이후 매 호출은 read_to_string.
    dir: PathBuf,
}

impl FilePromptLoader {
    /// startup 에서 호출 — env override → workspace dev → /opt 운영 chain 으로 resolve.
    pub fn discover() -> Self {
        let dir = Self::resolve_dir();
        tracing::info!(dir = %dir.display(), "FilePromptLoader 디렉토리 resolve");
        Self { dir }
    }

    /// 명시 디렉토리 박는 ctor — 테스트 + 명시적 deployment.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn resolve_dir() -> PathBuf {
        if let Ok(env_path) = std::env::var("FIREBAT_PROMPTS_DIR") {
            let p = PathBuf::from(env_path);
            if p.exists() {
                return p;
            }
        }
        let dev = PathBuf::from("infra/data/prompts");
        if dev.exists() {
            return dev;
        }
        let prod = PathBuf::from("/opt/firebat/infra/data/prompts");
        if prod.exists() {
            return prod;
        }
        // 폴백 — 첫 후보 그대로 (read 시 NotFound 후 stub fallback).
        dev
    }

    fn read_or_stub(&self, name: &str, stub: &str) -> String {
        let path = self.dir.join(name);
        match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "prompt .md read 실패 — stub fallback");
                stub.to_string()
            }
        }
    }
}

impl IPromptLoaderPort for FilePromptLoader {
    fn tool_system(&self) -> String {
        self.read_or_stub("tool_system.md", STUB_TOOL_SYSTEM)
    }

    fn cron_agent(&self) -> String {
        self.read_or_stub("cron_agent.md", STUB_CRON_AGENT)
    }

    fn plan_mode_always(&self) -> String {
        self.read_or_stub("plan_mode_always.md", STUB_PLAN_MODE_ALWAYS)
    }

    fn plan_mode_auto(&self) -> String {
        self.read_or_stub("plan_mode_auto.md", STUB_PLAN_MODE_AUTO)
    }
}

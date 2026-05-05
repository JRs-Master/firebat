//! 공유 reqwest::Client — services / managers 가 외부 HTTP 호출 시 사용.
//!
//! Phase B-4 cutover 시 옛 `infra/llm/formats/common::http_client` 에서 core utils 로 이동.
//! 사유: services (network / telegram) 가 외부 HTTP 직접 호출 → core 가 client 보유.
//! infra 의 LLM format 핸들러도 같은 client 를 재사용 (connection pool 절약).

use std::sync::OnceLock;

/// 공유 reqwest::Client — connection pool 재사용. 첫 호출 시 lazy 초기화.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .pool_max_idle_per_host(8)
            .build()
            .expect("reqwest client 빌드 실패")
    })
}

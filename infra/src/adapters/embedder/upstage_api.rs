//! UpstageEmbedderAdapter — Upstage Solar Embedding 2 (API) via OpenAI-compatible /embeddings.
//!
//! **섀도우 A/B 평가 전용** (2026-07, 7/20 무료 기간). 운영 임베더는 로컬 E5 그대로이고, 이 어댑터는
//! RetrievalEngine 의 `shadow` 슬롯에만 주입되어 같은 쿼리를 병렬로 임베딩 → 결과를 로그로 남겨 E5 와
//! 비교한다. 저장 벡터(DB)는 E5 그대로라 이 어댑터 결과는 어디에도 영속되지 않는다(비교 로그만).
//!
//! OpenAI 완전 호환 — POST {base}/embeddings {model, input} → {data:[{embedding:[...]}]}.
//! query/passage 비대칭: embed_query = `solar-embedding-2-query` / embed_passage = `-passage`.
//!
//! 공식 한도 (2026-07-13 사용자 페이스트 문서): 차원 1024 / 문자열당 최대 4,000 토큰·빈 문자열
//! 금지 / 배열 입력 = 최대 100개·요청당 204,800 토큰. 품질 권고 = 512 토큰 이하. 아래 가드:
//! 빈 입력 = HTTP 전 명시 에러 / 2,000자 초과 = 절단(한글 ≈ 글자당 1+토큰이라 4,000토큰 한도의
//! 보수 캡 — E5 로컬도 512토큰 절단이라 스케일 동급).
//!
//! Rate-limit 방어 2겹 (2026-07-13 실측 — 카탈로그 secondary 백필이 엔트리별 개별 호출로
//! 부팅 warm 813콜·재빌드마다 수백 콜 → 429 폭풍, secondary 미영속이라 매 재빌드 전량 재시도):
//! ① `embed_passages` 배치 오버라이드(배열 입력, 64개/콜) — 콜 수 = 엔트리 수 → 청크 수.
//! ② 429 수신 시 어댑터 전역 쿨다운(10분) — 이후 호출은 HTTP 없이 즉시 에러(전 경로 공통:
//!   카탈로그 백필·쿼리 섀도우·리콜 섀도우가 같은 어댑터를 지나므로 한 곳에서 폭풍 차단).

use firebat_core::ports::{IEmbedderPort, InfraResult};
use std::sync::atomic::{AtomicI64, Ordering};

const UPSTAGE_EMBED_VERSION: &str = "upstage-solar-embed-2";
const UPSTAGE_EMBED_DIM: usize = 1024;
/// 배열 입력 청크 — 공식 한도 100개/요청의 보수값 (요청당 204,800 토큰 한도도 64×2,000자로 안전).
const BATCH_CHUNK: usize = 64;
/// 429 후 쿨다운 초 — rate-limit 창이 지나기 전 재시도는 전부 낭비 + 로그 스팸.
const RATE_LIMIT_COOLDOWN_SECS: i64 = 600;

/// 어댑터 전역(프로세스) 쿨다운 만료 epoch 초 — 인스턴스가 여러 곳(카탈로그 6종·리콜 섀도우)에
/// 주입되어도 rate limit 은 계정 단위라 전역이 정확한 스코프.
static COOLDOWN_UNTIL: AtomicI64 = AtomicI64::new(0);

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn check_cooldown() -> InfraResult<()> {
    let until = COOLDOWN_UNTIL.load(Ordering::Relaxed);
    if now_secs() < until {
        return Err(format!(
            "upstage embed: rate-limit(429) 쿨다운 중 — {}초 후 재시도합니다",
            until - now_secs()
        ));
    }
    Ok(())
}

fn trip_cooldown_if_rate_limited(status: reqwest::StatusCode) {
    if status.as_u16() == 429 {
        let until = now_secs() + RATE_LIMIT_COOLDOWN_SECS;
        COOLDOWN_UNTIL.store(until, Ordering::Relaxed);
        tracing::warn!(
            target: "embed_shadow",
            "upstage rate limit (429) — embedder cooling down for {}s (all callers fast-fail without HTTP)",
            RATE_LIMIT_COOLDOWN_SECS
        );
    }
}

pub struct UpstageEmbedderAdapter {
    api_key: String,
    endpoint: String, // "https://api.upstage.ai/v1/embeddings"
    query_model: String,
    passage_model: String,
}

impl UpstageEmbedderAdapter {
    pub fn new(api_key: String) -> Self {
        Self {
            api_key,
            endpoint: "https://api.upstage.ai/v1/embeddings".to_string(),
            query_model: "solar-embedding-2-query".to_string(),
            passage_model: "solar-embedding-2-passage".to_string(),
        }
    }

    /// 공식 한도 가드 — 빈 문자열 = API 거부라 HTTP 전 명시 에러, 4,000토큰/문자열 한도는
    /// 2,000자 절단으로 보수 커버(char 경계 안전 — 바이트 절단 panic 클래스 회피).
    fn clamp_input(text: &str) -> InfraResult<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return Err("upstage embed: 빈 입력은 임베딩할 수 없습니다".to_string());
        }
        Ok(if trimmed.chars().count() > 2000 {
            trimmed.chars().take(2000).collect()
        } else {
            trimmed.to_string()
        })
    }

    /// L2 normalize — consumers (semantic_catalog / trait cosine) assume normalized vectors
    /// (dot product = cosine). No-op if the API already returns unit vectors.
    fn l2_normalize(vec: &mut [f32]) {
        let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in vec.iter_mut() {
                *x /= norm;
            }
        }
    }

    /// 요청 본체 — input 은 단건 문자열 또는 배열(OpenAI 호환 양쪽 수용). data 배열을
    /// index 순으로 반환(배치 응답 순서 보장용 index 필드 사용).
    async fn request(&self, model: &str, input: serde_json::Value) -> InfraResult<Vec<Vec<f32>>> {
        check_cooldown()?;
        let body = serde_json::json!({ "model": model, "input": input });
        let resp = firebat_core::utils::http_client::http_client()
            .post(&self.endpoint)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("upstage embed 요청 실패: {e}"))?;
        let status = resp.status();
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("upstage embed 응답 파싱 실패: {e}"))?;
        if !status.is_success() {
            trip_cooldown_if_rate_limited(status);
            return Err(format!("upstage embed API 에러 {status}: {json}"));
        }
        let mut items: Vec<(usize, Vec<f32>)> = json
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| {
                        let idx = e.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                        let v = e
                            .get("embedding")
                            .and_then(|v| v.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|x| x.as_f64().map(|f| f as f32))
                                    .collect::<Vec<f32>>()
                            })?;
                        Some((idx, v))
                    })
                    .collect()
            })
            .ok_or_else(|| "upstage embed 응답에 embedding 없음".to_string())?;
        if items.is_empty() {
            return Err("upstage embed 응답에 embedding 없음".to_string());
        }
        items.sort_by_key(|(i, _)| *i);
        Ok(items
            .into_iter()
            .map(|(_, mut v)| {
                Self::l2_normalize(&mut v);
                v
            })
            .collect())
    }

    async fn embed(&self, model: &str, text: &str) -> InfraResult<Vec<f32>> {
        let input = Self::clamp_input(text)?;
        let mut out = self.request(model, serde_json::Value::String(input)).await?;
        out.pop().ok_or_else(|| "upstage embed 응답에 embedding 없음".to_string())
    }
}

#[async_trait::async_trait]
impl IEmbedderPort for UpstageEmbedderAdapter {
    fn version(&self) -> &str {
        UPSTAGE_EMBED_VERSION
    }

    async fn embed_query(&self, text: &str) -> InfraResult<Vec<f32>> {
        self.embed(&self.query_model.clone(), text).await
    }

    async fn embed_passage(&self, text: &str) -> InfraResult<Vec<f32>> {
        self.embed(&self.passage_model.clone(), text).await
    }

    /// 배치 오버라이드 — 배열 입력(64개/콜)로 카탈로그 백필의 콜 수를 구조적으로 축소.
    /// 개수·순서 보존(응답 index 정렬). 청크 중 하나라도 실패하면 에러(호출자가 부분 결과 없이
    /// 다음 재빌드로 이월 — 쿨다운이 후속 청크를 즉시 끊어 폭풍 없음).
    async fn embed_passages(&self, texts: &[String]) -> InfraResult<Vec<Vec<f32>>> {
        let mut out: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BATCH_CHUNK) {
            let inputs: Vec<serde_json::Value> = chunk
                .iter()
                .map(|t| Self::clamp_input(t).map(serde_json::Value::String))
                .collect::<InfraResult<Vec<_>>>()?;
            let n = inputs.len();
            let vecs = self
                .request(&self.passage_model.clone(), serde_json::Value::Array(inputs))
                .await?;
            if vecs.len() != n {
                return Err(format!(
                    "upstage embed 배치 응답 개수 불일치: {} 요청 / {} 수신",
                    n,
                    vecs.len()
                ));
            }
            out.extend(vecs);
        }
        Ok(out)
    }

    fn dimension(&self) -> usize {
        UPSTAGE_EMBED_DIM
    }
    // cosine / vec_to_bytes / bytes_to_vec = trait 기본 구현 (정규화 벡터 dot product).
}

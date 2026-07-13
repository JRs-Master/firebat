//! UpstageEmbedderAdapter — Upstage Solar Embedding 2 (API) via OpenAI-compatible /embeddings.
//!
//! **섀도우 A/B 평가 전용** (2026-07, 7/20 무료 기간). 운영 임베더는 로컬 E5 그대로이고, 이 어댑터는
//! RetrievalEngine 의 `shadow` 슬롯에만 주입되어 같은 쿼리를 병렬로 임베딩 → 결과를 로그로 남겨 E5 와
//! 비교한다. 저장 벡터(DB)는 E5 그대로라 이 어댑터 결과는 어디에도 영속되지 않는다(비교 로그만).
//!
//! OpenAI 완전 호환 — POST {base}/embeddings {model, input} → {data:[{embedding:[...]}]}.
//! query/passage 비대칭: embed_query = `solar-embedding-2-query` / embed_passage = `-passage`.

use firebat_core::ports::{IEmbedderPort, InfraResult};

const UPSTAGE_EMBED_VERSION: &str = "upstage-solar-embed-2";
const UPSTAGE_EMBED_DIM: usize = 1024;

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

    async fn embed(&self, model: &str, text: &str) -> InfraResult<Vec<f32>> {
        let body = serde_json::json!({ "model": model, "input": text });
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
            return Err(format!("upstage embed API 에러 {status}: {json}"));
        }
        let mut vec = json
            .get("data")
            .and_then(|d| d.as_array())
            .and_then(|a| a.first())
            .and_then(|e| e.get("embedding"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_f64().map(|f| f as f32))
                    .collect::<Vec<f32>>()
            })
            .ok_or_else(|| "upstage embed 응답에 embedding 없음".to_string())?;
        // L2 normalize — consumers (semantic_catalog / trait cosine) assume normalized vectors
        // (dot product = cosine). No-op if the API already returns unit vectors.
        let norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in vec.iter_mut() {
                *x /= norm;
            }
        }
        Ok(vec)
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

    fn dimension(&self) -> usize {
        UPSTAGE_EMBED_DIM
    }
    // cosine / vec_to_bytes / bytes_to_vec = trait 기본 구현 (정규화 벡터 dot product).
}

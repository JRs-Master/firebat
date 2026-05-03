//! StubEmbedderAdapter — 진짜 ONNX 모델 박기 전 결정론적 hash 기반 pseudo-embedding.
//!
//! 옛 TS 의 `infra/llm/embedder.ts` 는 `Xenova/multilingual-e5-small` (transformers.js
//! 로컬 ONNX, 384차원) 사용. Rust 1:1 port 시 ONNX runtime (candle / ort crate) +
//! 모델 다운로드/캐싱이 필요한데 빌드 환경 + 의존성 큼 → **별도 batch 로 격리**.
//!
//! 현재 stub:
//!   - FNV-1a hash → 결정론적 (같은 입력 → 같은 벡터)
//!   - 384차원 (옛 TS 모델 dim 1:1)
//!   - E5 prefix 패턴만 흉내 (실제 의미 검색 X — wiring + 단위 테스트 가능 수준)
//!
//! ConversationManager.search_history / EntityManager.search_entities 의 cosine 검색은
//! stub 단계에서는 의미 0 — substring 매칭이 실용적. ONNX 박힌 후 자동 활성.

use crate::ports::{IEmbedderPort, InfraResult};

const STUB_DIM: usize = 384;
const STUB_VERSION: &str = "stub-fnv1a-v1";

pub struct StubEmbedderAdapter {
    dim: usize,
}

impl StubEmbedderAdapter {
    pub fn new() -> Self {
        Self { dim: STUB_DIM }
    }

    pub fn with_dim(dim: usize) -> Self {
        Self { dim }
    }

    fn hash_to_vec(&self, prefix: &str, text: &str) -> Vec<f32> {
        // E5 prefix 패턴 흉내 — `query: ...` / `passage: ...` 다른 hash seed 부여.
        let input = format!("{prefix}: {text}");

        // FNV-1a 64-bit hash
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in input.bytes() {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }

        let mut out = Vec::with_capacity(self.dim);
        for i in 0..self.dim {
            let v = (hash
                .wrapping_add(i as u64)
                .wrapping_mul(0x9E3779B97F4A7C15)
                % 10_000) as f32
                / 10_000.0;
            out.push(v - 0.5); // -0.5 ~ 0.5
        }

        // L2 normalize — 옛 TS E5 모델이 normalize:true 박은 패턴 따라감.
        let norm = out.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > f32::EPSILON {
            for x in out.iter_mut() {
                *x /= norm;
            }
        }
        out
    }
}

impl Default for StubEmbedderAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl IEmbedderPort for StubEmbedderAdapter {
    fn version(&self) -> &str {
        STUB_VERSION
    }

    async fn embed_query(&self, text: &str) -> InfraResult<Vec<f32>> {
        Ok(self.hash_to_vec("query", text))
    }

    async fn embed_passage(&self, text: &str) -> InfraResult<Vec<f32>> {
        Ok(self.hash_to_vec("passage", text))
    }

    fn dimension(&self) -> usize {
        self.dim
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stub_embedder_returns_384_dim() {
        let e = StubEmbedderAdapter::new();
        let v = e.embed_query("hello").await.unwrap();
        assert_eq!(v.len(), 384);
        assert_eq!(e.dimension(), 384);
    }

    #[tokio::test]
    async fn stub_embedder_deterministic_same_input() {
        let e = StubEmbedderAdapter::new();
        let a = e.embed_query("같은 입력").await.unwrap();
        let b = e.embed_query("같은 입력").await.unwrap();
        assert_eq!(a, b);
    }

    #[tokio::test]
    async fn stub_embedder_different_input_different_vector() {
        let e = StubEmbedderAdapter::new();
        let a = e.embed_query("hello").await.unwrap();
        let b = e.embed_query("world").await.unwrap();
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn stub_embedder_query_passage_different_vectors() {
        // E5 prefix 패턴 — 같은 텍스트라도 query / passage 는 다른 벡터.
        let e = StubEmbedderAdapter::new();
        let q = e.embed_query("삼성전자").await.unwrap();
        let p = e.embed_passage("삼성전자").await.unwrap();
        assert_ne!(q, p);
    }

    #[tokio::test]
    async fn stub_embedder_l2_normalized() {
        let e = StubEmbedderAdapter::new();
        let v = e.embed_query("hello world").await.unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "L2 norm should be ~1.0, got {norm}");
    }

    #[tokio::test]
    async fn stub_embedder_cosine_self_is_one() {
        let e = StubEmbedderAdapter::new();
        let v = e.embed_query("같은 벡터").await.unwrap();
        let cos = e.cosine(&v, &v);
        assert!((cos - 1.0).abs() < 1e-5, "cosine(v, v) should be ~1.0, got {cos}");
    }

    #[test]
    fn stub_embedder_bytes_roundtrip() {
        let e = StubEmbedderAdapter::new();
        let v = vec![0.1f32, -0.5, 0.7, 1.0, -1.0];
        let bytes = e.vec_to_bytes(&v);
        assert_eq!(bytes.len(), v.len() * 4);
        let restored = e.bytes_to_vec(&bytes);
        assert_eq!(restored, v);
    }

    #[test]
    fn stub_embedder_version_stable() {
        let e = StubEmbedderAdapter::new();
        assert_eq!(e.version(), "stub-fnv1a-v1");
    }
}

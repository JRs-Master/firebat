//! E5LocalEmbedderAdapter — `intfloat/multilingual-e5-small` safetensors 모델 로컬 추론.
//!
//! 옛 TS `infra/llm/embedder.ts` (transformers.js + `Xenova/multilingual-e5-small`) 1:1 port.
//! candle (HuggingFace 공식 pure Rust ML) + hf-hub (모델 자동 다운로드 + 캐싱) + tokenizers.
//!
//! 모델: `intfloat/multilingual-e5-small`
//!   - safetensors 약 470MB (multilingual, 한국어 retrieval 양호)
//!   - 384-dim 출력 (E5 family 의 small 변형)
//!   - mean pooling + L2 normalize → cosine similarity = dot product
//!
//! E5 prefix 패턴:
//!   - `embed_query(text)` → tokenize(`query: {text}`)
//!   - `embed_passage(text)` → tokenize(`passage: {text}`)
//!
//! Lazy 로드 — 첫 호출 시 모델 다운로드 + load (~2-5초). 이후 in-memory 재사용.
//! 동시성 — `tokio::sync::OnceCell` 으로 한 번만 init, 이후 모델은 `&` shared 접근 (forward 는
//! `&BertModel` self 라 동시 호출 안전).

use std::path::PathBuf;
use std::sync::Arc;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::bert::{BertModel, Config, DTYPE};
use hf_hub::api::tokio::Api;
use hf_hub::{Repo, RepoType};
use tokenizers::Tokenizer;
use tokio::sync::OnceCell;

use crate::ports::{IEmbedderPort, InfraResult};

/// 모델 ID — 옛 TS Xenova fork 가 아닌 HF 공식 (safetensors 호환).
const E5_MODEL_ID: &str = "intfloat/multilingual-e5-small";
/// 캐시 무효화 키 — 모델 교체 시 값 변경 → SQLite 임베딩 BLOB 자동 재인덱싱.
const E5_VERSION: &str = "e5-small-multilingual-v1";
/// 차원 — multilingual-e5-small = 384.
const E5_DIM: usize = 384;
/// 토크나이저 max_length (옛 TS transformers.js default 와 동일).
const E5_MAX_LENGTH: usize = 512;

/// 로드된 모델 + 토크나이저 + device. OnceCell 안에 박힘 (한 번만 init).
struct E5State {
    model: BertModel,
    tokenizer: Tokenizer,
    device: Device,
}

pub struct E5LocalEmbedderAdapter {
    /// 모델 캐시 디렉토리 override — 미박음 시 hf-hub default (`~/.cache/huggingface/hub/`).
    /// FIREBAT_EMBEDDER_CACHE env 박혀있으면 사용 (Docker / Tauri portable 시 portable USB).
    cache_dir: Option<PathBuf>,
    state: OnceCell<Arc<E5State>>,
}

impl E5LocalEmbedderAdapter {
    pub fn new() -> Self {
        let cache_dir = std::env::var("FIREBAT_EMBEDDER_CACHE").ok().map(PathBuf::from);
        Self {
            cache_dir,
            state: OnceCell::new(),
        }
    }

    pub fn with_cache_dir(cache_dir: PathBuf) -> Self {
        Self {
            cache_dir: Some(cache_dir),
            state: OnceCell::new(),
        }
    }

    /// 모델 + tokenizer 로드 — 첫 호출 시 hf-hub 으로 자동 다운로드, 이후 shared `Arc<E5State>`.
    /// OnceCell 의 `get_or_try_init` 으로 race-safe.
    async fn ensure_loaded(&self) -> Result<Arc<E5State>, String> {
        let state = self
            .state
            .get_or_try_init(|| async { self.load_state().await })
            .await?;
        Ok(state.clone())
    }

    async fn load_state(&self) -> Result<Arc<E5State>, String> {
        // hf-hub Api — 모델 자동 다운로드 + 캐싱.
        let api = self.build_api()?;
        let repo = api.repo(Repo::with_revision(
            E5_MODEL_ID.to_string(),
            RepoType::Model,
            "main".to_string(),
        ));

        let config_path = repo
            .get("config.json")
            .await
            .map_err(|e| format!("E5 config.json 다운로드 실패: {e}"))?;
        let tokenizer_path = repo
            .get("tokenizer.json")
            .await
            .map_err(|e| format!("E5 tokenizer.json 다운로드 실패: {e}"))?;
        let weights_path = repo
            .get("model.safetensors")
            .await
            .map_err(|e| format!("E5 model.safetensors 다운로드 실패: {e}"))?;

        let config_str = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("config.json 읽기: {e}"))?;
        let config: Config = serde_json::from_str(&config_str)
            .map_err(|e| format!("config.json 파싱: {e}"))?;

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("tokenizer.json 파싱: {e}"))?;
        // padding + truncation 활성 — batch 시 길이 통일. 단일 호출 시도 truncation 만 의미.
        tokenizer
            .with_padding(Some(tokenizers::PaddingParams {
                strategy: tokenizers::PaddingStrategy::BatchLongest,
                direction: tokenizers::PaddingDirection::Right,
                pad_to_multiple_of: None,
                pad_id: 1, // XLM-R / E5 의 <pad> token id
                pad_type_id: 0,
                pad_token: "<pad>".to_string(),
            }))
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: E5_MAX_LENGTH,
                direction: tokenizers::TruncationDirection::Right,
                strategy: tokenizers::TruncationStrategy::LongestFirst,
                stride: 0,
            }))
            .map_err(|e| format!("tokenizer truncation: {e}"))?;

        // CPU only — Tauri / Docker self-hosted 모두 대응. cuda/metal 빌드는 별도 cargo feature.
        let device = Device::Cpu;
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DTYPE, &device)
                .map_err(|e| format!("safetensors 로드: {e}"))?
        };
        let model = BertModel::load(vb, &config).map_err(|e| format!("BertModel 로드: {e}"))?;

        Ok(Arc::new(E5State {
            model,
            tokenizer,
            device,
        }))
    }

    fn build_api(&self) -> Result<Api, String> {
        let mut builder = hf_hub::api::tokio::ApiBuilder::new();
        if let Some(dir) = &self.cache_dir {
            builder = builder.with_cache_dir(dir.clone());
        }
        builder
            .build()
            .map_err(|e| format!("hf-hub Api 초기화: {e}"))
    }

    /// 단일 텍스트 → mean-pooled + L2-normalized 384-dim Vec<f32>.
    /// 옛 TS `embedWithPrefix` (pooling: mean, normalize: true) 1:1 패턴.
    async fn embed_with_prefix(&self, prefix: &str, text: &str) -> InfraResult<Vec<f32>> {
        let state = self.ensure_loaded().await?;
        let input = format!("{}: {}", prefix, text);
        let encoding = state
            .tokenizer
            .encode(input, true)
            .map_err(|e| format!("tokenize 실패: {e}"))?;

        let ids = encoding.get_ids();
        let mask = encoding.get_attention_mask();
        if ids.is_empty() {
            return Err("tokenize 결과가 비어있음".to_string());
        }

        // [1, seq_len] tensor (batch=1)
        let input_ids = Tensor::new(ids, &state.device)
            .and_then(|t| t.unsqueeze(0))
            .map_err(|e| format!("input_ids tensor: {e}"))?;
        let attention_mask = Tensor::new(mask, &state.device)
            .and_then(|t| t.unsqueeze(0))
            .map_err(|e| format!("attention_mask tensor: {e}"))?;
        let token_type_ids = input_ids
            .zeros_like()
            .map_err(|e| format!("token_type_ids zeros: {e}"))?;

        // BertModel forward → last_hidden_state [1, seq_len, hidden]
        let hidden = state
            .model
            .forward(&input_ids, &token_type_ids, Some(&attention_mask))
            .map_err(|e| format!("BertModel forward: {e}"))?;

        // mean pooling (attention_mask 가중) — 옛 TS 의 `pooling: 'mean'` 1:1.
        let mask_f = attention_mask
            .unsqueeze(2)
            .and_then(|t| t.to_dtype(DType::F32))
            .map_err(|e| format!("mask cast: {e}"))?;
        // hidden 은 BertModel output dtype (config 따라 F32) — to_dtype 으로 통일.
        let hidden_f = hidden
            .to_dtype(DType::F32)
            .map_err(|e| format!("hidden cast: {e}"))?;
        let masked = (&hidden_f * &mask_f).map_err(|e| format!("mask multiply: {e}"))?;
        let summed = masked.sum(1).map_err(|e| format!("sum seq: {e}"))?;
        let counts = mask_f.sum(1).map_err(|e| format!("count mask: {e}"))?;
        let mean = (summed / counts).map_err(|e| format!("mean div: {e}"))?;

        // L2 normalize — 옛 TS `normalize: true` 1:1.
        let norm = mean
            .sqr()
            .and_then(|t| t.sum_keepdim(1))
            .and_then(|t| t.sqrt())
            .map_err(|e| format!("L2 norm: {e}"))?;
        let normalized = (mean / norm).map_err(|e| format!("normalize div: {e}"))?;

        // [1, 384] → Vec<f32>
        let vec: Vec<f32> = normalized
            .squeeze(0)
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| format!("to_vec: {e}"))?;
        if vec.len() != E5_DIM {
            return Err(format!(
                "예상치 못한 임베딩 차원: {} (expected {})",
                vec.len(),
                E5_DIM
            ));
        }
        Ok(vec)
    }
}

impl Default for E5LocalEmbedderAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl IEmbedderPort for E5LocalEmbedderAdapter {
    fn version(&self) -> &str {
        E5_VERSION
    }

    async fn embed_query(&self, text: &str) -> InfraResult<Vec<f32>> {
        self.embed_with_prefix("query", text).await
    }

    async fn embed_passage(&self, text: &str) -> InfraResult<Vec<f32>> {
        self.embed_with_prefix("passage", text).await
    }

    fn dimension(&self) -> usize {
        E5_DIM
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 실 모델 다운로드 + 추론 — `cargo test --lib --ignored` 로 manual run.
    /// CI / 일반 빌드는 skip (네트워크 의존 + ~470MB 다운로드 + 첫 로드 ~5초).
    #[tokio::test]
    #[ignore]
    async fn e5_real_inference_query_passage_distinct() {
        let e = E5LocalEmbedderAdapter::new();
        let q = e.embed_query("삼성전자").await.unwrap();
        let p = e.embed_passage("삼성전자").await.unwrap();
        assert_eq!(q.len(), 384);
        assert_eq!(p.len(), 384);
        // E5 prefix 패턴 — 같은 텍스트라도 query / passage 다른 벡터
        assert_ne!(q, p);
        // L2 normalized — norm ~= 1.0
        let norm: f32 = q.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "L2 norm should be ~1.0, got {norm}");
    }

    #[tokio::test]
    #[ignore]
    async fn e5_real_semantic_similarity() {
        let e = E5LocalEmbedderAdapter::new();
        // 의미적으로 가까운 문장
        let a = e.embed_query("삼성전자 반도체 주가 분석").await.unwrap();
        let b = e.embed_passage("Samsung semiconductor stock review").await.unwrap();
        // 의미적으로 먼 문장
        let c = e.embed_passage("강아지 사료 추천").await.unwrap();
        let sim_close = e.cosine(&a, &b);
        let sim_far = e.cosine(&a, &c);
        assert!(
            sim_close > sim_far,
            "의미 가까운 쪽이 cosine 더 커야: close={sim_close} far={sim_far}"
        );
    }

    #[test]
    fn version_stable() {
        let e = E5LocalEmbedderAdapter::new();
        assert_eq!(e.version(), "e5-small-multilingual-v1");
        assert_eq!(e.dimension(), 384);
    }
}

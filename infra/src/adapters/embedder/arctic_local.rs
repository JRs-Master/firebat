//! ArcticLocalEmbedderAdapter — `Snowflake/snowflake-arctic-embed-l-v2.0` safetensors 모델 로컬 추론.
//!
//! candle (HuggingFace 공식 pure Rust ML) + hf-hub (모델 자동 다운로드 + 캐싱) + tokenizers.
//! XLM-RoBERTa-large 기반 (multilingual training + Snowflake 자체 fine-tune).
//!
//! 모델: `Snowflake/snowflake-arctic-embed-l-v2.0` (2024-12 release)
//!   - safetensors 약 1.1GB (multilingual, MTEB 다국어 65.8 — BGE-M3 의 ~98% 영역)
//!   - 1024-dim 출력 (XLM-RoBERTa-large hidden size)
//!   - mean pooling + L2 normalize → cosine similarity = dot product
//!   - max_length 8192 (E5-small 의 512 영역 보다 ↑ — 긴 자료 영역 단일 chunk 가능)
//!
//! BGE-M3 와 차이:
//!   - 메모리 절반 (1.1GB vs 2.27GB) — 가성비 영역
//!   - 정확도 영역 ~1.2% 영역 차이 (사용자 사용 영역 체감 0)
//!   - 후속 주자 (2024-12) + Snowflake 의 enterprise 영역 안정 + 다음 버전 영역 박을 가능성 ↑
//!
//! E5 와 차이:
//!   - prefix 영역 없음 (Arctic = query / passage prefix 박지 X)
//!   - dim 1024 (E5-small 384)
//!   - max_length 8192 (E5 512)
//!   - architecture XLM-RoBERTa (E5 BertModel)
//!
//! Lazy 로드 — 첫 호출 시 모델 다운로드 + load (~5-15초). 이후 in-memory 재사용.
//! 동시성 — `tokio::sync::OnceCell` 으로 한 번만 init, 이후 모델은 `&` shared 접근.

use std::path::PathBuf;
use std::sync::Arc;

use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::xlm_roberta::{Config, XLMRobertaModel};
use hf_hub::api::tokio::Api;
use hf_hub::{Repo, RepoType};
use tokenizers::Tokenizer;
use tokio::sync::OnceCell;

use firebat_core::ports::{IEmbedderPort, InfraResult};

const ARCTIC_MODEL_ID: &str = "Snowflake/snowflake-arctic-embed-l-v2.0";
const ARCTIC_VERSION: &str = "arctic-embed-l-v2.0";
const ARCTIC_DIM: usize = 1024;
const ARCTIC_MAX_LENGTH: usize = 8192;
const DTYPE: DType = DType::F32;

struct ArcticState {
    model: XLMRobertaModel,
    tokenizer: Tokenizer,
    device: Device,
}

pub struct ArcticLocalEmbedderAdapter {
    cache_dir: Option<PathBuf>,
    state: OnceCell<Arc<ArcticState>>,
}

impl ArcticLocalEmbedderAdapter {
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

    async fn ensure_loaded(&self) -> Result<Arc<ArcticState>, String> {
        let state = self
            .state
            .get_or_try_init(|| async {
                let result = self.load_state().await;
                if let Err(ref e) = result {
                    tracing::error!(
                        model_id = ARCTIC_MODEL_ID,
                        cache_dir = ?self.cache_dir,
                        error = %e,
                        "[ArcticEmbedder] 모델 로드 실패 — 다음 호출 시 재시도"
                    );
                }
                result
            })
            .await?;
        Ok(state.clone())
    }

    async fn load_state(&self) -> Result<Arc<ArcticState>, String> {
        tracing::info!(
            model_id = ARCTIC_MODEL_ID,
            cache_dir = ?self.cache_dir,
            "[ArcticEmbedder] 모델 로드 시작 — 첫 호출 시 ~1.1GB 다운로드"
        );
        let api = self.build_api()?;
        let repo = api.repo(Repo::with_revision(
            ARCTIC_MODEL_ID.to_string(),
            RepoType::Model,
            "main".to_string(),
        ));

        tracing::debug!("[ArcticEmbedder] config.json 다운로드 시도");
        let config_path = repo
            .get("config.json")
            .await
            .map_err(|e| format!("Arctic config.json 다운로드 실패: {e}"))?;
        tracing::debug!(path = ?config_path, "[ArcticEmbedder] config.json 받음");

        tracing::debug!("[ArcticEmbedder] tokenizer.json 다운로드 시도");
        let tokenizer_path = repo
            .get("tokenizer.json")
            .await
            .map_err(|e| format!("Arctic tokenizer.json 다운로드 실패: {e}"))?;
        tracing::debug!(path = ?tokenizer_path, "[ArcticEmbedder] tokenizer.json 받음");

        tracing::debug!("[ArcticEmbedder] model.safetensors 다운로드 시도 (~1.1GB)");
        let weights_path = repo
            .get("model.safetensors")
            .await
            .map_err(|e| format!("Arctic model.safetensors 다운로드 실패: {e}"))?;
        tracing::info!(path = ?weights_path, "[ArcticEmbedder] safetensors 받음");

        let config_str = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("config.json 읽기: {e}"))?;
        let config: Config = serde_json::from_str(&config_str)
            .map_err(|e| format!("config.json 파싱: {e}"))?;

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("tokenizer.json 파싱: {e}"))?;
        tokenizer
            .with_padding(Some(tokenizers::PaddingParams {
                strategy: tokenizers::PaddingStrategy::BatchLongest,
                direction: tokenizers::PaddingDirection::Right,
                pad_to_multiple_of: None,
                pad_id: 1, // XLM-Roberta <pad> token id
                pad_type_id: 0,
                pad_token: "<pad>".to_string(),
            }))
            .with_truncation(Some(tokenizers::TruncationParams {
                max_length: ARCTIC_MAX_LENGTH,
                direction: tokenizers::TruncationDirection::Right,
                strategy: tokenizers::TruncationStrategy::LongestFirst,
                stride: 0,
            }))
            .map_err(|e| format!("tokenizer truncation: {e}"))?;

        let device = Device::Cpu;
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[weights_path], DTYPE, &device)
                .map_err(|e| format!("safetensors 로드: {e}"))?
        };
        let model = XLMRobertaModel::new(&config, vb)
            .map_err(|e| format!("XLMRobertaModel 로드: {e}"))?;

        tracing::info!(
            model_id = ARCTIC_MODEL_ID,
            dim = ARCTIC_DIM,
            "[ArcticEmbedder] 모델 로드 완료 — OnceCell cache 박힘 (다음 호출은 hf_hub init 0)"
        );
        Ok(Arc::new(ArcticState {
            model,
            tokenizer,
            device,
        }))
    }

    fn build_api(&self) -> Result<Api, String> {
        // 옛 commit `3418b4b` 안 HF_ENDPOINT env fix = 잘못된 진단. hf-hub 0.3 안 env 안
        // 읽음. 0.4 upgrade + `with_endpoint` 명시 호출 정공 (e5_local.rs 와 동일 패턴).
        let endpoint = std::env::var("HF_ENDPOINT")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "https://huggingface.co".to_string());
        tracing::info!(endpoint = %endpoint, "[ArcticEmbedder] hf-hub endpoint 설정");
        let mut builder = hf_hub::api::tokio::ApiBuilder::new()
            .with_endpoint(endpoint);
        if let Some(dir) = &self.cache_dir {
            builder = builder.with_cache_dir(dir.clone());
        }
        builder
            .build()
            .map_err(|e| format!("hf-hub Api 초기화: {e}"))
    }

    /// 단일 텍스트 → mean-pooled + L2-normalized 1024-dim Vec<f32>.
    /// Arctic Embed = prefix 영역 박지 X (E5 와 다름).
    async fn embed_text(&self, text: &str) -> InfraResult<Vec<f32>> {
        let state = self.ensure_loaded().await?;
        let encoding = state
            .tokenizer
            .encode(text, true)
            .map_err(|e| format!("tokenize 실패: {e}"))?;

        let ids = encoding.get_ids();
        let mask = encoding.get_attention_mask();
        if ids.is_empty() {
            return Err("tokenize 결과가 비어있음".to_string());
        }

        let input_ids = Tensor::new(ids, &state.device)
            .and_then(|t| t.unsqueeze(0))
            .map_err(|e| format!("input_ids tensor: {e}"))?;
        let attention_mask = Tensor::new(mask, &state.device)
            .and_then(|t| t.unsqueeze(0))
            .map_err(|e| format!("attention_mask tensor: {e}"))?;
        let token_type_ids = input_ids
            .zeros_like()
            .map_err(|e| format!("token_type_ids zeros: {e}"))?;

        // XLMRobertaModel forward — past_key_value / encoder_hidden_states / encoder_attention_mask 모두 None
        let hidden = state
            .model
            .forward(&input_ids, &attention_mask, &token_type_ids, None, None, None)
            .map_err(|e| format!("XLMRobertaModel forward: {e}"))?;

        // mean pooling (attention_mask 가중) — E5 와 동일 패턴
        let mask_f = attention_mask
            .unsqueeze(2)
            .and_then(|t| t.to_dtype(DType::F32))
            .map_err(|e| format!("mask cast: {e}"))?;
        let hidden_f = hidden
            .to_dtype(DType::F32)
            .map_err(|e| format!("hidden cast: {e}"))?;
        let masked = (&hidden_f * &mask_f).map_err(|e| format!("mask multiply: {e}"))?;
        let summed = masked.sum(1).map_err(|e| format!("sum seq: {e}"))?;
        let counts = mask_f.sum(1).map_err(|e| format!("count mask: {e}"))?;
        let mean = (summed / counts).map_err(|e| format!("mean div: {e}"))?;

        // L2 normalize
        let norm = mean
            .sqr()
            .and_then(|t| t.sum_keepdim(1))
            .and_then(|t| t.sqrt())
            .map_err(|e| format!("L2 norm: {e}"))?;
        let normalized = (mean / norm).map_err(|e| format!("normalize div: {e}"))?;

        let vec: Vec<f32> = normalized
            .squeeze(0)
            .and_then(|t| t.to_vec1::<f32>())
            .map_err(|e| format!("to_vec: {e}"))?;
        if vec.len() != ARCTIC_DIM {
            return Err(format!(
                "예상치 못한 임베딩 차원: {} (expected {})",
                vec.len(),
                ARCTIC_DIM
            ));
        }
        Ok(vec)
    }
}

impl Default for ArcticLocalEmbedderAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl IEmbedderPort for ArcticLocalEmbedderAdapter {
    fn version(&self) -> &str {
        ARCTIC_VERSION
    }

    async fn embed_query(&self, text: &str) -> InfraResult<Vec<f32>> {
        // Arctic Embed v2.0 = query / passage prefix 박지 X — 단순 text 영역 입력
        self.embed_text(text).await
    }

    async fn embed_passage(&self, text: &str) -> InfraResult<Vec<f32>> {
        self.embed_text(text).await
    }

    fn dimension(&self) -> usize {
        ARCTIC_DIM
    }
}

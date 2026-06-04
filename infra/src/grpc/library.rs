//! LibraryServiceImpl — Library Phase 1 (2026-05-17) 의 gRPC 영역.
//!
//! infra 에 둔 사유 — UploadSource RPC 가 pdf-extract / extract_text_file 를
//! 직접 호출. 옛에는 매 grpc service 가 core 안에 있었는데 — Library 는
//! Hexagonal port 화하지 않음 (extractor 가 infra-only 라서).
//!
//! 매 source_type 영역 처리 path:
//! - `text` — inline_text 영역 직접 저장 (frontend 영역 textarea 영역)
//! - `txt` / `md` — file_path 영역 read (extract_text_file)
//! - `pdf` — file_path 영역 pdf-extract (extract_pdf, page 영역 매핑 영역)
//! - `url` — source_url 영역 fetch + HTML strip (옛 ReqwestNetworkAdapter 영역 활용 영역, Phase 1.5 영역 — Phase 1 영역 = sysmod_firecrawl 영역 frontend 영역 활용 영역)

use std::path::Path;
use std::sync::Arc;

use tonic::{Request, Response, Status as TonicStatus};

use firebat_core::managers::library::LibraryManager;
use firebat_core::ports::ILlmPort;
use firebat_core::proto::{
    library_service_server::LibraryService, LibraryCreateReferenceRequest,
    LibraryCreateReferenceResponse, LibraryDeleteReferenceRequest, LibraryDeleteReferenceResponse,
    LibraryDeleteSourceRequest, LibraryDeleteSourceResponse, LibraryGetSourceRequest,
    LibraryGetSourceResponse, LibraryHitPb, LibraryListReferencesRequest,
    LibraryListReferencesResponse, LibraryListSourcesRequest, LibraryListSourcesResponse,
    LibraryReextractSourceRequest, LibraryReextractSourceResponse, LibraryReferencePb,
    LibrarySearchRequest, LibrarySearchResponse, LibrarySourcePb, LibraryUploadSourceRequest,
    LibraryUploadSourceResponse,
};

use crate::library::extractor;

/// 중복 업로드 dedup 용 — 파일/텍스트 바이트의 sha256 hex.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

pub struct LibraryServiceImpl {
    manager: Arc<LibraryManager>,
    llm: Arc<dyn ILlmPort>,
}

impl LibraryServiceImpl {
    pub fn new(manager: Arc<LibraryManager>, llm: Arc<dyn ILlmPort>) -> Self {
        Self { manager, llm }
    }

    /// 정밀 추출(vision) — PDF 를 Gemini 가 직접 읽어 LaTeX·레이아웃 보존 텍스트로 추출. pdf-extract 가
    /// 수식·숫자를 망가뜨리던 문제를 우회. quality_boost = Gemini Pro, 아니면 Flash (models.json 단일 소스).
    async fn vision_extract_pdf(&self, file_path: &str, quality_boost: bool) -> Result<String, String> {
        use base64::Engine;
        let bytes = std::fs::read(file_path).map_err(|e| format!("PDF read 실패: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let model = firebat_core::llm::registry::library_extraction_model(quality_boost).to_string();
        let opts = firebat_core::ports::LlmCallOpts {
            model: Some(model),
            image: Some(b64),
            image_mime_type: Some("application/pdf".to_string()),
            max_tokens: Some(32000),
            ..Default::default()
        };
        let prompt = "이 문서(PDF)의 모든 텍스트를 빠짐없이 추출하라. 수식은 LaTeX 로 표기한다 \
            (인라인 $...$, 디스플레이 $$...$$). 표·문항·보기(①②③④⑤ 등)의 구조와 순서를 그대로 \
            보존한다. 페이지 경계는 빈 줄로 구분한다. 설명·머리말·메타 코멘트 없이 추출된 본문만 출력한다.";
        let resp = self.llm.ask_text(prompt, &opts).await?;
        Ok(resp.text)
    }
}

// ─── proto ↔ core struct 변환 (orphan rule — infra 에서 From impl 정의 불가, 직접 함수로) ──

fn ref_to_pb(r: firebat_core::ports::LibraryReference) -> LibraryReferencePb {
    LibraryReferencePb {
        id: r.id,
        name: r.name,
        description: r.description.unwrap_or_default(),
        owner: r.owner,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

fn source_to_pb(s: firebat_core::ports::LibrarySource) -> LibrarySourcePb {
    LibrarySourcePb {
        id: s.id,
        reference_id: s.reference_id,
        name: s.name,
        source_type: s.source_type,
        source_url: s.source_url.unwrap_or_default(),
        file_path: s.file_path.unwrap_or_default(),
        full_text: s.full_text,
        char_count: s.char_count,
        chunk_count: s.chunk_count,
        created_at: s.created_at,
    }
}

fn hit_to_pb(h: firebat_core::ports::LibraryHit) -> LibraryHitPb {
    LibraryHitPb {
        source_id: h.source_id,
        source_name: h.source_name,
        reference_id: h.reference_id,
        reference_name: h.reference_name,
        chunk_id: h.chunk_id,
        chunk_index: h.chunk_index,
        content: h.content,
        page_number: h.page_number,
        score: h.score,
    }
}

#[tonic::async_trait]
impl LibraryService for LibraryServiceImpl {
    async fn create_reference(
        &self,
        req: Request<LibraryCreateReferenceRequest>,
    ) -> Result<Response<LibraryCreateReferenceResponse>, TonicStatus> {
        let args = req.into_inner();
        let owner = if args.owner.is_empty() { "admin" } else { &args.owner };
        let description = if args.description.is_empty() { None } else { Some(args.description.as_str()) };
        let id = self
            .manager
            .create_reference(&args.name, description, owner)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryCreateReferenceResponse { id }))
    }

    async fn list_references(
        &self,
        req: Request<LibraryListReferencesRequest>,
    ) -> Result<Response<LibraryListReferencesResponse>, TonicStatus> {
        let args = req.into_inner();
        let owner = if args.owner.is_empty() { "admin" } else { &args.owner };
        let refs = self
            .manager
            .list_references(owner)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryListReferencesResponse {
            references: refs.into_iter().map(ref_to_pb).collect(),
        }))
    }

    async fn delete_reference(
        &self,
        req: Request<LibraryDeleteReferenceRequest>,
    ) -> Result<Response<LibraryDeleteReferenceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_reference(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryDeleteReferenceResponse {}))
    }

    async fn upload_source(
        &self,
        req: Request<LibraryUploadSourceRequest>,
    ) -> Result<Response<LibraryUploadSourceResponse>, TonicStatus> {
        let args = req.into_inner();
        // 매 source_type 별 추출 path 분기:
        //  - "text" — inline_text 직접
        //  - "txt" / "md" — file_path read
        //  - "pdf" — file_path pdf-extract
        //  - "url" — source_url fetch (Phase 1.5) — 현재 = inline_text 만 (frontend 에서 fetch + strip 처리)
        let (extracted_text, page_numbers): (String, Option<Vec<(usize, usize, usize)>>) =
            if args.precise && args.source_type == "pdf" {
                // 정밀 추출 (vision) — Gemini 가 PDF 직접 읽어 LaTeX·레이아웃 보존. page char-매핑 없음(None).
                let text = self
                    .vision_extract_pdf(&args.file_path, args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("정밀 추출 실패: {e}")))?;
                (text, None)
            } else {
                match args.source_type.as_str() {
                    "text" | "url" => (args.inline_text.clone(), None),
                    "txt" | "md" => {
                        let result = extractor::extract_text_file(Path::new(&args.file_path))
                            .map_err(|e| TonicStatus::invalid_argument(format!("text 추출 실패: {e}")))?;
                        (result.full_text, result.pages)
                    }
                    "pdf" => {
                        let result = extractor::extract_pdf(Path::new(&args.file_path))
                            .map_err(|e| TonicStatus::invalid_argument(format!("PDF 추출 실패: {e}")))?;
                        (result.full_text, result.pages)
                    }
                    other => {
                        return Err(TonicStatus::invalid_argument(format!(
                            "지원되지 않는 source_type: {other}"
                        )));
                    }
                }
            };

        let source_url_opt = if args.source_url.is_empty() { None } else { Some(args.source_url.as_str()) };

        // 원본 영구 보관 — 업로드 임시 파일을 data/library/originals/ 로 복사. 재추출(정밀/비전 포함) 시
        // 재업로드·중복 없이 보관본으로 재실행하기 위함. text/url 은 파일 없음. 복사 실패해도 추출은 계속.
        // 임시파일명(Node 가 부여한 uuid.<ext>)을 그대로 써 별도 id 생성 의존성 0.
        let persistent_path: Option<String> =
            if matches!(args.source_type.as_str(), "pdf" | "txt" | "md") && !args.file_path.is_empty() {
                let dir = Path::new("data/library/originals");
                let _ = std::fs::create_dir_all(dir);
                let fname = Path::new(&args.file_path)
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("source.{}", args.source_type));
                let dest = dir.join(&fname);
                match std::fs::copy(&args.file_path, &dest) {
                    Ok(_) => Some(dest.to_string_lossy().to_string()),
                    Err(e) => {
                        tracing::warn!(category = "library", "원본 보관 실패 (추출은 계속): {e}");
                        None
                    }
                }
            } else {
                None
            };
        let file_path_opt = persistent_path.as_deref();

        // 중복 dedup — 파일은 바이트, text/url 은 inline_text 의 sha256. 같은 reference 에 동일 내용이
        // 이미 있으면 새로 만들지 않고 기존 반환 (deduped=true). 못 읽으면 hash=None → dedup 생략.
        let content_hash: Option<String> = if !args.file_path.is_empty() {
            std::fs::read(&args.file_path).ok().map(|b| sha256_hex(&b))
        } else if !args.inline_text.is_empty() {
            Some(sha256_hex(args.inline_text.as_bytes()))
        } else {
            None
        };
        if let Some(h) = &content_hash {
            if let Ok(Some(existing)) = self.manager.find_source_by_hash(&args.reference_id, h).await {
                return Ok(Response::new(LibraryUploadSourceResponse {
                    source_id: existing.id,
                    chunk_count: existing.chunk_count,
                    deduped: true,
                }));
            }
        }

        let source_id = self
            .manager
            .upload_source(
                &args.reference_id,
                &args.name,
                &args.source_type,
                source_url_opt,
                file_path_opt,
                &extracted_text,
                page_numbers.as_deref(),
                content_hash.as_deref(),
            )
            .await
            .map_err(TonicStatus::internal)?;

        // chunk_count 채우기 위해 get_source 한 번 더 read.
        let source = self
            .manager
            .get_source(&source_id)
            .await
            .map_err(TonicStatus::internal)?;
        let chunk_count = source.map(|s| s.chunk_count).unwrap_or(0);

        Ok(Response::new(LibraryUploadSourceResponse {
            source_id,
            chunk_count,
            deduped: false,
        }))
    }

    async fn list_sources(
        &self,
        req: Request<LibraryListSourcesRequest>,
    ) -> Result<Response<LibraryListSourcesResponse>, TonicStatus> {
        let reference_id = req.into_inner().reference_id;
        let sources = self
            .manager
            .list_sources(&reference_id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryListSourcesResponse {
            sources: sources.into_iter().map(source_to_pb).collect(),
        }))
    }

    async fn get_source(
        &self,
        req: Request<LibraryGetSourceRequest>,
    ) -> Result<Response<LibraryGetSourceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        let source = self
            .manager
            .get_source(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryGetSourceResponse {
            source: source.map(source_to_pb),
        }))
    }

    async fn delete_source(
        &self,
        req: Request<LibraryDeleteSourceRequest>,
    ) -> Result<Response<LibraryDeleteSourceResponse>, TonicStatus> {
        let id = req.into_inner().id;
        self.manager
            .delete_source(&id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryDeleteSourceResponse {}))
    }

    async fn reextract_source(
        &self,
        req: Request<LibraryReextractSourceRequest>,
    ) -> Result<Response<LibraryReextractSourceResponse>, TonicStatus> {
        let args = req.into_inner();
        // 1. 기존 source 조회
        let source = self
            .manager
            .get_source(&args.source_id)
            .await
            .map_err(TonicStatus::internal)?
            .ok_or_else(|| TonicStatus::not_found("source 를 찾을 수 없습니다."))?;
        // 2. 원본 파일 존재 체크 — persist 이전 자료 / 사용자 삭제 시 명확한 에러 (재업로드 안내).
        let file_path = source.file_path.clone().unwrap_or_default();
        if file_path.is_empty() || !Path::new(&file_path).exists() {
            return Err(TonicStatus::failed_precondition(
                "원본 파일이 서버에 없습니다. 자료를 삭제 후 다시 업로드해 주세요.",
            ));
        }
        // 3. 재추출 — precise+pdf 면 vision, 아니면 기존 pdf-extract / text.
        let (extracted_text, page_numbers): (String, Option<Vec<(usize, usize, usize)>>) =
            if args.precise && source.source_type == "pdf" {
                let text = self
                    .vision_extract_pdf(&file_path, args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("정밀 추출 실패: {e}")))?;
                (text, None)
            } else {
                match source.source_type.as_str() {
                    "txt" | "md" => {
                        let r = extractor::extract_text_file(Path::new(&file_path))
                            .map_err(|e| TonicStatus::invalid_argument(format!("text 추출 실패: {e}")))?;
                        (r.full_text, r.pages)
                    }
                    "pdf" => {
                        let r = extractor::extract_pdf(Path::new(&file_path))
                            .map_err(|e| TonicStatus::invalid_argument(format!("PDF 추출 실패: {e}")))?;
                        (r.full_text, r.pages)
                    }
                    other => {
                        return Err(TonicStatus::invalid_argument(format!(
                            "재추출 미지원 타입: {other}"
                        )));
                    }
                }
            };
        // 4. 같은 id 로 청크 교체.
        let content_hash = std::fs::read(&file_path).ok().map(|b| sha256_hex(&b));
        let chunk_count = self
            .manager
            .reextract_source(
                &source.id,
                &source.reference_id,
                &source.name,
                &source.source_type,
                source.source_url.as_deref(),
                Some(file_path.as_str()),
                &extracted_text,
                page_numbers.as_deref(),
                content_hash.as_deref(),
            )
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryReextractSourceResponse {
            chunk_count: chunk_count as i64,
        }))
    }

    async fn search(
        &self,
        req: Request<LibrarySearchRequest>,
    ) -> Result<Response<LibrarySearchResponse>, TonicStatus> {
        let args = req.into_inner();
        let owner = if args.owner.is_empty() { "admin" } else { &args.owner };
        let top_k = if args.top_k <= 0 { 5 } else { args.top_k as usize };
        let hits = self
            .manager
            .search(owner, &args.reference_ids, &args.query, top_k)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibrarySearchResponse {
            hits: hits.into_iter().map(hit_to_pb).collect(),
        }))
    }
}

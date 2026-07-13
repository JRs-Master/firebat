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

/// 이미지 source_type 인지 — 이미지는 텍스트 레이어가 없어 vision(Gemini)으로만 추출.
fn is_image_type(t: &str) -> bool {
    matches!(t, "png" | "jpg" | "jpeg" | "webp" | "gif")
}

/// 업로드/재업로드 임시 파일을 `data/library/originals/` 로 영구 보관 (재파싱용 원본).
/// 임시파일명(Node 가 부여한 uuid.<ext>)을 그대로 써 별도 id 생성 의존성 0. 복사 실패 = None
/// (추출은 계속 — 보관만 못 한 상태, upload/reextract 공유 규약).
fn persist_original(src_path: &str, source_type: &str) -> Option<String> {
    let dir = Path::new("data/library/originals");
    let _ = std::fs::create_dir_all(dir);
    let fname = Path::new(src_path)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("source.{source_type}"));
    let dest = dir.join(&fname);
    match std::fs::copy(src_path, &dest) {
        Ok(_) => Some(dest.to_string_lossy().to_string()),
        Err(e) => {
            tracing::warn!(category = "library", "original file archive failed (extraction continues): {e}");
            None
        }
    }
}

/// 이미지 source_type → MIME (Gemini vision inlineData 용).
fn image_mime(t: &str) -> &'static str {
    match t {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    }
}

pub struct LibraryServiceImpl {
    manager: Arc<LibraryManager>,
    llm: Arc<dyn ILlmPort>,
    /// Upstage Document Parse ("solar" parse provider) API key lookup.
    vault: Arc<dyn firebat_core::ports::IVaultPort>,
}

impl LibraryServiceImpl {
    pub fn new(
        manager: Arc<LibraryManager>,
        llm: Arc<dyn ILlmPort>,
        vault: Arc<dyn firebat_core::ports::IVaultPort>,
    ) -> Self {
        Self { manager, llm, vault }
    }

    /// "solar" provider — Upstage Document Parse. Key = vault `system:upstage:api-key`
    /// (the same key the embedder swap uses).
    async fn solar_parse(
        &self,
        file_path: &str,
    ) -> Result<(String, Option<Vec<(usize, usize, usize)>>), String> {
        let key = self
            .vault
            .get_secret("system:upstage:api-key")
            .filter(|k| !k.is_empty())
            .ok_or_else(|| "Upstage API 키가 등록되어 있지 않습니다 (설정 → AI → LLM 공급자 키).".to_string())?;
        crate::library::upstage_parse::parse_document(&key, file_path).await
    }

    /// hub owner scoping — owner 지정 시 reference_id 가 그 owner 소유일 때만 통과. admin(None) 무검사.
    /// 미소유 = 권한 거부. 프론트(hub library route) ensureRefOwnership 대신 core 단일 강제.
    async fn ensure_ref_owner(&self, reference_id: &str, owner: &Option<String>) -> Result<(), TonicStatus> {
        let Some(o) = owner.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        match self.manager.is_reference_owned(reference_id, o).await {
            Ok(true) => Ok(()),
            Ok(false) => Err(TonicStatus::permission_denied(
                "이 reference 에 접근할 권한이 없습니다.",
            )),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    /// source id-op owner scoping — source 의 reference 가 owner 소유일 때만 통과 (간접).
    async fn ensure_source_owner(&self, source_id: &str, owner: &Option<String>) -> Result<(), TonicStatus> {
        if owner.as_deref().filter(|s| !s.is_empty()).is_none() {
            return Ok(());
        }
        match self.manager.get_source(source_id).await {
            Ok(Some(s)) => self.ensure_ref_owner(&s.reference_id, owner).await,
            Ok(None) => Err(TonicStatus::not_found("source 를 찾을 수 없습니다.")),
            Err(e) => Err(TonicStatus::internal(e)),
        }
    }

    /// 정밀/비전 추출 — 파일(PDF 또는 이미지)을 Gemini 가 직접 읽어 LaTeX·레이아웃 보존 텍스트로 추출.
    /// pdf-extract 가 수식·숫자를 망가뜨리던 문제 우회 + 이미지(스캔 기출·사진 등) OCR 겸용.
    /// quality_boost = Gemini Pro, 아니면 Flash (models.json 단일 소스). mime = application/pdf 또는 image/*.
    async fn vision_extract(&self, file_path: &str, mime: &str, quality_boost: bool) -> Result<String, String> {
        use base64::Engine;
        let bytes = std::fs::read(file_path).map_err(|e| format!("파일 read 실패: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let model = firebat_core::llm::registry::library_extraction_model(quality_boost).to_string();
        let opts = firebat_core::ports::LlmCallOpts {
            model: Some(model),
            image: Some(b64),
            image_mime_type: Some(mime.to_string()),
            max_tokens: Some(32000),
            ..Default::default()
        };
        // 추출 프롬프트 = system/prompts/library_extraction.md (단일 영어, prompt_store) — 재빌드 없이 튜닝.
        let prompt = firebat_core::prompt_store::get("library_extraction");
        let resp = self.llm.ask_text(&prompt, &opts).await?;
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
        let args = req.into_inner();
        self.ensure_ref_owner(&args.id, &args.owner).await?;
        self.manager
            .delete_reference(&args.id)
            .await
            .map_err(TonicStatus::internal)?;
        Ok(Response::new(LibraryDeleteReferenceResponse {}))
    }

    async fn upload_source(
        &self,
        req: Request<LibraryUploadSourceRequest>,
    ) -> Result<Response<LibraryUploadSourceResponse>, TonicStatus> {
        let args = req.into_inner();
        self.ensure_ref_owner(&args.reference_id, &args.owner).await?;
        // 매 source_type 별 추출 path 분기:
        //  - "text" — inline_text 직접
        //  - "txt" / "md" — file_path read
        //  - "pdf" — file_path pdf-extract
        //  - "url" — source_url fetch (Phase 1.5) — 현재 = inline_text 만 (frontend 에서 fetch + strip 처리)
        // parse_provider 스위치 — "" = 레거시(precise/quality_boost 그대로) / "solar" = Upstage
        // Document Parse / "gemini" = vision 강제 / "none" = 로컬 추출 강제. 실패 = 명시 에러
        // (자동 폴백 X — 사용자가 고른 프로바이더).
        let provider = args.parse_provider.as_str();
        let (extracted_text, page_numbers): (String, Option<Vec<(usize, usize, usize)>>) =
            if args.source_type == "text" || args.source_type == "url" {
                (args.inline_text.clone(), None)
            } else if provider == "solar" {
                self.solar_parse(&args.file_path)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("Solar 파싱 실패: {e}")))?
            } else if provider == "gemini" && args.source_type == "pdf" {
                let text = self
                    .vision_extract(&args.file_path, "application/pdf", args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("Gemini 파싱 실패: {e}")))?;
                (text, None)
            } else if provider == "gemini" && !is_image_type(&args.source_type) {
                // Gemini vision 은 PDF·이미지 전용 — office 문서는 solar 또는 로컬 추출을 사용.
                return Err(TonicStatus::invalid_argument(
                    "Gemini 파싱은 PDF·이미지 전용입니다. 이 파일 형식은 Solar 또는 기본(로컬) 파싱을 사용해 주세요.",
                ));
            } else if is_image_type(&args.source_type) {
                // 이미지 — 텍스트 레이어가 없어 vision(Gemini)으로만 추출 (스캔 기출·사진 OCR).
                let text = self
                    .vision_extract(&args.file_path, image_mime(&args.source_type), args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("이미지 추출 실패: {e}")))?;
                (text, None)
            } else if provider.is_empty() && args.precise && args.source_type == "pdf" {
                // 레거시 정밀 추출 (vision) — Gemini 가 PDF 직접 읽어 LaTeX·레이아웃 보존.
                let text = self
                    .vision_extract(&args.file_path, "application/pdf", args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("정밀 추출 실패: {e}")))?;
                (text, None)
            } else {
                // 텍스트 추출 가능 포맷 — pdf-extract / ZIP+XML(office·한글신형·odf) / calamine(스프레드시트).
                let p = Path::new(&args.file_path);
                let result = match args.source_type.as_str() {
                    "txt" | "md" | "csv" => extractor::extract_text_file(p),
                    "pdf" => extractor::extract_pdf(p),
                    "docx" => extractor::extract_docx(p),
                    "pptx" => extractor::extract_pptx(p),
                    "hwpx" => extractor::extract_hwpx(p),
                    "odt" => extractor::extract_odt(p),
                    "odp" => extractor::extract_odp(p),
                    "xlsx" | "xls" | "ods" => extractor::extract_spreadsheet(p),
                    other => {
                        return Err(TonicStatus::invalid_argument(format!(
                            "지원되지 않는 source_type: {other}"
                        )));
                    }
                }
                .map_err(|e| {
                    TonicStatus::invalid_argument(format!("{} 추출 실패: {e}", args.source_type))
                })?;
                (result.full_text, result.pages)
            };

        let source_url_opt = if args.source_url.is_empty() { None } else { Some(args.source_url.as_str()) };

        // 원본 영구 보관 — 업로드 임시 파일을 data/library/originals/ 로 복사. 재추출(정밀/비전 포함) 시
        // 재업로드·중복 없이 보관본으로 재실행하기 위함. text/url 은 파일 없음.
        let persistent_path: Option<String> = if !args.file_path.is_empty() {
            persist_original(&args.file_path, &args.source_type)
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
        // dedup 결정·인덱싱은 manager(Core) — infra 는 해시 계산(파일 I/O)만 + 결과 매핑.
        let outcome = self
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

        Ok(Response::new(LibraryUploadSourceResponse {
            source_id: outcome.source_id,
            chunk_count: outcome.chunk_count,
            deduped: outcome.deduped,
        }))
    }

    async fn list_sources(
        &self,
        req: Request<LibraryListSourcesRequest>,
    ) -> Result<Response<LibraryListSourcesResponse>, TonicStatus> {
        let args = req.into_inner();
        self.ensure_ref_owner(&args.reference_id, &args.owner).await?;
        let sources = self
            .manager
            .list_sources(&args.reference_id)
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
        let args = req.into_inner();
        self.ensure_source_owner(&args.id, &args.owner).await?;
        let source = self
            .manager
            .get_source(&args.id)
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
        let args = req.into_inner();
        self.ensure_source_owner(&args.id, &args.owner).await?;
        self.manager
            .delete_source(&args.id)
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
        // 2. 원본 경로 결정 — new_file_path(재업로드 임시 파일)가 오면 originals/ 로 보관 후 그걸로
        //    교체(영구 보관 이전 자료·서버 초기화로 원본 유실 케이스의 복구 경로 — file_path 도 갱신).
        //    없으면 보관본 사용, 보관본도 없으면 프론트가 재업로드 플로우로 잇는 에러
        //    ("원본 파일이 서버에 없습니다" — LibraryReferenceDetail 이 이 문구로 감지, 문구 계약).
        let (file_path, db_file_path): (String, Option<String>) = if !args.new_file_path.is_empty() {
            if !Path::new(&args.new_file_path).exists() {
                return Err(TonicStatus::invalid_argument("재업로드 파일을 읽을 수 없습니다."));
            }
            let persisted = persist_original(&args.new_file_path, &source.source_type);
            // 보관 실패 시에도 임시 파일로 추출은 진행 — 단 임시 경로를 DB 에 남기지 않는다(곧 삭제됨).
            (
                persisted.clone().unwrap_or_else(|| args.new_file_path.clone()),
                persisted,
            )
        } else {
            let p = source.file_path.clone().unwrap_or_default();
            if p.is_empty() || !Path::new(&p).exists() {
                return Err(TonicStatus::failed_precondition(
                    "원본 파일이 서버에 없습니다. 파일을 다시 업로드해 주세요.",
                ));
            }
            (p.clone(), Some(p))
        };
        // 3. 재추출 — parse_provider 스위치(upload_source 와 동일 규약): "" 레거시 /
        // "solar" Upstage Document Parse / "gemini" vision(PDF 전용) / "none" 로컬 강제.
        let provider = args.parse_provider.as_str();
        let (extracted_text, page_numbers): (String, Option<Vec<(usize, usize, usize)>>) =
            if provider == "solar" {
                self.solar_parse(&file_path)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("Solar 파싱 실패: {e}")))?
            } else if provider == "gemini" && source.source_type == "pdf" {
                let text = self
                    .vision_extract(&file_path, "application/pdf", args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("Gemini 파싱 실패: {e}")))?;
                (text, None)
            } else if provider == "gemini" && !is_image_type(&source.source_type) {
                return Err(TonicStatus::invalid_argument(
                    "Gemini 파싱은 PDF·이미지 전용입니다. 이 파일 형식은 Solar 또는 기본(로컬) 파싱을 사용해 주세요.",
                ));
            } else if is_image_type(&source.source_type) {
                let text = self
                    .vision_extract(&file_path, image_mime(&source.source_type), args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("이미지 추출 실패: {e}")))?;
                (text, None)
            } else if provider.is_empty() && args.precise && source.source_type == "pdf" {
                let text = self
                    .vision_extract(&file_path, "application/pdf", args.quality_boost)
                    .await
                    .map_err(|e| TonicStatus::invalid_argument(format!("정밀 추출 실패: {e}")))?;
                (text, None)
            } else {
                let p = Path::new(&file_path);
                let r = match source.source_type.as_str() {
                    "txt" | "md" | "csv" => extractor::extract_text_file(p),
                    "pdf" => extractor::extract_pdf(p),
                    "docx" => extractor::extract_docx(p),
                    "pptx" => extractor::extract_pptx(p),
                    "hwpx" => extractor::extract_hwpx(p),
                    "odt" => extractor::extract_odt(p),
                    "odp" => extractor::extract_odp(p),
                    "xlsx" | "xls" | "ods" => extractor::extract_spreadsheet(p),
                    other => {
                        return Err(TonicStatus::invalid_argument(format!(
                            "재추출 미지원 타입: {other}"
                        )));
                    }
                }
                .map_err(|e| {
                    TonicStatus::invalid_argument(format!("{} 추출 실패: {e}", source.source_type))
                })?;
                (r.full_text, r.pages)
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
                db_file_path.as_deref(),
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

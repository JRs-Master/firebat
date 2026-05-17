//! LibraryServiceImpl — Library Phase 1 (2026-05-17) 의 gRPC 영역.
//!
//! infra 영역 박은 사유 — UploadSource RPC 영역 = pdf-extract / extract_text_file / extract_html
//! 영역 직접 호출 영역. 옛 영역 매 grpc service 영역 = core 영역 박혀있는데 — Library 영역 =
//! Hexagonal port 영역 박지 마 (extractor 영역 = infra-only 영역).
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
use firebat_core::proto::{
    library_service_server::LibraryService, LibraryCreateReferenceRequest,
    LibraryCreateReferenceResponse, LibraryDeleteReferenceRequest, LibraryDeleteReferenceResponse,
    LibraryDeleteSourceRequest, LibraryDeleteSourceResponse, LibraryGetSourceRequest,
    LibraryGetSourceResponse, LibraryHitPb, LibraryListReferencesRequest,
    LibraryListReferencesResponse, LibraryListSourcesRequest, LibraryListSourcesResponse,
    LibraryReferencePb, LibrarySearchRequest, LibrarySearchResponse, LibrarySourcePb,
    LibraryUploadSourceRequest, LibraryUploadSourceResponse,
};

use crate::library::extractor;

pub struct LibraryServiceImpl {
    manager: Arc<LibraryManager>,
}

impl LibraryServiceImpl {
    pub fn new(manager: Arc<LibraryManager>) -> Self {
        Self { manager }
    }
}

// ─── proto ↔ core struct 변환 (orphan rule 영역 — infra 영역에서 From impl 박지 X, 직접 함수 영역) ──

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
        //  - "url" — source_url fetch (Phase 1.5 영역) — 현재 = inline_text 영역 만 (frontend 영역에서 fetch + strip 박은 영역)
        let (extracted_text, page_numbers): (String, Option<Vec<(usize, usize, usize)>>) =
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
            };

        let source_url_opt = if args.source_url.is_empty() { None } else { Some(args.source_url.as_str()) };
        let file_path_opt = if args.file_path.is_empty() { None } else { Some(args.file_path.as_str()) };

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
            )
            .await
            .map_err(TonicStatus::internal)?;

        // chunk_count 영역 = get_source 영역 한 번 더 (or 매니저 반환 영역 박은 영역) — 단순 영역 한 번 더 read
        let source = self
            .manager
            .get_source(&source_id)
            .await
            .map_err(TonicStatus::internal)?;
        let chunk_count = source.map(|s| s.chunk_count).unwrap_or(0);

        Ok(Response::new(LibraryUploadSourceResponse {
            source_id,
            chunk_count,
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

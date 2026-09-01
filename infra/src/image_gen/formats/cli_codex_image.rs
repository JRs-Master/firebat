//! Codex CLI 이미지 생성 — 내장 `image_gen` 도구 (구독 기반, gpt-image-2 native).
//!
//! `codex exec --json --skip-git-repo-check "$imagegen <prompt>"` spawn → 프로세스 종료 후
//! **`$CODEX_HOME/generated_images/` 에서 산출 파일 수확**.
//!
//! **stdout 파싱을 안 쓰는 이유**(2026-07-27 서버 실측): 내장 도구는 이벤트 스트림에 이미지
//! 바이트를 싣지 않고 파일로만 저장한다 — codex 내장 imagegen 스킬이 문서화한 계약
//! ("In built-in tool mode, Codex saves generated images under `$CODEX_HOME/*` by default" /
//! "move or copy the selected output from `$CODEX_HOME/generated_images/...`"). 옛 구현은 stdout
//! 에서 base64·path 를 찾는 3패턴이라 매칭이 원리적으로 불가능했고, 그래서 생성이 성공해도
//! 타임아웃까지 기다렸다가 실패했다(제주 4장 요청 = 정확히 300초 후 `bytes: 0` 에러 레코드).
//!
//! 원래 그 이동은 codex 가 자기 쉘로 하지만 우리 config 는 `shell_tool = false` + read-only
//! sandbox 라 codex 쪽 배달 수단이 없다 → 호스트가 거둔다.
//!
//! cost_usd None (구독 포함).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

use crate::image_gen::format_handler::{ImageFormatHandler, ImageFormatHandlerContext};
use crate::llm::formats::cli_codex::{copy_auth_json, extract_image_prompt, harvest_generated_images};
use firebat_core::ports::{ImageGenCallOpts, ImageGenOpts, ImageGenResult, InfraResult};

/// How long to wait for one image. Not a provider limit — ours.
///
/// A plain single image lands in 60~90s, which is what 420 was sized for. A harder ask does not:
/// measured 2026-08-30, an eight-frame animation sheet and a reference-guided sheet both finished
/// AFTER we gave up, and the finished PNGs were still sitting in `generated_images` when the user
/// asked whether the file had actually arrived. We had reported failure and thrown the work away.
///
/// Waiting longer costs nothing here. The caller is never blocked — `start_generate` hands back a
/// placeholder slug immediately and this runs in the background — so the only thing a short timeout
/// buys is discarding results that were about to exist.
const CODEX_TIMEOUT: Duration = Duration::from_secs(1500);

/// Deletes the reference image we handed to the CLI once the run is over.
struct TempFile(std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 산출 파일 폴링 주기 / 크기 안정 확인 간격(쓰는 중 truncated read 방지).
const HARVEST_POLL: Duration = Duration::from_millis(1000);
const HARVEST_SETTLE: Duration = Duration::from_millis(700);

/// A run that has written nothing for this long is wedged, not slow.
///
/// `CODEX_TIMEOUT` measures total time, and a wedged run is indistinguishable from a slow one
/// until it has cost all 1500 seconds — with the run lock held, so nothing else generates either.
/// Measured 2026-08-31, four runs in one afternoon: each froze about fourteen seconds in, the
/// session rollout stopped growing and never resumed, the socket sat in CLOSE-WAIT with 101 unread
/// bytes and the process slept on `futex_do_wait`. The answer had arrived and codex was not reading
/// it. None produced an image and none recovered.
///
/// So watch progress, not the clock. Successful runs write continuously and finish in 62~70s; five
/// quiet minutes has never been part of one. The total cap stays as it is — it measures a different
/// thing (a slow run that will still land), and shortening THAT is what threw away finished images
/// on 2026-08-30.
const STALL_TIMEOUT: Duration = Duration::from_secs(300);
const STALL_POLL: Duration = Duration::from_secs(5);

/// One retry, because the wedge is per-connection: the next spawn gets a new socket.
const MAX_ATTEMPTS: u32 = 2;

/// How long to keep waiting for the NEXT picture of a multi-image run once one has landed.
///
/// The harvest used to return the moment any file was stable, which is right when one picture was
/// ever asked for and wrong the moment `count` shipped: the kill that follows lands on a codex
/// that is mid-turn. Measured 2026-09-02 on a two-image request — variant 1 finished at 36.9s,
/// codex said "generating the second", and the rollout ends with
/// `turn_aborted / reason: interrupted` at 51.4s. We interrupted it, and the unfilled reservation
/// was reported to the operator as the generator returning fewer pictures than were asked for.
///
/// A picture takes 40~60s, so this is the gap that says "no more are coming" rather than "the next
/// one is still drawing". Waiting out `CODEX_TIMEOUT` instead would hold the run lock for 25
/// minutes every time the model decides one is enough.
const MULTI_GRACE: Duration = Duration::from_secs(150);

/// How much of the child's stderr to keep for a failure message.
const STDERR_TAIL_MAX: usize = 8192;

/// Keep the last `STDERR_TAIL_MAX` bytes of the child's stderr, dropping WHOLE LINES.
///
/// Never a byte offset. Trimming this by length took the service down twice on 2026-08-31:
/// codex echoes the prompt into its own tracing output, the prompt is Korean, and
/// `String::drain` to a byte index that lands inside a character panics — which aborts the
/// process. It only fires past the cap, so it fires on exactly the verbose runs the drain
/// was added for.
fn push_tail(tail: &mut std::collections::VecDeque<String>, held: &mut usize, line: String) {
    *held += line.len() + 1;
    tail.push_back(line);
    while *held > STDERR_TAIL_MAX && tail.len() > 1 {
        if let Some(gone) = tail.pop_front() {
            *held -= gone.len() + 1;
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Newest write anywhere under `dir`, in millis since the epoch (0 = nothing there).
///
/// The session rollout takes one jsonl line per event, so its mtime advances for as long as the run
/// is doing anything at all — which is the signal a wedged run stops producing.
fn newest_write_ms(dir: &Path) -> u64 {
    let mut best = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            best = best.max(newest_write_ms(&entry.path()));
        } else if let Some(ms) = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        {
            best = best.max(ms.as_millis() as u64);
        }
    }
    best
}

/// 실행이 어떻게 끝났나 — 에러 메시지 문맥 + 재수확 여부 결정.
enum RunEnd {
    /// 산출 파일을 먼저 건져 조기 종료(정상 경로).
    Harvested(Vec<PathBuf>),
    /// codex 가 스스로 끝남. 마지막 stdout 줄들(진단용).
    Exited(Vec<String>),
    TimedOut,
    /// 살아 있는데 아무것도 안 쓴다 — codex 안쪽 교착. 재시도 대상.
    Stalled,
}

/// 파일별 크기 — 두 번 찍어 같으면 쓰기 완료로 본다.
fn file_sizes(paths: &[PathBuf]) -> Vec<u64> {
    paths
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .collect()
}

pub struct CliCodexImageFormat;

impl CliCodexImageFormat {
    pub fn new() -> Self {
        Self
    }

    /// 이미지 전용 CODEX_HOME 준비 — auth 복사 + 최소 config.toml.
    /// MCP 서버는 등록하지 않는다(이미지 생성에 Firebat 도구 불필요 = 표면 최소).
    fn ensure_image_codex_home() -> Option<PathBuf> {
        let codex_home = crate::llm::formats::cli_codex::codex_home_base().join("image");
        std::fs::create_dir_all(&codex_home).ok()?;
        copy_auth_json(&codex_home);

        // 비대화형이라 승인 불가 → never. sandbox read-only + 쉘 차단 = LLM 경로와 같은 자세
        // (산출물은 우리가 파일로 거두므로 codex 에 쓰기 권한을 줄 이유가 없다).
        let toml = concat!(
            "approval_policy = \"never\"\n",
            "sandbox_mode = \"read-only\"\n",
            "web_search = \"disabled\"\n",
            "\n",
            "[features]\nshell_tool = false\n",
        );
        std::fs::write(codex_home.join("config.toml"), toml).ok()?;
        Some(codex_home)
    }
}

impl Default for CliCodexImageFormat {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ImageFormatHandler for CliCodexImageFormat {
    async fn generate(
        &self,
        opts: &ImageGenOpts,
        _call_opts: &ImageGenCallOpts,
        _ctx: ImageFormatHandlerContext<'_>,
    ) -> InfraResult<ImageGenResult> {
        // $imagegen 명시적 호출 + size/quality 는 프롬프트로 (Codex CLI 구조화 flag 미지원)
        let size_hint = match opts.size.as_deref() {
            Some(s) if s != "auto" => format!(" size:{}", s),
            _ => String::new(),
        };
        let quality_hint = match opts.quality.as_deref() {
            Some(q) => format!(" quality:{}", q),
            _ => String::new(),
        };
        // "정확히 1장" 고정 — 이 포트는 1 호출 = 1 이미지 계약(openai-image·gemini 와 동일)이고,
        // 프롬프트에 장수가 섞여 들어오면 codex 가 순차로 N 번 호출해 시간만 N 배가 된다.
        // How many, said once and exactly. A set that has to look like each other -
        // the parts of one animation cycle - has to be drawn in one call, because
        // separate calls redraw the character from scratch every time.
        let want = opts.n.unwrap_or(1).clamp(1, 8) as usize;
        let count_line = if want == 1 {
            "Generate exactly one image.".to_string()
        } else {
            format!("Generate exactly {want} images, all in this one turn.")
        };
        let prompt = format!(
            "$imagegen {}{}{}\n\n{}",
            opts.prompt, size_hint, quality_hint, count_line
        );

        // One codex image run at a time.
        //
        // Every run shares one CODEX_HOME, the harvest is the whole `generated_images` tree filtered
        // by "newer than this run started", and the adapter deletes everything it harvested. That is
        // correct while runs are sequential and wrong the moment two overlap: each sees the other's
        // output, `harvested.last()` can be the OTHER request's picture, and whichever finishes
        // first deletes the other's file.
        //
        // Measured 2026-08-30 — two image_gen calls ten seconds apart: the second read its image at
        // .728 and cleaned up, the first read at .731 and got ENOENT. That failure was the lucky
        // shape. The silent one is returning the other request's image, which nothing downstream
        // could detect.
        //
        // Serialising restores the assumption the watermark already makes rather than adding a
        // second mechanism beside it. A run is ~50s and generations are not a throughput path.
        static RUN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _run_guard = RUN_LOCK.lock().await;

        // Preparing the home belongs INSIDE the lock, not before it.
        //
        // It rewrites this home's `auth.json` and `config.toml`, and the running child is
        // reading both. Four requests arriving together each prepared the home while the
        // first one's codex was live: measured 2026-08-30, run A finished in 62s and run
        // B then sat for sixteen minutes without writing a single line to its rollout —
        // codex never got started at all. Refresh tokens are single-use (see
        // `copy_auth_json` below), so a copy landing under a live process is exactly the
        // way to strand the next one on a token nobody can use.
        //
        // The lock was put here to stop two runs harvesting each other's pictures. The
        // preparation was left outside it, which meant the lock did not cover the thing
        // it was named for: one run at a time.
        let codex_home = Self::ensure_image_codex_home();
        // 수확 워터마크 — spawn 직전. 이전 실행 잔여물 재수확 차단.
        let started_at = SystemTime::now();

        // 플래그 = `--json --skip-git-repo-check` 만 (LLM 경로 `cli_codex.rs` 와 동일 base_flags).
        // 옛 `--output-format stream-json` 은 신버전 codex exec 에서 제거돼 exit 2 로 죽는다
        // (2026-07-23 실측). spawn 지점이 둘이면 둘 다 갱신할 것.
        // Reference image (image-to-image). The CLI takes `--image <path>` and the chat adapter
        // beside this one has been passing attachments that way all along — this handler simply
        // never wired it, and a comment on the port said "Codex CLI: 미지원", which reads as a
        // provider limit rather than a missing edge. Four reference-guided runs were spent on that
        // sentence before anyone opened the file it was describing (2026-08-30).
        let mut ref_tmp: Option<std::path::PathBuf> = None;
        if let Some(r) = &opts.reference_image {
            let ext = match r.content_type.as_str() {
                "image/jpeg" | "image/jpg" => "jpg",
                "image/webp" => "webp",
                _ => "png",
            };
            let path = std::env::temp_dir().join(format!(
                "firebat-imgref-{}.{ext}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::write(&path, &r.binary)
                .map_err(|e| format!("참조 이미지 임시 저장 실패 ({}): {e}", path.display()))?;
            ref_tmp = Some(path);
        }

        let mut cmd = Command::new("codex");
        cmd.arg("exec")
            .arg("--json")
            .arg("--skip-git-repo-check")
            .arg(&prompt);
        if let Some(p) = &ref_tmp {
            cmd.arg("--image").arg(p);
        }
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(home) = &codex_home {
            cmd.env("CODEX_HOME", home);
        }
        // The temp file outlives the spawn and is removed when this scope ends.
        let _ref_guard = ref_tmp.map(TempFile);

        // One attempt, then one retry if it wedges. The wedge is per-connection — the socket is
        // left in CLOSE-WAIT with the answer unread — so the next spawn is not the same coin.
        let mut end = RunEnd::Stalled;
        let mut stderr_task: Option<tokio::task::JoinHandle<String>> = None;
        for attempt in 1..=MAX_ATTEMPTS {
            let mut child = cmd.spawn().map_err(|e| format!("Codex CLI spawn 실패: {e}"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| "Codex stdout pipe 없음".to_string())?;
            let stderr = child
                .stderr
                .take()
                .ok_or_else(|| "Codex stderr pipe 없음".to_string())?;

            // Last sign of life, millis since the epoch — read by the stall watch below.
            let progress = Arc::new(AtomicU64::new(now_ms()));

            // Drain stderr WHILE the child runs. This one line is the whole bug the stall watch
            // below was built to survive: the service runs with RUST_LOG=info, codex writes ~95 KB
            // of tracing there, and a pipe nobody reads holds 64 KB — so the child blocked in
            // write(2) forever, about fourteen seconds in, having produced nothing. Measured
            // 2026-08-31: six shell runs of the identical command all finished in 28~53s because
            // their stderr went to a file, while the adapter wedged every time. The three sibling
            // CLI adapters already drain stderr concurrently and say why; this one did not.
            stderr_task = Some(tokio::spawn({
                let progress = Arc::clone(&progress);
                async move {
                    // Whole lines, never a byte offset. Trimming this by length took the
                    // service down twice on 2026-08-31: codex echoes the prompt into its own
                    // tracing output, the prompt is Korean, and String::drain to a byte index
                    // that lands inside a character panics — which aborts the process. It only
                    // fires past the cap, so it fires on exactly the verbose runs this drain
                    // was added for.
                    let mut reader = BufReader::new(stderr).lines();
                    let mut tail: std::collections::VecDeque<String> = Default::default();
                    let mut held = 0usize;
                    while let Ok(Some(line)) = reader.next_line().await {
                        progress.store(now_ms(), Ordering::Relaxed);
                        push_tail(&mut tail, &mut held, line);
                    }
                    Vec::from(tail).join("\n")
                }
            }));

            // stdout 은 진단용으로만 흘려보낸다(파이프가 차서 자식이 멈추는 것도 방지).
            let drain = {
                let progress = Arc::clone(&progress);
                async move {
                    let mut reader = BufReader::new(stdout).lines();
                    let mut last_lines: Vec<String> = Vec::new();
                    while let Ok(Some(line)) = reader.next_line().await {
                        progress.store(now_ms(), Ordering::Relaxed);
                        if line.trim().is_empty() {
                            continue;
                        }
                        last_lines.push(line);
                        if last_lines.len() > 20 {
                            last_lines.remove(0);
                        }
                    }
                    last_lines
                }
            };

            // Liveness, not the clock: stdout lines and the session rollout both stop when codex
            // wedges, and neither stops while it is working.
            let stall = {
                let progress = Arc::clone(&progress);
                let sessions = codex_home.as_ref().map(|h| h.join("sessions"));
                async move {
                    loop {
                        tokio::time::sleep(STALL_POLL).await;
                        let mut last = progress.load(Ordering::Relaxed);
                        if let Some(dir) = sessions.as_ref() {
                            last = last.max(newest_write_ms(dir));
                        }
                        if now_ms().saturating_sub(last) > STALL_TIMEOUT.as_millis() as u64 {
                            return;
                        }
                    }
                }
            };

            let run = async {
                let last_lines = drain.await;
                let _ = child.wait().await;
                last_lines
            };

            // **완료 신호 = 산출 파일, 프로세스 종료가 아니다.** codex 는 이미지를 낸 뒤에도 한참
            // 안 끝난다(2026-07-27 실측: 생성 56초 / 종료 대기 420초 = 타임아웃까지 감). 도구 결과에
            // "The generated image is already displayed to the user" 라고 적혀 있어 모델은 더 할 일이
            // 없다고 보고 마무리를 서두르지 않는다 — 우리가 기다릴 이유가 없다.
            // 파일 크기가 안정될 때까지 확인하는 것은 쓰는 중 truncated read 방지.
            // `want` is part of the completion signal, not just of the prompt. Stopping at the
            // first stable file kills a codex that is still drawing the rest of the set — see
            // MULTI_GRACE. So: stop as soon as we have them all, and when fewer arrive, stop only
            // after the gap that means no more are coming (with whatever did land — a partial set
            // is worth more than a killed run, and the caller is told how many it got).
            let watch = async {
                let mut best = 0usize;
                let mut last_new = std::time::Instant::now();
                loop {
                    tokio::time::sleep(HARVEST_POLL).await;
                    let Some(home) = codex_home.as_ref() else {
                        continue;
                    };
                    let files = harvest_generated_images(home, started_at);
                    if files.is_empty() {
                        continue;
                    }
                    if files.len() > best {
                        best = files.len();
                        last_new = std::time::Instant::now();
                    }
                    let before = file_sizes(&files);
                    tokio::time::sleep(HARVEST_SETTLE).await;
                    let after = harvest_generated_images(home, started_at);
                    let settled = after.len() == files.len() && file_sizes(&after) == before;
                    if !settled {
                        continue;
                    }
                    if after.len() >= want {
                        return after;
                    }
                    if last_new.elapsed() >= MULTI_GRACE {
                        tracing::warn!(
                            target: "media",
                            "[cli-codex-image] asked for {want}, {} landed and none since {}s \
                             — taking what there is",
                            after.len(),
                            MULTI_GRACE.as_secs()
                        );
                        return after;
                    }
                }
            };

            end = match timeout(CODEX_TIMEOUT, async {
                tokio::select! {
                    files = watch => RunEnd::Harvested(files),
                    lines = run => RunEnd::Exited(lines),
                    _ = stall => RunEnd::Stalled,
                }
            })
            .await
            {
                Ok(e) => e,
                Err(_) => RunEnd::TimedOut,
            };
            // child kill — 파일을 먼저 건졌으면 아직 살아 있다(그게 정상 경로).
            let _ = child.kill().await;

            if matches!(end, RunEnd::Stalled) && attempt < MAX_ATTEMPTS {
                // Loud on purpose: a retry that hides the wedge means the wedge never gets counted.
                tracing::warn!(
                    target: "media",
                    "[cli-codex-image] attempt {attempt} wrote nothing for {}s — killed, retrying",
                    STALL_TIMEOUT.as_secs()
                );
                continue;
            }
            break;
        }
        let stderr_text = match stderr_task {
            Some(handle) => handle.await.unwrap_or_default(),
            None => String::new(),
        };
        // Rotated tokens go home — the image home refreshing a copied token is exactly how the
        // two lineages burned each other (2026-08-06, "refresh token was already used" → every
        // image sat on a silent 401 to the 420s timeout). Success or timeout, push back.
        if let Some(h) = codex_home.as_ref() {
            crate::llm::formats::cli_codex::sync_auth_back(h);
        }

        // 종료·타임아웃으로 끝난 경우엔 여기서 한 번 더 훑는다. 타임아웃이어도 수확을 시도하는
        // 이유 = 이미 떨어진 산출물을 버릴 이유가 없어서.
        let harvested = match end {
            RunEnd::Harvested(ref files) => files.clone(),
            _ => codex_home
                .as_ref()
                .map(|h| harvest_generated_images(h, started_at))
                .unwrap_or_default(),
        };

        if harvested.is_empty() {
            let tail = match &end {
                RunEnd::TimedOut => {
                    format!("타임아웃 ({}초) — 산출 파일 없음", CODEX_TIMEOUT.as_secs())
                }
                RunEnd::Exited(lines) => {
                    format!("마지막 stdout: {}", truncate(&lines.join("\n"), 500))
                }
                // Harvested 인데 비었다 = 도달 불가(watch 는 비면 return 안 함)
                RunEnd::Harvested(_) => "산출 파일 없음".to_string(),
                RunEnd::Stalled => format!(
                    "codex 가 {}초간 아무것도 쓰지 않음 (내부 교착) — {}회 시도 후 포기",
                    STALL_TIMEOUT.as_secs(),
                    MAX_ATTEMPTS
                ),
            };
            return Err(format!(
                "Codex CLI 이미지 수확 실패 ({tail} / stderr: {})",
                truncate(&stderr_text, 500)
            ));
        }

        // 이 포트는 1장 계약 — 가장 최근 파일을 쓴다. 여러 장이 나오면 나머지는 쓰이지 않으므로
        // 조용히 버리지 않고 남긴다(호출자가 장수 불일치를 판독할 수 있게).
        if harvested.len() > 1 {
            tracing::info!(
                target: "media",
                "[cli-codex-image] {} 장 수확 — 포트 계약상 1 장만 사용(나머지 {} 장 폐기)",
                harvested.len(),
                harvested.len() - 1
            );
        }
        // Oldest first, so a multi-part set comes back in the order it was drawn.
        let mut harvested = harvested;
        harvested.sort_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        });
        let picked = harvested.first().expect("non-empty");
        let binary = std::fs::read(picked)
            .map_err(|e| format!("이미지 파일 읽기 실패 ({}): {e}", picked.display()))?;
        let content_type = content_type_for(picked);
        // Everything past the first. A caller that asked for one gets an empty list
        // and never learns this existed.
        let mut extras: Vec<firebat_core::ports::ImageGenImage> = Vec::new();
        for path in harvested.iter().skip(1) {
            match std::fs::read(path) {
                Ok(bytes) => extras.push(firebat_core::ports::ImageGenImage {
                    binary: bytes,
                    content_type: content_type_for(path).to_string(),
                    width: None,
                    height: None,
                }),
                Err(e) => tracing::warn!(
                    target: "media",
                    "[cli-codex-image] extra output unreadable ({}): {e}",
                    path.display()
                ),
            }
        }

        // 소비한 산출물 정리 — /tmp 무한 증식 방지(장당 ~2MB).
        for path in &harvested {
            let _ = std::fs::remove_file(path);
        }

        // 모델이 실제로 넘긴 프롬프트 — 우리가 준 한 줄이 아니라 장면·조명·구도까지 확장된 원문.
        // 갤러리가 그걸 보여줘야 검색·재생성이 의미 있다(사용자 지적 2026-07-28).
        let revised_prompt = extract_image_prompt(picked);
        Ok(ImageGenResult {
            binary,
            content_type,
            width: None,
            height: None,
            revised_prompt,
            cost_usd: None,
            extras,
        })
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 확장자 → MIME. 수확 파일은 codex 가 이름 짓는다.
fn content_type_for(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "webp" => "image/webp".to_string(),
        _ => "image/png".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn content_type_maps_by_extension() {
        assert_eq!(content_type_for(std::path::Path::new("a/b.png")), "image/png");
        assert_eq!(content_type_for(std::path::Path::new("a/b.JPG")), "image/jpeg");
        assert_eq!(content_type_for(std::path::Path::new("a/b.webp")), "image/webp");
        // 확장자 없음 = png 기본
        assert_eq!(content_type_for(std::path::Path::new("a/b")), "image/png");
    }

    /// 수확기는 워터마크 이후 파일만, 세션 하위 디렉토리까지 훑는다.
    #[test]
    fn harvest_respects_watermark_and_nested_dirs() {
        let root = std::env::temp_dir().join(format!(
            "firebat-harvest-test-{}",
            std::process::id()
        ));
        let session = root.join("generated_images").join("sess-1");
        std::fs::create_dir_all(&session).unwrap();

        // 워터마크 이전 파일
        let old = session.join("call_old.png");
        std::fs::File::create(&old).unwrap().write_all(b"x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        let watermark = SystemTime::now();
        std::thread::sleep(std::time::Duration::from_millis(30));

        // 워터마크 이후 파일 + 이미지 아닌 파일
        let new = session.join("call_new.png");
        std::fs::File::create(&new).unwrap().write_all(b"y").unwrap();
        let txt = session.join("notes.txt");
        std::fs::File::create(&txt).unwrap().write_all(b"z").unwrap();

        let found = harvest_generated_images(&root, watermark);
        assert_eq!(found.len(), 1, "워터마크 이후 이미지 1장만: {:?}", found);
        assert_eq!(found[0].file_name().unwrap(), "call_new.png");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The stderr tail keeps whole lines and never cuts inside a character.
    ///
    /// codex echoes the prompt into its tracing output, our prompts carry Korean, and the
    /// first version of this trimmed by byte length — `String::drain` to an index inside a
    /// character panics, and a panic on a tokio worker aborts the process. It took the
    /// service down twice on 2026-08-31 and only ever fires past the cap, which is to say
    /// on exactly the verbose runs the drain exists for. Both directions: over the cap it
    /// drops from the front, under it nothing is lost.
    #[test]
    fn stderr_tail_trims_by_line_and_survives_multibyte() {
        fn tail_of(lines: &[String]) -> String {
            let mut tail: std::collections::VecDeque<String> = Default::default();
            let mut held = 0usize;
            for line in lines {
                push_tail(&mut tail, &mut held, line.clone());
            }
            Vec::from(tail).join("\n")
        }

        let noisy: Vec<String> = (0..400).map(|i| format!("{i} 이미지 생성 로그 한 줄 — codex")).collect();
        let out = tail_of(&noisy);
        assert!(out.len() <= STDERR_TAIL_MAX * 2, "tail ran away: {}", out.len());
        assert!(out.len() > STDERR_TAIL_MAX / 2, "tail lost everything: {}", out.len());
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
        assert!(out.ends_with("399 이미지 생성 로그 한 줄 — codex"), "kept the wrong end");
        // The first line still present must not be the first line written. Checked by its
        // number rather than by substring: "0 이미지" is inside "10 이미지" and "100 이미지",
        // so a contains() here passes and fails for the wrong reasons.
        let first_kept: usize = out
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().next())
            .and_then(|n| n.parse().ok())
            .expect("tail should start with a numbered line");
        assert!(first_kept > 0, "the front should have been dropped, kept from {first_kept}");

        let short = vec!["한 줄".to_string(), "두 줄".to_string()];
        assert_eq!(tail_of(&short), "한 줄\n두 줄");
    }
}

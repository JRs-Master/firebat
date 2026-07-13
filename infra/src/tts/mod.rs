//! TtsAdapter — ITtsPort 구현. OpenAI(mp3) / Gemini(base64 PCM→WAV) provider TTS API 호출.
//! 키는 Vault(LLM `system:*:api-key` / image `*_API_KEY` 재사용 — 다중 이름 fallback). LC 오디오 생성.
//! 모델·요청/응답 포맷 = reference_tts_api_integration (2026-06-20 검색·확정).

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use firebat_core::ports::{ITtsPort, IVaultPort, InfraResult, TtsLine, TtsRequest, TtsResult, TtsSpeaker, TtsWord};

pub struct TtsAdapter {
    vault: Arc<dyn IVaultPort>,
    client: reqwest::Client,
}

impl TtsAdapter {
    pub fn new(vault: Arc<dyn IVaultPort>) -> Self {
        Self {
            vault,
            client: reqwest::Client::new(),
        }
    }

    /// 후보 vault 키 중 첫 비-빈 시크릿 — LLM(`system:openai:api-key`) / image(`OPENAI_API_KEY`) 재사용.
    fn first_secret(&self, keys: &[&str]) -> Option<String> {
        for k in keys {
            if let Some(v) = self.vault.get_secret(k) {
                let v = v.trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
        None
    }

    /// 설정·키에서 effective (provider, model) 해석. req.provider 비었을 때 + 도구의 캐시키/ext 산정에 사용.
    /// provider = 설정값(system:tts:provider) → 없으면 키 보유로 자동(gemini 우선) → 둘 다 없으면 openai.
    fn resolve_config(&self) -> (String, String) {
        let provider = self
            .first_secret(&["system:tts:provider"])
            .filter(|p| matches!(p.as_str(), "browser" | "openai" | "gemini"))
            .unwrap_or_else(|| {
                // 설정 없으면 키 보유로 자동: gemini → openai → 키 0 이면 browser(클라 Web Speech) fallback.
                if self
                    .first_secret(&["system:gemini:api-key", "GEMINI_API_KEY"])
                    .is_some()
                {
                    "gemini".to_string()
                } else if self
                    .first_secret(&["system:openai:api-key", "OPENAI_API_KEY"])
                    .is_some()
                {
                    "openai".to_string()
                } else {
                    "browser".to_string()
                }
            });
        let model = self.first_secret(&["system:tts:model"]).unwrap_or_else(|| {
            match provider.as_str() {
                "gemini" => "gemini-3.1-flash-tts-preview".to_string(),
                _ => "gpt-4o-mini-tts".to_string(),
            }
        });
        (provider, model)
    }

    /// provider·성별 보이스 목록 — gender 주입 시 그 성별, 없으면 전체. 화자별 voice 미지정 시 자동배정.
    fn voices_for_gender(provider: &str, gender: Option<&str>) -> &'static [&'static str] {
        let female = gender.map(Self::is_female);
        match (provider, female) {
            // 큐레이션 = 스타일 확실히 다른 보이스(설정 picker 와 일치). 억양은 style 프롬프트로 미국식.
            ("gemini", Some(true)) => &["Kore", "Leda", "Aoede", "Sulafat"],
            ("gemini", Some(false)) => &["Puck", "Charon", "Fenrir", "Orus"],
            ("gemini", None) => &[
                "Kore", "Puck", "Leda", "Charon", "Aoede", "Fenrir", "Sulafat", "Orus",
            ],
            (_, Some(true)) => &["nova", "shimmer", "coral"],
            (_, Some(false)) => &["onyx", "echo", "ash"],
            (_, None) => &["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
        }
    }

    /// gender 문자열 → 여성 여부(영/한). 미상이면 남성 취급(false).
    fn is_female(g: &str) -> bool {
        let l = g.to_lowercase();
        l.contains("female") || l.contains("woman") || l.contains("girl") || l.contains('여')
    }

    /// 화자명에서 성별 신호 추론 — gender 미주입 시 fallback. 명확한 성별어(Woman/Man/여자/남자 등)
    /// 있을 때만 Some, 고유명(Lisa·Daniel 등 신호 없음)은 None(혼합 목록 유지 = 회귀 0).
    /// female 어가 male 어를 포함("female"⊃"male", "woman"⊃"man")하므로 female 먼저 판정.
    fn gender_from_name(name: &str) -> Option<bool> {
        let l = name.to_lowercase();
        if l.contains("female") || l.contains("woman") || l.contains("girl") || l.contains("lady") || l.contains('여') {
            Some(true)
        } else if l.contains("male") || l.contains("man") || l.contains("boy") || l.contains('남') {
            Some(false)
        } else {
            None
        }
    }

    /// OpenAI /v1/audio/speech 1회 — 단일 voice mp3. style → instructions(말투/억양).
    async fn openai_one(
        &self,
        key: &str,
        model: &str,
        input: &str,
        voice: &str,
        style: Option<&str>,
    ) -> InfraResult<Vec<u8>> {
        let mut body = serde_json::json!({
            "model": model,
            "input": input,
            "voice": voice,
            "response_format": "mp3",
        });
        if let Some(s) = style {
            if !s.trim().is_empty() {
                body["instructions"] = serde_json::Value::String(s.trim().to_string());
            }
        }
        let resp = self
            .client
            .post("https://api.openai.com/v1/audio/speech")
            .header("Authorization", format!("Bearer {key}"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("OpenAI TTS 요청 실패: {e}"))?;
        if !resp.status().is_success() {
            let st = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("OpenAI TTS {st}: {t}"));
        }
        Ok(resp
            .bytes()
            .await
            .map_err(|e| format!("OpenAI TTS 본문 읽기: {e}"))?
            .to_vec())
    }

    async fn openai(&self, req: &TtsRequest) -> InfraResult<TtsResult> {
        let key = self
            .first_secret(&["system:openai:api-key", "OPENAI_API_KEY"])
            .ok_or("OpenAI API 키 미설정 (설정에서 등록 필요)")?;
        // OpenAI = 단일 voice. 멀티스피커는 화자별 voice 로 줄별 생성 후 mp3 byte-concat
        // (같은 model/format 라 플레이어가 연속 재생). 단일 화자면 통째 1회.
        let audio = if req.speakers.is_empty() {
            self.openai_one(&key, &req.model, &req.text, &req.voice, req.style.as_deref())
                .await?
        } else {
            let mut out: Vec<u8> = Vec::new();
            for line in req.text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let (spk, utter) = line
                    .split_once(':')
                    .map(|(a, b)| (a.trim(), b.trim()))
                    .unwrap_or(("", line));
                let sp = req
                    .speakers
                    .iter()
                    .find(|s| s.speaker.eq_ignore_ascii_case(spk));
                let voice = sp.map(|s| s.voice.as_str()).unwrap_or(req.voice.as_str());
                let style = sp.and_then(|s| s.style.as_deref()).or(req.style.as_deref());
                let utter = if utter.is_empty() { line } else { utter };
                let mp3 = self.openai_one(&key, &req.model, utter, voice, style).await?;
                out.extend_from_slice(&mp3);
            }
            if out.is_empty() {
                return Err("TTS 합성할 대사가 없습니다".to_string());
            }
            out
        };
        Ok(TtsResult {
            audio,
            content_type: "audio/mpeg".to_string(),
            ext: "mp3".to_string(),
            lines: Vec::new(),
        })
    }

    async fn gemini(&self, req: &TtsRequest) -> InfraResult<TtsResult> {
        let key = self
            .first_secret(&["system:gemini:api-key", "GEMINI_API_KEY"])
            .ok_or("Gemini API 키 미설정 (설정에서 등록 필요)")?;
        let mut prompt = String::new();
        // 서문 — 없으면 native 가 긴 비대화 줄(안내문/디렉션)을 드롭한다(실측: 멀티 32s→59s, 단일 7.7s→30s).
        // 단일·멀티 둘 다 드롭하므로 리스닝(align=긴 스크립트)이면 항상 서문 추가. 짧은 샘플(align=false)은
        // 스타일 지시("Say cheerfully")와 충돌 피하려 제외. "모든 줄 verbatim 낭독" → 드롭 0 → 줄 수=오디오
        // 일치 → signal_align 정렬 정확. (서문 자체는 낭독 안 됨 — docs 표준 형식.)
        if req.align {
            prompt.push_str("Read the following aloud, every line verbatim:\n\n");
        }
        // 억양/스타일 = Gemini 는 per-speaker 스타일 필드 없음 → 프롬프트 텍스트에 자연어로 합성.
        if let Some(s) = &req.style {
            if !s.trim().is_empty() {
                prompt.push_str(s.trim());
                prompt.push('\n');
            }
        }
        let speech_config = if req.speakers.len() <= 1 {
            // multiSpeaker 는 정확히 2명 필수(1명이면 400 — 실측). 0~1명 = 단일 voice(1명이면 그 화자 보이스).
            let v = req.speakers.first().map(|s| s.voice.clone()).filter(|x| !x.is_empty()).unwrap_or_else(|| req.voice.clone());
            serde_json::json!({
                "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": v } }
            })
        } else {
            // 화자별 억양 텍스트 지시("X speaks with a Y accent")는 Gemini 안전필터에 PROHIBITED_CONTENT 로
            // 차단됨(오탐, safetySettings BLOCK_NONE 으로도 override 불가) + 프리빌트 보이스가 안 먹어 효과도
            // 없음 → 주입 안 함. 억양 다양성은 보이스 선택(성별별 큐레이션)으로.
            let configs: Vec<serde_json::Value> = req
                .speakers
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "speaker": s.speaker,
                        "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": s.voice } }
                    })
                })
                .collect();
            serde_json::json!({
                "multiSpeakerVoiceConfig": { "speakerVoiceConfigs": configs }
            })
        };
        prompt.push_str(&req.text);
        let body = serde_json::json!({
            "contents": [{ "parts": [{ "text": prompt }] }],
            "generationConfig": {
                "responseModalities": ["AUDIO"],
                "speechConfig": speech_config,
            },
        });
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
            req.model
        );
        let resp = self
            .client
            .post(&url)
            .header("x-goog-api-key", &key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Gemini TTS 요청 실패: {e}"))?;
        if !resp.status().is_success() {
            let st = resp.status();
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("Gemini TTS {st}: {t}"));
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("Gemini TTS 응답 파싱: {e}"))?;
        let inline = &json["candidates"][0]["content"]["parts"][0]["inlineData"];
        let b64 = inline["data"]
            .as_str()
            .ok_or_else(|| "Gemini TTS 응답에 오디오 데이터 없음".to_string())?;
        // 샘플레이트 = 응답 mimeType 의 rate= 에서 읽음("audio/L16;codec=pcm;rate=24000").
        // 옛엔 24000 하드코딩 → 모델이 다른 rate(예 16kHz)면 WAV 가 1.5배 빨라지고 길이·LRC 가 통째 어긋남.
        let mime = inline["mimeType"].as_str().unwrap_or("");
        let rate = mime
            .split(';')
            .find_map(|s| s.trim().strip_prefix("rate="))
            .and_then(|r| r.trim().parse::<u32>().ok())
            .filter(|r| *r >= 8000 && *r <= 48000)
            .unwrap_or(24000);
        tracing::info!(target: "tts", mime = %mime, rate = rate, "Gemini TTS PCM sample rate");
        let pcm = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Gemini PCM decode: {e}"))?;
        Ok(TtsResult {
            audio: pcm_to_wav(&pcm, rate, 1, 16),
            content_type: "audio/wav".to_string(),
            ext: "wav".to_string(),
            lines: Vec::new(),
        })
    }

    /// Gemini per-turn parallel synthesis — 3명+ 대화(native multispeaker 는 정확히 2명만 허용). 턴별 단일-스피커
    /// 호출(같은 화자=같은 voiceName=목소리·성별 일관 → "답을 남자가" 식 swap 불가)을 병렬(buffered 6)로
    /// 발사 후 순서대로 concat(턴 사이 0.4s 무음 = signal_align 이 턴 경계로 검출). wall-time ≈ 1콜.
    /// 화자 무제한(G-TELP 다자 대화) + 턴 경계 정확.
    async fn gemini_per_turn(&self, req: &TtsRequest) -> InfraResult<TtsResult> {
        use futures_util::StreamExt;
        let key = self
            .first_secret(&["system:gemini:api-key", "GEMINI_API_KEY"])
            .ok_or("Gemini API 키 미설정 (설정에서 등록 필요)")?;
        // 턴 파싱 — "Name: text" → (voice, style, text). 화자 매칭 실패 시 첫 화자 보이스.
        let turns: Vec<(String, Option<String>, String)> = req
            .text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| {
                if let Some((a, b)) = l.split_once(':') {
                    let name = a.trim();
                    if let Some(sp) = req
                        .speakers
                        .iter()
                        .find(|s| s.speaker.eq_ignore_ascii_case(name))
                    {
                        return (sp.voice.clone(), sp.style.clone(), b.trim().to_string());
                    }
                }
                let sp = &req.speakers[0];
                (sp.voice.clone(), sp.style.clone(), l.to_string())
            })
            .filter(|(_, _, t)| !t.is_empty())
            .collect();
        if turns.is_empty() {
            return Err("per-turn: 빈 스크립트".to_string());
        }
        let n_turns = turns.len();
        let model = req.model.clone();
        let global_style = req.style.clone();
        // into_iter(owned) + prompt 를 async 안에서 — 빌린 &tuple 로 인한 HRTB(FnOnce) 회피.
        let futs = turns.into_iter().map(|(voice, style, text)| {
            let client = self.client.clone();
            let key = key.clone();
            let model = model.clone();
            let global_style = global_style.clone();
            async move {
                let url = format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                    model
                );
                // 억양/스타일 = DIRECTOR'S NOTES + 명확한 서문 + TRANSCRIPT 라벨(Gemini TTS 공식). 모호한
                // 프롬프트는 분류기가 TTS 로 못 알아채 PROHIBITED_CONTENT 거부하거나 notes 를 소리내 읽음 →
                // 서문으로 "transcript 를 음성 합성" 명확히 + 스크립트 시작 라벨링. 그래도 차단되면 notes 빼고
                // 평문 재시도 → 오디오 보장(평문은 항상 통과, 서버 재현 확인).
                let dnote = style
                    .as_ref()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let gstyle = global_style
                    .as_ref()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                let mut use_notes = dnote.is_some() || gstyle.is_some();
                let mut last_err = String::new();
                for attempt in 0..3u32 {
                    if attempt > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    }
                    let mut prompt = String::new();
                    if use_notes {
                        // 서문(분류기에 TTS 요청임을 명시) + DIRECTOR'S NOTES(AI 자유 free-text) + TRANSCRIPT 라벨.
                        prompt.push_str("Read the transcript below aloud as natural speech. Do not read these notes or labels out loud.\n\nDIRECTOR'S NOTES\n");
                        if let Some(g) = &gstyle {
                            prompt.push_str(g);
                            prompt.push('\n');
                        }
                        if let Some(d) = &dnote {
                            prompt.push_str(d);
                            prompt.push('\n');
                        }
                        prompt.push_str("\nTRANSCRIPT\n");
                    }
                    prompt.push_str(&text);
                    let body = serde_json::json!({
                        "contents": [{ "parts": [{ "text": prompt }] }],
                        "generationConfig": {
                            "responseModalities": ["AUDIO"],
                            "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } },
                        },
                    });
                    let resp = match client
                        .post(&url)
                        .header("x-goog-api-key", &key)
                        .header("Content-Type", "application/json")
                        .json(&body)
                        .send()
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => {
                            last_err = format!("요청 {e}");
                            continue;
                        }
                    };
                    if !resp.status().is_success() {
                        let st = resp.status();
                        let t = resp.text().await.unwrap_or_default();
                        last_err = format!("{st}: {}", t.chars().take(160).collect::<String>());
                        continue;
                    }
                    let json: serde_json::Value = match resp.json().await {
                        Ok(j) => j,
                        Err(e) => {
                            last_err = format!("파싱 {e}");
                            continue;
                        }
                    };
                    let inline = &json["candidates"][0]["content"]["parts"][0]["inlineData"];
                    if let Some(b64) = inline["data"].as_str() {
                        let mime = inline["mimeType"].as_str().unwrap_or("");
                        let rate = mime
                            .split(';')
                            .find_map(|s| s.trim().strip_prefix("rate="))
                            .and_then(|r| r.trim().parse::<u32>().ok())
                            .filter(|r| *r >= 8000 && *r <= 48000)
                            .unwrap_or(24000);
                        match base64::engine::general_purpose::STANDARD.decode(b64) {
                            Ok(pcm) => return Ok::<(Vec<u8>, u32), String>((pcm, rate)),
                            Err(e) => {
                                last_err = format!("디코드 {e}");
                                continue;
                            }
                        }
                    }
                    // candidates 없는 차단(promptFeedback.blockReason) 식별.
                    let blocked = json["promptFeedback"]["blockReason"].is_string();
                    let fr = json["candidates"][0]["finishReason"]
                        .as_str()
                        .or_else(|| json["promptFeedback"]["blockReason"].as_str())
                        .unwrap_or("none");
                    last_err = format!("오디오 없음(reason={fr})");
                    if blocked {
                        if use_notes {
                            use_notes = false; // notes/서문이 차단 트리거 → 빼고 평문 재시도(평문은 항상 통과)
                            continue;
                        }
                        break; // 평문도 차단 = deterministic, 중단
                    }
                }
                Err(format!("Gemini per-turn 실패: {last_err}"))
            }
        });
        // buffered(8) = 사실상 전부 동시 발사(보통 대화 ≤8턴 = 뿅뿅뿅, wall-time ≈ 1콜). 캡은 병적 다턴
        // (30턴 모놀로그 등)서만 작동. 흘린 콜은 위 retry 가 줍는다 = 빠르고 robust. 순서 보존.
        let results: Vec<Result<(Vec<u8>, u32), String>> =
            futures_util::stream::iter(futs).buffered(8).collect().await;
        let mut rate = 24000u32;
        let mut all: Vec<u8> = Vec::new();
        for (i, r) in results.into_iter().enumerate() {
            let (pcm, r_rate) = r?;
            if i == 0 {
                rate = r_rate;
            } else {
                // 턴 사이 0.4s 무음 — signal_align 이 턴 경계로 검출(≥250ms gate).
                let gap_samples = (rate as usize) * 4 / 10;
                all.extend(std::iter::repeat(0u8).take(gap_samples * 2));
            }
            all.extend_from_slice(&pcm);
        }
        tracing::info!(target: "tts", turns = n_turns, rate = rate, "Gemini per-turn parallel synthesis");
        Ok(TtsResult {
            audio: pcm_to_wav(&all, rate, 1, 16),
            content_type: "audio/wav".to_string(),
            ext: "wav".to_string(),
            lines: Vec::new(),
        })
    }

    /// LRC 정렬 — 합성된 오디오를 STT(타임스탬프)로 전사 → 단어별 시각 → 스크립트 줄에 매핑.
    /// best-effort: STT 키 없음/실패 시 빈 Vec (컴포넌트가 글자수 비례 추정으로 fallback).
    /// provider 선택 = Whisper(OpenAI, 단어 정밀) 우선 → 없으면 Gemini STT. TTS provider 와 독립.
    async fn align(&self, audio: &[u8], content_type: &str, req: &TtsRequest) -> Vec<TtsLine> {
        // 스크립트를 줄(turn) 단위로 — "Name: utterance" 면 speaker/utterance 분리.
        let parsed: Vec<(Option<String>, String)> = req
            .text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .map(|l| {
                if !req.speakers.is_empty() {
                    if let Some((a, b)) = l.split_once(':') {
                        let spk = a.trim();
                        if req.speakers.iter().any(|s| s.speaker.eq_ignore_ascii_case(spk)) {
                            return (Some(spk.to_string()), b.trim().to_string());
                        }
                    }
                }
                (None, l.to_string())
            })
            .filter(|(_, t)| !t.is_empty())
            .collect();
        if parsed.is_empty() {
            return Vec::new();
        }
        // 정렬 provider 설정(system:tts:align_provider): ''/auto = 신호정렬 우선 / 'local' = 신호·추정만
        // (STT 0) / 'openai' = Whisper 강제(단어 단위 실측). Gemini 는 UI 제거(정렬 불안정 2.7s) — 옛 값이
        // 저장돼 있어도 auto 처럼 동작.
        let provider = self
            .first_secret(&["system:tts:align_provider"])
            .unwrap_or_default();
        // OpenAI(Whisper) 강제 — 신호정렬 건너뛰고 단어 단위 실측(WAV·mp3 공통). 키 없으면 빈 → 컴포넌트 추정.
        if provider == "openai" {
            let words = self.transcribe_words(audio, content_type).await;
            return map_words_to_lines(&parsed, &words, audio, content_type);
        }
        // 1순위 = 순수 신호 정렬(STT·API 0): WAV 에너지로 문장 쉼 검출 → 문장 앵커(실측 발화 재개 지점) +
        // 문장 안 음절가중 단어 분배. 측정(자연 오디오 문장-시작 MAE): 검출앵커≈정확 / char 0.30s /
        // gemini-forced 0.48s / open 2.18s. 우리 LC 오디오(TTS WAV)의 정답.
        if let Some(lines) = signal_align(audio, content_type, &parsed) {
            return lines;
        }
        // 비-WAV(mp3) 등: 'local' 이면 추정(STT 0, 빈 Vec) / auto 면 Whisper(OpenAI 키 있을 때).
        if provider == "local" {
            return Vec::new();
        }
        let words = self.transcribe_words(audio, content_type).await;
        map_words_to_lines(&parsed, &words, audio, content_type)
    }

    /// 단어별 타임스탬프 전사 — 설정 `system:tts:align_provider`(openai/gemini/빈=auto) 따름.
    /// auto = Whisper(OpenAI, 정밀) 우선 → 없으면 Gemini. 명시 provider 면 그것만(키 없으면 빈→fallback).
    async fn transcribe_words(&self, audio: &[u8], content_type: &str) -> Vec<TtsWord> {
        let pref = self
            .first_secret(&["system:tts:align_provider"])
            .unwrap_or_default();
        let has_openai = self
            .first_secret(&["system:openai:api-key", "OPENAI_API_KEY"])
            .is_some();
        let has_gemini = self
            .first_secret(&["system:gemini:api-key", "GEMINI_API_KEY"])
            .is_some();
        if pref == "openai" {
            if has_openai {
                if let Ok(w) = self.whisper_words(audio, content_type).await {
                    return w;
                }
            }
            return Vec::new();
        }
        if pref == "gemini" {
            if has_gemini {
                if let Ok(w) = self.gemini_words(audio, content_type).await {
                    return w;
                }
            }
            return Vec::new();
        }
        // auto — Whisper(OpenAI, word 타임스탬프 전용 설계)만. Gemini 는 단어 정렬이 불안정해 auto 폴백에서 제외.
        // 실측(같은 39.76초 wav, 스크립트·길이까지 준 forced-align 2회): 단어별 start MAE 2.7초 + 뒤로 갈수록
        // 드리프트(마지막 단어 35.5초 vs 실제 발화 끝 39.3초) = 개수·끝점만 맞고 중간 위치는 추측. → OpenAI 키
        // 없으면 빈 Vec → 컴포넌트가 실제 길이 기반 글자수 추정(결정적, 끝점 정확, 드리프트 0).
        // (Gemini 정렬을 굳이 쓰려면 system:tts:align_provider='gemini' 명시 = 짧은 오디오 opt-in.)
        let _ = has_gemini;
        if has_openai {
            if let Ok(w) = self.whisper_words(audio, content_type).await {
                if !w.is_empty() {
                    return w;
                }
            }
        }
        Vec::new()
    }

    /// OpenAI Whisper — `/v1/audio/transcriptions` verbose_json + word 타임스탬프(정밀).
    async fn whisper_words(&self, audio: &[u8], content_type: &str) -> InfraResult<Vec<TtsWord>> {
        let key = self
            .first_secret(&["system:openai:api-key", "OPENAI_API_KEY"])
            .ok_or("OpenAI 키 없음")?;
        let ext = if content_type.contains("wav") { "wav" } else { "mp3" };
        let part = reqwest::multipart::Part::bytes(audio.to_vec())
            .file_name(format!("audio.{ext}"))
            .mime_str(content_type)
            .map_err(|e| format!("whisper part: {e}"))?;
        let form = reqwest::multipart::Form::new()
            .text("model", "whisper-1")
            .text("response_format", "verbose_json")
            .text("timestamp_granularities[]", "word")
            .part("file", part);
        let resp = self
            .client
            .post("https://api.openai.com/v1/audio/transcriptions")
            .header("Authorization", format!("Bearer {key}"))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("whisper 요청: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("whisper {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("whisper 파싱: {e}"))?;
        Ok(json["words"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|w| {
                        Some(TtsWord {
                            word: w.get("word")?.as_str()?.trim().to_string(),
                            start: w.get("start")?.as_f64()?,
                            end: w.get("end")?.as_f64().unwrap_or(0.0),
                        })
                    })
                    .filter(|w| !w.word.is_empty())
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Gemini STT — generateContent 에 오디오 + "단어별 타임스탬프 JSON" 요청(덜 정밀, fallback).
    async fn gemini_words(&self, audio: &[u8], content_type: &str) -> InfraResult<Vec<TtsWord>> {
        let key = self
            .first_secret(&["system:gemini:api-key", "GEMINI_API_KEY"])
            .ok_or("Gemini 키 없음")?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(audio);
        let body = serde_json::json!({
            "contents": [{ "parts": [
                { "inlineData": { "mimeType": content_type, "data": b64 } },
                { "text": "Transcribe this audio. Output ONLY a JSON array of every spoken word in order with timings in seconds: [{\"word\":\"...\",\"start\":0.0,\"end\":0.0}]. No markdown, no commentary." }
            ]}],
            "generationConfig": { "responseModalities": ["TEXT"], "responseMimeType": "application/json" }
        });
        // STT 모델 = gemini-3.5-flash. 실측(40초 wav, 여러 회): 24kHz서 6/7 회 39~40초로 정확 + flash 라
        // pro 대비 ~10배 쌈(₩3/오디오, 1회+캐시). 가끔 32~36 으로 튀나 양방향 sanity gate(0.85~1.15배 벗어나면
        // 버리고 추정 fallback)가 잡음. (pro/pro-latest 는 항상 정확하나 오버킬, 3.1-pro=404, flash-lite=엉터리.)
        let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent";
        let resp = self
            .client
            .post(url)
            .header("x-goog-api-key", &key)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("gemini STT 요청: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("gemini STT {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().await.map_err(|e| format!("gemini STT 파싱: {e}"))?;
        let text = json["candidates"][0]["content"]["parts"][0]["text"]
            .as_str()
            .unwrap_or("[]");
        let arr: Vec<serde_json::Value> = serde_json::from_str(text).unwrap_or_default();
        Ok(arr
            .iter()
            .filter_map(|w| {
                Some(TtsWord {
                    word: w.get("word")?.as_str()?.trim().to_string(),
                    start: w.get("start")?.as_f64()?,
                    end: w.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0),
                })
            })
            .filter(|w| !w.word.is_empty())
            .collect())
    }
}

/// "(A)" → "A. " at line starts (optionally after a "Speaker:" prefix) — see the call site in
/// `synthesize` for why. A-E only, line-anchored, so prose collisions are practically nil
/// (and a line-leading "(a)" IS a marker anyway).
fn normalize_choice_markers(text: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"(?m)^([^\n():]{0,40}:\s*)?\(([A-Ea-e])\)\s*").unwrap()
    });
    re.replace_all(text, |c: &regex::Captures| {
        format!("{}{}. ", c.get(1).map(|m| m.as_str()).unwrap_or(""), &c[2])
    })
    .into_owned()
}

#[async_trait]
impl ITtsPort for TtsAdapter {
    fn effective_config(&self) -> (String, String) {
        self.resolve_config()
    }

    async fn synthesize(&self, req: &TtsRequest) -> InfraResult<TtsResult> {
        // provider/model 비었으면 설정·키에서 해석. 화자/단일 voice 미지정 시 provider 기본 보이스 자동배정.
        let mut req = req.clone();
        // Choice markers "(A)" at an utterance start are visual exam labels that voice models
        // read inconsistently (실측 2026-07-13: TOEIC part-2 보기 (A)/(B)/(C) 가 될 때도 안 될
        // 때도 — provider 가 주석으로 해석해 skip). Deterministic: rewrite to "A." for synthesis
        // (LRC parsing uses the same normalized text = alignment stays consistent); the
        // on-screen script keeps its parentheses (display = the component's own prop).
        req.text = normalize_choice_markers(&req.text);
        if req.provider.is_empty() || req.model.is_empty() {
            let (p, m) = self.resolve_config();
            if req.provider.is_empty() {
                req.provider = p;
            }
            if req.model.is_empty() {
                req.model = m;
            }
        }
        if req.speakers.is_empty() {
            if req.voice.is_empty() {
                // 단일 화자 = 설정 기본 보이스(system:tts:voice, 현 provider 목록에 있을 때만) → 없으면 provider 첫 보이스.
                let list = Self::voices_for_gender(&req.provider, None);
                req.voice = self
                    .first_secret(&["system:tts:voice"])
                    .filter(|v| list.contains(&v.as_str()))
                    .unwrap_or_else(|| list[0].to_string());
            }
        } else {
            // 화자별 voice 자동배정 — 성별(AI 주입) 기반 + 같은 성별끼리 다른 보이스.
            // 스크립트 해시로 시작 offset → 문제(스크립트)마다 보이스가 달라져 "다양한 스피커 연습"
            // (토익/학습용 의도). 같은 스크립트 = 같은 배정(캐시 일관). 같은 성별 화자끼린 distinct.
            let seed = {
                use std::hash::{Hash, Hasher};
                let mut h = std::collections::hash_map::DefaultHasher::new();
                req.text.hash(&mut h);
                h.finish() as usize
            };
            let mut gcount: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
            for sp in req.speakers.iter_mut() {
                if !sp.voice.is_empty() {
                    continue;
                }
                // gender 우선순위: AI 주입값 → (없으면) 화자명 성별어 추론 → (그것도 없으면) None(혼합).
                // "Woman"/"Man" 처럼 이름이 곧 성별인데 gender 미주입이면 남자 보이스가 걸리던 버그 차단.
                let eff_gender: Option<String> = match sp.gender.as_deref() {
                    Some(g) if !g.trim().is_empty() => Some(g.to_string()),
                    _ => Self::gender_from_name(&sp.speaker)
                        .map(|f| if f { "female".to_string() } else { "male".to_string() }),
                };
                let list = Self::voices_for_gender(&req.provider, eff_gender.as_deref());
                let i = gcount
                    .entry(eff_gender.clone().unwrap_or_default())
                    .or_insert(0);
                sp.voice = list[(seed + *i) % list.len()].to_string();
                *i += 1;
            }
        }
        // Pause 마커("[pause: N]" 단독 줄) — 그 지점에 N초 무음(시험 문항 사이 마킹 시간·받아쓰기 간격 등).
        // 화자 수·provider 무관하게 동작하려면 합성 단계서 세그먼트 분할이 정공(native gemini 는 한 콜이라
        // concat 지점이 없음). gemini(WAV) = 세그먼트별 합성+정렬 → 무음 PCM 끼워 concat → 타임스탬프 offset.
        let segments = split_pause_segments(&req.text);
        if req.provider == "gemini" && segments.len() > 1 && segments.iter().any(|s| s.1 > 0.0) {
            let mut combined: Vec<u8> = Vec::new();
            let mut rate = 24000u32;
            let mut lines: Vec<TtsLine> = Vec::new();
            let mut offset = 0.0f64;
            for (seg_text, pause_after) in &segments {
                if !seg_text.trim().is_empty() {
                    let mut sub = req.clone();
                    sub.text = seg_text.clone();
                    let mut spoken = sub.clone(); // 합성 입력 = 라벨 낭독형(괄호 제거) + 화자 접두 정규화.
                    spoken.text = prep_synth_text(seg_text, &req.speakers);
                    let seg = if spoken.speakers.len() > 2 {
                        self.gemini_per_turn(&spoken).await?
                    } else {
                        self.gemini(&spoken).await?
                    };
                    if let Some((pcm, r)) = wav_pcm(&seg.audio) {
                        rate = r;
                        if req.align {
                            // 세그먼트별 정렬(깨끗한 오디오 — 큰 무음이 signal_align 을 교란 안 함) 후 offset.
                            for mut ln in self.align(&seg.audio, &seg.content_type, &sub).await {
                                ln.start += offset;
                                ln.end += offset;
                                for w in ln.words.iter_mut() {
                                    w.start += offset;
                                    w.end += offset;
                                }
                                lines.push(ln);
                            }
                        }
                        offset += pcm.len() as f64 / (rate as f64 * 2.0); // mono 16bit
                        combined.extend_from_slice(&pcm);
                    }
                }
                if *pause_after > 0.0 {
                    combined.extend(std::iter::repeat(0u8).take((rate as f64 * *pause_after) as usize * 2));
                    offset += *pause_after;
                }
            }
            return Ok(TtsResult {
                audio: pcm_to_wav(&combined, rate, 1, 16),
                content_type: "audio/wav".to_string(),
                ext: "wav".to_string(),
                lines,
            });
        }
        // pause 없음 또는 openai(mp3 — 무음 PCM 삽입 불가) — 마커 제거(낭독 방지) 후 단일 합성.
        req.text = segments
            .into_iter()
            .map(|s| s.0)
            .filter(|t| !t.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        // 합성 입력만 라벨 낭독 가능 형태로(괄호 제거) + 화자 접두 정규화(미선언 화자 줄=안내멘트 등을 첫 화자로
        // → native 가 빼먹지 않음) — 표시·LRC 는 원본(req.text) 유지(align 은 req 로 호출).
        let mut spoken = req.clone();
        spoken.text = prep_synth_text(&req.text, &req.speakers);
        let mut result = match spoken.provider.as_str() {
            "openai" => self.openai(&spoken).await?,
            // Gemini native multispeaker = 정확히 2명만 → 3명+ 면 per-turn 병렬 합성(화자 무제한·성별 일관).
            "gemini" if spoken.speakers.len() > 2 => self.gemini_per_turn(&spoken).await?,
            "gemini" => self.gemini(&spoken).await?,
            other => return Err(format!("알 수 없는 TTS provider: {other}")),
        };
        // LRC 정렬 — 합성된 오디오를 STT(타임스탬프)로 전사 → 단어별 시각. best-effort: 실패 시 빈 lines
        // (컴포넌트가 글자수 비례 추정으로 graceful fallback). 정독 노래방 fill·단어 클릭 seek 의 소스.
        // 샘플 미리듣기(align=false)는 짧은 문장이라 정렬 불필요(STT 콜 낭비 회피).
        if req.align {
            result.lines = self.align(&result.audio, &result.content_type, &req).await;
        }
        Ok(result)
    }
}

/// WAV 길이(초) — 헤더 byte_rate(28..32) 로 data 길이 나눔. LRC sanity gate 용(mp3 는 None → 검사 skip,
/// Whisper 정밀이라 무관). 헤더가 RIFF/WAVE 면만.
fn wav_duration_secs(audio: &[u8], content_type: &str) -> Option<f64> {
    if !content_type.contains("wav") || audio.len() < 44 || &audio[0..4] != b"RIFF" {
        return None;
    }
    let byte_rate = u32::from_le_bytes([audio[28], audio[29], audio[30], audio[31]]) as f64;
    if byte_rate <= 0.0 {
        return None;
    }
    Some((audio.len() as f64 - 44.0) / byte_rate)
}

/// 단어 음절 수(모음 그룹 추정) — char 길이보다 발화 길이에 비례. 축약형(It's/let's)=1음절이라 짧게 잡힘.
fn syllables(word: &str) -> usize {
    // Digits speak as full words — "9:45"→"nine forty-five", "2024"→"twenty twenty-four".
    // The old alphabetic-only filter collapsed number/time/price tokens to weight 1, so the
    // fill rushed past exactly the tokens LC scripts are dense with (times, prices, dates).
    // First-order: ≈1 spoken syllable per digit.
    let digits = word.chars().filter(|c| c.is_ascii_digit()).count();
    let w: String = word.to_lowercase().chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if w.is_empty() {
        return digits.max(1);
    }
    let mut n = 0usize;
    let mut prev_v = false;
    for c in w.chars() {
        let v = matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y');
        if v && !prev_v {
            n += 1;
        }
        prev_v = v;
    }
    if w.ends_with('e') && n > 1 {
        n -= 1; // silent trailing e
    }
    // Spelled-out acronyms — all-caps token spoken letter-by-letter ("CEO"=see-ee-oh=3,
    // "HR"=2, "HTML"=4) ≈1 syllable per letter. Heuristic: ≤3 letters always spelled;
    // 4 letters spelled only without vowels (NASA/AIDS-like vowel acronyms speak as words).
    let alpha: Vec<char> = word.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if !alpha.is_empty()
        && alpha.len() <= 4
        && alpha.iter().all(|c| c.is_ascii_uppercase())
        && (alpha.len() <= 3 || !w.chars().any(|c| matches!(c, 'a' | 'e' | 'i' | 'o' | 'u')))
    {
        n = n.max(alpha.len());
    }
    (n + digits).max(1)
}

/// Closed-class function words — spoken reduced/unstressed, materially shorter than content
/// words of equal syllable count (standard English phonetics — a closed set, not case tuning).
fn is_function_word(w: &str) -> bool {
    matches!(
        w,
        "a" | "an" | "the" | "of" | "to" | "in" | "on" | "at" | "for" | "and" | "or" | "but"
            | "is" | "are" | "was" | "were" | "be" | "been" | "am" | "do" | "does" | "did"
            | "has" | "have" | "had" | "will" | "would" | "can" | "could" | "shall" | "should"
            | "may" | "might" | "must" | "it" | "its" | "as" | "by" | "with" | "from" | "that"
            | "this" | "so" | "if" | "than" | "then" | "i" | "he" | "she" | "we" | "you" | "they"
    )
}

/// 단어 발화시간 근사 = 음절 + 0.5×자음수. 음절-only 는 자음클러스터 단어("trends" 1음절 5자음·
/// "client"·"year-over-year")를 과소평가해 fill 이 빨리 지나간다 → 자음(articulation 시간) 반영.
/// 기능어(관사·전치사·조동사 등 닫힌 집합)는 약형(reduced)으로 짧게 발화 → ×0.6 —
/// "the"(옛 2.0)가 content 단음절과 동급으로 과대평가돼 앵커 사이 보간이 밀리던 것.
fn word_weight(w: &str) -> f64 {
    let s = syllables(w) as f64;
    let cons = w
        .chars()
        .filter(|c| {
            let lc = c.to_ascii_lowercase();
            lc.is_ascii_alphabetic() && !matches!(lc, 'a' | 'e' | 'i' | 'o' | 'u' | 'y')
        })
        .count() as f64;
    let base = s + 0.5 * cons;
    let clean: String = w
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphabetic())
        .collect();
    if is_function_word(&clean) {
        base * 0.6
    } else {
        base
    }
}

/// 줄 가중치 = 음절(발화시간) + 문장부호 쉼(쉼표·세미콜론·콜론 ×2, 줄 안 마침표/물음표/느낌표 ×3).
/// 음절만으론 *발화 시간*만 재고 문장부호가 만드는 *쉼*은 못 잡아, 쉼표 많은 줄이 음절보다 길게 발화되는데도
/// 짧게 추정돼 경계가 일찍 잡혔다(under-allocated). 쉼 시간을 음절-등가로 더해 경계 위치 추정을 실제에 맞춘다.
fn line_weight(text: &str) -> f64 {
    let syl: f64 = text.split_whitespace().map(|w| syllables(w) as f64).sum();
    let commas = text.matches(',').count() + text.matches(';').count() + text.matches(':').count();
    // 줄 안(끝 제외) 문장끝 — '.'/'?'/'!' 바로 뒤가 공백인 경우(ASCII 단일바이트라 UTF-8 안전).
    let bytes = text.as_bytes();
    let mut inner_ends = 0usize;
    for i in 0..bytes.len() {
        if matches!(bytes[i], b'.' | b'?' | b'!') && bytes.get(i + 1).is_some_and(|b| b.is_ascii_whitespace()) {
            inner_ends += 1;
        }
    }
    (syl + commas as f64 * 2.0 + inner_ends as f64 * 3.0).max(1.0)
}

/// 연음 그룹 분할 — punctuation(.,;:?!) 으로 끝나는 단어 뒤에서 끊음. per-group 단어 분배용.
fn split_word_groups(text: &str) -> Vec<Vec<&str>> {
    let mut groups: Vec<Vec<&str>> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    for w in text.split_whitespace() {
        cur.push(w);
        if w
            .chars()
            .last()
            .map(|ch| matches!(ch, '.' | ',' | ';' | ':' | '?' | '!'))
            .unwrap_or(false)
        {
            groups.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    groups
}

/// [a,b] 에서 무음(gaps) 뺀 발화 구간들 — speech-time 매핑용(무음 건너뛰기).
fn subtract_gaps(a: f64, b: f64, gaps: &[(f64, f64, f64, f64)]) -> Vec<(f64, f64)> {
    let mut segs = Vec::new();
    let mut cur = a;
    for g in gaps {
        let (gs, ge) = (g.0, g.1);
        if ge <= a || gs >= b {
            continue;
        }
        let gs = gs.max(a);
        let ge = ge.min(b);
        if gs > cur {
            segs.push((cur, gs));
        }
        cur = cur.max(ge);
    }
    if cur < b {
        segs.push((cur, b));
    }
    segs
}

/// speech-fraction(0..1) → 실제 시각(무음 구간 건너뜀).
fn seg_frac_to_time(frac: f64, segs: &[(f64, f64)], total: f64) -> f64 {
    let target = frac.clamp(0.0, 1.0) * total;
    let mut acc = 0.0;
    for &(a, b) in segs {
        let d = b - a;
        if acc + d >= target {
            return a + (target - acc);
        }
        acc += d;
    }
    segs.last().map(|s| s.1).unwrap_or(0.0)
}

/// coarse-to-fine 문장 경계 — 큰 pause(≥2s, 답안 pause 등)를 하드 앵커로 박아 블록 분할 후, 각 블록
/// 안에서만 local expected(speech-time 누적가중) + prominence(쉼 길이) snap. 옛 wall-clock 누적비례는
/// 큰 무음이 뒤에 몰리면 앞 줄(긴 Directions 등)을 과배정 → cascade 로 전 줄 어긋났다. 앵커가 기준을
/// 리셋하고 speech-time 이 무음 분포 왜곡을 제거. 큰 pause 없으면(일반 대화) 단일 블록 = 옛 동작과 등가.
fn coarse_to_fine_lines(
    parsed: &[(Option<String>, String)],
    cand: &[(f64, f64, f64, f64)],
    gaps: &[(f64, f64, f64, f64)],
    onset0: f64,
    offset: f64,
) -> (Vec<f64>, Vec<f64>) {
    let n = parsed.len();
    let nb = n - 1;
    let big_thr = 2.0_f64;
    let wt: Vec<f64> = parsed.iter().map(|(_, t)| line_weight(t)).collect();
    let totw: f64 = wt.iter().sum::<f64>().max(1.0);
    let gsegs = subtract_gaps(onset0, offset, gaps);
    let gsp = gsegs.iter().map(|(a, b)| b - a).sum::<f64>().max(1e-3);
    let mut cum: Vec<f64> = Vec::with_capacity(nb);
    let mut acc = 0.0;
    for s in wt.iter().take(nb) {
        acc += *s;
        cum.push(acc);
    }
    let exp: Vec<f64> = cum.iter().map(|ck| seg_frac_to_time(ck / totw, &gsegs, gsp)).collect();
    // 큰 pause → 가장 가까운 기대 경계 idx 에 단조 배정(하드 앵커).
    let mut anchor: Vec<Option<(f64, f64, f64, f64)>> = vec![None; nb];
    let mut lo = 0usize;
    for bg in cand.iter().filter(|g| g.2 >= big_thr) {
        let mut best: Option<usize> = None;
        let mut bd = f64::INFINITY;
        for k in lo..nb {
            let d = (exp[k] - bg.0).abs();
            if d < bd {
                bd = d;
                best = Some(k);
            }
        }
        match best {
            Some(k) => {
                anchor[k] = Some(*bg);
                lo = k + 1;
            }
            None => break,
        }
    }
    let mut chosen: Vec<Option<(f64, f64, f64, f64)>> = anchor.clone();
    let mut iter_pts: Vec<usize> = (0..nb).filter(|&k| anchor[k].is_some()).collect();
    iter_pts.push(nb);
    let mut prev_idx: isize = -1;
    let mut prev_time = onset0;
    for &ak in &iter_pts {
        let p_ = (prev_idx + 1) as usize;
        let q_isize = ak as isize - 1;
        let r = if ak < nb { anchor[ak].unwrap().0 } else { offset };
        let l = prev_time;
        if (p_ as isize) <= q_isize {
            let q_ = q_isize as usize;
            let nbk = q_ - p_ + 1;
            let local: Vec<(f64, f64, f64, f64)> = cand
                .iter()
                .filter(|g| g.0 > l + 0.02 && g.1 < r - 0.02 && g.2 < big_thr)
                .cloned()
                .collect();
            let lsegs = subtract_gaps(l, r, gaps);
            let lsp = lsegs.iter().map(|(a, b)| b - a).sum::<f64>().max(1e-3);
            let lw: Vec<f64> = (p_..=q_ + 1).map(|i| wt[i]).collect();
            let ltot: f64 = lw.iter().sum::<f64>().max(1.0);
            let mut lacc = 0.0;
            let mut lexp: Vec<f64> = Vec::with_capacity(nbk);
            for s in lw.iter().take(nbk) {
                lacc += *s;
                lexp.push(seg_frac_to_time(lacc / ltot, &lsegs, lsp));
            }
            if local.len() >= nbk && nbk > 0 {
                // score = -|t-exp| + λ·쉼길이 → within-line 작은 쉼 대신 진짜 경계(큰 쉼) 선호.
                let lam = 2.0_f64;
                let mut lo2 = 0usize;
                for bi in 0..nbk {
                    let hi = local.len() - (nbk - bi);
                    let mut best = lo2;
                    let mut bs = f64::NEG_INFINITY;
                    for ci in lo2..=hi {
                        let g = local[ci];
                        let score = -(g.0 - lexp[bi]).abs() + lam * g.2;
                        if score > bs {
                            bs = score;
                            best = ci;
                        }
                    }
                    chosen[p_ + bi] = Some(local[best]);
                    lo2 = best + 1;
                }
            } else {
                for bi in 0..nbk {
                    let t = lexp[bi];
                    chosen[p_ + bi] = Some((t, t, 0.0, 0.0));
                }
            }
        }
        prev_idx = ak as isize;
        prev_time = if ak < nb { anchor[ak].unwrap().1 } else { offset };
    }
    let mut st = vec![onset0];
    let mut en = Vec::new();
    for g in &chosen {
        let g = g.unwrap_or((onset0, onset0, 0.0, 0.0));
        st.push(g.1);
        en.push(g.0);
    }
    en.push(offset);
    (st, en)
}

/// 순수 신호 정렬 (STT·API 0) — WAV 에너지에서 문장 쉼을 검출해 문장 앵커(실측 발화 재개 지점)를 잡고,
/// 문장 안은 음절가중으로 단어를 분배(노래방 fill). 우리 LC 오디오(TTS 생성 WAV)의 정답 — 측정상 문장 경계
/// 검출은 깨끗(top N-1 긴 쉼, 6/6)하고 char 추정보다 정확하며, 단어는 연결발화라 무음 분리가 불가(4/7)해서
/// 음절 분배가 정공. WAV·16bit 아니면(mp3 등) None → 상위에서 Whisper/추정 폴백.
fn signal_align(
    audio: &[u8],
    content_type: &str,
    parsed: &[(Option<String>, String)],
) -> Option<Vec<TtsLine>> {
    if !content_type.contains("wav") || audio.len() < 46 || &audio[0..4] != b"RIFF" {
        return None;
    }
    let channels = u16::from_le_bytes([audio[22], audio[23]]).max(1) as usize;
    let rate = u32::from_le_bytes([audio[24], audio[25], audio[26], audio[27]]) as usize;
    let bits = u16::from_le_bytes([audio[34], audio[35]]);
    if bits != 16 || rate == 0 {
        return None;
    }
    let data = &audio[44..];
    let frame_bytes = channels * 2;
    let nsamp = data.len() / frame_bytes;
    if nsamp < rate / 2 {
        return None; // 0.5초 미만 = 의미 없음
    }
    // mono mean-abs amplitude per 5ms frame
    let fr = (rate / 200).max(1);
    let total = nsamp as f64 / rate as f64;
    let fsec = fr as f64 / rate as f64;
    let mut env: Vec<f64> = Vec::with_capacity(nsamp / fr + 1);
    let mut k = 0usize;
    while k + fr <= nsamp {
        let mut s: i64 = 0;
        for i in k..k + fr {
            let mut acc = 0i32;
            for c in 0..channels {
                let o = i * frame_bytes + c * 2;
                acc += i16::from_le_bytes([data[o], data[o + 1]]) as i32;
            }
            s += (acc / channels as i32).unsigned_abs() as i64;
        }
        env.push(s as f64 / fr as f64);
        k += fr;
    }
    if env.is_empty() {
        return None;
    }
    let mx = env.iter().cloned().fold(0.0_f64, f64::max);
    if mx <= 0.0 {
        return None;
    }
    let thr = mx * 0.06;
    // interior silence gaps (양 끝 무음 제외) — (start_s, end_s, dur, minenv).
    // minenv(쉼 바닥 에너지) = 깊이: 진짜 쉼(마침표·쉼표·문장)은 에너지 0 근처(깊음), 파열음/자음군은 얕음.
    let mut gaps: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut i = 0usize;
    while i < env.len() {
        if env[i] < thr {
            let a = i;
            let mut mn = env[i];
            while i < env.len() && env[i] < thr {
                if env[i] < mn {
                    mn = env[i];
                }
                i += 1;
            }
            if a > 0 && i < env.len() {
                gaps.push((a as f64 * fsec, i as f64 * fsec, (i - a) as f64 * fsec, mn));
            }
        } else {
            i += 1;
        }
    }
    let onset0 = env
        .iter()
        .position(|&v| v >= thr)
        .map(|p| p as f64 * fsec)
        .unwrap_or(0.0);
    let offset = env
        .iter()
        .rposition(|&v| v >= thr)
        .map(|p| (p + 1) as f64 * fsec)
        .unwrap_or(total);
    let nsent = parsed.len();
    // 문장 앵커 = 줄 가중치(음절+문장부호 쉼) 누적 "기대 시각"에 가장 가까운 실제 쉼으로 단조 snap. 부족하면 추정.
    let (starts, ends): (Vec<f64>, Vec<f64>) = if nsent <= 1 {
        (vec![onset0], vec![offset])
    } else {
        // 후보 쉼(≥250ms), 시간순.
        let mut cand: Vec<(f64, f64, f64, f64)> = gaps.iter().filter(|g| g.2 >= 0.25).cloned().collect();
        cand.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        if cand.len() >= nsent - 1 {
            // coarse-to-fine: 큰 pause(≥2s)를 하드 앵커로 박아 블록 분할 → 블록 안에서만 local expected
            // (speech-time 누적가중) + prominence(쉼 길이) snap. 옛 wall-clock 누적비례는 답안 pause 같은
            // 큰 무음이 뒤에 몰리면 앞 줄(긴 Directions 등)을 과배정 → cascade. speech-time + 앵커가 차단.
            // 큰 pause 없는 일반 대화 = 단일 블록 = 옛 동작과 등가(회귀 0, Henderson 검증).
            coarse_to_fine_lines(parsed, &cand, &gaps, onset0, offset)
        } else {
            // 쉼 부족 → 줄 가중치(음절+문장부호 쉼) 추정 문장 경계(char 보다 정확).
            let lens: Vec<f64> = parsed.iter().map(|(_, t)| line_weight(t)).collect();
            let tot: f64 = lens.iter().sum::<f64>().max(1.0);
            let span = (offset - onset0).max(0.1);
            let mut st = Vec::new();
            let mut en = Vec::new();
            let mut acc = 0.0;
            for l in &lens {
                st.push(onset0 + acc / tot * span);
                acc += l;
                en.push(onset0 + acc / tot * span);
            }
            (st, en)
        }
    };
    // 문장 안 단어 분배 — thought group(원어민이 한 호흡에 묶어 발음하는 단위) 인식.
    // 문장 span 안 미세 쉼(≥125ms, 단어내 파열음 노이즈·짧은 쉼 제외)을 검출 → 발화(speech) 구간만 음절-균등,
    // 쉼 구간엔 단어 0 → fill 이 그 thought-group 경계에서 멈췄다 다음 그룹으로 이어짐(연음그룹 단위 동기).
    let mut out: Vec<TtsLine> = Vec::with_capacity(nsent);
    for (idx, (speaker, text)) in parsed.iter().enumerate() {
        let s0 = starts.get(idx).copied().unwrap_or(onset0);
        let s1 = ends.get(idx).copied().unwrap_or(offset).max(s0 + 0.05);
        // position-based 연음 분배 (사용자 설계): punctuation 이 쉼 위치를 *지정* → 그 위치 근처 *깊은 쉼*을
        // 신호로 *확인*(스크립트 연결) → 확인된 쉼이 세그먼트 경계 → 각 그룹(연결 단어)을 제 세그먼트 시간에
        // 음절 분배. 옛 줄전체 분배는 그룹 첫 단어가 쉼 *전*부터 시작("A." 뒤 쉬는데 "On"이 칠해짐)했는데
        // 그룹↔세그먼트 1:1 로 차단. punctuation 이 권위(항상 그룹 단위), 신호는 위치만 정밀화 = 폴백 없음.
        let words: Vec<&str> = text.split_whitespace().collect();
        let groups = split_word_groups(text);
        let span = (s1 - s0).max(1e-3);
        // 확인용 깊은 쉼(짧아도 OK; depth 로 진짜 쉼만 — 비-punctuation·파열음 closure 무시).
        let deep: Vec<(f64, f64)> = gaps
            .iter()
            .filter(|g| g.0 > s0 + 0.02 && g.1 < s1 - 0.02 && g.3 < thr * 0.07 && g.2 >= 0.05)
            .map(|g| (g.0, g.1))
            .collect();
        let gsyl: Vec<f64> = groups
            .iter()
            .map(|g| g.iter().map(|w| syllables(w) as f64).sum::<f64>())
            .collect();
        let totsyl: f64 = gsyl.iter().sum::<f64>().max(1.0);
        // 그룹 경계(음절 누적 기대위치) → 가장 긴 깊은 쉼에 snap(±0.6s·단조). 없으면 추정위치(쉼 없음).
        // 그룹 경계 기대시각(음절 누적 비례) 사전 계산 — 최근접 배정의 기준.
        let n_bnd = groups.len().saturating_sub(1);
        let mut exps: Vec<f64> = Vec::with_capacity(n_bnd);
        {
            let mut cum = 0.0;
            for gi in 0..n_bnd {
                cum += gsyl[gi];
                exps.push(s0 + cum / totsyl * span);
            }
        }
        // 최근접 1:1 배정 — 각 경계는 자기 기대시각에 가장 가까운 깊은 쉼을 취하되, **그 쉼이 다른
        // 경계에 더 가까우면(=이웃 것) 취하지 않고 비례추정으로 둔다.** 옛 greedy-forward + 가장-긴-쉼
        // 은 짧은 인접 그룹("Sure, | Tom. | I heard") 에서 앞 경계가 뒤 경계의 쉼을 채가 → 앞 그룹이
        // 뒷 그룹 오디오까지 뻗고 가운데 그룹 붕괴 → fill 밀림(현재 단어는 비고 앞뒤가 채워짐)이 발생.
        let mut seg_starts: Vec<f64> = vec![s0];
        let mut seg_ends: Vec<f64> = Vec::new();
        let mut prev_end = s0;
        let mut used = vec![false; deep.len()];
        for gi in 0..n_bnd {
            let exp = exps[gi];
            // prev_end 이후 미사용 깊은 쉼 중 exp 에 가장 가까운 것(±0.6s).
            let mut best: Option<usize> = None;
            let mut bd = 0.6;
            for ci in 0..deep.len() {
                if used[ci] || deep[ci].0 < prev_end {
                    continue;
                }
                let d = (deep[ci].0 - exp).abs();
                if d < bd {
                    bd = d;
                    best = Some(ci);
                }
            }
            // 이 쉼의 최근접 경계가 gi 일 때만 취득(이웃 경계 것 훔침 방지).
            let claim = best.is_some_and(|ci| {
                let g = deep[ci].0;
                exps.iter().enumerate().all(|(gj, &e)| {
                    gj == gi || (e - g).abs() >= (exps[gi] - g).abs()
                })
            });
            match best {
                Some(ci) if claim => {
                    used[ci] = true;
                    seg_ends.push(deep[ci].0);
                    seg_starts.push(deep[ci].1);
                    prev_end = deep[ci].1;
                }
                _ => {
                    // 비례추정 fallback — 단, 앞 그룹이 깊은 쉼을 claim 해 prev_end 를 밀었으면 그
                    // 추정치가 prev_end 뒤로 갈 수 있다 → clamp 로 단조 보장(뒤 그룹이 앞 그룹보다 이른
                    // 시각으로 역행 = fill 겹침 방지).
                    let e = exp.max(prev_end);
                    seg_ends.push(e);
                    seg_starts.push(e);
                    prev_end = e;
                }
            }
        }
        seg_ends.push(s1);
        // 각 그룹 안 단어 분배 — word_weight 기대위치를 미세 쉼(depth<thr×0.12, ≥40ms)에 snap(앵커).
        // 미세 쉼 있는 단어경계는 거기 고정(재동기), 없으면 기대위치 → 긴 연결 그룹의 누적 드리프트 차단
        // (계층: 문장→연음그룹→단어경계 미세쉼). 미세쉼 없는 짧은 그룹은 순수 word_weight(영향 0).
        let mut wl: Vec<TtsWord> = Vec::with_capacity(words.len());
        for (gi, group) in groups.iter().enumerate() {
            let ga = seg_starts[gi];
            let gb = seg_ends[gi].max(ga + 0.05);
            let micro: Vec<(f64, f64)> = gaps
                .iter()
                .filter(|g| g.0 > ga + 0.02 && g.1 < gb - 0.02 && g.3 < thr * 0.12 && g.2 >= 0.04)
                .map(|g| (g.0, g.1))
                .collect();
            let ww: Vec<f64> = group.iter().map(|w| word_weight(w)).collect();
            let totw: f64 = ww.iter().sum::<f64>().max(1.0);
            let gspan = (gb - ga).max(1e-3);
            // 그룹 내 단어 경계 기대시각(word_weight 누적).
            let n_wb = group.len().saturating_sub(1);
            let mut wexps: Vec<f64> = Vec::with_capacity(n_wb);
            {
                let mut wc = 0.0;
                for k in 0..n_wb {
                    wc += ww[k];
                    wexps.push(ga + wc / totw * gspan);
                }
            }
            // 최근접 1:1 + 이웃 경계 미세쉼 훔침 방지 — 그룹 경계 배정과 동일 방식(밀림 차단).
            let mut w_starts: Vec<f64> = vec![ga];
            let mut w_ends: Vec<f64> = Vec::new();
            let mut wprev = ga;
            let mut wused = vec![false; micro.len()];
            for k in 0..n_wb {
                let exp = wexps[k];
                let mut best: Option<usize> = None;
                let mut bd = 0.15;
                for ci in 0..micro.len() {
                    if wused[ci] || micro[ci].0 < wprev {
                        continue;
                    }
                    let d = (micro[ci].0 - exp).abs();
                    if d < bd {
                        bd = d;
                        best = Some(ci);
                    }
                }
                let claim = best.is_some_and(|ci| {
                    let g = micro[ci].0;
                    wexps
                        .iter()
                        .enumerate()
                        .all(|(kj, &e)| kj == k || (e - g).abs() >= (wexps[k] - g).abs())
                });
                match best {
                    Some(ci) if claim => {
                        wused[ci] = true;
                        w_ends.push(micro[ci].0);
                        w_starts.push(micro[ci].1);
                        wprev = micro[ci].1;
                    }
                    _ => {
                        // 그룹 경계와 동일 — 앞 단어가 미세 쉼을 claim 했으면 추정치를 wprev 이상으로
                        // clamp(단어 타임스탬프 단조 보장).
                        let e = exp.max(wprev);
                        w_ends.push(e);
                        w_starts.push(e);
                        wprev = e;
                    }
                }
            }
            w_ends.push(gb);
            for (k, w) in group.iter().enumerate() {
                let ws = w_starts[k];
                let we = w_ends[k].max(ws + 0.02);
                wl.push(TtsWord {
                    word: (*w).to_string(),
                    start: ws,
                    end: we,
                });
            }
        }
        out.push(TtsLine {
            speaker: speaker.clone(),
            text: text.clone(),
            start: s0,
            end: s1,
            words: wl,
        });
    }
    Some(out)
}

/// 전사 단어(STT) → 스크립트 줄에 순차 매핑 + 양방향 sanity gate. STT 폴백(Whisper) 경로 전용
/// (signal_align 은 자체로 줄 생성). 각 줄의 발화 단어 수만큼 전사 단어를 소비. 타임스탬프가 실제 오디오
/// 길이의 0.85~1.15배 밖이면 엉터리로 보고 빈 Vec(→ 컴포넌트가 글자수 추정 fallback).
fn map_words_to_lines(
    parsed: &[(Option<String>, String)],
    words: &[TtsWord],
    audio: &[u8],
    content_type: &str,
) -> Vec<TtsLine> {
    if words.is_empty() {
        return Vec::new();
    }
    let mut idx = 0usize;
    let mut out: Vec<TtsLine> = Vec::with_capacity(parsed.len());
    for (speaker, text) in parsed {
        let n = text.split_whitespace().count().max(1);
        if idx >= words.len() {
            break;
        }
        let take = n.min(words.len() - idx);
        let slice = &words[idx..idx + take];
        idx += take;
        let start = slice.first().map(|w| w.start).unwrap_or(0.0);
        let end = slice.last().map(|w| w.end).unwrap_or(start);
        out.push(TtsLine {
            speaker: speaker.clone(),
            text: text.clone(),
            start,
            end,
            words: slice.to_vec(),
        });
    }
    if let Some(d) = wav_duration_secs(audio, content_type) {
        let max_end = out.iter().map(|l| l.end).fold(0.0_f64, f64::max);
        if d > 0.5 && (max_end > d * 1.15 || max_end < d * 0.85) {
            return Vec::new();
        }
    }
    out
}

/// PCM(16-bit LE) → WAV. Gemini TTS 응답 = 24kHz mono 16-bit PCM (헤더 없음) → RIFF/WAVE 헤더 부착.
fn pcm_to_wav(pcm: &[u8], sample_rate: u32, channels: u16, bits: u16) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let data_len = pcm.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm);
    out
}

/// WAV(pcm_to_wav 산출 = 44바이트 헤더·mono·16bit)에서 PCM 바이트 + 샘플레이트 추출. concat·무음 삽입용.
fn wav_pcm(audio: &[u8]) -> Option<(Vec<u8>, u32)> {
    if audio.len() < 44 || &audio[0..4] != b"RIFF" {
        return None;
    }
    let rate = u32::from_le_bytes([audio[24], audio[25], audio[26], audio[27]]);
    if !(8000..=48000).contains(&rate) {
        return None;
    }
    Some((audio[44..].to_vec(), rate))
}

/// pause 마커 분할 — "[pause: 10]" / "{pause 10}" 류 **단독 줄**(대괄호/중괄호로 시작)을 만나면 거기서
/// 끊고 그 뒤에 N초 무음을 둔다. 각 세그먼트 = (스크립트 텍스트, 뒤따르는 무음 초). 마커는 화자 수·provider
/// 무관하게 무음을 끼우기 위함(시험 문항 사이 마킹 시간·받아쓰기 간격 등 범용 — 시험별 길이는 스킬이 지정).
fn split_pause_segments(text: &str) -> Vec<(String, f64)> {
    let parse_pause = |line: &str| -> Option<f64> {
        let t = line.trim();
        if !(t.starts_with('[') || t.starts_with('{')) {
            return None; // 산문 오탐 방지 — 대괄호/중괄호 시작만 마커로 인정.
        }
        let inner = t.trim_matches(|c| c == '[' || c == ']' || c == '{' || c == '}').trim();
        if !inner.to_lowercase().starts_with("pause") {
            return None;
        }
        let num: String = inner[4..].chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
        num.parse::<f64>().ok().filter(|n| *n > 0.0 && *n <= 60.0)
    };
    let mut segs: Vec<(String, f64)> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if let Some(secs) = parse_pause(line) {
            if !cur.trim().is_empty() {
                segs.push((cur.trim().to_string(), secs));
                cur.clear();
            } else if let Some(last) = segs.last_mut() {
                last.1 += secs; // 연속 pause / 빈 텍스트 → 직전 무음에 누적.
            }
            continue;
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        segs.push((cur.trim().to_string(), 0.0));
    }
    if segs.is_empty() {
        segs.push((text.trim().to_string(), 0.0));
    }
    segs
}


/// 멀티스피커 줄의 화자 접두 정규화 — native multispeaker 는 선언된 화자와 매칭 안 되는 "Name:" 줄을
/// 낭독에서 건너뛴다(per-turn 은 첫 화자로 폴백하나 native 는 안 함 = 비대칭). 안내멘트를 "Directions: ..."
/// 처럼 화자 없이 쓰면 native 가 통째로 빼먹음 → 선언 안 된(또는 접두 없는) 줄을 **첫 화자**로 재귀속.
/// speakers 비었으면(단일 음성) 그대로(전체 낭독). 이미 유효 화자 줄은 불변(idempotent).
/// 합성 입력 텍스트 준비 — 단일 화자(1명)면 그 이름 접두만 제거(단일 voice 라 안 떼면 이름까지 낭독됨;
/// 추측이 아니라 알려진 단일 이름의 결정적 정규화). 2명+/0명 = 그대로 통과. 무라벨 줄 강제 화자주입은
/// 제거함 — 잘못 만든 스크립트를 합성단에서 추측 보정하면 화자 오배정(2번째 턴 라벨 빼먹으면 1번째가 읽음)·
/// 정렬 밀림 같은 2차 문제를 만든다. 라벨 정확성은 프롬프트/스킬 책임(multiSpeaker 가 "Name: line" 직접 파싱).
fn prep_synth_text(text: &str, speakers: &[TtsSpeaker]) -> String {
    if speakers.len() == 1 {
        let pfx = format!("{}:", speakers[0].speaker);
        text.lines()
            .map(|l| {
                let t = l.trim_start();
                t.strip_prefix(&pfx).map(|r| r.trim_start().to_string()).unwrap_or_else(|| l.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text.to_string()
    }
}

#[cfg(test)]
mod weight_tests {
    use super::{is_function_word, syllables, word_weight};

    #[test]
    fn numbers_speak_as_digits() {
        // Old code collapsed these to 1 (alphabetic filter) — fills rushed past times/prices.
        assert_eq!(syllables("9:45"), 3); // "nine forty-five" ≈ 4 — 3 is the digit first-order
        assert_eq!(syllables("2024"), 4);
        assert_eq!(syllables("$4.50"), 3);
        assert_eq!(syllables("7"), 1);
    }

    #[test]
    fn acronyms_spell_letter_by_letter() {
        assert_eq!(syllables("CEO"), 3); // see-ee-oh
        assert_eq!(syllables("HR"), 2);
        assert_eq!(syllables("VIP"), 3);
        assert_eq!(syllables("HTML"), 4); // 4 letters, no vowels → spelled
        assert_eq!(syllables("NASA"), 2); // 4 letters WITH vowels → spoken as a word
        assert_eq!(syllables("B2B"), 3); // bee-to-bee: 2 letters + 1 digit
    }

    #[test]
    fn normal_words_unchanged() {
        assert_eq!(syllables("meeting"), 2);
        assert_eq!(syllables("available"), 3); // silent trailing-e rule (spoken 4 — known approximation)
        assert_eq!(syllables("Tom"), 1); // capitalized ≠ all-caps acronym
        assert_eq!(syllables("I"), 1);
    }

    #[test]
    fn function_words_discounted() {
        assert!(is_function_word("the"));
        assert!(is_function_word("with"));
        assert!(!is_function_word("meeting"));
        // "the" (1 syl + 2 cons = 2.0 base) discounted below a content monosyllable.
        assert!(word_weight("the") < word_weight("desk"));
        // Trailing punctuation doesn't break the closed-set match.
        assert!(word_weight("to,") < 2.0);
    }
}

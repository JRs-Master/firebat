//! TtsAdapter — ITtsPort 구현. OpenAI(mp3) / Gemini(base64 PCM→WAV) provider TTS API 호출.
//! 키는 Vault(LLM `system:*:api-key` / image `*_API_KEY` 재사용 — 다중 이름 fallback). LC 오디오 생성.
//! 모델·요청/응답 포맷 = reference_tts_api_integration (2026-06-20 검색·확정).

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use firebat_core::ports::{ITtsPort, IVaultPort, InfraResult, TtsLine, TtsRequest, TtsResult, TtsWord};

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
        // 억양/스타일 = Gemini 는 per-speaker 스타일 필드 없음 → 프롬프트 텍스트에 자연어로 합성.
        let mut prompt = String::new();
        if let Some(s) = &req.style {
            if !s.trim().is_empty() {
                prompt.push_str(s.trim());
                prompt.push('\n');
            }
        }
        let speech_config = if req.speakers.is_empty() {
            serde_json::json!({
                "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": req.voice } }
            })
        } else {
            // 화자별 억양은 멀티스피커 config 에 필드가 없어 프롬프트로 지시(Gemini 스타일 제어).
            let accents: Vec<String> = req
                .speakers
                .iter()
                .filter_map(|s| {
                    s.style
                        .as_ref()
                        .filter(|st| !st.trim().is_empty())
                        .map(|st| format!("{} speaks with a {}", s.speaker, st.trim()))
                })
                .collect();
            if !accents.is_empty() {
                prompt.push_str(&accents.join("; "));
                prompt.push_str(".\n");
            }
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
        tracing::info!(target: "tts", mime = %mime, rate = rate, "Gemini TTS PCM 샘플레이트");
        let pcm = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Gemini PCM 디코드: {e}"))?;
        Ok(TtsResult {
            audio: pcm_to_wav(&pcm, rate, 1, 16),
            content_type: "audio/wav".to_string(),
            ext: "wav".to_string(),
            lines: Vec::new(),
        })
    }

    /// Gemini per-turn 병렬 합성 — 3명+ 대화(native multispeaker 는 정확히 2명만 허용). 턴별 단일-스피커
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
                let mut prompt = String::new();
                if let Some(g) = &global_style {
                    if !g.trim().is_empty() {
                        prompt.push_str(g.trim());
                        prompt.push('\n');
                    }
                }
                if let Some(s) = &style {
                    if !s.trim().is_empty() {
                        prompt.push_str(&format!("Speak with a {}.\n", s.trim()));
                    }
                }
                prompt.push_str(&text);
                let body = serde_json::json!({
                    "contents": [{ "parts": [{ "text": prompt }] }],
                    "generationConfig": {
                        "responseModalities": ["AUDIO"],
                        "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } },
                    },
                });
                let url = format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
                    model
                );
                let resp = client
                    .post(&url)
                    .header("x-goog-api-key", &key)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| format!("Gemini per-turn 요청 실패: {e}"))?;
                if !resp.status().is_success() {
                    let st = resp.status();
                    let t = resp.text().await.unwrap_or_default();
                    return Err(format!("Gemini per-turn {st}: {t}"));
                }
                let json: serde_json::Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("per-turn 응답 파싱: {e}"))?;
                let inline = &json["candidates"][0]["content"]["parts"][0]["inlineData"];
                let b64 = inline["data"]
                    .as_str()
                    .ok_or_else(|| "per-turn 응답에 오디오 없음".to_string())?;
                let mime = inline["mimeType"].as_str().unwrap_or("");
                let rate = mime
                    .split(';')
                    .find_map(|s| s.trim().strip_prefix("rate="))
                    .and_then(|r| r.trim().parse::<u32>().ok())
                    .filter(|r| *r >= 8000 && *r <= 48000)
                    .unwrap_or(24000);
                let pcm = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| format!("per-turn PCM 디코드: {e}"))?;
                Ok::<(Vec<u8>, u32), String>((pcm, rate))
            }
        });
        // buffered(6) = 최대 6 동시(rate-limit 안전) + 결과는 입력 순서 보존.
        let results: Vec<Result<(Vec<u8>, u32), String>> =
            futures_util::stream::iter(futs).buffered(6).collect().await;
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
        tracing::info!(target: "tts", turns = n_turns, rate = rate, "Gemini per-turn 병렬 합성");
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

#[async_trait]
impl ITtsPort for TtsAdapter {
    fn effective_config(&self) -> (String, String) {
        self.resolve_config()
    }

    async fn synthesize(&self, req: &TtsRequest) -> InfraResult<TtsResult> {
        // provider/model 비었으면 설정·키에서 해석. 화자/단일 voice 미지정 시 provider 기본 보이스 자동배정.
        let mut req = req.clone();
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
                let list = Self::voices_for_gender(&req.provider, sp.gender.as_deref());
                let i = gcount
                    .entry(sp.gender.clone().unwrap_or_default())
                    .or_insert(0);
                sp.voice = list[(seed + *i) % list.len()].to_string();
                *i += 1;
            }
        }
        let mut result = match req.provider.as_str() {
            "openai" => self.openai(&req).await?,
            // Gemini native multispeaker = 정확히 2명만 → 3명+ 면 per-turn 병렬 합성(화자 무제한·성별 일관).
            "gemini" if req.speakers.len() > 2 => self.gemini_per_turn(&req).await?,
            "gemini" => self.gemini(&req).await?,
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
    let w: String = word.to_lowercase().chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if w.is_empty() {
        return 1;
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
    n.max(1)
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
    // interior silence gaps (양 끝 무음 제외)
    let mut gaps: Vec<(f64, f64, f64)> = Vec::new(); // (start_s, end_s, dur)
    let mut i = 0usize;
    while i < env.len() {
        if env[i] < thr {
            let a = i;
            while i < env.len() && env[i] < thr {
                i += 1;
            }
            if a > 0 && i < env.len() {
                gaps.push((a as f64 * fsec, i as f64 * fsec, (i - a) as f64 * fsec));
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
    // 문장 앵커 = 긴 쉼(≥250ms) 중 시간 길이 top (N-1) → 시간순. 부족하면 char 추정(드문 경우).
    let (starts, ends): (Vec<f64>, Vec<f64>) = if nsent <= 1 {
        (vec![onset0], vec![offset])
    } else {
        let mut long: Vec<&(f64, f64, f64)> = gaps.iter().filter(|g| g.2 >= 0.25).collect();
        if long.len() >= nsent - 1 {
            long.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
            let mut sb: Vec<&(f64, f64, f64)> = long.into_iter().take(nsent - 1).collect();
            sb.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
            let mut st = vec![onset0];
            let mut en = Vec::new();
            for g in &sb {
                st.push(g.1);
                en.push(g.0);
            }
            en.push(offset);
            (st, en)
        } else {
            // 쉼 부족 → char 추정 문장 경계
            let lens: Vec<f64> = parsed
                .iter()
                .map(|(_, t)| t.chars().count().max(1) as f64)
                .collect();
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
    // 문장 span 안 미세 쉼(≥150ms, 단어내 파열음 노이즈 제외)을 검출 → 발화(speech) 구간만 음절-균등 분배,
    // 쉼 구간엔 단어 0 → fill 이 그 thought-group 경계에서 멈췄다 다음 그룹으로 이어짐(연음그룹 단위 동기).
    let mut out: Vec<TtsLine> = Vec::with_capacity(nsent);
    for (idx, (speaker, text)) in parsed.iter().enumerate() {
        let s0 = starts.get(idx).copied().unwrap_or(onset0);
        let s1 = ends.get(idx).copied().unwrap_or(offset).max(s0 + 0.05);
        // 이 문장 안 thought-group 경계 쉼(라인 경계 제외=내부만, ≥150ms 라 파열음 노이즈 제외).
        let mut inner: Vec<(f64, f64)> = gaps
            .iter()
            .filter(|g| g.0 > s0 + 0.02 && g.1 < s1 - 0.02 && g.2 >= 0.15)
            .map(|g| (g.0, g.1))
            .collect();
        inner.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        // 발화 세그먼트 = [s0,s1] 에서 inner 쉼 제외.
        let mut segs: Vec<(f64, f64)> = Vec::new();
        let mut cur = s0;
        for &(ps, pe) in &inner {
            if ps > cur {
                segs.push((cur, ps));
            }
            cur = pe.max(cur);
        }
        if cur < s1 {
            segs.push((cur, s1));
        }
        if segs.is_empty() {
            segs.push((s0, s1));
        }
        let speech_total: f64 = segs.iter().map(|(a, b)| b - a).sum::<f64>().max(1e-3);
        // speech-fraction(0..1) → 실제 시각(쉼 건너뜀). 단어를 발화시간에 균등 → 쉼은 자연히 빈 구간.
        let to_time = |frac: f64| -> f64 {
            let target = frac.clamp(0.0, 1.0) * speech_total;
            let mut accum = 0.0;
            for &(a, b) in &segs {
                let d = b - a;
                if accum + d >= target {
                    return a + (target - accum);
                }
                accum += d;
            }
            s1
        };
        let words: Vec<&str> = text.split_whitespace().collect();
        let weights: Vec<f64> = words.iter().map(|w| syllables(w) as f64).collect();
        let tw: f64 = weights.iter().sum::<f64>().max(1.0);
        let mut acc = 0.0;
        let mut wl: Vec<TtsWord> = Vec::with_capacity(words.len());
        for (k2, w) in words.iter().enumerate() {
            let ws = to_time(acc / tw);
            acc += weights[k2];
            let we = to_time(acc / tw);
            wl.push(TtsWord {
                word: (*w).to_string(),
                start: ws,
                end: we,
            });
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

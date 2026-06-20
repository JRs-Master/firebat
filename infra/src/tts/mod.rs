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
        let b64 = json["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            .as_str()
            .ok_or_else(|| "Gemini TTS 응답에 오디오 데이터 없음".to_string())?;
        let pcm = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Gemini PCM 디코드: {e}"))?;
        Ok(TtsResult {
            audio: pcm_to_wav(&pcm, 24000, 1, 16),
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
        // 단어별 타임스탬프 전사 (Whisper 우선, 없으면 Gemini). 실패 = 빈 → fallback.
        let words = self.transcribe_words(audio, content_type).await;
        if words.is_empty() {
            return Vec::new();
        }
        // 순차 매핑 — 스크립트 줄 = 오디오 순서. 각 줄의 발화 단어 수만큼 전사 단어를 소비.
        // (구두점/병합 차이로 미세 드리프트 가능하나 깨끗한 합성음 + 알려진 순서라 충분.)
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
                speaker,
                text,
                start,
                end,
                words: slice.to_vec(),
            });
        }
        out
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
        // auto — Whisper 우선(정밀), 실패/없으면 Gemini.
        if has_openai {
            if let Ok(w) = self.whisper_words(audio, content_type).await {
                if !w.is_empty() {
                    return w;
                }
            }
        }
        if has_gemini {
            if let Ok(w) = self.gemini_words(audio, content_type).await {
                return w;
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
        let url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
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

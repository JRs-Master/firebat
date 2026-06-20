//! TtsAdapter — ITtsPort 구현. OpenAI(mp3) / Gemini(base64 PCM→WAV) provider TTS API 호출.
//! 키는 Vault(LLM `system:*:api-key` / image `*_API_KEY` 재사용 — 다중 이름 fallback). LC 오디오 생성.
//! 모델·요청/응답 포맷 = reference_tts_api_integration (2026-06-20 검색·확정).

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use firebat_core::ports::{ITtsPort, IVaultPort, InfraResult, TtsRequest, TtsResult};

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
        })
    }
}

#[async_trait]
impl ITtsPort for TtsAdapter {
    async fn synthesize(&self, req: &TtsRequest) -> InfraResult<TtsResult> {
        match req.provider.as_str() {
            "openai" => self.openai(req).await,
            "gemini" => self.gemini(req).await,
            other => Err(format!("알 수 없는 TTS provider: {other}")),
        }
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

"""stt — audio file in, text out, via the OpenAI transcription API.

The chat record button uploads a take to media and leaves its URL in the input box; the user's
sentence routes it here ("받아 적어줘"). The module resolves that URL to the workspace file, posts
it as multipart (stdlib only — no requests dependency for one endpoint), and returns the text.

The API key is the system OpenAI key reused via the declarative vaultKey — no per-module entry.
"""

import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid

API_URL = "https://api.openai.com/v1/audio/transcriptions"
DEFAULT_MODEL = "gpt-4o-mini-transcribe"
MAX_BYTES = 24 * 1024 * 1024  # the API refuses 25MB+; fail here with a better sentence

AUDIO_EXTS = {"webm", "mp3", "wav", "m4a", "mp4", "ogg", "oga", "flac", "mpga", "mpeg"}


def resolve_media_path(raw):
    """Media URL or workspace-relative path -> readable path (sandbox cwd = workspace root)."""
    path = str(raw or "").strip()
    if not path:
        return None, "mediaPath is required"
    if "://" in path:
        rest = path.split("://", 1)[1]
        path = "/" + rest.split("/", 1)[1] if "/" in rest else ""
    path = path.lstrip("/")
    if ".." in path.split("/"):
        return None, f"mediaPath escapes the workspace: {raw}"
    if not os.path.isfile(path):
        return None, f"audio file not found: {path} (workspace-relative)"
    return path, None


def build_multipart(fields, file_field, filename, file_bytes, content_type):
    """dict + one file -> (body bytes, boundary). Stdlib multipart, RFC 2046 shaped."""
    boundary = f"----firebat-stt-{uuid.uuid4().hex}"
    parts = []
    for k, v in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; "
        f"filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n".encode()
    )
    parts.append(file_bytes)
    parts.append(f"\r\n--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def action_transcribe(inp):
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not key:
        return {"success": False, "action": "transcribe",
                "error": "OPENAI_API_KEY is not set — register the system OpenAI key in settings"}

    path, err = resolve_media_path(inp.get("mediaPath"))
    if err:
        return {"success": False, "action": "transcribe", "error": err}

    ext = path.rsplit(".", 1)[-1].lower()
    if ext not in AUDIO_EXTS:
        return {"success": False, "action": "transcribe",
                "error": f"not an audio file the API accepts (.{ext}) — "
                         f"one of: {', '.join(sorted(AUDIO_EXTS))}"}
    size = os.path.getsize(path)
    if size > MAX_BYTES:
        return {"success": False, "action": "transcribe",
                "error": f"audio too large for the API ({size // (1024 * 1024)}MB > 24MB) — "
                         "split the recording"}

    with open(path, "rb") as fh:
        blob = fh.read()

    model = os.environ.get("MODULE_STTMODEL", "").strip() or DEFAULT_MODEL
    fields = {"model": model}
    lang = str(inp.get("language") or "").strip()
    if lang:
        fields["language"] = lang
    prompt = str(inp.get("prompt") or "").strip()
    if prompt:
        fields["prompt"] = prompt

    content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    body, boundary = build_multipart(fields, "file", os.path.basename(path), blob, content_type)
    req = urllib.request.Request(
        API_URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        return {"success": False, "action": "transcribe",
                "error": f"transcription API {e.code}: {detail}"}
    except Exception as e:  # noqa: BLE001 — network failure should name itself
        return {"success": False, "action": "transcribe", "error": f"transcription failed: {e}"}

    text = str(payload.get("text") or "").strip()
    if not text:
        return {"success": False, "action": "transcribe",
                "error": "the API returned no text (empty or unintelligible audio?)"}
    return {"success": True, "action": "transcribe",
            "data": {"text": text, "model": model, "sourcePath": path, "bytes": size}}


def action_selftest():
    checks = []

    def ck(name, ok):
        checks.append({"name": name, "ok": bool(ok)})

    p, err = resolve_media_path("/user/media/x.webm")
    ck("media URL resolves to a workspace path (missing file named)", p is None and "not found" in (err or ""))
    p, err = resolve_media_path("http://example.com/user/media/y.webm")
    ck("absolute URL sheds scheme and host", p is None and "user/media/y.webm" in (err or ""))
    p, err = resolve_media_path("../etc/passwd")
    ck("path traversal is refused", p is None and "escapes" in (err or ""))

    body, boundary = build_multipart({"model": "m"}, "file", "a.webm", b"\x1a\x45", "audio/webm")
    ck("multipart carries the boundary top and bottom",
       body.startswith(f"--{boundary}".encode()) and body.rstrip().endswith(f"--{boundary}--".encode()))
    ck("multipart carries the file bytes verbatim", b"\x1a\x45" in body)

    failed = [c for c in checks if not c["ok"]]
    return {"success": not failed, "action": "selftest",
            "data": {"checks": checks, "total": len(checks), "failed": len(failed)}}


def main():
    raw = sys.stdin.read()
    try:
        envelope = json.loads(raw or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"success": False, "action": "", "error": f"input JSON: {e}"}))
        return
    inp = envelope.get("data") or envelope
    action = str(inp.get("action") or "").strip()
    if action == "selftest":
        out = action_selftest()
    elif action == "transcribe":
        out = action_transcribe(inp)
    else:
        out = {"success": False, "action": action,
               "error": f"unknown action {action!r} — one of: transcribe, selftest"}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()

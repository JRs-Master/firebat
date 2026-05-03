# Tauri 아이콘

Tauri 빌드 시 필요한 아이콘 파일들. 본 디렉토리에 `tauri.conf.json` 에 박힌 5 파일 placement:

- `32x32.png`
- `128x128.png`
- `128x128@2x.png` (256x256, retina)
- `icon.icns` (macOS)
- `icon.ico` (Windows)

## 자동 생성 (권장)

Tauri CLI 의 `icon` 서브커맨드로 PNG 한 장에서 모든 사이즈 + ICO + ICNS 자동 생성:

```bash
npx @tauri-apps/cli icon path/to/source.png
```

source.png 권장: **1024x1024 PNG** (transparent background).

## 수동 박기

이미 5 파일 박혀있는 경우 그대로 사용. 빌드 시 path 검증.

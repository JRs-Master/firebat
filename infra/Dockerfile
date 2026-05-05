# Phase C — Firebat Core multi-stage Docker build (self-hosted distribution).
#
# Stage 1: rust:alpine 위에서 정적 링크 binary 빌드 (musl libc).
# Stage 2: alpine 3.20 runtime — binary + ca-certificates 만.
#
# 결과: ~15-25MB final image. Anthropic / OpenAI / Gemini API 호출 모두 rustls
# (OS native lib 의존성 0). Vault / DB / Cache / Media 모두 volume mount 로 영속.

# ──────────────────────────────────────────────────────────────────────────
# Stage 1 — builder
# ──────────────────────────────────────────────────────────────────────────
FROM rust:1.83-alpine AS builder

# musl-dev: rusqlite bundled SQLite cc 컴파일용
# pkgconfig: 일부 deps 가 pkg-config 호출
# perl + make: 일부 OpenSSL deps backup (rustls 만 쓰므로 사실상 불필요하지만 안전)
RUN apk add --no-cache \
    musl-dev \
    pkgconfig \
    perl \
    make \
    g++

WORKDIR /app

# proto schema + Cargo workspace
COPY proto /app/proto
COPY core-rust/Cargo.toml core-rust/Cargo.lock core-rust/build.rs /app/core-rust/

# Phase B-17 의 protoc-bin-vendored 가 musl static binary 자동 다운로드.
# 별도 protoc apk install 불필요 — vendored 가 PATH 박음.

# 의존성 캐시 layer — Cargo.toml 만 변경 안 됐으면 deps 컴파일 결과 재사용.
# dummy main.rs 로 deps 만 먼저 빌드 (Cargo 캐시 패턴).
RUN mkdir -p /app/core-rust/src && \
    echo "fn main() {}" > /app/core-rust/src/main.rs && \
    echo "// dummy" > /app/core-rust/src/lib.rs && \
    cd /app/core-rust && \
    cargo build --release --bin firebat-core 2>&1 | tail -20 || true

# 실 소스 복사 후 incremental build
COPY core-rust/src /app/core-rust/src

RUN cd /app/core-rust && \
    cargo build --release --bin firebat-core && \
    strip target/release/firebat-core && \
    ls -lh target/release/firebat-core

# ──────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ──────────────────────────────────────────────────────────────────────────
FROM alpine:3.20

# ca-certificates — rustls 가 system trust store 사용 (Anthropic / OpenAI / Gemini TLS 검증)
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -g 1000 firebat && \
    adduser -D -u 1000 -G firebat firebat

WORKDIR /opt/firebat

# binary + 권한
COPY --from=builder /app/core-rust/target/release/firebat-core /usr/local/bin/firebat-core
RUN chmod +x /usr/local/bin/firebat-core

# data / 미디어 디렉토리 — docker-compose volume mount.
# 부팅 시 firebat-core 가 자동으로 sub-dir 생성하지만 권한 사전 박음.
RUN mkdir -p /opt/firebat/data \
             /opt/firebat/user/media \
             /opt/firebat/system/media \
             /opt/firebat/system/modules \
             /opt/firebat/user/modules && \
    chown -R firebat:firebat /opt/firebat

USER firebat

# 환경 변수 default — docker-compose.yml override 가능
ENV FIREBAT_WORKSPACE_ROOT=/opt/firebat \
    FIREBAT_CORE_LISTEN=0.0.0.0:50051 \
    FIREBAT_TIMEZONE=Asia/Seoul \
    FIREBAT_DEFAULT_MODEL=claude-4-sonnet \
    RUST_LOG=info

EXPOSE 50051

# Phase B-17b 박힘 — SIGTERM 으로 graceful shutdown 정상 작동.
# Docker 가 SIGTERM 보내고 30초 대기 (--stop-timeout) 후 SIGKILL.
STOPSIGNAL SIGTERM

CMD ["/usr/local/bin/firebat-core"]

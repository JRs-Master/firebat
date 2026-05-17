//! Infra-side gRPC service impls — extractor / 외부 영역 의존 영역 박은 service 영역.
//!
//! 옛 영역 = 매 grpc service 영역 core 영역 (port 영역만 의존). 다만 Library 영역 = pdf-extract /
//! sysmod 영역 의존 영역 박은 영역 = infra 영역 박음. Hexagonal 영역 = port 영역 박은 영역 안전 영역.

pub mod library;

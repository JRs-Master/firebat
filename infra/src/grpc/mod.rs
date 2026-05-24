//! Infra-side gRPC service impls — extractor / 외부 라이브러리에 의존하는 service.
//!
//! 옛에는 매 grpc service 가 core 안에 있었음 (port 만 의존). 다만 Library 는 pdf-extract /
//! sysmod 에 의존해서 infra 에 둠. Hexagonal 룰은 port 만 거치면 안전.

pub mod library;

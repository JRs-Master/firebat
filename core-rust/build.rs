//! Build script — proto/firebat.proto 를 Rust 코드로 컴파일.
//!
//! tonic-build 가 service 별 trait + message struct + client/server stub 자동 생성.
//! 생성 결과는 OUT_DIR (target/.../build/firebat-core-*/out/) 에 들어감.
//! src/lib.rs 의 `tonic::include_proto!("firebat.v1")` 로 include.
//!
//! protoc binary 는 protoc-bin-vendored crate 가 OS-별 동봉 — 시스템 설치 의존 0.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // protoc binary 환경 변수 set (tonic-build / prost-build 가 PROTOC 읽음)
    let protoc_path = protoc_bin_vendored::protoc_bin_path()?;
    std::env::set_var("PROTOC", protoc_path);

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile_protos(
            &["../proto/firebat.proto"],
            &["../proto"],
        )?;
    Ok(())
}

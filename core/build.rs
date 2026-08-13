//! Build script — proto/firebat.proto 를 Rust 코드로 컴파일.
//!
//! tonic-build 가 service 별 trait + message struct + client/server stub 자동 생성.
//! 생성 결과는 OUT_DIR (target/.../build/firebat-core-*/out/) 에 들어감.
//! src/lib.rs 의 `tonic::include_proto!("firebat.v1")` 로 include.
//!
//! protoc binary 는 protoc-bin-vendored crate 가 OS-별 동봉 — 시스템 설치 의존 0.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Build stamp — `<pkg version>.<yy.mm.dd.hh.mm>` of the moment this was compiled, UTC (the
    // build runs in GHA, which is UTC). Read back through `firebat_core::BUILD_VERSION`.
    //
    // It answers one question on sight: is the thing running the thing that was just built? Two
    // deploy paths (Rust artifact, frontend bundle) go out separately and either can be forgotten,
    // and the running binary otherwise says nothing about which build it is.
    //
    // Derived, so there is no number to remember to increment. `version.workspace` stays the
    // product version and is the only hand-managed part.
    let stamp = chrono::Utc::now().format("%y.%m.%d.%H.%M");
    let pkg = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    // `1.0.0` → `1.0`: the patch digit is what the stamp replaces.
    let product: String = pkg.split('.').take(2).collect::<Vec<_>>().join(".");
    println!("cargo:rustc-env=FIREBAT_BUILD={product}.{stamp}");

    // protoc binary 환경 변수 set (tonic-build / prost-build 가 PROTOC 읽음)
    let protoc_path = protoc_bin_vendored::protoc_bin_path()?;
    std::env::set_var("PROTOC", protoc_path);

    // file_descriptor_set 생성 — tonic-reflection 의 reflection service 가 사용.
    // OUT_DIR 안 `firebat_descriptor.bin` 생성 → lib.rs 의 include_bytes! 로 노출.
    let out_dir = std::env::var("OUT_DIR")?;
    let descriptor_path = std::path::PathBuf::from(&out_dir).join("firebat_descriptor.bin");

    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .file_descriptor_set_path(&descriptor_path)
        .compile_protos(
            &["../proto/firebat.proto"],
            &["../proto"],
        )?;
    Ok(())
}

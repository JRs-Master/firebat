//! Build Session — Modify(수정 PB) 흐름 테스트: 변경점(requirements) → 적용(implement) 2단계 +
//! Create 흐름 불변(4단계) 회귀 고정. store 는 파일 영속이라 temp FIREBAT_DATA_DIR 필요 없음? —
//! 필요함: OnceLock 전역 store 라 테스트 간 공유되지만 세션 id 로 격리되어 안전.

use firebat_core::utils::build_session::{self, BuildMode, BuildStep};

#[test]
fn modify_flow_skips_design_and_refine() {
    // 수정 빌드: 변경점 → 적용 → 완료 (Design/Refine 스킵)
    let id = build_session::create_session(Some("test-conv-mod"), "버튼 색 바꿔줘", BuildMode::Modify, Some("calc-page"));
    let s = build_session::get_session(&id).unwrap();
    assert_eq!(s.mode, BuildMode::Modify);
    assert_eq!(s.target_slug.as_deref(), Some("calc-page"));
    assert_eq!(s.step, BuildStep::Requirements);

    // M1 프롬프트 = 수정 전용 (get_page 로드 지시)
    let p = build_session::step_prompt(s.step, None, s.mode);
    assert!(p.contains("MODIFY"));
    assert!(p.contains("get_page"));

    // awaiting 게이트 해제(사용자 응답 턴 시뮬레이션) 후 advance → Implement 직행
    build_session::reset_awaiting_for_conv("test-conv-mod");
    build_session::set_step_output(&id, serde_json::json!({"changes": ["색 변경"]}));
    let next = build_session::advance_step(&id).unwrap();
    assert_eq!(next, BuildStep::Implement);
    let p2 = build_session::step_prompt(next, None, BuildMode::Modify);
    assert!(p2.contains("SAME slug"));

    // Implement 완료 → Done
    build_session::reset_awaiting_for_conv("test-conv-mod");
    build_session::set_step_output(&id, serde_json::json!("saved"));
    assert_eq!(build_session::advance_step(&id).unwrap(), BuildStep::Done);
    build_session::finish_session(&id, true);
}

#[test]
fn create_flow_unchanged_four_steps() {
    let id = build_session::create_session(Some("test-conv-create"), "계산기 만들어줘", BuildMode::Create, None);
    let s = build_session::get_session(&id).unwrap();
    assert_eq!(s.mode, BuildMode::Create);
    assert!(s.target_slug.is_none());

    let mut steps = vec![];
    let mut cur = BuildStep::Requirements;
    for _ in 0..5 {
        build_session::reset_awaiting_for_conv("test-conv-create");
        build_session::set_step_output(&id, serde_json::json!("out"));
        match build_session::advance_step(&id) {
            Ok(n) => { steps.push(n); cur = n; }
            Err(_) => break,
        }
        if cur == BuildStep::Done { break; }
    }
    assert_eq!(steps, vec![BuildStep::Design, BuildStep::Refine, BuildStep::Implement, BuildStep::Done]);
    build_session::finish_session(&id, true);
}

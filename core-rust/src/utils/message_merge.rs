//! 대화 메시지 union merge — id 기준 합집합, 동일 id 면 incoming 우선.
//!
//! 옛 TS `core/utils/message-merge.ts` 1:1 port.
//!
//! 사용처:
//! - `ConversationManager.save` — 모바일·PC 동시 쓰기 시 incoming 으로 단순 덮어쓰면 다른 기기 메시지 유실
//! - 향후 임의 다기기 동기화 위치에서도 재사용
//!
//! 정렬: id 안의 숫자 부분 (timestamp) 추출해 시간순.
//! id 형식 가정 — `u-{Date.now()}` / `s-{Date.now()}` / `system-init`.
//! id 에 timestamp 없으면 맨 앞 (ts=0). id 없는 메시지는 따로 모아 뒤에 append.
//!
//! 일반 로직 — 메시지 도메인 분기 X, role/content 무관 id 기반 merge 만.

use serde_json::Value;
use std::collections::BTreeMap;

/// 메시지에서 `id` 필드 추출 (string 일 때만).
fn get_id(m: &Value) -> Option<String> {
    m.as_object()
        .and_then(|o| o.get("id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// id 안의 timestamp 숫자 추출 — 옛 TS regex `/(\d{10,})/` 1:1.
fn get_ts(id: &str) -> u64 {
    // 10자리+ 연속 숫자 첫 매치 → u64.
    let chars: Vec<char> = id.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            let len = i - start;
            if len >= 10 {
                let s: String = chars[start..i].iter().collect();
                return s.parse::<u64>().unwrap_or(0);
            }
        } else {
            i += 1;
        }
    }
    0
}

/// existing + incoming 합집합. 동일 id 면 incoming 우선 (최신 데이터로 덮어쓰기).
/// id 없는 메시지는 incoming 의 순서대로 뒤에 append (PartialEq 비교).
/// 옛 TS `unionMergeMessages` 1:1.
pub fn union_merge_messages(existing: &[Value], incoming: &[Value]) -> Vec<Value> {
    // BTreeMap<id, value> — insertion order 무관, key 기준 lookup
    let mut by_id: BTreeMap<String, Value> = BTreeMap::new();
    let mut no_id_msgs: Vec<Value> = Vec::new();

    for m in existing {
        match get_id(m) {
            Some(id) => {
                by_id.insert(id, m.clone());
            }
            None => no_id_msgs.push(m.clone()),
        }
    }
    for m in incoming {
        match get_id(m) {
            Some(id) => {
                // incoming 우선 — 같은 id 면 덮어쓰기
                by_id.insert(id, m.clone());
            }
            None => {
                if !no_id_msgs.contains(m) {
                    no_id_msgs.push(m.clone());
                }
            }
        }
    }

    // timestamp 순 정렬 — id 에 timestamp 없으면 ts=0 (맨 앞)
    let mut with_id: Vec<(u64, Value)> = by_id
        .into_iter()
        .map(|(id, msg)| (get_ts(&id), msg))
        .collect();
    with_id.sort_by_key(|(ts, _)| *ts);

    let mut out: Vec<Value> = with_id.into_iter().map(|(_, v)| v).collect();
    out.extend(no_id_msgs);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn empty_merge_returns_empty() {
        let out = union_merge_messages(&[], &[]);
        assert!(out.is_empty());
    }

    #[test]
    fn existing_only_preserved() {
        let existing = vec![json!({"id": "u-1700000000000", "text": "안녕"})];
        let out = union_merge_messages(&existing, &[]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["text"], "안녕");
    }

    #[test]
    fn incoming_only_preserved() {
        let incoming = vec![json!({"id": "s-1700000000000", "text": "ack"})];
        let out = union_merge_messages(&[], &incoming);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["text"], "ack");
    }

    #[test]
    fn same_id_incoming_wins() {
        let existing = vec![json!({"id": "u-1700000000000", "text": "오래된"})];
        let incoming = vec![json!({"id": "u-1700000000000", "text": "최신"})];
        let out = union_merge_messages(&existing, &incoming);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["text"], "최신");
    }

    #[test]
    fn different_ids_union() {
        let existing = vec![json!({"id": "u-1700000000000", "text": "PC"})];
        let incoming = vec![json!({"id": "u-1700000001000", "text": "Mobile"})];
        let out = union_merge_messages(&existing, &incoming);
        assert_eq!(out.len(), 2);
        // timestamp 순 정렬 → PC 먼저 (1700000000000), Mobile 나중 (1700000001000)
        assert_eq!(out[0]["text"], "PC");
        assert_eq!(out[1]["text"], "Mobile");
    }

    #[test]
    fn no_id_msgs_appended() {
        let existing = vec![json!({"id": "u-1700000000000", "text": "한 ID"})];
        let incoming = vec![json!({"text": "ID 없음"})];
        let out = union_merge_messages(&existing, &incoming);
        assert_eq!(out.len(), 2);
        // ID 있는 메시지가 먼저, ID 없는 메시지가 뒤
        assert_eq!(out[0]["text"], "한 ID");
        assert_eq!(out[1]["text"], "ID 없음");
    }

    #[test]
    fn no_id_dedup_by_value() {
        let existing = vec![json!({"text": "중복"})];
        let incoming = vec![json!({"text": "중복"})];
        let out = union_merge_messages(&existing, &incoming);
        // 같은 value 면 한 번만
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn system_init_gets_zero_ts_first() {
        // system-init 처럼 timestamp 없는 id 는 ts=0 → 맨 앞
        let existing = vec![
            json!({"id": "u-1700000000000", "text": "유저 메시지"}),
            json!({"id": "system-init", "text": "초기"}),
        ];
        let out = union_merge_messages(&existing, &[]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["text"], "초기"); // ts=0
        assert_eq!(out[1]["text"], "유저 메시지"); // ts=1700000000000
    }

    #[test]
    fn mobile_pc_concurrent_write_no_loss() {
        // 모바일이 메시지 추가하는 동안 PC 도 메시지 추가 — 둘 다 보존
        let existing_on_server = vec![
            json!({"id": "u-1700000000000", "text": "원래 메시지"}),
            json!({"id": "u-1700000001000", "text": "PC 추가"}),
        ];
        let mobile_incoming = vec![
            json!({"id": "u-1700000000000", "text": "원래 메시지"}),
            json!({"id": "u-1700000002000", "text": "모바일 추가"}),
        ];
        let out = union_merge_messages(&existing_on_server, &mobile_incoming);
        assert_eq!(out.len(), 3);
        // 모두 timestamp 순 정렬
        assert_eq!(out[0]["text"], "원래 메시지");
        assert_eq!(out[1]["text"], "PC 추가");
        assert_eq!(out[2]["text"], "모바일 추가");
    }

    #[test]
    fn ts_extraction_finds_first_10digit_run() {
        assert_eq!(get_ts("u-1700000000000"), 1700000000000);
        assert_eq!(get_ts("s-1234567890"), 1234567890);
        // 10자리 미만은 미매칭
        assert_eq!(get_ts("u-123"), 0);
        assert_eq!(get_ts("system-init"), 0);
        assert_eq!(get_ts(""), 0);
    }
}

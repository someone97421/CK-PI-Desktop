use super::*;
use serde_json::json;
use tempfile::tempdir;

const CREATED_AT: &str = "2026-10-11T00:00:00.000Z";

fn message(id: &str, text: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: "user".into(),
        tool_name: None,
        is_error: false,
        blocks: json!([{ "type": "text", "text": text }]),
        meta: None,
        created_at: CREATED_AT.into(),
    }
}

fn cold_read(dir: &Path) -> Vec<MessageRecord> {
    let layout = refresh_layout(dir, "layout-regression", TranscriptLayout::default()).unwrap();
    read_transcript_window_with_layout(dir, "layout-regression", &layout, 0, None)
        .unwrap()
        .messages
}

fn seed_cache(dir: &Path, messages: &[MessageRecord]) {
    write_transcript(dir, "layout-regression", CREATED_AT, messages).unwrap();
    assert_messages(&cold_read(dir), messages);
}

fn assert_messages(actual: &[MessageRecord], expected: &[MessageRecord]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert!(
            serde_json::to_value(actual).unwrap() == serde_json::to_value(expected).unwrap(),
            "message {} must remain unchanged",
            expected.id
        );
    }
}

#[test]
fn cold_layout_preserves_unicode_after_a_growing_rewrite() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "before"),
        message("m3", "last"),
    ];
    seed_cache(dir.path(), &messages);
    messages[1] = message("m2", &"xx中文".repeat(3000));
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    for _ in 0..3 {
        assert_messages(&cold_read(dir.path()), &messages);
    }
}

#[test]
fn cold_layout_preserves_all_messages_after_a_same_length_rewrite() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "a"),
        message("m3", "x中文中文"),
    ];
    seed_cache(dir.path(), &messages);
    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    let previous_len = fs::metadata(&path).unwrap().len();
    messages[1] = message("m2", "a中文");
    messages[2] = message("m3", "x中文");
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), previous_len);
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn cold_layout_ignores_a_previous_zero_identity_cache() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "a"),
        message("m3", "x中文中文"),
    ];
    seed_cache(dir.path(), &messages);
    let layout =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap();
    let cache = layout_cache_path(dir.path(), "layout-regression").unwrap();
    // Emulate an existing Windows cache, without editing user history.
    let offsets = layout
        .message_offsets
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    fs::write(
        &cache,
        format!(
            "0 {}\n{} 0\n{}\n",
            layout.file_len,
            layout.message_count(),
            offsets
        ),
    )
    .unwrap();
    messages[1] = message("m2", "a中文");
    messages[2] = message("m3", "x中文");
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn cold_layout_keeps_append_only_history() {
    let dir = tempdir().unwrap();
    let mut messages = vec![message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize))];
    seed_cache(dir.path(), &messages);
    messages.push(message("m2", "中文😀 appended"));
    append_message(dir.path(), "layout-regression", CREATED_AT, &messages[1]).unwrap();
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn cold_layout_after_updating_an_earlier_message_preserves_the_tail() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "before"),
        message("m3", "last"),
    ];
    seed_cache(dir.path(), &messages);
    messages[1] = message("m2", &"xx中文".repeat(3000));
    assert!(update_message(dir.path(), "layout-regression", &messages[1]).unwrap());
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn an_unsupported_identity_never_persists_a_layout() {
    let dir = tempdir().unwrap();
    let messages = vec![message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize))];
    seed_cache(dir.path(), &messages);
    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    let identity = file_identity(&fs::metadata(path).unwrap());
    assert_eq!(
        layout_cache_path(dir.path(), "layout-regression")
            .unwrap()
            .exists(),
        identity != 0
    );
}

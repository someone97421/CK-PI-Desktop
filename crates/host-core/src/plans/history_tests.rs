use super::*;

#[test]
fn plan_history_returns_authoritative_approved_snapshot_without_rewriting_transcript() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let proposal = submit(&PlanManager, &db, &root, "submit-history");
    let message: sessions::UiMessage = serde_json::from_value(json!({
        "id": "plan-tool", "role": "tool", "content": "Plan submitted",
        "createdAt": proposal.created_at, "toolName": "SubmitPlan",
        "toolCallId": proposal.tool_call_id, "toolStatus": "success",
        "toolResult": { "details": { "proposal": proposal } }
    }))
    .unwrap();
    sessions::append_message(&db, &proposal.session_id, &message, Some(&proposal.turn_id)).unwrap();
    let transcript =
        crate::transcripts::transcript_path(db.data_dir(), &proposal.session_id).unwrap();
    let before = fs::read(&transcript).unwrap();
    PlanManager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("ask"),
            },
        )
        .unwrap();
    fs::remove_file(root.join(&proposal.artifact.as_ref().unwrap().relative_path)).unwrap();
    let detail = sessions::get_session_with_options(
        &db,
        &proposal.session_id,
        sessions::SessionReadOptions {
            content_limit: Some(16),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    let view = serde_json::to_value(detail).unwrap();
    assert_eq!(view["planHistory"][0]["proposal"]["status"], "approved");
    assert_eq!(
        view["planHistory"][0]["proposal"]["markdown"],
        proposal.markdown
    );
    assert_eq!(
        view["planHistory"][0]["proposal"]["artifact"],
        serde_json::to_value(proposal.artifact).unwrap()
    );
    assert_eq!(view["planHistory"][0]["superseded"], false);
    assert_eq!(
        fs::read(transcript).unwrap(),
        before,
        "history projection must not rewrite model evidence"
    );
}

#[test]
fn plan_history_is_page_scoped_survives_reopen_and_retains_superseded_versions() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let first = submit(&PlanManager, &db, &root, "version-one");
    let append = |proposal: &PlanProposal| {
        let message = serde_json::from_value(json!({
            "id": proposal.tool_call_id, "role": "tool", "content": "submitted",
            "createdAt": proposal.created_at, "toolName": "SubmitPlan",
            "toolCallId": proposal.tool_call_id, "toolResult": { "details": { "proposal": proposal } }
        })).unwrap();
        sessions::append_message(&db, &proposal.session_id, &message, Some(&proposal.turn_id))
            .unwrap();
    };
    append(&first);
    PlanManager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &first.id,
                session_id: &first.session_id,
                turn_id: &first.turn_id,
                tool_call_id: &first.tool_call_id,
                version: Some(first.version),
                action: "reject",
                target_permission_mode: None,
            },
        )
        .unwrap();
    sessions::end_turn(&db, &first.turn_id, "completed", None, None, false).unwrap();
    let turn = live_turn(&db, &first.session_id);
    let second = PlanManager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &first.session_id,
                turn_id: &turn,
                tool_call_id: "version-two",
                kind: KIND_PLAN,
                title: "Revised API",
                markdown: "# Revised\n- preserve this version",
                question: "Proceed?",
            },
        )
        .unwrap();
    append(&second);
    assert!(
        history_for_tool_calls(&db, "another-session", &["version-one"])
            .unwrap()
            .is_empty()
    );
    assert!(history_for_tool_calls(&db, &first.session_id, &[])
        .unwrap()
        .is_empty());
    drop(db);
    let reopened = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let latest = sessions::get_session_with_options(
        &reopened,
        &first.session_id,
        sessions::SessionReadOptions {
            message_limit: Some(1),
            content_limit: Some(16),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(latest.plan_history.len(), 1);
    assert_eq!(latest.plan_history[0].proposal.id, second.id);
    assert!(!latest.plan_history[0].superseded);
    let older = sessions::get_session_with_options(
        &reopened,
        &first.session_id,
        sessions::SessionReadOptions {
            message_limit: Some(1),
            message_before: latest.message_start,
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(older.plan_history.len(), 1);
    assert_eq!(older.plan_history[0].proposal.status, STATUS_REJECTED);
    assert_eq!(older.plan_history[0].proposal.markdown, first.markdown);
    assert!(older.plan_history[0].superseded);
}

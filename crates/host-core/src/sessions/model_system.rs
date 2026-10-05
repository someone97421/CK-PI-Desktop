use super::UiMessage;
use anyhow::{anyhow, Result};
use serde_json::Value;

/// Internal model state uses existing transcript metadata, never visible chat text.
pub(super) fn validate(row: &UiMessage) -> Result<()> {
    let Some(record) = &row.model_system else {
        return Ok(());
    };
    let invalid = || anyhow!("Invalid model system record");
    if row.role != "system" || !row.content.is_empty() || record["version"] != 1 {
        return Err(invalid());
    }
    for key in ["beforeMessageId", "afterMessageId"] {
        if record
            .get(key)
            .is_some_and(|value| value.as_str().is_none_or(str::is_empty))
        {
            return Err(invalid());
        }
    }
    let message: Value = serde_json::from_str(record["messageJson"].as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    if message["role"] != "system"
        || !message["content"].is_string()
        || !message["timestamp"]
            .as_f64()
            .is_some_and(|value| (0.0..=8.64e15).contains(&value))
    {
        return Err(invalid());
    }
    if let Some(sections) = message.get("sections") {
        let sections = sections.as_object().ok_or_else(invalid)?;
        if sections
            .values()
            .any(|value| !value.is_null() && !value.is_string())
        {
            return Err(invalid());
        }
    }
    for key in ["toolsAdded", "toolsRemoved"] {
        if let Some(tools) = message.get(key) {
            for tool in tools.as_array().ok_or_else(invalid)? {
                if tool
                    .get("name")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty)
                    || (key == "toolsAdded"
                        && (!tool["description"].is_string() || !tool["parameters"].is_object()))
                {
                    return Err(invalid());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row() -> UiMessage {
        serde_json::from_value(json!({
            "id":"state", "role":"system", "content":"", "createdAt":"2026-10-01T00:00:00Z",
            "modelSystem":{"version":1,"beforeMessageId":"user","messageJson":json!({
                "role":"system","content":"","timestamp":1,
                "sections":{"skills":"catalog"},"toolsAdded":[{"name":"Read","description":"read","parameters":{}}]
            }).to_string()}
        })).unwrap()
    }

    #[test]
    fn state_roundtrips_in_canonical_metadata_and_remaps_fork_anchors() {
        let row = row();
        validate(&row).unwrap();
        let (record, text) = super::super::ui_to_record(&row);
        assert!(text.as_deref().unwrap_or("").is_empty());
        assert_eq!(
            super::super::record_to_ui(record.clone()).model_system,
            row.model_system
        );
        let mut user = row.clone();
        user.id = "user".into();
        user.role = "user".into();
        user.model_system = None;
        let (records, ids, _) =
            super::super::clone_records_for_fork(vec![record, super::super::ui_to_record(&user).0]);
        assert_eq!(
            records[0].meta.as_ref().unwrap()["modelSystem"]["beforeMessageId"],
            ids["user"]
        );
    }

    #[test]
    fn rejects_invalid_state_or_hiding_a_user_message() {
        let mut row = row();
        row.role = "user".into();
        assert!(validate(&row).is_err());
        row.role = "system".into();
        row.model_system.as_mut().unwrap()["version"] = json!(2);
        assert!(validate(&row).is_err());
        row.model_system.as_mut().unwrap()["version"] = json!(1);
        row.model_system.as_mut().unwrap()["messageJson"] = json!("invalid JSON");
        assert!(validate(&row).is_err());
    }
}

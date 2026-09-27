use anyhow::{bail, Result};
use std::collections::BTreeMap;

/// Pins remain flat frontmatter strings; no credential or runtime state is stored here.
pub(super) fn normalize(values: &[String]) -> Result<Vec<String>> {
    let mut pins = Vec::new();
    for value in values {
        let pin = value.trim();
        if pin.is_empty() || pin.chars().any(char::is_control) {
            bail!("SUBAGENT_INVALID: fallbackModels entries must be non-empty provider/model pins");
        }
        // Match the definition parser's flat list syntax; delimiters cannot
        // round-trip inside a pin and must never inject another field.
        if pin.contains([',', '[', ']', '\'', '"']) {
            bail!("SUBAGENT_INVALID: fallbackModels contains a frontmatter delimiter");
        }
        super::normalize_model(Some(pin))?;
        if !pins.iter().any(|existing| existing == pin) {
            pins.push(pin.to_string());
        }
    }
    Ok(pins)
}

/// Read the same inline or block list accepted by the shared definition parser.
pub(super) fn parse(raw: &str) -> Result<Vec<String>> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(Vec::new());
    }
    let mut values = Vec::new();
    let mut collecting = false;
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if collecting {
            if let Some(value) = line.strip_prefix("- ") {
                values.push(unquote(value));
                continue;
            }
        }
        collecting = false;
        if let Some((key, value)) = line.split_once(':') {
            if key.to_lowercase().replace(['-', '_', ' '], "") == "fallbackmodels" {
                values.clear();
                let value = value.trim();
                collecting = value.is_empty();
                if !collecting {
                    values.extend(
                        value
                            .trim_matches(['[', ']'])
                            .split(',')
                            .map(unquote)
                            .filter(|pin| !pin.is_empty()),
                    );
                }
            }
        }
    }
    normalize(&values)
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches(['\'', '"']).trim().to_string()
}


/// Keep only valid overrides for pins that remain in `fallbackModels`.
pub(super) fn normalize_thinking_levels(
    values: &BTreeMap<String, String>,
    fallback_models: &[String],
) -> BTreeMap<String, String> {
    let mut levels = BTreeMap::new();
    for (pin, level) in values {
        let pin = pin.trim();
        if fallback_models.iter().any(|fallback| fallback == pin) {
            if let Some(level) = super::normalize_thinking(Some(level)) {
                levels.insert(pin.to_string(), level);
            }
        }
    }
    levels
}

/// Read inline or block fallback-thinking entries from document frontmatter.
pub(super) fn parse_thinking_levels(
    raw: &str,
    fallback_models: &[String],
) -> Result<BTreeMap<String, String>> {
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Ok(BTreeMap::new());
    }
    let mut entries = Vec::new();
    let mut collecting = false;
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if collecting {
            if let Some(value) = line.strip_prefix("- ") {
                entries.push(unquote(value));
                continue;
            }
        }
        collecting = false;
        if let Some((key, value)) = line.split_once(':') {
            if key.to_lowercase().replace(['-', '_', ' '], "") == "fallbackthinkinglevels" {
                entries.clear();
                let value = value.trim();
                collecting = value.is_empty();
                if !collecting {
                    entries.extend(
                        value
                            .trim_matches(['[', ']'])
                            .split(',')
                            .map(unquote)
                            .filter(|entry| !entry.is_empty()),
                    );
                }
            }
        }
    }

    let mut values = BTreeMap::new();
    for entry in entries {
        let Some((pin, level)) = entry.rsplit_once('=') else {
            bail!("SUBAGENT_INVALID: fallbackThinkingLevels entries must be pin=thinkingLevel");
        };
        let pin = pin.trim();
        if pin.is_empty() {
            bail!("SUBAGENT_INVALID: fallbackThinkingLevels entries must be pin=thinkingLevel");
        }
        values.insert(pin.to_string(), level.trim().to_string());
    }
    Ok(normalize_thinking_levels(&values, fallback_models))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordered_lists_accept_both_spellings_and_preserve_model_slashes() {
        for list in [
            "fallbackModels: [a/one, b/vendor/two, a/one]",
            "fallback-models:\n  - a/one\n  - 'b/vendor/two'\n  - a/one",
        ] {
            let raw = format!("---\n{list}\n---\nBody");
            assert_eq!(parse(&raw).unwrap(), vec!["a/one", "b/vendor/two"]);
        }
    }

    #[test]
    fn invalid_pins_and_frontmatter_injection_are_rejected() {
        for pin in [
            "",
            "model",
            "/model",
            "vendor/",
            "vendor/model\npermission: auto",
            "vendor/model, other/model",
        ] {
            assert!(normalize(&[pin.to_string()]).is_err(), "{pin}");
        }
        assert_eq!(normalize(&[]).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn thinking_overrides_split_at_the_last_equals_and_match_full_pins() {
        let raw = "---\nfallbackModels: [gateway/model=revision, backup/other]\nfallbackThinkingLevels: [gateway/model=revision=high, backup/other=omit, unknown/model=low]\n---\nBody";
        let fallback_models = parse(raw).unwrap();
        let levels = parse_thinking_levels(raw, &fallback_models).unwrap();
        assert_eq!(levels.get("gateway/model=revision").map(String::as_str), Some("high"));
        assert_eq!(levels.get("backup/other").map(String::as_str), Some("omit"));
        assert!(!levels.contains_key("unknown/model"));
    }

    #[test]
    fn thinking_overrides_accept_every_existing_thinking_level() {
        let all_levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "omit"];
        let values = all_levels
            .iter()
            .enumerate()
            .map(|(index, level)| (format!("backup/model-{index}"), (*level).to_string()))
            .collect::<BTreeMap<_, _>>();
        let fallback_models = values.keys().cloned().collect::<Vec<_>>();
        assert_eq!(normalize_thinking_levels(&values, &fallback_models), values);
    }
}

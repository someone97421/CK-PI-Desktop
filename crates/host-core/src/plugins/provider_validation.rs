use super::{anyhow, bail, validation::require_permission, PluginManifest, Result, Value};

pub(crate) fn validate_declared_provider_oauth(
    id: &str,
    provider: &serde_json::Map<String, Value>,
    auth_kind: &str,
    manifest: &PluginManifest,
) -> Result<()> {
    if auth_kind == "oauth" {
        require_permission(manifest, "provider.oauth", "OAuth providers")?;
        if provider.get("baseUrl").and_then(Value::as_str).is_none() {
            bail!("PLUGIN_INVALID: provider {id} requires baseUrl for OAuth");
        }
    }

    let Some(oauth) = provider.get("oauth") else {
        return Ok(());
    };
    if auth_kind != "oauth" {
        bail!("PLUGIN_INVALID: provider {id} oauth metadata requires authKind oauth");
    }
    let oauth = oauth
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: provider {id} oauth must be an object"))?;
    if let Some(field) = oauth
        .keys()
        .find(|key| key.as_str() != "loginLabel" && key.as_str() != "isSubscription")
    {
        bail!("PLUGIN_INVALID: provider {id} oauth has unsupported field {field}");
    }
    if let Some(login_label) = oauth.get("loginLabel") {
        if login_label
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 128)
            .is_none()
        {
            bail!(
                "PLUGIN_INVALID: provider {id} oauth.loginLabel must be a non-empty string of at most 128 characters"
            );
        }
    }
    if oauth
        .get("isSubscription")
        .is_some_and(|value| !value.is_boolean())
    {
        bail!("PLUGIN_INVALID: provider {id} oauth.isSubscription must be a boolean");
    }
    Ok(())
}

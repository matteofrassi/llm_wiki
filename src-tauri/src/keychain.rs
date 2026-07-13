use std::collections::BTreeMap;

use keyring::{Entry, Error};
use serde_json::Value;

const SERVICE: &str = "com.matteofrassi.llm-wiki";
const STATIC_PATHS: &[&str] = &[
    "llmConfig.apiKey",
    "searchApiConfig.apiKey",
    "embeddingConfig.apiKey",
    "multimodalConfig.apiKey",
    "mineruConfig.token",
    "proxyConfig.url",
    "apiConfig.token",
];

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 256
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_'))
}

fn entry(key: &str) -> Result<Entry, String> {
    if !valid_key(key) {
        return Err("Invalid Keychain entry name".to_string());
    }
    Entry::new(SERVICE, key).map_err(|err| format!("Keychain entry unavailable: {err}"))
}

pub fn store(key: &str, value: &str) -> Result<(), String> {
    entry(key)?
        .set_password(value)
        .map_err(|err| format!("Keychain write failed: {err}"))
}

pub fn remove(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("Keychain delete failed: {err}")),
    }
}

pub fn load(key: &str) -> Result<Option<String>, String> {
    match entry(key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("Keychain read failed: {err}")),
    }
}

#[tauri::command]
pub fn keychain_sync(entries: BTreeMap<String, String>) -> Result<(), String> {
    for (key, value) in entries {
        if value.is_empty() {
            remove(&key)?;
        } else {
            store(&key, &value)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn keychain_hydrate_config(mut config: Value) -> Result<Value, String> {
    hydrate_config(&mut config)?;
    Ok(config)
}

pub fn hydrate_config(config: &mut Value) -> Result<(), String> {
    for path in STATIC_PATHS {
        hydrate_string(config, path)?;
    }
    hydrate_provider_keys(config, "providerConfigs")?;
    hydrate_provider_keys(config, "searchApiConfig.providerConfigs")?;
    hydrate_headers(config)?;
    Ok(())
}

fn hydrate_provider_keys(config: &mut Value, path: &str) -> Result<(), String> {
    let Some(providers) = value_at(config, path).and_then(Value::as_object) else {
        return Ok(());
    };
    let names: Vec<String> = providers.keys().cloned().collect();
    for name in names {
        hydrate_string(config, &format!("{path}.{name}.apiKey"))?;
    }
    Ok(())
}

fn hydrate_headers(config: &mut Value) -> Result<(), String> {
    if value_at(config, "embeddingConfig.extraHeaders").is_none() {
        return Ok(());
    }
    let Some(value) = load("embeddingConfig.extraHeaders")? else {
        return Ok(());
    };
    if let Ok(headers) = serde_json::from_str::<Value>(&value) {
        set_at(config, "embeddingConfig.extraHeaders", headers)
    }
    Ok(())
}

fn hydrate_string(config: &mut Value, path: &str) -> Result<(), String> {
    if value_at(config, path).is_none() {
        return Ok(());
    }
    let Some(value) = load(path)? else {
        return Ok(());
    };
    set_at(config, path, Value::String(value));
    Ok(())
}

fn value_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(value, |current, part| current.get(part))
}

fn set_at(value: &mut Value, path: &str, next: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = value;
    for part in &parts[..parts.len() - 1] {
        if !current.is_object() {
            *current = Value::Object(Default::default());
        }
        current = current
            .as_object_mut()
            .expect("object set above")
            .entry((*part).to_string())
            .or_insert_with(|| Value::Object(Default::default()));
    }
    if !current.is_object() {
        *current = Value::Object(Default::default());
    }
    current
        .as_object_mut()
        .expect("object set above")
        .insert(parts[parts.len() - 1].to_string(), next);
}

#[cfg(test)]
mod tests {
    use super::{set_at, valid_key, value_at};
    use serde_json::json;

    #[test]
    fn only_accepts_stable_keychain_entry_names() {
        assert!(valid_key("llmConfig.apiKey"));
        assert!(!valid_key("../../bad"));
        assert!(!valid_key(""));
    }

    #[test]
    fn sets_nested_values_without_overwriting_siblings() {
        let mut value = json!({ "apiConfig": { "enabled": true } });
        set_at(&mut value, "apiConfig.token", json!("value"));
        assert_eq!(value_at(&value, "apiConfig.enabled"), Some(&json!(true)));
        assert_eq!(value_at(&value, "apiConfig.token"), Some(&json!("value")));
    }
}

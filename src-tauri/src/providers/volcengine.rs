//! Volcengine Ark Coding Plan adapter & SigV4 signer (Apache-2.0 / Pulse 442a9c5).
use crate::types::ProviderUsage;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        let hash = Sha256::digest(key);
        k[..32].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0u8; 64];
    let mut opad = [0u8; 64];
    for i in 0..64 {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(&ipad);
    inner.update(msg);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(&opad);
    outer.update(&inner_hash);
    outer.finalize().into()
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

pub struct Signer;

impl Signer {
    pub fn sign(
        method: &str,
        url_str: &str,
        body: &[u8],
        content_type: &str,
        ak: &str,
        sk: &str,
        region: &str,
        now: DateTime<Utc>,
    ) -> Result<HashMap<String, String>, String> {
        let timestamp = now.format("%Y%m%dT%H%M%SZ").to_string();
        let day = now.format("%Y%m%d").to_string();
        let payload_hash = hex_encode(&Sha256::digest(body));

        let parsed_url = reqwest::Url::parse(url_str).map_err(|e| e.to_string())?;
        let host = parsed_url.host_str().unwrap_or("open.volcengineapi.com");
        let path = if parsed_url.path().is_empty() { "/" } else { parsed_url.path() };

        let mut query_pairs: Vec<(String, String)> = parsed_url.query_pairs().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        query_pairs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let canonical_query = query_pairs
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("&");

        let signed_headers = "content-type;host;x-content-sha256;x-date";
        let canonical_request = format!(
            "{}\n{}\n{}\ncontent-type:{}\nhost:{}\nx-content-sha256:{}\nx-date:{}\n\n{}\n{}",
            method,
            path,
            canonical_query,
            content_type,
            host,
            payload_hash,
            timestamp,
            signed_headers,
            payload_hash
        );

        let service = "ark";
        let terminator = "request";
        let scope = format!("{}/{}/{}/{}", day, region, service, terminator);
        let canonical_hash = hex_encode(&Sha256::digest(canonical_request.as_bytes()));
        let string_to_sign = format!("HMAC-SHA256\n{}\n{}\n{}", timestamp, scope, canonical_hash);

        let k_date = hmac_sha256(sk.as_bytes(), day.as_bytes());
        let k_region = hmac_sha256(&k_date, region.as_bytes());
        let k_service = hmac_sha256(&k_region, service.as_bytes());
        let k_signing = hmac_sha256(&k_service, terminator.as_bytes());
        let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));

        let auth = format!(
            "HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            ak, scope, signed_headers, signature
        );

        let mut headers = HashMap::new();
        headers.insert("Content-Type".into(), content_type.into());
        headers.insert("Host".into(), host.into());
        headers.insert("X-Date".into(), timestamp);
        headers.insert("X-Content-Sha256".into(), payload_hash);
        headers.insert("Authorization".into(), auth);
        Ok(headers)
    }
}

pub async fn fetch(token: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let token = token.trim();
    if let Some((ak, sk)) = token.split_once(':') {
        let ak = ak.trim();
        let sk = sk.trim();
        if !ak.is_empty() && !sk.is_empty() {
            return fetch_openapi(ak, sk, http).await;
        }
    }
    fetch_arkcli().await
}

async fn fetch_openapi(ak: &str, sk: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let now = Utc::now();
    let region = "cn-beijing";
    let coding_url = "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01";
    let agent_url = "https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01";
    let content_type = "application/x-www-form-urlencoded; charset=utf-8";

    let coding_headers = Signer::sign("GET", coding_url, b"", content_type, ak, sk, region, now)
        .map_err(|e| ProviderUsage::problem("volcengine", "auth", &e))?;
    let mut coding_req = http.get(coding_url);
    for (k, v) in coding_headers {
        coding_req = coding_req.header(k, v);
    }
    let coding_res = crate::providers::response("volcengine", coding_req).await;

    let agent_headers = Signer::sign("GET", agent_url, b"", content_type, ak, sk, region, now)
        .map_err(|e| ProviderUsage::problem("volcengine", "auth", &e))?;
    let mut agent_req = http.get(agent_url);
    for (k, v) in agent_headers {
        agent_req = agent_req.header(k, v);
    }
    let agent_res = crate::providers::response("volcengine", agent_req).await;

    match (coding_res, agent_res) {
        (Ok(c), Ok(a)) => Ok(serde_json::json!({ "coding": c, "afp": a })),
        (Ok(c), Err(_)) => Ok(serde_json::json!({ "coding": c })),
        (Err(_), Ok(a)) => Ok(serde_json::json!({ "afp": a })),
        (Err(e1), Err(_)) => Err(e1),
    }
}

pub async fn fetch_arkcli() -> Result<Value, ProviderUsage> {
    let mut cmd = tokio::process::Command::new("arkcli");
    cmd.args(["usage", "plan", "--format", "json"]);
    cmd.kill_on_drop(true);

    if let Ok(settings) = crate::config::load_settings() {
        match settings.network_proxy.mode.as_str() {
            "manual_http" => {
                let url = format!("http://{}:{}", settings.network_proxy.host, settings.network_proxy.port);
                cmd.env("HTTP_PROXY", &url);
                cmd.env("HTTPS_PROXY", &url);
                cmd.env("ALL_PROXY", &url);
            }
            "manual_socks5" => {
                let url = format!("socks5://{}:{}", settings.network_proxy.host, settings.network_proxy.port);
                cmd.env("ALL_PROXY", &url);
            }
            _ => {}
        }
    }

    let output = match tokio::time::timeout(std::time::Duration::from_secs(6), cmd.output()).await {
        Ok(Ok(out)) => out,
        Ok(Err(_)) => return Err(ProviderUsage::problem("volcengine", "missing_credentials", "未找到 arkcli 命令行工具或已配置的 AccessKey:SecretAccessKey 凭据")),
        Err(_) => return Err(ProviderUsage::problem("volcengine", "timeout", "arkcli 执行超时")),
    };

    if !output.status.success() {
        return Err(ProviderUsage::problem("volcengine", "auth", "arkcli 执行失败，请核对登录状态"));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| ProviderUsage::problem("volcengine", "schema", "arkcli 输出不是有效 JSON"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn upstream_sigv4_test_vector() {
        let hmac1 = hmac_sha256(&[0x0b; 20], b"Hi There");
        assert_eq!(hex_encode(&hmac1), "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");

        let ak = "AKLTTestAccessKeyId";
        let sk = "dGVzdC1zZWNyZXQtYWNjZXNzLWtleQ==";
        let region = "cn-beijing";
        let date = Utc.timestamp_opt(1_788_773_400, 0).unwrap();
        let url = "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01";
        let content_type = "application/x-www-form-urlencoded; charset=utf-8";

        let headers = Signer::sign("GET", url, b"", content_type, ak, sk, region, date).unwrap();
        assert_eq!(headers["X-Date"], "20260907T093000Z");
        assert_eq!(headers["X-Content-Sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

        let expected_auth = "HMAC-SHA256 Credential=AKLTTestAccessKeyId/20260907/cn-beijing/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=3bc6ebb4fd6da065cae0c05dbfc35285cdced26090d7c0aea87b2f2330cd031d";
        assert_eq!(headers["Authorization"], expected_auth);
    }
}

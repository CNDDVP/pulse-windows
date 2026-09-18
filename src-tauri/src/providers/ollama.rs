//! Ollama Cloud provider adapter (Apache-2.0 / Pulse 442a9c5).
use crate::types::ProviderUsage;
use serde_json::Value;

pub async fn fetch(cookie: &str, http: &reqwest::Client) -> Result<Value, ProviderUsage> {
    let cookie = cookie.trim();
    if cookie.is_empty() {
        return Err(ProviderUsage::problem("ollama", "missing_credentials", "未提供 Ollama Cloud 会话 Cookie"));
    }

    let normalized = if cookie.to_lowercase().starts_with("cookie:") {
        cookie[7..].trim().to_string()
    } else if !cookie.contains('=') {
        format!("wos-session={cookie}")
    } else {
        cookie.to_string()
    };

    let url = "https://ollama.com/settings";
    let resp = http.get(url)
        .header("Cookie", normalized)
        .header("Accept", "text/html")
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .send()
        .await
        .map_err(|_| ProviderUsage::problem("ollama", "network", "无法连接 ollama.com"))?;

    let status = resp.status().as_u16();
    if status == 401 || status == 403 || (300..=399).contains(&status) {
        return Err(ProviderUsage::problem("ollama", "auth", "Ollama Cloud 会话 Cookie 已失效或未登录"));
    }
    if !resp.status().is_success() {
        return Err(ProviderUsage::problem("ollama", "server", "Ollama 服务响应异常"));
    }

    let text = resp.text().await.map_err(|_| ProviderUsage::problem("ollama", "network", "读取 Ollama 页面失败"))?;
    if text.contains("action=\"/signin\"") || text.contains("action=\"/login\"") {
        return Err(ProviderUsage::problem("ollama", "auth", "Ollama 会话已登出，请重新登录获取 Cookie"));
    }

    // Extract session & weekly usage from HTML
    let mut session_pct: Option<f64> = None;
    let mut session_reset: Option<String> = None;
    let mut weekly_pct: Option<f64> = None;
    let mut weekly_reset: Option<String> = None;

    if let Some(chunk) = slice_after(&text, "Session usage", 1200) {
        session_pct = extract_pct(chunk);
        session_reset = extract_data_time(chunk);
    }
    if let Some(chunk) = slice_after(&text, "Weekly usage", 1200) {
        weekly_pct = extract_pct(chunk);
        weekly_reset = extract_data_time(chunk);
    }

    if session_pct.is_none() && weekly_pct.is_none() {
        return Err(ProviderUsage::problem("ollama", "schema", "未能从 Ollama 设置页解析出额度"));
    }

    Ok(serde_json::json!({
        "session": {
            "percent": session_pct,
            "reset": session_reset
        },
        "weekly": {
            "percent": weekly_pct,
            "reset": weekly_reset
        }
    }))
}

/// Slice up to `span` bytes after `needle`, backing the end off to a char
/// boundary: the settings page carries user text (emails, "×" glyphs) that
/// can straddle an arbitrary byte offset.
fn slice_after<'a>(text: &'a str, needle: &str, span: usize) -> Option<&'a str> {
    let start = text.find(needle)?;
    let mut end = (start + span).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(&text[start..end])
}

fn extract_pct(chunk: &str) -> Option<f64> {
    // Look for pattern like "12% used" or "12.5% used"
    for part in chunk.split("% used") {
        let trimmed = part.trim();
        let num_str: String = trimmed.chars().rev().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let forward: String = num_str.chars().rev().collect();
        if let Ok(n) = forward.parse::<f64>() {
            return Some(n);
        }
    }
    None
}

fn extract_data_time(chunk: &str) -> Option<String> {
    if let Some(pos) = chunk.find("data-time=\"") {
        let rest = &chunk[pos + 11..];
        if let Some(end) = rest.find('\"') {
            return Some(rest[..end].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::slice_after;

    #[test]
    fn slice_backs_off_to_char_boundary() {
        // "×" is 3 bytes; any cut landing mid-codepoint must not panic.
        let html = "Session usage 中×文×夹×杂 12% used data-time=\"1789000000\" rest";
        let chunk = slice_after(html, "Session usage", 20).expect("needle present");
        assert!(chunk.starts_with("Session usage"));
        assert_eq!(slice_after(html, "absent", 5), None);
        let short = "Weekly usage";
        assert_eq!(slice_after(short, "Weekly usage", 1200), Some("Weekly usage"));
    }
}

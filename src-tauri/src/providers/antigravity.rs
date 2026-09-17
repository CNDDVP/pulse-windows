use crate::types::{ProviderUsage, UsageWindow};
use serde_json::Value;
use std::os::windows::process::CommandExt;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

pub async fn fetch_antigravity_usage() -> ProviderUsage {
    // 1. Locate language_server.exe process
    let ps_cmd = "Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json";
    let output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", ps_cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(e) => {
            return ProviderUsage {
                provider_id: "antigravity".to_string(),
                display_name: "Antigravity".to_string(),
                icon: "antigravity".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some(format!("未运行: {}", e)),
            };
        }
    };

    if output.trim().is_empty() {
        return ProviderUsage {
            provider_id: "antigravity".to_string(),
            display_name: "Antigravity".to_string(),
            icon: "antigravity".to_string(),
            state: "unavailable".to_string(),
            primary_percent: 0,
            plan_name: None,
            is_active: false,
            windows: vec![],
            error_message: Some("Antigravity 未在运行".to_string()),
        };
    }

    let parsed_json: Value = match serde_json::from_str(&output) {
        Ok(v) => v,
        Err(_) => {
            return ProviderUsage {
                provider_id: "antigravity".to_string(),
                display_name: "Antigravity".to_string(),
                icon: "antigravity".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("无法解析进程信息".to_string()),
            };
        }
    };

    let items = if let Some(arr) = parsed_json.as_array() {
        arr.clone()
    } else {
        vec![parsed_json]
    };

    let mut found_token = None;
    let mut found_pid = None;

    for item in items {
        let cmdline = item.get("CommandLine").and_then(|c| c.as_str()).unwrap_or("");
        let pid = item.get("ProcessId").and_then(|p| p.as_i64());
        if cmdline.contains("--csrf_token") {
            if let Some(token_part) = cmdline.split("--csrf_token").nth(1) {
                let token = token_part.trim().split_whitespace().next().unwrap_or("");
                if !token.is_empty() {
                    found_token = Some(token.to_string());
                    found_pid = pid;
                    break;
                }
            }
        }
    }

    let (token, pid) = match (found_token, found_pid) {
        (Some(t), Some(p)) => (t, p),
        _ => {
            return ProviderUsage {
                provider_id: "antigravity".to_string(),
                display_name: "Antigravity".to_string(),
                icon: "antigravity".to_string(),
                state: "unavailable".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some("未找到 CSRF Token".to_string()),
            };
        }
    };

    // 2. Find listening ports
    let net_cmd = format!(
        "Get-NetTCPConnection -OwningProcess {} -State Listen | Select-Object -ExpandProperty LocalPort",
        pid
    );
    let port_output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &net_cmd])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_string(),
        Err(_) => String::new(),
    };

    let ports: Vec<u16> = port_output
        .lines()
        .filter_map(|l| l.trim().parse::<u16>().ok())
        .collect();

    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProviderUsage {
                provider_id: "antigravity".to_string(),
                display_name: "Antigravity".to_string(),
                icon: "antigravity".to_string(),
                state: "error".to_string(),
                primary_percent: 0,
                plan_name: None,
                is_active: false,
                windows: vec![],
                error_message: Some(e.to_string()),
            };
        }
    };

    // 3. Query ports
    for port in ports {
        let url = format!(
            "https://127.0.0.1:{}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary",
            port
        );
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("x-codeium-csrf-token", &token)
            .body("{}")
            .send()
            .await;

        if let Ok(res) = resp {
            if res.status().is_success() {
                if let Ok(data) = res.json::<Value>().await {
                    let mut windows = vec![];
                    let mut max_used_percent: u32 = 0;

                    if let Some(groups) = data
                        .get("response")
                        .and_then(|r| r.get("groups"))
                        .and_then(|g| g.as_array())
                    {
                        for group in groups {
                            let g_name = group
                                .get("displayName")
                                .and_then(|n| n.as_str())
                                .unwrap_or("Model");
                            if let Some(buckets) =
                                group.get("buckets").and_then(|b| b.as_array())
                            {
                                for bucket in buckets {
                                    let b_id = bucket
                                        .get("bucketId")
                                        .and_then(|i| i.as_str())
                                        .unwrap_or("bucket");
                                    let b_name = bucket
                                        .get("displayName")
                                        .and_then(|n| n.as_str())
                                        .unwrap_or("Quota");
                                    let rem_frac = bucket
                                        .get("remainingFraction")
                                        .and_then(|f| f.as_f64())
                                        .unwrap_or(1.0);
                                    let reset_time = bucket
                                        .get("resetTime")
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.to_string());

                                    let used_frac = (1.0 - rem_frac).clamp(0.0, 1.0);
                                    let used_pct = (used_frac * 100.0).round() as u32;

                                    if used_pct > max_used_percent {
                                        max_used_percent = used_pct;
                                    }

                                    windows.push(UsageWindow {
                                        id: b_id.to_string(),
                                        name: format!("{} · {}", g_name, b_name),
                                        used_fraction: used_frac,
                                        used_percent: used_pct,
                                        resets_at: reset_time.clone(),
                                        resets_in: reset_time.map(|t| format_reset_time(&t)),
                                    });
                                }
                            }
                        }
                    }

                    // Query plan
                    let status_url = format!(
                        "https://127.0.0.1:{}/exa.language_server_pb.LanguageServerService/GetUserStatus",
                        port
                    );
                    let plan_name = if let Ok(s_res) = client
                        .post(&status_url)
                        .header("Content-Type", "application/json")
                        .header("x-codeium-csrf-token", &token)
                        .body("{}")
                        .send()
                        .await
                    {
                        if let Ok(s_data) = s_res.json::<Value>().await {
                            s_data
                                .get("userStatus")
                                .and_then(|us| us.get("planStatus"))
                                .and_then(|ps| ps.get("planInfo"))
                                .and_then(|pi| pi.get("planName"))
                                .and_then(|pn| pn.as_str())
                                .map(|s| s.to_string())
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                    return ProviderUsage {
                        provider_id: "antigravity".to_string(),
                        display_name: "Antigravity".to_string(),
                        icon: "antigravity".to_string(),
                        state: "live".to_string(),
                        primary_percent: max_used_percent,
                        plan_name,
                        is_active: false,
                        windows,
                        error_message: None,
                    };
                }
            }
        }
    }

    ProviderUsage {
        provider_id: "antigravity".to_string(),
        display_name: "Antigravity".to_string(),
        icon: "antigravity".to_string(),
        state: "unavailable".to_string(),
        primary_percent: 0,
        plan_name: None,
        is_active: false,
        windows: vec![],
        error_message: Some("端口连接失败".to_string()),
    }
}

fn format_reset_time(iso_str: &str) -> String {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso_str) {
        let now = chrono::Utc::now();
        let diff = dt.signed_duration_since(now);
        if diff.num_hours() > 24 {
            format!("{}天后", diff.num_days())
        } else if diff.num_hours() > 0 {
            format!("{}小时后", diff.num_hours())
        } else if diff.num_minutes() > 0 {
            format!("{}分钟后", diff.num_minutes())
        } else {
            "即将刷新".to_string()
        }
    } else {
        iso_str.to_string()
    }
}

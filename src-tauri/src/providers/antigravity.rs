use crate::types::ProviderUsage;
use serde_json::Value;
use super::parsers::{number,window};
pub async fn fetch()->ProviderUsage{
    #[cfg(not(windows))] {return ProviderUsage::problem("antigravity","unsupported","此路线需要 Windows");}
    #[cfg(windows)] {
        // A fixed command, no input from the renderer. stdout never leaves this module.
        let script=r#"Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" | Where-Object { $_.ExecutablePath -match 'Antigravity' } | ForEach-Object { [pscustomobject]@{ command=$_.CommandLine; ports=@(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) } } | ConvertTo-Json -Depth 4 -Compress"#;
        let mut cmd=tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile","-NonInteractive","-Command",script]).creation_flags(0x08000000).kill_on_drop(true);
        let output=match tokio::time::timeout(std::time::Duration::from_secs(8),cmd.output()).await{
            Ok(Ok(o)) if o.status.success() && o.stdout.len()<1024*1024=>o.stdout,
            _=>return ProviderUsage::problem("antigravity","local_service","无法在时限内识别 Antigravity 服务")};
        let value:Value=serde_json::from_slice(&output).unwrap_or(Value::Null);
        let items=value.as_array().cloned().unwrap_or_else(||vec![value]);
        let http=match reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).danger_accept_invalid_certs(true).timeout(std::time::Duration::from_secs(3)).build(){Ok(c)=>c,Err(_)=>return ProviderUsage::problem("antigravity","internal","本地客户端初始化失败")};
        for item in items {
            let cmd=item["command"].as_str().unwrap_or("");
            let Some(tail)=cmd.split("--csrf_token").nth(1)else{continue};
            let token=tail.trim_start_matches([' ','=','"']).split_whitespace().next().unwrap_or("").trim_matches('"');
            if token.is_empty(){continue}
            for port in item["ports"].as_array().into_iter().flatten().take(8){let Some(port)=port.as_u64().filter(|p|*p>0 && *p<=65535)else{continue};
                let url=format!("https://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary");
                if let Ok(v)=super::response("antigravity",http.post(url).header("x-codeium-csrf-token",token).json(&serde_json::json!({}))).await{
                    let mut windows=vec![];
                    for (gi,g) in v.pointer("/response/groups").and_then(Value::as_array).into_iter().flatten().enumerate(){for (bi,b) in g["buckets"].as_array().into_iter().flatten().enumerate(){
                        let Some(left)=number(&b["remainingFraction"]).filter(|n|(0.0..=1.0).contains(n))else{continue};
                        let raw_g=g["displayName"].as_str().unwrap_or("模型");
                        let g_name=match raw_g {
                            "Gemini Models" => "Gemini 模型".to_string(),
                            "Claude and GPT models" => "Claude 与 GPT 模型".to_string(),
                            s if s.ends_with(" Models") => format!("{} 模型",&s[..s.len()-7]),
                            s if s.ends_with(" models") => format!("{} 模型",&s[..s.len()-7]),
                            s => s.to_string(),
                        };
                        let raw_b=b["displayName"].as_str().unwrap_or("额度");
                        let b_name=match raw_b {
                            "Weekly Limit Remaining" => "每周限额",
                            "Five Hour Limit Remaining" => "5小时限额",
                            s if s.contains("Weekly") => "每周限额",
                            s if s.contains("Five Hour") || s.contains("5 Hour") => "5小时限额",
                            s => s,
                        };
                        if let Some(w)=window(&format!("{gi}-{bi}"),&format!("{g_name} · {b_name}"),(1.0-left)*100.0,&b["resetTime"],None){windows.push(w)}
                    }}
                    let mut r=ProviderUsage::reading("antigravity",windows);r.source="Antigravity 本地服务".into();return r;
                }
            }
        }
        ProviderUsage::problem("antigravity","local_service","未发现可读取额度的 Antigravity 本地服务")
    }
}

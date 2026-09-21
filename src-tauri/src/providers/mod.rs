pub mod credentials;
pub mod parsers;
pub mod antigravity;
pub mod volcengine;
pub mod command_code;
pub mod devin;
pub mod ollama;
pub mod xiaomi;

use crate::{secrets::{SecretStore,WindowsSecrets},types::{AppSettings,ProviderConfig,ProviderUsage}};
use std::{sync::Arc,time::Duration};
use tokio::sync::Semaphore;
use serde_json::Value;

pub const IMPLEMENTED:&[&str]=&[
    "claude","codex","antigravity","cursor","copilot","grok","grok-bot",
    "opencode","kimi","zai","zhipu","minimax","minimax-cn","deepseek",
    "volcengine","command-code","devin","ollama","xiaomi","stepfun"
];

pub fn is_network_error(code: &str) -> bool {
    matches!(code, "timeout" | "dns" | "proxy" | "tls" | "connect" | "network")
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxyDetection {
    pub mode: String,
    pub detected_type: String,
    pub address: Option<String>,
    pub detail: String,
}

pub fn detect_proxy(proxy_cfg: &crate::types::NetworkProxySettings) -> ProxyDetection {
    match proxy_cfg.mode.as_str() {
        "manual_http" => ProxyDetection {
            mode: "manual_http".into(),
            detected_type: "manual_http".into(),
            address: Some(format!("{}:{}", proxy_cfg.host, proxy_cfg.port)),
            detail: format!("手动 HTTP 代理 ({}:{})", proxy_cfg.host, proxy_cfg.port),
        },
        "manual_socks5" => ProxyDetection {
            mode: "manual_socks5".into(),
            detected_type: "manual_socks5".into(),
            address: Some(format!("{}:{}", proxy_cfg.host, proxy_cfg.port)),
            detail: format!("手动 SOCKS5 代理 ({}:{})", proxy_cfg.host, proxy_cfg.port),
        },
        _ => {
            if let Ok(env_proxy) = std::env::var("HTTPS_PROXY").or_else(|_| std::env::var("ALL_PROXY")).or_else(|_| std::env::var("HTTP_PROXY")) {
                if !env_proxy.trim().is_empty() {
                    return ProxyDetection {
                        mode: "auto".into(),
                        detected_type: "env_proxy".into(),
                        address: Some(env_proxy.clone()),
                        detail: format!("环境变量代理 ({env_proxy})"),
                    };
                }
            }
            if let Some(sys_proxy) = crate::platform::detect_windows_system_proxy() {
                ProxyDetection {
                    mode: "auto".into(),
                    detected_type: "system_proxy".into(),
                    address: Some(sys_proxy.clone()),
                    detail: format!("Windows 系统代理 ({sys_proxy})"),
                }
            } else {
                ProxyDetection {
                    mode: "auto".into(),
                    detected_type: "direct".into(),
                    address: None,
                    detail: "直连（未检测到系统代理或环境变量代理）".into(),
                }
            }
        }
    }
}

pub fn client_with_proxy(proxy_cfg: &crate::types::NetworkProxySettings) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("PulseWindows/", env!("CARGO_PKG_VERSION")));

    match proxy_cfg.mode.as_str() {
        "manual_http" => {
            let proxy_url = format!("http://{}:{}", proxy_cfg.host, proxy_cfg.port);
            let mut p = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("无效的 HTTP 代理地址: {e}"))?;
            p = p.no_proxy(reqwest::NoProxy::from_string("127.0.0.1,localhost"));
            builder = builder.proxy(p);
        }
        "manual_socks5" => {
            let proxy_url = format!("socks5h://{}:{}", proxy_cfg.host, proxy_cfg.port);
            let mut p = reqwest::Proxy::all(&proxy_url).map_err(|e| format!("无效的 SOCKS5 代理地址: {e}"))?;
            p = p.no_proxy(reqwest::NoProxy::from_string("127.0.0.1,localhost"));
            builder = builder.proxy(p);
        }
        _ => {
            // "auto": 自动使用系统代理与环境变量代理
        }
    }

    builder.build().map_err(|e| format!("无法初始化网络客户端: {e}"))
}

pub fn client()->Result<reqwest::Client,String>{
    client_with_proxy(&crate::types::NetworkProxySettings::default())
}

pub async fn response(id:&str,request:reqwest::RequestBuilder)->Result<Value,ProviderUsage>{
    let host=request.try_clone()
        .and_then(|r|r.build().ok())
        .and_then(|r|r.url().host_str().map(str::to_string))
        .unwrap_or_else(||"目标服务".to_string());
    let mut response=request.send().await.map_err(|e|{
        let host=host.as_str();
        let err_str = e.to_string().to_lowercase();
        let (code, detail) = if e.is_timeout() {
            ("timeout", "连接超时，请检查网络延迟或代理响应".to_string())
        } else if err_str.contains("dns") || err_str.contains("name resolution") || err_str.contains("no such host") {
            ("dns", format!("无法解析 {host} 域名，请检查 DNS 设置或代理规则"))
        } else if err_str.contains("proxy") {
            ("proxy", "无法连接到指定的本地/系统代理端口，请检查代理软件是否已启动".to_string())
        } else if err_str.contains("tls") || err_str.contains("handshake") || err_str.contains("certificate") || err_str.contains("rustls") {
            ("tls", format!("与 {host} 建立安全连接失败（TLS/SSL 握手错误），请检查代理证书或网络拦截"))
        } else if e.is_connect() {
            ("connect", format!("无法建立到 {host} 的网络连接，请检查网络环境或代理配置"))
        } else if e.is_decode() {
            ("decode", format!("{host} 返回的数据无法解码"))
        } else {
            ("network", format!("{host}：{e}"))
        };
        ProviderUsage::problem(id, code, &format!("网络请求失败：{detail}"))
    })?;
    if !response.status().is_success(){
        let status = response.status().as_u16();
        let (code,msg)=match status {
            401 => ("auth", "登录凭据无效或已过期，请重新登录".to_string()),
            403 => ("forbidden", "服务拒绝访问（HTTP 403）；请检查账号权限、区域限制或网络出口（重新登录未必能解决）".to_string()),
            404 => ("not_found", "服务接口不存在（HTTP 404）".to_string()),
            429 => ("rate_limited", "请求频率受限（HTTP 429），稍后自动重试".to_string()),
            300..=399 => ("redirect", "服务重定向已阻止，请核对登录状态".to_string()),
            500..=599 => ("server", format!("服务端暂时异常（HTTP {status}），稍后自动重试")),
            _ => ("server", format!("服务返回异常状态码（HTTP {status}）")),
        };
        let mut r=ProviderUsage::problem(id,code,&msg);
        r.retry_after_seconds=response.headers().get("retry-after").and_then(|h|h.to_str().ok()).and_then(|s|s.parse::<u64>().ok()).map(|n|n.clamp(30,3600));
        return Err(r)
    }
    let mut body=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|ProviderUsage::problem(id,"network","响应读取失败"))?{
        if body.len()+chunk.len()>10*1024*1024{return Err(ProviderUsage::problem(id,"schema","响应超过大小限制"))}body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_|ProviderUsage::problem(id,"schema","服务响应不是有效 JSON"))
}

pub async fn fetch_one(account:&str,cfg:&ProviderConfig,http:&reqwest::Client)->ProviderUsage{
    let id=cfg.provider_id.as_str();
    let started=std::time::Instant::now();
    let mut r=fetch_inner(account,cfg,http).await;
    r.duration_ms=Some(started.elapsed().as_millis() as u64);
    r.account_id=account.into();r.provider_id=id.into();r.display_name=if cfg.label.is_empty(){crate::types::name(id)}else{cfg.label.clone()};
    if r.state=="live"{if let Some(pin)=&cfg.primary_window{if let Some(w)=r.windows.iter().find(|w|&w.id==pin){r.primary_percent=Some(w.used_percent)}}}
    r.checked_at=Some(chrono::Utc::now().to_rfc3339());
    if r.state=="live"{r.last_success_at=r.checked_at.clone();}
    r
}

pub fn scope_of(token:&str)->String{use sha2::Digest;format!("{:x}",sha2::Sha256::digest(token.as_bytes()))}

/// Stored credential first, then the local tool login. Credential Manager and the
/// editor SQLite stores are synchronous, so they run off the async workers.
async fn resolve_credential(account:&str,cfg:&ProviderConfig)->Result<Option<credentials::Credential>,ProviderUsage>{
    let id=cfg.provider_id.clone();
    let account=account.to_string();
    let entered=match tokio::task::spawn_blocking(move||WindowsSecrets.get(&account)).await{Ok(Ok(v))=>v,_=>return Err(ProviderUsage::problem(&id,"credential_store","无法读取 Windows 凭据管理器"))};
    if let Some(token)=entered{
        let account=if id=="codex"{credentials::claims(&token).and_then(|v|v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id").and_then(Value::as_str).map(str::to_string))}else{None};
        return Ok(Some(credentials::Credential{token,account}));
    }
    if cfg.use_local{return Ok(tokio::task::spawn_blocking(move||credentials::local(&id)).await.ok().flatten())}
    Ok(None)
}

/// Antigravity is a local RPC with no credential; a fixed scope lets a transient
/// failure fall back to the last reading like every other account.
const LOCAL_SCOPE:&str="local-rpc";

async fn fetch_inner(account:&str,cfg:&ProviderConfig,http:&reqwest::Client)->ProviderUsage{
    let id=cfg.provider_id.as_str();
    if !IMPLEMENTED.contains(&id){return ProviderUsage::problem(id,"unsupported","此 Provider 尚未完成 Windows 数据路线，不能报告额度")}
    if id=="antigravity"{let mut r=antigravity::fetch().await;if r.scope.is_empty(){r.scope=LOCAL_SCOPE.into();}return r}
    let credential=match resolve_credential(account,cfg).await{Ok(c)=>c,Err(r)=>return r};

    if id=="devin" && credential.is_none() && cfg.use_local {
        let answer=tokio::task::spawn_blocking(devin::fetch_local).await.unwrap_or_else(|_|Err(ProviderUsage::problem("devin","internal","本地状态库读取任务失败")));
        let mut r=match answer {Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.source="Windsurf 本地状态库 → 额度读取".into();
        return r;
    }

    if id=="volcengine" && credential.is_none() && cfg.use_local {
        let answer=volcengine::fetch_arkcli().await;
        let mut r=match answer {Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.source="arkcli 命令行工具 → 额度读取".into();
        return r;
    }

    let Some(credential)=credential else{return ProviderUsage::problem(id,"missing_credentials","未发现可用凭据；请登录对应工具或在账号中保存凭据")};

    if id=="volcengine"{
        let answer=volcengine::fetch(&credential.token,http).await;
        let mut r=match answer{Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.scope=scope_of(&credential.token);
        r.source=if cfg.use_local && !cfg.credential_configured{"本地工具登录 → 服务接口"}else{"已保存凭据 → 服务接口"}.into();
        return r;
    }
    if id=="command-code"{
        let answer=command_code::fetch(&credential.token,http).await;
        let mut r=match answer{Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.scope=scope_of(&credential.token);
        r.source=if cfg.use_local && !cfg.credential_configured{"本地工具登录 → 服务接口"}else{"已保存凭据 → 服务接口"}.into();
        return r;
    }
    if id=="devin"{
        let answer=devin::fetch(Some(&credential.token),http).await;
        let mut r=match answer{Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.scope=scope_of(&credential.token);
        r.source=if cfg.use_local && !cfg.credential_configured{"本地工具登录 → 服务接口"}else{"已保存凭据 → 服务接口"}.into();
        return r;
    }
    if id=="xiaomi"{
        let answer=xiaomi::fetch(&credential.token,http).await;
        let mut r=match answer{Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.scope=scope_of(&credential.token);
        r.source=if cfg.use_local && !cfg.credential_configured{"粘贴的会话 Cookie → 控制台接口"}else{"已保存凭据 → 控制台接口"}.into();
        return r;
    }
    if id=="ollama"{
        let answer=ollama::fetch(&credential.token,http).await;
        let mut r=match answer{Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
        r.scope=scope_of(&credential.token);
        r.source=if cfg.use_local && !cfg.credential_configured{"本地工具登录 → 服务接口"}else{"已保存凭据 → 服务接口"}.into();
        return r;
    }

    let endpoint=match id{
        "claude"=>"https://api.anthropic.com/api/oauth/usage",
        "codex"=>"https://chatgpt.com/backend-api/wham/usage",
        "cursor"=>"https://cursor.com/api/usage-summary",
        "copilot"=>"https://api.github.com/copilot_internal/user",
        "grok"=>"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
        "grok-bot"=>"https://cursor.com/api/dashboard/get-sand-usage-status",
        "kimi"=>"https://api.kimi.com/coding/v1/usages",
        "opencode"=>"https://opencode.ai/zen/go/v1/usage",
        "zai"=>"https://api.z.ai/api/monitor/usage/quota/limit",
        "zhipu"=>"https://open.bigmodel.cn/api/monitor/usage/quota/limit",
        "minimax"=>"https://api.minimax.io/v1/token_plan/remains",
        "minimax-cn"=>"https://api.minimaxi.com/v1/token_plan/remains",
        "deepseek"=>"https://api.deepseek.com/user/balance",
        "stepfun"=>"https://api.stepfun.com/v1/accounts",
        _=>return ProviderUsage::problem(id,"unsupported","此 Provider 尚未配置服务地址")};
    let mut request=if id=="grok-bot"{http.post(endpoint).json(&serde_json::json!({}))}else{http.get(endpoint)};
    if id=="cursor" || id=="grok-bot"{
        let Some(cookie)=credentials::cursor_cookie(&credential.token)else{return ProviderUsage::problem(id,"auth","Cursor 登录已失效或格式不匹配，请重新登录编辑器")};
        request=request.header("Cookie",cookie).header("Origin","https://cursor.com");
    }else if id=="copilot"{request=request.header("Authorization",format!("token {}",credential.token)).header("Editor-Version","vscode/1.96.2").header("Editor-Plugin-Version","copilot-chat/0.26.7").header("X-Github-Api-Version","2025-04-01");}
    else{request=request.bearer_auth(&credential.token);}
    if id=="claude"{request=request.header("anthropic-beta","oauth-2025-04-20");}
    if id=="codex"{if let Some(account)=credential.account{request=request.header("ChatGPT-Account-Id",account);}}
    if id=="grok"{request=request.header("x-xai-token-auth","xai-grok-cli");}
    let mut answer=response(id,request.header("Accept","application/json")).await;
    if ["minimax","minimax-cn"].contains(&id) && answer.as_ref().err().and_then(|r|r.error_code.as_deref())==Some("not_found"){
        answer=response(id,http.get(endpoint.replace("/v1/token_plan/remains","/v1/api/openplatform/coding_plan/remains")).bearer_auth(&credential.token)).await;
    }
    if id=="stepfun" && answer.as_ref().err().and_then(|r|r.error_code.as_deref())==Some("not_found"){
        answer=response(id,http.get("https://api.stepfun.com/step_plan/v1/accounts").bearer_auth(&credential.token).header("Accept","application/json")).await;
    }
    let mut r=match answer {Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
    r.scope=scope_of(&credential.token);
    r.source=if cfg.use_local && !cfg.credential_configured{"本地工具登录 → 服务接口"}else{"已保存凭据 → 服务接口"}.into();
    r
}

pub fn fetch_all_stream(settings:&AppSettings,http:&reqwest::Client,semaphore:Arc<Semaphore>)->tokio::sync::mpsc::Receiver<ProviderUsage>{
    let (tx,rx)=tokio::sync::mpsc::channel(16);
    let mut ordered:Vec<_>=settings.providers.iter().filter(|(_,c)|c.enabled).collect();
    ordered.sort_by_key(|(id,c)|(c.order,*id));
    for (id,cfg) in ordered {
        let id=id.clone();let cfg=cfg.clone();let http=http.clone();let gate=semaphore.clone();let tx=tx.clone();
        tokio::spawn(async move{
            let _permit=gate.acquire_owned().await.expect("semaphore lives for fetch");
            let r=match tokio::time::timeout(Duration::from_secs(25),fetch_one(&id,&cfg,&http)).await {
                Ok(r)=>r,
                Err(_)=>{
                    let mut r=ProviderUsage::problem(&cfg.provider_id,"timeout","查询超时");
                    r.account_id=id.clone();r.display_name=cfg.label.clone();
                    if cfg.provider_id=="antigravity"{r.scope=LOCAL_SCOPE.into();}
                    else if let Ok(Some(c))=resolve_credential(&id,&cfg).await{r.scope=scope_of(&c.token);}
                    r.checked_at=Some(chrono::Utc::now().to_rfc3339());
                    r
                }
            };
            let _=tx.send(r).await;
        });
    }
    rx
}

pub async fn fetch_all_usages(settings:&AppSettings,http:&reqwest::Client,semaphore:Arc<Semaphore>)->Vec<ProviderUsage>{
    let mut rx=fetch_all_stream(settings,http,semaphore);
    let mut out=vec![];
    while let Some(r)=rx.recv().await{
        out.push(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::NetworkProxySettings;

    #[test]
    fn test_client_with_proxy_modes() {
        let auto_cfg = NetworkProxySettings {
            mode: "auto".to_string(),
            host: "127.0.0.1".to_string(),
            port: 7890,
        };
        assert!(client_with_proxy(&auto_cfg).is_ok());

        let http_cfg = NetworkProxySettings {
            mode: "manual_http".to_string(),
            host: "127.0.0.1".to_string(),
            port: 8080,
        };
        assert!(client_with_proxy(&http_cfg).is_ok());

        let socks_cfg = NetworkProxySettings {
            mode: "manual_socks5".to_string(),
            host: "127.0.0.1".to_string(),
            port: 1080,
        };
        assert!(client_with_proxy(&socks_cfg).is_ok());
    }

    #[test]
    fn test_is_network_error() {
        assert!(is_network_error("timeout"));
        assert!(is_network_error("dns"));
        assert!(is_network_error("proxy"));
        assert!(is_network_error("tls"));
        assert!(is_network_error("connect"));
        assert!(is_network_error("network"));

        assert!(!is_network_error("rate_limited"));
        assert!(!is_network_error("auth"));
        assert!(!is_network_error("forbidden"));
        assert!(!is_network_error("server"));
        assert!(!is_network_error("schema"));
    }
}


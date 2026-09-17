pub mod credentials;
pub mod parsers;
pub mod antigravity;
pub mod volcengine;
pub mod command_code;
pub mod devin;
pub mod ollama;

use crate::{secrets::{SecretStore,WindowsSecrets},types::{AppSettings,ProviderConfig,ProviderUsage}};
use std::{sync::Arc,time::Duration};
use tokio::sync::Semaphore;
use serde_json::Value;

pub const IMPLEMENTED:&[&str]=&[
    "claude","codex","antigravity","cursor","copilot","grok","grok-bot",
    "opencode","kimi","zai","zhipu","minimax","minimax-cn","deepseek",
    "volcengine","command-code","devin","ollama"
];

pub fn client()->Result<reqwest::Client,String>{
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("PulseWindows/0.2.0")
        .build()
        .map_err(|_|"无法初始化网络客户端".into())
}

pub async fn response(id:&str,request:reqwest::RequestBuilder)->Result<Value,ProviderUsage>{
    let mut response=request.send().await.map_err(|e|ProviderUsage::problem(id,if e.is_timeout(){"timeout"}else{"network"},"网络请求失败；请检查代理或连接"))?;
    if !response.status().is_success(){
        let (code,msg)=match response.status().as_u16(){401|403=>("auth","凭据失效或权限不足，请重新登录"),429=>("rate_limited","请求频率受限，稍后重试"),404=>("not_found","服务接口不存在"),300..=399=>("redirect","服务重定向已阻止，请核对登录状态"),_=>("server","服务暂时无法提供数据")};
        let mut r=ProviderUsage::problem(id,code,msg);
        r.retry_after_seconds=response.headers().get("retry-after").and_then(|h|h.to_str().ok()).and_then(|s|s.parse::<u64>().ok()).map(|n|n.clamp(30,3600));
        return Err(r)
    }
    let mut body=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|ProviderUsage::problem(id,"network","响应读取失败"))?{
        if body.len()+chunk.len()>2*1024*1024{return Err(ProviderUsage::problem(id,"schema","响应超过大小限制"))}body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_|ProviderUsage::problem(id,"schema","服务响应不是有效 JSON"))
}

pub async fn fetch_one(account:&str,cfg:&ProviderConfig,http:&reqwest::Client)->ProviderUsage{
    let id=cfg.provider_id.as_str();
    let mut r=fetch_inner(account,cfg,http).await;
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
    if id=="antigravity"{let mut r=antigravity::fetch().await;r.scope=LOCAL_SCOPE.into();return r}
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
        "deepseek"=>"https://api.deepseek.com/user/balance",_=>return ProviderUsage::problem(id,"unsupported","此 Provider 尚未配置服务地址")};
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
    let mut r=match answer {Ok(v)=>parsers::parse(id,&v,chrono::Utc::now().timestamp()),Err(r)=>r};
    r.scope=scope_of(&credential.token);
    r.source=if cfg.use_local && !cfg.credential_configured{"本地工具登录 → 服务接口"}else{"已保存凭据 → 服务接口"}.into();
    r
}

pub async fn fetch_all_usages(settings:&AppSettings,http:&reqwest::Client)->Vec<ProviderUsage>{
    let semaphore=Arc::new(Semaphore::new(4));let mut tasks=vec![];
    let mut ordered:Vec<_>=settings.providers.iter().filter(|(_,c)|c.enabled).collect();ordered.sort_by_key(|(id,c)|(c.order,*id));
    for (id,cfg) in ordered {let id=id.clone();let cfg=cfg.clone();let http=http.clone();let gate=semaphore.clone();
        let saved=(id.clone(),cfg.clone());
        tasks.push((saved,tokio::spawn(async move{let _permit=gate.acquire_owned().await.expect("semaphore lives for fetch");
            match tokio::time::timeout(Duration::from_secs(25),fetch_one(&id,&cfg,&http)).await {Ok(r)=>r,Err(_)=>{
                let mut r=ProviderUsage::problem(&cfg.provider_id,"timeout","查询超时");r.account_id=id.clone();r.display_name=cfg.label.clone();
                // Carry the account scope so a transient timeout can fall back to the last good reading.
                if cfg.provider_id=="antigravity"{r.scope=LOCAL_SCOPE.into();}
                else if let Ok(Some(c))=resolve_credential(&id,&cfg).await{r.scope=scope_of(&c.token);}
                r.checked_at=Some(chrono::Utc::now().to_rfc3339());r}}
        })));
    }
    let mut out=vec![];for ((id,cfg),task) in tasks{out.push(match task.await{Ok(r)=>r,Err(_)=>{let mut r=ProviderUsage::problem(&cfg.provider_id,"internal","查询任务失败");r.account_id=id;r.display_name=cfg.label;r}});}out
}

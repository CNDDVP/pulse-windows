use serde_json::Value;
use std::path::{Path,PathBuf};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
pub struct Credential {pub token:String,pub account:Option<String>}
pub fn home_path(env:&str,folder:&str)->Option<PathBuf>{
    std::env::var_os(env).map(PathBuf::from).filter(|p|p.is_absolute()).or_else(||dirs::home_dir().map(|p|p.join(folder)))
}
pub fn json_file(path:&Path)->Option<Value>{
    if std::fs::metadata(path).ok()?.len()>1024*1024{return None}
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}
pub fn claims(token:&str)->Option<Value>{let p=token.split('.').nth(1)?;serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok()?).ok()}
pub fn from_json(provider:&str,v:&Value)->Option<Credential>{
    let paths:&[&str]=match provider{
        "claude"=>&["/claudeAiOauth/accessToken","/accessToken","/token"],
        "codex"=>&["/tokens/access_token","/access_token"],
        "grok"=>&["/id_token","/idToken","/access_token","/accessToken"],
        "opencode"=>&["/opencode-go/key"],"command-code"=>&["/apiKey"],_=>&[]};
    let token=paths.iter().find_map(|p|v.pointer(p)?.as_str()).filter(|s|!s.trim().is_empty())?.to_string();
    let account=if provider=="codex"{v.pointer("/tokens/account_id").and_then(Value::as_str).map(str::to_string).or_else(||claims(&token)?.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")?.as_str().map(str::to_string))}else{None};
    Some(Credential{token,account})
}
pub fn local(provider:&str)->Option<Credential>{
    let paths:Vec<PathBuf>=match provider{
        "claude"=>vec![home_path("CLAUDE_CONFIG_DIR",".claude")?.join(".credentials.json")],
        "codex"=>vec![home_path("CODEX_HOME",".codex")?.join("auth.json")],
        "grok"=>vec![dirs::home_dir()?.join(".grok/auth.json")],
        "opencode"=>vec![home_path("XDG_DATA_HOME",".local/share")?.join("opencode/auth.json")],
        "command-code"=>vec![dirs::home_dir()?.join(".commandcode/auth.json")],
        "copilot"=>{let mut p=vec![dirs::config_dir()?.join("github-copilot/hosts.json"),dirs::config_dir()?.join("github-copilot/apps.json")];p.push(dirs::home_dir()?.join(".config/github-copilot/hosts.json"));p},
        "cursor"|"grok-bot"=>{return cursor().map(|token|Credential{token,account:None})},
        _=>vec![]};
    for p in paths{if let Some(v)=json_file(&p){
        if provider=="copilot"{if let Some(entries)=v.as_object(){for (host,entry) in entries{if host.starts_with("github.com"){if let Some(token)=entry["oauth_token"].as_str(){return Some(Credential{token:token.into(),account:None})}}}}}
        if let Some(c)=from_json(provider,&v){return Some(c)}
    }} None
}
pub fn cursor()->Option<String>{
    let path=dirs::config_dir()?.join("Cursor/User/globalStorage/state.vscdb");
    let db=rusqlite::Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    db.busy_timeout(std::time::Duration::from_millis(500)).ok()?;
    db.query_row("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'",[],|r|{
        let token=match r.get_ref(0)?{
            rusqlite::types::ValueRef::Text(v)=>String::from_utf8_lossy(v).into_owned(),
            rusqlite::types::ValueRef::Blob(v)=>decode_blob(v).unwrap_or_default(),_=>String::new()};Ok(token)
    }).ok().filter(|s|!s.is_empty())
}
pub fn decode_blob(bytes:&[u8])->Option<String>{
    if bytes.len()%2==0 && bytes.iter().skip(1).step_by(2).any(|b|*b==0){String::from_utf16(&bytes.chunks_exact(2).map(|p|u16::from_le_bytes([p[0],p[1]])).collect::<Vec<_>>()).ok()}
    else{String::from_utf8(bytes.to_vec()).ok()}
}
pub fn cursor_cookie(token:&str)->Option<String>{
    let claims=claims(token)?;
    if claims["exp"].as_i64().is_some_and(|e|e<=chrono::Utc::now().timestamp()+60){return None}
    let account=claims["sub"].as_str()?.rsplit('|').next()?;
    if !account.bytes().all(|b|b.is_ascii_alphanumeric()||b"_-".contains(&b)){return None}
    Some(format!("WorkosCursorSessionToken={account}%3A%3A{token}"))
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct StepFunCredentials {
    pub api_key: Option<String>,
    pub oasis_token: Option<String>,
    pub cookie: Option<String>,
    /// P2 #6：是否通过网页登录获得（有完整浏览器会话可续期）。
    /// 手动粘贴的 Token 即使有 cookie 字段也不标记为 web_bound。
    pub web_bound: bool,
}

pub fn clean_oasis_token(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() { return None; }
    if let Some(pos) = s.find("Oasis-Token=") {
        let after = &s[pos + "Oasis-Token=".len()..];
        let token = after.split(';').next()?.trim();
        if !token.is_empty() { return Some(token.to_string()); }
    }
    Some(s.trim_matches(';').trim().to_string())
}

pub fn parse_stepfun_credentials(secret: &str) -> StepFunCredentials {
    let s = secret.trim();
    if s.starts_with('{') && s.ends_with('}') {
        if let Ok(v) = serde_json::from_str::<Value>(s) {
            let api_key = v.get("api_key")
                .or_else(|| v.get("apiKey"))
                .or_else(|| v.get("key"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(str::to_string);
            let oasis_token = v.get("oasis_token")
                .or_else(|| v.get("oasisToken"))
                .or_else(|| v.get("token"))
                .and_then(Value::as_str)
                .and_then(clean_oasis_token)
                .or_else(|| v.get("cookie").and_then(Value::as_str).and_then(clean_oasis_token));
            let cookie = v.get("cookie")
                .or_else(|| v.get("cookies"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(str::to_string);
            // web_bound 迁移：JSON 里 token+cookie 并存的格式只有应用的网页登录
            // 保存流程会产生（手动粘贴走下方裸串分支，恒为 false）——旧凭据缺该
            // 字段时按 true 迁移，避免升级后现有可续期会话被误判为手填而拒绝续期
            let web_bound = v.get("web_bound").and_then(Value::as_bool)
                .unwrap_or(oasis_token.is_some() && cookie.is_some());
            if api_key.is_some() || oasis_token.is_some() || cookie.is_some() {
                return StepFunCredentials { api_key, oasis_token, cookie, web_bound };
            }
        }
    }
    if s.contains("Oasis-Token=") || s.contains("platform.stepfun.com") || s.starts_with("eyJ") {
        let cookie = if s.contains(';') { Some(s.to_string()) } else { None };
        StepFunCredentials {
            api_key: None,
            oasis_token: clean_oasis_token(s),
            cookie,
            web_bound: false,
        }
    } else {
        StepFunCredentials {
            api_key: Some(s.to_string()),
            oasis_token: None,
            cookie: None,
            web_bound: false,
        }
    }
}

/// Blank/omitted fields preserve existing secrets; the delete command removes both.
pub fn merge_stepfun_credentials(old: &str, update: &str) -> String {
    let previous = parse_stepfun_credentials(old);
    let incoming = parse_stepfun_credentials(update);
    let nonempty = |v: Option<String>| v.filter(|s| !s.trim().is_empty());
    serde_json::json!({
        "api_key": nonempty(incoming.api_key).or_else(|| nonempty(previous.api_key)),
        "oasis_token": nonempty(incoming.oasis_token).or_else(|| nonempty(previous.oasis_token)),
        "cookie": nonempty(incoming.cookie).or_else(|| nonempty(previous.cookie)),
        "web_bound": incoming.web_bound || previous.web_bound
    }).to_string()
}

#[cfg(test)] mod tests{
    use super::*;
    #[test]fn nested_claude(){assert_eq!(from_json("claude",&serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic"}})).unwrap().token,"synthetic");}
    #[test]fn sqlite_utf16(){let b:Vec<u8>="synthetic".encode_utf16().flat_map(u16::to_le_bytes).collect();assert_eq!(decode_blob(&b).as_deref(),Some("synthetic"));}
    #[test]fn no_api_key_as_codex_oauth(){assert!(from_json("codex",&serde_json::json!({"OPENAI_API_KEY":"synthetic"})).is_none());}
    #[test]fn web_bound_migration_legacy_json(){
        // 旧版网页登录保存的凭据（无 web_bound 字段，token+cookie 并存）→ 迁移为 true
        let legacy = parse_stepfun_credentials(r#"{"api_key":"k","oasis_token":"eyJt.jw.t","cookie":"Oasis-Token=eyJt.jw.t; INGRESSCOOKIE=x"}"#);
        assert!(legacy.web_bound, "旧 JSON 格式（应用网页登录产物）应迁移为 web_bound=true");
        // 显式 false 尊重存储值
        let explicit = parse_stepfun_credentials(r#"{"oasis_token":"t","web_bound":false}"#);
        assert!(!explicit.web_bound);
    }
    #[test]fn web_bound_manual_paste_stays_false(){
        // 手动粘贴裸 Token / 整串 Cookie → 恒为 false，不误判为可续期会话
        assert!(!parse_stepfun_credentials("eyJhbGciOiJ9.sig.sig").web_bound);
        assert!(!parse_stepfun_credentials("Oasis-Token=eyJx.y.z; other=1").web_bound);
        assert!(!parse_stepfun_credentials(r#"{"api_key":"sk-only"}"#).web_bound);
    }
    #[test]fn test_stepfun_credentials_parsing(){
        let c1 = parse_stepfun_credentials("Jbz085Nk3L7Yk294...");
        assert_eq!(c1.api_key.as_deref(), Some("Jbz085Nk3L7Yk294..."));
        assert_eq!(c1.oasis_token, None);

        let c2 = parse_stepfun_credentials("Oasis-Token=xyz123; other=abc");
        assert_eq!(c2.api_key, None);
        assert_eq!(c2.oasis_token.as_deref(), Some("xyz123"));

        let c3 = parse_stepfun_credentials(r#"{"api_key":"my-key","oasis_token":"Oasis-Token=token456"}"#);
        assert_eq!(c3.api_key.as_deref(), Some("my-key"));
        assert_eq!(c3.oasis_token.as_deref(), Some("token456"));

        let c4 = parse_stepfun_credentials("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...eyJhbGciOi...");
        assert_eq!(c4.api_key, None);
        assert_eq!(c4.oasis_token.as_deref(), Some("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ...eyJhbGciOi..."));
    }
}

/// Explicit token wins over an old Cookie token. Never send conflicting auth values.
pub fn stepfun_cookie(token:&str,cookie:Option<&str>,device:Option<&str>)->String{
 let mut entries=vec![format!("Oasis-Token={token}")];
 if let Some(id)=device{entries.push(format!("Oasis-Webid={id}"));}
 for entry in cookie.unwrap_or("").split(';'){
  if let Some((name,value))=entry.trim().split_once('='){
   if name.eq_ignore_ascii_case("Oasis-Token")||device.is_some()&&name.eq_ignore_ascii_case("Oasis-Webid"){continue}
   if !name.is_empty()&&!entry.contains(['\r','\n']){entries.push(format!("{name}={value}"));}
  }
 }entries.join("; ")
}
pub fn stepfun_expires_at(token:&str)->Option<i64>{claims(token.split("...").next()?).and_then(|c|c["exp"].as_i64())}
pub fn stepfun_same_session(old:&str,new:&str)->bool{
 let old_tail=old.split("...").last().unwrap_or(old);let new_tail=new.split("...").last().unwrap_or(new);
 if old.contains("...")&&new.contains("...")&&old_tail==new_tail{return true}
 let (Some(a),Some(b))=(claims(old_tail),claims(new_tail))else{return false};
 let mut matched=false;
 for key in ["sub","uid","user_id","userId","account_id"]{if let Some(v)=a.get(key).filter(|v|v.as_str().is_some_and(|s|!s.is_empty())||v.as_i64().is_some_and(|n|n>0)){
  if b.get(key)!=Some(v){return false}matched=true;
 }}matched
}
pub fn stepfun_renew_candidate(old:&str,new:&str,now:i64)->bool{
 old!=new&&stepfun_expires_at(new).is_none_or(|exp|exp>now+60)&&stepfun_same_session(old,new)
}

#[cfg(test)]mod stepfun_session_tests{
 use super::*;use serde_json::json;
 fn token(user:&str,exp:i64)->String{format!("e30.{}.sig",URL_SAFE_NO_PAD.encode(json!({"sub":user,"exp":exp}).to_string()))}
 #[test]fn cookie_header_uses_new_token_and_keeps_session_cookie(){let c=stepfun_cookie("new",Some("Oasis-Token=old; Oasis-Webid=old-device; INGRESSCOOKIE=session"),Some("new-device"));assert_eq!(c,"Oasis-Token=new; Oasis-Webid=new-device; INGRESSCOOKIE=session");}
 #[test]fn renewal_rejects_unchanged_expired_and_other_account_tokens(){let old=token("user-a",100);assert!(!stepfun_renew_candidate(&old,&old,200));assert!(!stepfun_renew_candidate(&old,&token("user-a",250),200));assert!(!stepfun_renew_candidate(&old,&token("user-b",1000),200));assert!(stepfun_renew_candidate(&old,&token("user-a",1000),200));assert!(!stepfun_renew_candidate("opaque-old","opaque-new",200));}
 #[test]fn compound_token_uses_access_expiry_not_refresh_expiry(){let t=format!("{}...{}",token("user",100),token("user",10000));assert_eq!(stepfun_expires_at(&t),Some(100));}
}

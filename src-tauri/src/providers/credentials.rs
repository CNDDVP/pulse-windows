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
#[cfg(test)] mod tests{
    use super::*;
    #[test]fn nested_claude(){assert_eq!(from_json("claude",&serde_json::json!({"claudeAiOauth":{"accessToken":"synthetic"}})).unwrap().token,"synthetic");}
    #[test]fn sqlite_utf16(){let b:Vec<u8>="synthetic".encode_utf16().flat_map(u16::to_le_bytes).collect();assert_eq!(decode_blob(&b).as_deref(),Some("synthetic"));}
    #[test]fn no_api_key_as_codex_oauth(){assert!(from_json("codex",&serde_json::json!({"OPENAI_API_KEY":"synthetic"})).is_none());}
}

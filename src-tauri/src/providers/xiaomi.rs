//! Xiaomi Coding Plan (MiMo console) adapter: browser-session cookie routes with the
//! envelope checked inside HTTP 200. Contract per upstream Docs/providers/xiaomi-coding-plan.md.
use crate::types::ProviderUsage;
use serde_json::{json,Value};

const BASE:&str="https://platform.xiaomimimo.com/api/v1";
const KEEP:&[&str]=&["api-platform_serviceToken","userId","api-platform_ph","api-platform_slh"];

fn problem(code:&str,msg:&str)->ProviderUsage{ProviderUsage::problem("xiaomi",code,msg)}

/// Keep only the four console cookies (first occurrence wins), require the two mandatory
/// ones, refuse control characters before anything leaves the process.
pub fn normalize_cookie(raw:&str)->Result<String,String>{
    let mut kept:Vec<(&'static str,String)>=vec![];
    for pair in raw.split(';'){
        let pair=pair.trim();
        if pair.is_empty(){continue}
        let Some((name,value))=pair.split_once('=')else{continue};
        let name=name.trim();
        if let Some(k)=KEEP.iter().find(|k|**k==name){
            if value.chars().any(char::is_control){return Err("Cookie 值包含非法控制字符".into())}
            if !kept.iter().any(|(n,_)|*n==*k){kept.push((k,value.trim().to_string()));}
        }
    }
    for req in ["api-platform_serviceToken","userId"]{
        if !kept.iter().any(|(n,_)|*n==req){return Err(format!("Cookie 缺少必需字段 {req}；请从控制台整行复制会话 Cookie"))}
    }
    Ok(kept.iter().map(|(n,v)|format!("{n}={v}")).collect::<Vec<_>>().join("; "))
}

async fn call(http:&reqwest::Client,cookie:&str,path:&str)->Result<Value,ProviderUsage>{
    let resp=http.get(format!("{BASE}/{path}")).header("Cookie",cookie).header("Accept","application/json")
        .send().await.map_err(|_|problem("network","无法连接小米 MiMo 控制台"))?;
    let status=resp.status().as_u16();
    if status==401||status==403||(300..=399).contains(&status){return Err(problem("auth","小米控制台会话已失效，请重新复制 Cookie"))}
    if status==429{return Err(problem("rate_limited","请求频率受限，稍后重试"))}
    if !resp.status().is_success(){return Err(problem("server","小米控制台暂时不可用"))}
    let v:Value=resp.json().await.map_err(|_|problem("schema","小米控制台响应不是有效 JSON"))?;
    let Some(code)=v["code"].as_i64()else{return Err(problem("schema","小米控制台响应缺少或格式错误的 code 字段"))};
    if code==401||code==403{return Err(problem("auth","会话被控制台拒绝（HTTP 200 内 code）"))}
    if code!=0{return Err(problem("server",&format!("控制台返回业务错误 code {code}")))}
    Ok(v["data"].clone())
}

pub async fn fetch(cookie:&str,http:&reqwest::Client)->Result<Value,ProviderUsage>{
    let cookie=normalize_cookie(cookie).map_err(|m|problem("invalid_credential",&m))?;
    // The ring lives on the usage route: its failure is the provider's failure. The other
    // two only decorate the card and are kept as outcomes, not discarded.
    let usage=call(http,&cookie,"tokenPlan/usage").await?;
    let detail=call(http,&cookie,"tokenPlan/detail").await;
    let balance=call(http,&cookie,"balance").await;
    let items=usage["monthUsage"]["items"].as_array().cloned()
        .ok_or_else(||problem("schema","月度用量响应缺少 monthUsage.items"))?;
    if items.is_empty(){return Err(problem("no_plan","该账号未购买 Coding Plan（按量计费账户）"))}
    Ok(json!({"items":items,"detail":detail.ok(),"balance":balance.ok()}))
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn cookie_filter_keeps_four_and_requires_two(){
        let raw="a=1; api-platform_serviceToken=abc; userId=42; api-platform_ph=ph; userId=99; api-platform_slh=sl; other=x";
        let out=normalize_cookie(raw).unwrap();
        assert_eq!(out,"api-platform_serviceToken=abc; userId=42; api-platform_ph=ph; api-platform_slh=sl");
        assert!(normalize_cookie("api-platform_serviceToken=abc").is_err(),"missing userId refused");
        assert!(normalize_cookie("foo=bar").is_err());
        assert!(normalize_cookie("api-platform_serviceToken=a\nb; userId=1").is_err(),"control char refused");
    }
}

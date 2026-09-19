//! Secrets never enter settings, diagnostics, events or Debug output.
use sha2::{Digest, Sha256};
pub trait SecretStore { fn get(&self,id:&str)->Result<Option<String>,String>; fn put(&self,id:&str,value:&str)->Result<(),String>; fn delete(&self,id:&str)->Result<(),String>; }
pub struct WindowsSecrets;
fn target(id:&str)->Result<Vec<u16>,String> {
    if !crate::types::valid_id(id) { return Err("账号标识无效".into()); }
    let profile_id=crate::config::get_profile_id();
    Ok(format!("PulseWindows/{}/{id}\0",&profile_id).encode_utf16().collect())
}
fn legacy_target(id:&str)->Result<Vec<u16>,String> {
    if !crate::types::valid_id(id) { return Err("账号标识无效".into()); }
    let scope=format!("{:x}",Sha256::digest(crate::config::get_config_dir().to_string_lossy().as_bytes()));
    Ok(format!("PulseWindows/{}/{id}\0",&scope[..24]).encode_utf16().collect())
}
#[cfg(windows)]
impl SecretStore for WindowsSecrets {
    fn get(&self,id:&str)->Result<Option<String>,String> {
        use windows::{core::PCWSTR,Win32::Security::Credentials::*};
        let target=target(id)?;
        unsafe {
            let mut ptr=std::ptr::null_mut();
            if CredReadW(PCWSTR(target.as_ptr()),CRED_TYPE_GENERIC,0,&mut ptr).is_ok() {
                let bytes=std::slice::from_raw_parts((*ptr).CredentialBlob,(*ptr).CredentialBlobSize as usize);
                let result=String::from_utf8(bytes.to_vec()).map_err(|_|"凭据编码无效".into());
                CredFree(ptr.cast());
                return result.map(Some);
            }
            // Check legacy target for automatic migration
            let leg=legacy_target(id)?;
            let mut leg_ptr=std::ptr::null_mut();
            if CredReadW(PCWSTR(leg.as_ptr()),CRED_TYPE_GENERIC,0,&mut leg_ptr).is_ok() {
                let bytes=std::slice::from_raw_parts((*leg_ptr).CredentialBlob,(*leg_ptr).CredentialBlobSize as usize);
                let secret=String::from_utf8(bytes.to_vec()).map_err(|_|"凭据编码无效".to_string())?;
                CredFree(leg_ptr.cast());
                // Write to new target, verify, then remove legacy
                if self.put(id, &secret).is_ok() {
                    let _ = CredDeleteW(PCWSTR(leg.as_ptr()),CRED_TYPE_GENERIC,0);
                }
                return Ok(Some(secret));
            }
            Ok(None)
        }
    }
    fn put(&self,id:&str,value:&str)->Result<(),String> {
        use windows::{core::PWSTR,Win32::Security::Credentials::*};
        if value.trim().is_empty() || value.len()>2560 || value.contains(['\r','\n','\0']) {return Err("凭据为空、过长或包含换行".into())}
        let mut name=target(id)?;
        // Own a mutable copy: CredWriteW takes a mutable blob pointer though it never writes through it.
        let mut blob=value.as_bytes().to_vec();
        let credential=CREDENTIALW { Type:CRED_TYPE_GENERIC,TargetName:PWSTR(name.as_mut_ptr()),
            CredentialBlobSize:blob.len() as u32, CredentialBlob:blob.as_mut_ptr(),
            Persist:CRED_PERSIST_LOCAL_MACHINE, ..Default::default() };
        unsafe { CredWriteW(&credential,0).map_err(|_|"无法写入 Windows 凭据管理器".to_string())?; }
        if self.get(id)?.as_deref()!=Some(value) {return Err("凭据写入校验失败".into())} Ok(())
    }
    fn delete(&self,id:&str)->Result<(),String> {
        use windows::{core::PCWSTR,Win32::Security::Credentials::*};
        let target=target(id)?;
        let leg=legacy_target(id)?;
        unsafe {
            let _ = CredDeleteW(PCWSTR(leg.as_ptr()),CRED_TYPE_GENERIC,0);
            match CredDeleteW(PCWSTR(target.as_ptr()),CRED_TYPE_GENERIC,0) {
                Ok(())=>Ok(()), Err(e) if e.code().0 as u32==0x80070490=>Ok(()), Err(_)=>Err("无法删除 Windows 凭据".into())
            }
        }
    }
}
pub fn clear_profile_credentials()->Result<(),String> {
    let settings=crate::config::load_settings()?;
    // 逐项删除失败不能静默吞掉：用户会以为凭据已清除而实际仍在凭据管理器里。
    let mut failed:Vec<String>=vec![];
    for id in settings.providers.keys() {
        if let Err(e)=WindowsSecrets.delete(id){failed.push(format!("{id}: {e}"));}
    }
    if failed.is_empty(){Ok(())}else{Err(format!("{} 项凭据删除失败——{}",failed.len(),failed.join("；")))}
}
#[cfg(not(windows))]
impl SecretStore for WindowsSecrets {
    fn get(&self,_:&str)->Result<Option<String>,String>{Err("需要 Windows 凭据管理器".into())}
    fn put(&self,_:&str,_:&str)->Result<(),String>{Err("需要 Windows 凭据管理器".into())}
    fn delete(&self,_:&str)->Result<(),String>{Err("需要 Windows 凭据管理器".into())}
}

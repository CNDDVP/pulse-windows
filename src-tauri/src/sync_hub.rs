//! 多设备同步核心（Round 6：docs/ROUND6_PLAN.md）。
//!
//! 架构（MVP 裁剪）：
//! - **托管（host）**：本实例内嵌 tiny_http 线程监听 0.0.0.0:45539，提供
//!   `POST /v1/sync`（接收日聚合整批）与 `GET /v1/devices`（返回全部设备聚合）。
//!   `sync_hub::spawn` 启动的常驻 manager 线程每秒对齐设置：模式非 host 时停服，
//!   绑定失败（端口占用）→ 设置回退 off + 报错（不静默半开）。
//! - **连接（connect）**：同一常驻轮询线程每 60s 向远端 hub 上推自己的聚合并拉取
//!   设备列表，落盘 `sync-devices.json`；host 模式在 hub 确认监听后同样向
//!   127.0.0.1:45539 自注册（统一数据面）——hub 未起（如端口被占）的窗口期不发，
//!   避免把密钥发往占用端口的无关本地进程。
//! - **隐私边界**：仅日聚合（day/source/model/四列 token 计数，取自 daily_archive）
//!   + 设备元信息（设备名、app 版本、hub 收到时间）。转录内容/路径/凭据/账号身份
//!   在类型层面就进不来（线协议结构体 deny_unknown_fields 白名单）。
//!
//! 安全要求（复核重点，均有单测钉住）：
//! - secret 为 128 位随机（OS CSPRNG），只入 Windows 凭据管理器，不进 settings.json；
//! - 所有端点要求 `X-Pulse-Secret`，比较用常量时间实现，失败一律 401（不区分原因防枚举）；
//! - 请求体上限 256KB；JSON 解析失败或任一行校验失败 → 整批拒绝（不落任何部分数据）；
//! - devices.json / sync-devices.json 写入前走 `updater::core::plain()` 同款
//!   路径（拒绝 `..`）与符号链接/重解析点校验，再经 `config::atomic_write` 原子落盘；
//!   hub 不写任何用户可执行路径（文件只落在数据目录）。
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::secrets::SecretStore as _;
use tauri::Emitter as _;

/// hub 默认端口（docs/ROUND6_PLAN.md：默认 45539，绑定 0.0.0.0）。
pub const DEFAULT_PORT: u16 = 45539;
/// 请求体上限 256KB；超出整批拒绝（413）。
pub const MAX_BODY_BYTES: usize = 256 * 1024;
/// 客户端拉取设备列表的响应上限（防御性，正常远小于此值）。
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
/// 客户端轮询周期（docs/ROUND6_PLAN.md：每 60s）。
pub const POLL_SECS: u64 = 60;
/// 鉴权头名。失败一律 401，不区分「缺头/错值」（防枚举）。
pub const SECRET_HEADER: &str = "X-Pulse-Secret";
/// host 角色访问密钥在 Windows 凭据管理器中的存储 ID。
pub const HUB_SECRET_ID: &str = "sync-hub-secret";
/// connect 角色（作为客户端连他人 hub）的远端密钥存储 ID。
pub const CLIENT_SECRET_ID: &str = "sync-client-secret";
/// hub 侧设备聚合落盘文件（数据目录内；写入走 plain() 校验）。
pub const DEVICES_FILE: &str = "devices.json";
/// 客户端拉取快照落盘文件（数据目录内；拉取失败静默保留旧数据）。
pub const SYNC_DEVICES_FILE: &str = "sync-devices.json";
/// 上推聚合的时间窗（最近 30 天）。body 体积由 MAX_PUSH_PAYLOAD_BYTES 硬保证。
pub const SYNC_DAYS: u32 = 30;
/// 单设备上推载荷（序列化后的 SyncPush）字节预算。行数上限（4096 行 × ~100B/行
/// ≈ 392KB）本身并不保证 body 在 hub 的 256KB 限内，故以字节预算独立兜底；
/// 预算恒 ≤ MAX_BODY_BYTES（留 16KB 余量），超出时丢弃最旧的行（保留最新天）。
pub const MAX_PUSH_PAYLOAD_BYTES: usize = 240 * 1024;
/// manager 线程对齐设置的节拍。
const MANAGER_TICK_MS: u64 = 1000;
/// 单 hub 设备数上限（超出整批拒绝新设备）。
const MAX_DEVICES: usize = 64;
/// 单设备日聚合行数上限。
const MAX_DAYS_PER_DEVICE: usize = 4096;
/// 同时处理的请求数上限（超限立即 503）。名额回收由「worker 完成自还」与
/// 「watchdog 超时强制归还」双路径保证，慢客户端无法占尽名额（tiny_http 0.12
/// 对已接受连接无读/写超时入口，阻塞在读上的 worker 靠处理时限兜底）。
const MAX_CONCURRENT_REQUESTS: usize = 16;
/// 单请求处理时限：超时后由 watchdog 归还并发名额（连接与线程交给对端断开回收）。
/// 取值需覆盖合法最坏路径（256KB body 慢链路传输 + 落盘），客户端自身超时为 20s。
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);
/// watchdog 扫描在途表的周期。
const DEADLINE_SWEEP: Duration = Duration::from_secs(5);
/// 停服时等待在途请求收尾的上限（降低旧 server 在途 POST 与重启后新 server
/// 竞争写 devices.json 的窗口；无限期挂起的慢连接不在此保证内）。
const DRAIN_WAIT: Duration = Duration::from_secs(5);

// ---------------------------------------------------------------------------
// 常量时间比较与 secret 生成
// ---------------------------------------------------------------------------

/// 常量时间字符串比较（防时序枚举 secret）：逐字节 XOR 累积，长度差一并折入
/// 结果，中途不提前返回。长度本身不是机密（HTTP 头长度可见），值比较恒定时间。
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let mut diff: usize = a.len() ^ b.len();
    let n = a.len().max(b.len());
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

/// 生成 128 位随机 secret（小写 hex，32 字符）。Windows 走 OS CSPRNG
/// （BCryptGenRandom）；其它平台/失败回退为两个 v4 UUID 逐字节异或（≥120 位熵）。
pub fn generate_secret() -> String {
    let bytes = generate_secret_bytes();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn generate_secret_bytes() -> [u8; 16] {
    #[cfg(windows)]
    {
        use windows::Win32::Security::Cryptography::{BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG};
        let mut buf = [0u8; 16];
        // NTSTATUS 成功即 0；失败回退到 UUID 异或路径。
        if unsafe { BCryptGenRandom(None, &mut buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) }.is_ok() {
            return buf;
        }
    }
    let a = uuid::Uuid::new_v4().into_bytes();
    let b = uuid::Uuid::new_v4().into_bytes();
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = a[i] ^ b[i];
    }
    out
}

// ---------------------------------------------------------------------------
// 线协议（隐私边界在类型层面钉住：deny_unknown_fields 白名单字段）
// ---------------------------------------------------------------------------

/// 单行日聚合（day/source/model + 四列 token 计数），与 ledger::daily_archive 同构。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncDayRow {
    pub day: String,
    pub source: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}
impl SyncDayRow {
    pub fn tokens(&self) -> u64 { self.input + self.output + self.cache_read + self.cache_write }
}

/// 上推载荷（客户端 → hub）。绝不包含：转录内容、路径、凭据、账号身份。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SyncPush {
    pub device_id: String,
    pub device_name: String,
    pub app_version: String,
    pub days: Vec<SyncDayRow>,
}

/// hub 侧设备记录。`last_active` 由 hub 在收到推送时盖时间戳（不信客户端自报）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceRecord {
    pub device_id: String,
    pub device_name: String,
    pub app_version: String,
    pub last_active: String,
    pub days: Vec<SyncDayRow>,
}

/// GET /v1/devices 响应 & sync-devices.json 落盘格式。version 仅在数据变化时递增。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DevicesSnapshot {
    pub version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated_at: Option<String>,
    pub devices: Vec<DeviceRecord>,
}

/// devices.json（hub 持久层）格式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DevicesFileFormat {
    version: u64,
    devices: Vec<DeviceRecord>,
}

fn now_rfc3339() -> String { chrono::Utc::now().to_rfc3339() }

/// YYYY-MM-DD 严格校验（同时拒绝 2026-13-99 这类格式正确但日期无效的值）。
pub fn valid_day(s: &str) -> bool {
    s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn clean_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}

/// 单条设备记录校验（hub 收批与客户端收快照共用同一规则；任一行失败整批拒绝）。
pub fn validate_device_record(d: &DeviceRecord) -> Result<(), String> {
    if !crate::types::valid_id(&d.device_id) { return Err("设备标识无效".into()); }
    if !clean_text(&d.device_name, 100) { return Err("设备名无效".into()); }
    if !clean_text(&d.app_version, 40) { return Err("app 版本无效".into()); }
    if d.last_active.chars().count() > 40 || chrono::DateTime::parse_from_rfc3339(&d.last_active).is_err() {
        return Err("最后活跃时间无效".into());
    }
    validate_days(&d.days)
}

fn validate_days(days: &[SyncDayRow]) -> Result<(), String> {
    if days.len() > MAX_DAYS_PER_DEVICE { return Err("日聚合行数过多".into()); }
    for r in days {
        if !valid_day(&r.day) { return Err(format!("日期无效：{}", r.day)); }
        if !crate::types::valid_id(&r.source) { return Err(format!("来源标识无效：{}", r.source)); }
        if !clean_text(&r.model, 200) { return Err("模型名无效".into()); }
    }
    Ok(())
}

/// 上推整批校验：任一字段/行不合法即拒绝整批（不落任何部分数据）。
pub fn validate_push(p: &SyncPush) -> Result<(), String> {
    if !crate::types::valid_id(&p.device_id) { return Err("设备标识无效".into()); }
    if !clean_text(&p.device_name, 100) { return Err("设备名无效".into()); }
    if !clean_text(&p.app_version, 40) { return Err("app 版本无效".into()); }
    validate_days(&p.days)
}

/// 设备快照整批校验（客户端收 GET 响应后重验，恶意/损坏响应不落盘）。
pub fn validate_snapshot(s: &DevicesSnapshot) -> Result<(), String> {
    if s.devices.len() > MAX_DEVICES { return Err("设备数过多".into()); }
    if let Some(g) = &s.generated_at {
        if g.chars().count() > 40 || chrono::DateTime::parse_from_rfc3339(g).is_err() {
            return Err("生成时间无效".into());
        }
    }
    let mut ids = std::collections::BTreeSet::new();
    for d in &s.devices {
        validate_device_record(d)?;
        if !ids.insert(d.device_id.as_str()) { return Err("设备标识重复".into()); }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// devices.json / sync-devices.json 读写（plain() 路径 + 符号链接校验 + 原子写）
// ---------------------------------------------------------------------------

/// 统一落盘通道：先 `updater::core::plain()` 同款校验（拒绝 `..` 跳转与
/// 符号链接/重解析点祖先），再 `config::atomic_write` 原子替换。
/// hub 与客户端的所有 JSON 落盘都走这里——不写任何用户可执行路径（仅数据目录）。
pub fn write_plain_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    crate::updater::core::plain(path).map_err(|e| format!("写入路径校验失败：{e}"))?;
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "序列化失败".to_string())?;
    crate::config::atomic_write(path, &bytes)
}

/// hub 启动时装载设备表。文件缺失 → 空表；损坏/校验失败 → 保留 `.bad-*` 副本
/// 后从空表开始（与 profile.json 同语义，不静默覆盖坏文件）。
pub fn load_devices_file(path: &Path) -> HubData {
    // 数据目录被换成符号链接等异常形态时拒绝读取（与写入同款校验，fail-closed）。
    if crate::updater::core::plain(path).is_err() {
        return HubData::default();
    }
    let Ok(bytes) = std::fs::read(path) else { return HubData::default() };
    match serde_json::from_slice::<DevicesFileFormat>(&bytes) {
        Ok(f) if f.devices.len() <= MAX_DEVICES && f.devices.iter().all(|d| validate_device_record(d).is_ok()) => {
            HubData { version: f.version, devices: f.devices.into_iter().map(|d| (d.device_id.clone(), d)).collect() }
        }
        _ => {
            let file_name=path.file_name().map(|n|n.to_string_lossy().to_string()).unwrap_or_else(||"devices.json".into());
            let bad = path.with_file_name(format!("{file_name}.bad-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
            // 副本路径与本模块落盘不变式一致：同样过 plain() 校验（拒绝 `..` 与
            // 符号链接/重解析点）。预置同名符号链接时拒绝副本（裸 fs::copy 会写穿
            // 链接），宁可放弃副本也不绕过校验。
            let copied = crate::updater::core::plain(&bad).is_ok() && std::fs::copy(path, &bad).is_ok();
            eprintln!("Pulse: devices.json 损坏（{}），从空设备表开始",
                if copied { format!("副本已存 {}", bad.display()) } else { "副本保留失败".into() });
            HubData::default()
        }
    }
}

/// hub 内存态：version 在每次整批落盘成功后 +1（GET 侧以版本号判断数据是否变化）。
#[derive(Debug, Clone, Default)]
pub struct HubData {
    pub version: u64,
    pub devices: BTreeMap<String, DeviceRecord>,
}

// ---------------------------------------------------------------------------
// hub 服务（tiny_http 托管线程）
// ---------------------------------------------------------------------------

pub struct HubConfig {
    pub port: u16,
    pub secret: String,
    pub devices_path: PathBuf,
}

struct RequestCtx {
    secret: String,
    devices_path: PathBuf,
    devices: Mutex<HubData>,
    active: AtomicUsize,
    /// 在途请求监督表：请求 id → 受理时刻。worker 完成时自摘并归还名额；
    /// 超过 REQUEST_DEADLINE 的条目由 watchdog 摘除并归还名额。两条路径都通过
    /// 「摘到条目者才扣减」保证名额恰好归还一次（panic/spawn 失败/慢读均覆盖）。
    inflight: Mutex<HashMap<u64, Instant>>,
    next_req_id: AtomicU64,
    deadline: Duration,
}

/// 内嵌 hub：bind 即刻成败（端口占用在 start() 返回 Err，由调用方回退设置态）。
/// accept 循环在独立线程；每个请求再分发到有界 worker（慢客户端不阻塞 accept）；
/// watchdog 周期扫描在途请求，超时者强制归还并发名额（服务不被慢客户端钉死）。
pub struct HubServer {
    server: Arc<tiny_http::Server>,
    worker: Option<std::thread::JoinHandle<()>>,
    watchdog: Option<std::thread::JoinHandle<()>>,
    stop_tx: mpsc::Sender<()>,
    ctx: Arc<RequestCtx>,
}

impl HubServer {
    pub fn start(cfg: HubConfig) -> Result<HubServer, String> {
        // 纵深防御：空 secret 与空值头经 constant_time_eq("","")==true 会互相通过。
        // 生产唯一调用方（manager_loop）已有非空守卫，此处再拒一次，杜绝未来新增
        // 调用方以空密钥开机。
        if cfg.secret.is_empty() { return Err("同步访问密钥为空，拒绝启动同步服务".into()); }
        // 先 bind（端口占用即刻失败且零磁盘访问），再装载设备表——绑定失败的重试
        // 拍不做无谓读盘。
        let server = tiny_http::Server::http(("0.0.0.0", cfg.port))
            .map_err(|e| format!("端口 {} 监听失败：{e}", cfg.port))?;
        let data = load_devices_file(&cfg.devices_path);
        let server = Arc::new(server);
        let ctx = Arc::new(RequestCtx {
            secret: cfg.secret,
            devices_path: cfg.devices_path,
            devices: Mutex::new(data),
            active: AtomicUsize::new(0),
            inflight: Mutex::new(HashMap::new()),
            next_req_id: AtomicU64::new(0),
            deadline: REQUEST_DEADLINE,
        });
        // watchdog：单线程周期扫描在途表，超时条目归还并发名额（stop 经 channel 即刻退出）。
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let c4 = ctx.clone();
        let watchdog = std::thread::Builder::new().name("sync-hub-watchdog".into()).spawn(move || {
            loop {
                if stop_rx.recv_timeout(DEADLINE_SWEEP).is_ok() { return; }
                if !sweep_deadlines(&c4) { return; }
            }
        }).map_err(|e| format!("同步服务监督线程启动失败：{e}"))?;
        let s2 = server.clone();
        let c2 = ctx.clone();
        let worker = std::thread::Builder::new().name("sync-hub".into()).spawn(move || {
            for request in s2.incoming_requests() {
                if c2.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONCURRENT_REQUESTS {
                    c2.active.fetch_sub(1, Ordering::SeqCst);
                    respond(request, 503, "{\"error\":\"busy\"}");
                    continue;
                }
                let id = c2.next_req_id.fetch_add(1, Ordering::SeqCst);
                let registered = c2.inflight.lock().map(|mut m| m.insert(id, Instant::now()).is_none()).is_ok();
                if !registered {
                    // 监督表不可用（仅锁中毒可能）：不受理，立即归还名额。
                    c2.active.fetch_sub(1, Ordering::SeqCst);
                    respond(request, 503, "{\"error\":\"busy\"}");
                    continue;
                }
                let c3 = c2.clone();
                let spawned = std::thread::Builder::new().name("sync-hub-req".into()).spawn(move || {
                    handle_request(request, c3.clone());
                    release_slot(&c3, id);
                });
                if spawned.is_err() {
                    // 线程创建失败：请求闭包已被丢弃（连接随之关闭），必须当场归还
                    // 名额，否则每次失败永久泄漏一个名额直至全部 503。
                    release_slot(&c2, id);
                }
            }
        }).map_err(|e| format!("同步服务线程启动失败：{e}"))?;
        Ok(HubServer { server, worker: Some(worker), watchdog: Some(watchdog), stop_tx, ctx })
    }

    pub fn port(&self) -> u16 { self.server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0) }
    pub fn secret(&self) -> &str { &self.ctx.secret }
    pub fn devices_path(&self) -> &Path { &self.ctx.devices_path }
    pub fn device_count(&self) -> usize { self.ctx.devices.lock().map(|d| d.devices.len()).unwrap_or(0) }

    /// 停止：先停 watchdog 与 accept 循环并 join，再有界等待在途请求收尾——
    /// 降低旧 server 的在途 POST 与（secret 重置等场景下）紧随其后的新 server
    /// 竞争写 devices.json 的窗口。慢客户端线程可能仍阻塞在读上（tiny_http 无
    /// 读超时入口），此处只保证有上限的等待，不等待无限期挂起者。
    pub fn stop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(h) = self.watchdog.take() { let _ = h.join(); }
        self.server.unblock();
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
        let deadline = Instant::now() + DRAIN_WAIT;
        while Instant::now() < deadline {
            let quiet = self.ctx.inflight.lock().map(|m| m.is_empty()).unwrap_or(true);
            if quiet { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for HubServer {
    fn drop(&mut self) { self.stop(); }
}

/// 归还并发名额：仅当本路径从监督表摘到条目时扣减。watchdog 已超时摘除过的条目
/// 不会被重复扣减（worker/accept 循环侧摘取返回 None → 不扣减），恰好归还一次。
fn release_slot(ctx: &RequestCtx, id: u64) {
    let own = ctx.inflight.lock().map(|mut m| m.remove(&id).is_some()).unwrap_or(false);
    if own { ctx.active.fetch_sub(1, Ordering::SeqCst); }
}

/// watchdog 一轮扫描：摘除超过处理时限的在途条目并归还并发名额。
/// 返回 false 表示监督表锁不可用（watchdog 线程退出）。
fn sweep_deadlines(ctx: &RequestCtx) -> bool {
    let Ok(mut m) = ctx.inflight.lock() else { return false; };
    let now = Instant::now();
    let expired: Vec<u64> = m.iter()
        .filter(|(_, start)| now.duration_since(**start) >= ctx.deadline)
        .map(|(id, _)| *id)
        .collect();
    for id in expired {
        m.remove(&id);
        ctx.active.fetch_sub(1, Ordering::SeqCst);
        eprintln!("Pulse: 同步请求处理超时，已释放并发名额（连接由对端断开回收）");
    }
    true
}

/// 应答并消费请求（tiny_http::Request::respond 收所有权）。
fn respond(req: tiny_http::Request, code: u16, body: &str) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("static header is valid");
    let resp = tiny_http::Response::from_string(body).with_status_code(code).with_header(header);
    let _ = req.respond(resp);
}

/// 鉴权：缺头或值不匹配一律 401，且在路由之前执行（未鉴权方无法探测路径）。
fn auth_ok(req: &tiny_http::Request, secret: &str) -> bool {
    req.headers().iter().find(|h| h.field.equiv(SECRET_HEADER))
        .map(|h| constant_time_eq(h.value.as_str(), secret))
        .unwrap_or(false)
}

enum BodyError { TooLarge, Read }

/// 有界读体：最多 MAX_BODY_BYTES+1 字节，超过即 TooLarge（上限判读不信任 Content-Length）。
fn read_body_limited(req: &mut tiny_http::Request) -> Result<Vec<u8>, BodyError> {
    let mut buf = Vec::new();
    req.as_reader().take((MAX_BODY_BYTES + 1) as u64)
        .read_to_end(&mut buf).map_err(|_| BodyError::Read)?;
    if buf.len() > MAX_BODY_BYTES { return Err(BodyError::TooLarge); }
    Ok(buf)
}

fn handle_request(req: tiny_http::Request, ctx: Arc<RequestCtx>) {
    if !auth_ok(&req, &ctx.secret) {
        respond(req, 401, "{\"error\":\"unauthorized\"}");
        return;
    }
    let path = req.url().split('?').next().unwrap_or("").to_string();
    let method = req.method().clone();
    match (path.as_str(), method) {
        ("/v1/sync", tiny_http::Method::Post) => handle_sync_push(req, ctx),
        ("/v1/devices", tiny_http::Method::Get) => handle_devices_get(req, ctx),
        ("/v1/sync", _) | ("/v1/devices", _) => respond(req, 405, "{\"error\":\"method not allowed\"}"),
        _ => respond(req, 404, "{\"error\":\"not found\"}"),
    }
}

/// POST /v1/sync：限长 → 整批校验 → 原子落 devices.json → 换入内存 → 200。
/// 解析/校验/落盘任一失败都不改动内存与磁盘（畸形整批拒绝）。
fn handle_sync_push(mut req: tiny_http::Request, ctx: Arc<RequestCtx>) {
    let bytes = match read_body_limited(&mut req) {
        Ok(b) => b,
        Err(BodyError::TooLarge) => { respond(req, 413, "{\"error\":\"payload too large\"}"); return; }
        Err(BodyError::Read) => { respond(req, 400, "{\"error\":\"unreadable body\"}"); return; }
    };
    let push = match serde_json::from_slice::<SyncPush>(&bytes) {
        Ok(p) => p,
        Err(_) => { respond(req, 400, "{\"error\":\"invalid payload\"}"); return; }
    };
    if let Err(_) = validate_push(&push) {
        respond(req, 400, "{\"error\":\"invalid payload\"}");
        return;
    }
    let record = DeviceRecord {
        device_id: push.device_id,
        device_name: push.device_name,
        app_version: push.app_version,
        last_active: now_rfc3339(),
        days: push.days,
    };
    // 持锁串行「改内存副本 → 落盘 → 换入内存」，保证 version 单调且磁盘==内存。
    let applied = (|| -> Result<u64, String> {
        let mut guard = ctx.devices.lock().map_err(|_| "设备表状态不可用".to_string())?;
        if !guard.devices.contains_key(&record.device_id) && guard.devices.len() >= MAX_DEVICES {
            return Err("设备数已达上限".into());
        }
        let mut next_devices = guard.devices.clone();
        next_devices.insert(record.device_id.clone(), record);
        let next_version = guard.version.wrapping_add(1);
        write_plain_json(&ctx.devices_path, &DevicesFileFormat {
            version: next_version,
            devices: next_devices.values().cloned().collect(),
        })?;
        guard.devices = next_devices;
        guard.version = next_version;
        Ok(next_version)
    })();
    match applied {
        Ok(v) => respond(req, 200, &format!("{{\"ok\":true,\"version\":{v}}}")),
        Err(_) => respond(req, 500, "{\"error\":\"persist failed\"}"),
    }
}

/// GET /v1/devices：返回全部设备聚合（含本机——host 实例也向自己注册）。
fn handle_devices_get(req: tiny_http::Request, ctx: Arc<RequestCtx>) {
    let body = {
        let guard = match ctx.devices.lock() {
            Ok(g) => g,
            Err(_) => { respond(req, 500, "{\"error\":\"state unavailable\"}"); return; }
        };
        let snap = DevicesSnapshot {
            version: guard.version,
            generated_at: Some(now_rfc3339()),
            devices: guard.devices.values().cloned().collect(),
        };
        serde_json::to_string(&snap).unwrap_or_else(|_| "{\"error\":\"serialize failed\"}".into())
    };
    respond(req, 200, &body);
}

// ---------------------------------------------------------------------------
// 客户端轮询（60s 上推 + 拉取，失败静默保留旧数据）
// ---------------------------------------------------------------------------

/// 传输抽象：生产实现走 reqwest::blocking（独立 std 线程），单测注入假实现。
pub trait SyncTransport: Send {
    fn get_devices(&mut self, url: &str, secret: &str) -> Result<Vec<u8>, String>;
    fn post_sync(&mut self, url: &str, secret: &str, body: &[u8]) -> Result<Vec<u8>, String>;
}

pub struct HttpTransport { client: reqwest::blocking::Client }

impl HttpTransport {
    pub fn new() -> Result<Self, String> {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            // 同步密钥是自定义头，reqwest 跨主机重定向默认策略只剥标准凭据头，
            // X-Pulse-Secret 会被原样转发到重定向目标。hub 地址是用户配置的固定
            // 值，无需跟随重定向：禁用之，恶意/被劫持 hub 无法把 secret 转投
            // 第三方（3xx 响应按非 2xx 报错，诚实降级）。
            .redirect(reqwest::redirect::Policy::none())
            .build().map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;
        Ok(Self { client })
    }
}

fn checked_secret(secret: &str) -> Result<&str, String> {
    // 密钥是 HTTP 头值：非 ASCII/控制字符直接判错，不冒进发请求。
    if secret.is_ascii() && !secret.chars().any(|c| c.is_control() || c == ' ') { Ok(secret) }
    else { Err("访问密钥包含无效字符".into()) }
}

impl SyncTransport for HttpTransport {
    fn get_devices(&mut self, url: &str, secret: &str) -> Result<Vec<u8>, String> {
        let secret = checked_secret(secret)?;
        let resp = self.client.get(url).header(SECRET_HEADER, secret)
            .send().map_err(|e| format!("请求失败：{e}"))?;
        let status = resp.status();
        if !status.is_success() { return Err(format!("服务返回 HTTP {status}")); }
        let bytes = resp.bytes().map_err(|e| format!("读取响应失败：{e}"))?;
        if bytes.len() > MAX_RESPONSE_BYTES { return Err("设备列表响应过大".into()); }
        Ok(bytes.to_vec())
    }
    fn post_sync(&mut self, url: &str, secret: &str, body: &[u8]) -> Result<Vec<u8>, String> {
        let secret = checked_secret(secret)?;
        let resp = self.client.post(url).header(SECRET_HEADER, secret)
            .header("Content-Type", "application/json")
            .body(body.to_vec())
            .send().map_err(|e| format!("请求失败：{e}"))?;
        let status = resp.status();
        if !status.is_success() { return Err(format!("服务返回 HTTP {status}")); }
        let bytes = resp.bytes().map_err(|e| format!("读取响应失败：{e}"))?;
        if bytes.len() > MAX_RESPONSE_BYTES { return Err("响应过大".into()); }
        Ok(bytes.to_vec())
    }
}

/// 一个同步端点（host 模式指向 127.0.0.1 自身，connect 模式指向远端 hub）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint { pub url: String, pub secret: String }

/// 一拍的输入。endpoint=None 即「同步关闭」——零网络行为（单测钉住）。
#[derive(Debug, Clone, Default)]
pub struct PollInput {
    pub endpoint: Option<Endpoint>,
    pub push_body: Option<Vec<u8>>,
}

/// 一拍的结果。snapshot 仅在「校验通过且版本变化」时给出；None = 保留旧数据。
#[derive(Debug, Clone, Default)]
pub struct PollReport {
    pub push_ok: bool,
    pub push_error: Option<String>,
    pub pull_ok: bool,
    pub pull_error: Option<String>,
    pub version: Option<u64>,
    pub devices: usize,
    pub changed: bool,
    pub snapshot: Option<DevicesSnapshot>,
}

/// 纯轮询逻辑（无文件 IO）：先上推（失败不阻断拉取），再拉取并整批校验。
/// 版本未变 → 不产出快照（调用方不重写文件，即「版本号变更时数据才重算」）。
pub fn poll_once(last_version: Option<u64>, t: &mut dyn SyncTransport, input: &PollInput) -> PollReport {
    let mut r = PollReport::default();
    let Some(ep) = &input.endpoint else { return r };
    if let Some(body) = &input.push_body {
        match t.post_sync(&format!("{}/v1/sync", ep.url), &ep.secret, body) {
            Ok(_) => r.push_ok = true,
            Err(e) => r.push_error = Some(e),
        }
    }
    match t.get_devices(&format!("{}/v1/devices", ep.url), &ep.secret) {
        Err(e) => { r.pull_error = Some(e); r }
        Ok(bytes) => {
            let parsed = serde_json::from_slice::<DevicesSnapshot>(&bytes).ok()
                .filter(|s| validate_snapshot(s).is_ok());
            match parsed {
                Some(snap) => {
                    r.pull_ok = true;
                    r.version = Some(snap.version);
                    r.devices = snap.devices.len();
                    r.changed = r.version != last_version;
                    if r.changed { r.snapshot = Some(snap); }
                    r
                }
                None => { r.pull_error = Some("设备列表响应无效".into()); r }
            }
        }
    }
}

/// connect 模式地址规整：去尾斜杠；仅接受 http(s)；拒绝空白/控制字符与超长。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() { return Err("同步服务器地址为空".into()); }
    if t.len() > 2048 { return Err("同步服务器地址过长".into()); }
    if !t.starts_with("http://") && !t.starts_with("https://") {
        return Err("同步服务器地址需以 http:// 或 https:// 开头".into());
    }
    if t.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("同步服务器地址含空白或控制字符".into());
    }
    let host_part = t.split("://").nth(1).unwrap_or("");
    if host_part.is_empty() || host_part.starts_with('/') {
        return Err("同步服务器地址缺少主机名".into());
    }
    Ok(t.trim_end_matches('/').to_string())
}

// ---------------------------------------------------------------------------
// 上推载荷组装（今日聚合取 daily_archive）
// ---------------------------------------------------------------------------

/// 上推窗口起点（含）：最近 SYNC_DAYS 天。day 键为归档冻结时区的 YYYY-MM-DD，
/// 字典序即日期序；与本地日历差一日的边缘行不损害正确性（多/少同步一天聚合）。
pub fn today_cutoff() -> String {
    (chrono::Local::now().date_naive() - chrono::Duration::days((SYNC_DAYS - 1) as i64))
        .format("%Y-%m-%d").to_string()
}

/// 纯组装：窗口过滤 + 双重上限。行数 ≤ MAX_DAYS_PER_DEVICE，且序列化后整包
/// ≤ MAX_PUSH_PAYLOAD_BYTES（行数上限本身在最坏行长下会超 hub 256KB 限，字节
/// 预算独立兜底）。输入按 day ASC（archived_daily 的 ORDER BY），从尾部（最新）
/// 往前收集，任一上限触顶时被截断的是最旧的行——最新天（含今日）恒保留。
pub fn build_payload(device_id: &str, device_name: &str, app_version: &str,
                     cutoff_day: &str, rows: &[crate::ledger::ArchivedDay]) -> SyncPush {
    // 信封（device_id/name/version + 空 days 数组）固定开销按实际序列化测量；
    // 逐行开销 = 行 JSON 字节数 + 1 枚逗号（末行逗号多记使估计只会偏大，安全）。
    let envelope = serde_json::to_vec(&SyncPush {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        app_version: app_version.to_string(),
        days: Vec::new(),
    }).map(|v| v.len()).unwrap_or(usize::MAX);
    let mut used = envelope;
    let mut days: Vec<SyncDayRow> = Vec::new();
    for r in rows.iter().rev() {
        if r.day.as_str() < cutoff_day { continue; }
        if days.len() >= MAX_DAYS_PER_DEVICE { break; }
        let row = SyncDayRow {
            day: r.day.clone(), source: r.source.clone(), model: r.model.clone(),
            input: r.input, output: r.output, cache_read: r.cache_read, cache_write: r.cache_write,
        };
        let Ok(row_json) = serde_json::to_vec(&row) else { break };
        if used.saturating_add(row_json.len() + 1) > MAX_PUSH_PAYLOAD_BYTES { break; }
        used += row_json.len() + 1;
        days.push(row);
    }
    days.reverse(); // 恢复 day ASC（hub 校验/磁盘与既有调用方的顺序契约）
    SyncPush {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        app_version: app_version.to_string(),
        days,
    }
}

/// 读本机 daily_archive（与趋势面板同数据源）。统计开关关闭时不读（与既有账本
/// 读取同一道门禁）；库文件缺失/读取失败一律空表（上推仍带设备元信息）。
pub fn collect_own_days(stats_enabled: bool) -> Vec<crate::ledger::ArchivedDay> {
    if !stats_enabled { return vec![]; }
    let path = crate::ledger::ledger_db_path();
    if !path.is_file() { return vec![]; }
    crate::ledger::archived_daily(&path).unwrap_or_default()
}

/// 设备名：COMPUTERNAME 去控制字符截断；空回退 "Windows PC"。
pub fn device_name() -> String {
    let raw = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Windows PC".into());
    let cleaned: String = raw.trim().chars().filter(|c| !c.is_control()).take(100).collect();
    if cleaned.is_empty() { "Windows PC".into() } else { cleaned }
}

fn build_push_body(stats_enabled: bool) -> Vec<u8> {
    let rows = collect_own_days(stats_enabled);
    let cutoff = today_cutoff();
    let push = build_payload(&crate::config::get_profile_id(), &device_name(),
        env!("CARGO_PKG_VERSION"), &cutoff, &rows);
    serde_json::to_vec(&push).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// 运行时状态（设置页状态行 / 端口占用报错的数据源）
// ---------------------------------------------------------------------------

/// 一次上推/拉取的结果记录（诚实降级：失败与时间都暴露给 UI）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PollRecord {
    pub at: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub devices: Option<usize>,
    pub version: Option<u64>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct StatusInner {
    pub hub_running: bool,
    pub hub_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hub_error: Option<String>,
    pub device_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_poll: Option<PollRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_push: Option<PollRecord>,
}

/// 被 tauri manage 的共享状态。`kick` 由 secret 重置命令递增，manager 据此重读凭据。
pub struct Runtime {
    inner: Mutex<StatusInner>,
    pub kick: AtomicU64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordKind { Poll, Push }

impl Runtime {
    pub fn new() -> Self {
        Self { inner: Mutex::new(StatusInner::default()), kick: AtomicU64::new(0) }
    }
    pub fn snapshot(&self) -> StatusInner {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }
    /// 更新 hub 运行态；返回是否发生变化（变化时 manager 才 emit 事件）。
    pub fn set_hub(&self, running: bool, port: u16, error: Option<String>) -> bool {
        let Ok(mut g) = self.inner.lock() else { return false };
        let changed = g.hub_running != running || g.hub_port != port || g.hub_error != error;
        g.hub_running = running;
        g.hub_port = port;
        g.hub_error = error;
        if !running { g.device_count = 0; }
        changed
    }
    pub fn set_device_count(&self, count: usize) {
        if let Ok(mut g) = self.inner.lock() { g.device_count = count; }
    }
    pub fn set_record(&self, kind: RecordKind, rec: PollRecord) {
        if let Ok(mut g) = self.inner.lock() {
            match kind {
                RecordKind::Poll => g.last_poll = Some(rec),
                RecordKind::Push => g.last_push = Some(rec),
            }
        }
    }
}

fn record(ok: bool, error: Option<String>, devices: Option<usize>, version: Option<u64>) -> PollRecord {
    PollRecord { at: now_rfc3339(), ok, error, devices, version }
}

/// 组装一拍输入（读设置 + 凭据 + 组载荷）。设置锁被占用（保存中）或配置不完整时
/// 返回 endpoint=None（本拍跳过，零网络），符合「失败静默」语义。
fn build_poll_input(app: &tauri::AppHandle) -> PollInput {
    use tauri::Manager;
    let (mode, connect_url, stats_enabled) = {
        let st = app.state::<crate::AppState>();
        let Ok(s) = st.settings.try_lock() else { return PollInput::default() };
        (s.sync_mode.clone(), s.sync_connect_url.clone(), s.token_spend_enabled)
    };
    let (base, secret) = match mode.as_str() {
        "host" => {
            // host 也向自己注册（统一数据面），用 hub 自己的密钥走同一 POST/GET。
            // 仅当本机 hub 确实在监听时才自注册：绑定失败/尚未起/端口被占的窗口期
            // 不把密钥发往固定端口——该端口此刻可能被无关本地进程占用，密钥会经
            // 明文 HTTP 头泄露给它。
            let rt = app.state::<Runtime>();
            let hub = rt.snapshot();
            if !hub.hub_running || hub.hub_port == 0 { return PollInput::default(); }
            let Ok(Some(sec)) = crate::secrets::WindowsSecrets.get(HUB_SECRET_ID) else {
                return PollInput::default();
            };
            (format!("http://127.0.0.1:{}", hub.hub_port), sec)
        }
        "connect" => {
            let Ok(base) = normalize_base_url(&connect_url) else { return PollInput::default() };
            let Ok(Some(sec)) = crate::secrets::WindowsSecrets.get(CLIENT_SECRET_ID) else {
                return PollInput::default();
            };
            (base, sec)
        }
        _ => return PollInput::default(),
    };
    if secret.is_empty() { return PollInput::default(); }
    PollInput {
        endpoint: Some(Endpoint { url: base, secret }),
        push_body: Some(build_push_body(stats_enabled)),
    }
}

/// 设置态回退 off（绑定失败时的规格行为）：持 settings_io + settings 锁改内存、
/// 落盘并广播 settings-updated。锁忙/落盘失败时不强改，错误经 Runtime 状态暴露。
fn revert_mode_off(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let Ok(_io) = state.settings_io.try_lock() else { return false };
    let Ok(mut s) = state.settings.try_lock() else { return false };
    if s.sync_mode != "host" { return true; } // 已被并发保存改走，无需回退
    s.sync_mode = "off".into();
    let snapshot = s.clone();
    match crate::config::save_settings(&snapshot) {
        Ok(()) => {
            drop(s);
            let _ = app.emit("settings-updated", &snapshot);
            let rt = app.state::<Runtime>();
            let _ = app.emit("sync-hub-status", serde_json::to_value(rt.snapshot()).unwrap_or_default());
            true
        }
        Err(_) => {
            // 落盘失败：内存回滚回 host（磁盘仍为 host），错误经状态行暴露。
            s.sync_mode = "host".into();
            drop(s);
            let rt = app.state::<Runtime>();
            let _ = app.emit("sync-hub-status", serde_json::to_value(rt.snapshot()).unwrap_or_default());
            false
        }
    }
}

fn publish_hub_state(app: &tauri::AppHandle, running: bool, port: u16, error: Option<String>) {
    use tauri::Manager;
    let rt = app.state::<Runtime>();
    if rt.set_hub(running, port, error) {
        let _ = app.emit("sync-hub-status", serde_json::to_value(rt.snapshot()).unwrap_or_default());
    }
}

/// manager 线程：每秒对齐设置与 hub 实际状态（启动/停止/换密钥重启/端口占用回退）。
fn manager_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    let mut hub: Option<HubServer> = None;
    let mut cached_secret: Option<(u64, String)> = None;
    // 最近一次已广播的绑定错误（按内容去重）：绑定失败且回退未生效时 manager 会
    // 每秒重试，错误事件与状态不同——sync-hub-status 经 set_hub 去重，此处事件
    // 不去重会 1Hz 刷屏。
    let mut last_bind_error: Option<String> = None;
    loop {
        std::thread::sleep(Duration::from_millis(MANAGER_TICK_MS));
        // 退出升级期间一律停服（不新增监听面）。
        if crate::updater::applying() {
            if let Some(mut h) = hub.take() { h.stop(); publish_hub_state(&app, false, 0, None); }
            continue;
        }
        let mode = {
            let st = app.state::<crate::AppState>();
            let got = match st.settings.try_lock() { Ok(s) => s.sync_mode.clone(), Err(_) => continue };
            got
        };
        if mode != "host" {
            if let Some(mut h) = hub.take() { h.stop(); publish_hub_state(&app, false, 0, None); }
            continue;
        }
        // host 模式：按 kick 代际缓存 secret，避免每秒读凭据库。
        let epoch = app.state::<Runtime>().kick.load(Ordering::SeqCst);
        if cached_secret.as_ref().map(|(e, _)| *e) != Some(epoch) {
            let sec = crate::secrets::WindowsSecrets.get(HUB_SECRET_ID).ok().flatten().unwrap_or_default();
            cached_secret = Some((epoch, sec));
        }
        let secret = cached_secret.as_ref().map(|(_, s)| s.clone()).unwrap_or_default();
        if secret.is_empty() {
            // 未生成密钥：不开端口也不回退设置（生成密钥后下一拍自动开）；错误可见。
            if let Some(mut h) = hub.take() { h.stop(); publish_hub_state(&app, false, 0, None); }
            let rt = app.state::<Runtime>();
            if rt.set_hub(false, 0, Some("同步访问密钥未生成；请先在设置中生成密钥".into())) {
                let _ = app.emit("sync-hub-status", serde_json::to_value(rt.snapshot()).unwrap_or_default());
            }
            continue;
        }
        let devices_path = crate::config::get_config_dir().join(DEVICES_FILE);
        let need_restart = hub.as_ref()
            .map(|h| h.secret() != secret || h.devices_path() != devices_path)
            .unwrap_or(true);
        if !need_restart {
            if let Some(h) = &hub { let c = h.device_count(); app.state::<Runtime>().set_device_count(c); }
            continue;
        }
        if let Some(mut h) = hub.take() { h.stop(); }
        match HubServer::start(HubConfig { port: DEFAULT_PORT, secret, devices_path }) {
            Ok(h) => {
                let port = h.port();
                hub = Some(h);
                last_bind_error = None;
                publish_hub_state(&app, true, port, None);
            }
            Err(e) => {
                // 端口占用等绑定失败：设置态回退 off + 界面报错，不静默半开。
                hub = None;
                let msg = format!("{e}；已回退为关闭");
                publish_hub_state(&app, false, 0, Some(msg.clone()));
                // 错误事件按内容去重：回退未生效（锁忙/落盘失败）期间的每秒重试
                // 不得重复刷事件；恢复运行后置空，再次失败会重新广播。
                if last_bind_error.as_deref() != Some(msg.as_str()) {
                    last_bind_error = Some(msg.clone());
                    let _ = app.emit("sync-hub-error", serde_json::json!({"error": msg}));
                }
                if !revert_mode_off(&app) {
                    eprintln!("Pulse: 同步服务绑定失败且设置回退未完成：{msg}");
                }
            }
        }
    }
}

/// 客户端轮询线程：先 5s（让 hub 先绑定），此后每 60s 一拍；
/// 拉取成功且版本变化 → 校验后原子落盘 sync-devices.json；失败静默保留旧文件。
fn poll_loop(app: tauri::AppHandle) {
    use tauri::Manager;
    std::thread::sleep(Duration::from_secs(5));
    let snapshot_path = crate::config::get_config_dir().join(SYNC_DEVICES_FILE);
    let mut last_version: Option<u64> = std::fs::read(&snapshot_path).ok()
        .and_then(|b| serde_json::from_slice::<DevicesSnapshot>(&b).ok())
        .map(|s| s.version);
    let mut transport = HttpTransport::new().ok();
    loop {
        if !crate::updater::applying() {
            let input = build_poll_input(&app);
            let report = match transport.as_mut() {
                Some(t) => poll_once(last_version, t, &input),
                None => PollReport { pull_error: Some("HTTP 客户端不可用".into()), ..PollReport::default() },
            };
            let rt = app.state::<Runtime>();
            if let Some(e) = &report.push_error {
                rt.set_record(RecordKind::Push, record(false, Some(e.clone()), None, None));
            } else if report.push_ok {
                rt.set_record(RecordKind::Push, record(true, None, None, None));
            }
            match &report.snapshot {
                Some(snap) => {
                    match write_plain_json(&snapshot_path, snap) {
                        Ok(()) => {
                            last_version = Some(snap.version);
                            rt.set_record(RecordKind::Poll,
                                record(true, None, Some(snap.devices.len()), Some(snap.version)));
                        }
                        Err(e) => {
                            // 落盘失败：旧文件保留，版本不推进（下一拍重试重写）。
                            rt.set_record(RecordKind::Poll,
                                record(false, Some(format!("快照落盘失败：{e}")), None, None));
                        }
                    }
                }
                None => {
                    if let Some(e) = &report.pull_error {
                        rt.set_record(RecordKind::Poll, record(false, Some(e.clone()), None, None));
                    } else if report.pull_ok {
                        // 拉取成功但版本未变：无快照可落盘（文件不重写），但「最近
                        // 拉取」时间仍须如实刷新（诚实降级：成功就是成功）。
                        rt.set_record(RecordKind::Poll,
                            record(true, None, Some(report.devices), report.version));
                    }
                    // 其余（endpoint=None 的零网络拍）不记记录。
                }
            }
        }
        std::thread::sleep(Duration::from_secs(POLL_SECS));
    }
}

/// 启动两个常驻线程（manager + 轮询）。绝无 panic 路径；所有失败静默或入状态。
pub fn spawn(app: tauri::AppHandle) {
    let m = app.clone();
    let _ = std::thread::Builder::new().name("sync-manager".into()).spawn(move || manager_loop(m));
    let p = app;
    let _ = std::thread::Builder::new().name("sync-poll".into()).spawn(move || poll_loop(p));
}

// ---------------------------------------------------------------------------
// 单测：安全矩阵（鉴权/超大/畸形/缺字段）、整批拒绝、持久化、轮询降级
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- 纯函数 ----------

    #[test]
    fn constant_time_eq_matches_and_mismatches() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(constant_time_eq("", ""));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("ab", "abc"));
        assert!(!constant_time_eq("a", ""));
        assert!(!constant_time_eq("", "a"));
        // 长 secret 全程一致/仅末位不同：不 panic，结果正确。
        let a = "0123456789abcdef0123456789abcdef";
        let mut b = a.to_string(); b.replace_range(31..32, "0");
        assert!(constant_time_eq(a, a));
        assert!(!constant_time_eq(a, &b));
    }

    #[test]
    fn generate_secret_is_32_hex_and_unique() {
        let s1 = generate_secret();
        let s2 = generate_secret();
        assert_eq!(s1.len(), 32, "128 位 = 32 hex 字符");
        assert!(s1.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_ne!(s1, s2, "两次生成不应相同");
    }

    fn fixture_push() -> SyncPush {
        SyncPush {
            device_id: "device-alpha".into(),
            device_name: "测试机".into(),
            app_version: "0.6.6".into(),
            days: vec![SyncDayRow {
                day: "2026-09-23".into(), source: "claude".into(), model: "glm-5".into(),
                input: 1, output: 2, cache_read: 3, cache_write: 4,
            }],
        }
    }

    #[test]
    fn push_missing_fields_are_rejected() {
        // 缺字段：required 字段缺失 → 反序列化失败（线协议不做缺省补齐）。
        assert!(serde_json::from_str::<SyncPush>(r#"{}"#).is_err());
        assert!(serde_json::from_str::<SyncPush>(r#"{"device_id":"a"}"#).is_err());
        assert!(serde_json::from_str::<SyncPush>(
            r#"{"device_id":"a","device_name":"n"}"#).is_err());
        assert!(serde_json::from_str::<SyncPush>(
            r#"{"device_id":"a","device_name":"n","app_version":"1.0"}"#).is_err());
        // 多余字段同样拒绝（隐私白名单）。
        let mut v = serde_json::to_value(fixture_push()).unwrap();
        v["extra"] = serde_json::json!(1);
        assert!(serde_json::from_value::<SyncPush>(v).is_err());
        // 反序列化成功但字段不合法 → validate 拒绝。
        let bad = SyncPush { device_id: "bad id!".into(), ..fixture_push() };
        assert!(validate_push(&bad).is_err());
        let bad = SyncPush { device_name: String::new(), ..fixture_push() };
        assert!(validate_push(&bad).is_err());
        let bad = SyncPush { device_name: "a\nb".into(), ..fixture_push() };
        assert!(validate_push(&bad).is_err(), "控制字符拒绝");
        let bad = SyncPush { app_version: "x".repeat(41), ..fixture_push() };
        assert!(validate_push(&bad).is_err());
    }

    #[test]
    fn push_bad_rows_reject_whole_batch() {
        let mut p = fixture_push();
        p.days.push(SyncDayRow {
            day: "2026-13-99".into(), source: "claude".into(), model: "m".into(),
            input: 0, output: 0, cache_read: 0, cache_write: 0,
        });
        assert!(validate_push(&p).is_err(), "格式对但日期无效的行 → 整批拒绝");
        let mut p = fixture_push();
        p.days.push(SyncDayRow {
            day: "2026-9-3".into(), source: "claude".into(), model: "m".into(),
            input: 0, output: 0, cache_read: 0, cache_write: 0,
        });
        assert!(validate_push(&p).is_err(), "非零填充日期拒绝");
        let mut p = fixture_push();
        p.days[0].source = "bad source!".into();
        assert!(validate_push(&p).is_err());
        let mut p = fixture_push();
        p.days[0].model = String::new();
        assert!(validate_push(&p).is_err());
        let mut p = fixture_push();
        p.days = (0..=MAX_DAYS_PER_DEVICE).map(|i| SyncDayRow {
            day: "2026-09-23".into(), source: "claude".into(), model: format!("m{i}"),
            input: 0, output: 0, cache_read: 0, cache_write: 0,
        }).collect();
        assert!(validate_push(&p).is_err(), "行数超上限整批拒绝");
        assert!(validate_push(&fixture_push()).is_ok());
        // tokens 口径：四列之和。
        assert_eq!(fixture_push().days[0].tokens(), 10);
    }

    #[test]
    fn snapshot_validation_rejects_bad_records() {
        let good = DevicesSnapshot {
            version: 3,
            generated_at: Some(now_rfc3339()),
            devices: vec![DeviceRecord {
                device_id: "device-alpha".into(), device_name: "n".into(),
                app_version: "1".into(), last_active: now_rfc3339(),
                days: fixture_push().days,
            }],
        };
        assert!(validate_snapshot(&good).is_ok());
        let mut bad = good.clone();
        bad.devices.push(DeviceRecord {
            device_id: "device-beta".into(), device_name: "n".into(),
            app_version: "1".into(), last_active: "not-a-time".into(), days: vec![],
        });
        assert!(validate_snapshot(&bad).is_err(), "任一记录 last_active 无效 → 整批拒绝");
        let mut bad = good.clone();
        bad.devices[0].device_id = "dup".into();
        bad.devices.push(DeviceRecord {
            device_id: "dup".into(), device_name: "n".into(),
            app_version: "1".into(), last_active: now_rfc3339(), days: vec![],
        });
        assert!(validate_snapshot(&bad).is_err(), "重复设备标识整批拒绝");
        let mut bad = good;
        bad.generated_at = Some("bad".into());
        assert!(validate_snapshot(&bad).is_err());
    }

    #[test]
    fn devices_file_roundtrip_and_parentdir_rejected() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("devices.json");
        let data = DevicesFileFormat { version: 7, devices: vec![] };
        write_plain_json(&path, &data).unwrap();
        let loaded = load_devices_file(&path);
        assert_eq!(loaded.version, 7);
        // 父目录跳转拒绝（plain 同款校验）。
        let evil = d.path().join("sub").join("..").join("evil.json");
        assert!(write_plain_json(&evil, &data).is_err());
        assert!(!d.path().join("evil.json").exists(), "路径校验失败时不得写出文件");
        // 损坏文件：保留副本，从空表开始。
        std::fs::write(&path, b"broken").unwrap();
        let loaded = load_devices_file(&path);
        assert_eq!(loaded.version, 0);
        assert!(loaded.devices.is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken", "坏文件不被静默覆盖");
        assert!(d.path().read_dir().unwrap()
            .any(|e| e.unwrap().file_name().to_string_lossy().starts_with("devices.json.bad-")),
            "损坏副本被保留");
    }

    #[test]
    fn load_devices_file_rejects_invalid_records() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("devices.json");
        let bad = r#"{"version":1,"devices":[{"device_id":"bad id","device_name":"n","app_version":"1","last_active":"2026-09-23T00:00:00+00:00","days":[]}]}"#;
        std::fs::write(&path, bad).unwrap();
        let loaded = load_devices_file(&path);
        assert!(loaded.devices.is_empty(), "含非法记录的文件不装入");
        // 合法记录正常装入。
        let rec = DeviceRecord {
            device_id: "device-alpha".into(), device_name: "n".into(), app_version: "1".into(),
            last_active: "2026-09-23T00:00:00+00:00".into(), days: fixture_push().days,
        };
        write_plain_json(&path, &DevicesFileFormat { version: 2, devices: vec![rec] }).unwrap();
        let loaded = load_devices_file(&path);
        assert_eq!(loaded.version, 2);
        assert_eq!(loaded.devices.len(), 1);
    }

    #[test]
    fn build_payload_filters_window_and_caps_rows() {
        let rows = vec![
            crate::ledger::ArchivedDay { day: "2026-08-01".into(), source: "claude".into(), model: "m".into(), input: 1, output: 0, cache_read: 0, cache_write: 0 },
            crate::ledger::ArchivedDay { day: "2026-09-20".into(), source: "codex".into(), model: "gpt".into(), input: 0, output: 0, cache_read: 0, cache_write: 0 },
            crate::ledger::ArchivedDay { day: "2026-09-23".into(), source: "zcode".into(), model: "glm-5".into(), input: 2, output: 3, cache_read: 0, cache_write: 4 },
        ];
        let p = build_payload("pr_test", "pc", "0.6.6", "2026-09-20", &rows);
        assert_eq!(p.device_id, "pr_test");
        assert_eq!(p.days.len(), 2, "窗口外的 8 月行被过滤");
        assert_eq!(p.days[0].day, "2026-09-20");
        assert_eq!(p.days[1].tokens(), 9);
        // 空窗口 → 空行（设备元信息仍上推）。
        let p = build_payload("pr_test", "pc", "0.6.6", "2099-01-01", &rows);
        assert!(p.days.is_empty());
        assert!(validate_push(&p).is_ok(), "空 days 合法（统计关/库缺）");
    }

    #[test]
    fn build_payload_caps_bytes_and_keeps_newest_days() {
        // 行数上限内的最坏行长必然超 256KB（4096 行 × ~100B ≈ 392KB）：字节预算
        // 必须独立生效，且截断保留最新天（含今日）、丢弃最旧天。
        let start = chrono::NaiveDate::from_ymd_opt(2026, 5, 1).unwrap();
        let mut rows = Vec::new();
        for i in 0..100 {
            let day = (start + chrono::Duration::days(i)).format("%Y-%m-%d").to_string();
            for m in 0..50 {
                rows.push(crate::ledger::ArchivedDay {
                    day: day.clone(), source: "claude".into(), model: format!("claude-opus-4-{m}"),
                    input: 12345, output: 678, cache_read: 9_000_000, cache_write: 1_000,
                });
            }
        }
        assert!(rows.len() > MAX_DAYS_PER_DEVICE, "fixture 须同时越过行数上限（{}）", rows.len());
        let p = build_payload("pr_test", "pc", "0.6.6", "2000-01-01", &rows);
        assert!(p.days.len() <= MAX_DAYS_PER_DEVICE);
        let body = serde_json::to_vec(&p).unwrap();
        assert!(body.len() <= MAX_PUSH_PAYLOAD_BYTES, "序列化整包必须恒在字节预算内：{}", body.len());
        assert!(body.len() <= MAX_BODY_BYTES, "字节预算必须 ≤ hub 256KB 限：{}", body.len());
        // 截断方向：最新天保留、最旧天被丢；行数与字节两个上限先到哪个都一样。
        let last_day = rows.last().unwrap().day.clone();
        assert!(p.days.iter().any(|r| r.day == last_day), "最新天不得被截断丢弃");
        assert!(p.days.first().unwrap().day > rows[0].day, "被截断的是最旧的行");
        // 顺序契约：day 非降（与 archived_daily 的 ORDER BY 一致）。
        for w in p.days.windows(2) { assert!(w[0].day <= w[1].day); }
        // 未触顶的小批量原样保留（与旧行为一致）。
        let p2 = build_payload("pr_test", "pc", "0.6.6", "2000-01-01", &rows[..3]);
        assert_eq!(p2.days.len(), 3);
    }

    #[test]
    fn hub_start_rejects_empty_secret() {
        // 纵深防御：constant_time_eq("","")==true，空密钥绝不能开机。
        let d = tempfile::tempdir().unwrap();
        let r = HubServer::start(HubConfig {
            port: 0, secret: String::new(), devices_path: d.path().join("devices.json"),
        });
        assert!(r.is_err(), "空 secret 必须拒绝启动");
    }

    #[test]
    fn request_deadline_sweep_releases_slots_exactly_once() {
        // watchdog 扫描：只摘超时条目并归还名额；worker 晚到时不得重复归还。
        let ctx = RequestCtx {
            secret: "s".into(), devices_path: PathBuf::from("unused"),
            devices: Mutex::new(HubData::default()), active: AtomicUsize::new(3),
            inflight: Mutex::new(HashMap::new()), next_req_id: AtomicU64::new(0),
            deadline: Duration::from_millis(50),
        };
        ctx.inflight.lock().unwrap().insert(1, Instant::now());
        ctx.inflight.lock().unwrap().insert(2, Instant::now() - Duration::from_secs(60));
        assert!(sweep_deadlines(&ctx));
        assert_eq!(ctx.active.load(Ordering::SeqCst), 2, "只有超时条目归还名额");
        assert!(ctx.inflight.lock().unwrap().contains_key(&1));
        assert!(!ctx.inflight.lock().unwrap().contains_key(&2));
        // 已被 watchdog 摘除的请求，其 worker 晚到释放：不得重复扣减。
        release_slot(&ctx, 2);
        assert_eq!(ctx.active.load(Ordering::SeqCst), 2);
        // 未超时条目不受影响；worker 正常完成时自行摘除并归还。
        release_slot(&ctx, 1);
        assert_eq!(ctx.active.load(Ordering::SeqCst), 1, "正常完成恰归还一次");
        assert!(ctx.inflight.lock().unwrap().is_empty());
        release_slot(&ctx, 1);
        assert_eq!(ctx.active.load(Ordering::SeqCst), 1, "重复释放不二次扣减");
    }

    #[test]
    fn normalize_base_url_rules() {
        assert_eq!(normalize_base_url("http://192.168.1.5:45539/").unwrap(), "http://192.168.1.5:45539");
        assert_eq!(normalize_base_url("https://hub.example.com").unwrap(), "https://hub.example.com");
        assert!(normalize_base_url("ftp://x").is_err());
        assert!(normalize_base_url("http://").is_err());
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("http://a b/").is_err());
        assert!(normalize_base_url(&"http://x".repeat(400)).is_err());
    }

    #[test]
    fn today_cutoff_is_sync_days_back() {
        let today = chrono::Local::now().date_naive();
        let expect = (today - chrono::Duration::days(SYNC_DAYS as i64 - 1)).format("%Y-%m-%d").to_string();
        assert_eq!(today_cutoff(), expect);
    }

    #[test]
    fn valid_day_rules() {
        assert!(valid_day("2026-09-23"));
        assert!(!valid_day("2026-9-23"));
        assert!(!valid_day("2026-13-01"));
        assert!(!valid_day("2026-02-30"));
        assert!(!valid_day("20260923"));
        assert!(!valid_day(""));
    }

    // ---------- 轮询降级（假传输） ----------

    struct FakeTransport {
        calls: Arc<AtomicUsize>,
        get_res: Result<Vec<u8>, String>,
        post_res: Result<Vec<u8>, String>,
    }
    impl FakeTransport {
        fn ok(snapshot: &DevicesSnapshot) -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                get_res: Ok(serde_json::to_vec(snapshot).unwrap()),
                post_res: Ok(b"{}".to_vec()),
            }
        }
        fn failing() -> Self {
            Self {
                calls: Arc::new(AtomicUsize::new(0)),
                get_res: Err("网络不可达".into()),
                post_res: Err("网络不可达".into()),
            }
        }
    }
    impl SyncTransport for FakeTransport {
        fn get_devices(&mut self, _u: &str, _s: &str) -> Result<Vec<u8>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.get_res.clone()
        }
        fn post_sync(&mut self, _u: &str, _s: &str, _b: &[u8]) -> Result<Vec<u8>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.post_res.clone()
        }
    }

    fn snapshot_fixture(version: u64) -> DevicesSnapshot {
        DevicesSnapshot {
            version,
            generated_at: Some("2026-09-23T00:00:00+00:00".into()),
            devices: vec![DeviceRecord {
                device_id: "device-alpha".into(), device_name: "n".into(),
                app_version: "1".into(), last_active: "2026-09-23T00:00:00+00:00".into(),
                days: fixture_push().days,
            }],
        }
    }

    fn poll_input() -> PollInput {
        PollInput {
            endpoint: Some(Endpoint { url: "http://127.0.0.1:1".into(), secret: "s".into() }),
            push_body: Some(b"{}".to_vec()),
        }
    }

    #[test]
    fn poll_off_is_zero_network_and_keeps_old_data() {
        // THE 关态零网络单测：endpoint=None 时任何输入都不得发起请求。
        for failing in [true, false] {
            let mut t = if failing { FakeTransport::failing() } else { FakeTransport::ok(&snapshot_fixture(1)) };
            let r = poll_once(Some(1), &mut t, &PollInput::default());
            assert_eq!(t.calls.load(Ordering::SeqCst), 0, "关态不得发起任何请求");
            assert!(!r.push_ok && r.push_error.is_none());
            assert!(!r.pull_ok && r.pull_error.is_none());
            assert!(r.snapshot.is_none() && !r.changed);
        }
    }

    #[test]
    fn poll_pull_failure_keeps_old_version_and_data() {
        let mut t = FakeTransport::failing();
        let r = poll_once(Some(4), &mut t, &poll_input());
        assert!(!r.pull_ok);
        assert!(r.pull_error.is_some());
        assert!(r.snapshot.is_none(), "拉取失败不产出快照，调用方保留旧 sync-devices.json");
        assert!(!r.changed);
    }

    #[test]
    fn poll_malformed_body_rejected() {
        let mut t = FakeTransport::ok(&snapshot_fixture(1));
        t.get_res = Ok(b"{not json".to_vec());
        let r = poll_once(None, &mut t, &poll_input());
        assert!(!r.pull_ok && r.pull_error.is_some(), "畸形响应整批拒绝");
        assert!(r.snapshot.is_none());
    }

    #[test]
    fn poll_invalid_device_rejects_whole_batch() {
        let mut snap = snapshot_fixture(2);
        snap.devices.push(DeviceRecord {
            device_id: "bad id!".into(), device_name: "n".into(), app_version: "1".into(),
            last_active: "2026-09-23T00:00:00+00:00".into(), days: vec![],
        });
        let mut t = FakeTransport::ok(&snap);
        let r = poll_once(Some(1), &mut t, &poll_input());
        assert!(!r.pull_ok && r.snapshot.is_none(), "任一设备记录非法 → 整批拒绝，旧数据保留");
    }

    #[test]
    fn poll_new_version_produces_snapshot_same_version_skips_rewrite() {
        // 新版本：产出快照（调用方落盘并推进版本）。
        let mut t = FakeTransport::ok(&snapshot_fixture(5));
        let r = poll_once(Some(4), &mut t, &poll_input());
        assert!(r.pull_ok && r.changed);
        assert_eq!(r.version, Some(5));
        assert_eq!(r.devices, 1);
        assert!(r.snapshot.is_some());
        // 版本未变：不产出快照（数据不重算/文件不重写）。
        let mut t = FakeTransport::ok(&snapshot_fixture(5));
        let r = poll_once(Some(5), &mut t, &poll_input());
        assert!(r.pull_ok && !r.changed && r.snapshot.is_none());
    }

    #[test]
    fn poll_push_failure_does_not_block_pull() {
        let mut t = FakeTransport::ok(&snapshot_fixture(6));
        t.post_res = Err("上推失败".into());
        let r = poll_once(Some(5), &mut t, &poll_input());
        assert!(!r.push_ok && r.push_error.is_some());
        assert!(r.pull_ok && r.changed && r.snapshot.is_some(), "上推失败不阻断设备列表拉取");
    }

    // ---------- hub 集成（真实 tiny_http，端口 0 随机） ----------

    struct TestHub { server: HubServer, _dir: tempfile::TempDir }
    impl Drop for TestHub { fn drop(&mut self) { self.server.stop(); } }

    fn start_test_hub() -> (TestHub, String, u16) {
        let dir = tempfile::tempdir().unwrap();
        let secret = generate_secret();
        let server = HubServer::start(HubConfig {
            port: 0,
            secret: secret.clone(),
            devices_path: dir.path().join("devices.json"),
        }).unwrap();
        let port = server.port();
        assert_ne!(port, 0);
        (TestHub { server, _dir: dir }, secret, port)
    }

    /// 极简 HTTP 客户端（Connection: close）。写/读失败容忍（服务端提前关连时
    /// 已收到的响应字节仍在缓冲里）。
    fn http_once(port: u16, method: &str, path: &str, secret: Option<&str>, body: Option<&[u8]>) -> (u16, Vec<u8>) {
        use std::io::Write;
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        if let Some(sec) = secret { req += &format!("{SECRET_HEADER}: {sec}\r\n"); }
        if let Some(b) = body { req += &format!("Content-Length: {}\r\nContent-Type: application/json\r\n", b.len()); }
        req += "\r\n";
        let _ = s.write_all(req.as_bytes());
        if let Some(b) = body {
            for chunk in b.chunks(8192) { let _ = s.write_all(chunk); }
        }
        let mut buf = Vec::new();
        let _ = s.read_to_end(&mut buf);
        let head = String::from_utf8_lossy(&buf);
        let code = head.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok()).unwrap_or(0);
        (code, buf)
    }

    fn post_json(port: u16, secret: Option<&str>, body: &[u8]) -> (u16, Vec<u8>) {
        http_once(port, "POST", "/v1/sync", secret, Some(body))
    }

    /// 从原始 HTTP 响应中取 body（跳过头部；tiny_http 对小响应走 Content-Length）。
    fn body_of(raw: &[u8]) -> Vec<u8> {
        let sep = b"\r\n\r\n";
        raw.windows(4).position(|w| w == sep).map(|i| raw[i + 4..].to_vec()).unwrap_or_default()
    }

    fn get_devices(port: u16, secret: Option<&str>) -> (u16, Vec<u8>) {
        http_once(port, "GET", "/v1/devices", secret, None)
    }

    #[test]
    fn hub_auth_matrix() {
        let (_hub, secret, port) = start_test_hub();
        let body = serde_json::to_vec(&fixture_push()).unwrap();
        // 无 secret / 错 secret：两个端点一律 401（不区分原因，防枚举）。
        for (code, _) in [
            get_devices(port, None),
            get_devices(port, Some("wrong-secret")),
            post_json(port, None, &body),
            post_json(port, Some("wrong-secret"), &body),
            http_once(port, "GET", "/unknown", None, None),
        ] {
            assert_eq!(code, 401, "未鉴权请求必须 401");
        }
        // 正确 secret：可用。
        let (code, _) = get_devices(port, Some(&secret));
        assert_eq!(code, 200);
        let (code, resp) = post_json(port, Some(&secret), &body);
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&resp).contains("\"ok\":true"));
    }

    #[test]
    fn hub_rejects_oversized_body() {
        let (_hub, secret, port) = start_test_hub();
        // > 256KB 的请求体 → 413，且不改变设备表。
        let oversized = vec![b'a'; MAX_BODY_BYTES + 1];
        let (code, _) = post_json(port, Some(&secret), &oversized);
        assert_eq!(code, 413);
        // 恰好 256KB 的非 JSON：超过大小才 413，这里应落到 400（解析失败）。
        let at_limit = vec![b'a'; MAX_BODY_BYTES];
        let (code, _) = post_json(port, Some(&secret), &at_limit);
        assert_eq!(code, 400, "限内但畸形 → 400 而非 413");
        let (code, resp) = get_devices(port, Some(&secret));
        assert_eq!(code, 200);
        let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
        assert_eq!(snap.version, 0, "被拒请求不得推进版本");
    }

    #[test]
    fn hub_rejects_malformed_and_missing_field_payloads_without_state_change() {
        let (hub, secret, port) = start_test_hub();
        // 畸形 JSON。
        let (code, _) = post_json(port, Some(&secret), b"{not json");
        assert_eq!(code, 400);
        // 缺字段。
        for bad in [
            r#"{}"#.as_bytes(),
            br#"{"device_id":"a"}"#,
            br#"{"device_id":"a","device_name":"n"}"#,
            br#"{"device_id":"a","device_name":"n","app_version":"1"}"#,
        ] {
            let (code, _) = post_json(port, Some(&secret), bad);
            assert_eq!(code, 400, "缺字段必须整批拒绝：{bad:?}");
        }
        // 类型错误（counts 非数值）。
        let (code, _) = post_json(port, Some(&secret),
            br#"{"device_id":"a","device_name":"n","app_version":"1","days":[{"day":"2026-09-23","source":"claude","model":"m","input":"x","output":0,"cache_read":0,"cache_write":0}]}"#);
        assert_eq!(code, 400);
        let (code, resp) = get_devices(port, Some(&secret));
        assert_eq!(code, 200);
        let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
        assert_eq!(snap.version, 0);
        assert!(snap.devices.is_empty(), "被拒批次不得留下任何数据");
        assert!(hub.server.device_count() == 0);
    }

    #[test]
    fn hub_whole_batch_rejected_on_single_bad_row() {
        let (_hub, secret, port) = start_test_hub();
        let mut p = fixture_push();
        p.days.push(SyncDayRow {
            day: "2026-13-99".into(), source: "claude".into(), model: "m".into(),
            input: 0, output: 0, cache_read: 0, cache_write: 0,
        });
        let (code, _) = post_json(port, Some(&secret), &serde_json::to_vec(&p).unwrap());
        assert_eq!(code, 400, "一条坏行整批拒绝");
        let (_, resp) = get_devices(port, Some(&secret));
        let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
        assert_eq!(snap.version, 0);
        assert!(snap.devices.is_empty(), "坏行不得连累好行一起入库");
    }

    #[test]
    fn hub_end_to_end_push_get_and_persistence_across_restart() {
        let (mut hub, secret, port) = start_test_hub();
        let path = hub.server.devices_path().to_path_buf();
        let (code, _) = post_json(port, Some(&secret), &serde_json::to_vec(&fixture_push()).unwrap());
        assert_eq!(code, 200);
        let (code, resp) = get_devices(port, Some(&secret));
        assert_eq!(code, 200);
        let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
        assert_eq!(snap.version, 1);
        assert_eq!(snap.devices.len(), 1);
        assert_eq!(snap.devices[0].device_id, "device-alpha");
        assert_eq!(snap.devices[0].days[0].tokens(), 10);
        assert!(chrono::DateTime::parse_from_rfc3339(&snap.devices[0].last_active).is_ok(),
            "last_active 由 hub 盖时间戳");
        // devices.json 已落盘。
        let on_disk = std::fs::read(&path).unwrap();
        assert!(String::from_utf8_lossy(&on_disk).contains("device-alpha"));
        // 重启（同数据目录；TempDir 在 hub 存活期间保持有效）：设备表从盘恢复。
        hub.server.stop();
        let dir_path = hub._dir.path().to_path_buf();
        let mut server2 = HubServer::start(HubConfig {
            port: 0, secret: secret.clone(), devices_path: dir_path.join("devices.json"),
        }).unwrap();
        let port2 = server2.port();
        let (code, resp) = get_devices(port2, Some(&secret));
        assert_eq!(code, 200);
        let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
        assert_eq!(snap.version, 1, "重启后版本延续");
        assert_eq!(snap.devices.len(), 1);
        server2.stop();
        drop(hub);
    }

    #[test]
    fn hub_serves_beyond_concurrency_cap_without_degrading() {
        // 回归：并发名额必须随请求完成而释放，否则第 17 个请求起永久 503。
        let (_hub, secret, port) = start_test_hub();
        for i in 0..(MAX_CONCURRENT_REQUESTS * 3) {
            let (code, resp) = get_devices(port, Some(&secret));
            assert_eq!(code, 200, "第 {i} 个请求被错误拒绝");
            let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
            let _ = snap.version;
        }
    }

    #[test]
    fn hub_wrong_method_and_unknown_path() {
        let (_hub, secret, port) = start_test_hub();
        let (code, _) = http_once(port, "GET", "/v1/sync", Some(&secret), None);
        assert_eq!(code, 405);
        let (code, _) = http_once(port, "POST", "/v1/devices", Some(&secret), Some(b"{}"));
        assert_eq!(code, 405);
        let (code, _) = http_once(port, "GET", "/v1/other", Some(&secret), None);
        assert_eq!(code, 404);
        let (code, _) = http_once(port, "PUT", "/v1/sync", Some(&secret), Some(b"{}"));
        assert_eq!(code, 405);
    }

    #[test]
    fn hub_second_device_updates_version_and_replaces_same_device() {
        let (_hub, secret, port) = start_test_hub();
        let (code, _) = post_json(port, Some(&secret), &serde_json::to_vec(&fixture_push()).unwrap());
        assert_eq!(code, 200);
        // 同一 device_id 再推：替换而非新增。
        let mut p = fixture_push();
        p.device_name = "改名机".into();
        let (code, _) = post_json(port, Some(&secret), &serde_json::to_vec(&p).unwrap());
        assert_eq!(code, 200);
        // 第二台设备。
        let mut q = fixture_push();
        q.device_id = "device-beta".into();
        let (code, _) = post_json(port, Some(&secret), &serde_json::to_vec(&q).unwrap());
        assert_eq!(code, 200);
        let (_, resp) = get_devices(port, Some(&secret));
        let snap: DevicesSnapshot = serde_json::from_slice(&body_of(&resp)).unwrap();
        assert_eq!(snap.version, 3);
        assert_eq!(snap.devices.len(), 2);
        let alpha = snap.devices.iter().find(|d| d.device_id == "device-alpha").unwrap();
        assert_eq!(alpha.device_name, "改名机");
    }

    #[test]
    fn hub_secret_change_requires_new_secret() {
        let (_hub, secret, port) = start_test_hub();
        let (code, _) = get_devices(port, Some(&secret));
        assert_eq!(code, 200);
        let (code, _) = get_devices(port, Some(&generate_secret()));
        assert_eq!(code, 401, "换密钥后旧密钥立即失效");
    }
}

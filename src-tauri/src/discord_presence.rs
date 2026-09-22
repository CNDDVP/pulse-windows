//! Discord Rich Presence（Round5d 项目二，opt-in 默认关）。
//!
//! 设计与隐私边界（docs/ROUND5D_PLAN.md【项目二】）：
//! - 仅当设置开关 `discord_presence_enabled` 开启时才与 Discord 客户端经本地 IPC（命名
//!   管道/套接字）通信；Discord 未运行（连接失败）一律静默忽略，不打日志不弹错。
//! - 广播内容只有三类聚合信息：活动状态（working/idle，复用活动灯信号——`AppState.activity`
//!   任一账号亮灯即 working）、已启用账号数、今日 token 总量（读 ledger 当日聚合，与趋势
//!   面板当日值同口径；需同时开启 `token_spend_enabled`，与既有账本读取门禁一致）。
//! - 不广播账号名/供应商名/凭据——payload 纯函数的入参 `PresenceData` 结构上只有数字与
//!   布尔，明细在类型层面就进不来（单测钉住序列化字段白名单）。
//! - 每 60s 节流：后台线程 60s 一拍，且仅当聚合值变化才发送；`Runner` 内置最小发送间隔
//!   双保险。开关关闭（或退出升级中）的 tick 不创建连接、不发送——零网络行为（单测钉住）。
//!
//! 诚实边界（README 同步注明）：Discord Rich Presence 需要在 Discord Developer Portal
//! 注册应用拿到 Client ID。Pulse 仓库不内置任何 ID；未设置环境变量
//! `PULSE_DISCORD_CLIENT_ID` 时连接器直接返回不可用（同样零 IPC 行为），开关形同未启用，
//! 不会向 Discord 发送任何东西。
use std::time::{Duration, Instant};

use discord_rich_presence::{activity::Activity, DiscordIpc, DiscordIpcClient};

/// 广播节拍：60s 一拍（每 60s 节流更新；连接失败下一拍静默重试）。
pub const TICK_SECS: u64 = 60;
/// Runner 内置最小发送间隔（与节拍同值的双保险：即使节拍被调密，发送也不密于 60s）。
pub const MIN_SEND_INTERVAL: Duration = Duration::from_secs(TICK_SECS);
/// Discord Application Client ID 的环境变量覆盖名（值须为已注册应用 ID；未设置 = 广播不可用）。
pub const CLIENT_ID_ENV: &str = "PULSE_DISCORD_CLIENT_ID";

/// 活动状态文案：working 复用活动灯聚合信号（诚实口径——灯亮只说明本机 CLI 在跑任务，
/// 不区分项目/语言）。
pub const STATE_WORKING: &str = "正在写代码";
pub const STATE_IDLE: &str = "空闲";

/// 一次广播的三类聚合输入。没有名字字段——账号名/供应商名在类型层面就无法进入 payload。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PresenceData {
    /// 活动灯聚合：任一被监控账号亮灯 = working。
    pub working: bool,
    /// 已启用账号数（当前账号数）。
    pub accounts: u32,
    /// 今日 token 总量（ledger 当日聚合；统计开关关闭或账本不可用时 None，广播里整行省略）。
    pub today_tokens: Option<u64>,
}

/// 后台线程每一拍的输入：设置快照 + 聚合数据（设置锁不可用时整拍跳过，保持现状）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickInput {
    pub enabled: bool,
    /// None = 本拍数据不可用（跳过，不视为变化）。
    pub presence: Option<PresenceData>,
}

impl TickInput {
    pub fn off() -> Self {
        Self { enabled: false, presence: None }
    }
}

/// 千分位分隔（1_234_567 -> "1,234,567"），今日 token 总量的展示格式。
pub fn format_tokens(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 { out.push(','); }
        out.push(c);
    }
    out
}

/// 构造广播 payload（纯函数）。details = 活动状态；state = 聚合数字行。
/// 今日 tokens 为 None（统计关/账本缺）时整段省略；为 Some(0) 时诚实显示 0（不当作缺失）。
pub fn build_activity(d: &PresenceData) -> Activity<'static> {
    let details = if d.working { STATE_WORKING } else { STATE_IDLE };
    let mut state = format!("启用账号 {} 个", d.accounts);
    if let Some(tokens) = d.today_tokens {
        state.push_str(&format!(" · 今日 {} tokens", format_tokens(tokens)));
    }
    Activity::new().details(details).state(state)
}

/// payload 的可比较形态：变化检测与单测断言都用它（Activity 只实现 Serialize）。
pub fn activity_json(d: &PresenceData) -> serde_json::Value {
    serde_json::to_value(build_activity(d)).unwrap_or(serde_json::Value::Null)
}

/// 一拍的三种网络动作（零网络行为是其中两种的恒等返回）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 不做任何 IO（开关关闭且无在途连接，或载荷未变化，或节流窗口内）。
    None,
    /// 需要先连接再发送（当前未连接）。
    ConnectSend,
    /// 复用现有连接发送（当前已连接）。
    Send,
    /// 开关刚被关闭：清空 Discord 状态并断开（一次性善后，之后每拍归零网络）。
    ClearAndClose,
}

/// 纯决策函数：开关关闭且无在途连接时恒 None（零网络行为）；连接/发送只在
/// 「开启 + 载荷变化 + 不在节流窗口」时发生。
pub fn decide_action(
    enabled: bool,
    connected: bool,
    payload_changed: bool,
    since_last_send: Option<Duration>,
    min_interval: Duration,
) -> Action {
    if !enabled {
        return if connected { Action::ClearAndClose } else { Action::None };
    }
    if !payload_changed || since_last_send.is_some_and(|e| e < min_interval) {
        return Action::None;
    }
    if connected { Action::Send } else { Action::ConnectSend }
}

/// 传输层抽象：生产实现包 `DiscordIpcClient`（本地 IPC），测试用假实现计数调用。
/// 错误一律折成 String 由调用方静默丢弃（连接失败静默语义）。
pub trait PresenceIpc: Send {
    fn connect(&mut self) -> Result<(), String>;
    fn set_activity(&mut self, activity: &Activity<'_>) -> Result<(), String>;
    fn clear_activity(&mut self) -> Result<(), String>;
    fn close(&mut self) -> Result<(), String>;
}

struct DiscordIpcTransport(DiscordIpcClient);
impl PresenceIpc for DiscordIpcTransport {
    fn connect(&mut self) -> Result<(), String> {
        DiscordIpc::connect(&mut self.0).map_err(|e| e.to_string())
    }
    fn set_activity(&mut self, activity: &Activity<'_>) -> Result<(), String> {
        DiscordIpc::set_activity(&mut self.0, activity.clone()).map_err(|e| e.to_string())
    }
    fn clear_activity(&mut self) -> Result<(), String> {
        DiscordIpc::clear_activity(&mut self.0).map_err(|e| e.to_string())
    }
    fn close(&mut self) -> Result<(), String> {
        DiscordIpc::close(&mut self.0).map_err(|e| e.to_string())
    }
}

/// 连接器工厂：生产实现按需读环境变量构造 `DiscordIpcClient`；返回 Err = 不可用（静默）。
pub type Connector = Box<dyn FnMut() -> Result<Box<dyn PresenceIpc>, String> + Send>;

/// 生产连接器：未配置 Client ID 时不发起任何 IPC（零网络行为），配置后把失败交给调用方静默。
pub fn production_connector() -> Result<Box<dyn PresenceIpc>, String> {
    let id = match std::env::var(CLIENT_ID_ENV) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => return Err(format!("未配置 {CLIENT_ID_ENV}，Discord 广播保持不可用（静默）")),
    };
    Ok(Box::new(DiscordIpcTransport(DiscordIpcClient::new(id))))
}

/// 状态机持有者：连接、上次发送的载荷与时间戳。所有失败路径都静默（计划语义），
/// 断连后下一拍自动重试（受节拍节流）。
pub struct Runner {
    connect: Connector,
    ipc: Option<Box<dyn PresenceIpc>>,
    last_json: Option<serde_json::Value>,
    last_send: Option<Instant>,
    min_interval: Duration,
}

impl Runner {
    pub fn new(connect: Connector, min_interval: Duration) -> Self {
        Self { connect, ipc: None, last_json: None, last_send: None, min_interval }
    }

    /// 是否当前持有连接（测试与诊断用）。
    pub fn connected(&self) -> bool {
        self.ipc.is_some()
    }

    /// 处理一拍。任何错误都被吞掉——连接失败静默，绝不向上传播。
    pub fn tick(&mut self, input: &TickInput) {
        let changed = match (&input.presence, &self.last_json) {
            (Some(d), Some(j)) => activity_json(d) != *j,
            (Some(_), None) => true,
            (None, _) => false,
        };
        let since_last_send = self.last_send.map(|t| t.elapsed());
        let action = decide_action(input.enabled, self.connected(), changed, since_last_send, self.min_interval);
        match action {
            Action::None => {}
            Action::ConnectSend => {
                let Some(data) = input.presence else { return };
                let Ok(mut client) = (self.connect)() else { return }; // 不可用/连接失败：静默
                if client.set_activity(&build_activity(&data)).is_ok() {
                    self.last_json = Some(activity_json(&data));
                    self.last_send = Some(Instant::now());
                    self.ipc = Some(client);
                } // 发送失败：丢弃半开连接，下一拍重连（静默）
            }
            Action::Send => {
                let Some(data) = input.presence else { return };
                let Some(client) = self.ipc.as_mut() else { return };
                if client.set_activity(&build_activity(&data)).is_ok() {
                    self.last_json = Some(activity_json(&data));
                    self.last_send = Some(Instant::now());
                } else {
                    let _ = client.close();
                    self.ipc = None;
                    self.last_json = None;
                    self.last_send = None;
                }
            }
            Action::ClearAndClose => {
                if let Some(mut client) = self.ipc.take() {
                    let _ = client.clear_activity();
                    let _ = client.close();
                }
                self.last_json = None;
                self.last_send = None;
            }
        }
    }
}

/// 今日 token 总量：读 ledger 当日聚合（与趋势面板当日值同口径，复用 daily_trends）。
/// 统计开关关闭（与既有账本读取同一道门禁）或账本文件不存在时不读、返回 None；
/// 查询失败同样 None（静默降级为不广播该行）。
fn today_tokens(stats_enabled: bool) -> Option<u64> {
    if !stats_enabled { return None; }
    let path = crate::ledger::ledger_db_path();
    if !path.is_file() { return None; }
    crate::ledger::daily_trends(&path, 1).ok()?.into_iter().next().map(|d| d.tokens)
}

/// 从应用状态读取一拍输入；设置锁被占用（保存中）时整拍跳过。
fn read_input(app: &tauri::AppHandle) -> Option<TickInput> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    let (enabled, accounts, stats_enabled) = {
        let s = state.settings.try_lock().ok()?;
        (
            s.discord_presence_enabled,
            s.providers.values().filter(|c| c.enabled).count() as u32,
            s.token_spend_enabled,
        )
    };
    if !enabled { return Some(TickInput::off()); }
    // 活动灯聚合（复用 poll_activity 写入的 per-account 信号）；灯映射锁异常按全灭处理。
    let working = state.activity.lock().map(|m| m.values().any(|(a, _)| *a)).unwrap_or(false);
    let today = today_tokens(stats_enabled);
    Some(TickInput { enabled: true, presence: Some(PresenceData { working, accounts, today_tokens: today }) })
}

/// 启动 60s 后台线程（阻塞 IO：本地 IPC 与 SQLite 都不该进 async 工作线程，
/// 与 poll_activity 的 spawn_blocking 同理）。绝无 panic 路径，失败均静默。
pub fn spawn(app: tauri::AppHandle) {
    let _ = std::thread::Builder::new().name("discord-presence".into()).spawn(move || {
        let mut runner = Runner::new(Box::new(production_connector), MIN_SEND_INTERVAL);
        loop {
            std::thread::sleep(Duration::from_secs(TICK_SECS));
            // 退出升级期间按“开关关闭”处理，把 Discord 状态清掉再退出。
            let input = if crate::updater::applying() {
                Some(TickInput::off())
            } else {
                read_input(&app)
            };
            if let Some(input) = input { runner.tick(&input); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicBool, AtomicU32, Ordering}};

    fn data(working: bool, accounts: u32, tokens: Option<u64>) -> PresenceData {
        PresenceData { working, accounts, today_tokens: tokens }
    }

    #[test]
    fn payload_state_text_follows_activity_light() {
        // working/idle 文案复用活动灯语义：任一账号亮灯 = 正在写代码，全灭 = 空闲。
        // Activity 字段私有，断言统一走序列化形态 activity_json。
        assert_eq!(activity_json(&data(true, 1, None))["details"], STATE_WORKING);
        assert_eq!(activity_json(&data(false, 1, None))["details"], STATE_IDLE);
    }

    #[test]
    fn payload_carries_account_count_and_today_tokens() {
        let j = activity_json(&data(true, 3, Some(1_234_567)));
        assert_eq!(j["details"], "正在写代码");
        let state = j["state"].as_str().unwrap();
        assert!(state.contains('3'), "账号数进 payload：{state}");
        assert!(state.contains("1,234,567"), "今日 token 总量进 payload：{state}");
        assert!(state.contains("今日"), "state 行：{state}");
    }

    #[test]
    fn payload_honest_zero_vs_missing_tokens() {
        // None（统计关/账本缺）→ 整行省略，不冒充 0；
        assert!(!activity_json(&data(false, 2, None))["state"].as_str().unwrap().contains("今日"));
        // Some(0)（账本在、今日确实为 0）→ 诚实显示 0。
        assert!(activity_json(&data(false, 2, Some(0)))["state"].as_str().unwrap().contains("今日 0 tokens"));
    }

    #[test]
    fn payload_serializes_only_whitelisted_fields() {
        // 隐私边界：序列化产物只含 details/state 两个白名单字段——timestamp/资产/按钮/派对
        // 一律缺席（skip_serializing_if），明细在类型层面就进不来。
        let j = activity_json(&data(true, 5, Some(42)));
        let obj = j.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, vec!["details", "state"], "payload 字段白名单被破坏：{obj:?}");
        // 双保险：即便未来加字段，广播产物也绝不出现账号/供应商名。
        let s = serde_json::to_string(&j).unwrap().to_lowercase();
        for banned in ["claude", "codex", "antigravity", "cursor", "label", "account-"] {
            assert!(!s.contains(banned), "payload 不应包含 {banned}");
        }
    }

    #[test]
    fn format_tokens_separates_thousands() {
        assert_eq!(format_tokens(0), "0");
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1_000), "1,000");
        assert_eq!(format_tokens(1_234_567), "1,234,567");
    }

    #[test]
    fn decide_switch_off_with_no_connection_is_zero_network() {
        // 开关关闭（且无在途连接）：无论载荷是否变化、节流状态如何——恒 None。
        // 生产上 Runner 在关态从不创建连接，本决策是其唯一路径。
        for changed in [true, false] {
            for since in [None, Some(Duration::ZERO), Some(Duration::from_secs(3600))] {
                assert_eq!(
                    decide_action(false, false, changed, since, MIN_SEND_INTERVAL),
                    Action::None,
                    "关态任何输入都不得产生网络动作"
                );
            }
        }
    }

    #[test]
    fn decide_switch_off_with_live_connection_clears_once() {
        // 关闭瞬间的唯一善后：清状态并断开；此后 connected=false 回到恒 None。
        assert_eq!(decide_action(false, true, false, None, MIN_SEND_INTERVAL), Action::ClearAndClose);
    }

    #[test]
    fn decide_switch_on_needs_change_and_respects_throttle() {
        const MIN: Duration = Duration::from_secs(60);
        // 开启但载荷未变化 → 不发送（60s 节流语义：只在变化时更新）。
        assert_eq!(decide_action(true, true, false, Some(Duration::from_secs(59)), MIN), Action::None);
        assert_eq!(decide_action(true, false, false, None, MIN), Action::None);
        // 节流窗口内即使变化也不发送。
        assert_eq!(decide_action(true, true, true, Some(Duration::from_secs(59)), MIN), Action::None);
        // 窗口外（或从未发送）才发送：已连接 → Send，未连接 → ConnectSend。
        assert_eq!(decide_action(true, true, true, Some(MIN), MIN), Action::Send);
        assert_eq!(decide_action(true, false, true, Some(Duration::from_secs(61)), MIN), Action::ConnectSend);
        assert_eq!(decide_action(true, false, true, None, MIN), Action::ConnectSend);
    }

    /// 测试用假 IPC：可配置成功/失败（计数断言由专用假实现承担）。
    struct FakeIpc { ok: bool }

    impl FakeIpc {
        fn new(ok: bool) -> Self { Self { ok } }
    }
    impl PresenceIpc for FakeIpc {
        fn connect(&mut self) -> Result<(), String> { if self.ok { Ok(()) } else { Err("no discord".into()) } }
        fn set_activity(&mut self, _a: &Activity<'_>) -> Result<(), String> {
            if self.ok { Ok(()) } else { Err("pipe broken".into()) }
        }
        fn clear_activity(&mut self) -> Result<(), String> { Ok(()) }
        fn close(&mut self) -> Result<(), String> { Ok(()) }
    }

    #[test]
    fn runner_switch_off_never_touches_network() {
        // THE 零网络行为单测：开关关闭时连续多拍（即便带数据），连接器零调用、零发送。
        let connects = Arc::new(AtomicU32::new(0));
        let c2 = connects.clone();
        let mut runner = Runner::new(
            Box::new(move || {
                c2.fetch_add(1, Ordering::Relaxed);
                Ok(Box::new(FakeIpc::new(true)) as Box<dyn PresenceIpc>)
            }),
            Duration::ZERO,
        );
        for _ in 0..5 {
            runner.tick(&TickInput { enabled: false, presence: Some(data(true, 3, Some(99))) });
            runner.tick(&TickInput::off());
        }
        assert_eq!(connects.load(Ordering::Relaxed), 0, "关态不得发起任何连接");
        assert!(!runner.connected());
        assert_eq!(runner.last_json, None, "关态不残留上次载荷");
    }

    #[test]
    fn runner_sends_exactly_on_change() {
        // 开启后：同值连拍只发一次；任一聚合值变化（活动/账号数/tokens）才再发。
        let sends = Arc::new(AtomicU32::new(0));
        let s2 = sends.clone();
        struct Counting { n: Arc<AtomicU32> }
        impl PresenceIpc for Counting {
            fn connect(&mut self) -> Result<(), String> { Ok(()) }
            fn set_activity(&mut self, _a: &Activity<'_>) -> Result<(), String> { self.n.fetch_add(1, Ordering::Relaxed); Ok(()) }
            fn clear_activity(&mut self) -> Result<(), String> { Ok(()) }
            fn close(&mut self) -> Result<(), String> { Ok(()) }
        }
        let mut runner = Runner::new(
            Box::new(move || Ok(Box::new(Counting { n: s2.clone() }) as Box<dyn PresenceIpc>)),
            Duration::ZERO,
        );
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 3, None)) });
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 3, None)) });
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 3, None)) });
        assert_eq!(sends.load(Ordering::Relaxed), 1, "同值连拍只发一次（60s 节流）");
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 3, Some(7))) });
        assert_eq!(sends.load(Ordering::Relaxed), 2, "tokens 变化才再发");
        runner.tick(&TickInput { enabled: true, presence: Some(data(false, 3, Some(7))) });
        assert_eq!(sends.load(Ordering::Relaxed), 3, "活动状态变化是载荷变化");
        runner.tick(&TickInput { enabled: true, presence: Some(data(false, 5, Some(7))) });
        assert_eq!(sends.load(Ordering::Relaxed), 4, "账号数变化是载荷变化");
        runner.tick(&TickInput { enabled: true, presence: None });
        assert_eq!(sends.load(Ordering::Relaxed), 4, "数据不可用的拍跳过，不视为变化");
        assert!(runner.connected(), "跳过拍不断连");
    }

    #[test]
    fn runner_connect_failure_is_silent_and_retries_next_tick() {
        // Discord 未运行：连接失败静默（不 panic、无状态残留）。从未成功发送过
        // （last_json=None）时每拍重试（频率受 60s 节拍限制）；成功后同值载荷不再重试。
        let connects = Arc::new(AtomicU32::new(0));
        let c2 = connects.clone();
        let fail = Arc::new(AtomicBool::new(true));
        let f2 = fail.clone();
        let mut runner = Runner::new(
            Box::new(move || {
                c2.fetch_add(1, Ordering::Relaxed);
                if f2.load(Ordering::Relaxed) { Err("discord 未运行".into()) }
                else { Ok(Box::new(FakeIpc::new(true)) as Box<dyn PresenceIpc>) }
            }),
            Duration::ZERO,
        );
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert!(!runner.connected());
        assert_eq!(connects.load(Ordering::Relaxed), 1, "失败静默，无 panic");
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert_eq!(connects.load(Ordering::Relaxed), 2, "未成功发送过 → 每拍重试（节拍限频）");
        // Discord 恢复：连接成功并发送。
        fail.store(false, Ordering::Relaxed);
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert!(runner.connected(), "恢复后下一拍连上");
        let after_ok = connects.load(Ordering::Relaxed);
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert_eq!(connects.load(Ordering::Relaxed), after_ok, "已连接且载荷未变化不重连");
    }

    #[test]
    fn runner_send_failure_drops_connection_and_recovers() {
        // 已连接但管道断了：静默断开，下一拍重连重发。
        let broken = Arc::new(AtomicBool::new(true));
        let b2 = broken.clone();
        struct Flaky { broken: Arc<AtomicBool> }
        impl PresenceIpc for Flaky {
            fn connect(&mut self) -> Result<(), String> { Ok(()) }
            fn set_activity(&mut self, _a: &Activity<'_>) -> Result<(), String> {
                if self.broken.load(Ordering::Relaxed) { Err("pipe broken".into()) } else { Ok(()) }
            }
            fn clear_activity(&mut self) -> Result<(), String> { Ok(()) }
            fn close(&mut self) -> Result<(), String> { Ok(()) }
        }
        let mut runner = Runner::new(
            Box::new(move || Ok(Box::new(Flaky { broken: b2.clone() }) as Box<dyn PresenceIpc>)),
            Duration::ZERO,
        );
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert!(!runner.connected(), "发送失败丢弃半开连接");
        broken.store(false, Ordering::Relaxed);
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert!(runner.connected(), "下一拍重连成功");
    }

    #[test]
    fn runner_disable_clears_once_then_stays_off() {
        let clears = Arc::new(AtomicU32::new(0));
        let closes = Arc::new(AtomicU32::new(0));
        let (c3, l3) = (clears.clone(), closes.clone());
        struct Clearing { clears: Arc<AtomicU32>, closes: Arc<AtomicU32> }
        impl PresenceIpc for Clearing {
            fn connect(&mut self) -> Result<(), String> { Ok(()) }
            fn set_activity(&mut self, _a: &Activity<'_>) -> Result<(), String> { Ok(()) }
            fn clear_activity(&mut self) -> Result<(), String> { self.clears.fetch_add(1, Ordering::Relaxed); Ok(()) }
            fn close(&mut self) -> Result<(), String> { self.closes.fetch_add(1, Ordering::Relaxed); Ok(()) }
        }
        let mut runner = Runner::new(
            Box::new(move || Ok(Box::new(Clearing { clears: c3.clone(), closes: l3.clone() }) as Box<dyn PresenceIpc>)),
            Duration::ZERO,
        );
        runner.tick(&TickInput { enabled: true, presence: Some(data(true, 1, None)) });
        assert!(runner.connected());
        // 关闭：一次性 clear+close，之后每拍零调用。
        runner.tick(&TickInput::off());
        assert_eq!(clears.load(Ordering::Relaxed), 1);
        assert_eq!(closes.load(Ordering::Relaxed), 1);
        assert!(!runner.connected());
        for _ in 0..3 { runner.tick(&TickInput::off()); }
        assert_eq!(clears.load(Ordering::Relaxed), 1, "关态保持零网络行为");
        assert_eq!(closes.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn production_connector_requires_client_id() {
        // 未配置 Client ID：连接器不可用（生产 spawn 路径因此零 IPC 行为）。
        // 测试进程内若外部环境已设置该变量，则跳过断言而不是失败（不与真实配置打架）。
        if std::env::var(CLIENT_ID_ENV).is_ok() {
            return;
        }
        assert!(production_connector().is_err(), "未配置 Client ID 时连接器必须不可用");
    }

    #[test]
    fn tick_period_is_sixty_seconds() {
        // 规格钉住：每 60s 节流更新。
        assert_eq!(TICK_SECS, 60);
        assert_eq!(MIN_SEND_INTERVAL, Duration::from_secs(60));
    }
}

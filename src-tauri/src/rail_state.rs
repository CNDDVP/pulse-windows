use crate::types::AppSettings;
use std::time::Instant;

/// Shared by the watchdog and delayed frontend acknowledgements.
pub fn may_collapse(settings: &AppSettings, pin_until: Option<Instant>, now: Instant, interacting: bool) -> bool {
    settings.auto_collapse_seconds > 0 && settings.dock_side != "free" && !interacting
        && !pin_until.is_some_and(|until| now < until)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn reveal_pin_wins_over_short_auto_collapse_and_late_ack() {
        let now=Instant::now();let pin=Some(now+Duration::from_secs(5));
        let mut settings=AppSettings::default();settings.auto_collapse_seconds=1;
        for seconds in 0..5 { assert!(!may_collapse(&settings,pin,now+Duration::from_secs(seconds),false)); }
        assert!(may_collapse(&settings,pin,now+Duration::from_secs(5),false));
        assert!(!may_collapse(&settings,None,now,true)); // rail, detail or dragging
        settings.dock_side="free".into();assert!(!may_collapse(&settings,None,now,false));
        settings.dock_side="right".into();settings.auto_collapse_seconds=0;
        assert!(!may_collapse(&settings,None,now,false));
    }
}

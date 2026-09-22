import {useEffect,useState} from "react";
import type {AppSettings,ProviderUsage} from "../types";
import {resetText,forecast,forecastKind,timingWindows,balanceText,balanceLabel} from "../presentation";
import {convertBalance,formatMoney,normalizeDisplayCurrency,normalizeRate,rateEstimateNote} from "../lib/currency";
import {HourlyUsageChart} from "./HourlyUsageChart";
import {useLang} from "../lib/i18n";
export function UsageDetailCard({usage,settings,placement,cardRef}:{usage:ProviderUsage;settings:AppSettings;placement?: "left" | "right" | "top" | "bottom";cardRef?:React.Ref<HTMLElement>}){
  const {t,lang}=useLang();
  // 详情卡内日期的展示 locale 跟随界面语言（zh→zh-CN，en→en-US）。
  const dateLocale=lang==="en"?"en-US":"zh-CN";
  const [now,setNow]=useState(()=>Date.now());useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),10000);return()=>clearInterval(t)},[]);
  const timed=timingWindows(usage,settings.providers[usage.account_id],lang);
  const dark = settings.theme === "obsidian";
  const isRightOfRail = placement !== undefined ? placement === "right" : settings.dock_side === "left";
  // 侧向小箭头只在卡片位于 rail 左/右侧时有意义；正下/正上时朝向用 dock_side 兜底。
  const sideways = placement ? placement==="left"||placement==="right" : settings.dock_side!=="top";

  const isRemaining = settings.display_mode === "remaining";
  const red = settings.warning_threshold, amber = red - 15;

  const animClass = isRightOfRail ? "card-animate-left" : "card-animate-right";
  return <section ref={cardRef} className={`detail-scroll-container relative rounded-2xl p-4 max-h-full overflow-y-auto overflow-x-hidden w-[290px] text-xs ${animClass} ${dark?"card-obsidian text-zinc-200":"card-translucent text-zinc-800"}`}>
    {sideways && (
      <div
        className={`absolute top-6 w-3 h-3 rotate-45 pointer-events-none ${
          isRightOfRail
            ? "-left-1.5 " + (dark ? "bg-[#131317] border-l border-b border-white/10" : "bg-white border-l border-b border-black/10")
            : "-right-1.5 " + (dark ? "bg-[#131317] border-r border-t border-white/10" : "bg-white border-r border-t border-black/10")
        }`}
      />
    )}
    <strong className="text-sm">{usage.display_name}</strong><p className="text-zinc-500">{usage.plan_name}</p>
    {/* Round4 项目一：实时速率行仅在账号处于工作状态时显示；None/缺省 = 渠道日志无
        usage 字段或速率不足 1，显示「—」，不编造。值为后端取整后的 tok/min。 */}
    {usage.is_active&&(
      <p className="text-zinc-500 mt-0.5">{t("rail.detail.rate",{rate:typeof usage.tok_per_min==="number"&&usage.tok_per_min>=1?`${Math.round(usage.tok_per_min)} tok/min`:"—"})}</p>
    )}
    {/* TODO(EN-backend)：usage.error_message 为 Rust 侧消息，原样展示不做翻译映射。 */}
    {usage.error_message && (
      <p className="text-amber-500 my-2">
        {usage.state === "stale"
          ? (usage.error_code === "local_service" ? t("rail.detail.err_app_not_running") : t("rail.detail.err_stale",{message:usage.error_message}))
          : usage.error_message}
      </p>
    )}
    {usage.windows.map(w => {
      const pct = isRemaining ? Math.max(0, 100 - w.used_percent) : w.used_percent;
      const label = isRemaining ? t("rail.detail.remaining") : t("rail.detail.used");
      const barColor = w.exhausted || w.used_percent >= red ? "#ef4444" : w.used_percent >= amber ? "#f97316" : w.used_percent >= 50 ? "#eab308" : "#10b981";
      return (
        <div key={w.id} className="mt-3">
          <div className="flex justify-between gap-2">
            <span>{w.name}</span>
            <b>{Number(pct.toFixed(2))}% {label}</b>
          </div>
          <div className="h-1.5 bg-zinc-500/20 rounded my-1">
            <div
              className="h-full rounded transition-all duration-300"
              // 条形跟随数字语义：剩余模式下显示剩余比例（颜色仍按已用量判危险等级），
              // 否则数字"76% 剩余"配 76% 宽的条会读成"只剩 24%"。
              style={{width:`${Math.min(100,Math.max(0,pct))}%`,backgroundColor:barColor}}
            />
          </div>
          <p className="text-zinc-500">{resetText(w.resets_at,now,lang)}</p>
          <p className="text-zinc-500">{timed.find(t=>t.id===w.id)?.period_note}</p>
          {settings.forecast&&usage.state==="live"&&(()=>{
            const kind=forecastKind(w,now);
            const color=kind==="exhausted"?"text-red-500":kind==="ok"?"text-emerald-500":kind==="soon"?"text-orange-500":"text-yellow-500";
            return <p className={color}>{forecast(w,now,lang)}</p>;
          })()}
        </div>
      );
    })}
    {usage.balances.map((b,i)=>{
      // Round4 项目二：显示币种为 CNY 时，仅对 USD 余额按固定汇率给出折算参考行，
      // 且必须就近标注口径；其余币种（原生 CNY、Credit 积分等）无换算口径，原样显示。
      const displayCurrency=normalizeDisplayCurrency(settings.display_currency);
      const fxRate=normalizeRate(settings.usd_cny_rate);
      const converted=convertBalance(b.amount,b.currency,displayCurrency,fxRate);
      const note=rateEstimateNote(displayCurrency,fxRate,lang);
      return (
      <div key={i} className="mt-3">
        <p className="text-base font-medium">{t("rail.balance.line",{label:balanceLabel(usage.provider_id,b.currency,lang),value:balanceText(b.currency,b.amount,lang)})}</p>
        {converted!=null&&note&&<p className="text-[11px] text-zinc-400 mt-0.5">≈ {formatMoney(converted,displayCurrency)}{t("rail.detail.rate_note_wrap",{note})}</p>}
        {b.expires_at && (
          <p className="text-[11px] text-zinc-400 mt-0.5">
            {t("rail.detail.expires_at",{time:new Date(b.expires_at).toLocaleString(dateLocale, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })})}
          </p>
        )}
      </div>
    );})}
    {usage.hourly_usages && usage.hourly_usages.length > 0 && (
      <HourlyUsageChart usages={usage.hourly_usages} compact={true} />
    )}
    {!usage.windows.length&&!usage.balances.length&&!usage.error_message&&<p>{t("rail.detail.no_readings")}</p>}
    <p className="mt-3 text-[10px] text-zinc-500">{usage.source||t("rail.detail.source_fallback")}{usage.last_success_at&&` · ${t("rail.detail.last_success",{time:new Date(usage.last_success_at).toLocaleString()})}`}</p>
  </section>;
}

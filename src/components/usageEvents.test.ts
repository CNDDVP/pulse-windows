import { describe, expect, it, beforeEach } from "vitest";
import { detectEvent, resetBotHistory } from "./botEvents";
import type { ProviderUsage } from "../types";

function usage(over: Partial<ProviderUsage>): ProviderUsage {
  return {
    account_id: "a1", provider_id: "openai", display_name: "OpenAI",
    state: "live", primary_percent: 40, plan_name: null, is_active: false,
    windows: [{ id: "w5h", name: "5h", used_fraction: 0.4, used_percent: 40, resets_at: null, window_seconds: null, exhausted: false }],
    balances: [], error_code: null, error_message: null, source: "test",
    checked_at: null, last_success_at: null, retry_after_seconds: null, duration_ms: null,
    ...over,
  };
}

beforeEach(() => resetBotHistory());

describe("机器人事件检测", () => {
  it("同窗口用量骤降 ≥20 点 → 额度重置", () => {
    expect(detectEvent("k", usage({windows:[{...usage({}).windows[0],resets_at:"2026-09-20T00:00:00Z"}]}), "idle")).toBeNull();
    const event = detectEvent("k", usage({ primary_percent: 5, windows: [{ id: "w5h", name: "5h", used_fraction: 0.05, used_percent: 5, resets_at: "2026-09-21T00:00:00Z", window_seconds: null, exhausted: false }] }), "idle");
    expect(event?.kind).toBe("limitReset");
  });

  it("小幅波动不触发", () => {
    detectEvent("k", usage({}), "idle");
    expect(detectEvent("k", usage({ primary_percent: 30 }), "idle")).toBeNull();
  });

  it("is_active 下降沿 → 完工", () => {
    expect(detectEvent("k", usage({ is_active: true }), "working")).toBeNull();
    expect(detectEvent("k", usage({ is_active: false }), "idle")?.kind).toBe("workFinished");
  });

  it("从离线/无读数恢复 → 醒来", () => {
    expect(detectEvent("k", usage({ state: "error", primary_percent: null }), "unavailable")).toBeNull();
    expect(detectEvent("k", usage({}), "idle")?.kind).toBe("woke");
  });

  it("持有期内重复报告同一事件（seq 不变）", () => {
    detectEvent("k", usage({ is_active: true }), "working");
    const first = detectEvent("k", usage({ is_active: false }), "idle");
    const second = detectEvent("k", usage({ is_active: false }), "idle");
    expect(first?.seq).toBe(second?.seq);
  });
});

it('changing selected primary does not celebrate',()=>{
 resetBotHistory();const u=usage({windows:[{...usage({}).windows[0],id:'a',used_percent:85},{...usage({}).windows[0],id:'b',used_percent:20}]});
 detectEvent('selected',u,'idle','a');expect(detectEvent('selected',{...u,primary_percent:20},'idle','b')).toBeNull();
});
it('a drop without a reset boundary does not celebrate',()=>{
 resetBotHistory();detectEvent('drop',usage({}),'idle');expect(detectEvent('drop',usage({primary_percent:0,windows:[{...usage({}).windows[0],used_percent:0}]}),'idle')).toBeNull();
});

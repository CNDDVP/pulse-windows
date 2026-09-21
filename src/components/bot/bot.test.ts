import { describe, expect, it } from "vitest";
import { BotSpring, cubicInOut, unitRemainder } from "./math";
import { lerpRing, pathOpsD, reflected, ringOutlineD, spanAt } from "./geometry";
import { loadBotData, shapeOf, stateOf } from "./data";
import { BotMarkEngine } from "./engine";
import type { Programme } from "./mood";
import {
  eventDuration, eventState, gazeFromLookX, idleStates, personaState, workingStates,
  type Mood,
} from "./mood";

function prog(states: string[], mood: Mood = "idle"): Programme {
  return {
    states, hold: [2500, 4500], event: null, mood, shape: "blob",
    tempo: 1, motionScale: 1, gazeScale: 1, eyeScale: 1, gazeBias: 0, flipX: false,
    rotationScale: 1, squashScale: 1, particlesEnabled: true, viewWidth: 20,
  };
}

describe("math", () => {
  it("弹簧向目标收敛，欠阻尼时过冲", () => {
    const s = new BotSpring(0);
    s.target = 1;
    let overshot = false;
    for (let i = 0; i < 600; i++) {
      s.step(5, 0.8, 1 / 120);
      if (s.value > 1.005) overshot = true;
    }
    expect(overshot).toBe(true);
    expect(Math.abs(s.value - 1)).toBeLessThan(0.01);
  });

  it("弹簧遇到非有限值时回到目标", () => {
    const s = new BotSpring(0);
    s.value = NaN;
    s.target = 2;
    s.step(5, 1, 1 / 120);
    expect(s.value).toBe(2);
    expect(s.velocity).toBe(0);
  });

  it("cubicInOut 端点与中点", () => {
    expect(cubicInOut(0)).toBe(0);
    expect(cubicInOut(0.5)).toBe(0.5);
    expect(cubicInOut(1)).toBe(1);
  });

  it("unitRemainder 恒在 0..<1", () => {
    expect(unitRemainder(-0.25)).toBeCloseTo(0.75);
    expect(unitRemainder(1.25)).toBeCloseTo(0.25);
    expect(unitRemainder(3)).toBeCloseTo(0);
  });
});

describe("geometry", () => {
  it("lerpRing 端点与中点", () => {
    const from = [[0, 0]] as [number, number][];
    const to = [[10, 10]] as [number, number][];
    expect(lerpRing(from, to, 0)[0]).toEqual([0, 0]);
    expect(lerpRing(from, to, 1)[0]).toEqual([10, 10]);
    expect(lerpRing(from, to, 0.5)[0]).toEqual([5, 5]);
  });

  it("镜像保长度并翻转 x", () => {
    const ring: [number, number][] = [[3, 1], [5, 2], [7, 1]];
    const out = reflected(ring, 5);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual([7, 1]);
  });

  it("spanAt 扫描左右边界", () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const [left, right] = spanAt(square, 5, 5);
    expect(left).toBe(0);
    expect(right).toBe(10);
  });

  it("ringOutlineD 生成闭合贝塞尔", () => {
    const d = ringOutlineD([[0, 0], [10, 0], [10, 10], [0, 10]]);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("C");
    expect(d.endsWith("Z")).toBe(true);
  });

  it("pathOpsD 拼接 JSON 路径段", () => {
    expect(pathOpsD([
      { op: "M", values: [1.11, 2.2] },
      { op: "L", values: [3, 4] },
    ])).toBe("M1.1,2.2L3,4");
  });
});

describe("data", () => {
  it("解码真实 bot-data.json", async () => {
    const data = await loadBotData();
    expect(data.states).toHaveLength(39);
    expect(data.expressions[0]).toHaveLength(2);
    expect(data.circleRing).toHaveLength(96);
    expect(data.headC).toBeCloseTo(114.27, 1);
    expect(data.starGold).toBe("#f4c34e");
    expect(data.eyeReach).toBeGreaterThan(0);
  });

  it("关键状态带 morph，未知状态回退 blob/idle", async () => {
    const data = await loadBotData();
    expect(stateOf(data, "alerting").morph).toBe("bang");
    expect(stateOf(data, "spawning").morph).toBe("gather");
    expect(stateOf(data, "writing").morph).toBe("pencil");
    expect(stateOf(data, "idle").blinkCadence).toEqual([6000, 14000]);
    expect(stateOf(data, "no-such-state").id).toBe(data.states[0].id);
    expect(shapeOf(data, "no-such-shape").ring.length).toBe(96);
  });
});

describe("mood 层", () => {
  it("working 播放列表不重复且加班加入 angry", () => {
    const calm = workingStates("calm", false, false);
    expect(calm).toEqual(["working", "spawning", "writing"]);
    expect(workingStates("calm", true, false)).toContain("angry");
  });

  it("警戒时 idle 轮换加入 alerting", () => {
    expect(idleStates("calm", false)).toEqual(["idle"]);
    const alerting = idleStates("calm", true);
    expect(alerting).toContain("idle");
    expect(alerting).toContain("alerting");
  });

  it("个性只改说法不改事实", () => {
    expect(personaState("eager", "working")).toBe("excited");
    expect(personaState("stoic", "working")).toBe("working");
    expect(personaState("sleepy", "spent")).toBe("drowsy");
    expect(personaState("stoic", "asleep")).toBe("powering-down");
  });

  it("事件映射与时长", () => {
    expect(eventState("limitReset")).toBe("celebrate");
    expect(eventState("workFinished")).toBe("excited");
    expect(eventState("woke")).toBe("waking");
    expect(eventDuration("limitReset")).toBeGreaterThan(eventDuration("workFinished"));
  });

  it("朝向：右停靠反向带偏倚，自由朝前", () => {
    expect(gazeFromLookX(-1)).toEqual({ bias: 7, mirrored: true });
    expect(gazeFromLookX(1)).toEqual({ bias: 7, mirrored: false });
    expect(gazeFromLookX(0)).toEqual({ bias: 0, mirrored: false });
  });
});

describe("engine", () => {
  it("空闲推进 4 秒输出完整帧，无 NaN", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = prog(["idle"]);
    let t = 0;
    let frame = engine.advance(t, p);
    for (let i = 0; i < 120; i++) frame = engine.advance(t += 1 / 30, p);
    expect(frame.headD).toContain("M");
    expect(frame.headTransform).toContain("translate");
    expect(frame.eyes).toHaveLength(2);
    expect(frame.viewBoxRadius).toBeCloseTo(129.5, 1);
    const sample = `${frame.headD}${frame.headTransform}${frame.eyes.map(e => e.d + e.transform).join("")}`;
    expect(sample).not.toContain("NaN");
  });

  it("morph 状态下特效出现且眼睛在半程隐没", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = prog(["thinking"]); // dots morph
    let t = 0;
    let sawShapes = false;
    let eyesHid = false;
    for (let i = 0; i < 45; i++) {
      const frame = engine.advance(t += 1 / 30, p);
      if (frame.shapes.length > 0) sawShapes = true;
      if (frame.eyes.every(e => !e.visible) && frame.morphAmount > 0.5) eyesHid = true;
    }
    expect(sawShapes).toBe(true);
    expect(eyesHid).toBe(true);
  });

  it("alerting 状态画出'！'警示字形", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = prog(["alerting"]);
    let t = 0;
    let saw = false;
    for (let i = 0; i < 45; i++) {
      const frame = engine.advance(t += 1 / 30, p);
      if (frame.shapes.length > 0) saw = true;
    }
    expect(saw).toBe(true);
  });

  it("writing 状态画出铅笔特效与变换，且以 translate(-c, -c) 结束", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = prog(["writing"]);
    let t = 0;
    let pencilShape: { d: string; transform?: string } | null = null;
    for (let i = 0; i < 45; i++) {
      const frame = engine.advance(t += 1 / 30, p);
      const found = frame.shapes.find(s => s.transform?.includes("translate"));
      if (found) { pencilShape = found; break; }
    }
    expect(pencilShape).not.toBeNull();
    // SVG 右至左求值：最右侧必须是 translate(-c, -c) 将字形中心归零后再缩放旋转
    expect(pencilShape!.transform).toMatch(/translate\(-[0-9.]+,[ ]*-[0-9.]+\)$/);
  });

  it("notifying 状态出现 badge 且带有半径和颜色", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = prog(["notifying"]);
    let t = 0;
    let badgeFound = false;
    for (let i = 0; i < 45; i++) {
      const frame = engine.advance(t += 1 / 30, p);
      if (frame.badge && frame.badge.r > 0) { badgeFound = true; break; }
    }
    expect(badgeFound).toBe(true);
  });

  it("poke 触发粒子爆裂", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    engine.advance(0, prog(["idle"]));
    engine.poke();
    const frame = engine.advance(1 / 30, prog(["idle"]));
    expect(frame.back.length).toBeGreaterThan(0);
  });

  it("celebrate 大画布一秒内出现丝带或彩纸", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    // 丝带只在 >36px 画布渲染（小画布门控），这里用 64px。
    const p = { ...prog(["celebrate"]), viewWidth: 64 };
    let t = 0;
    let particles = 0;
    for (let i = 0; i < 30; i++) {
      const frame = engine.advance(t += 1 / 30, p);
      particles = Math.max(particles, frame.back.length + frame.front.length);
    }
    expect(particles).toBeGreaterThan(0);
  });

  it("小画布（环内 20px）不渲染轨道丝带，避免拖死点击", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = prog(["loading"]); // whirl：粒子带 + 高速自旋
    let t = 0;
    let ribbonLike = 0;
    for (let i = 0; i < 60; i++) {
      const frame = engine.advance(t += 1 / 30, p);
      ribbonLike = Math.max(ribbonLike, frame.back.length + frame.front.length);
    }
    expect(ribbonLike).toBe(0);
  });

  it("事件只播一次，seq 不变不重播", async () => {
    const data = await loadBotData();
    const engine = new BotMarkEngine(data);
    const p = { ...prog(["idle"]), event: { kind: "workFinished" as const, seq: 1 } };
    let t = 0;
    engine.advance(t, p);
    // 播完事件的按住期内状态是 excited，回落后才是 idle。
    let excitedFrames = 0;
    let idleFrames = 0;
    for (let i = 0; i < 130; i++) {
      engine.advance(t += 1 / 30, p);
      if (engine.state === "excited") excitedFrames += 1;
      if (engine.state === "idle") idleFrames += 1;
    }
    expect(excitedFrames).toBeGreaterThan(0);
    // 事件持有期结束（2.6s）后回到播放列表，且不会因事件仍在传入而重播。
    expect(idleFrames).toBeGreaterThan(0);
  });
});

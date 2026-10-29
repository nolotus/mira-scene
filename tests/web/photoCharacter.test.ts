/**
 * 照片角色的表演逻辑与回退决策。
 *
 * 三组性质（都是「照片方案没有第二层兜底」的地方，必须先钉死）：
 *   ① 口型节奏是**纯函数**：同一 (subtitle, elapsed) 永远同一口型，不依赖真实时钟；
 *      快语速下退化两态（闭合/张开），否则 3 张图会读作抖动。
 *   ② 情绪 → 眼/嘴组合：7 种情绪必须**两两可区分**（curious 与 surprised 不许同一张图）。
 *   ③ 回退决策：只有「开关打开 + 素材就绪」才走照片，其余一律 SVG，且每种原因各有一档。
 */

import { describe, expect, test } from "bun:test";
import {
  EMOTION_FACE,
  FAST_SYLLABLE_MS,
  MAX_STEPS,
  MIN_SYLLABLE_MS,
  PHOTO_MOTION,
  SPEAK_ONSET_MS,
  STATUS_PLACEMENT,
  faceAt,
  faceKey,
  faceVariantsUsed,
  motionEnabled,
  mouthAt,
  mouthIndex,
  mouthVariantOfPhase,
  syllableMs,
  transitionMs,
} from "../../src/web/stage/characters/photoRig";
import { MOUTH_VARIANTS, PORTRAIT_BASE_FILE } from "../../src/web/stage/characters/portraitSpec";
import {
  decidePortraitMode,
  parseCharFlag,
  reasonOfSpecIssue,
  type PortraitResource,
} from "../../src/web/stage/characters/portraitRuntime";

const SLOW_SENTENCE = "嗯。"; // 2 字 → 音节长，允许三态
const FAST_SENTENCE = "雨好像不打算停了你要的那杯我还留着再等一会儿也没关系真的没关系的".repeat(2); // 长句 → 音节短

describe("mouthIndex：节奏函数", () => {
  test("确定性：同 (subtitle, elapsed) 反复调用结果一致", () => {
    for (const ms of [0, 69, 70, 180, 420, 1600, 5000]) {
      const a = mouthIndex(SLOW_SENTENCE, ms);
      expect(mouthIndex(SLOW_SENTENCE, ms)).toBe(a);
      expect(mouthIndex(SLOW_SENTENCE, ms)).toBe(a);
    }
  });

  test("只会返回 MOUTH_VARIANTS 的下标（0/1/2）", () => {
    for (let ms = 0; ms <= 8000; ms += 37) {
      const index = mouthIndex(FAST_SENTENCE, ms);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(MOUTH_VARIANTS.length);
      expect(Number.isInteger(index)).toBe(true);
    }
  });

  test("开场先闭嘴一拍：elapsed < SPEAK_ONSET_MS 一定是闭合", () => {
    expect(mouthIndex(SLOW_SENTENCE, 0)).toBe(0);
    expect(mouthIndex(SLOW_SENTENCE, SPEAK_ONSET_MS - 1)).toBe(0);
  });

  test("空字幕 / 负时间 / NaN 都退化成闭合，不抛", () => {
    expect(mouthIndex("", 1000)).toBe(0);
    expect(mouthIndex("   ", 1000)).toBe(0);
    expect(mouthIndex(SLOW_SENTENCE, -1)).toBe(0);
    expect(mouthIndex(SLOW_SENTENCE, Number.NaN)).toBe(0);
  });

  test("慢语速（音节 ≥180ms）会用到三态里的每一档", () => {
    const seen = new Set<number>();
    for (let ms = 0; ms <= 6000; ms += 10) seen.add(mouthIndex(SLOW_SENTENCE, ms));
    expect(seen.has(0)).toBe(true);
    expect(seen.has(1)).toBe(true);
    expect(seen.has(2)).toBe(true);
  });

  test("快语速（音节 <180ms）退化两态：half 不再出现，只剩闭合/张开", () => {
    const chars = Array.from(FAST_SENTENCE);
    // 前提自检：这段字幕的**基准节奏**短于阈值（判据是基准节奏，不是 jitter 后的单音节间隔）
    expect(chars.length).toBeGreaterThanOrEqual(25);
    expect(syllableMs(chars.length)).toBeLessThan(FAST_SYLLABLE_MS);
    expect(syllableMs(chars.length)).toBe(MIN_SYLLABLE_MS);

    const seen = new Set<number>();
    for (let ms = 0; ms <= 8000; ms += 7) seen.add(mouthIndex(FAST_SENTENCE, ms));
    expect(seen.has(1)).toBe(false); // 没有 half
    expect(seen.has(2)).toBe(true); // 有张开
    expect(seen.has(0)).toBe(true); // 有闭合
  });

  test("换一句台词换一套节奏（不是固定循环）", () => {
    const a = Array.from({ length: 40 }, (_, i) => mouthIndex(SLOW_SENTENCE, i * 60));
    const b = Array.from({ length: 40 }, (_, i) => mouthIndex("雨好像不打算停了。", i * 60));
    expect(a.join("")).not.toBe(b.join(""));
  });

  test("极端输入不失控：超长字幕 + 超大时间戳仍在步数上限内返回", () => {
    const huge = "雨".repeat(4000);
    const t0 = Date.now();
    const value = mouthIndex(huge, 1e9);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(MOUTH_VARIANTS.length);
    expect(MAX_STEPS).toBeGreaterThan(0);
  });

  test("mouthVariantOfPhase：4 相位压成 3 张图，圆口给 open、扁口给 half", () => {
    expect(mouthVariantOfPhase(0)).toBe("closed");
    expect(mouthVariantOfPhase(1)).toBe("half");
    expect(mouthVariantOfPhase(2)).toBe("open");
    expect(mouthVariantOfPhase(3)).toBe("half");
    // 脏相位不崩
    expect(mouthVariantOfPhase(99)).toBe("half");
    expect(mouthAt(SLOW_SENTENCE, 0)).toBe("closed");
  });
});

describe("EMOTION_FACE：七情绪映射", () => {
  test("每个情绪都落在契约内的变体名上", () => {
    const used = faceVariantsUsed();
    expect(used.eyes.length).toBeGreaterThan(0);
    expect(used.mouth.length).toBeGreaterThan(0);
    for (const v of used.eyes) expect(["open", "half", "closed"]).toContain(v);
    for (const v of used.mouth) expect(["closed", "half", "open"]).toContain(v);
    expect(Object.keys(EMOTION_FACE)).toHaveLength(7);
  });

  test("七种情绪：六组可区分 + 一对近义合并（curious/amused）", () => {
    const byKey = new Map<string, string[]>();
    for (const [emotion, face] of Object.entries(EMOTION_FACE)) {
      const key = faceKey(face.eyes, face.mouth);
      byKey.set(key, [...(byKey.get(key) ?? []), emotion]);
    }
    const dupes = [...byKey.values()].filter((list) => list.length > 1);
    /*
     * 为什么允许且只允许一对：待机不许张成圆口（写实脸张嘴 = 恐怖谷），
     * 嘴只剩 closed / half 两档，眼 3 档里 closed 基本归眨眼 → 可用组合 6 组 < 7 种情绪。
     * 合并选在 curious / amused：两者在照片上都是「眼压低 + 唇微启」，语义最近。
     */
    expect(dupes.length).toBe(1);
    expect([...dupes[0]].sort()).toEqual(["amused", "curious"]);
    expect(byKey.size).toBe(6);
  });

  test("待机永不张成圆口：非说话态 mouth 不会是 open", () => {
    const emotions = Object.keys(EMOTION_FACE) as Array<keyof typeof EMOTION_FACE>;
    for (const emotion of emotions) {
      for (const status of ["idle", "listening", "thinking"] as const) {
        const face = faceAt({ emotion, status, subtitle: "外面还在下雨吗？", elapsedMs: 500 });
        expect(face.mouth).not.toBe("open");
      }
    }
  });

  test("curious 与 surprised 不同图（用户明确要求）", () => {
    const a = EMOTION_FACE.curious;
    const b = EMOTION_FACE.surprised;
    expect(faceKey(a.eyes, a.mouth)).not.toBe(faceKey(b.eyes, b.mouth));
  });

  test("说话时嘴由字幕驱动，情绪嘴让位；眼睛仍按情绪", () => {
    const sadIdle = faceAt({ emotion: "sad", status: "idle", subtitle: "嗯。", elapsedMs: 999 });
    const sadSpeaking = faceAt({ emotion: "sad", status: "speaking", subtitle: SLOW_SENTENCE, elapsedMs: 999 });
    expect(sadIdle.mouth).toBe(EMOTION_FACE.sad.mouth);
    expect(sadIdle.eyes).toBe(EMOTION_FACE.sad.eyes);
    expect(sadSpeaking.eyes).toBe(EMOTION_FACE.sad.eyes);
    // 说话时嘴走节奏函数（不再固定为情绪的嘴）
    expect(sadSpeaking.mouth).toBe(mouthAt(SLOW_SENTENCE, 999));
  });

  test("说话但字幕为空 → 保持情绪嘴（不空张着嘴）", () => {
    const face = faceAt({ emotion: "surprised", status: "speaking", subtitle: "  ", elapsedMs: 1500 });
    expect(face.mouth).toBe(EMOTION_FACE.surprised.mouth);
  });

  test("眨眼盖住情绪眼，且只影响眼", () => {
    const blinked = faceAt({ emotion: "neutral", status: "idle", subtitle: "", elapsedMs: 0, blinking: true });
    expect(blinked.eyes).toBe("closed");
    expect(blinked.mouth).toBe(EMOTION_FACE.neutral.mouth);
  });
});

describe("位移与过渡：幅度必须小于 SVG 版", () => {
  test("呼吸缩放 ≤0.6%，点头 ≤2px / ≤0.3°", () => {
    expect(PHOTO_MOTION.breathScale).toBeLessThanOrEqual(1.006);
    expect(PHOTO_MOTION.breathScale).toBeGreaterThan(1);
    expect(PHOTO_MOTION.nodPx).toBeLessThanOrEqual(2);
    expect(PHOTO_MOTION.nodDeg).toBeLessThanOrEqual(0.3);
    expect(PHOTO_MOTION.breathDur).toBeCloseTo(4.6, 6);
  });

  test("站位：倾听前倾 -10px、思考下移 >0、旋转都很小", () => {
    expect(STATUS_PLACEMENT.listening.y).toBe(-10);
    expect(STATUS_PLACEMENT.thinking.y).toBeGreaterThan(0);
    expect(STATUS_PLACEMENT.idle.y).toBe(0);
    for (const place of Object.values(STATUS_PLACEMENT)) {
      expect(Math.abs(place.rot)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(place.scale - 1)).toBeLessThanOrEqual(0.03);
    }
  });

  test("过渡时长严格在 120–200ms，位移越大越长", () => {
    const statuses = ["idle", "listening", "thinking", "speaking"] as const;
    for (const from of statuses) {
      for (const to of statuses) {
        const ms = transitionMs(from, to);
        expect(ms).toBeGreaterThanOrEqual(120);
        expect(ms).toBeLessThanOrEqual(200);
      }
    }
    expect(transitionMs(null, "idle")).toBe(PHOTO_MOTION.transitionMs);
    // idle → thinking（+12px）比 idle → speaking（-3px）更长
    expect(transitionMs("idle", "thinking")).toBeGreaterThan(transitionMs("idle", "speaking"));
  });

  test("reduced motion 关掉微动", () => {
    expect(motionEnabled(true)).toBe(false);
    expect(motionEnabled(false)).toBe(true);
  });
});

describe("parseCharFlag：默认 SVG，未知值不静默", () => {
  test("不写 char → SVG（三场景像素验收依赖这条）", () => {
    expect(parseCharFlag("")).toEqual({ mode: "svg", raw: null, recognized: true });
    expect(parseCharFlag("?scene=cafe_night")).toMatchObject({ mode: "svg", raw: null });
  });

  test("?char=photo 及各等价写法 → photo", () => {
    for (const raw of ["photo", "PHOTO", "1", "on", "true", "png"]) {
      expect(parseCharFlag(`?char=${raw}`)).toEqual({ mode: "photo", raw, recognized: true });
    }
  });

  test("显式关闭 → svg 且 recognized", () => {
    for (const raw of ["svg", "0", "off", "false", "no", "vector"]) {
      const flag = parseCharFlag(`?char=${raw}`);
      expect(flag.mode).toBe("svg");
      expect(flag.recognized).toBe(true);
    }
  });

  test("未知取值 → svg + recognized:false（不静默当 photo 用）", () => {
    const flag = parseCharFlag("?char=webgl");
    expect(flag.mode).toBe("svg");
    expect(flag.recognized).toBe(false);
    expect(flag.raw).toBe("webgl");
  });
});

describe("decidePortraitMode：回退决策", () => {
  const ready: PortraitResource = {
    phase: "ready",
    spec: {
      version: 1,
      size: { w: 1024, h: 1536 },
      source: "flux+inpaint",
      anchor: {
        eyeL: { x: 0.34, y: 0.42 },
        eyeR: { x: 0.66, y: 0.42 },
        mouth: { x: 0.5, y: 0.56 },
      },
      region: { eye: { padX: 0.03, height: 0.11 }, mouth: { width: 0.16, height: 0.11 } },
    },
    assets: [PORTRAIT_BASE_FILE],
  };

  test("开关关着 → SVG（reason=flag_off）", () => {
    expect(decidePortraitMode({ mode: "svg", resource: ready })).toMatchObject({
      mode: "svg",
      reason: "flag_off",
    });
  });

  test("开关打开 + 素材就绪 → 照片", () => {
    const d = decidePortraitMode({ mode: "photo", resource: ready });
    expect(d.mode).toBe("photo");
    expect(d.reason).toBeNull();
  });

  test("装载中 → 先 SVG（不白屏），reason=loading", () => {
    expect(decidePortraitMode({ mode: "photo", resource: { phase: "loading" } })).toMatchObject({
      mode: "svg",
      reason: "loading",
    });
    expect(decidePortraitMode({ mode: "photo", resource: { phase: "idle" } })).toMatchObject({
      mode: "svg",
      reason: "loading",
    });
  });

  test("失败原因原样透出（spec 缺失 / 版本不匹配 / 定妆照加载失败）", () => {
    for (const reason of ["spec_missing", "version_mismatch", "portrait_load_failed"] as const) {
      const d = decidePortraitMode({
        mode: "photo",
        resource: { phase: "failed", reason, detail: `${reason} 的说明` },
      });
      expect(d.mode).toBe("svg");
      expect(d.reason).toBe(reason);
      expect(d.detail).toContain(reason);
    }
  });

  test("spec issue → 回退原因的一一对应（版本不匹配单独一档）", () => {
    expect(reasonOfSpecIssue("empty")).toBe("spec_missing");
    expect(reasonOfSpecIssue("version_mismatch")).toBe("version_mismatch");
    for (const issue of ["not_json", "not_object", "bad_version", "bad_size", "bad_anchor", "bad_region"] as const) {
      expect(reasonOfSpecIssue(issue)).toBe("spec_invalid");
    }
  });
});

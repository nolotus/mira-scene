/**
 * 照片角色素材契约（/char/spec.json）的解析与换算。
 *
 * 这组测试的核心不是「能解析好的」，而是**八类脏值各自被单独拒绝**：
 * 脏 anchor 的后果不是「图丑一点」，而是嘴贴到额头上——那种画面比没有照片更糟，
 * 所以每种坏法都必须落到一个具名 issue 上，由调用方整体回退 SVG。
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REGION,
  PORTRAIT_VERSION,
  allVariantFiles,
  clamp01,
  eyePatchRect,
  mergeRegion,
  mouthPatchRect,
  parsePortraitSpec,
  parseSpecJson,
  patchRectOf,
  portraitManifest,
  portraitUrl,
  rectToPct,
  rectToPx,
  variantFile,
  variantFiles,
  type PortraitSize,
  type PortraitSpec,
} from "../../src/web/stage/characters/portraitSpec";

const VALID = {
  version: PORTRAIT_VERSION,
  size: { w: 1024, h: 1536 },
  source: "flux+inpaint",
  anchor: {
    eyeL: { x: 0.34, y: 0.42 },
    eyeR: { x: 0.66, y: 0.42 },
    mouth: { x: 0.5, y: 0.56 },
  },
};

function clone(): typeof VALID {
  return JSON.parse(JSON.stringify(VALID)) as typeof VALID;
}

/** 断言逐条独立：每种坏法只改一处，避免「因为别处脏所以挂了」的假绿 */
describe("parsePortraitSpec：八类拒绝", () => {
  test("① empty：空文本 / 非字符串", () => {
    expect(parseSpecJson("")).toMatchObject({ ok: false, issue: "empty" });
    expect(parseSpecJson("   \n ")).toMatchObject({ ok: false, issue: "empty" });
    expect(parseSpecJson(undefined as unknown as string)).toMatchObject({ ok: false, issue: "empty" });
  });

  test("② not_json：语法坏了，且 detail 带上原始报错", () => {
    const r = parseSpecJson("{ version: 1, ");
    expect(r).toMatchObject({ ok: false, issue: "not_json" });
    if (!r.ok) expect(r.detail.length).toBeGreaterThan(0);
  });

  test("③ not_object：顶层是数组 / null / 字符串", () => {
    expect(parsePortraitSpec([])).toMatchObject({ ok: false, issue: "not_object" });
    expect(parsePortraitSpec(null)).toMatchObject({ ok: false, issue: "not_object" });
    expect(parsePortraitSpec("spec")).toMatchObject({ ok: false, issue: "not_object" });
  });

  test("④ bad_version：缺失 / 非整数 / NaN", () => {
    const noVersion = clone() as Record<string, unknown>;
    delete noVersion.version;
    expect(parsePortraitSpec(noVersion)).toMatchObject({ ok: false, issue: "bad_version" });
    expect(parsePortraitSpec({ ...clone(), version: 1.5 })).toMatchObject({ ok: false, issue: "bad_version" });
    expect(parsePortraitSpec({ ...clone(), version: Number.NaN })).toMatchObject({ ok: false, issue: "bad_version" });
  });

  test("⑤ version_mismatch：素材与代码不同代（不与 bad_version 混为一谈）", () => {
    const r = parsePortraitSpec({ ...clone(), version: 2 });
    expect(r).toMatchObject({ ok: false, issue: "version_mismatch" });
    if (!r.ok) expect(r.detail).toContain("2");
  });

  test("⑥ bad_size：缺失 / 0 / 负数 / 非有限数", () => {
    for (const size of [undefined, { w: 0, h: 100 }, { w: 100, h: -1 }, { w: "1024", h: 1536 }, { w: Number.POSITIVE_INFINITY, h: 10 }]) {
      expect(parsePortraitSpec({ ...clone(), size })).toMatchObject({ ok: false, issue: "bad_size" });
    }
  });

  test("⑦ bad_anchor：越界 / 非数 / 缺字段 / 左右眼写反", () => {
    const cases: unknown[] = [
      { ...VALID.anchor, eyeL: { x: 1.2, y: 0.4 } },
      { ...VALID.anchor, eyeR: { x: 0.6, y: -0.1 } },
      { ...VALID.anchor, mouth: { x: Number.NaN, y: 0.5 } },
      { eyeL: VALID.anchor.eyeL, mouth: VALID.anchor.mouth },
      undefined,
      // 写反：eyeL 跑到 eyeR 右边
      { ...VALID.anchor, eyeL: { x: 0.7, y: 0.42 }, eyeR: { x: 0.3, y: 0.42 } },
      // 贴太近（<0.02）：补丁宽度趋零
      { ...VALID.anchor, eyeL: { x: 0.5, y: 0.42 }, eyeR: { x: 0.51, y: 0.42 } },
    ];
    for (const anchor of cases) {
      expect(parsePortraitSpec({ ...clone(), anchor })).toMatchObject({ ok: false, issue: "bad_anchor" });
    }
  });

  test("⑧ bad_region：给了就必须是 (0,1] 内的数", () => {
    for (const region of [
      { eye: { padX: 0 } },
      { eye: { height: 1.4 } },
      { mouth: { width: -0.1 } },
      { mouth: { height: "0.1" } },
      "big",
    ]) {
      expect(parsePortraitSpec({ ...clone(), region })).toMatchObject({ ok: false, issue: "bad_region" });
    }
  });
});

describe("parsePortraitSpec：合法值", () => {
  test("补全默认 region 与 source，且圆整进 spec", () => {
    const r = parsePortraitSpec(clone());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.region).toEqual(DEFAULT_REGION);
    expect(r.spec.anchor.eyeL).toEqual({ x: 0.34, y: 0.42 });
    expect(r.spec.size).toEqual({ w: 1024, h: 1536 });
    expect(r.spec.source).toBe("flux+inpaint");
  });

  test("source 缺失 → unknown（不因为留痕字段而整体拒绝）", () => {
    const raw = clone() as Record<string, unknown>;
    delete raw.source;
    const r = parsePortraitSpec(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.source).toBe("unknown");
  });

  test("region 部分覆盖：只给 padX，其余取默认", () => {
    const r = parsePortraitSpec({ ...clone(), region: { eye: { padX: 0.05 } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.region.eye.padX).toBe(0.05);
    expect(r.spec.region.eye.height).toBe(DEFAULT_REGION.eye.height);
    expect(r.spec.region.mouth).toEqual(DEFAULT_REGION.mouth);
  });

  test("mergeRegion 单独可用：null/undefined 都回默认", () => {
    expect(mergeRegion(undefined)).toEqual({ ok: true, region: DEFAULT_REGION });
    expect(mergeRegion(null)).toEqual({ ok: true, region: DEFAULT_REGION });
  });
});

describe("anchor → 像素换算", () => {
  const spec = (() => {
    const r = parsePortraitSpec(clone());
    if (!r.ok) throw new Error("fixture 必须合法");
    return r.spec;
  })();

  test("眼补丁：横向 = [eyeL-padX, eyeR+padX]，纵向以两点 y 的中点为中心", () => {
    const rect = eyePatchRect(spec);
    expect(rect.left).toBeCloseTo(0.34 - DEFAULT_REGION.eye.padX, 6); // 0.31
    expect(rect.left + rect.width).toBeCloseTo(0.66 + DEFAULT_REGION.eye.padX, 6); // 0.69
    expect(rect.height).toBeCloseTo(DEFAULT_REGION.eye.height, 6);
    expect(rect.top).toBeCloseTo(0.42 - DEFAULT_REGION.eye.height / 2, 6);
  });

  test("嘴补丁：以 anchor.mouth 为中心，尺寸取 region.mouth", () => {
    const rect = mouthPatchRect(spec);
    expect(rect.left).toBeCloseTo(0.5 - DEFAULT_REGION.mouth.width / 2, 6);
    expect(rect.top).toBeCloseTo(0.56 - DEFAULT_REGION.mouth.height / 2, 6);
    expect(rect.width).toBeCloseTo(DEFAULT_REGION.mouth.width, 6);
    expect(rect.height).toBeCloseTo(DEFAULT_REGION.mouth.height, 6);
  });

  test("归一化 → 像素：按 size 缩放并取整（避免亚像素模糊）", () => {
    const px = rectToPx(mouthPatchRect(spec), spec.size);
    expect(px).toEqual({
      left: Math.round((0.5 - DEFAULT_REGION.mouth.width / 2) * 1024),
      top: Math.round((0.56 - DEFAULT_REGION.mouth.height / 2) * 1536),
      width: Math.round(DEFAULT_REGION.mouth.width * 1024),
      height: Math.round(DEFAULT_REGION.mouth.height * 1536),
    });
    const eyes = rectToPx(eyePatchRect(spec), spec.size);
    expect(eyes.left).toBe(Math.round(0.31 * 1024)); // 317
    expect(eyes.width).toBe(Math.round(0.38 * 1024)); // 389
    expect(eyes.height).toBe(Math.round(0.11 * 1536)); // 169
  });

  test("同一份 spec 换分辨率，归一化矩形不变、像素矩形跟着变", () => {
    const big: PortraitSize = { w: 2048, h: 3072 };
    const rect = eyePatchRect(spec);
    // 归一化矩形与 size 无关
    expect(eyePatchRect(spec)).toEqual(rect);
    // 像素矩形按各自 size 独立取整（不是简单 ×2，取整发生在每个分量上）
    expect(rectToPx(rect, big)).toEqual({
      left: Math.round(rect.left * big.w),
      top: Math.round(rect.top * big.h),
      width: Math.round(rect.width * big.w),
      height: Math.round(rect.height * big.h),
    });
    expect(rectToPx(rect, big).width).toBe(rectToPx(rect, spec.size).width * 2);
  });

  test("越界 anchor 被夹进画布：不会出现负宽 / 右边界 > 1", () => {
    const edge: PortraitSpec = {
      ...spec,
      anchor: { eyeL: { x: 0.0, y: 0.02 }, eyeR: { x: 0.99, y: 0.02 }, mouth: { x: 0.02, y: 0.99 } },
    };
    const eyesRect = eyePatchRect(edge);
    expect(eyesRect.left).toBe(0);
    expect(eyesRect.left + eyesRect.width).toBeLessThanOrEqual(1);
    expect(eyesRect.top).toBe(0);
    const mouth = mouthPatchRect(edge);
    expect(mouth.left).toBe(0);
    expect(mouth.top + mouth.height).toBeLessThanOrEqual(1);
    expect(mouth.width).toBeGreaterThan(0);
  });

  test("rectToPct：输出 CSS 百分比，三位小数，渲染层与画布尺寸解耦", () => {
    const pct = rectToPct({ left: 0.31, top: 0.365, width: 0.38, height: 0.11 });
    expect(pct).toEqual({ left: "31.000%", top: "36.500%", width: "38.000%", height: "11.000%" });
    const eyes = rectToPct(eyePatchRect(spec));
    expect(eyes.width).toBe("38.000%");
  });

  test("patchRectOf 与两个专用函数同源", () => {
    expect(patchRectOf(spec, "eyes")).toEqual(eyePatchRect(spec));
    expect(patchRectOf(spec, "mouth")).toEqual(mouthPatchRect(spec));
  });
});

describe("clamp01", () => {
  test("夹紧到 [0,1]，脏值一律 0（不是 NaN 传播出去）", () => {
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("清单与命名", () => {
  test("文件名约定：part_variant.png", () => {
    expect(variantFile("eyes", "closed")).toBe("eyes_closed.png");
    expect(variantFile("mouth", "open")).toBe("mouth_open.png");
    expect(variantFiles("eyes")).toEqual(["eyes_open.png", "eyes_half.png", "eyes_closed.png"]);
    expect(variantFiles("mouth")).toEqual(["mouth_closed.png", "mouth_half.png", "mouth_open.png"]);
  });

  test("manifest：portrait.png 必需，6 个变体可选", () => {
    const manifest = portraitManifest();
    expect(manifest.dir).toBe("/char");
    expect(manifest.spec).toBe("spec.json");
    expect(manifest.required).toEqual(["portrait.png"]);
    expect(manifest.optional).toEqual(allVariantFiles());
    expect(manifest.optional).toHaveLength(6);
    expect(manifest.version).toBe(PORTRAIT_VERSION);
  });

  test("portraitUrl 容忍尾部斜杠", () => {
    expect(portraitUrl("spec.json")).toBe("/char/spec.json");
    expect(portraitUrl("spec.json", "/char/")).toBe("/char/spec.json");
  });
});

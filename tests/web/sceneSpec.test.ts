/**
 * SceneSpec 契约测试。
 *
 * 三件事必须被机器守住：
 *  1. 数据完整性 —— 三个生产场景都有 lighting / horizon / actions / planes；
 *  2. 标定守恒 —— 角色站位/身高/光色与改造前的硬编码值逐字相同（观感不变的前提）；
 *  3. 场景适配 —— `actions` 不是随手写的白名单：允许的动作必须有场景物件做依据，
 *     且 reducer 会把场景外的动作（sea 上的 hold_cup）真正丢掉、并且不静默。
 */

import { describe, expect, test } from "bun:test";
import type { SceneVariant } from "../../src/shared/protocol";
import {
  DEFAULT_SCENE_ID,
  RENDERABLE_PLANES,
  SCENE_SPECS,
  actionRequirements,
  charBoxOf,
  isActionAllowed,
  isKnownSceneId,
  missingProps,
  resolveScene,
  sceneVars,
  specOf,
  unsupportedPlanes,
} from "../../src/web/stage/scenes/spec";
import {
  applyDirective,
  createInitialScene,
  createMachine,
  reduceEvent,
} from "../../src/web/state/session";

const PRODUCTION_SCENES: SceneVariant[] = ["cafe_night", "cafe_closing", "window_rain"];

describe("SceneSpec 完整性", () => {
  test("三个生产场景都有 lighting / horizon / actions / planes / label", () => {
    for (const id of PRODUCTION_SCENES) {
      const spec = specOf(id);
      expect(spec.id).toBe(id);
      expect(spec.label.length).toBeGreaterThan(0);

      // 光照五项齐全且取值合法
      const { lighting } = spec;
      expect(Number.isFinite(lighting.keyDir.x)).toBe(true);
      expect(Number.isFinite(lighting.keyDir.y)).toBe(true);
      expect(lighting.keyColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(lighting.fillColor).toMatch(/^#[0-9a-f]{6}$/i);
      expect(lighting.rimStrength).toBeGreaterThan(0);
      expect(lighting.shadowSoftness).toBeGreaterThan(0);
      expect(lighting.shadowSoftness).toBeLessThanOrEqual(1);

      // 地平线在画面内
      expect(spec.camera.horizonY).toBeGreaterThan(0);
      expect(spec.camera.horizonY).toBeLessThan(1);

      // 动作与景深都不是空的，且景深层 id 唯一
      expect(spec.actions.length).toBeGreaterThan(0);
      expect(spec.depthPlanes.length).toBeGreaterThan(0);
      const planeIds = spec.depthPlanes.map((p) => p.id);
      expect(new Set(planeIds).size).toBe(planeIds.length);

      // 调色板六项齐全
      for (const value of Object.values(spec.palette)) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  test("生产场景的景深层都有渲染器（不会渲染成一块空背景）", () => {
    for (const id of PRODUCTION_SCENES) {
      expect(unsupportedPlanes(specOf(id))).toEqual([]);
      for (const plane of specOf(id).depthPlanes) {
        expect(RENDERABLE_PLANES).toContain(plane.id);
      }
    }
  });

  test("海边场景 seaside_dawn 数据完整，且每一层都有渲染器（能真的切过去）", () => {
    const spec = specOf("seaside_dawn");
    expect(spec.id).toBe("seaside_dawn");
    expect(spec.actions.length).toBeGreaterThan(0);
    expect(spec.particles).toBeUndefined();
    // 不再有缺口层：天幕 / 海面 / 岸线 / 前景四层都有渲染器
    expect(unsupportedPlanes(spec)).toEqual([]);
    expect(spec.depthPlanes.map((p) => p.id)).toEqual(["sky", "sea", "shore", "fg"]);
    for (const plane of spec.depthPlanes) {
      expect(RENDERABLE_PLANES).toContain(plane.id);
    }
  });

  test("海边三层的渲染器真的把声明的构件画了出来", async () => {
    const { PLANE_RENDERERS } = await import("../../src/web/stage/StageBackdrop");
    for (const plane of ["sky", "sea", "shore"] as const) {
      expect(PLANE_RENDERERS[plane]).toBeDefined();
    }
    // 渲染出来的 DOM 里要真的有构件，而不是一层空白
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { StageBackdrop } = await import("../../src/web/stage/StageBackdrop");
    const html = renderToStaticMarkup(createElement(StageBackdrop, { scene: "seaside_dawn" }));
    for (const marker of [
      "dawn-sky", // 天空渐变
      "dawn-sun-glow", // 日晕
      "sea-water", // 海面
      "sea-wave", // 波线
      "sea-gull", // 海鸥
      "shore-sand", // 沙滩
      "shore-rock", // 礁石
      "shore-wind", // 风力细节
      "sea-spray", // 前景水雾
      "vignette", // 暗角
    ]) {
      expect(html).toContain(marker);
    }
    // 海边没有雨：不能画出雨丝
    expect(html).not.toContain("streak");
  });
});

describe("标定：默认值与改造前的硬编码值一致", () => {
  test("标定场景的角色盒子 = 原来的 bottom:30% / height:56%", () => {
    expect(charBoxOf(specOf("cafe_night"))).toEqual({
      bottom: "30%",
      height: "56%",
      scale: 1,
    });
    // 三个生产场景必须同盒：任何一个偏 0.1% 都会改观感。
    // 注意断言的是 "56%" 而不是 `${0.56 * 100}%` —— 后者是 "56.00000000000001%"，
    // 而 CSS 里写 `height: 56.00000000000001%` 与 `56%` 并不保证同一像素网格，
    // charBoxOf() 里的 num() 正是为此把浮点噪声抹掉。
    for (const id of PRODUCTION_SCENES) {
      expect(charBoxOf(specOf(id)).bottom).toBe("30%");
      expect(charBoxOf(specOf(id)).height).toBe("56%");
    }
  });

  test("CSS 变量默认值 = 改造前写死在 stage.css / Character.tsx 里的值", () => {
    const vars = sceneVars(specOf("cafe_night"));
    expect(vars["--fill-color"]).toBe("#9ec6ec"); // 原 mx-rim 的 stop 色
    expect(vars["--key-color"]).toBe("#ffe6bd"); // 原 mx-muglight 的 stop 色
    expect(vars["--rim-strength"]).toBe("1"); // 原 stopOpacity 0.85 / 0.12 / 0
  });

  test("地平线真的会驱动角色尺寸（示例场景 0.22 → 变小、下沉）", () => {
    const box = charBoxOf(specOf("seaside_dawn"));
    expect(box.bottom).toBe("22%");
    expect(box.scale).toBeCloseTo(0.22 / 0.3, 6);
    expect(box.height).toBe("41.067%");
  });
});

describe("动作-场景可用性", () => {
  test("咖啡馆三个状态允许 hold_cup（桌上有杯子）与 glance_window（有窗）", () => {
    for (const id of PRODUCTION_SCENES) {
      expect(isActionAllowed(id, "hold_cup")).toBe(true);
      expect(isActionAllowed(id, "glance_window")).toBe(true);
      expect(isActionAllowed(id, "blink")).toBe(true);
    }
  });

  test("只有窗外视角的海边场景容不下 hold_cup / glance_window", () => {
    expect(isActionAllowed("seaside_dawn", "hold_cup")).toBe(false);
    expect(isActionAllowed("seaside_dawn", "glance_window")).toBe(false);
    // 但站在海边、前倾、侧身、眨眼这些都成立
    expect(isActionAllowed("seaside_dawn", "stand")).toBe(true);
    expect(isActionAllowed("seaside_dawn", "blink")).toBe(true);
  });

  test("actions 不是空口声明：允许的动作必须有场景物件做依据", () => {
    for (const id of PRODUCTION_SCENES) {
      for (const action of specOf(id).actions) {
        expect(missingProps(specOf(id), action)).toEqual([]);
      }
    }
    // 海边缺杯少窗 —— 这正是它不允许 hold_cup / glance_window 的机器可查理由
    expect(missingProps(specOf("seaside_dawn"), "hold_cup")).toEqual(["cup"]);
    expect(missingProps(specOf("seaside_dawn"), "glance_window")).toEqual(["window"]);
    expect(actionRequirements("hold_cup")).toEqual(["cup"]);
  });

  test("未知 id 降级到 cafe_night（不抛错），认识与否另有判定", () => {
    const fallback = resolveScene("atlantis_reef");
    expect(fallback.id).toBe(DEFAULT_SCENE_ID);
    expect(fallback).toBe(SCENE_SPECS.cafe_night);
    expect(isKnownSceneId("atlantis_reef")).toBe(false);
    expect(isKnownSceneId("seaside_dawn")).toBe(true);
    // 未知场景的场景适配也走降级后的白名单，而不是全放行/全拦下
    expect(isActionAllowed("atlantis_reef", "hold_cup")).toBe(true);
  });
});

describe("reducer 过滤场景外动作", () => {
  const seasideMachine = () => ({
    ...createMachine(1),
    turnActive: true,
    turnId: "t1",
    scene: createInitialScene({ scene: "seaside_dawn" }),
  });

  test("applyDirective：海边收到 hold_cup 原样返回（连 lastBeat 都不动）", () => {
    const scene = createInitialScene({ scene: "seaside_dawn", lastBeat: "keep" });
    expect(applyDirective(scene, { kind: "pose", pose: "hold_cup" }, "t1")).toBe(scene);
    // 同一台机器上，合法的姿势照常生效
    const stood = applyDirective(scene, { kind: "pose", pose: "stand" }, "t1");
    expect(stood.pose).toBe("stand");
  });

  test("reduceEvent：被拦下的指令带 action-not-in-scene，机器状态引用不变", () => {
    const machine = seasideMachine();
    const rejected = reduceEvent(machine, {
      type: "directive",
      turnId: "t1",
      epoch: 1,
      directive: { kind: "pose", pose: "hold_cup" },
    });
    expect(rejected.outcome).toBe("action-not-in-scene");
    expect(rejected.machine).toBe(machine);

    const accepted = reduceEvent(machine, {
      type: "directive",
      turnId: "t1",
      epoch: 1,
      directive: { kind: "action", action: "blink" },
    });
    expect(accepted.outcome).toBe("applied");
    expect(accepted.machine.scene.pendingActions).toEqual(["blink"]);
  });

  test("咖啡馆里同样的 hold_cup 仍然放行（过滤只针对场景，不是禁用动作）", () => {
    const machine = {
      ...createMachine(1),
      turnActive: true,
      turnId: "t1",
      scene: createInitialScene({ scene: "window_rain" }),
    };
    const result = reduceEvent(machine, {
      type: "directive",
      turnId: "t1",
      epoch: 1,
      directive: { kind: "pose", pose: "hold_cup" },
    });
    expect(result.outcome).toBe("applied");
    expect(result.machine.scene.pose).toBe("hold_cup");
  });
});

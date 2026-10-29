import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Action, Pose } from "../../src/shared/protocol";
import { Character, ACT_DUR, POSE_RIG } from "../../src/web/stage/Character";
import { createInitialScene } from "../../src/web/state/session";

const css = await Bun.file(new URL("../../src/web/styles/stage.css", import.meta.url)).text();
const source = await Bun.file(new URL("../../src/web/stage/Character.tsx", import.meta.url)).text();
const render = (pose: Pose = "stand", action?: Action, speaking = false, mouthDrive = true) =>
  renderToStaticMarkup(<Character state={{ ...createInitialScene(), pose,
    pendingActions: action ? [action] : [], characterStatus: speaking ? "speaking" : "idle",
  }} actionNonce={1} mouthDrive={mouthDrive} />);

const targets: Record<Action, string[]> = {
  blink: ["eye-blink"],
  hair_tuck: ["char-reach", "char-arm-l-act", "char-head-act", "strand", "pin-act"],
  sigh: ["char-shoulders-act", "char-head-act", "char-jaw-act"],
  shiver: ["char-shoulders-act", "char-arm-l-act", "char-arm-r-act", "eye-shape", "char-cup-liquid"],
  look_back: ["char-head-act", "char-neck-act", "char-shoulders-act"],
  nod: ["char-head-act", "char-shoulders-act"],
  startle: ["char-head-act", "char-shoulders-act", "char-torso-act", "eye-shape"],
};

describe("SVG character articulation", () => {
  for (const action of Object.keys(targets) as Action[]) {
    test(`${action} has duration, rendered targets and local CSS animation`, () => {
      const html = render("hold_cup", action);
      expect(html).toContain(`data-act="${action}"`);
      expect(ACT_DUR[action]).toBeGreaterThan(0);
      for (const target of targets[action]) {
        expect(html).toMatch(new RegExp(`class="[^"]*\\b${target}\\b`));
        expect(css).toMatch(new RegExp(`\\.char-rig\\[data-act="${action}"\\] \\.${target}\\s*\\{\\s*animation:`));
      }
    });
  }

  test("actions never overwrite persistent pose transforms", () => {
    for (const part of ["char-torso", "char-shoulders", "char-neck", "char-arm-l", "char-arm-r", "char-jaw"]) {
      expect(css).not.toMatch(new RegExp(`\\[data-act="[^"]+"\\] \\.${part}\\s*\\{`));
    }
    expect(css).toContain("rotate(var(--neck-rot, 0deg))");
  });

  test("all five poses map to articulation, not whole-body pose translation", () => {
    expect(Object.keys(POSE_RIG)).toHaveLength(5);
    for (const pose of Object.keys(POSE_RIG) as Pose[]) {
      const html = render(pose);
      expect(html).toContain(`data-pose="${pose}"`);
      expect(html).toContain("--char-x:0px;--char-y:0px;--char-rot:0deg;--char-scale:1");
      expect(html).toContain(`--rig-turn:${POSE_RIG[pose].turn}deg`);
    }
    expect(POSE_RIG.lean_in.lean).toBeGreaterThan(POSE_RIG.stand.lean);
    expect(POSE_RIG.turn_away.turn).toBeLessThan(POSE_RIG.stand.turn);
    expect(POSE_RIG.glance_window.gazeX).toBeLessThan(-5);
    expect(render("glance_window")).toContain("--gaze-x:-8px");
  });

  test("holding a cup folds both forearms and supplies separate hand and liquid layers", () => {
    const html = render("hold_cup");
    expect(html).toContain("--forearm-fold:-65deg");
    expect(render()).toContain("--forearm-fold:0deg");
    expect(html.match(/class="char-forearm"/g)).toHaveLength(2);
    expect(html.match(/class="char-hand"/g)).toHaveLength(2);
    expect(html).toContain('class="char-cup-grip"');
    expect(html).toContain('class="char-cup-liquid"');
    expect(css).toContain("transform-origin: 100px 440px");
    expect(css).toContain("rotate(var(--forearm-fold, 0deg))");
  });

  test("chest breathes locally and mouth closed phase stays visible even when speaking", () => {
    expect(css).toContain("animation: chestBreath var(--breath-dur");
    expect(css).not.toContain("animation: breathe var(--breath-dur");
    expect(css).not.toContain('.char-rig[data-status="speaking"] .mouth { opacity: 0; }');
    expect(render("stand", undefined, true, false)).toContain('data-speaking="false"');
    expect(render("stand", undefined, true)).toContain('data-speaking="true"');
    expect(css).toContain('.char-rig[data-speaking="true"][data-act="none"] .char-head-act');
    expect(source).toContain("useBlink()");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

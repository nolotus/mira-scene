/**
 * 开发预览面板（仅 preview.html 使用，不进生产构建）。
 *
 * 用途：单独把渲染层跑起来，循环/手动切换 4 种角色状态、7 种情绪、5 种姿势、
 * 3 个场景、5 种镜头、6 种特效与 7 种一次性动作，确认每一种都有可辨认的视觉差异。
 *
 * 这里的 setInterval 只属于演示面板，不是渲染层：Stage 内部没有任何时钟逻辑。
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type {
  Action,
  Branch,
  CameraMove,
  CharacterStatus,
  Emotion,
  Pose,
  SceneState,
  SceneVariant,
  Vfx,
} from "../../shared/protocol";
import { Stage } from "./Stage";

const EMOTIONS: Emotion[] = ["neutral", "curious", "warm", "amused", "anxious", "sad", "surprised"];
const STATUSES: CharacterStatus[] = ["idle", "listening", "thinking", "speaking"];
const POSES: Pose[] = ["stand", "lean_in", "turn_away", "hold_cup", "glance_window"];
const SCENES: SceneVariant[] = [
  "cafe_night",
  "cafe_closing",
  "window_rain",
  "seaside_dawn",
  "street_night",
  "hotel_entrance",
];
const CAMERAS: CameraMove[] = ["push_in", "pull_back", "whip_pan", "shake", "settle"];
const VFX: Vfx[] = ["lightning", "rain_heavy", "rain_light", "warm_glow", "lights_dim", "steam_wisp"];
const ACTIONS: Action[] = ["blink", "hair_tuck", "sigh", "shiver", "look_back", "nod", "startle"];
const BRANCHES: Branch[] = [
  { id: "b1", label: "「你等了很久吗？」" },
  { id: "b2", label: "坐到她对面" },
  { id: "b3", label: "先不说话，看向窗外" },
];

const INITIAL: SceneState = {
  scene: "cafe_night",
  emotion: "curious",
  pose: "stand",
  camera: null,
  vfx: { rain_light: 1, steam_wisp: 1 },
  characterStatus: "idle",
  pendingActions: [],
  subtitle: "雨好像不打算停了。你要的那杯，我还留着。",
  branches: [],
  lastBeat: null,
};

const panelHidden = typeof window !== "undefined" && window.location.search.includes("nopanel");

function Row({
  title,
  items,
  active,
  onPick,
}: {
  title: string;
  items: readonly string[];
  active: string;
  onPick: (v: string) => void;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, letterSpacing: ".14em", opacity: 0.45, marginBottom: 5 }}>
        {title}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {items.map((it) => (
          <button
            key={it}
            type="button"
            onClick={() => onPick(it)}
            style={{
              padding: "5px 9px",
              fontSize: 11.5,
              borderRadius: 7,
              cursor: "pointer",
              color: active === it ? "#1a1208" : "#e9e2d6",
              background: active === it ? "#f2b45c" : "rgba(255,255,255,.07)",
              border: `1px solid ${active === it ? "#f2b45c" : "rgba(255,255,255,.14)"}`,
              fontFamily: "inherit",
            }}
          >
            {it}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 截图 / 自查用的 URL 定点（仅 dev harness 使用）：
 *   /preview.html?nopanel&scene=cafe_closing&pose=hold_cup&emotion=warm
 *   /preview.html?nopanel&status=speaking&subtitle=雨好像不打算停了
 * 缺省值逐字段等于 INITIAL，所以不带参数时渲染结果与之前完全一致。
 *
 * `status` / `subtitle` 是给照片角色验收加的：口型由字幕驱动，
 * 四状态必须能固定在同一 URL 上截图，否则每张图的状态都不由自己决定。
 */
function seedFromUrl(): SceneState {
  if (typeof window === "undefined") return INITIAL;
  const query = new URLSearchParams(window.location.search);
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const raw = query.get(key);
    return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  };
  return {
    ...INITIAL,
    scene: pick("scene", SCENES, INITIAL.scene),
    pose: pick("pose", POSES, INITIAL.pose),
    emotion: pick("emotion", EMOTIONS, INITIAL.emotion),
    characterStatus: pick("status", STATUSES, INITIAL.characterStatus),
    subtitle: query.get("subtitle") ?? INITIAL.subtitle,
  };
}

function Preview() {
  const [state, setState] = useState<SceneState>(seedFromUrl);
  const [auto, setAuto] = useState(false);
  const beatId = useRef(0);
  const tour = useRef(0);

  const patch = (p: Partial<SceneState>) => setState((s) => ({ ...s, ...p }));

  const fireBeat = () =>
    patch({ lastBeat: `beat-${(beatId.current += 1)}` });

  const toggleVfx = (v: Vfx) =>
    setState((s) => {
      const next = { ...s.vfx };
      if (next[v]) delete next[v];
      else next[v] = 1;
      return { ...s, vfx: next };
    });

  const fireAction = (a: Action) => patch({ pendingActions: [a] });

  // 自动巡演：每 2.6s 换一组（状态 → 情绪 → 姿势 → 镜头 → 特效 → beat → 动作）
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      tour.current += 1;
      const n = tour.current;
      setState((s) => {
        const next: SceneState = { ...s };
        if (n % 2 === 0) next.characterStatus = STATUSES[(n / 2) % STATUSES.length] ?? "idle";
        if (n % 3 === 0) next.emotion = EMOTIONS[(n / 3) % EMOTIONS.length] ?? "neutral";
        if (n % 5 === 0) next.pose = POSES[(n / 5) % POSES.length] ?? "stand";
        if (n % 4 === 0) {
          next.camera = CAMERAS[(n / 4) % CAMERAS.length] ?? null;
          next.lastBeat = `beat-${n}`;
        }
        if (n % 7 === 0) next.scene = SCENES[(n / 7) % SCENES.length] ?? "cafe_night";
        if (n % 6 === 0) next.pendingActions = [ACTIONS[(n / 6) % ACTIONS.length] ?? "blink"];
        return next;
      });
    }, 2600);
    return () => clearInterval(id);
  }, [auto]);

  return (
    <>
      <Stage state={state} onBranchPick={(id) => patch({ subtitle: `（选中分支 ${id}）` })} />
      {panelHidden ? null : (
        <aside
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            zIndex: 50,
            width: 292,
            maxHeight: "calc(100dvh - 24px)",
            overflowY: "auto",
            padding: "12px 13px 6px",
            borderRadius: 14,
            background: "rgba(10,13,19,.92)",
            border: "1px solid rgba(255,255,255,.1)",
            boxShadow: "0 24px 60px -20px rgba(0,0,0,.9)",
            backdropFilter: "blur(12px)",
            color: "#e9e2d6",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <strong style={{ letterSpacing: ".1em", fontSize: 12 }}>STAGE PREVIEW</strong>
            <button
              type="button"
              onClick={() => setAuto((v) => !v)}
              style={{
                padding: "3px 8px",
                fontSize: 11,
                borderRadius: 6,
                cursor: "pointer",
                color: auto ? "#1a1208" : "#e9e2d6",
                background: auto ? "#8fd7a8" : "rgba(255,255,255,.08)",
                border: "1px solid rgba(255,255,255,.16)",
                fontFamily: "inherit",
              }}
            >
              {auto ? "巡演中" : "自动巡演"}
            </button>
          </div>

          <Row title="STATUS" items={STATUSES} active={state.characterStatus} onPick={(v) => patch({ characterStatus: v as CharacterStatus })} />
          <Row title="EMOTION" items={EMOTIONS} active={state.emotion} onPick={(v) => patch({ emotion: v as Emotion })} />
          <Row title="POSE" items={POSES} active={state.pose} onPick={(v) => patch({ pose: v as Pose })} />
          <Row title="SCENE" items={SCENES} active={state.scene} onPick={(v) => patch({ scene: v as SceneVariant })} />
          <Row title="CAMERA" items={CAMERAS} active={state.camera ?? ""} onPick={(v) => { fireBeat(); patch({ camera: v as CameraMove }); }} />

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: ".14em", opacity: 0.45, marginBottom: 5 }}>
              VFX
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {VFX.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleVfx(v)}
                  style={{
                    padding: "5px 9px",
                    fontSize: 11.5,
                    borderRadius: 7,
                    cursor: "pointer",
                    color: state.vfx[v] ? "#1a1208" : "#e9e2d6",
                    background: state.vfx[v] ? "#9ec6ec" : "rgba(255,255,255,.07)",
                    border: `1px solid ${state.vfx[v] ? "#9ec6ec" : "rgba(255,255,255,.14)"}`,
                    fontFamily: "inherit",
                  }}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: ".14em", opacity: 0.45, marginBottom: 5 }}>
              ACTION（点一次播一次）
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {ACTIONS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => fireAction(a)}
                  style={{
                    padding: "5px 9px",
                    fontSize: 11.5,
                    borderRadius: 7,
                    cursor: "pointer",
                    color: "#e9e2d6",
                    background: "rgba(255,255,255,.07)",
                    border: "1px solid rgba(255,255,255,.14)",
                    fontFamily: "inherit",
                  }}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 5, marginBottom: 10 }}>
            <button type="button" onClick={fireBeat} style={ghost}>
              lastBeat +1
            </button>
            <button
              type="button"
              onClick={() => patch({ branches: state.branches.length ? [] : BRANCHES })}
              style={ghost}
            >
              branches {state.branches.length ? "off" : "on"}
            </button>
            <button
              type="button"
              onClick={() =>
                patch({
                  subtitle:
                    "她把手心贴在杯壁上，热气一点点散掉。窗外的雨忽然大了，像是有人把整片海倒了过来，路灯在雨里碎成一团模糊的光。她停了很久，才开口：「我一直觉得，雨声是最诚实的背景音。」",
                })
              }
              style={ghost}
            >
              长字幕
            </button>
          </div>

          <div style={{ fontSize: 10.5, opacity: 0.38, paddingBottom: 8, lineHeight: 1.6 }}>
            lastBeat: {state.lastBeat ?? "—"} · vfx:{" "}
            {Object.keys(state.vfx).length ? Object.keys(state.vfx).join(",") : "—"}
          </div>
        </aside>
      )}
    </>
  );
}

const ghost: CSSProperties = {
  flex: 1,
  padding: "6px 6px",
  fontSize: 11,
  borderRadius: 7,
  cursor: "pointer",
  color: "#e9e2d6",
  background: "rgba(255,255,255,.05)",
  border: "1px solid rgba(255,255,255,.14)",
  fontFamily: "inherit",
};

const host = document.getElementById("root");
if (host) createRoot(host).render(<Preview />);

// 便于用 headless 浏览器自查：任何运行期错误都写进 document.title 与 #err
window.addEventListener("error", (e) => {
  document.title = `ERR: ${e.message}`;
  const box = document.createElement("pre");
  box.id = "err";
  box.style.cssText = "position:fixed;left:0;bottom:0;z-index:9999;color:#f66;background:#000;font-size:11px;margin:0;padding:4px";
  box.textContent = `${e.message} @ ${e.filename}:${e.lineno}`;
  document.body.appendChild(box);
});
window.addEventListener("unhandledrejection", (e) => {
  document.title = `ERR: ${String(e.reason)}`;
});

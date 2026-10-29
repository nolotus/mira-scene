/**
 * Mira —— 分层 SVG 角色（骨架版：颈 / 肩 / 躯干 / 上臂 / 头 / 下颌 / 下摆各自独立）
 *
 * 全部由 CSS 变量驱动，没有一张位图、没有一个外部字体：
 *   状态（idle/listening/thinking/speaking）→ 躯干前倾量、呼吸周期与幅度、视线、耳侧高光
 *   姿势（5 种）→ 躯干 rotateY（透视）+ 颈前伸 + 肩线压低 + 头反向补偿
 *   情绪（7 种）→ 眉形 / 眼形（每条情绪一套眼睑开口裁剪）/ 瞳孔 / 嘴形 / 红晕 / 呼吸幅度
 *   口型（4 相位）→ 由 subtitle 的字数与内容驱动节奏（非固定循环）
 *   眨眼 → 1.8–7s 随机间隔 + 偶发双眨，由 --blink-name 切换 keyframes 重播
 *   动作（7 种）→ 各自一套多关键帧动画，跑在独立子层上，不与姿态过渡抢 transform
 */

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Emotion, Pose, SceneState } from "../../shared/protocol";
import { EMOTION_ORDER, EMOTION_SPEC, POSE_SPEC, STATUS_SPEC } from "./visuals";
import { specOf } from "./scenes/spec";

const vars = (o: Record<string, string>): CSSProperties => o as CSSProperties;

export interface CharacterProps {
  state: SceneState;
  /** 每当 pendingActions 变化时自增：用作一次性动作的 key，强制重播 */
  actionNonce: number;
  /**
   * 是否允许驱动口型（由在场状态仲裁器给出）。
   * 缺省 true = 保持原行为（preview 页 / 未接线的调用方）：只要状态是 speaking 就动嘴。
   * 接线后只有「TTS 真的在播」才为 true —— 没有声音的时候嘴不该动。
   */
  mouthDrive?: boolean;
}

// ---------------------------------------------------------------- 骨架参数表

/** 姿势 → 骨架量（注意：这些是「骨架怎么摆」，不是「整体平移多少」） */
interface PoseRig {
  /** 躯干绕 Y 轴转动（度）：负值 = 左半身退后（侧身避开） */
  turn: number;
  /** 前倾量 0..1：颈前伸 + 肩线压低 */
  lean: number;
  /** 肩线上下（px）：正值 = 压肩 */
  shrug: number;
  /** 肩宽缩放：侧身时肩膀更「正对镜头」一点 */
  wide: number;
}

const POSE_RIG: Record<Pose, PoseRig> = {
  stand: { turn: 0, lean: 0, shrug: 0, wide: 1 },
  lean_in: { turn: 0, lean: 1, shrug: 9.5, wide: 0.965 },
  turn_away: { turn: -31, lean: -0.15, shrug: 1.5, wide: 1.06 },
  hold_cup: { turn: 0, lean: 0.42, shrug: 3, wide: 0.99 },
  glance_window: { turn: -17, lean: 0.18, shrug: 1.5, wide: 1.02 },
};

/** 情绪 → 骨架量（呼吸幅度 / 耸肩 / 手臂收拢），让「紧张」「疲惫」写在肩上也读得出来 */
interface EmoRig {
  breath: number;
  shrug: number;
  armL: number;
  armR: number;
}

const EMO_RIG: Record<Emotion, EmoRig> = {
  neutral: { breath: 1, shrug: 0, armL: 0, armR: 0 },
  curious: { breath: 1.15, shrug: -1, armL: 0, armR: 0 },
  warm: { breath: 1.3, shrug: 1.5, armL: 1.5, armR: -1.5 },
  amused: { breath: 0.85, shrug: -2, armL: 2, armR: -2 },
  anxious: { breath: 1.95, shrug: -4.5, armL: 5, armR: -5 },
  sad: { breath: 1.4, shrug: 4.5, armL: -2, armR: 2 },
  surprised: { breath: 1.6, shrug: -3.5, armL: 3, armR: -3 },
};

/** 一次性动作时长（ms，400–1400），只用于动画时长，不影响姿态过渡 */
const ACT_DUR: Record<string, number> = {
  blink: 340,
  hair_tuck: 1240,
  sigh: 1300,
  shiver: 720,
  look_back: 1040,
  nod: 760,
  startle: 620,
};

// ---------------------------------------------------------------- 口型 / 眨眼

/** 口型相位序列（0 闭合 / 1 半开 / 2 圆 / 3 扁），含换气停顿 */
const TALK_SEQ = [1, 0, 2, 1, 3, 0, 1, 2, 1, 0, 3, 1] as const;

/**
 * 口型相位：节奏由字幕决定 ——
 *   字数越多 → 音节越密；每个音节用「字数 + 序号 + 当前字码」哈希出相位与抖动，
 *   所以同一句台词不会掉进固定循环，换一句台词节奏也换一套。
 */
function useMouthPhase(subtitle: string, speaking: boolean): number {
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (!speaking) {
      setPhase(0);
      return;
    }
    const chars = Array.from(subtitle || "");
    const n = chars.length;
    let step = 0;
    let timer = 0;
    let stop = false;

    const tick = () => {
      if (stop) return;
      step += 1;
      if (n === 0) {
        setPhase(0);
        timer = window.setTimeout(tick, 240);
        return;
      }
      const code = chars[step % n]?.codePointAt(0) ?? 0;
      const h = (code * 31 + step * 17 + n * 7) % 996;
      const next = TALK_SEQ[h % TALK_SEQ.length] ?? 1;
      setPhase(next);
      // 字越多 → 说话越快（音节间隔更短）；抖动来自哈希，不是固定周期
      const base = Math.max(116, 262 - n * 3.4);
      const gap = base + (h % 6) * 21 + (next === 0 ? 52 : 0);
      timer = window.setTimeout(tick, gap);
    };

    timer = window.setTimeout(tick, 70);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [subtitle, speaking]);

  return phase;
}

/**
 * 眨眼：不用 CSS 无限循环，改成 JS 随机间隔 + keyframes 重播。
 * 间隔 1.8–7s，约 3 成概率连眨两下（--blink-name 换成 Twice 版本即重播）。
 */
function useBlink(): { name: string; ms: number } {
  const [tick, setTick] = useState(0);
  const [twice, setTwice] = useState(false);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    const loop = () => {
      if (stop) return;
      setTwice(Math.random() < 0.32);
      setTick((v) => (v + 1) % 2);
      timer = window.setTimeout(loop, 1800 + Math.random() * 5200);
    };
    timer = window.setTimeout(loop, 500 + Math.random() * 1900);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, []);

  const suffix = tick === 0 ? "A" : "B";
  return { name: `${twice ? "blinkTwice" : "blinkOnce"}${suffix}`, ms: twice ? 430 : 300 };
}

export function Character({ state, actionNonce, mouthDrive = true }: CharacterProps) {
  const pose = POSE_SPEC[state.pose];
  const status = STATUS_SPEC[state.characterStatus];
  const emo = EMOTION_SPEC[state.emotion];
  const rig = POSE_RIG[state.pose];
  const erg = EMO_RIG[state.emotion];
  /**
   * 场景光照契约（见 scenes/spec.ts）。
   * 颜色与轮廓光强度走 CSS 变量（--key-color / --fill-color / --rim-strength），
   * 这里只取渐变**几何**：SVG 的 offset / x2 / y2 是属性，不接受 var()。
   */
  const lighting = specOf(state.scene).lighting;

  const primary = state.pendingActions[0];
  const lip = useMouthPhase(state.subtitle, state.characterStatus === "speaking" && mouthDrive);
  const blink = useBlink();

  // 侧身补偿：躯干转了 turn，头要把脸「转回来」——宽度还原 + 反向偏转，避免整个人斜着平移
  const unyaw = Math.min(1.32, 1 / Math.max(0.62, Math.cos((rig.turn * Math.PI) / 180)));
  const leanPx = rig.lean * 9 + (state.characterStatus === "listening" ? 4.5 : 0);

  const rigStyle = vars({
    // 走位（保留）：整体位置/缩放只负责「站位」，表演交给下面的骨架
    "--char-x": `${pose.x + status.x}px`,
    "--char-y": `${(pose.y + status.y) * 0.5}px`,
    "--char-rot": `${pose.rot}deg`,
    "--char-scale": `${pose.scale * status.scale}`,

    // ---- 骨架 ----
    "--rig-turn": `${rig.turn}deg`,
    "--head-unyaw": `${unyaw}`,
    "--head-unskew": `${-rig.turn * 0.2}deg`,
    "--neck-fwd": `${leanPx}px`,
    "--shoulder-drop": `${rig.shrug + erg.shrug}px`,
    "--shoulder-wide": `${rig.wide}`,
    "--torso-rot": `${rig.turn * 0.14 + rig.lean * 1.3}deg`,
    "--arm-l": `${erg.armL - rig.lean * 1.6}deg`,
    "--arm-r": `${erg.armR + rig.lean * 1.6}deg`,
    "--hem-dur": `${status.breathDur}s`,
    "--hem-delay": `${-status.breathDur * 0.24}s`,
    "--hem-amp": `${0.55 + erg.breath * 0.42}deg`,

    // ---- 头 ----
    "--head-rot": `${pose.headRot + status.headRot + emo.headTilt - rig.turn * 0.3}deg`,
    "--head-x": `${pose.headX + status.gazeX * 0.4 - rig.turn * 0.1}px`,
    "--head-y": `${pose.headY + status.headY + emo.headY + rig.lean * 4}px`,

    // ---- 五官 ----
    "--gaze-x": `${status.gazeX + emo.gazeX}px`,
    "--gaze-y": `${status.gazeY + emo.gazeY}px`,
    "--eye-open": `${emo.eyeOpen}`,
    "--cheek": `${Math.min(1, emo.cheek * 1.55)}`,
    "--shade": `${pose.shade}`,
    "--cup": `${pose.cup}`,
    "--warmth": `${emo.warmth}`,

    // ---- 呼吸 / 其他 ----
    "--breath-dur": `${status.breathDur}s`,
    "--breath-amp": `${erg.breath}`,
    "--ear-glow": `${status.earGlow}`,

    // ---- 口型 / 眨眼（都由状态驱动，不是固定循环） ----
    "--blink-name": blink.name,
    "--blink-ms": `${blink.ms}ms`,
    "--act-dur": `${(primary && ACT_DUR[primary]) || 600}ms`,
  });

  return (
    <div className="char" aria-hidden="true">
      <div className="char-breathe">
        <div
          className="char-rig"
          data-emotion={state.emotion}
          data-status={state.characterStatus}
          data-pose={state.pose}
          data-lip={lip}
          data-act={primary ?? "none"}
          style={rigStyle}
        >
          <div className="char-yaw">
            <div className="char-act" key={`act-${actionNonce}`}>
              <svg className="char-svg" viewBox="0 0 400 560" role="img">
                <defs>
                  <linearGradient id="mx-hair" x1="0" y1="0" x2="0.3" y2="1">
                    <stop offset="0" stopColor="#4b3427" />
                    <stop offset="0.55" stopColor="#2e2019" />
                    <stop offset="1" stopColor="#1a110d" />
                  </linearGradient>
                  <linearGradient id="mx-hair-sheen" x1="0" y1="0" x2="1" y2="0.4">
                    <stop offset="0" stopColor="#c79a72" stopOpacity="0" />
                    <stop offset="0.45" stopColor="#d8ad83" stopOpacity="0.5" />
                    <stop offset="1" stopColor="#8a6446" stopOpacity="0" />
                  </linearGradient>
                  <linearGradient id="mx-skin" x1="0.2" y1="0" x2="0.8" y2="1">
                    <stop offset="0" stopColor="#f8dfc9" />
                    <stop offset="0.6" stopColor="#f1cdb0" />
                    <stop offset="1" stopColor="#dfad91" />
                  </linearGradient>
                  <linearGradient id="mx-skin-neck" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#c08f74" />
                    <stop offset="1" stopColor="#e9c2a5" />
                  </linearGradient>
                  <linearGradient id="mx-coat" x1="0.15" y1="0" x2="0.85" y2="1">
                    <stop offset="0" stopColor="#f7c583" />
                    <stop offset="0.38" stopColor="#e09a4a" />
                    <stop offset="0.78" stopColor="#b06c26" />
                    <stop offset="1" stopColor="#7d4615" />
                  </linearGradient>
                  {/* 与 mx-coat 同一套色阶，但用用户坐标系：上下两片雨衣拼接处不会有色差 */}
                  <linearGradient id="mx-coat-us" gradientUnits="userSpaceOnUse" x1="109" y1="318" x2="291" y2="560">
                    <stop offset="0" stopColor="#f7c583" />
                    <stop offset="0.38" stopColor="#e09a4a" />
                    <stop offset="0.78" stopColor="#b06c26" />
                    <stop offset="1" stopColor="#7d4615" />
                  </linearGradient>
                  <linearGradient id="mx-coat-dark" x1="0" y1="0" x2="0.4" y2="1">
                    <stop offset="0" stopColor="#a35f20" />
                    <stop offset="1" stopColor="#6d3b12" />
                  </linearGradient>
                  <linearGradient id="mx-sleeve" gradientUnits="userSpaceOnUse" x1="100" y1="340" x2="200" y2="540">
                    <stop offset="0" stopColor="#e0a04f" />
                    <stop offset="0.5" stopColor="#b4712a" />
                    <stop offset="1" stopColor="#7a4413" />
                  </linearGradient>
                  <linearGradient id="mx-hood" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#c07c2f" />
                    <stop offset="1" stopColor="#5f3311" />
                  </linearGradient>
                  <linearGradient id="mx-rim" x1="1" y1="0" x2="0" y2="0.6">
                    <stop
                      offset="0"
                      style={{
                        stopColor: "var(--fill-color, #9ec6ec)",
                        stopOpacity: "calc(var(--rim-strength, 1) * 0.85)",
                      }}
                    />
                    <stop
                      offset="0.5"
                      style={{
                        stopColor: "var(--fill-color, #9ec6ec)",
                        stopOpacity: "calc(var(--rim-strength, 1) * 0.12)",
                      }}
                    />
                    <stop
                      offset="1"
                      style={{ stopColor: "var(--fill-color, #9ec6ec)", stopOpacity: "0" }}
                    />
                  </linearGradient>
                  <radialGradient id="mx-iris" cx="0.42" cy="0.36" r="0.75">
                    <stop offset="0" stopColor="#8a6038" />
                    <stop offset="0.55" stopColor="#54341d" />
                    <stop offset="1" stopColor="#241407" />
                  </radialGradient>
                  <radialGradient id="mx-cheek" cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0" stopColor="#e07a63" stopOpacity="0.75" />
                    <stop offset="1" stopColor="#e07a63" stopOpacity="0" />
                  </radialGradient>
                  <radialGradient id="mx-earglow" cx="0.5" cy="0.5" r="0.5">
                    <stop offset="0" stopColor="#bfe3ff" stopOpacity="0.85" />
                    <stop offset="1" stopColor="#bfe3ff" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient
                    id="mx-shade"
                    x1="0"
                    y1="0"
                    x2={String(lighting.keyDir.x)}
                    y2={String(lighting.keyDir.y)}
                  >
                    <stop offset="0" stopColor="#050a14" stopOpacity="0.85" />
                    <stop
                      offset={String(lighting.shadowSoftness)}
                      stopColor="#050a14"
                      stopOpacity="0"
                    />
                  </linearGradient>
                  <radialGradient id="mx-muglight" cx="0.5" cy="0.2" r="0.7">
                    <stop
                      offset="0"
                      style={{ stopColor: "var(--key-color, #ffe6bd)" }}
                      stopOpacity="0.55"
                    />
                    <stop
                      offset="1"
                      style={{ stopColor: "var(--key-color, #ffe6bd)" }}
                      stopOpacity="0"
                    />
                  </radialGradient>
                  <clipPath id="mx-face-clip">
                    <path d="M200,102 C247,102 275,138 276,190 C277,214 273,232 261,250 C250,272 231,286 214,293 C208,295.5 203,298 200,298 C197,298 192,295.5 186,293 C169,286 150,272 139,250 C127,232 123,214 124,190 C125,138 153,102 200,102 Z" />
                  </clipPath>
                  {/* 每种情绪、每只眼一套「眼睑开口」裁剪：情绪在静态单帧上就有不同眼形 */}
                  {EMOTION_ORDER.map((e) =>
                    EYES.map(({ cx, side }) => (
                      <clipPath id={`mx-eyec-${side}-${e}`} key={`${side}-${e}`}>
                        <path d={eyeOpening(cx, EYE_SHAPE[e])} />
                      </clipPath>
                    )),
                  )}
                </defs>

                {/* 1. 后发（跟头部旋转，被雨衣压住下摆） */}
                <g className="char-head char-head-back">
                  <g className="char-head-act">
                    {/* 头整体缩到 0.8×（绕颈根 200,330）：头身比从娃娃脸改成成年女性 */}
                    <g className="char-head-scale" transform="translate(200,330) scale(0.8) translate(-200,-330)">
                      <path
                        className="hair-back"
                        d="M200,78 C251,78 292,116 294,178 C296,230 286,276 294,320 C300,350 312,368 322,380 C292,392 264,380 246,354 C234,336 230,308 228,284 C222,234 232,194 222,160 C215,136 210,118 200,118 C190,118 185,136 178,160 C168,194 178,234 172,284 C170,308 166,336 154,354 C136,380 108,392 78,380 C92,368 102,350 108,320 C116,276 106,230 108,178 C110,116 149,78 200,78 Z"
                        fill="url(#mx-hair)"
                      />
                    </g>
                  </g>
                </g>

                {/* 2. 躯干骨架 */}
                <g className="char-torso">
                  {/* 雨衣后领 / 兜帽堆叠 */}
                  <ellipse cx="200" cy="336" rx="72" ry="24" fill="url(#mx-hood)" opacity="0.85" />

                  <g className="char-shoulders">
                    {/* 3. 脖子（独立组：前倾时颈前伸、微旋） */}
                    <g className="char-neck">
                      <path
                        d="M180,268 L180,326 C180,340 189,349 200,349 C211,349 220,340 220,326 L220,268 Z"
                        fill="url(#mx-skin-neck)"
                      />
                      <ellipse cx="200" cy="308" rx="20" ry="12" fill="#b07f66" opacity="0.45" />
                    </g>

                    {/* 4. 雨衣上身（琥珀色，湿润高光） */}
                    <path
                      className="coat"
                      d="M200,326 C186,326 170,331 154,338 C134,346 108,352 92,364 C86,398 96,438 112,470 C150,482 250,482 288,470 C304,438 314,398 308,364 C292,352 266,346 246,338 C230,331 214,326 200,326 Z"
                      fill="url(#mx-coat-us)"
                    />
                    {/* 领口 */}
                    <path
                      d="M140,344 C150,368 170,384 200,396 C184,370 176,350 172,332 Z M260,344 C250,368 230,384 200,396 C216,370 224,350 228,332 Z"
                      fill="url(#mx-coat-dark)"
                    />
                    {/* 门襟 + 拉链 */}
                    <path d="M200,352 L200,486" stroke="#6b3a12" strokeWidth="2.6" opacity="0.55" />
                    <rect x="196.5" y="400" width="8" height="14" rx="3" fill="#f3d9a6" opacity="0.7" />
                    {/* 肩线（压肩时整条线一起下去） */}
                    <path d="M93,370 C88,398 94,438 108,466" stroke="#7d4615" strokeWidth="2.6" fill="none" opacity="0.35" />
                    <path d="M307,370 C312,398 306,438 292,466" stroke="#7d4615" strokeWidth="2.6" fill="none" opacity="0.35" />
                    {/* 肩缝：让「肩」真的看得出来，不是一整块色块 */}
                    <path d="M176,332 C154,340 124,350 100,362" stroke="#6d3b12" strokeWidth="3" fill="none" opacity="0.5" strokeLinecap="round" />
                    <path d="M224,332 C246,340 276,350 300,362" stroke="#6d3b12" strokeWidth="3" fill="none" opacity="0.5" strokeLinecap="round" />
                    <path d="M100,362 C92,372 88,384 88,396 C100,388 108,376 112,360 Z" fill="#5f3311" opacity="0.2" />
                    <path d="M300,362 C308,372 312,384 312,396 C300,388 292,376 288,360 Z" fill="#5f3311" opacity="0.2" />
                    {/* 湿润高光 + 窗外冷色白边光（上半段） */}
                    <path
                      d="M186,330 C160,336 136,346 118,358 C104,368 98,382 95,402"
                      stroke="#ffe3b4"
                      strokeWidth="4.5"
                      fill="none"
                      opacity="0.35"
                    />
                    {/* 雨衣腰带：把腰线读出来（不是圆筒），并挂一枚 D 形扣 */}
                    <path
                      d="M102,436 C148,452 252,452 298,436 L299,454 C250,470 150,470 101,454 Z"
                      fill="#6d3b12"
                      opacity="0.5"
                    />
                    <path
                      d="M106,442 C150,456 250,456 294,442"
                      stroke="#a9712c"
                      strokeWidth="1.6"
                      fill="none"
                      opacity="0.5"
                    />
                    <rect x="188" y="440" width="24" height="22" rx="5" fill="#f3d9a6" opacity="0.85" />
                    <rect x="193" y="445" width="14" height="12" rx="3" fill="#b4712a" opacity="0.9" />
                    <path
                      d="M214,450 C220,470 218,486 210,498 C205,504 198,502 197,496 C203,484 205,468 204,452 Z"
                      fill="#6d3b12"
                      opacity="0.45"
                    />
                    {/* 兜帽抽绳：领口不再是一块死板的深色 */}
                    <path d="M166,342 C162,364 160,382 164,396" stroke="#e8c48a" strokeWidth="2" fill="none" opacity="0.6" strokeLinecap="round" />
                    <path d="M234,342 C238,364 240,382 236,396" stroke="#e8c48a" strokeWidth="2" fill="none" opacity="0.6" strokeLinecap="round" />
                    <circle cx="164" cy="399" r="2.6" fill="#e8c48a" opacity="0.8" />
                    <circle cx="236" cy="399" r="2.6" fill="#e8c48a" opacity="0.8" />
                    {/* 上衣不再散布雨珠：原来的 4+4 个静止淡色椭圆在待机态也一直亮着，
                        没有水流方向、没有形成轨迹，读作「污渍」而不是雨。雨的表达交给
                        窗外的 rain-layer 与演出期的 vfx。 */}
                  </g>

                  {/* 5. 下摆（独立组，origin 在肩部：呼吸/动作时 2–4px 延迟摆动） */}
                  <g className="char-hem">
                    <path
                      className="coat-hem"
                      d="M112,470 C102,494 98,524 98,560 L302,560 C302,524 298,494 288,470 C246,486 154,486 112,470 Z"
                      fill="url(#mx-coat-us)"
                    />
                    <path
                      d="M282,332 C296,352 304,384 306,420 C308,450 306,486 302,520"
                      stroke="url(#mx-rim)"
                      strokeWidth="5"
                      fill="none"
                      strokeLinecap="round"
                    />
                    {/* 衣摆的湿褶：让下摆不是一块梯形 */}
                    <path d="M150,504 C146,522 144,540 146,558" stroke="#7d4615" strokeWidth="2.2" fill="none" opacity="0.3" />
                    <path d="M246,498 C250,520 252,540 250,558" stroke="#7d4615" strokeWidth="2.2" fill="none" opacity="0.3" />

                  </g>
                </g>

                {/* 6. 侧发（压在雨衣上，不随头旋转） */}
                <g className="char-sidehair">
                  <path
                    d="M140.8,237.2 C129.6,275.6 124.8,322 131.2,366.8 C134.4,390.8 144,411.6 160,426 C153.6,395.6 152,358.8 153.6,325.2 C155.2,296.4 156.8,264.4 160,238.8 Z"
                    fill="url(#mx-hair)"
                  />
                  <path
                    d="M259.2,237.2 C270.4,275.6 275.2,322 268.8,366.8 C265.6,390.8 256,411.6 240,426 C246.4,395.6 248,358.8 246.4,325.2 C244.8,296.4 243.2,264.4 240,238.8 Z"
                    fill="url(#mx-hair)"
                  />
                  {/* 侧发上的细碎发丝：头发不是一块纯色 */}
                  <path d="M148,246 C139,292 137,344 144,384" stroke="#5d4231" strokeWidth="2" fill="none" opacity="0.5" strokeLinecap="round" />
                  <path d="M252,246 C261,292 263,344 256,384" stroke="#5d4231" strokeWidth="2" fill="none" opacity="0.5" strokeLinecap="round" />
                </g>

                {/* 7. 上臂（独立组，origin 在肩关节）：姿势与动作都会抬肩/转袖 */}
                {/* 袖口与手共用上臂骨架，不另加位移动画；腕根藏进收口内，避免转肩时脱节。 */}
                <g className="char-arm char-arm-l">
                  <path
                    className="sleeve"
                    d="M96,368 C86,398 80,436 80,468 C80,479 83,488 87,494 Q101,501 116,493 C115,480 116,466 117,452 C119,420 122,392 124,372 Z"
                    fill="url(#mx-sleeve)"
                  />
                  <path d="M118,378 C112,412 108,450 110,478 M84,471 Q92,479 91,486 M115,470 Q105,480 108,488" stroke="#7d4615" strokeWidth="2.4" fill="none" opacity="0.45" />
                  {/* 袖口内腔 → 腕掌 → 前侧布边：遮挡关系让手从袖内长出来。 */}
                  <path d="M86,487 Q101,493 116,486 L116,499 Q102,507 88,499 Z" fill="#593619" />
                  <path
                    d="M92,493 C92,501 91,507 92,514 L94,526 Q96,532 101,533 L107,533 Q113,532 114,526 L114,516 Q119,520 121,516 Q122,513 118,508 L111,501 L110,493 Z"
                    fill="url(#mx-skin)" stroke="#b77f64" strokeWidth="1.2" strokeLinejoin="round"
                  />
                  <path d="M110,505 Q106,511 111,517 M99,524 L100,529 M105,524 L105,530" fill="none" stroke="#bd896e" strokeWidth="1.1" strokeLinecap="round" opacity="0.65" />
                  <path d="M85,483 Q100,490 116,483 L116,494 Q102,502 87,495 Z" fill="url(#mx-sleeve)" stroke="#754719" strokeWidth="1.2" />
                  <path d="M88,486 Q101,492 113,487" fill="none" stroke="#e4b16f" strokeWidth="1.6" opacity="0.7" />
                  <path d="M89,493 Q102,499 114,493" fill="none" stroke="#603816" strokeWidth="1.2" />
                </g>
                <g className="char-arm char-arm-r">
                  {/* 镜像局部几何，保留原有左右臂的独立 CSS 变换与动作钩子。 */}
                  <g transform="translate(400,0) scale(-1,1)">
                    <path
                      className="sleeve"
                      d="M96,368 C86,398 80,436 80,468 C80,479 83,488 87,494 Q101,501 116,493 C115,480 116,466 117,452 C119,420 122,392 124,372 Z"
                      fill="url(#mx-sleeve)"
                    />
                    <path d="M118,378 C112,412 108,450 110,478 M84,471 Q92,479 91,486 M115,470 Q105,480 108,488" stroke="#7d4615" strokeWidth="2.4" fill="none" opacity="0.45" />
                    <path d="M86,487 Q101,493 116,486 L116,499 Q102,507 88,499 Z" fill="#593619" />
                    <path
                      d="M92,493 C92,501 91,507 92,514 L94,526 Q96,532 101,533 L107,533 Q113,532 114,526 L114,516 Q119,520 121,516 Q122,513 118,508 L111,501 L110,493 Z"
                      fill="url(#mx-skin)" stroke="#b77f64" strokeWidth="1.2" strokeLinejoin="round"
                    />
                    <path d="M110,505 Q106,511 111,517 M99,524 L100,529 M105,524 L105,530" fill="none" stroke="#bd896e" strokeWidth="1.1" strokeLinecap="round" opacity="0.65" />
                    <path d="M85,483 Q100,490 116,483 L116,494 Q102,502 87,495 Z" fill="url(#mx-sleeve)" stroke="#754719" strokeWidth="1.2" />
                    <path d="M88,486 Q101,492 113,487" fill="none" stroke="#e4b16f" strokeWidth="1.6" opacity="0.7" />
                    <path d="M89,493 Q102,499 114,493" fill="none" stroke="#603816" strokeWidth="1.2" />
                  </g>
                </g>

                {/* 杯子（hold_cup 才出现） */}
                <g className="mug">
                  <ellipse cx="200" cy="496" rx="62" ry="26" fill="url(#mx-muglight)" />
                  <path d="M174,452 L226,452 L221,508 C220,515 214,520 207,520 L193,520 C186,520 180,515 179,508 Z" fill="#f4efe6" />
                  <path d="M174,452 L226,452 L224,467 L176,467 Z" fill="#e4d9c8" />
                  <path d="M226,463 C241,463 246,473 244,483 C242,494 233,500 222,500" stroke="#f4efe6" strokeWidth="6" fill="none" strokeLinecap="round" />
                  <ellipse cx="200" cy="452" rx="26" ry="8" fill="#6b4423" />
                  <ellipse cx="200" cy="451" rx="19" ry="5" fill="#432815" />
                  {/* 杯壁反光：杯子不是白色梯形 */}
                  <path d="M181,472 C180,486 181,498 184,510" stroke="#d8cdbb" strokeWidth="2" fill="none" opacity="0.7" />
                </g>

                {/* 8. 头部（面部特征整体跟随 --head-rot / --head-unyaw） */}
                <g className="char-head char-head-front">
                  <g className="char-head-act">
                    {/* 头整体缩到 0.8×（绕颈根 200,330）：头身比从娃娃脸改成成年女性 */}
                    <g className="char-head-scale" transform="translate(200,330) scale(0.8) translate(-200,-330)">
                      {/* 耳朵 + 倾听时的耳侧高光 */}
                      <ellipse cx="126" cy="208" rx="11" ry="17" fill="url(#mx-skin)" />
                      <ellipse cx="274" cy="208" rx="11" ry="17" fill="url(#mx-skin)" />
                      <ellipse cx="126" cy="208" rx="5" ry="9" fill="#d9a184" opacity="0.6" />
                      <ellipse cx="274" cy="208" rx="5" ry="9" fill="#d9a184" opacity="0.6" />
                      <circle className="ear-glow" cx="126" cy="206" r="30" fill="url(#mx-earglow)" />
                      <circle className="ear-glow ear-glow-r" cx="274" cy="206" r="30" fill="url(#mx-earglow)" />

                      {/* 脸 */}
                      <path
                        className="face"
                        d="M200,102 C247,102 275,138 276,190 C277,214 273,232 261,250 C250,272 231,286 214,293 C208,295.5 203,298 200,298 C197,298 192,295.5 186,293 C169,286 150,272 139,250 C127,232 123,214 124,190 C125,138 153,102 200,102 Z"
                        fill="url(#mx-skin)"
                      />

                      {/* 侧向阴影（turn_away / glance_window） */}
                      <g clipPath="url(#mx-face-clip)">
                        <rect className="face-shade" x="110" y="90" width="180" height="220" fill="url(#mx-shade)" />
                        <ellipse cx="200" cy="120" rx="96" ry="34" fill="#0a1018" opacity="0.18" />
                      </g>

                      {/* 脸颊红晕（强度由情绪给，位置随情绪微移） */}
                      <g className="cheeks">
                        <ellipse className="cheek" cx="158" cy="234" rx="27" ry="18" fill="url(#mx-cheek)" />
                        <ellipse className="cheek" cx="242" cy="234" rx="27" ry="18" fill="url(#mx-cheek)" />
                      </g>

                      {/* 眼：7 种情绪各一套眼睑开口（裁剪），瞳孔大小与朝向单独给 */}
                      <g className="eyes">
                        {EMOTION_ORDER.map((e) => (
                          <g className={`eye-set eye-set-${e}`} key={e}>
                            {EYES.map(({ cx, side }) => (
                              <g className="eye" key={side}>
                                <g className="eye-shape">
                                  <g className="eye-blink">
                                    <g clipPath={`url(#mx-eyec-${side}-${e})`}>
                                      <ellipse cx={cx} cy="198" rx="16.5" ry="12.4" fill="#fbf3ee" />
                                      <ellipse cx={cx} cy="198" rx="16.5" ry="12.4" fill="#2a1712" opacity="0.12" />
                                      <g className="gaze">
                                        <g className="gaze-act">
                                          <circle cx={cx} cy="199.5" r="9.2" fill="url(#mx-iris)" />
                                          <circle cx={cx} cy="199.5" r={3.8 * EYE_PUPIL[e]} fill="#150d09" />
                                          <circle cx={cx - 3} cy="196" r="2.9" fill="#ffffff" opacity="0.92" />
                                          <circle cx={cx + 3.6} cy="202.8" r="1.3" fill="#ffffff" opacity="0.45" />
                                        </g>
                                      </g>
                                    </g>
                                    {/* 眼线不在裁剪里：闭眼时也要有形状 */}
                                    <path
                                      d={eyeUpper(cx, EYE_SHAPE[e])}
                                      stroke="#2c1a12"
                                      strokeWidth={EYE_SHAPE[e].thick}
                                      strokeLinecap="round"
                                      fill="none"
                                    />
                                    <path
                                      d={eyeLower(cx, EYE_SHAPE[e])}
                                      stroke={EYE_SHAPE[e].tear ? "#8fa7c4" : "#c68a72"}
                                      strokeWidth={EYE_SHAPE[e].tear ? 2 : 1.4}
                                      fill="none"
                                      opacity={EYE_SHAPE[e].tear ? 0.75 : 0.5}
                                    />
                                    <path
                                      d={`M${cx + 14},${192.5 + EYE_SHAPE[e].tilt} L${cx + 20},${188.5 + EYE_SHAPE[e].tilt}`}
                                      stroke="#2c1a12"
                                      strokeWidth="2.8"
                                      strokeLinecap="round"
                                    />
                                  </g>
                                </g>
                              </g>
                            ))}
                          </g>
                        ))}
                      </g>

                      {/* 眉毛：7 种情绪各一份 */}
                      <g className="brows">
                        {EMOTION_ORDER.map((e) => (
                          <g className={`brow brow-${e}`} key={e}>
                            <path d={BROWS[e][0]} />
                            <path d={BROWS[e][1]} />
                          </g>
                        ))}
                      </g>

                      {/* 鼻子 */}
                      <path
                        d="M200,222 C196,232 195,238 199,241 C202,243 206,242 208,239"
                        stroke="#c58a6d"
                        strokeWidth="2.8"
                        fill="none"
                        strokeLinecap="round"
                        opacity="0.75"
                      />

                      {/* 嘴 + 下颌：闭合相位用情绪嘴形，1/2/3 相位是说话口型 */}
                      <g className="char-jaw">
                        <g className="mouths">
                          {EMOTION_ORDER.map((e) => (
                            <g className={`mouth mouth-${e}`} key={e}>
                              <path d={MOUTHS[e].path} fill={MOUTHS[e].fill} />
                              {MOUTHS[e].lip ? <path d={MOUTHS[e].lip} fill="#b5675c" opacity="0.5" /> : null}
                            </g>
                          ))}
                          {LIPS.map((l, i) =>
                            l.path ? (
                              <g className={`lip lip-${i}`} key={i}>
                                <path d={l.path} fill={l.fill} />
                                {l.teeth ? <path d={l.teeth} fill="#fdf3ea" opacity="0.85" /> : null}
                              </g>
                            ) : null,
                          )}
                        </g>
                      </g>

                      {/* 情绪标记：焦虑的汗滴 / 惊讶的爆点（只在对应情绪出现） */}
                      <g className="char-marks">
                        <path
                          className="mark mark-sweat"
                          d="M284,168 C290,178 294,184 294,190 C294,197 289,201 283,201 C277,201 272,197 272,190 C272,184 278,178 284,168 Z"
                          fill="#bfe3ff"
                          opacity="0.8"
                        />
                        <path className="mark mark-spark" d="M300,132 L303,141 L312,144 L303,147 L300,156 L297,147 L288,144 L297,141 Z" fill="#fff2c9" opacity="0.9" />
                      </g>

                      {/* 刘海 + 湿发丝 */}
                      <path
                        d="M112,206 C116,130 148,92 200,92 C252,92 284,130 288,206 C278,172 258,152 230,143 C212,138 198,152 184,163 C168,176 142,190 112,206 Z"
                        fill="#241811"
                      />
                      {/* 发缝补片：后发的内挖空（y≈120–162）与刘海底边（x≈212 处升至 y≈138）之间
                          曾露出一块额头皮肤，在头顶读成「假发中缝」。这里用与刘海同色的覆盖路径把
                          缺口填上：上沿钻进刘海内部避免接缝，下沿是一道连续发际线（y≈158–164，
                          高于眉毛 y≈173 至少 9px，不会压眼）。 */}
                      <path
                        className="hair-part-fill"
                        d="M184,164 C194,150 206,140 216,134 C226,128 238,136 248,146 C256,152 262,156 268,160 C254,158 232,158 210,159 C198,160 188,162 184,164 Z"
                        fill="#241811"
                      />
                      <path d="M236,140 C222,152 214,170 212,188" stroke="#6d4c35" strokeWidth="2.4" fill="none" opacity="0.6" strokeLinecap="round" />
                      <path d="M168,146 C160,160 156,174 156,186" stroke="#6d4c35" strokeWidth="2" fill="none" opacity="0.45" strokeLinecap="round" />
                      {/* 额前碎发：多几缕，刘海才不是一块色板 */}
                      <path d="M206,116 C197,132 191,150 190,166" stroke="#6d4c35" strokeWidth="1.8" fill="none" opacity="0.38" strokeLinecap="round" />
                      <path d="M142,138 C134,154 131,170 132,184" stroke="#6d4c35" strokeWidth="1.6" fill="none" opacity="0.3" strokeLinecap="round" />
                      <path d="M262,132 C268,150 270,168 268,182" stroke="#6d4c35" strokeWidth="1.6" fill="none" opacity="0.3" strokeLinecap="round" />
                      {/* 湿发的反光带（复用已有的 mx-hair-sheen 渐变） */}
                      <path
                        d="M140,116 C162,102 196,98 226,106 C198,120 172,132 152,150 C144,140 140,128 140,116 Z"
                        fill="url(#mx-hair-sheen)"
                        opacity="0.5"
                      />
                      {/* 前景发绺：别头发时会被拨动。曾用 mx-hair 渐变，在额头上读成一道浅色斜线，改深色 */}
                      <path className="strand" d="M132,182 C146,174 158,166 170,158 C158,172 144,186 136,198 Z" fill="#2a1c12" opacity="0.92" />

                      {/* 银色星星发夹 */}
                      <g className="hairpin" transform="translate(152,158) rotate(-14)">
                        <g className="pin-act">
                          <path
                            d="M0,-13 L3.8,-4.6 L12.6,-3.7 L6.2,2.2 L7.9,11 L0,6.4 L-7.9,11 L-6.2,2.2 L-12.6,-3.7 L-3.8,-4.6 Z"
                            fill="#eaf2fb"
                            stroke="#b9cde2"
                            strokeWidth="1"
                          />
                          <path d="M0,-7 L1.6,-1.8 L6.6,-1.4 L2.7,1.9 L4,6.6 L0,3.8 L-4,6.6 L-2.7,1.9 L-6.6,-1.4 L-1.6,-1.8 Z" fill="#ffffff" opacity="0.85" />
                          <circle className="pin-spark" cx="9" cy="-11" r="2.6" fill="#ffffff" />
                        </g>
                      </g>
                      {/* 第二枚小发夹：鬓角一小撮，别在耳后 */}
                      <g className="hairpin" transform="translate(141,206) rotate(-28)">
                        <g className="pin-act">
                          <path d="M0,-7 L2.1,-2.5 L6.9,-2 L3.4,1.2 L4.3,6 L0,3.5 L-4.3,6 L-3.4,1.2 L-6.9,-2 L-2.1,-2.5 Z" fill="#e6eef8" stroke="#a9c0d8" strokeWidth="0.9" />
                          <circle className="pin-spark" cx="6" cy="-7" r="1.8" fill="#ffffff" />
                        </g>
                      </g>
                    </g>
                  </g>
                </g>

                {/* 9. 别头发：抬起的手臂（前景，压在头部之上，靠透视缩短表现「伸过去」） */}
                <g className="char-reach">
                  {/* 前臂：后粗前细，斜着向发夹方向伸 */}
                  <path
                    className="reach-arm"
                    d="M185.6,344.4 C174.4,325.2 164.8,304.4 160,285.2 C157.6,275.6 161.6,268.4 168,269.2 C174.4,270 177.6,276.4 179.2,283.6 C182.4,301.2 188.8,322 195.2,339.6 Z"
                    fill="url(#mx-sleeve)"
                  />
                  {/* 袖口 + 掌 + 指：整体上移 14、左移 6 —— 头缩到 0.8× 后发夹随之上移，
                      原来手停在旧位置会悬空约 20~30 单位（几何近似，未逐帧校） */}
                  <g transform="translate(-6,-14)">
                  <path d="M158.4,285.2 C163.2,279.6 176,279.6 180.8,284.4 L179.2,292.4 C174.4,297.2 163.2,297.2 158.4,292.4 Z" fill="url(#mx-coat-dark)" opacity="0.9" />
                  {/* 手掌 + 手指朝发夹 */}
                  <path className="reach-hand" d="M165.6,282 C160,274 157.6,263.6 160.8,257.2 C164,250.8 170.4,250 173.6,256.4 C175.2,262 174.4,269.2 172.8,274 Z" fill="url(#mx-skin)" />
                  <path d="M161.6,258 C163.2,251.6 168,248.4 172,251.6" stroke="#c58a6d" strokeWidth="1.8" fill="none" opacity="0.7" />
                  <path d="M166.4,255.6 L170.4,246" stroke="#f5d6bd" strokeWidth="4.2" strokeLinecap="round" />
                  <path d="M172,257.2 L176.8,248.4" stroke="#f5d6bd" strokeWidth="4" strokeLinecap="round" />
                  </g>
                </g>

                {/* 10. 思考：头顶飘散的光点 */}
                <g className="think-motes">
                  <circle cx="242" cy="100" r="3.2" />
                  <circle cx="264" cy="82" r="2.2" />
                  <circle cx="220" cy="76" r="2.6" />
                </g>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 骨架几何表

const EYES: { cx: number; side: "l" | "r" }[] = [
  { cx: 172, side: "l" },
  { cx: 228, side: "r" },
];

/** 每只眼睛的「开口」形状：上弧抬起 up、下弧下沉 down、内外眼角倾斜 tilt */
interface EyeShape {
  up: number;
  down: number;
  tilt: number;
  thick: number;
  tear?: boolean;
}

const EYE_SHAPE: Record<Emotion, EyeShape> = {
  // 平静：上下弧都薄，正中
  neutral: { up: 9, down: 6.7, tilt: 0, thick: 3 },
  // 好奇：睁大且外眼角上挑
  curious: { up: 11.8, down: 7.3, tilt: -1.6, thick: 3.2 },
  // 温和：下眼睑抬起 → 弯眼（但还留着可识别的眼白，别变成闭眼）
  warm: { up: 10.6, down: 4.3, tilt: -1, thick: 3.2 },
  // 愉悦：弯成月牙
  amused: { up: 11.2, down: 2.5, tilt: -2, thick: 3.5 },
  // 焦虑：睁大但上眼睑压低、外眼角下垂
  anxious: { up: 10.1, down: 4.9, tilt: 1.8, thick: 2.8 },
  // 难过：眼睑沉、水光
  sad: { up: 7.2, down: 5.2, tilt: 2.4, thick: 2.8, tear: true },
  // 惊讶：最大
  surprised: { up: 14, down: 8.5, tilt: -0.6, thick: 3 },
};

/** 瞳孔大小（惊讶最大，焦虑最紧） */
const EYE_PUPIL: Record<Emotion, number> = {
  neutral: 1,
  curious: 1.12,
  warm: 1.02,
  amused: 0.94,
  anxious: 0.82,
  sad: 0.96,
  surprised: 1.3,
};

/** 由 EyeShape 生成闭合的「眼睑开口」路径（用于裁剪） */
function eyeOpening(cx: number, s: EyeShape): string {
  const l = cx - 16.5;
  const r = cx + 16.5;
  const c = 195.5;
  const inner = c + s.tilt;
  const outer = c - s.tilt;
  return (
    `M${l},${inner} C${cx - 10},${c - s.up} ${cx + 10},${c - s.up} ${r},${outer}` +
    ` C${cx + 10},${c + s.down} ${cx - 10},${c + s.down} ${l},${inner} Z`
  );
}

function eyeUpper(cx: number, s: EyeShape): string {
  const c = 195.5;
  return `M${cx - 16.5},${c + s.tilt} C${cx - 10},${c - s.up} ${cx + 10},${c - s.up} ${cx + 16.5},${c - s.tilt}`;
}

function eyeLower(cx: number, s: EyeShape): string {
  const c = 195.5;
  return `M${cx - 14},${c + s.down * 0.35} C${cx - 7},${c + s.down * 0.9} ${cx + 7},${c + s.down * 0.9} ${cx + 14},${c + s.down * 0.35}`;
}

// ---------------------------------------------------------------- 五官路径表

/** 左右眉毛（顺序：左、右） */
const BROWS: Record<Emotion, [string, string]> = {
  neutral: ["M155,177 Q172,173 189,176", "M211,176 Q228,173 245,177"],
  // 一边挑眉：好奇读起来是「不对称」
  curious: ["M154,165 Q172,156 190,162", "M210,170 Q228,166 245,171"],
  warm: ["M155,180 Q172,172 189,177", "M211,177 Q228,172 245,180"],
  // 愉悦：外段上挑的「坏笑眉」
  amused: ["M155,175 Q173,163 190,170", "M210,176 Q228,174 246,173"],
  // 焦虑：内端高、外端塌
  anxious: ["M155,184 Q170,172 189,166", "M211,166 Q230,172 245,184"],
  sad: ["M155,186 Q169,174 189,168", "M211,168 Q231,174 245,186"],
  surprised: ["M155,159 Q172,150 189,157", "M211,157 Q228,150 245,159"],
};

interface MouthSpec {
  path: string;
  fill: string;
  lip?: string;
}

/** 嘴形（静态单帧就要能和别的情绪分开） */
const MOUTHS: Record<Emotion, MouthSpec> = {
  neutral: {
    path: "M188,257 C193,260 207,260 212,257",
    fill: "none",
    lip: "M189,257.5 C194,260.4 206,260.4 211,257.5 L211,258.6 C206,261.4 194,261.4 189,258.6 Z",
  },
  curious: {
    path: "M193,255 C196,263 204,263 207,255 C204,259 196,259 193,255 Z",
    fill: "#5a2a24",
    lip: "M192,254.5 C196,252.6 204,252.6 208,254.5 C204,256 196,256 192,254.5 Z",
  },
  warm: {
    path: "M184,254 C192,267 208,267 216,254 C208,260 192,260 184,254 Z",
    fill: "#5c2b28",
    lip: "M183,254 C192,264 208,264 217,254 C210,257.5 190,257.5 183,254 Z",
  },
  amused: {
    path: "M181,252 C190,273 210,273 219,252 C210,258 190,258 181,252 Z",
    fill: "#4a1f21",
    lip: "M180,252 C190,270 210,270 220,252 C211,256 189,256 180,252 Z",
  },
  anxious: {
    path: "M190,258 C195,255.5 205,260.5 211,257",
    fill: "none",
    lip: "M190,258 C195,255.5 205,260.5 211,257 L210.6,258.4 C205,262 195,257 190.4,259.4 Z",
  },
  sad: {
    path: "M186,261 C194,252 206,252 214,261",
    fill: "none",
    lip: "M186,260.6 C194,252 206,252 214,260.6 L214,262 C206,254 194,254 186,262 Z",
  },
  surprised: {
    path: "M200,247 C206,247 209,252 209,258 C209,265 205,269 200,269 C195,269 191,265 191,258 C191,252 194,247 200,247 Z",
    fill: "#3d1a1d",
    lip: "M193,250 C196,247 204,247 207,250 C204,252 196,252 193,250 Z",
  },
};

/** 说话口型：1 半开 / 2 圆 / 3 扁（0 相位交给情绪嘴形） */
const LIPS: { path?: string; fill?: string; teeth?: string }[] = [
  {},
  {
    path: "M188,252.4 C192,268.4 208,268.4 212,252.4 C208,257.4 192,257.4 188,252.4 Z",
    fill: "#3b191c",
    teeth: "M190,253.4 C194,250.4 206,250.4 210,253.4 C206,255.2 194,255.2 190,253.4 Z",
  },
  {
    path: "M200,249.5 C205.2,249.5 208.2,254.6 208.2,260.8 C208.2,267.4 204.6,271.6 200,271.6 C195.4,271.6 191.8,267.4 191.8,260.8 C191.8,254.6 194.8,249.5 200,249.5 Z",
    fill: "#33151a",
  },
  {
    path: "M182,253 C189,270 211,270 218,253 C211,259 189,259 182,253 Z",
    fill: "#3b191c",
    teeth: "M184.5,254 C192,250.6 208,250.6 215.5,254 C208,256.2 192,256.2 184.5,254 Z",
  },
];

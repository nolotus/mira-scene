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

const vars = (o: Record<string, string>): CSSProperties => o as CSSProperties;

export interface CharacterProps {
  state: SceneState;
  /** 每当 pendingActions 变化时自增：用作一次性动作的 key，强制重播 */
  actionNonce: number;
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

export function Character({ state, actionNonce }: CharacterProps) {
  const pose = POSE_SPEC[state.pose];
  const status = STATUS_SPEC[state.characterStatus];
  const emo = EMOTION_SPEC[state.emotion];
  const rig = POSE_RIG[state.pose];
  const erg = EMO_RIG[state.emotion];

  const primary = state.pendingActions[0];
  const lip = useMouthPhase(state.subtitle, state.characterStatus === "speaking");
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
                    <stop offset="0" stopColor="#9ec6ec" stopOpacity="0.85" />
                    <stop offset="0.5" stopColor="#9ec6ec" stopOpacity="0.12" />
                    <stop offset="1" stopColor="#9ec6ec" stopOpacity="0" />
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
                  <linearGradient id="mx-shade" x1="0" y1="0" x2="1" y2="0.2">
                    <stop offset="0" stopColor="#050a14" stopOpacity="0.85" />
                    <stop offset="0.62" stopColor="#050a14" stopOpacity="0" />
                  </linearGradient>
                  <radialGradient id="mx-muglight" cx="0.5" cy="0.2" r="0.7">
                    <stop offset="0" stopColor="#ffe6bd" stopOpacity="0.55" />
                    <stop offset="1" stopColor="#ffe6bd" stopOpacity="0" />
                  </radialGradient>
                  <clipPath id="mx-face-clip">
                    <path d="M200,102 C247,102 275,138 276,190 C277,214 273,232 265,250 C254,272 236,286 219,293 C213,295 206,297 200,297 C194,297 187,295 181,293 C164,286 146,272 135,250 C127,232 123,214 124,190 C125,138 153,102 200,102 Z" />
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
                    <path
                      className="hair-back"
                      d="M200,80 C256,80 300,118 302,180 C304,232 292,278 300,322 C306,352 318,370 332,382 C300,394 268,382 250,356 C238,338 234,310 232,286 C226,236 236,196 226,162 C219,138 212,120 200,120 C188,120 181,138 174,162 C164,196 174,236 168,286 C166,310 162,338 150,356 C132,382 100,394 68,382 C82,370 94,352 100,322 C108,278 96,232 98,180 C100,118 144,80 200,80 Z"
                      fill="url(#mx-hair)"
                    />
                  </g>
                </g>

                {/* 2. 躯干骨架 */}
                <g className="char-torso">
                  {/* 雨衣后领 / 兜帽堆叠 */}
                  <ellipse cx="200" cy="330" rx="92" ry="30" fill="url(#mx-hood)" opacity="0.85" />

                  <g className="char-shoulders">
                    {/* 3. 脖子（独立组：前倾时颈前伸、微旋） */}
                    <g className="char-neck">
                      <path
                        d="M174,258 L174,316 C174,330 186,340 200,340 C214,340 226,330 226,316 L226,258 Z"
                        fill="url(#mx-skin-neck)"
                      />
                      <ellipse cx="200" cy="292" rx="26" ry="16" fill="#b07f66" opacity="0.45" />
                    </g>

                    {/* 4. 雨衣上身（琥珀色，湿润高光） */}
                    <path
                      className="coat"
                      d="M200,318 C176,318 152,330 134,350 C110,376 96,440 88,486 C130,510 270,510 312,486 C304,440 290,376 266,350 C248,330 224,318 200,318 Z"
                      fill="url(#mx-coat-us)"
                    />
                    {/* 领口 */}
                    <path
                      d="M138,316 C148,352 166,374 200,382 C186,362 176,340 172,314 Z M262,316 C252,352 234,374 200,382 C214,362 224,340 228,314 Z"
                      fill="url(#mx-coat-dark)"
                    />
                    {/* 门襟 + 拉链 */}
                    <path d="M200,340 L200,470" stroke="#6b3a12" strokeWidth="3" opacity="0.55" />
                    <rect x="196" y="392" width="9" height="16" rx="3" fill="#f3d9a6" opacity="0.7" />
                    {/* 肩线（压肩时整条线一起下去） */}
                    <path d="M132,336 C118,368 110,406 106,452" stroke="#7d4615" strokeWidth="3" fill="none" opacity="0.35" />
                    <path d="M268,336 C282,368 290,406 294,452" stroke="#7d4615" strokeWidth="3" fill="none" opacity="0.35" />
                    {/* 肩缝：让「肩」真的看得出来，不是一整块色块 */}
                    <path d="M172,330 C158,336 145,344 137,354" stroke="#6d3b12" strokeWidth="3.4" fill="none" opacity="0.5" strokeLinecap="round" />
                    <path d="M228,330 C242,336 255,344 263,354" stroke="#6d3b12" strokeWidth="3.4" fill="none" opacity="0.5" strokeLinecap="round" />
                    <path d="M137,354 C128,362 121,374 118,386 C130,378 141,366 148,352 Z" fill="#5f3311" opacity="0.2" />
                    <path d="M263,354 C272,362 279,374 282,386 C270,378 259,366 252,352 Z" fill="#5f3311" opacity="0.2" />
                    {/* 湿润高光 + 窗外冷色白边光（上半段） */}
                    <path
                      d="M200,298 C170,298 146,309 126,326 C110,340 96,364 86,396"
                      stroke="#ffe3b4"
                      strokeWidth="5"
                      fill="none"
                      opacity="0.35"
                    />
                    {/* 上半身雨珠 */}
                    {UPPER_DROPS.map(([cx, cy, rx, ry], i) => (
                      <ellipse
                        key={`d${i}`}
                        className="coat-drop"
                        cx={cx}
                        cy={cy}
                        rx={rx}
                        ry={ry}
                        fill="#ffeccc"
                        opacity="0.42"
                        style={{ animationDelay: `${i * 0.7}s` }}
                      />
                    ))}
                  </g>

                  {/* 5. 下摆（独立组，origin 在肩部：呼吸/动作时 2–4px 延迟摆动） */}
                  <g className="char-hem">
                    <path
                      className="coat-hem"
                      d="M88,486 C76,508 72,536 70,560 L330,560 C328,536 324,508 312,486 C270,510 130,510 88,486 Z"
                      fill="url(#mx-coat-us)"
                    />
                    <path
                      d="M274,326 C290,346 302,380 310,420 C316,452 320,486 322,516"
                      stroke="url(#mx-rim)"
                      strokeWidth="6"
                      fill="none"
                      strokeLinecap="round"
                    />
                    {/* 下摆雨珠（跟着下摆一起晃） */}
                    {HEM_DROPS.map(([cx, cy, rx, ry], i) => (
                      <ellipse
                        key={`h${i}`}
                        className="coat-drop"
                        cx={cx}
                        cy={cy}
                        rx={rx}
                        ry={ry}
                        fill="#ffeccc"
                        opacity="0.42"
                        style={{ animationDelay: `${(i + 3) * 0.65}s` }}
                      />
                    ))}
                  </g>
                </g>

                {/* 6. 侧发（压在雨衣上，不随头旋转） */}
                <g className="char-sidehair">
                  <path
                    d="M126,214 C112,262 106,320 114,376 C118,406 130,432 150,450 C142,412 140,366 142,324 C144,288 146,248 150,216 Z"
                    fill="url(#mx-hair)"
                  />
                  <path
                    d="M274,214 C288,262 294,320 286,376 C282,406 270,432 250,450 C258,412 260,366 258,324 C256,288 254,248 250,216 Z"
                    fill="url(#mx-hair)"
                  />
                </g>

                {/* 7. 上臂（独立组，origin 在肩关节）：姿势与动作都会抬肩/转袖 */}
                <g className="char-arm char-arm-l">
                  <path
                    className="sleeve"
                    d="M132,344 C118,376 112,414 110,452 C109,484 112,510 118,530 C124,540 146,540 152,530 C148,506 146,472 148,436 C150,404 154,374 160,350 Z"
                    fill="url(#mx-sleeve)"
                  />
                  <path d="M156,352 C150,392 146,440 148,486" stroke="#7d4615" strokeWidth="2.6" fill="none" opacity="0.45" />
                  {/* 袖口（压到画面下沿之外，读作「小臂还在下面」，不要读成口袋） */}
                  <path d="M116,536 C122,532 150,532 156,536 L154,558 C148,562 124,562 118,558 Z" fill="url(#mx-coat-dark)" opacity="0.9" />
                </g>
                <g className="char-arm char-arm-r">
                  <path
                    className="sleeve"
                    d="M268,344 C282,376 288,414 290,452 C291,484 288,510 282,530 C276,540 254,540 248,530 C252,506 254,472 252,436 C250,404 246,374 240,350 Z"
                    fill="url(#mx-sleeve)"
                  />
                  <path d="M244,352 C250,392 254,440 252,486" stroke="#7d4615" strokeWidth="2.6" fill="none" opacity="0.45" />
                  <path d="M284,536 C278,532 250,532 244,536 L246,558 C252,562 276,562 282,558 Z" fill="url(#mx-coat-dark)" opacity="0.9" />
                </g>

                {/* 杯子（hold_cup 才出现） */}
                <g className="mug">
                  <ellipse cx="200" cy="500" rx="86" ry="34" fill="url(#mx-muglight)" />
                  <path d="M166,438 L234,438 L228,502 C227,510 220,516 212,516 L188,516 C180,516 173,510 172,502 Z" fill="#f4efe6" />
                  <path d="M166,438 L234,438 L232,456 L168,456 Z" fill="#e4d9c8" />
                  <path d="M234,452 C252,452 258,464 256,476 C254,490 244,498 232,498" stroke="#f4efe6" strokeWidth="7" fill="none" strokeLinecap="round" />
                  <ellipse cx="200" cy="438" rx="34" ry="9" fill="#6b4423" />
                  <ellipse cx="200" cy="437" rx="26" ry="6" fill="#432815" />
                </g>

                {/* 8. 头部（面部特征整体跟随 --head-rot / --head-unyaw） */}
                <g className="char-head char-head-front">
                  <g className="char-head-act">
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
                      d="M200,102 C247,102 275,138 276,190 C277,214 273,232 265,250 C254,272 236,286 219,293 C213,295 206,297 200,297 C194,297 187,295 181,293 C164,286 146,272 135,250 C127,232 123,214 124,190 C125,138 153,102 200,102 Z"
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
                                    <ellipse cx={cx} cy="198" rx="16.5" ry="11.5" fill="#fbf3ee" />
                                    <ellipse cx={cx} cy="198" rx="16.5" ry="11.5" fill="#2a1712" opacity="0.12" />
                                    <g className="gaze">
                                      <g className="gaze-act">
                                        <circle cx={cx} cy="199.5" r="8.4" fill="url(#mx-iris)" />
                                        <circle cx={cx} cy="199.5" r={3.4 * EYE_PUPIL[e]} fill="#150d09" />
                                        <circle cx={cx - 3} cy="196" r="2.7" fill="#ffffff" opacity="0.92" />
                                        <circle cx={cx + 3.6} cy="202.8" r="1.2" fill="#ffffff" opacity="0.45" />
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
                                    strokeWidth="2.2"
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
                      strokeWidth="2.2"
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
                    <path d="M236,140 C222,152 214,170 212,188" stroke="#6d4c35" strokeWidth="2.4" fill="none" opacity="0.6" strokeLinecap="round" />
                    <path d="M168,146 C160,160 156,174 156,186" stroke="#6d4c35" strokeWidth="2" fill="none" opacity="0.45" strokeLinecap="round" />
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
                  </g>
                </g>

                {/* 9. 别头发：抬起的手臂（前景，压在头部之上，靠透视缩短表现「伸过去」） */}
                <g className="char-reach">
                  {/* 前臂：后粗前细，斜着向发夹方向伸 */}
                  <path
                    className="reach-arm"
                    d="M182,348 C168,324 156,298 150,274 C147,262 152,253 160,254 C168,255 172,263 174,272 C178,294 186,320 194,342 Z"
                    fill="url(#mx-sleeve)"
                  />
                  {/* 袖口 */}
                  <path d="M148,274 C154,267 170,267 176,273 L174,283 C168,289 154,289 148,283 Z" fill="url(#mx-coat-dark)" opacity="0.9" />
                  {/* 手掌 + 手指朝发夹 */}
                  <path className="reach-hand" d="M157,270 C150,260 147,247 151,239 C155,231 163,230 167,238 C169,245 168,254 166,260 Z" fill="url(#mx-skin)" />
                  <path d="M152,240 C154,232 160,228 165,232" stroke="#c58a6d" strokeWidth="1.8" fill="none" opacity="0.7" />
                  <path d="M158,237 L163,225" stroke="#f5d6bd" strokeWidth="4.2" strokeLinecap="round" />
                  <path d="M165,239 L171,228" stroke="#f5d6bd" strokeWidth="4" strokeLinecap="round" />
                </g>

                {/* 10. 思考：头顶飘散的光点 */}
                <g className="think-motes">
                  <circle cx="248" cy="84" r="3.4" />
                  <circle cx="272" cy="66" r="2.4" />
                  <circle cx="226" cy="60" r="2.8" />
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
  neutral: { up: 8, down: 6, tilt: 0, thick: 2.6 },
  // 好奇：睁大且外眼角上挑
  curious: { up: 10.5, down: 6.5, tilt: -1.6, thick: 2.8 },
  // 温和：下眼睑抬起 → 弯眼（但还留着可识别的眼白，别变成闭眼）
  warm: { up: 9.5, down: 3.8, tilt: -1, thick: 2.8 },
  // 愉悦：弯成月牙
  amused: { up: 10, down: 2.2, tilt: -2, thick: 3 },
  // 焦虑：睁大但上眼睑压低、外眼角下垂
  anxious: { up: 9, down: 4.4, tilt: 1.8, thick: 2.4 },
  // 难过：眼睑沉、水光
  sad: { up: 6.4, down: 4.6, tilt: 2.4, thick: 2.4, tear: true },
  // 惊讶：最大
  surprised: { up: 12.5, down: 7.6, tilt: -0.6, thick: 2.6 },
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

/** 上半身的雨珠 */
const UPPER_DROPS: [number, number, number, number][] = [
  [116, 372, 4.5, 6.5],
  [292, 356, 4, 6],
  [136, 448, 5, 7],
  [268, 470, 4.5, 6.5],
];

/** 下摆的雨珠（跟着下摆摆） */
const HEM_DROPS: [number, number, number, number][] = [
  [98, 486, 4, 5.5],
  [308, 512, 5, 7],
  [176, 500, 3.5, 5],
  [230, 528, 4, 6],
];

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

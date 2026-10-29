/**
 * 照片级角色：`portrait.png` 底图 + 眼/嘴两个**局部变体**按 anchor 贴回原位。
 *
 * 为什么不是「重新生成整张脸」：参考图重生成实测保造型不保脸（同一张定妆照三张是三个人），
 * 所以身份完全来自这张定妆照，表情只允许 inpainting 变体覆盖眼睛/嘴巴两块矩形，
 * 其余像素一个都不动。
 *
 * 降级契约（全部只在诊断区留一行，绝不弹错、绝不白屏）：
 *   素材缺失 / spec 版本不匹配 / 定妆照加载失败 / 变体缺失 → 回退既有 SVG 角色。
 *   变体只是「可选增强」：眼睛没有变体就露定妆照原样，嘴没有变体就一直是闭唇。
 *
 * 微动幅度刻意小于 SVG 版（照片一动就是整张脸在抖）：
 *   呼吸 scale 1.000↔1.006（4.6s）、说话点头 ≤1.6px + 0.3°、状态位移走 120–200ms 过渡；
 *   `prefers-reduced-motion` 下这些动画与过渡全部关掉，只保留状态之间的静态差异。
 */

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CharacterStatus } from "../../../shared/protocol";
import { Character, type CharacterProps } from "../Character";
import {
  PORTRAIT_BASE_FILE,
  eyePatchRect,
  mouthPatchRect,
  portraitUrl,
  rectToPct,
  variantFile,
  EYE_VARIANTS,
  MOUTH_VARIANTS,
  type PatchRect,
} from "./portraitSpec";
import {
  EMOTION_FACE,
  PHOTO_MOTION,
  STATUS_PLACEMENT,
  faceAt,
  transitionMs,
} from "./photoRig";
import {
  decidePortraitMode,
  ensurePortraitAssets,
  hasAsset,
  usePortraitResource,
} from "./portraitRuntime";
import { photoBottomPx, propOcclusion, type PropOcclusion } from "./photoGrade";
import { photoStageVars } from "./photoStage";
import { specOf } from "../scenes/spec";
import "./photo.css";

const vars = (o: Record<string, string>): CSSProperties => o as CSSProperties;

/**
 * 补丁四边羽化：边缘做 alpha 过渡，中心保持全不透明。
 * 两层线性渐变按 `mask-composite: intersect` 相交；不支持该属性的浏览器会退化成并集，
 * 也就是「几乎不羽化」——安全失败，不会糊掉眼睛。
 *
 * **这里是羽化唯一生效的位置**：`patchStyle()` 把它内联到每个贴片上，内联优先级高于
 * `photo.css` 里的类规则（所以别在 CSS 里改 mask，改了也不会生效——2026-10-29 踩过）。
 *
 * 为什么只有 8%/10%（复现方法：`ffmpeg -v error -i public/char/mouth_closed.png -f rawvideo
 * -pix_fmt rgba` 后逐像素统计，116×88）：
 *   · 贴片 alpha 只有 {253, 255} —— 它是**不透明矩形**，不是带透明外框的贴纸；
 *   · 暗内容（唇线与下唇阴影）有两条带：y≈34–50 与 y≈57–73，横向铺到 x≈14–100；
 *   · 所以纵向实心核下沿必须在 y>73：18% 羽化的实心核下沿是 y=72.2，**正好切在暗带上**。
 * 8%/10% 把实心核扩到 x 9–106 / y 9–79，四面都留余量；相对 18% 那个更激进的方案，
 * 过渡带从 ~16px 收到 ~9px（相对原来的 6%/10% 基版反而是加宽）。想再加大，先重量一次 bbox。
 */
const PATCH_MASK = {
  maskImage:
    "linear-gradient(90deg, transparent 0, #000 8%, #000 92%, transparent 100%), linear-gradient(0deg, transparent 0, #000 10%, #000 90%, transparent 100%)",
  maskComposite: "intersect",
  WebkitMaskImage:
    "linear-gradient(90deg, transparent 0, #000 8%, #000 92%, transparent 100%), linear-gradient(0deg, transparent 0, #000 10%, #000 90%, transparent 100%)",
  WebkitMaskComposite: "source-in",
} as CSSProperties;

function patchStyle(rect: PatchRect): CSSProperties {
  return { ...rectToPct(rect), ...PATCH_MASK } as CSSProperties;
}

/** 系统是否要求减弱动态效果 */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return undefined;
  }, []);
  return reduced;
}

/**
 * 说话时钟：`speaking` 期间每 ~80ms 推一次已说话时长，交给纯函数 `mouthIndex` 算口型。
 * 不用 rAF：口型 3 张图，60fps 只换来更贵的重渲染，不会更顺。
 */
function useTalkClock(active: boolean, subtitle: string): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 80);
    return () => {
      window.clearInterval(timer);
      setElapsed(0);
    };
  }, [active, subtitle]);
  return elapsed;
}

/**
 * 眨眼：随机间隔 + 固定时长，和 SVG 版同一套节奏（1.8–7s，约 3 成连眨两下）。
 * 只有在 `eyes_closed.png` 真的存在时才跑——否则闭眼无从表达，宁可不动。
 */
function useBlink(enabled: boolean): boolean {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setClosed(false);
      return;
    }
    let stop = false;
    let timer = 0;
    const loop = () => {
      if (stop) return;
      const twice = Math.random() < 0.32;
      setClosed(true);
      window.setTimeout(() => {
        if (stop) return;
        if (twice) {
          setClosed(false);
          window.setTimeout(() => {
            if (stop) return;
            setClosed(true);
            window.setTimeout(() => {
              if (!stop) setClosed(false);
            }, 90);
          }, 90);
        } else {
          setClosed(false);
        }
      }, 105);
      timer = window.setTimeout(loop, 1800 + Math.random() * 5200);
    };
    timer = window.setTimeout(loop, 600 + Math.random() * 1600);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      setClosed(false);
    };
  }, [enabled]);
  return closed;
}

export function PhotoCharacter({ state, actionNonce, mouthDrive = true }: CharacterProps) {
  const resource = usePortraitResource();
  const reduced = useReducedMotion();

  useEffect(() => {
    void ensurePortraitAssets();
  }, []);

  const decision = decidePortraitMode({ mode: "photo", resource });
  const photoReady = decision.mode === "photo";
  const closedAsset = hasAsset(resource, variantFile("eyes", "closed"));
  const blinking = useBlink(photoReady && closedAsset && !reduced);
  const elapsed = useTalkClock(
    photoReady && state.characterStatus === "speaking" && mouthDrive,
    state.subtitle,
  );

  // 过渡时长按「上一次状态 → 本次状态」的位移量取 120–200ms
  const prevStatus = useRef<CharacterStatus | null>(null);
  const [duration, setDuration] = useState<number>(PHOTO_MOTION.transitionMs);
  useEffect(() => {
    const prev = prevStatus.current;
    if (prev === state.characterStatus) return;
    setDuration(transitionMs(prev, state.characterStatus));
    prevStatus.current = state.characterStatus;
  }, [state.characterStatus]);

  /**
   * 把「谁在渲染」写成可断言的痕迹（截图自查 / 用户排查都用得上）：
   *   data-mira-char          photo | svg:<原因>
   *   data-mira-svg           unmounted（照片就绪，SVG 层**已被卸载**）| fallback:svg
   *   data-mira-prop-occlusion hide（桌面杯按角色 rect 判为被遮挡，整组隐藏）
   * 三者都是 DOM 上可读的事实，不是「我想让它怎样」。
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const prevChar = root.dataset.miraChar;
    const prevSvg = root.dataset.miraSvg;
    root.dataset.miraChar = photoReady ? "photo" : `svg:${decision.reason ?? "flag_off"}`;
    root.dataset.miraSvg = photoReady ? "unmounted" : "fallback:svg";
    return () => {
      if (prevChar === undefined) delete root.dataset.miraChar;
      else root.dataset.miraChar = prevChar;
      if (prevSvg === undefined) delete root.dataset.miraSvg;
      else root.dataset.miraSvg = prevSvg;
    };
  }, [photoReady, decision.reason]);

  const charRef = useRef<HTMLDivElement | null>(null);
  const [bottomPx, setBottomPx] = useState<number | null>(null);
  const [propVerdict, setPropVerdict] = useState<PropOcclusion | null>(null);

  /**
   * 与字幕带上沿的间距：元素底边（渐隐走到 0 的位置）必须落在字幕带之上 12px。
   * 改前这里是写死的 CSS `bottom: 9%` —— 实测角色底边 848.1，字幕带上沿 799.1，
   * 角色的硬边直接压在字幕渐变里，两条边叠成一条更醒目的横线。
   */
  useEffect(() => {
    if (!photoReady || typeof window === "undefined") return;
    let raf = 0;
    const measure = () => {
      const el = charRef.current;
      const canvas = el?.closest(".stage-canvas");
      if (!el || !(canvas instanceof HTMLElement)) return;
      const canvasRect = canvas.getBoundingClientRect();
      const subtitle = document.querySelector(".stage-subtitle");
      const subTop = subtitle ? subtitle.getBoundingClientRect().top - canvasRect.top : null;
      setBottomPx(photoBottomPx(canvasRect.height, subTop));
    };
    raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    };
  }, [photoReady]);

  /**
   * 道具遮挡判定：拿**实测 rect**（不是设计稿常量）比较角色框与桌面杯。
   * 杯子在角色框内占比 ≥ 35% 就判为「被角色挡住」并整组隐藏（杯 + 碟）。
   * 依赖 bottomPx 是为了在角色被抬到字幕带之上后重量一次（站位变了，判据要重算）。
   */
  useEffect(() => {
    if (!photoReady || typeof window === "undefined") return;
    const root = document.documentElement;
    let raf = 0;
    const measure = () => {
      const el = charRef.current;
      if (!el) return;
      const c = el.getBoundingClientRect();
      const cup = document.querySelector(".table-cup");
      const p = cup ? cup.getBoundingClientRect() : null;
      const verdict = propOcclusion(
        { x: c.x, y: c.y, w: c.width, h: c.height },
        p ? { x: p.x, y: p.y, w: p.width, h: p.height } : null,
      );
      setPropVerdict(verdict);
      if (verdict.hidden) root.dataset.miraPropOcclusion = "hide";
      else delete root.dataset.miraPropOcclusion;
    };
    raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      delete root.dataset.miraPropOcclusion;
    };
  }, [photoReady, bottomPx]);

  // 降级：照片不可用 → 直接复用既有 SVG 角色（不套额外 DOM，几何与默认路径完全一致）
  if (!photoReady || resource.phase !== "ready") {
    return <Character state={state} actionNonce={actionNonce} />;
  }

  const spec = resource.spec;
  // 「落地感」三件事（接触阴影 / 边缘色 / 底部渐隐）的参数全部由场景数据算出来
  const stageVars = photoStageVars(specOf(state.scene).lighting, specOf(state.scene).palette);
  const place = STATUS_PLACEMENT[state.characterStatus];
  const face = faceAt({
    emotion: state.emotion,
    status: state.characterStatus,
    subtitle: state.subtitle,
    elapsedMs: elapsed,
    blinking,
  });

  const style = vars({
    ...stageVars,
    // 实测反推的底边（照片就绪后才有；首帧仍走 CSS 里的 9% 兜底）
    ...(bottomPx === null ? {} : { "--photo-bottom": `${bottomPx}px` }),
    "--photo-y": `${place.y}px`,
    "--photo-scale": `${place.scale}`,
    "--photo-rot": `${place.rot}deg`,
    "--photo-ar": `${spec.size.w} / ${spec.size.h}`,
    "--photo-dur": `${duration}ms`,
    "--photo-breath-dur": `${PHOTO_MOTION.breathDur}s`,
    "--photo-breath-scale": `${PHOTO_MOTION.breathScale}`,
    "--photo-fade": `${PHOTO_MOTION.variantFadeMs}ms`,
    "--photo-nod-px": `${PHOTO_MOTION.nodPx}px`,
    "--photo-nod-deg": `${PHOTO_MOTION.nodDeg}deg`,
  });

  return (
    <div
      ref={charRef}
      className="char-photo"
      aria-hidden="true"
      data-char-mode="photo"
      data-svg-layer="unmounted"
      data-prop-occlusion={propVerdict?.hidden ? "hide" : "visible"}
      data-prop-overlap={propVerdict ? String(propVerdict.overlap) : ""}
      data-status={state.characterStatus}
      data-emotion={state.emotion}
      data-eyes={face.eyes}
      data-mouth={face.mouth}
      data-motion={reduced ? "reduced" : "on"}
      style={style}
    >
      <span className="char-photo__shadow" aria-hidden="true" />
      <div className="char-photo__place">
        <div className="char-photo__breathe">
          <div className="char-photo__nod">
            <img
              className="char-photo__base"
              src={portraitUrl(PORTRAIT_BASE_FILE)}
              alt=""
              draggable={false}
              // 已经预加载过，这里再失败只可能是解码期问题；交给 onError 记一条诊断
              onError={() => {
                void ensurePortraitAssets();
              }}
            />
            {EYE_VARIANTS.map((variant) =>
              hasAsset(resource, variantFile("eyes", variant)) ? (
                <img
                  key={variant}
                  className="char-photo__patch"
                  data-part="eyes"
                  data-on={face.eyes === variant ? "true" : "false"}
                  src={portraitUrl(variantFile("eyes", variant))}
                  style={patchStyle(eyePatchRect(spec))}
                  alt=""
                  draggable={false}
                />
              ) : null,
            )}
            {MOUTH_VARIANTS.map((variant) =>
              hasAsset(resource, variantFile("mouth", variant)) ? (
                <img
                  key={variant}
                  className="char-photo__patch"
                  data-part="mouth"
                  data-on={face.mouth === variant ? "true" : "false"}
                  src={portraitUrl(variantFile("mouth", variant))}
                  style={patchStyle(mouthPatchRect(spec))}
                  alt=""
                  draggable={false}
                />
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 供测试/诊断引用的映射表（避免两处各写一份情绪 → 眼/嘴） */
export { EMOTION_FACE };

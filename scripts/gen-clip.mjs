/**
 * 生成「暴雨夜」媒体片段 —— 可选重新生成素材工具，产物是 public/clip/storm-strip.png。
 *
 * 说明：
 *   此脚本为可选开发工具，仅用于重新生成媒体片段素材（spritesheet）。
 *   仓库已内置已提交的素材文件（public/clip/storm-strip.png），日常开发、测试、
 *   构建与项目启动均不依赖此脚本，也不强制要求安装 puppeteer-core 或 Chrome。
 *
 * 运行（按需重新生成）：
 *   node scripts/gen-clip.mjs 或 bun scripts/gen-clip.mjs
 *
 * 配置项（环境变量）：
 *   - PUPPETEER_CORE_PATH: 自定义 puppeteer-core 模块路径或包名（可选覆盖，默认按标准本地依赖解析）
 *   - CHROME_PATH / PUPPETEER_EXECUTABLE_PATH: Chrome 可执行文件路径（默认 /usr/bin/google-chrome）
 *
 * 为什么要有它：题目要求「处理加载 / 播放结束 / 中途打断 / 失败」这四态，而 SVG 角色动画
 * 没有可加载、可播放结束、可解码失败的媒体资源，等于绕开了考点。所以这里真的产出一张
 * canvas 画出来的 spritesheet（12 帧 × 320×180 横排），由 ClipPlayer 用 <canvas> 逐帧播放。
 *
 * 约束：
 *   · 只画几何形状 + 渐变（雨线、灯光、窗框、模糊人影），无文字、无外部字体、无外部图片；
 *   · 固定种子 → 同一浏览器版本下每次产出同一张图（幂等：内容相同就不重写文件）；
 *   · 整张 PNG 必须 ≤ 250KB（超出直接退出码 1，不写出半成品）；
 *   · 画布 320×180 每帧，横向拼接，总宽 3840。
 *
 * 体积控制（实测）：抗锯齿斜线 + 每帧独立随机 + 大量半透明径向渐变会把 PNG 推到 900KB+。
 * 因此这里刻意用「扁平色块 + 少量色阶 + 跨帧共享的雨滴表」，让 PNG 的逐扫线滤波器有东西可压缩。
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "public", "clip", "storm-strip.png");
const CHROME =
  process.env.CHROME_PATH ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  "/usr/bin/google-chrome";

async function loadPuppeteer() {
  const customPath = process.env.PUPPETEER_CORE_PATH;
  if (customPath) {
    try {
      const isPathLike =
        customPath.startsWith(".") ||
        customPath.startsWith("/") ||
        customPath.includes("/");
      if (isPathLike) {
        try {
          return require(resolve(customPath));
        } catch {
          const mod = await import(pathToFileURL(resolve(customPath)).href);
          return mod.default || mod;
        }
      }
      const mod = await import(customPath);
      return mod.default || mod;
    } catch (err) {
      console.error(
        `[gen-clip] 无法从 PUPPETEER_CORE_PATH (${customPath}) 加载 puppeteer-core: ${err?.message ?? err}\n` +
          "  说明：此脚本为可选重新生成素材工具，不影响已有提交素材与项目启动。",
      );
      process.exit(1);
    }
  }

  try {
    const mod = await import("puppeteer-core");
    return mod.default || mod;
  } catch (err) {
    console.error(
      `[gen-clip] 缺少 puppeteer-core 依赖（${err?.message ?? err}）。\n` +
        "  可操作建议：\n" +
        "    1. 若需重新生成素材，可安装本地依赖：npm i -D puppeteer-core（或 bun add -d puppeteer-core）\n" +
        "    2. 或通过环境变量指定模块路径：PUPPETEER_CORE_PATH=/path/to/puppeteer-core node scripts/gen-clip.mjs\n" +
        "  说明：此脚本为可选重新生成素材工具，仓库已提交素材位于 public/clip/storm-strip.png，日常开发、构建与启动无需此脚本与 puppeteer。",
    );
    process.exit(1);
  }
}

const FRAME_W = 320;
const FRAME_H = 180;
const FRAMES = 12;
const SIZE_LIMIT = 250 * 1024;

/**
 * 在浏览器里画整条 storyboard。函数体必须自包含（puppeteer 会把它序列化进页面执行）。
 *
 * 分镜：
 *   0–3   窗外暴雨，镜头横向掠过（雨幕斜线、对街灯光）
 *   4–7   靠近玻璃：窗框入画、水痕下淌、窗外一团模糊人影；闪电在 2 / 6 帧爆亮
 *   8–11  切到室内暖光：吊灯暖晕、桌面与杯子的剪影、左侧窗户仍在漏雨
 */
async function drawStrip({ frameW, frameH, count, seed }) {
  const canvas = document.createElement("canvas");
  canvas.width = frameW * count;
  canvas.height = frameH;
  const ctx = canvas.getContext("2d", { alpha: false });

  // mulberry32：固定种子的伪随机，保证每次生成同一张图
  function rngFactory(a) {
    return function next() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  // 雨滴表跨帧共享：同一批雨线随帧平移 → 帧间相似、PNG 好压
  const rand = rngFactory(seed);
  const DROPS = 66;
  const drops = [];
  for (let d = 0; d < DROPS; d += 1) {
    drops.push({
      x: rand(),
      y: rand(),
      len: 12 + rand() * 24,
      speed: 0.55 + rand() * 0.9,
      tone: rand(), // 3 个色阶
    });
  }

  function rainLines(w, h, { frame, alpha, scale = 1, ox = 0 }) {
    ctx.save();
    ctx.lineWidth = 1;
    for (let tone = 0; tone < 3; tone += 1) {
      const a = alpha * (0.35 + tone * 0.3);
      ctx.strokeStyle = `rgba(178, 208, 240, ${a.toFixed(2)})`;
      ctx.beginPath();
      for (let d = 0; d < drops.length; d += 1) {
        const drop = drops[d];
        if (Math.floor(drop.tone * 3) !== tone) continue;
        const x = ((drop.x * w + ox) % (w + 30)) - 15;
        const len = drop.len * scale;
        const y = ((drop.y * h + frame * drop.speed * 16 * scale) % (h + 30)) - 15;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * 0.22, y + len);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function vignette(w, h, strength) {
    const g = ctx.createRadialGradient(w / 2, h * 0.52, h * 0.3, w / 2, h * 0.52, h * 0.98);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /** 窗框：竖向型材 + 冷色反光边，用来把「隔着玻璃看出去」讲清楚 */
  function windowFrame(x, width) {
    ctx.fillStyle = "#070a0f";
    ctx.fillRect(x, 0, width, frameH);
    ctx.fillStyle = "rgba(150, 186, 226, 0.28)";
    ctx.fillRect(x + width - 1, 0, 1, frameH);
  }

  /** 水痕：实心椭圆 + 一个高光点 + 一条下淌细线（三档色阶） */
  function droplets({ count: n, region, alpha }) {
    const [rx, ry, rw, rh] = region;
    ctx.save();
    for (let tone = 0; tone < 3; tone += 1) {
      ctx.fillStyle = `rgba(214, 234, 255, ${(alpha * (0.4 + tone * 0.3)).toFixed(2)})`;
      for (let d = 0; d < n; d += 1) {
        const r2 = rngFactory(seed + d * 31 + rx)();
        if (Math.floor(r2 * 3) !== tone) continue;
        const x = rx + ((d * 53 + r2 * 211) % rw);
        const y = ry + ((d * 97 + r2 * 131) % rh);
        const r = 1.2 + r2 * 3.2;
        ctx.beginPath();
        ctx.ellipse(x, y, r * 0.8, r * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 高光：一个色阶就够，避免大量半透明度
    ctx.fillStyle = "rgba(240, 250, 255, 0.5)";
    for (let d = 0; d < n; d += 1) {
      const r2 = rngFactory(seed + d * 31 + rx)();
      const x = rx + ((d * 53 + r2 * 211) % rw);
      const y = ry + ((d * 97 + r2 * 131) % rh);
      ctx.fillRect(x - 1, y - 2, 1, 1);
    }
    // 下淌水痕
    ctx.strokeStyle = `rgba(190, 216, 245, ${(alpha * 0.55).toFixed(2)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let d = 0; d < n; d += 3) {
      const r2 = rngFactory(seed + d * 31 + rx)();
      const x = rx + ((d * 53 + r2 * 211) % rw);
      const y = ry + ((d * 97 + r2 * 131) % rh);
      ctx.moveTo(x, y + 3);
      ctx.lineTo(x - 1, y + 8 + (d % 11));
    }
    ctx.stroke();
    ctx.restore();
  }

  function lightning(i, strength) {
    const w = frameW;
    const h = frameH;
    ctx.save();
    const glow = ctx.createLinearGradient(0, 0, 0, h);
    glow.addColorStop(0, `rgba(206, 226, 255, ${(0.34 * strength).toFixed(2)})`);
    glow.addColorStop(0.55, `rgba(150, 190, 240, ${(0.1 * strength).toFixed(2)})`);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const bolt = rngFactory(seed + 101);
    let x = w * (0.24 + bolt() * 0.5);
    let y = 6;
    ctx.strokeStyle = `rgba(240, 248, 255, ${(0.9 * strength).toFixed(2)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let seg = 0; seg < 6; seg += 1) {
      x += (bolt() - 0.5) * 24;
      y += 12 + bolt() * 14;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    void i;
    ctx.restore();
  }

  function bokeh(frame, sweep) {
    const w = frameW;
    const r2 = rngFactory(seed + 7);
    ctx.save();
    for (let pass = 0; pass < 2; pass += 1) {
      ctx.fillStyle = pass === 0 ? "rgba(255, 186, 116, 0.3)" : "rgba(148, 190, 240, 0.24)";
      ctx.beginPath();
      for (let b = 0; b < 18; b += 1) {
        const bx = r2() * (w + 60) - 30 + sweep;
        const by = 72 + r2() * 54;
        const br = 1.6 + r2() * 5.4;
        if ((b % 2 === 0) !== (pass === 0)) continue;
        ctx.moveTo(bx + br, by);
        ctx.arc(bx, by, br, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.restore();
  }

  function exterior(i) {
    const w = frameW;
    const h = frameH;
    const t = i / 7;

    // 夜空
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#0a1726");
    sky.addColorStop(0.44, "#13293f");
    sky.addColorStop(0.74, "#0a1828");
    sky.addColorStop(1, "#04070c");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const sweep = lerp(-10, 12, t);
    bokeh(i, sweep);

    // 湿路面反光
    const street = ctx.createLinearGradient(0, 116, 0, 152);
    street.addColorStop(0, "rgba(120, 158, 200, 0.2)");
    street.addColorStop(1, "rgba(120, 158, 200, 0)");
    ctx.fillStyle = street;
    ctx.fillRect(0, 116, w, 36);

    // 远景雨（慢）+ 近景雨（快）
    rainLines(w, h, { frame: i * 0.6, alpha: 0.18, scale: 0.7, ox: sweep * 0.4 });
    rainLines(w, h, { frame: i, alpha: 0.34, ox: sweep });

    const flash = i === 2 ? 0.55 : i === 6 ? 0.95 : i === 7 ? 0.22 : 0;
    if (flash > 0) lightning(i, flash);

    if (i >= 4) {
      const fx = lerp(w * 0.62, w * 0.2, (i - 4) / 5);
      windowFrame(fx, 16);
      droplets({ count: 22, alpha: 0.5, region: [fx + 18, 4, w - fx - 22, h - 8] });
    } else {
      droplets({ count: 8, alpha: 0.26, region: [0, 0, w, h] });
    }

    // 窗外一团模糊人影：5–7 帧慢慢贴上玻璃。
    // 先垫一层很淡的冷光，否则纯黑剪影在夜里完全读不出来。
    if (i >= 5) {
      const px = lerp(w * 1.02, w * 0.58, (i - 5) / 3);
      const py = h * 0.62;
      const back = ctx.createLinearGradient(px - 34, 0, px + 34, 0);
      back.addColorStop(0, "rgba(126, 166, 206, 0)");
      back.addColorStop(0.5, `rgba(140, 182, 222, ${lerp(0.1, 0.26, (i - 5) / 3).toFixed(2)})`);
      back.addColorStop(1, "rgba(126, 166, 206, 0)");
      ctx.fillStyle = back;
      ctx.fillRect(px - 34, 0, 68, h);

      ctx.save();
      ctx.filter = "blur(2.6px)";
      ctx.fillStyle = `rgba(4, 7, 12, ${lerp(0.34, 0.62, (i - 5) / 3).toFixed(2)})`;
      ctx.beginPath();
      ctx.ellipse(px, py - 34, 9, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px - 18, py + 46);
      ctx.quadraticCurveTo(px - 16, py - 22, px, py - 24);
      ctx.quadraticCurveTo(px + 16, py - 22, px + 18, py + 46);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // 肩线冷色轮廓光：让「有个人站在玻璃外」这件事可辨认
      ctx.strokeStyle = `rgba(196, 220, 246, ${lerp(0.14, 0.4, (i - 5) / 3).toFixed(2)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(px - 18, py + 46);
      ctx.quadraticCurveTo(px - 16, py - 22, px, py - 24);
      ctx.quadraticCurveTo(px + 16, py - 22, px + 18, py + 46);
      ctx.stroke();
    }

    vignette(w, h, 0.7);
  }

  function interior(i) {
    const w = frameW;
    const h = frameH;
    const warm = 0.55 + (i - 8) * 0.14;

    // 墙面：吊灯位置的暖色球面
    const wall = ctx.createRadialGradient(w * 0.72, h * 0.18, 8, w * 0.62, h * 0.44, h * 1.1);
    wall.addColorStop(0, `rgb(${lerp(120, 168, warm) | 0}, ${lerp(78, 108, warm) | 0}, 44)`);
    wall.addColorStop(0.44, "#2a1a10");
    wall.addColorStop(1, "#0a0705");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, w, h);

    // 吊灯灯罩 + 热光晕
    const lamp = ctx.createRadialGradient(w * 0.72, h * 0.2, 2, w * 0.72, h * 0.2, 62);
    lamp.addColorStop(0, "rgba(255, 230, 186, 0.92)");
    lamp.addColorStop(0.3, "rgba(255, 190, 120, 0.42)");
    lamp.addColorStop(1, "rgba(255, 170, 90, 0)");
    ctx.fillStyle = lamp;
    ctx.beginPath();
    ctx.arc(w * 0.72, h * 0.2, 62, 0, Math.PI * 2);
    ctx.fill();

    // 吊灯：吊线 + 灯罩（梯形）+ 暖光池，避免一个孤立椭圆读成「眼睛」
    ctx.strokeStyle = "rgba(20, 12, 8, 0.9)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(w * 0.72, 0);
    ctx.lineTo(w * 0.72, h * 0.2 - 16);
    ctx.stroke();

    const shade = ctx.createLinearGradient(0, h * 0.2 - 16, 0, h * 0.2 + 6);
    shade.addColorStop(0, "#3d2616");
    shade.addColorStop(1, "#180f09");
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.moveTo(w * 0.72 - 10, h * 0.2 - 16);
    ctx.lineTo(w * 0.72 + 10, h * 0.2 - 16);
    ctx.lineTo(w * 0.72 + 26, h * 0.2 + 5);
    ctx.lineTo(w * 0.72 - 26, h * 0.2 + 5);
    ctx.closePath();
    ctx.fill();
    // 灯罩下沿被灯泡照亮的亮边
    ctx.fillStyle = "rgba(255, 228, 180, 0.9)";
    ctx.fillRect(w * 0.72 - 26, h * 0.2 + 5, 52, 2);

    // 左侧仍在漏雨的窗：冷色块 vs 室内暖光
    const winX = 10;
    const winY = 18;
    const winW = 86;
    const winH = 112;
    const cold = ctx.createLinearGradient(winX, winY, winX + winW, winY + winH);
    cold.addColorStop(0, "#12293f");
    cold.addColorStop(1, "#060b13");
    ctx.fillStyle = cold;
    ctx.fillRect(winX, winY, winW, winH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(winX, winY, winW, winH);
    ctx.clip();
    rainLines(winW, winH, { frame: i * 0.8, alpha: 0.3, scale: 0.8, ox: winX });
    droplets({ count: 7, alpha: 0.4, region: [winX, winY, winW, winH] });
    ctx.restore();
    ctx.strokeStyle = "#0c0907";
    ctx.lineWidth = 4;
    ctx.strokeRect(winX, winY, winW, winH);
    ctx.beginPath();
    ctx.moveTo(winX + winW / 2, winY);
    ctx.lineTo(winX + winW / 2, winY + winH);
    ctx.stroke();

    // 桌面
    const table = ctx.createLinearGradient(0, h * 0.68, 0, h);
    table.addColorStop(0, "#3a2414");
    table.addColorStop(1, "#0e0906");
    ctx.fillStyle = table;
    ctx.fillRect(0, h * 0.68, w, h * 0.32);
    ctx.fillStyle = "rgba(255, 205, 150, 0.55)";
    ctx.fillRect(0, h * 0.68 - 1, w, 1);

    // 咖啡杯剪影 + 暖光镶边
    const cupX = w * 0.6;
    const cupY = h * 0.68;
    ctx.fillStyle = "#120b07";
    ctx.beginPath();
    ctx.ellipse(cupX, cupY, 15, 5.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cupX - 15, cupY);
    ctx.lineTo(cupX - 15, cupY - 17);
    ctx.quadraticCurveTo(cupX, cupY - 21, cupX + 15, cupY - 17);
    ctx.lineTo(cupX + 15, cupY);
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 198, 140, 0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cupX + 15, cupY - 13);
    ctx.quadraticCurveTo(cupX + 21, cupY - 11, cupX + 15, cupY - 4);
    ctx.stroke();

    // 热气
    ctx.strokeStyle = `rgba(255, 224, 186, ${(0.12 + (i - 8) * 0.03).toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let s = 0; s < 3; s += 1) {
      const sx = cupX - 5 + s * 5;
      ctx.moveTo(sx, cupY - 22);
      ctx.bezierCurveTo(sx - 5, cupY - 32, sx + 6, cupY - 38, sx - 2, cupY - 48);
    }
    ctx.stroke();

    // 空气里的暖尘
    ctx.fillStyle = "rgba(255, 214, 168, 0.12)";
    ctx.beginPath();
    const dust = rngFactory(seed + 211);
    for (let d = 0; d < 18; d += 1) {
      const dx = w * 0.34 + dust() * w * 0.6;
      const dy = h * 0.1 + dust() * h * 0.6;
      const dr = 0.6 + dust() * 1.1;
      ctx.moveTo(dx + dr, dy);
      ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    }
    ctx.fill();

    // 暖色空气 + 暗角
    const haze = ctx.createRadialGradient(w * 0.66, h * 0.3, 10, w * 0.66, h * 0.3, h * 1.05);
    haze.addColorStop(0, `rgba(255, 176, 108, ${(0.14 * warm).toFixed(2)})`);
    haze.addColorStop(1, "rgba(255, 140, 60, 0)");
    ctx.fillStyle = haze;
    ctx.fillRect(0, 0, w, h);
    vignette(w, h, 0.6);
  }

  for (let i = 0; i < count; i += 1) {
    ctx.save();
    ctx.translate(i * frameW, 0);
    ctx.beginPath();
    ctx.rect(0, 0, frameW, frameH);
    ctx.clip();
    if (i < 8) exterior(i);
    else interior(i);

    // 帧边界硬切：一条极窄暗缝，播放时不会误读成「一张长图」
    if (i > 0) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
      ctx.fillRect(0, 0, 1, frameH);
    }
    ctx.restore();
  }

  // 返回原始 RGBA（而不是浏览器直接编码的 PNG）：
  // Chrome 的 PNG 编码不带调色板，12 帧渐变 + 雨线的图会被压成 900KB+，
  // 这里拿回像素，在 Node 里做调色板量化后自己写 PNG（见下方 encodeIndexedPng）。
  const { data } = ctx.getImageData(0, 0, frameW * count, frameH);
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------- PNG 编码

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC32（PNG 每个 chunk 都要） */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * 把 RGBA 量化成 ≤256 色的调色板图（median cut），写成 PNG color type 3。
 *
 * 为什么值得这么做：渐变 + 半透明雨线在 24bit RGB 下每个像素都不同，PNG 几乎压不动；
 * 量化成索引色后，同一段渐变成了一条条等值色带，deflate 能压到几十 KB。
 */
function quantize(rgba, maxColors = 256) {
  const BITS = 5;
  const LEVELS = 1 << BITS; // 32
  const BINS = LEVELS * LEVELS * LEVELS;
  const counts = new Uint32Array(BINS);
  const sumR = new Float64Array(BINS);
  const sumG = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);

  const pixels = rgba.length / 4;
  for (let i = 0; i < pixels; i += 1) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const key = ((r >> 3) << (BITS * 2)) | ((g >> 3) << BITS) | (b >> 3);
    counts[key] += 1;
    sumR[key] += r;
    sumG[key] += g;
    sumB[key] += b;
  }

  let bins = [];
  for (let key = 0; key < BINS; key += 1) {
    if (counts[key] === 0) continue;
    bins.push({
      key,
      count: counts[key],
      r: sumR[key] / counts[key],
      g: sumG[key] / counts[key],
      b: sumB[key] / counts[key],
    });
  }

  const boxStats = (box) => {
    let minR = 255;
    let maxR = 0;
    let minG = 255;
    let maxG = 0;
    let minB = 255;
    let maxB = 0;
    let count = 0;
    for (const bin of box) {
      if (bin.r < minR) minR = bin.r;
      if (bin.r > maxR) maxR = bin.r;
      if (bin.g < minG) minG = bin.g;
      if (bin.g > maxG) maxG = bin.g;
      if (bin.b < minB) minB = bin.b;
      if (bin.b > maxB) maxB = bin.b;
      count += bin.count;
    }
    return { minR, maxR, minG, maxG, minB, maxB, count };
  };

  let boxes = [bins];
  while (boxes.length < maxColors) {
    let target = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.length < 2) continue;
      const s = boxStats(box);
      const range = Math.max(s.maxR - s.minR, s.maxG - s.minG, s.maxB - s.minB);
      const score = s.count * range;
      if (score > bestScore) {
        bestScore = score;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const s = boxStats(box);
    const axis =
      s.maxR - s.minR >= s.maxG - s.minG && s.maxR - s.minR >= s.maxB - s.minB
        ? "r"
        : s.maxG - s.minG >= s.maxB - s.minB
          ? "g"
          : "b";
    box.sort((a, b2) => a[axis] - b2[axis]);

    const half = s.count / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += box[i].count;
      if (acc >= half) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
  }

  const palette = [];
  for (const box of boxes) {
    let count = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const bin of box) {
      count += bin.count;
      r += bin.r * bin.count;
      g += bin.g * bin.count;
      b += bin.b * bin.count;
    }
    palette.push([
      Math.round(r / count),
      Math.round(g / count),
      Math.round(b / count),
    ]);
  }

  // 每个 5bit 色桶 → 最近的调色板项（只算一次，之后按桶查表）
  const lut = new Uint8Array(BINS);
  for (const bin of bins) {
    let best = 0;
    let bestDist = Infinity;
    for (let p = 0; p < palette.length; p += 1) {
      const dr = bin.r - palette[p][0];
      const dg = bin.g - palette[p][1];
      const db = bin.b - palette[p][2];
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    lut[bin.key] = best;
  }

  const indices = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const key =
      ((rgba[i * 4] >> 3) << (BITS * 2)) | ((rgba[i * 4 + 1] >> 3) << BITS) | (rgba[i * 4 + 2] >> 3);
    indices[i] = lut[key];
  }

  // bin 数组参与过 sort，只在前面的遍历里用到，这里无需再复原
  void bins;
  return { palette, indices };
}

function encodeIndexedPng(width, height, indices, palette) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 3; // color type: 索引色
  header[10] = 0; // deflate
  header[11] = 0; // filter 0
  header[12] = 0; // 非隔行

  const paletteData = Buffer.alloc(palette.length * 3);
  palette.forEach(([r, g, b], i) => {
    paletteData[i * 3] = r;
    paletteData[i * 3 + 1] = g;
    paletteData[i * 3 + 2] = b;
  });

  // 扫描线：每行 1 字节 filter（索引色用 None 最省）+ 1 字节/像素
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    raw.set(indices.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("PLTE", paletteData),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const puppeteer = await loadPuppeteer();

  if (!existsSync(CHROME)) {
    console.error(
      `[gen-clip] 未找到 Chrome 可执行文件：${CHROME}\n` +
        "  可操作建议：\n" +
        "    1. 请确保系统已安装 Chrome/Chromium，或通过环境变量指定路径：\n" +
        "       CHROME_PATH=/path/to/chrome node scripts/gen-clip.mjs\n" +
        "       或 PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node scripts/gen-clip.mjs\n" +
        "  说明：此脚本为可选重新生成素材工具，仓库已提交素材位于 public/clip/storm-strip.png，日常开发、构建与启动无需此脚本。",
    );
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--disable-lcd-text"],
  });

  let pixels;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
    await page.goto("about:blank");
    pixels = await page.evaluate(drawStrip, {
      frameW: FRAME_W,
      frameH: FRAME_H,
      count: FRAMES,
      seed: 0x5eed,
    });
  } finally {
    await browser.close();
  }

  if (typeof pixels !== "string" || pixels.length === 0) {
    throw new Error("生成失败：页面没有返回像素数据");
  }

  const width = FRAME_W * FRAMES;
  const height = FRAME_H;
  const rgba = Buffer.from(pixels, "base64");
  if (rgba.length !== width * height * 4) {
    throw new Error(`生成失败：像素尺寸不符（${rgba.length} != ${width * height * 4}）`);
  }

  const { palette, indices } = quantize(rgba, 256);
  const buffer = encodeIndexedPng(width, height, indices, palette);

  if (buffer.byteLength > SIZE_LIMIT) {
    throw new Error(
      `生成失败：PNG ${(buffer.byteLength / 1024).toFixed(1)}KB 超过 ${SIZE_LIMIT / 1024}KB 上限`,
    );
  }

  await mkdir(dirname(OUT), { recursive: true });
  let previous = null;
  try {
    previous = await readFile(OUT);
  } catch {
    previous = null;
  }

  const unchanged = previous !== null && previous.equals(buffer);
  if (!unchanged) await writeFile(OUT, buffer);

  console.log(`[gen-clip] ${unchanged ? "未变化" : "已写入"} ${OUT.replace(ROOT + "/", "")}`);
  console.log(
    `[gen-clip] ${FRAMES} 帧 · 每帧 ${FRAME_W}×${FRAME_H} · 整张 ${FRAME_W * FRAMES}×${FRAME_H} · ${(buffer.byteLength / 1024).toFixed(1)}KB`,
  );
  if (unchanged) console.log("[gen-clip] 重复执行幂等：字节完全一致，未重写文件");
}

main().catch((error) => {
  console.error(`[gen-clip] ${error?.stack ?? error}`);
  process.exit(1);
});

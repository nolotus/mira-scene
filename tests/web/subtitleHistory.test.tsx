import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StageSubtitles, SubtitleLines } from "../../src/web/stage/StageSubtitles";
import { advanceSubtitleHistory, type SubtitleHistory } from "../../src/web/stage/subtitleHistory";
import { createInitialScene } from "../../src/web/state/session";

const initial = (): SubtitleHistory => ({ scene: "cafe_night", observed: "", current: "", previous: "", candidate: "" });
const next = (h: SubtitleHistory, text: string, status: "speaking" | "thinking" | "listening" | "idle" = "speaking") =>
  advanceSubtitleHistory(h, "cafe_night", text, status);

describe("字幕轻历史", () => {
  test("首句无残影，下一句仅保留前一句且排在主字幕上方", () => {
    const first = next(initial(), "雨停了。");
    expect(first.previous).toBe("");
    const second = next(first, "我们走吧。");
    const html = renderToStaticMarkup(<SubtitleLines {...second} />);
    expect(html).toContain('class="sub-history" aria-hidden="true">雨停了。</p>');
    expect(html).toContain('class="sub">我们走吧。</p>');
    expect(html.indexOf("雨停了。")).toBeLessThan(html.indexOf("我们走吧。"));
    expect(next(second, "去海边。").previous).toBe("我们走吧。");
  });

  test("流式 token 增长不产生伪历史，也不覆盖前一句", () => {
    let h = next(initial(), "雨停了。");
    h = next(h, "我们");
    h = next(h, "我们走吧。");
    expect(h.previous).toBe("雨停了。");
    expect(next(h, "我们走吧。")).toBe(h);
    expect(next(next(initial(), "你"), "你好。").previous).toBe("");
  });

  test("正常等待下一轮保留候选；打断或显式清空则丢弃候选", () => {
    const h = next(initial(), "雨停了。");
    expect(next(next(h, "", "thinking"), "走吧。").previous).toBe("雨停了。");
    for (const status of ["listening", "idle"] as const) {
      const cleared = next(h, "", status);
      expect(cleared.current).toBe("雨停了。"); // 保留 DOM 供 340ms 淡出。
      expect(cleared.observed).toBe("");
      expect(next(cleared, "走吧。").previous).toBe("");
    }
  });

  test("切景与重复句不会出现旧场景残影或双份相同台词", () => {
    const h = next(initial(), "雨停了。");
    expect(advanceSubtitleHistory(h, "street_night", "走吧。", "speaking").previous).toBe("");
    expect(next(next(h, "", "thinking"), "雨停了。").previous).toBe("");
  });

  test("字幕容器渲染当前句与读屏区域；空态隐藏，思考态提示保留", () => {
    const scene = createInitialScene();
    const html = renderToStaticMarkup(<StageSubtitles state={{ ...scene, subtitle: "雨停了。" }} />);
    expect(html).toContain('data-history="false"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sub">雨停了。</p>');
    const empty = renderToStaticMarkup(<StageSubtitles state={{ ...scene, subtitle: "" }} />);
    expect(empty).toContain('data-empty="true"');
    expect(empty).not.toContain('class="sub"');
    const thinking = renderToStaticMarkup(<StageSubtitles state={{ ...scene, subtitle: "", characterStatus: "thinking" }} />);
    expect(thinking).toContain('data-empty="thinking"');
    expect(thinking).toContain("Mira 正在思考…");
  });
});

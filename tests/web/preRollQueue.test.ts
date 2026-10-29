/**
 * 预滚队列的溢出策略。钉住的是一条线上踩过的硬约束：
 * **首块（带 EBML 容器头）永不丢弃** —— 丢了之后服务端 ffmpeg 只能拿到无头 cluster，
 * 报 `EBML header parsing failed`、pcm 恒为 0、整句识别不出字。
 */
import { describe, expect, test } from "bun:test";
import { pushBoundedPreRoll } from "../../src/web/voice/preRollQueue.ts";

describe("预滚队列：首块永不丢弃", () => {
  test("未溢出时按序排队，不丢", () => {
    const q: string[] = [];
    expect(pushBoundedPreRoll(q, "a", 3).dropped).toBe(false);
    pushBoundedPreRoll(q, "b", 3);
    pushBoundedPreRoll(q, "c", 3);
    expect(q).toEqual(["a", "b", "c"]);
  });

  test("溢出时丢第二旧的，首块仍在第一位", () => {
    const q: string[] = ["header", "old", "newer"];
    const result = pushBoundedPreRoll(q, "newest", 3);
    expect(result.dropped).toBe(true);
    expect(q).toEqual(["header", "newer", "newest"]);
  });

  test("连续溢出多次，首块依然是第一块（长度恒等于上限）", () => {
    const q: string[] = ["header"];
    for (let i = 0; i < 20; i += 1) pushBoundedPreRoll(q, `frame-${i}`, 4);
    expect(q[0]).toBe("header");
    expect(q).toHaveLength(4);
    expect(q.at(-1)).toBe("frame-19");
  });

  test("容量为 1 时退化成「只留最新」并报告丢弃", () => {
    const q: string[] = ["header"];
    const result = pushBoundedPreRoll(q, "next", 1);
    expect(result.dropped).toBe(true);
    expect(q).toEqual(["next"]);
  });
});

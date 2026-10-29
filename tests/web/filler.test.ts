/**
 * 垫音播放器：三条纪律的机械验证（同音色素材由 /api/tts 生成，这里只测播放语义）。
 */

import { describe, expect, test } from "bun:test";
import { FILLER_SRC, createFillerPlayer, type FillerAudio } from "../../src/web/voice/filler";

function fakeAudio() {
  const calls = { play: 0, pause: 0, rewinds: 0 };
  let currentTime = 5;
  const node: FillerAudio = {
    get currentTime() {
      return currentTime;
    },
    set currentTime(v: number) {
      if (v === 0) calls.rewinds += 1;
      currentTime = v;
    },
    play() {
      calls.play += 1;
      return Promise.resolve();
    },
    pause() {
      calls.pause += 1;
    },
  };
  return { node, calls };
}

describe("垫音播放器", () => {
  test("play 会归零再播；重复 play 不会叠第二遍", () => {
    const { node, calls } = fakeAudio();
    const filler = createFillerPlayer({ createAudio: () => node });
    filler.play();
    filler.play();
    filler.play();
    expect(calls.play).toBe(1);
    expect(calls.rewinds).toBe(1);
    expect(filler.playing).toBe(true);
  });

  test("stop 立刻暂停并归零；停止后再 play 能重新播", () => {
    const { node, calls } = fakeAudio();
    const filler = createFillerPlayer({ createAudio: () => node });
    filler.play();
    filler.stop();
    expect(calls.pause).toBe(1);
    expect(filler.playing).toBe(false);
    filler.play();
    expect(calls.play).toBe(2);
  });

  test("未播放时 stop 是空操作（不会无端 pause）", () => {
    const { node, calls } = fakeAudio();
    const filler = createFillerPlayer({ createAudio: () => node });
    filler.stop();
    expect(calls.pause).toBe(0);
  });

  test("自动播放被拦（play 返回 rejected）不抛错，且状态回到未播放", async () => {
    const node: FillerAudio = {
      currentTime: 0,
      play: () => Promise.reject(new Error("NotAllowedError")),
      pause: () => {},
    };
    const filler = createFillerPlayer({ createAudio: () => node });
    expect(() => filler.play()).not.toThrow();
    await Bun.sleep(0);
    expect(filler.playing).toBe(false);
  });

  test("没有 Audio 环境（工厂抛错）也不崩，只是没声音", () => {
    const filler = createFillerPlayer({
      createAudio: () => {
        throw new Error("Audio is not defined");
      },
    });
    expect(() => filler.play()).not.toThrow();
    expect(filler.playing).toBe(false);
    expect(() => filler.stop()).not.toThrow();
  });

  test("stop 后立刻再 play：上一代 rejected 的 catch 不能把新一代的 playing 打回 false", async () => {
    let attempts = 0;
    let rejectFirst: ((e: Error) => void) | null = null;
    const node: FillerAudio = {
      currentTime: 0,
      play: () => {
        attempts += 1;
        if (attempts === 1) return new Promise<void>((_, reject) => (rejectFirst = reject));
        return Promise.resolve();
      },
      pause: () => {},
    };
    const filler = createFillerPlayer({ createAudio: () => node });
    filler.play(); // 第一代：play promise 挂起
    filler.stop(); // 打断第一代
    filler.play(); // 第二代：应该真正开始
    rejectFirst!(new Error("NotAllowedError")); // 第一代的 promise 此刻才 settle
    await Bun.sleep(0);
    // 若 catch 没有代次守卫，这里会被错误地置成 false，随后 stop() 早退 → 垫音压在 TTS 下面
    expect(filler.playing).toBe(true);
    filler.stop();
    expect(filler.playing).toBe(false);
  });

  test("素材路径指向 public 下的静态文件（音色与 App 一致，非外挂 TTS）", () => {
    expect(FILLER_SRC).toBe("/voice/filler-zh.mp3");
  });
});

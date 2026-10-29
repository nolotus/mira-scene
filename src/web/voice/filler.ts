/**
 * 垫音（filler）：按下发送的那一刻先出一声「嗯」，把「等模型首字」的空白填掉。
 *
 * 为什么需要它：真模型首字实测 1005–1866ms（中位数约 1.5s），加上 TTS 首包 0.29s，
 * 用户从说完到听见回应要等 2 秒以上。人对「沉默」的容忍比「慢」低得多 —— 一声
 * 极短的应答音能把主观等待从秒级压到「立刻有反应」，而真实内容随后就到。
 *
 * 三条纪律：
 *  1. **用同一个音色**：素材由本应用自己的 `/api/tts`（Edge `zh-CN-XiaoxiaoNeural`）
 *     生成后裁掉首尾静音，所以不会出现「另一个人嘴里发出的嗯」。
 *  2. **只播一次且不排队**：每次 play() 先把 currentTime 归零再播；重复调用直接忽略，
 *     绝不叠加两遍。真实语音一到（首个 `text.delta` / `audio.chunk`）必须立刻 stop()。
 *  3. **失败即静默**：自动播放策略、解码失败、无 `Audio` 环境（测试/SSR）都只让垫音消失，
 *     绝不抛错、绝不挡住正常 TTS。
 */

/** 垫音素材：`public/voice/filler-zh.mp3`（约 0.6s，已裁掉首尾静音） */
export const FILLER_SRC = "/voice/filler-zh.mp3";

export interface FillerPlayer {
  /** 播一次垫音；已在播则忽略 */
  play(): void;
  /** 立刻停（真实语音开始 / 打断 / 一轮结束） */
  stop(): void;
  /** 当前是否在播（测试与诊断用） */
  readonly playing: boolean;
}

/** 只依赖 Audio 里用到的那几个成员，便于测试注入假实现 */
export interface FillerAudio {
  currentTime: number;
  play(): Promise<void> | void;
  pause(): void;
  preload?: string;
  src?: string;
}

export interface FillerOptions {
  src?: string;
  /** 音频工厂（默认 `new Audio(src)`；测试注入假对象） */
  createAudio?: (src: string) => FillerAudio;
  /** `pause()` 之后是否把播放位置归零（默认 true；测试可关） */
  rewindOnStop?: boolean;
}

export function createFillerPlayer(options: FillerOptions = {}): FillerPlayer {
  const src = options.src ?? FILLER_SRC;
  const rewindOnStop = options.rewindOnStop ?? true;
  const createAudio =
    options.createAudio ??
    ((url: string) => {
      const audio = new Audio(url);
      audio.preload = "auto";
      return audio as unknown as FillerAudio;
    });

  let audio: FillerAudio | null = null;
  let playing = false;
  /**
   * 代次：每次 play/stop 都 +1。旧 play() 的 rejected 回调只允许作废**它自己那一代**，
   * 否则「stop 后立刻再 play」时，上一代 promise 的 catch 会把新一轮的 playing 置 false，
   * 之后 stop() 因早退而空转，那声「嗯」就会一直压在 TTS 下面。
   */
  let generation = 0;

  function ensure(): FillerAudio | null {
    if (audio) return audio;
    try {
      audio = createAudio(src);
    } catch {
      audio = null;
    }
    return audio;
  }

  return {
    get playing() {
      return playing;
    },

    play() {
      if (playing) return;
      const node = ensure();
      if (!node) return;
      playing = true;
      const mine = (generation += 1);
      try {
        node.currentTime = 0;
        const result = node.play();
        // 自动播放被拦是正常情况（用户还没交互过），静默吞掉，绝不让它变成未处理的 rejection
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch(() => {
            if (mine !== generation) return;
            playing = false;
          });
        }
      } catch {
        if (mine === generation) playing = false;
      }
    },

    stop() {
      if (!playing) return;
      generation += 1;
      playing = false;
      const node = audio;
      if (!node) return;
      try {
        node.pause();
        if (rewindOnStop) node.currentTime = 0;
      } catch {
        /* 停不下来也不能抛：调用点在 SSE 事件处理里 */
      }
    },
  };
}

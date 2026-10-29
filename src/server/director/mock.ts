/**
 * MockDirector —— 零密钥可跑的脚本导演。
 *
 * 三条设计原则（对应题目里最容易被写歪的地方）：
 *
 * 1. **由用户输入驱动，不是由定时器驱动**。
 *    选哪一段 beat 只取决于「用户这句话说了什么」+「之前说过哪些 beat」+「这是第几轮」，
 *    没有随机数、没有 setInterval。同一个输入序列必然得到同一段演出，因此可回放、可测试。
 *
 * 2. **视觉事件挂在对话上**。
 *    提到「雨」→ 闪电 + 发抖 + 雨势加大；问「等谁」→ 侧身避开视线 + 望向窗外；
 *    提到「打烊/几点」→ 场景切到 cafe_closing + 灯光变暗。
 *
 * 3. **节奏像真模型**。
 *    台词按 2–6 字分片，片间 40–70ms；台词与 Directive 交织产出，画面跟着话走。
 *    signal 中止后立刻停止产出（每个 await 之后都会检查）。
 */
import type {
  AnchoredCue,
  Directive,
  Director,
  DirectorInput,
  SessionEvent,
  SpokenPlan,
} from "../../shared/protocol.ts";
import { CueScheduler, charCount } from "./cues.ts";
import { chunkText, delayFor, sleep } from "./stream-utils.ts";

/** 一步演出：要么说一句话（会被切成小片），要么丢一条视觉指令 */
type MockStep = { kind: "say"; text: string } | { kind: "directive"; directive: Directive };

interface MockBeat {
  /** beat id，同时充当 SceneState.lastBeat 的语义标识 */
  id: string;
  /** 命中用户文本的正则；不填的 beat 只能作为兜底 */
  match?: RegExp;
  /** 需要对话已进行到第几轮（用户消息条数），用于把揭底留到后面 */
  minPhase?: number;
  /** 最多允许在第几轮命中：开场白只能在第 0 轮，否则未命中的第 N 轮会突然"初次见面" */
  maxPhase?: number;
  /** 越大越优先 */
  priority: number;
  /** 整场对话只演一次（防止闪电放三次） */
  once?: boolean;
  /** 旧写法：say 步与指令步按顺序交织（指令立即执行，没有 atChar） */
  steps: MockStep[];
  /**
   * 时序写法：指令锚定到「整段台词的第几个字符」（= 该 beat 所有 say 步拼起来的字符位置）。
   * 有 cues 的 beat 走 CueScheduler：说到 atChar 那一刻才把指令投递出去，
   * 于是「闪电」不会抢在「刚才那一下——」前面劈下来。
   */
  cues?: AnchoredCue[];
}

export interface MockDirectorOptions {
  /** 台词节奏缩放：1 = 真实节奏（默认），0 = 不停顿（测试用） */
  delayScale?: number;
}

const say = (text: string): MockStep => ({ kind: "say", text });
const md = (directive: Directive): MockStep => ({ kind: "directive", directive });

/** 情绪/姿势等常用指令的简写，避免 beat 表被字面量淹没 */
const emotion = (value: "neutral" | "curious" | "warm" | "amused" | "anxious" | "sad" | "surprised"): MockStep =>
  md({ kind: "emotion", emotion: value });
const pose = (value: "stand" | "lean_in" | "turn_away" | "hold_cup" | "glance_window"): MockStep =>
  md({ kind: "pose", pose: value });
const action = (value: "blink" | "hair_tuck" | "sigh" | "shiver" | "look_back" | "nod" | "startle"): MockStep =>
  md({ kind: "action", action: value });
const camera = (value: "push_in" | "pull_back" | "whip_pan" | "shake" | "settle"): MockStep =>
  md({ kind: "camera", move: value });
const vfx = (value: "lightning" | "rain_heavy" | "rain_light" | "warm_glow" | "lights_dim" | "steam_wisp"): MockStep =>
  md({ kind: "vfx", vfx: value });
const scene = (value: "cafe_night" | "cafe_closing" | "window_rain"): MockStep =>
  md({ kind: "scene", scene: value });

/**
 * 主要 beat 表。priority 决定「这句话同时命中多条时听谁的」。
 * 剧情弧线：寒暄 → 雨夜氛围 → 试探「等谁」→ 回避与松动 → 打烊/灯暗 → 摊牌或道别。
 */
export const MOCK_BEATS: readonly MockBeat[] = [
  // —— 由对话内容触发的显著视觉事件：提到雨 ——
  {
    id: "rain_lightning",
    match: /雨|雷|闪电|湿|下大|storm|rain/i,
    priority: 90,
    once: true,
    // 时序写法示范 ①：闪电在「刚才那一下——」说完之后（atChar=7），
    // 雨势与镜头抖动在「雨又大了。」之后（atChar=18）—— 画面跟着话走，不是抢在话前面。
    steps: [
      say("刚才那一下——"),
      say("你看见了吗。"),
      say("雨又大了。"),
      say("这种天气，他应该会更迟吧。"),
    ],
    cues: [
      { atChar: 0, directive: { kind: "action", action: "shiver" } },
      { atChar: 7, directive: { kind: "vfx", vfx: "lightning" } },
      { atChar: 18, directive: { kind: "vfx", vfx: "rain_heavy" } },
      { atChar: 18, directive: { kind: "camera", move: "shake" } },
      { atChar: 31, directive: { kind: "pose", pose: "glance_window" } },
    ],
  },
  // —— 场景切换：由「用户明确提到地点/时间」触发（2026-10-29 加）——
  // 设计口径：只在用户点了地名或点了时间才切，且每条 once ——画面不该自己乱逛。
  {
    id: "scene_closing",
    // 「几点 / 太晚 / 关门 / 闭店 / 下班 / 营业」原本在独立的 closing_keyword(76) beat 里；
    // 那条被本条(84)完全遮蔽，已合并过来，否则既死分支又丢能力（审查 2026-10-29）
    match: /打烊|要关门|关门|收摊|快关门|几点|太晚|闭店|下班|营业/,
    priority: 84,
    once: true,
    steps: [
      say("灯确实该关了。"),
      say("老板十分钟前就把牌子翻过去了。"),
      say("他说可以让我坐到雨停。"),
      say("这里的人都很好。"),
      say("好到我不敢问太多。"),
      say("再给我一分钟。"),
    ],
    cues: [
      { atChar: 0, directive: { kind: "scene", scene: "cafe_closing" } },
      { atChar: 0, directive: { kind: "vfx", vfx: "lights_dim" } },
      { atChar: 0, directive: { kind: "emotion", emotion: "sad" } },
    ],
  },
  {
    id: "scene_window",
    match: /看看窗外|望向窗外|窗外|玻璃上|街对面/,
    priority: 82,
    once: true,
    steps: [
      say("嗯。"),
      say("玻璃上全是水。"),
      say("外面什么都看不清。"),
    ],
    cues: [
      { atChar: 0, directive: { kind: "scene", scene: "window_rain" } },
      { atChar: 0, directive: { kind: "pose", pose: "glance_window" } },
    ],
  },
  {
    id: "scene_back_inside",
    match: /回店里|回咖啡馆|回屋里|还是店里|进来坐/,
    priority: 80,
    once: true,
    steps: [
      say("还是店里暖和。"),
      say("坐吧。"),
    ],
    cues: [{ atChar: 0, directive: { kind: "scene", scene: "cafe_night" } }],
  },

  // —— 用户替她担心：最容易被戳到的点 ——
  {
    id: "danger",
    match: /报警|出事|危险|担心|不会来|别等了|放鸽子|骗/,
    minPhase: 2,
    priority: 88,
    once: true,
    // 时序写法示范 ②：惊跳与镜头抖动在开口之前（atChar=0），
    // 情绪掉下去在「别这么说。」之后（atChar=7），侧身避开在「我知道这样不正常。」之后（atChar=16）。
    steps: [
      say("别。"),
      say("别这么说。"),
      say("我知道这样不正常。"),
      say("可我一走，就真的等不到了。"),
    ],
    cues: [
      { atChar: 0, directive: { kind: "action", action: "startle" } },
      { atChar: 0, directive: { kind: "camera", move: "shake" } },
      { atChar: 7, directive: { kind: "emotion", emotion: "anxious" } },
      { atChar: 16, directive: { kind: "pose", pose: "turn_away" } },
    ],
  },
  // —— 题目点名的：问「等谁」→ 侧身 + 望窗 ——
  {
    id: "who_waiting",
    match: /等谁|等谁啊|等人|在等|约了|谁啊|为什么在这|一个人/,
    priority: 85,
    once: true,
    steps: [
      pose("turn_away"),
      say("……"),
      say("一个不太守时的人。"),
      pose("glance_window"),
      say("他说九点。"),
      say("现在几点了？"),
    ],
  },
  // —— 追问原因：只肯给六个字 ——
  {
    id: "why_unknown",
    match: /为什么|什么原因|没说|原因|怎么不问|多久了/,
    minPhase: 2,
    priority: 80,
    once: true,
    steps: [
      emotion("anxious"),
      action("hair_tuck"),
      say("他只发了六个字。"),
      say("「等我。别问。」"),
      say("所以我就真的没问。"),
      say("我是不是很傻。"),
    ],
  },
  // —— 用户提出陪伴：给一次分支选择 ——
  {
    id: "invite",
    match: /一起|陪你|要不要|留下|我等你|陪你等|坐下/,
    priority: 78,
    once: true,
    steps: [
      emotion("warm"),
      pose("lean_in"),
      camera("push_in"),
      say("真的？"),
      say("……那你要不要坐下来。"),
      vfx("steam_wisp"),
      say("这杯快凉了，我不介意分你一半。"),
      md({
        kind: "branch",
        options: [
          { id: "stay", label: "陪你一起等" },
          { id: "call", label: "我帮你打个电话" },
        ],
      }),
    ],
  },
  // —— 场景/灯光变化：提到打烊 ——
  // —— 用户要离开 ——
  {
    id: "leaving",
    match: /我得走|先走|下次|抱歉|对不起|要走|改天|该走|走了|回去|得走了/,
    priority: 74,
    once: true,
    steps: [
      emotion("sad"),
      pose("turn_away"),
      camera("pull_back"),
      say("嗯。"),
      say("没关系，真的。"),
      say("……路上小心。"),
      action("sigh"),
    ],
  },
  // —— 注意到她的星星发夹 ——
  {
    id: "star_pin",
    match: /好看|漂亮|星星|发夹|可爱|亮/,
    priority: 72,
    once: true,
    steps: [
      emotion("surprised"),
      action("hair_tuck"),
      say("……这个？"),
      say("里斯本跳蚤市场，两欧元。"),
      pose("hold_cup"),
      emotion("warm"),
      say("老板说是别人退回来的。"),
      say("我信了。"),
    ],
  },
  // —— 聊到摄影 ——
  {
    id: "photo_talk",
    match: /照片|摄影|相机|拍|作品|职业|做什么|干什么|工作/,
    priority: 70,
    once: true,
    steps: [
      pose("lean_in"),
      emotion("amused"),
      say("你也懂相机？"),
      say("我背了它三年，走了十一个国家。"),
      vfx("warm_glow"),
      say("最好的照片，都是在等的时候拍的。"),
    ],
  },
  // —— 关心她等了多久/累不累 ——
  {
    id: "how_long",
    match: /多久|几个小时|一直|累|冷不冷|坐多久/,
    minPhase: 2,
    priority: 66,
    once: true,
    steps: [
      emotion("sad"),
      action("sigh"),
      say("三个小时。"),
      say("两杯咖啡，一个冷掉的三明治。"),
      pose("glance_window"),
      say("我不数时间。"),
      say("我只数门口进来的人。"),
    ],
  },
  // —— 用户问她自己的故事 ——
  {
    id: "about_mira",
    match: /你呢|你为什么|怎么在|你在追|拍照的|住哪/,
    priority: 60,
    once: true,
    steps: [
      emotion("curious"),
      say("我？"),
      say("我在追一场雨。"),
      say("哪儿下雨，我就去哪儿。"),
      pose("hold_cup"),
      say("听着是不是很像逃。"),
    ],
  },
  // —— 用户的善意 ——
  {
    id: "thanks",
    match: /谢谢|你很好|温柔|辛苦|会好起来|别难过/,
    priority: 55,
    steps: [
      emotion("warm"),
      action("nod"),
      say("别这么说。"),
      say("我只是没别的地方可去。"),
      action("blink"),
      say("……不过，谢谢。"),
    ],
  },
  // —— 开场：任何文本都会命中一次，兜住「第一句话没说关键词」的情况 ——
  {
    id: "opening",
    match: /.*/,
    maxPhase: 0,
    priority: 12,
    once: true,
    steps: [
      pose("hold_cup"),
      emotion("curious"),
      say("……哦，你来了。"),
      say("我还以为今晚就我一个人。"),
      camera("settle"),
      say("坐吧，别站在门口，雨会跟进来。"),
    ],
  },
  // —— 弧线推进：聊够几轮后自动进入打烊氛围（不依赖关键词，但依然是「对话推进到这一步」触发）——
  {
    id: "closing_auto",
    match: /.*/,
    minPhase: 5,
    priority: 8,
    once: true,
    steps: [
      scene("cafe_closing"),
      vfx("lights_dim"),
      say("灯关了一半。"),
      say("老板在里屋数杯子，很轻。"),
      emotion("sad"),
      say("再过一会儿，连这点声音都没有了。"),
    ],
  },
];

/** 兜底 beat：不重复、每轮换一个，保证对话永远接得住 */
const FALLBACKS: readonly MockBeat[] = [
  {
    id: "still_raining",
    priority: 0,
    steps: [
      emotion("neutral"),
      pose("hold_cup"),
      camera("settle"),
      say("外面还在下。"),
      say("杯子里的热气散了又起来。"),
    ],
  },
  {
    id: "small_talk",
    priority: 0,
    steps: [
      emotion("curious"),
      pose("lean_in"),
      say("你常来这儿吗？"),
      say("我每次都坐这个位置。"),
      say("靠窗，看得见整条街。"),
    ],
  },
  {
    id: "guess_you",
    priority: 0,
    steps: [
      emotion("amused"),
      say("我猜你不是来喝咖啡的。"),
      say("这个点还进来的人，要么在躲雨，"),
      say("要么在躲别的什么。"),
    ],
  },
  {
    id: "quiet",
    priority: 0,
    steps: [
      emotion("sad"),
      pose("turn_away"),
      say("其实我不太会跟人说话。"),
      say("拍照的时候不用说话。"),
      say("所以我拍了很久。"),
    ],
  },
];

/** 用户什么都没说（空白输入）时的 beat */
const SILENCE: MockBeat = {
  id: "silence",
  priority: 0,
  steps: [
    emotion("curious"),
    pose("glance_window"),
    say("……"),
    say("你有没有过那种感觉？"),
    say("越安静，越听得见雨。"),
  ],
};

/**
 * 选 beat：纯函数。
 * 输入 = 这句话 + 第几轮 + 已经演过哪些 once beat，输出 = 唯一确定的一段演出。
 */
export function selectMockBeat(userText: string, phase: number, fired: ReadonlySet<string>): MockBeat {
  if (!userText.trim()) return SILENCE;

  let best: MockBeat | null = null;
  for (const beat of MOCK_BEATS) {
    if (beat.once && fired.has(beat.id)) continue;
    if ((beat.minPhase ?? 0) > phase) continue;
    if (beat.maxPhase !== undefined && phase > beat.maxPhase) continue;
    if (!beat.match || !beat.match.test(userText)) continue;
    if (!best || beat.priority > best.priority) best = beat;
  }
  if (best) return best;

  const index = phase % FALLBACKS.length;
  return FALLBACKS[index] ?? SILENCE;
}

export interface TurnPlan {
  beat: MockBeat;
  phase: number;
  /** 本轮结束后累计演过的 once beat（可回传给客户端作为 scene.playedBeats） */
  fired: Set<string>;
}

/**
 * 从历史重放出「已经演过哪些 beat」，再为本轮选 beat。
 * 这个重放让导演保持无状态：只要拿到 history，结论就唯一。
 */
export function planMockTurn(input: DirectorInput): TurnPlan {
  const fired = new Set<string>(input.scene.playedBeats);
  const userTexts = input.history.filter((message) => message.role === "user").map((message) => message.text);

  userTexts.forEach((text, index) => {
    const beat = selectMockBeat(text, index, fired);
    if (beat.once) fired.add(beat.id);
  });

  const phase = userTexts.length;
  const beat = selectMockBeat(input.userText, phase, fired);
  if (beat.once) fired.add(beat.id);
  return { beat, phase, fired };
}

export class MockDirector implements Director {
  readonly name = "mock-mira";
  readonly #delayScale: number;

  constructor(options: MockDirectorOptions = {}) {
    this.#delayScale = Math.max(0, options.delayScale ?? 1);
  }

  async *stream(input: DirectorInput, signal: AbortSignal): AsyncIterable<SessionEvent> {
    const beat = planMockTurn(input).beat;
    const scale = this.#delayScale;
    let chunkIndex = 0;

    // 时序写法（beat.cues）：台词先合成一把尺子，指令按 atChar 落在字幕的字符位置上
    const plan: SpokenPlan | null = beat.cues
      ? {
          say: beat.steps.map((step) => (step.kind === "say" ? step.text : "")).join(""),
          cues: beat.cues,
        }
      : null;
    const scheduler = plan ? new CueScheduler(plan.cues, { sayLength: charCount(plan.say) }) : null;
    let spoken = 0;

    const cueEvent = (cue: AnchoredCue): SessionEvent => ({
      type: "directive",
      turnId: input.turnId,
      epoch: input.epoch,
      directive: cue.directive,
      atChar: cue.atChar,
    });
    // 场景切换/灯光变化给足呼吸，普通姿势指令快一些
    const holdOf = (directive: Directive): number => (directive.kind === "scene" ? 240 : 55);

    // 开场给一小段「正在想」的停顿，紧接着第一个视觉指令就会到
    await sleep(Math.round(80 * scale), signal);
    if (signal.aborted) return;

    // atChar = 0 的指令：开口之前就变（与旧行为一致，只是现在明确标了位置）
    if (scheduler) {
      for (const cue of scheduler.advance(0)) {
        if (signal.aborted) return;
        yield cueEvent(cue);
        await sleep(Math.round(holdOf(cue.directive) * scale), signal);
      }
    }

    for (const step of beat.steps) {
      if (signal.aborted) return;

      if (step.kind === "directive") {
        yield { type: "directive", turnId: input.turnId, epoch: input.epoch, directive: step.directive };
        await sleep(Math.round(holdOf(step.directive) * scale), signal);
        continue;
      }

      for (const piece of chunkText(step.text)) {
        if (signal.aborted) return;
        yield { type: "text.delta", turnId: input.turnId, epoch: input.epoch, text: piece };
        spoken += charCount(piece);
        chunkIndex += 1;

        // 说完这一片后，越过 atChar 的指令立刻放 —— 「说到第 N 个字符时画面变」
        if (scheduler) {
          for (const cue of scheduler.advance(spoken)) {
            if (signal.aborted) return;
            yield cueEvent(cue);
            await sleep(Math.round(holdOf(cue.directive) * scale), signal);
          }
        }

        await sleep(delayFor(chunkIndex - 1, scale), signal);
      }
      // 句子之间的呼吸
      await sleep(Math.round(110 * scale), signal);
    }

    // 收尾：atChar 落在末字之后/越界的 cue（例如结尾的 branch）不丢
    if (scheduler) {
      for (const cue of scheduler.takeAll()) {
        if (signal.aborted) return;
        yield cueEvent(cue);
        await sleep(Math.round(holdOf(cue.directive) * scale), signal);
      }
    }
  }
}

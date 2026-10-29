/** One immutable sample drives subtitle, mouth and cue watermark in the same render. */
export interface PlaybackSample {
  text: string;
  revealed: number;
  currentTime: number;
  duration: number;
  playing: boolean;
  mouth: number;
  /** Monotonic within a provider; distinguishes consecutive identical sentences. */
  sentence: number;
}

export function samplePlayback(text: string, currentTime: number, duration: number,
  sentence: number, started = true): PlaybackSample {
  const chars = Array.from(text);
  const time = Math.max(0, Math.min(currentTime, duration));
  const playing = started && currentTime >= 0 && currentTime < duration;
  const position = duration > 0 ? time / duration * chars.length : chars.length;
  const revealed = !started || currentTime < 0 ? 0 : playing
    ? Math.min(chars.length, Math.floor(time / duration * Math.max(0, chars.length - 1)) + 1) : chars.length;
  const char = chars[Math.min(chars.length - 1, Math.floor(position))] ?? '';
  // Character-level timing, with closure inside each syllable. No wall-clock oscillator.
  const mouth = !playing || /[\s，。！？、,.!?;；：:]/u.test(char) ? 0
    : position % 1 > 0.78 ? 0 : 1 + ((char.codePointAt(0) ?? 0) % 3);
  return { text, revealed, currentTime: time, duration, playing, mouth, sentence };
}

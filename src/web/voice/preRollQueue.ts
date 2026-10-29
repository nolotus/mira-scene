/**
 * 握手窗口的「预滚队列」策略：WS 还没就绪时录到的帧先排队，就绪后按序补发。
 *
 * 唯一的硬约束：**首块永不丢弃**。
 * MediaRecorder 的第一块带 EBML 容器头，后续块只是 cluster。丢了首块，服务端
 * 那句新起的 ffmpeg 就只能拿到无头数据流 —— 实测表现为
 * `EBML header parsing failed` + `pcm=0`，整句识别不出任何字（线上录屏就是这么崩的）。
 * 所以队列溢出时丢「第二旧」的那块：保住头，代价只是音频里少一小段。
 */
export interface PreRollPushResult {
  /** 本帧是否被丢弃（调用方用它累加 prerollDropped） */
  dropped: boolean;
}

export function pushBoundedPreRoll<T>(queue: T[], chunk: T, max: number): PreRollPushResult {
  queue.push(chunk);
  if (queue.length <= max) return { dropped: false };
  if (max <= 1) {
    // 容量只有 1 时只能留最新那块（此时本来也留不住头，交由调用方按无头处理）
    queue.splice(0, queue.length - 1);
    return { dropped: true };
  }
  // 保留首块，丢第二旧的
  queue.splice(1, 1);
  return { dropped: true };
}

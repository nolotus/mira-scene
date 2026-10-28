/**
 * `?obs=1` 观测面板：给优化用的量化视图。
 *
 * 只读、全屏覆盖、不参与主界面布局（主界面在它下面照常跑，只是被盖住）。
 * 放在独立入口而不是塞进 Diagnostics：Diagnostics 是给「现在出了什么事」看的，
 * 这里看的是「过去 N 轮的分段耗时分布」，两种信息混在一起会让两边都难读。
 */

import { useEffect, useState } from "react";
import { obsSnapshot, resetObs, subscribeObs, type ObsSnapshot, type ObsTurn } from "./obs";

const S = {
  // 顶部抽屉而不是全屏：面板盖住底部输入框的话，就没法「边发消息边看数据」了
  root: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    maxHeight: "58vh",
    zIndex: 9999,
    background: "#0d0f12",
    color: "#e6e8eb",
    font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
    overflow: "auto",
    padding: "12px 14px 16px",
    borderBottom: "1px solid #232a34",
    boxShadow: "0 10px 30px rgba(0,0,0,.55)",
  },
  h: { fontSize: "13px", letterSpacing: ".08em", color: "#8b98a8", margin: "0 0 8px" },
  cardRow: { display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "18px" },
  card: {
    border: "1px solid #232a34",
    borderRadius: "8px",
    padding: "8px 12px",
    minWidth: "132px",
    background: "#12161b",
  },
  cardLabel: { color: "#8b98a8", fontSize: "11px" },
  cardValue: { fontSize: "16px", marginTop: "2px" },
  table: { width: "100%", borderCollapse: "collapse", marginBottom: "16px" },
  th: { textAlign: "left", color: "#8b98a8", fontWeight: 400, padding: "4px 6px", borderBottom: "1px solid #232a34" },
  td: { padding: "4px 6px", borderBottom: "1px solid #171c23" },
  dim: { color: "#5f6b7a" },
  warn: { color: "#f0a35e" },
  bad: { color: "#ef6b6b" },
  ok: { color: "#63c08a" },
} as const;

function ms(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function pct(a: number | null, b: number | null): string {
  return `${ms(a)} / ${ms(b)}`;
}

function turnRow(turn: ObsTurn, index: number) {
  const bad = turn.error !== null || turn.ttsFailed > 0;
  return (
    <tr key={turn.turnId}>
      <td style={S.td}>
        <span style={S.dim}>#{index + 1}</span>
      </td>
      <td style={S.td}>{ms(turn.firstEventMs)}</td>
      <td style={S.td}>{ms(turn.firstDeltaMs)}</td>
      <td style={S.td}>{ms(turn.firstAudioMs)}</td>
      <td style={S.td}>{ms(turn.firstSoundMs)}</td>
      <td style={S.td}>{ms(turn.totalMs)}</td>
      <td style={S.td}>{turn.ttsRequests > 0 ? `${turn.ttsRequests}${turn.ttsFailed > 0 ? ` / ✗${turn.ttsFailed}` : ""}` : "—"}</td>
      <td style={S.td}>{ms(turn.ttsFirstMs)}</td>
      <td style={S.td}>{turn.channel ?? "—"}</td>
      <td style={{ ...S.td, ...(bad ? S.warn : S.ok) }}>
        {turn.interrupted ? "打断" : turn.error ?? (bad ? "部分失败" : "ok")}
      </td>
    </tr>
  );
}

export function ObsPanel() {
  const [snapshot, setSnapshot] = useState<ObsSnapshot>(() => obsSnapshot());
  const [showEvents, setShowEvents] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    const unsubscribe = subscribeObs(() => setSnapshot(obsSnapshot()));
    const timer = setInterval(() => setSnapshot(obsSnapshot()), 500);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);

  const { summary, turns, events } = snapshot;

  return (
    <div style={{ ...S.root, ...(open ? {} : { maxHeight: "42px", overflow: "hidden" }) }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "14px", marginBottom: "14px" }}>
        <strong style={{ fontSize: "15px" }}>MIRA 观测</strong>
        <span style={S.dim}>?obs=1 · 只统计本页打开之后的轮次</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={() => setOpen((value) => !value)} style={btn(!open)}>
          {open ? "收起" : "展开"}
        </button>
        <button type="button" onClick={() => setShowEvents((value) => !value)} style={btn(showEvents)}>
          {showEvents ? "隐藏事件流" : "显示事件流"}
        </button>
        <button type="button" onClick={() => resetObs()} style={btn(false)}>
          清空
        </button>
        <a href="/" style={{ ...btn(false), textDecoration: "none" }}>
          回到场景
        </a>
      </div>

      <h2 style={S.h}>分段耗时（p50 / p95）</h2>
      <div style={S.cardRow}>
        <div style={S.card}>
          <div style={S.cardLabel}>首事件（建连+首个 SSE）</div>
          <div style={S.cardValue}>{pct(summary.firstEvent.p50, summary.firstEvent.p95)}</div>
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>模型首字</div>
          <div style={S.cardValue}>{pct(summary.firstDelta.p50, summary.firstDelta.p95)}</div>
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>首个音频分片</div>
          <div style={S.cardValue}>{pct(summary.firstAudio.p50, summary.firstAudio.p95)}</div>
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>真正出声（用户感知）</div>
          <div style={S.cardValue}>{pct(summary.firstSound.p50, summary.firstSound.p95)}</div>
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>整轮结束</div>
          <div style={S.cardValue}>{pct(summary.total.p50, summary.total.p95)}</div>
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>完成 / 打断 / 出错</div>
          <div style={{ ...S.cardValue, ...(summary.errors > 0 ? S.bad : S.ok) }}>
            {summary.turns} / {summary.interrupted} / {summary.errors}
          </div>
        </div>
        <div style={S.card}>
          <div style={S.cardLabel}>TTS 请求失败</div>
          <div style={{ ...S.cardValue, ...(summary.failedTtsRequests > 0 ? S.warn : S.ok) }}>
            {summary.failedTtsRequests}
          </div>
        </div>
      </div>

      <h2 style={S.h}>最近轮次（从发送那一刻起算）</h2>
      {turns.length === 0 ? (
        <p style={S.dim}>还没有轮次。回到场景发一句话，这里就会出现分段数据。</p>
      ) : (
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th} />
              <th style={S.th}>首事件</th>
              <th style={S.th}>模型首字</th>
              <th style={S.th}>首个音频分片</th>
              <th style={S.th}>真正出声</th>
              <th style={S.th}>整轮</th>
              <th style={S.th}>TTS 请求</th>
              <th style={S.th}>TTS TTFB</th>
              <th style={S.th}>通道</th>
              <th style={S.th}>结果</th>
            </tr>
          </thead>
          <tbody>{turns.map(turnRow)}</tbody>
        </table>
      )}

      {showEvents && (
        <>
          <h2 style={S.h}>原始事件（最近 {events.length} 条）</h2>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>t (ms)</th>
                <th style={S.th}>类型</th>
                <th style={S.th}>轮次</th>
                <th style={S.th}>明细</th>
              </tr>
            </thead>
            <tbody>
              {events
                .slice()
                .reverse()
                .map((event, index) => (
                  <tr key={`${event.t}-${event.kind}-${index}`}>
                    <td style={S.td}>{event.t}</td>
                    <td style={S.td}>{event.kind}</td>
                    <td style={{ ...S.td, ...S.dim }}>{event.turnId ? event.turnId.slice(-6) : "—"}</td>
                    <td style={{ ...S.td, ...S.dim }}>
                      {event.detail
                        ? Object.entries(event.detail)
                            .map(([key, value]) => `${key}=${String(value)}`)
                            .join(" ")
                        : ""}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function btn(active: boolean) {
  return {
    background: active ? "#1d2630" : "transparent",
    border: "1px solid #2b3440",
    borderRadius: "6px",
    color: "#c9d1da",
    padding: "4px 10px",
    font: "inherit",
    cursor: "pointer",
  } as const;
}

/**
 * 流式读秒格式化（v3.37）：秒 → 分 → 小时进位，不一直显示秒；秒位始终在转。
 * <60s → `42s`；<60m → `5m30s`（整分省秒 `5m`）；≥60m → `1h2m28s`（整分/整时省零位 `1h1m`、`1h`）。
 */
export function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s === 0 ? `${m}m` : `${m}m${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (s === 0) return rm === 0 ? `${h}h` : `${h}h${rm}m`;
  return `${h}h${rm}m${s}s`;
}

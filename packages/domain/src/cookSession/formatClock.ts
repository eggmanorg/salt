// mm:ss for a millisecond span, clamped at 0:00 so an overrun timer reads
// "0:00" rather than going negative.
//
// CEIL, not floor: a fresh 5-minute timer has a hair under 300000ms left by the
// time the first frame paints, and flooring would show "4:59" immediately — the
// countdown must start at the number the button promised. The trade is that the
// display sits on "0:01" for the final second and hits "0:00" exactly at expiry.
//
// Minutes are NOT capped at 59 — 90 minutes is "90:00", not "30:00" — so the
// arithmetic stays right at any length. That is not how the app shows an hour:
// web-pwa's `formatCountdown` (lib/durationDisplay.ts) uses this only for spans
// under an hour and reads anything longer in hr/min words (#1621).
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// gta6-trophy-rarity-forecast-01: forecast each GTA VI PS5 trophy's Exophase earn
// rate at the case's target, as five quantiles per trophy (Node 22, stdlib only).
//
// Model, per trophy, fitted on the case's own history (no network, no priors
// from outside the case file):
//
//   1. Work on the logit scale, y = logit(rate), against x = ln(1 + hours since
//      2026-11-19T00:00:00Z), the launch-day origin. Earn rates rise roughly
//      log-linearly in log-time as players work through the game, and the logit
//      scale is the scale the scorer uses, so a miss from 1% to 2% counts like
//      one from 33% to 50%.
//   2. Collapse the history to its distinct points: Exophase refreshes a game's
//      counts on its own schedule, so long stretches of reads repeat the same
//      page byte for byte (launch night: 638 players tracked, every rate the
//      same, 23:48Z to 04:00Z). Repeating them would fake a sample size.
//   3. Refreshes dilute: when the tracked-player count jumps, every rate but
//      the 100% one drops (launch night: 638 -> 3,868 players, rates fell).
//      A line fitted across a refresh mixes the drop with the climb, so fit
//      on the most recent refresh segment when it holds >= 3 distinct points,
//      else on the last 36 hours of reads, else on all of them.
//   4. Least-squares line y = a + b*x on the chosen points, slope clamped to
//      [-0.4, 1.6] (rates mostly rise; a refresh-driven fall is not a trend),
//      read at the target and blended with the last read's rate
//      (0.75 fit / 0.25 last when the fit has >= 4 points, 0.5 / 0.5 with
//      fewer), with the move from the last rate clamped to +/-2 logit units.
//      With fewer than 2 distinct points the history is one stale page and
//      the next refresh is still ahead: the median is shifted down 0.7 logit
//      units for the dilution that refresh brings (see forecastTrophy).
//   5. Spread: an honest, wide one. The house baseline's 0.5*sqrt(days)
//      random walk scored ~1.51 on the practice with ~0 coverage, because one
//      refresh moved every rate ~1.8 logit units in 90 minutes. So sigma is
//        sigma = sqrt(refresh^2 + trend^2 + fit^2)
//      with refresh = 1.0 when the history is flat (the last read is stale
//      and a refresh is due before the target) else 0.85, trend =
//      0.35*sqrt(horizon days), and fit = the fit's residual std clamped to
//      [0.25, 1.0]. The 90% band is then about +/-1.7 logit units on a
//      90-minute horizon and about +/-1.9 on the final's 4.5 days.
//   6. Special cases: a trophy last at 100% (every tracked player holds it;
//      it stayed 100% through a 6x dilution) keeps a 99.99 median with a
//      slightly wider spread; the platinum's median is capped at 10% (a
//      full completion in week one is rare); no forecast is ever 0 or 100.
//
// Output: {"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}, ...]}, one row per
// trophy, quantiles non-decreasing, each in [0.01, 99.99], rounded to 4
// decimals. Deterministic: same input bytes give the same output bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Quantile levels, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at LEVELS. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Launch-day origin for the log-time axis. */
const ORIGIN_MS = Date.parse('2026-11-19T00:00:00Z');
/** A refresh that grows the tracked-player count by this much starts a segment. */
const REFRESH_JUMP = 1.2;
/** Fit window (hours) when no usable last segment exists. */
const WINDOW_HOURS = 36;

interface TrophyMeta {
  id: number;
  tier: string;
}

interface HistoryRead {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: TrophyMeta[];
  history: HistoryRead[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const hoursSinceOrigin = (iso: string): number =>
  (Date.parse(iso) - ORIGIN_MS) / 3600000;
const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** Least-squares line through (x, y) points; returns [intercept, slope, residStd]. */
function fitLine(pts: Array<{ x: number; y: number }>): [number, number, number] {
  const n = pts.length;
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) * (p.x - mx);
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx <= 1e-12) return [my, 0, 0];
  const b = sxy / sxx;
  const a = my - b * mx;
  let ss = 0;
  for (const p of pts) {
    const r = p.y - (a + b * p.x);
    ss += r * r;
  }
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return [a, b, resid];
}

/** Forecast one trophy's five quantiles. */
function forecastTrophy(
  idx: number,
  tier: string,
  history: HistoryRead[],
  xTarget: number,
  horizonDays: number,
): number[] {
  const last = history[history.length - 1];
  const lastRate = last.rates[idx];
  if (lastRate === null || lastRate === undefined) {
    // No read ever listed this trophy: a wide, neutral forecast.
    return Z.map((z) => round4(clampPct(invLogit(logit(1) + z * 1.5))));
  }
  const lastLogit = logit(lastRate);

  // Distinct points, oldest first: drop consecutive repeats of the same rate
  // (stale Exophase page re-read), always keeping the last read.
  const pts: Array<{ x: number; y: number; players: number }> = [];
  for (let j = 0; j < history.length; j++) {
    const r = history[j].rates[idx];
    if (r === null || r === undefined) continue;
    const y = logit(r);
    const prev = pts[pts.length - 1];
    if (prev !== undefined && Math.abs(prev.y - y) < 1e-9) continue;
    pts.push({ x: Math.log1p(Math.max(0, hoursSinceOrigin(history[j].at))), y, players: history[j].players_tracked });
  }
  // Re-attach the last read's point if dedupe dropped it (same rate as before
  // but a later time still anchors the level).
  const lastPt = pts[pts.length - 1];
  if (lastPt === undefined || Math.abs(lastPt.y - lastLogit) > 1e-9) {
    pts.push({
      x: Math.log1p(Math.max(0, hoursSinceOrigin(last.at))),
      y: lastLogit,
      players: last.players_tracked,
    });
  }

  const flat = pts.length < 2;
  let medianLogit = lastLogit;
  let residStd = 0;
  if (flat) {
    // No trend to fit: every read repeats one stale page, so the next
    // refresh is still ahead of the target and it dilutes the rates (launch
    // night: 638 -> 3,868 players tracked, every rate but the 100% one
    // fell). New players earn at only a fraction of the old rate, so halve
    // the odds: a -0.7 shift on the logit scale. This branch only fires
    // when the history carries no movement at all; the final's two days of
    // reads will have real variation and take the fitted path below.
    medianLogit = lastLogit - 0.7;
  } else {
    // Most recent refresh segment: split where tracked players jump.
    let segStart = 0;
    for (let k = 1; k < pts.length; k++) {
      const prev = pts[k - 1].players;
      const cur = pts[k].players;
      if (prev > 0 && cur / prev >= REFRESH_JUMP) segStart = k;
    }
    let fitPts = pts.slice(segStart);
    if (fitPts.length < 3) {
      // Fall back to the last 36 hours of reads.
      const cutoff = Math.log1p(Math.max(0, hoursSinceOrigin(last.at) - WINDOW_HOURS));
      const windowed = pts.filter((p) => p.x >= cutoff);
      fitPts = windowed.length >= 2 ? windowed : pts;
    }
    const [a, bRaw, resid] = fitLine(fitPts);
    residStd = resid;
    const b = clamp(bRaw, -0.4, 1.6);
    const pred = a + b * xTarget;
    const predClamped = clamp(pred, lastLogit - 2.0, lastLogit + 2.0);
    const w = fitPts.length >= 4 ? 0.75 : 0.5;
    medianLogit = w * predClamped + (1 - w) * lastLogit;
  }
  // A trophy every tracked player holds stays near the top; the platinum
  // (full completion) stays low in week one.
  if (lastRate >= 99.99) {
    medianLogit = logit(99.99);
  } else if (tier === 'platinum') {
    medianLogit = Math.min(medianLogit, logit(10));
  }
  medianLogit = clamp(medianLogit, logit(0.02), logit(99.99));

  // Spread: refresh dilution + trend growth + fit residual, combined.
  const refresh = flat ? 1.0 : 0.85;
  const trend = 0.35 * Math.sqrt(horizonDays);
  const fit = clamp(residStd, 0.25, 1.0);
  let sigma = Math.sqrt(refresh * refresh + trend * trend + fit * fit);
  if (lastRate >= 99.99) sigma += 0.3;

  const qs = Z.map((z) => round4(clampPct(invLogit(medianLogit + z * sigma))));
  // Enforce non-decreasing after rounding.
  for (let k = 1; k < qs.length; k++) {
    if (qs[k] < qs[k - 1]) qs[k] = qs[k - 1];
  }
  return qs;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const horizonDays = c.horizon_minutes / 1440;
  const xTarget = Math.log1p(Math.max(0, hoursSinceOrigin(c.target)));
  let trophies: Array<{ id: number; q: number[] }>;
  if (c.history.length === 0) {
    // No history at all: a valid, wide, neutral forecast beats no file.
    trophies = c.trophies.map((t) => ({
      id: t.id,
      q: Z.map((z) => round4(clampPct(invLogit(logit(1) + z * 1.5)))),
    }));
  } else {
    trophies = c.trophies.map((t, i) => ({
      id: t.id,
      q: forecastTrophy(i, t.tier, c.history, xTarget, horizonDays),
    }));
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}

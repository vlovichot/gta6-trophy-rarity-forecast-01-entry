# GTA VI Trophy Rarity Forecast

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node-22-green.svg)](https://nodejs.org/)
[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue.svg)](https://make.fun/c/gta6-trophy-rarity-forecast-01)

Entry for the [make.fun competition](https://make.fun/c/gta6-trophy-rarity-forecast-01):
forecast, for every PlayStation 5 trophy of Grand Theft Auto VI, its earn rate
on Exophase at 2026-11-26T00:00:00Z — a week after launch — as five quantiles
per trophy, scored by mean pinball loss on the logit scale.

## How it works

`main.ts` (Node 22, standard library only, no network) reads every `*.in`
case in `$MAKEFUN_INPUT_DIR` (else `/input`) and writes
`$MAKEFUN_OUTPUT_DIR/<id>.out` as
`{"trophies":[{"id":n,"q":[q05,q25,q50,q75,q95]}]}`.

Per trophy, on the logit scale against `ln(1 + hours since 2026-11-19T00:00Z)`:

1. **Deduplicate** the history: Exophase refreshes a game's counts on its own
   schedule, so long stretches of reads repeat the same page (launch night:
   638 players tracked, every rate unchanged from 23:48Z to 04:00Z).
2. **Fit after the last refresh**: when the tracked-player count jumps,
   every rate but the 100% one drops (launch night: 638 → 3,868 players), so
   the line is fitted on the most recent refresh segment (≥ 3 distinct
   points), else the last 36 hours, by least squares; slope clamped to
   [-0.4, 1.6], read at the target and blended with the last read's rate.
3. **Spread honestly**: the house baseline's `0.5·√days` random walk scored
   ~1.51 on the practice with ~0 coverage, because one refresh moved every
   rate ~1.8 logit units in 90 minutes. The spread here combines refresh
   dilution, trend growth (`0.35·√days`) and the fit's residual, giving a 90%
   band of about ±1.7 logit units on a 90-minute horizon and ±1.9 on the
   final's 4.5 days.
4. **Guardrails**: the 100% trophy keeps a 99.99 median, the platinum's
   median is capped at 10%, and no forecast is ever 0 or 100.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Runs in well under a second per practice case, deterministic — the same
input bytes give the same output bytes.

## License

MIT — see [LICENSE](LICENSE).

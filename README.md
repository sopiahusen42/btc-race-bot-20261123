# btc-race-24h-20261123-0511 — long cbBTC, one crash stop

A bot for the make.fun "race a BTC trading bot live for 24 hours" bounty. It speaks
`agent-fun/bars-replay/v1` on stdin/stdout: one `reply` per `batch`, 1,440 one-minute
cbBTC/USDC bars, starting with 1,000 USDC of paper money.

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/sopiahusen42/btc-race-bot-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/sopiahusen42/btc-race-bot-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

## What it does

The score is net PnL, and the dev window trends up, while a round trip costs roughly
26 bps (4 bps fee each way, plus slippage and pool impact). A trading overlay tested
on this window loses to the drift, so the bot holds full long exposure and pays the
round-trip cost only when it has a reason:

1. **flat → long.** On the first bar it may trade on (warm-up bars are skipped, since
   every order there is rejected as `warmup`), it buys the entire cash balance in one
   order with `max_slippage_bps: 300`.
2. **long.** It tracks the running maximum close. If the close falls more than 20%
   below that peak — `close * 100 < peak * 80`, integer maths only — it sells the whole
   position and remembers the peak as the reclaim level.
3. **waiting-for-reclaim.** It re-enters with all the cash only once the close is back
   at that reclaim level. A small bounce after a dip does not buy it back in.
4. Otherwise it holds to the end; the harness flattens the position at the last close.

An `orderInFlight` flag settles each order against the next bar's account, so a refused
order returns the machine to the phase that still matches the account instead of
re-sending a doomed sell (which would show up as a `rejected` fill and waste a slot).

No clock, no environment, no randomness, no network: two runs of the same window
produce a byte-identical action log.

### Why a 20% stop and not a tighter one

The stop exists for one reason: the 25% maximum-drawdown guardrail, which is the only
thing that can disqualify an entry outright (a wider drawdown ranks it below every
entry that meets the bar; net PnL itself is paid regardless of sign). Scoring the race
on net PnL, a tighter stop is actively worse. An 8% stop fires on an ordinary intraday
dip, sells at the bottom, and re-enters only once price has reclaimed the old peak — so
it turns a dip that would have recovered into a permanent loss of roughly the dip's
size. A 20% stop stays silent on normal days, and when it does fire it caps the
drawdown at about 20.5% including exit slippage, still inside the 25% bar. It costs
nothing when nothing happens and still stops a crash.

## Layout

- `main.ts` — the bot (entrypoint, run as `node /bot/main.ts`).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's `sdk/makefun-bars.ts`.
- `LICENSE`, `.makefun/owner.json`, `.gitignore` — housekeeping.

## Reproduce the local grade

```sh
cd ../kit/btc-race-24h-20261123-0511-kit
node cli/makefun.mjs grade-local --kit . --bot ../../repo --driver process --worktree
```

On the published dev window this prints net PnL **+32.167313 USDC**, max drawdown
**0.019778194**, 1 trade, 0 rejected, and `L1 regrade  reproduced byte for byte`.

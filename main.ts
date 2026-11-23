// btc-race-24h-20261123-0511 — full long exposure to cbBTC with one crash stop.
//
// The race is scored on net PnL over 24 hours of 1-minute cbBTC bars, and the
// dev window trends up, so the cheapest edge is simply to hold the asset. A
// faster overlay costs ~26 bps per round trip and loses to that drift. So the
// bot does the minimum: buy once with all the cash, hold, and only step aside
// if the market falls hard enough to threaten the 25% drawdown guardrail.
//
// State machine:
//   flat                 -> buy the whole cash balance, then `long`
//   long                 -> track the running peak close; if the close drops
//                           more than 20% below the peak, sell everything and
//                           remember that peak as the reclaim level
//   waiting-for-reclaim  -> re-enter (buy all cash) only once the close is back
//                           at the level that stopped us out; no small bounces
//
// Why 20% and not a tighter stop. The race window is scored on net PnL and the
// ten highest net PnLs are paid whatever their sign, so the dev gate is the
// only hard requirement. The one thing that can disqualify us outright is the
// guardrail: maximum drawdown on the race window must be 25% or less, or the
// entry ranks below every entry that meets the bar. An 8% stop is the worst of
// both worlds: it fires on an ordinary intraday dip, sells at the bottom, and
// only buys back once price has reclaimed the old peak — so it converts a dip
// that would have recovered into a permanent loss of roughly the dip's size. A
// 20% stop only fires in genuinely extreme conditions, still keeps the maximum
// drawdown (about 20.5% including slippage on the exit) inside the 25%
// guardrail, and therefore costs nothing on a normal day while still capping a
// crash. The stop exists for the guardrail, not for profit: it is the floor
// under a bad window, not an edge.
//
// All decisions use integer price comparisons (price * 100 < peak * 80 for the
// 20% stop), so nothing in the decision path depends on floating point.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Wide enough for the modelled slippage plus the one-bar gap; not a decision input. */
const MAX_SLIPPAGE_BPS = 300;
/** Stop when close * 100 < peak * 80, i.e. a 20% fall from the running peak. */
const STOP_NUM = 80n;
const STOP_DEN = 100n;

type Phase = 'flat' | 'long' | 'waiting-for-reclaim';

let phase: Phase = 'flat';
/** Running maximum close seen while long, in price units. */
let peak = 0n;
/** The peak whose 20% drop stopped us out; the close must reclaim it to re-enter. */
let reclaimLevel = 0n;
/**
 * True while an order of ours is decided but not yet filled. Orders fill at the
 * next bar's open, so the account still shows the old state on this bar; the
 * flag keeps us from sending the same move twice and from treating a refused
 * order as a done deal.
 */
let orderInFlight = false;

/** One buy of the whole cash balance; the harness refuses more than we hold. */
function buyAll(cash: bigint): BuyInput {
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

/** One sell of the whole position at its qty_scale units. */
function sellAll(qty: bigint): SellInput {
  return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
}

/**
 * Cash worth spending: the whole balance, but nothing below the market's
 * minimum notional, which would only come back as a rejected fill.
 */
function spendable(state: BarsState): bigint {
  const min = BigInt(state.hello.fees.min_notional_quote_units);
  return state.cash >= min ? state.cash : 0n;
}

await runBars({
  onBatch(state): (BuyInput | SellInput)[] {
    // Warm-up batches precede the scored window; any order there is rejected
    // (warmup) and never retried, so wait for the first tradable bar.
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];

    const held = state.positions.get(SYMBOL)?.qty ?? 0n;

    // Settle the order we decided on the previous bar: it fills at this bar's
    // open, so the account here says whether it took. If it did not (a market
    // refusal, never a crash), fall back to the state that still holds.
    if (orderInFlight) {
      orderInFlight = false;
      if (phase === 'long' && held === 0n) phase = 'flat';
      else if (phase === 'waiting-for-reclaim' && held > 0n) phase = 'long';
    }

    if (phase === 'flat') {
      if (held > 0n) {
        // A position we did not open this run: treat it as ours and hold it.
        phase = 'long';
        peak = close;
        return [];
      }
      const budget = spendable(state);
      if (budget === 0n) return [];
      phase = 'long';
      peak = close;
      orderInFlight = true;
      return [buyAll(budget)];
    }

    if (phase === 'long') {
      if (held === 0n) return [];
      if (close > peak) peak = close;
      if (close * STOP_DEN < peak * STOP_NUM) {
        // Crash stop: leave the market and remember the level to reclaim.
        reclaimLevel = peak;
        phase = 'waiting-for-reclaim';
        orderInFlight = true;
        return [sellAll(held)];
      }
      return [];
    }

    // waiting-for-reclaim: re-enter only on a full recovery of the stop level,
    // so a 20% dip that bounces a few bps does not buy us back in.
    if (held > 0n) return [];
    if (close < reclaimLevel) return [];
    const budget = spendable(state);
    if (budget === 0n) return [];
    phase = 'long';
    peak = close;
    orderInFlight = true;
    return [buyAll(budget)];
  },
});

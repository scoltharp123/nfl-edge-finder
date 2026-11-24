// Edge engine: turns raw Odds API data into ranked DraftKings bets.
// Works in the browser and in Node (for testing).

export const TARGET_BOOK = "draftkings";
export const SHARP_BOOKS = ["pinnacle"];           // preferred fair-price reference
export const EXCLUDE_FROM_CONSENSUS = ["draftkings"];
export const MIN_CONSENSUS_BOOKS = 3;

export const amToDec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
export const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
export const probToAm = (p) => decToAm(1 / p);
export const fmtAm = (a) => (a > 0 ? `+${a}` : `${a}`);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const outcomeKey = (marketKey, o) =>
  `${marketKey}|${o.name}|${o.point ?? ""}`;

// Group a market's outcomes into two-way pairs (same line), then remove the vig.
// Returns Map<outcomeKey, fairProb>.
function fairProbs(market) {
  const out = new Map();
  const outs = market.outcomes || [];
  let groups = [];
  if (market.key === "h2h") {
    groups = [outs];
  } else if (market.key === "totals") {
    const byPt = {};
    for (const o of outs) (byPt[o.point] ||= []).push(o);
    groups = Object.values(byPt);
  } else if (market.key === "spreads") {
    // Team A -3.5 pairs with Team B +3.5
    const byAbs = {};
    for (const o of outs) (byAbs[Math.abs(o.point)] ||= []).push(o);
    groups = Object.values(byAbs).filter(
      (g) => g.length === 2 && g[0].point === -g[1].point
    );
  }
  for (const g of groups) {
    if (g.length !== 2) continue; // only clean two-way markets
    const imp = g.map((o) => 1 / amToDec(o.price));
    const sum = imp[0] + imp[1];
    g.forEach((o, i) => out.set(outcomeKey(market.key, o), imp[i] / sum));
  }
  return out;
}

export function analyze(games, opts = {}) {
  const now = opts.now ?? Date.now();
  const includeLive = opts.includeLive ?? false;
  const rows = [];
  let gamesWithDK = 0;

  for (const g of games) {
    const start = Date.parse(g.commence_time);
    const live = start <= now;
    if (live && !includeLive) continue;

    const dk = g.bookmakers.find((b) => b.key === TARGET_BOOK);
    if (!dk) continue;
    gamesWithDK++;

    // Fair probabilities per book
    const perBook = g.bookmakers
      .filter((b) => b.key !== TARGET_BOOK)
      .map((b) => {
        const fair = new Map();
        for (const m of b.markets) for (const [k, v] of fairProbs(m)) fair.set(k, v);
        return { key: b.key, title: b.title, fair, last: b.last_update };
      });

    for (const m of dk.markets) {
      for (const o of m.outcomes) {
        const k = outcomeKey(m.key, o);
        let p = null, source = null, n = 0;

        const sharp = perBook.find((b) => SHARP_BOOKS.includes(b.key) && b.fair.has(k));
        if (sharp) {
          p = sharp.fair.get(k); source = sharp.title; n = 1;
        } else {
          const vals = perBook
            .filter((b) => !EXCLUDE_FROM_CONSENSUS.includes(b.key) && b.fair.has(k))
            .map((b) => b.fair.get(k));
          if (vals.length >= MIN_CONSENSUS_BOOKS) {
            p = median(vals); source = `Consensus of ${vals.length} books`; n = vals.length;
          }
        }
        if (p == null) continue;

        const dec = amToDec(o.price);
        const ev = p * dec - 1;                       // expected profit per $1
        const kelly = Math.max(0, (p * dec - 1) / (dec - 1));
        rows.push({
          id: `${g.id}|${k}`,
          gameId: g.id,
          game: `${g.away_team} @ ${g.home_team}`,
          start: g.commence_time,
          live,
          market: m.key,
          marketLabel: { h2h: "Moneyline", spreads: "Spread", totals: "Total" }[m.key] || m.key,
          pick: pickLabel(m.key, o),
          price: o.price,
          dec,
          fairProb: p,
          fairAm: probToAm(p),
          breakeven: 1 / dec,
          ev,
          kelly,
          source,
          sharp: !!sharp,
          refBooks: n,
          trap: p >= 0.6 && ev < -0.01,
          grade: ev >= 0.03 ? "Strong" : ev >= 0.01 ? "Lean" : ev >= 0 ? "Thin" : "Pass",
        });
      }
    }
  }
  rows.sort((a, b) => b.ev - a.ev);
  return { rows, gamesWithDK };
}

function pickLabel(market, o) {
  if (market === "h2h") return `${o.name} ML`;
  if (market === "spreads") return `${o.name} ${o.point > 0 ? "+" : ""}${o.point}`;
  if (market === "totals") return `${o.name} ${o.point}`;
  return o.name;
}

// Suggested stake: fractional Kelly, capped at maxPct of bankroll.
export function stake(row, { bankroll, kellyFrac, maxPct }) {
  const s = bankroll * Math.min(row.kelly * kellyFrac, maxPct);
  return Math.max(0, Math.round(s));
}

// Profit/loss of a settled bet
export function betProfit(b) {
  if (b.result === "win") return b.stake * (amToDec(b.price) - 1);
  if (b.result === "loss") return -b.stake;
  return 0;
}

// Closing line value: how much better your price was than the close (positive = good)
export function clv(b) {
  if (b.closing == null || b.closing === "" || isNaN(b.closing)) return null;
  return amToDec(b.price) / amToDec(Number(b.closing)) - 1;
}

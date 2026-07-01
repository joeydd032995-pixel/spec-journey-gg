import { describe, expect, it } from "vitest";
import {
  americanStr, bestPrice, buildRatingsModel, clamp, clvEv, computeProjection,
  decimalOdds, devigTwoWay, DEFAULT_SETTINGS, efficiency, erf, evPerUnit,
  formScore, fullKelly, h2hDominance, impliedProb, leagueMeanPpm, makeRatings,
  marginRatioFrom, matchKey, normCdf, num, payoutMult, pearson, probOver,
  projectTotal, r1, shrink, wfKey, winProb,
  type MatchResult, type Player, type Settings,
} from "@/lib/model";

const S: Settings = { ...DEFAULT_SETTINGS };

function mkPlayer(over: Partial<Player> = {}): Player {
  return {
    name: "A", win_pct: 55, pts_per_match: 68, fg_pct: 50,
    steals: 2, fouls: 3, gp: 60, recent_form: "WWLWL", ...over,
  };
}

/* ----------------------------- math core --------------------------------- */
describe("math core", () => {
  it("num coerces safely", () => {
    expect(num("3.5")).toBe(3.5);
    expect(num("")).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num("abc")).toBe(0);
    expect(num(Infinity)).toBe(0);
  });

  it("clamp bounds values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("r1 rounds to one decimal", () => {
    expect(r1(1.26)).toBe(1.3);
    expect(r1(1.24)).toBe(1.2);
  });

  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(normCdf(2) + normCdf(-2)).toBeCloseTo(1.0, 6);
  });

  it("erf is odd and bounded", () => {
    expect(erf(0)).toBeCloseTo(0, 7);
    expect(erf(1)).toBeCloseTo(0.8427, 3);
    expect(erf(-1)).toBeCloseTo(-0.8427, 3);
    expect(Math.abs(erf(5))).toBeLessThanOrEqual(1);
  });

  it("pearson: perfect, inverse, degenerate", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 9);
    expect(pearson([1], [1])).toBeNull();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull(); // zero variance
  });

  it("formScore weights recent games more", () => {
    expect(formScore("")).toBe(0);
    expect(formScore("WWWWW")).toBe(1);
    expect(formScore("LLLLL")).toBe(-1);
    expect(formScore("WLLLL")).toBeGreaterThan(formScore("LLLLW")); // leftmost = most recent
    expect(formScore("w-x-l")).toBeCloseTo(formScore("WL"), 9);     // sanitizes input
  });

  it("efficiency = ppm + steals - fouls/2", () => {
    expect(efficiency({ pts_per_match: 60, steals: 4, fouls: 2 })).toBe(63);
  });
});

/* ----------------------------- odds helpers ------------------------------ */
describe("odds helpers", () => {
  it("impliedProb for +/- odds", () => {
    expect(impliedProb(-110)).toBeCloseTo(110 / 210, 9);
    expect(impliedProb(100)).toBeCloseTo(0.5, 9);
    expect(impliedProb(150)).toBeCloseTo(100 / 250, 9);
    expect(impliedProb("")).toBeNull();
    expect(impliedProb(0)).toBeNull();
  });

  it("payoutMult and decimalOdds", () => {
    expect(payoutMult(100)).toBe(1);
    expect(payoutMult(-200)).toBe(0.5);
    expect(payoutMult(0)).toBe(0);
    expect(decimalOdds(-110)).toBeCloseTo(1.909, 3);
  });

  it("evPerUnit: fair coin at +100 is zero EV", () => {
    expect(evPerUnit(0.5, 100)).toBeCloseTo(0, 9);
    expect(evPerUnit(0.55, 100)).toBeCloseTo(0.10, 9);
    expect(evPerUnit(0.5, -110)).toBeLessThan(0);
  });

  it("fullKelly: standard cases", () => {
    expect(fullKelly(0.5, 100)).toBeCloseTo(0, 9);           // no edge
    expect(fullKelly(0.6, 100)).toBeCloseTo(0.2, 9);         // b=1: 2p-1
    expect(fullKelly(0.5, "")).toBe(0);                      // no odds
  });

  it("americanStr formats sign", () => {
    expect(americanStr(120)).toBe("+120");
    expect(americanStr(-110)).toBe("-110");
  });
});

/* ---------------- de-vig, CLV, line shopping ----------------------------- */
describe("devig / CLV / best price", () => {
  it("devigTwoWay removes vig proportionally", () => {
    const [p1, p2] = devigTwoWay(-110, -110);
    expect(p1).toBeCloseTo(0.5, 9);
    expect(p2).toBeCloseTo(0.5, 9);
    expect(devigTwoWay("", -110)).toEqual([null, null]);
  });

  it("clvEv: beating the close is positive", () => {
    // took +110, market closed at -110/-110 => fair 50% => EV = .5*2.1 - 1 = +5%
    expect(clvEv(110, -110, -110)).toBeCloseTo(0.05, 9);
    // took the close exactly (one-sided, vigged) => negative EV vs implied
    expect(clvEv(-110, -110)).toBeCloseTo((110 / 210) * (1 + 100 / 110) - 1, 9);
    expect(clvEv(-110, "")).toBeNull();
  });

  it("bestPrice picks highest decimal each side + consensus", () => {
    const bp = bestPrice([
      { book: "A", over: -115, under: -105 },
      { book: "B", over: -105, under: -115 },
      { book: "C", over: "", under: "" },
    ]);
    expect(bp.bestOver?.book).toBe("B");
    expect(bp.bestUnder?.book).toBe("A");
    expect(bp.consensusOver).toBeGreaterThan(0.45);
    expect(bp.consensusOver).toBeLessThan(0.55);
  });

  it("bestPrice with no quotes", () => {
    const bp = bestPrice([{ book: "A", over: "", under: "" }]);
    expect(bp.bestOver).toBeNull();
    expect(bp.bestUnder).toBeNull();
    expect(bp.consensusOver).toBeNull();
  });
});

/* ----------------------- empirical-Bayes shrink -------------------------- */
describe("shrink", () => {
  it("pulls toward target at low gp and fades with sample", () => {
    expect(shrink(80, 4, 4, 60)).toBeCloseTo(70, 9);           // w = 4/8 = .5
    expect(shrink(80, 400, 4, 60)).toBeGreaterThan(79);        // large sample ≈ raw
    expect(shrink(80, 0, 4, 60)).toBe(80);                     // gp<=0 disabled
    expect(shrink(80, 10, 0, 60)).toBe(80);                    // k=0 disabled
    expect(shrink(80, 10, 4, null)).toBe(80);                  // no target
  });

  it("leagueMeanPpm is gp-weighted", () => {
    const players = [
      { gp: 10, pts_per_match: 60 },
      { gp: 30, pts_per_match: 80 },
      { gp: 0, pts_per_match: 100 },   // ignored
    ];
    expect(leagueMeanPpm(players)).toBeCloseTo((10 * 60 + 30 * 80) / 40, 9);
    expect(leagueMeanPpm([])).toBeNull();
  });
});

/* ----------------------- baseline projector ------------------------------ */
describe("projectTotal", () => {
  const p1 = mkPlayer({ name: "A", pts_per_match: 68, win_pct: 60 });
  const p2 = mkPlayer({ name: "B", pts_per_match: 62, win_pct: 40 });

  it("returns null without both players", () => {
    expect(projectTotal(undefined, p2, S, false, null)).toBeNull();
  });

  it("splits total by win% and sums back", () => {
    const pr = projectTotal(p1, p2, S, false, null)!;
    expect(pr.p1_proj + pr.p2_proj).toBeCloseTo(pr.projected, 5);
    expect(pr.p1_proj).toBeGreaterThan(pr.p2_proj);
    expect(pr.sigma).toBeGreaterThan(0);
  });

  it("late-night fatigue lowers the projection", () => {
    const day = projectTotal(p1, p2, S, false, null)!;
    const night = projectTotal(p1, p2, S, true, null)!;
    expect(night.projected).toBeLessThan(day.projected);
    expect(night.fatigue_adj).toBe(S.fatigue);
  });

  it("good form raises the projection", () => {
    const hot = projectTotal(mkPlayer({ recent_form: "WWWWW" }), mkPlayer({ name: "B", recent_form: "WWWWW" }), S, false, null)!;
    const cold = projectTotal(mkPlayer({ recent_form: "LLLLL" }), mkPlayer({ name: "B", recent_form: "LLLLL" }), S, false, null)!;
    expect(hot.projected).toBeGreaterThan(cold.projected);
  });

  it("confidence follows min gp", () => {
    expect(projectTotal(mkPlayer({ gp: 60 }), mkPlayer({ gp: 60 }), S, false, null)!.confidence).toBe("High");
    expect(projectTotal(mkPlayer({ gp: 30 }), mkPlayer({ gp: 60 }), S, false, null)!.confidence).toBe("Med");
    expect(projectTotal(mkPlayer({ gp: 5 }), mkPlayer({ gp: 60 }), S, false, null)!.confidence).toBe("Low");
  });

  it("shrinkage pulls a low-sample outlier toward the league mean", () => {
    const rookie = mkPlayer({ pts_per_match: 90, gp: 2 });
    const noShrink = projectTotal(rookie, p2, { ...S, shrinkK: 0 }, false, { leagueMean: 65 })!;
    const shrunk = projectTotal(rookie, p2, { ...S, shrinkK: 8 }, false, { leagueMean: 65 })!;
    expect(shrunk.projected).toBeLessThan(noShrink.projected);
  });
});

describe("probOver", () => {
  it("is monotone in the line with continuity correction", () => {
    const pLo = probOver(130, 12, 120)!;
    const pHi = probOver(130, 12, 140)!;
    expect(pLo).toBeGreaterThan(pHi);
    expect(probOver(130, 0, 130)).toBeNull();                 // zero sigma guarded
    expect(probOver(130, 12, "")).toBeNull();
    // integer line uses +0.5 cc: P(over 130) < P(over 129.5) at proj 130
    expect(probOver(130, 12, 130)!).toBeLessThan(probOver(130, 12, 129.5)!);
  });
});

/* ----------------------- win probability --------------------------------- */
describe("winProb", () => {
  it("is proportional to win% and adjusted by form/h2h", () => {
    const a = mkPlayer({ win_pct: 60, recent_form: "" });
    const b = mkPlayer({ name: "B", win_pct: 40, recent_form: "" });
    const wp = winProb(a, b);
    expect(wp.baseWp).toBeCloseTo(60, 5);
    expect(winProb(a, b, 1).adjusted).toBeLessThan(wp.adjusted);  // h2h dominance of B penalizes A
  });

  it("clamps to 5–95", () => {
    const strong = mkPlayer({ win_pct: 99, recent_form: "WWWWW" });
    const weak = mkPlayer({ name: "B", win_pct: 1, recent_form: "LLLLL" });
    expect(winProb(strong, weak).adjusted).toBeLessThanOrEqual(95);
    expect(winProb(weak, strong).adjusted).toBeGreaterThanOrEqual(5);
  });
});

describe("h2hDominance", () => {
  const matches: MatchResult[] = [
    { id: "1", date: "2026-01-01", player1: "A", player2: "B", score1: 60, score2: 70, total: 130 },
    { id: "2", date: "2026-01-02", player1: "B", player2: "A", score1: 71, score2: 61, total: 132 },
    { id: "3", date: "2026-01-03", player1: "A", player2: "C", score1: 60, score2: 50, total: 110 },
  ];
  it("measures dominance of p2 over p1 in shared games only", () => {
    expect(h2hDominance("A", "B", matches)).toBe(1);   // B won both meetings
    expect(h2hDominance("B", "A", matches)).toBe(-1);
    expect(h2hDominance("A", "D", matches)).toBe(0);   // never met
  });
});

/* ----------------------- rating model ------------------------------------ */
describe("ratings model", () => {
  it("cold start predicts league mean and marks players unseen", () => {
    const R = makeRatings(S);
    expect(R.leagueMean()).toBeNull();
    expect(R.seen("X")).toBe(false);
    const pr = R.predict("X", "T1", "Y", "T2");
    expect(pr.total).toBe(0); // no data yet: m=0, all ratings 0
  });

  it("learns offense/defense from results (convergence)", () => {
    const R = makeRatings(S);
    // A consistently outscores B 70-50 across many games
    for (let i = 0; i < 200; i++) R.update("A", "TA", "B", "TB", 70, 50);
    const pr = R.predict("A", "TA", "B", "TB");
    expect(pr.sA).toBeGreaterThan(pr.sB);
    expect(pr.sA).toBeCloseTo(70, 0);
    expect(pr.sB).toBeCloseTo(50, 0);
    expect(R.ratingOf("A").off).toBeGreaterThan(0);
    expect(R.seen("A")).toBe(true);
  });

  it("is leakage-free: predict before update never sees the current result", () => {
    const R = makeRatings(S);
    const before = R.predict("A", "", "B", "");
    R.update("A", "", "B", "", 90, 10);
    const after = R.predict("A", "", "B", "");
    expect(before.total).toBe(0);
    expect(after.total).not.toBe(before.total);
  });

  it("decay shrinks ratings toward zero", () => {
    const noDecay = makeRatings({ ...S, ratingDecay: 0 });
    const decayed = makeRatings({ ...S, ratingDecay: 0.5 });
    for (let i = 0; i < 10; i++) {
      noDecay.update("A", "", "B", "", 80, 40);
      decayed.update("A", "", "B", "", 80, 40);
    }
    expect(Math.abs(decayed.ratingOf("A").off)).toBeLessThan(Math.abs(noDecay.ratingOf("A").off));
  });

  it("buildRatingsModel trains over a game list", () => {
    const R = buildRatingsModel(
      [{ p1: "A", t1: "TA", p2: "B", t2: "TB", s1: 66, s2: 60 }],
      S,
    );
    expect(R.seen("A")).toBe(true);
    expect(R.leagueMean()).toBeCloseTo(63, 5);
  });
});

describe("computeProjection", () => {
  const p1 = mkPlayer({ name: "A" });
  const p2 = mkPlayer({ name: "B" });

  it("uses the rating model when selected and both players seen", () => {
    const ratings = buildRatingsModel(
      Array.from({ length: 30 }, () => ({ p1: "A", t1: "", p2: "B", t2: "", s1: 70, s2: 60 })),
      S,
    );
    const pr = computeProjection(p1, p2, { ...S, modelMode: "rated" }, false, { ratings, team1: "", team2: "" })!;
    expect(pr.rated).toBe(true);
    expect(pr.projected).toBeCloseTo(130, 0);
  });

  it("falls back to baseline when a player is unseen", () => {
    const ratings = makeRatings(S);
    const pr = computeProjection(p1, p2, { ...S, modelMode: "rated" }, false, { ratings, leagueMean: 65 })!;
    expect(pr.rated).toBeUndefined();
  });

  it("uses baseline when modelMode is baseline", () => {
    const pr = computeProjection(p1, p2, { ...S, modelMode: "baseline" }, false, { leagueMean: 65 })!;
    expect(pr.rated).toBeUndefined();
  });
});

/* ----------------------- margin ratio + keys ----------------------------- */
describe("marginRatioFrom", () => {
  it("defaults to 1.0 below the sample floor", () => {
    expect(marginRatioFrom([])).toBe(1.0);
    expect(marginRatioFrom(Array(11).fill({ score1: 60, score2: 60 }))).toBe(1.0);
  });

  it("is clamped to [0.5, 1.6] and guards zero total variance", () => {
    // near-constant totals, huge alternating margins -> ratio blows up, clamps to 1.6
    const wild = Array.from({ length: 20 }, (_, i) => (i % 2 ? { score1: 91, score2: 30 } : { score1: 30, score2: 90 }));
    expect(marginRatioFrom(wild)).toBe(1.6);
    // zero total variance is guarded to 1.0
    const flat = Array.from({ length: 20 }, (_, i) => (i % 2 ? { score1: 90, score2: 30 } : { score1: 30, score2: 90 }));
    expect(marginRatioFrom(flat)).toBe(1.0);
  });
});

describe("dedup keys", () => {
  it("matchKey / wfKey are case-insensitive on names", () => {
    const a = { date: "2026-01-01", player1: "Foo", player2: "Bar", score1: 60, score2: 61 };
    const b = { ...a, player1: "FOO", player2: "bar" };
    expect(matchKey(a)).toBe(matchKey(b));
    expect(wfKey(a)).toBe(wfKey(b));
    expect(matchKey({ ...a, score1: 61 })).not.toBe(matchKey(a));
  });
});

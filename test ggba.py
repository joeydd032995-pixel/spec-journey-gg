#!/usr/bin/env python3
"""
test_ggba.py — test suite for the GG League analytics model (ggba_model.py).
Stdlib unittest only:  python3 -m unittest test_ggba -v   (or: python3 test_ggba.py)

Covers every current pure component: math core, odds/EV/Kelly, de-vig + line
shopping + CLV, the empirical-Bayes shrink, the baseline projector, the online
opponent+team rating model (incl. leakage-freeness and convergence), and the
end-to-end walk-forward / soft-book acceptance gates.
"""
import math
import unittest
import ggba_model as G


class TestMathCore(unittest.TestCase):
    def test_norm_cdf(self):
        self.assertAlmostEqual(G.norm_cdf(0), 0.5, places=6)
        self.assertAlmostEqual(G.norm_cdf(1.96), 0.975, places=3)
        self.assertAlmostEqual(G.norm_cdf(-1.96), 0.025, places=3)
        self.assertAlmostEqual(G.norm_cdf(2) + G.norm_cdf(-2), 1.0, places=6)

    def test_prob_over_monotone_and_continuity(self):
        p_lo = G.prob_over(130, 12, 120)
        p_hi = G.prob_over(130, 12, 140)
        self.assertGreater(p_lo, p_hi)               # higher line -> lower P(over)
        self.assertTrue(0 < p_hi < p_lo < 1)
        self.assertIsNone(G.prob_over(130, 0, 130))  # zero sigma guarded
        # integer line uses 0.5 continuity correction: P(over 130) < P(over 129.5) at proj 130
        self.assertLess(G.prob_over(130, 12, 130), G.prob_over(130, 12, 129.5))

    def test_pearson(self):
        self.assertAlmostEqual(G.pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1.0, places=6)
        self.assertAlmostEqual(G.pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1.0, places=6)
        self.assertIsNone(G.pearson([1, 1, 1], [1, 2, 3]))   # zero variance
        self.assertIsNone(G.pearson([1], [1]))               # too few


class TestOdds(unittest.TestCase):
    def test_implied(self):
        self.assertAlmostEqual(G.american_to_implied(-110), 110/210, places=6)
        self.assertAlmostEqual(G.american_to_implied(100), 0.5, places=6)
        self.assertAlmostEqual(G.american_to_implied(150), 0.4, places=6)
        self.assertAlmostEqual(G.american_to_implied(-200), 2/3, places=6)
        self.assertIsNone(G.american_to_implied(0))

    def test_payout_and_decimal(self):
        self.assertAlmostEqual(G.payout_mult(-110), 100/110, places=6)
        self.assertAlmostEqual(G.payout_mult(150), 1.5, places=6)
        self.assertAlmostEqual(G.decimal_odds(100), 2.0, places=6)
        self.assertAlmostEqual(G.decimal_odds(-110), 1 + 100/110, places=6)

    def test_ev_and_kelly(self):
        # at the break-even prob, EV and Kelly are ~0
        impl = G.american_to_implied(-110)
        self.assertAlmostEqual(G.ev_per_unit(impl, -110), 0.0, places=6)
        self.assertAlmostEqual(G.full_kelly(impl, -110), 0.0, places=6)
        # an edge -> positive EV and positive Kelly fraction
        self.assertGreater(G.ev_per_unit(0.60, -110), 0)
        self.assertGreater(G.full_kelly(0.60, -110), 0)
        # negative edge -> negative
        self.assertLess(G.ev_per_unit(0.45, -110), 0)


class TestDevigLineShopCLV(unittest.TestCase):
    def test_devig_sums_to_one(self):
        p, q = G.devig_two_way(-110, -110)
        self.assertAlmostEqual(p, 0.5, places=6)
        self.assertAlmostEqual(p + q, 1.0, places=9)
        p2, q2 = G.devig_two_way(-200, 170)
        self.assertAlmostEqual(p2 + q2, 1.0, places=9)
        self.assertGreater(p2, q2)                   # favorite has higher fair prob

    def test_best_price(self):
        quotes = [
            {"book": "A", "over": -110, "under": -110},
            {"book": "B", "over": +105, "under": -125},   # best over here
            {"book": "C", "over": -120, "under": +100},   # best under here
        ]
        bp = G.best_price(quotes)
        self.assertEqual(bp["best_over"][1], +105)
        self.assertEqual(bp["best_over"][2], "B")
        self.assertEqual(bp["best_under"][1], +100)
        self.assertEqual(bp["best_under"][2], "C")
        self.assertTrue(0 < bp["consensus_over"] < 1)

    def test_clv_beats_close(self):
        # took +120 (dec 2.2); fair close 0.5 -> CLV = 0.5*2.2-1 = +0.10
        self.assertAlmostEqual(G.clv_ev(+120, -110, -110), 0.10, places=6)
        self.assertTrue(G.beat_close(+120, -110, -110))
        # took -150 (dec 1.667); fair close 0.5 -> negative CLV
        self.assertLess(G.clv_ev(-150, -110, -110), 0)
        self.assertFalse(G.beat_close(-150, -110, -110))
        # exactly fair (+100 vs fair 0.5) -> ~0
        self.assertAlmostEqual(G.clv_ev(+100, -110, -110), 0.0, places=6)

    def test_clv_single_sided_fallback(self):
        # only one closing price given -> uses vigged implied
        c = G.clv_ev(+100, -110)         # p_close=0.5238, dec_taken=2.0 -> +0.0476
        self.assertAlmostEqual(c, 0.5238095 * 2 - 1, places=5)

    def test_clv_summary(self):
        bets = [
            {"odds_taken": +120, "close_side": -110, "close_other": -110},  # +CLV
            {"odds_taken": -150, "close_side": -110, "close_other": -110},  # -CLV
        ]
        s = G.clv_summary(bets)
        self.assertEqual(s["n"], 2)
        self.assertAlmostEqual(s["beat_close_rate"], 50.0, places=6)


class TestShrink(unittest.TestCase):
    def test_shrink_behaviour(self):
        self.assertEqual(G.shrink(80, 30, 0, 65), 80)        # k=0 disables
        self.assertEqual(G.shrink(80, 0, 4, 65), 80)         # gp=0 -> raw (no info to shrink)
        self.assertAlmostEqual(G.shrink(80, 4, 4, 60), 70, places=6)   # gp=k -> midpoint
        near = G.shrink(80, 100, 4, 60)
        self.assertTrue(76 < near <= 80)                     # large gp -> near raw


class TestBaselineProjector(unittest.TestCase):
    S = {"formCoef": 0.10, "matchupCoef": 0.05, "fatigue": 0.92, "variance": 1.00,
         "dispersion": 1.20, "shrinkK": 0}

    def p(self, ppm, form="", gp=50):
        return {"pts_per_match": ppm, "gp": gp, "recent_form": form, "win_pct": 50, "steals": 0, "fouls": 0}

    def test_unbiased_base(self):
        r = G.project_total(self.p(65), self.p(70), self.S)
        self.assertAlmostEqual(r["base"], 135, places=6)
        self.assertAlmostEqual(r["projected"], 135, places=6)   # neutral adjustments
        self.assertAlmostEqual(r["sigma"], math.sqrt(135 * 1.2), places=6)

    def test_variance_scales(self):
        s = dict(self.S, variance=0.90)
        r = G.project_total(self.p(65), self.p(65), s)
        self.assertAlmostEqual(r["projected"], round(130 * 0.90, 1), places=6)

    def test_form_direction(self):
        hot = G.project_total(self.p(65, "WWWWW"), self.p(65, "WWWWW"), self.S)["projected"]
        cold = G.project_total(self.p(65, "LLLLL"), self.p(65, "LLLLL"), self.S)["projected"]
        self.assertGreater(hot, 130)
        self.assertLess(cold, 130)


class TestRatingModel(unittest.TestCase):
    def test_new_entities_start_at_league_mean(self):
        R = G.OnlineRatings()
        sA, sB, total = R.predict("X", "TX", "Y", "TY")
        self.assertEqual(total, 0.0)                 # no games yet -> m=0
        R.update("X", "TX", "Y", "TY", 70, 60)
        self.assertAlmostEqual(R.league_mean(), 65.0, places=6)
        sA2, sB2, total2 = R.predict("Z", "TZ", "W", "TW")   # brand-new -> league mean each
        self.assertAlmostEqual(total2, 130.0, places=6)

    def test_additivity_and_leakage_free(self):
        R = G.OnlineRatings()
        for _ in range(5):
            R.update("A", "T1", "B", "T2", 72, 64)
        sA, sB, total = R.predict("A", "T1", "B", "T2")
        self.assertAlmostEqual(sA + sB, total, places=9)
        # predicting does not mutate state (leakage-free): two predicts identical
        self.assertEqual(R.predict("A", "T1", "B", "T2"), (sA, sB, total))

    def test_convergence_on_structured_data(self):
        games = G._synthetic(n_games=4000, seed=11)
        rated, base, _ = G.walk_forward(games)
        acc = G.accuracy(rated)
        self.assertGreater(acc["r"], 0.5)            # recovers injected structure
        self.assertLess(acc["mae"], 12)
        self.assertLess(abs(acc["bias"]), 1.0)


class TestAcceptanceGates(unittest.TestCase):
    """The /loop gates: positive correlation, win% > break-even, +EV, accuracy."""
    @classmethod
    def setUpClass(cls):
        cls.games = G._synthetic(n_games=5200, seed=7)
        cls.rated, cls.base, _ = G.walk_forward(cls.games)
        cls.sb = G.soft_book_backtest(cls.games)
        cls.breakeven = G.american_to_implied(-110) * 100  # 52.38

    def test_positive_correlation_beats_baseline(self):
        ar, ab = G.accuracy(self.rated), G.accuracy(self.base)
        self.assertGreater(ar["r"], 0)
        self.assertGreaterEqual(ar["r"], ab["r"])

    def test_accuracy_beats_baseline(self):
        ar, ab = G.accuracy(self.rated), G.accuracy(self.base)
        self.assertLess(ar["mae"], ab["mae"])

    def test_positive_ev_beats_baseline(self):
        self.assertGreater(self.sb["rate"]["roi_pct"], 0)
        self.assertGreater(self.sb["rate"]["roi_pct"], self.sb["base"]["roi_pct"])

    def test_win_pct_above_breakeven(self):
        self.assertGreater(self.sb["rate"]["win_pct"], self.breakeven)

    def test_calibration_reasonable(self):
        cal = G.calibration(self.rated)
        self.assertTrue(0 <= cal["ece"] <= 1)
        self.assertLess(cal["ece"], 0.05)           # well-calibrated on the benchmark


if __name__ == "__main__":
    unittest.main(verbosity=2)

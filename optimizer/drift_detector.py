#!/usr/bin/env python3
"""
drift_detector.py — Distribution shift (concept drift) detection for the
GGBA Optimizer pipeline.

Implements a pure-Python two-sample Kolmogorov-Smirnov test and helpers that
detect scoring and feature-level drift between a reference period and a current
sliding window. No scipy or numpy required — only the standard library.

KS test overview
----------------
Given two samples S1 and S2, the KS statistic D is the maximum absolute
difference between their empirical CDFs evaluated at every point in the pooled
sample:

    D = max_x |F1(x) - F2(x)|

The p-value is approximated from the asymptotic KS distribution:

    p ≈ 2 * exp(-2 * n_eff * D^2),  where n_eff = n1*n2 / (n1+n2)

A p-value below alpha (default 0.05) indicates a statistically significant
shift in distribution.
"""
from __future__ import annotations

import math
import statistics
from typing import Optional


# ---------------------------------------------------------------------------
# KS test (pure Python)
# ---------------------------------------------------------------------------

def ks_statistic(
    sample1: list[float],
    sample2: list[float],
) -> tuple[float, float]:
    """Two-sample Kolmogorov-Smirnov test.

    Parameters
    ----------
    sample1, sample2:
        Numeric samples to compare.  Need not be the same length.

    Returns
    -------
    (D_statistic, p_value)
        D – the KS statistic (0 … 1).
        p – approximate two-sided p-value.
        p < 0.05 indicates a statistically significant distribution shift.

    Notes
    -----
    If either sample is empty the function returns (0.0, 1.0) — no test
    can be performed, so we conservatively assume no drift.
    """
    n1 = len(sample1)
    n2 = len(sample2)

    if n1 == 0 or n2 == 0:
        return 0.0, 1.0

    # Sort both samples and build the merged (unique) evaluation grid.
    sorted1 = sorted(sample1)
    sorted2 = sorted(sample2)

    # Walk both sorted arrays in lock-step, tracking the CDF of each.
    i, j = 0, 0
    max_diff = 0.0

    while i < n1 or j < n2:
        # Determine the current x value (the next step in either CDF).
        if i < n1 and (j >= n2 or sorted1[i] <= sorted2[j]):
            x = sorted1[i]
        else:
            x = sorted2[j]

        # Advance past all occurrences of x in each sample.
        while i < n1 and sorted1[i] <= x:
            i += 1
        while j < n2 and sorted2[j] <= x:
            j += 1

        f1 = i / n1
        f2 = j / n2
        diff = abs(f1 - f2)
        if diff > max_diff:
            max_diff = diff

    D = max_diff

    # Approximate p-value using the asymptotic KS distribution.
    n_eff = (n1 * n2) / (n1 + n2)

    if D == 0.0:
        p_value = 1.0
    else:
        # Two-sided p-value approximation: p ≈ 2*exp(-2*n_eff*D^2)
        exponent = -2.0 * n_eff * D * D
        if exponent < -700:
            p_value = 0.0
        else:
            p_value = 2.0 * math.exp(exponent)
            p_value = min(p_value, 1.0)

    return D, p_value


# ---------------------------------------------------------------------------
# Score-level drift
# ---------------------------------------------------------------------------

def detect_score_drift(
    reference_scores: list[float],
    current_scores: list[float],
    alpha: float = 0.05,
) -> dict:
    """Compare score distributions between a reference period and a current window.

    Parameters
    ----------
    reference_scores:
        Historical/reference score values.
    current_scores:
        Recent/current score values.
    alpha:
        Significance level for the KS test (default 0.05).

    Returns
    -------
    dict with keys:
        drift_detected  – bool, True when p_value < alpha
        ks_stat         – float, KS D statistic
        p_value         – float
        reference_mean  – float (nan if empty)
        current_mean    – float (nan if empty)
        mean_shift      – float, current_mean - reference_mean
        reference_std   – float (nan if empty / single element)
        current_std     – float (nan if empty / single element)
    """
    D, p_value = ks_statistic(reference_scores, current_scores)
    drift_detected = p_value < alpha

    def _mean(lst: list[float]) -> float:
        return statistics.mean(lst) if lst else float("nan")

    def _std(lst: list[float]) -> float:
        if len(lst) < 2:
            return float("nan")
        return statistics.stdev(lst)

    ref_mean = _mean(reference_scores)
    cur_mean = _mean(current_scores)
    mean_shift = cur_mean - ref_mean if (reference_scores and current_scores) else float("nan")

    return {
        "drift_detected": drift_detected,
        "ks_stat": D,
        "p_value": p_value,
        "reference_mean": ref_mean,
        "current_mean": cur_mean,
        "mean_shift": mean_shift,
        "reference_std": _std(reference_scores),
        "current_std": _std(current_scores),
    }


# ---------------------------------------------------------------------------
# Feature-level drift
# ---------------------------------------------------------------------------

_DEFAULT_FEATURES = ["score1", "score2", "actual_total"]


def detect_feature_drift(
    reference_games: list[dict],
    current_games: list[dict],
    features: Optional[list[str]] = None,
) -> dict:
    """Run a KS test on each numeric feature between two sets of game records.

    Parameters
    ----------
    reference_games, current_games:
        Lists of game dicts, each containing numeric feature values.
    features:
        Feature names to test.  Defaults to ['score1', 'score2', 'actual_total'].

    Returns
    -------
    dict mapping feature_name -> detect_score_drift result dict for that feature.

    Missing or non-numeric values are silently skipped (the game is excluded
    from that feature's sample).
    """
    if features is None:
        features = _DEFAULT_FEATURES

    results: dict = {}
    for feat in features:
        ref_vals: list[float] = []
        for g in reference_games:
            v = g.get(feat)
            try:
                ref_vals.append(float(v))
            except (TypeError, ValueError):
                pass

        cur_vals: list[float] = []
        for g in current_games:
            v = g.get(feat)
            try:
                cur_vals.append(float(v))
            except (TypeError, ValueError):
                pass

        results[feat] = detect_score_drift(ref_vals, cur_vals)

    return results

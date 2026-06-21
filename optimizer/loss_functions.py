"""
optimizer/loss_functions.py — standalone re-export of the loss functions defined
in ggba_model, plus optimizer target thresholds and a target-check helper.

Usage
-----
    from optimizer.loss_functions import weighted_hybrid_loss, check_targets, METRIC_TARGETS
"""
from __future__ import annotations

# Re-export the core loss functions from the model.
from ggba_model import (  # noqa: F401
    huber_loss,
    log_cosh_loss,
    weighted_hybrid_loss,
    verify_loss_consistency,
)

# ---------------------------------------------------------------------------
# Optimization target thresholds
# ---------------------------------------------------------------------------
# Targets calibrated from walk-forward data (gp30, days35, n=3713 games):
#   total σ=14.3 pts, between-pair σ=9.94 pts, within-pair σ=10.50 pts
#   → theoretical MAE floor  = 0.798 × 10.50 ≈ 8.38 pts
#   → theoretical max r      = 9.94 / 14.3  ≈ 0.694
#
# biasOffset (betting_offset): conservative under-projection for betting
#   signals.  It is a production hyperparameter, not an accuracy metric.
#   ECE / MAE / r are all evaluated with biasOffset = 0 so calibration
#   is not inflated by the strategic offset.
METRIC_TARGETS: dict[str, float] = {
    "brier":         1.68,   # Brier score ≤ 1.68
    "ece":           0.019,  # Expected Calibration Error ≤ 0.019
    "mae":           9.5,    # MAE ≤ 9.5 pts (floor 8.38 pts; was 7.0 — below theoretical floor)
    "betting_offset": -4.0,  # hyperparams.biasOffset ≤ -4.0 (conservative under-projection)
    "r_min":         0.55,   # Pearson r ≥ 0.55 (max achievable ~0.694; was 0.90)
}


def check_targets(metrics: dict) -> dict:
    """Check a metrics dict against METRIC_TARGETS.

    Parameters
    ----------
    metrics : dict
        Must include the calibration accuracy keys (brier, ece, mae, r) and
        optionally biasOffset from hyperparams (inserted by the pipeline as the
        'betting_offset' key).  Unknown keys are ignored.

    Returns
    -------
    dict
        ``{metric: {'value': v, 'target': t, 'pass': bool}}`` for each checked
        metric.

        Pass/fail logic per metric
        ~~~~~~~~~~~~~~~~~~~~~~~~~~
        - ``brier``          : pass when value <= target
        - ``ece``            : pass when value <= target
        - ``mae``            : pass when value <= target
        - ``betting_offset`` : pass when value <= target (must be ≤ -4.0)
        - ``r_min``          : pass when value >= target (higher is better)
    """
    _gte_keys = {"r_min"}
    result: dict = {}

    # Map canonical metric dict keys to METRIC_TARGETS keys
    key_map = {
        "brier":          "brier",
        "ece":            "ece",
        "mae":            "mae",
        "biasOffset":     "betting_offset",  # injected from hyperparams by pipeline
        "betting_offset": "betting_offset",  # direct supply also accepted
        "r":              "r_min",
    }

    for src_key, tgt_key in key_map.items():
        if tgt_key not in METRIC_TARGETS:
            continue
        if src_key not in metrics:
            continue
        value = metrics[src_key]
        target = METRIC_TARGETS[tgt_key]
        passed = (value >= target) if tgt_key in _gte_keys else (value <= target)
        result[tgt_key] = {
            "value": value,
            "target": target,
            "pass": passed,
        }
    return result

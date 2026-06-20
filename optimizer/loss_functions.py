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
# brier  : Brier score — lower is better (target: ≤ 1.68)
# ece    : Expected Calibration Error — lower is better (target: ≤ 0.019)
# mae    : Mean Absolute Error in points — lower is better (target: ≤ 7.0)
# bias_max : Maximum allowed model bias (projection - actual) -- target: <= -4.0
#            (negative means the model under-projects, which is acceptable;
#             we flag when bias is worse / more positive than this threshold)
METRIC_TARGETS: dict[str, float] = {
    "brier": 1.68,
    "ece": 0.019,
    "mae": 7.0,
    "bias_max": -4.0,
}


def check_targets(metrics: dict) -> dict:
    """Check a metrics dict against METRIC_TARGETS.

    Parameters
    ----------
    metrics : dict
        Keys that match METRIC_TARGETS are evaluated; unknown keys are ignored.

    Returns
    -------
    dict
        ``{metric: {'value': v, 'target': t, 'pass': bool}}`` for each metric
        that appears in both *metrics* and METRIC_TARGETS.

        Pass/fail logic per metric
        ~~~~~~~~~~~~~~~~~~~~~~~~~~
        - ``brier``    : pass when value <= target
        - ``ece``      : pass when value <= target
        - ``mae``      : pass when value <= target
        - ``bias_max`` : pass when value <= target  (bias must not exceed the cap)
    """
    result: dict = {}
    for metric, target in METRIC_TARGETS.items():
        if metric not in metrics:
            continue
        value = metrics[metric]
        result[metric] = {
            "value": value,
            "target": target,
            "pass": value <= target,
        }
    return result

"""
ggba_model.py — thin shim that makes `import ggba_model` work.

The canonical source is 'ggba model.py' (filename with a space, matching the
project convention). This file loads it at import time and re-exports every
public name so test suites and library consumers can do:

    import ggba_model as G

without caring about the space in the source filename.
"""
from __future__ import annotations
import importlib.util
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_src = os.path.join(_here, "ggba model.py")

_spec = importlib.util.spec_from_file_location("ggba_model", _src)
_mod = importlib.util.module_from_spec(_spec)
# Register before exec so @dataclass and other __module__ lookups resolve.
sys.modules["ggba_model"] = _mod
_spec.loader.exec_module(_mod)

# Re-export everything into this module's namespace.
from ggba_model import *  # noqa: F401, F403, E402
from ggba_model import (  # noqa: F401, E402  — explicit for static analysers
    _num,
    _synthetic,
    norm_cdf,
    prob_over,
    form_score,
    shrink,
    project_total,
    pearson,
    american_to_implied,
    payout_mult,
    decimal_odds,
    ev_per_unit,
    full_kelly,
    devig_two_way,
    best_price,
    clv_ev,
    beat_close,
    clv_summary,
    OnlineRatings,
    walk_forward,
    accuracy,
    huber_loss,
    log_cosh_loss,
    weighted_hybrid_loss,
    verify_loss_consistency,
    calibration,
    soft_book_backtest,
    load_csv,
    main,
    CAL_GRID,
)

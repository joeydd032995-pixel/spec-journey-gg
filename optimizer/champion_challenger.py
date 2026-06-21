#!/usr/bin/env python3
"""
champion_challenger.py — Core champion/challenger promotion system for the GGBA Optimizer.

Every optimizer run produces a "challenger" result.  The challenger only replaces the
current champion if it passes a set of strict gating checks:

    1. ROI improvement gate        — challenger ROI must exceed champion ROI by GATE_ROI_MARGIN
    2. MAE improvement gate        — challenger MAE must be lower by at least GATE_MAE_MARGIN
    3. Trade-count gate            — challenger must have at least GATE_MIN_TRADES trades
    4. Calibration gate            — ECE and Brier must not be worse than champion + tolerance
    5. Bootstrap gate              — challenger mean trade-ROI beats champion in >= GATE_BOOTSTRAP_WIN
                                     fraction of GATE_BOOTSTRAP_N bootstrap resamples

All thresholds are configurable via environment variables (see constants below).

Champion JSON schema:
    {
        "version":          int,          # incremented on each promotion
        "created_at":       str (ISO-8601 UTC),
        "updated_at":       str (ISO-8601 UTC),
        "hyperparams":      dict,
        "metrics":          dict,         # mae, brier, ece, bias, correlation, roi_pct, trade_count
        "data_date_range":  {"start": str, "end": str},
        "test_set_dates":   {"start": str, "end": str}   # optional
    }
"""

import json
import os
import random
import statistics
import tempfile
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# File paths
# ---------------------------------------------------------------------------

CHAMPION_PATH = "optimizer/ggba_champion.json"
CHALLENGER_PATH = "optimizer/challenger.json"

# ---------------------------------------------------------------------------
# Gating thresholds (overridable via environment variables)
# ---------------------------------------------------------------------------

GATE_ROI_MARGIN = float(os.environ.get("GGBA_GATE_ROI_MARGIN", "2.0"))
GATE_MAE_MARGIN = float(os.environ.get("GGBA_GATE_MAE_MARGIN", "0.2"))
GATE_MIN_TRADES = int(os.environ.get("GGBA_GATE_MIN_TRADES", "50"))
GATE_ECE_TOL = float(os.environ.get("GGBA_GATE_ECE_TOL", "0.005"))
GATE_BRIER_TOL = float(os.environ.get("GGBA_GATE_BRIER_TOL", "0.05"))
GATE_BOOTSTRAP_N = int(os.environ.get("GGBA_GATE_BOOTSTRAP_N", "1000"))
GATE_BOOTSTRAP_WIN = float(os.environ.get("GGBA_GATE_BOOTSTRAP_WIN", "0.60"))


# ---------------------------------------------------------------------------
# Helper: current UTC timestamp string
# ---------------------------------------------------------------------------

def _now_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Load / save champion
# ---------------------------------------------------------------------------

def load_champion(path: str = CHAMPION_PATH):
    """Load champion JSON.  Returns None if the file does not exist."""
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_champion(champion: dict, path: str = CHAMPION_PATH) -> None:
    """Save champion JSON using an atomic write (temp file + rename)."""
    dir_name = os.path.dirname(path) or "."
    os.makedirs(dir_name, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as fh:
            json.dump(champion, fh, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        # Clean up the temp file if something went wrong before the rename
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Load / save challenger
# ---------------------------------------------------------------------------

def load_challenger(path: str = CHALLENGER_PATH):
    """Load challenger JSON.  Returns None if the file does not exist."""
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def save_challenger(challenger: dict, path: str = CHALLENGER_PATH) -> None:
    """Save challenger JSON using an atomic write (temp file + rename)."""
    dir_name = os.path.dirname(path) or "."
    os.makedirs(dir_name, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as fh:
            json.dump(challenger, fh, indent=2)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# Factory functions
# ---------------------------------------------------------------------------

def make_initial_champion(hyperparams: dict, metrics: dict, data_date_range: dict) -> dict:
    """Create a new champion dict (version=1, no prior champion).

    Parameters
    ----------
    hyperparams:      Dict of model hyperparameters.
    metrics:          Dict of evaluation metrics (mae, brier, ece, bias,
                      correlation, roi_pct, trade_count, …).
    data_date_range:  Dict with 'start' and 'end' date strings covering the
                      full training + test data window.

    Returns
    -------
    dict: Champion record ready to pass to save_champion().
    """
    now = _now_utc()
    return {
        "version": 1,
        "created_at": now,
        "updated_at": now,
        "hyperparams": hyperparams,
        "metrics": metrics,
        "data_date_range": data_date_range,
        "test_set_dates": {},
    }


def produce_challenger(optimizer_result: dict) -> dict:
    """Convert an optimizer run result into challenger.json format.

    The optimizer_result dict is expected to contain at minimum:
        - 'hyperparams': dict
        - 'metrics':     dict
        - 'data_date_range': dict  (optional)
        - 'test_set_dates':  dict  (optional)

    Any additional keys are preserved as-is.

    Returns
    -------
    dict: Challenger record (same shape as champion, but without 'version' /
          'created_at' / 'updated_at' — those are added by promote()).
    """
    challenger = {
        "produced_at": _now_utc(),
        "hyperparams": optimizer_result.get("hyperparams", {}),
        "metrics": optimizer_result.get("metrics", {}),
        "data_date_range": optimizer_result.get("data_date_range", {}),
        "test_set_dates": optimizer_result.get("test_set_dates", {}),
    }
    # Preserve any extra keys the optimizer added
    for key, value in optimizer_result.items():
        if key not in challenger:
            challenger[key] = value
    return challenger


# ---------------------------------------------------------------------------
# Individual gate functions
# ---------------------------------------------------------------------------

def gate_roi(challenger_metrics: dict, champion_metrics: dict):
    """Check ROI improvement gate.

    The challenger's roi_pct must exceed the champion's roi_pct by at least
    GATE_ROI_MARGIN percentage points.

    Returns
    -------
    tuple[bool, str]: (passed, reason_string)
    """
    c_roi = challenger_metrics.get("roi_pct", 0.0)
    ch_roi = champion_metrics.get("roi_pct", 0.0)
    improvement = c_roi - ch_roi
    passed = improvement >= GATE_ROI_MARGIN
    reason = (
        f"ROI gate {'PASS' if passed else 'FAIL'}: "
        f"challenger={c_roi:.2f}%, champion={ch_roi:.2f}%, "
        f"improvement={improvement:.2f}% (need >={GATE_ROI_MARGIN:.2f}%)"
    )
    return passed, reason


def gate_mae(challenger_metrics: dict, champion_metrics: dict):
    """Check MAE improvement gate.

    The challenger's mae must be lower than the champion's mae by at least
    GATE_MAE_MARGIN points.

    Returns
    -------
    tuple[bool, str]: (passed, reason_string)
    """
    c_mae = challenger_metrics.get("mae", float("inf"))
    ch_mae = champion_metrics.get("mae", float("inf"))
    improvement = ch_mae - c_mae
    passed = improvement >= GATE_MAE_MARGIN
    reason = (
        f"MAE gate {'PASS' if passed else 'FAIL'}: "
        f"challenger={c_mae:.4f}, champion={ch_mae:.4f}, "
        f"improvement={improvement:.4f} (need >={GATE_MAE_MARGIN:.4f})"
    )
    return passed, reason


def gate_trade_count(challenger_metrics: dict):
    """Check that the challenger has at least GATE_MIN_TRADES trades.

    Returns
    -------
    tuple[bool, str]: (passed, reason_string)
    """
    count = challenger_metrics.get("trade_count", 0)
    passed = count >= GATE_MIN_TRADES
    reason = (
        f"Trade-count gate {'PASS' if passed else 'FAIL'}: "
        f"challenger has {count} trades (need >={GATE_MIN_TRADES})"
    )
    return passed, reason


def gate_calibration(challenger_metrics: dict, champion_metrics: dict):
    """Check that ECE and Brier are not worse than champion + tolerance.

    The challenger is allowed to be slightly worse on calibration metrics
    (within GATE_ECE_TOL for ECE and GATE_BRIER_TOL for Brier), but any
    degradation beyond those tolerances causes the gate to fail.

    Returns
    -------
    tuple[bool, str]: (passed, reason_string)
    """
    c_ece = challenger_metrics.get("ece", float("inf"))
    ch_ece = champion_metrics.get("ece", float("inf"))
    c_brier = challenger_metrics.get("brier", float("inf"))
    ch_brier = champion_metrics.get("brier", float("inf"))

    ece_ok = c_ece <= ch_ece + GATE_ECE_TOL
    brier_ok = c_brier <= ch_brier + GATE_BRIER_TOL
    passed = ece_ok and brier_ok

    parts = []
    parts.append(
        f"ECE {'OK' if ece_ok else 'FAIL'} "
        f"(challenger={c_ece:.4f}, champion={ch_ece:.4f}, tol={GATE_ECE_TOL:.4f})"
    )
    parts.append(
        f"Brier {'OK' if brier_ok else 'FAIL'} "
        f"(challenger={c_brier:.4f}, champion={ch_brier:.4f}, tol={GATE_BRIER_TOL:.4f})"
    )
    reason = f"Calibration gate {'PASS' if passed else 'FAIL'}: " + "; ".join(parts)
    return passed, reason


def gate_bootstrap(challenger_trades: list, champion_trades: list):
    """Bootstrap resample gate: challenger mean trade-ROI must beat champion in at
    least GATE_BOOTSTRAP_WIN fraction of GATE_BOOTSTRAP_N resamples.

    Parameters
    ----------
    challenger_trades:  List of per-trade profit/loss values (floats).
    champion_trades:    List of per-trade profit/loss values (floats).

    Returns
    -------
    tuple[bool, str]: (passed, reason_string)
    """
    if not challenger_trades or not champion_trades:
        # Cannot perform bootstrap without trade-level data; skip (pass by default)
        return True, "Bootstrap gate SKIP: no trade-level data provided"

    n_c = len(challenger_trades)
    n_ch = len(champion_trades)
    wins = 0
    n_resamples = GATE_BOOTSTRAP_N

    for _ in range(n_resamples):
        sample_c = [random.choice(challenger_trades) for _ in range(n_c)]
        sample_ch = [random.choice(champion_trades) for _ in range(n_ch)]
        if statistics.mean(sample_c) > statistics.mean(sample_ch):
            wins += 1

    win_rate = wins / n_resamples
    passed = win_rate >= GATE_BOOTSTRAP_WIN
    reason = (
        f"Bootstrap gate {'PASS' if passed else 'FAIL'}: "
        f"challenger won {wins}/{n_resamples} resamples "
        f"({win_rate:.2%} vs threshold {GATE_BOOTSTRAP_WIN:.2%})"
    )
    return passed, reason


# ---------------------------------------------------------------------------
# Composite gate runner
# ---------------------------------------------------------------------------

def run_gates(
    challenger: dict,
    champion: dict,
    challenger_trades: list = None,
    champion_trades: list = None,
) -> dict:
    """Run all promotion gates against a challenger/champion pair.

    Parameters
    ----------
    challenger:        Challenger dict (must have 'metrics' key).
    champion:          Champion dict (must have 'metrics' key).
    challenger_trades: Optional list of per-trade P&L floats for the challenger.
    champion_trades:   Optional list of per-trade P&L floats for the champion.

    Returns
    -------
    dict with keys:
        'passed'  — bool, True only if ALL gates pass
        'gates'   — dict mapping gate name -> {'passed': bool, 'reason': str}
        'summary' — human-readable one-liner
    """
    c_metrics = challenger.get("metrics", {})
    ch_metrics = champion.get("metrics", {})

    gate_results = {}

    roi_pass, roi_reason = gate_roi(c_metrics, ch_metrics)
    gate_results["roi"] = {"passed": roi_pass, "reason": roi_reason}

    mae_pass, mae_reason = gate_mae(c_metrics, ch_metrics)
    gate_results["mae"] = {"passed": mae_pass, "reason": mae_reason}

    trade_pass, trade_reason = gate_trade_count(c_metrics)
    gate_results["trade_count"] = {"passed": trade_pass, "reason": trade_reason}

    cal_pass, cal_reason = gate_calibration(c_metrics, ch_metrics)
    gate_results["calibration"] = {"passed": cal_pass, "reason": cal_reason}

    boot_pass, boot_reason = gate_bootstrap(
        challenger_trades or [], champion_trades or []
    )
    gate_results["bootstrap"] = {"passed": boot_pass, "reason": boot_reason}

    all_passed = all(g["passed"] for g in gate_results.values())

    failed_names = [name for name, g in gate_results.items() if not g["passed"]]
    if all_passed:
        summary = "All gates passed — challenger eligible for promotion"
    else:
        summary = f"Gates FAILED: {', '.join(failed_names)}"

    return {
        "passed": all_passed,
        "gates": gate_results,
        "summary": summary,
    }


# ---------------------------------------------------------------------------
# Promote / reject
# ---------------------------------------------------------------------------

def promote(challenger: dict, champion_path: str = CHAMPION_PATH) -> dict:
    """Overwrite the champion file with the challenger, incrementing the version.

    Parameters
    ----------
    challenger:    Challenger dict to be promoted.
    champion_path: Path to the champion JSON file.

    Returns
    -------
    dict: The new champion record (with updated version, created_at, updated_at).
    """
    existing = load_champion(champion_path)
    old_version = existing["version"] if existing else 0
    old_created = existing["created_at"] if existing else _now_utc()

    now = _now_utc()
    new_champion = {
        "version": old_version + 1,
        "created_at": old_created,
        "updated_at": now,
        "hyperparams": challenger.get("hyperparams", {}),
        "metrics": challenger.get("metrics", {}),
        "data_date_range": challenger.get("data_date_range", {}),
        "test_set_dates": challenger.get("test_set_dates", {}),
    }
    save_champion(new_champion, champion_path)
    return new_champion


def reject_and_log(
    challenger: dict,
    gate_result: dict,
    registry_path: str = None,
) -> None:
    """Log a rejected challenger to the experiments registry SQLite DB.

    Parameters
    ----------
    challenger:     Challenger dict that failed promotion.
    gate_result:    Return value of run_gates() for this challenger.
    registry_path:  Path to the experiments registry DB.  Defaults to the
                    module-level REGISTRY_PATH from init_registry.
    """
    # Import here to avoid circular dependency at module level
    from optimizer.init_registry import REGISTRY_PATH as DEFAULT_REGISTRY_PATH
    from optimizer.init_registry import init_registry, log_experiment

    path = registry_path if registry_path is not None else DEFAULT_REGISTRY_PATH

    # Ensure the registry exists before logging
    init_registry(path)

    # Determine current champion version for context
    champion = load_champion()
    champion_version = champion.get("version") if champion else None

    log_experiment(
        params=challenger.get("hyperparams", {}),
        metrics=challenger.get("metrics", {}),
        promoted=False,
        reason=gate_result.get("summary", ""),
        champion_version=champion_version,
        path=path,
    )

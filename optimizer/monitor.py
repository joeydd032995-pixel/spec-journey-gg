#!/usr/bin/env python3
"""
monitor.py — Monitoring service for the GGBA Optimizer pipeline.

Runs periodic health checks on the champion model, computes realized EV,
hit-rate, calibration drift and concept drift, raises alerts, and enqueues
automatic retrain jobs when performance thresholds are breached.

Stores monitoring history in a SQLite database (monitor_log.db) and retrain
jobs in a JSON queue file (retrain_queue.json).

Stdlib only: sqlite3, json, math, statistics, os, datetime, uuid.
"""
from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import statistics
import uuid
from datetime import datetime, timezone
from typing import Optional

_log = logging.getLogger(__name__)

from optimizer.drift_detector import detect_feature_drift

# ---------------------------------------------------------------------------
# Paths & thresholds (overridable via environment variables)
# ---------------------------------------------------------------------------

MONITOR_LOG_PATH: str = "optimizer/monitor_log.db"
RETRAIN_QUEUE_PATH: str = "optimizer/retrain_queue.json"
SHADOW_DB_PATH: str = "optimizer/shadow_log.db"

# 7-day EV below this triggers a retrain alert (default: 0 = break-even)
EV_7D_THRESHOLD: float = float(os.environ.get("GGBA_MON_EV_7D", "0.0"))

# ECE (Expected Calibration Error) multiplier threshold — if rolling ECE is
# this many times the baseline ECE, trigger a calibration-drift alert.
ECE_DRIFT_FACTOR: float = float(os.environ.get("GGBA_MON_ECE_FACTOR", "2.0"))

# Significance level for the KS distribution-shift test.
KS_ALPHA: float = float(os.environ.get("GGBA_MON_KS_ALPHA", "0.05"))

# Break-even win-rate for -110 American odds.
_BREAKEVEN: float = 110.0 / 210.0  # ≈ 0.5238


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def init_monitor_db(path: str = MONITOR_LOG_PATH) -> None:
    """Create (or migrate) the monitor_log SQLite database.

    Creates the ``monitor_runs`` table if it does not already exist.  Safe to
    call repeatedly — uses ``CREATE TABLE IF NOT EXISTS``.

    Schema
    ------
    id              – auto-increment primary key
    run_ts          – ISO-8601 UTC timestamp of the monitoring run
    ev_7d           – realized expected value over the last 7 days
    hit_rate_7d     – win-rate over the last 7 days (0-1 float)
    ece_rolling     – rolling Expected Calibration Error
    ece_baseline    – baseline ECE value used in this run
    drift_detected  – 1 if any feature drift was detected, else 0
    alerts_json     – JSON array of triggered alert dicts
    retrain_enqueued – 1 if a retrain job was enqueued, else 0
    """
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS monitor_runs (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                run_ts           TEXT    NOT NULL,
                ev_7d            REAL,
                hit_rate_7d      REAL,
                ece_rolling      REAL,
                ece_baseline     REAL,
                drift_detected   INTEGER DEFAULT 0,
                alerts_json      TEXT    DEFAULT '[]',
                retrain_enqueued INTEGER DEFAULT 0
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def _log_run(
    ev_7d: Optional[float],
    hit_rate_7d: Optional[float],
    ece_rolling: Optional[float],
    ece_baseline: float,
    drift_detected: bool,
    alerts: list[dict],
    retrain_enqueued: bool,
    path: str = MONITOR_LOG_PATH,
) -> None:
    """Insert one monitoring run into the log database."""
    init_monitor_db(path)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            INSERT INTO monitor_runs
                (run_ts, ev_7d, hit_rate_7d, ece_rolling, ece_baseline,
                 drift_detected, alerts_json, retrain_enqueued)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                datetime.now(timezone.utc).isoformat(),
                ev_7d,
                hit_rate_7d,
                ece_rolling,
                ece_baseline,
                1 if drift_detected else 0,
                json.dumps(alerts),
                1 if retrain_enqueued else 0,
            ),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Shadow DB helpers
# ---------------------------------------------------------------------------

def _open_shadow(path: str) -> Optional[sqlite3.Connection]:
    """Return a SQLite connection to the shadow DB, or None if it doesn't exist."""
    if not os.path.exists(path):
        return None
    try:
        return sqlite3.connect(path)
    except sqlite3.Error:
        return None


def _shadow_schema_ok(conn: sqlite3.Connection) -> bool:
    """Return True if the shadow_predictions table exists."""
    cur = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='shadow_predictions'"
    )
    return cur.fetchone() is not None


# ---------------------------------------------------------------------------
# Realized EV
# ---------------------------------------------------------------------------

def compute_realized_ev(
    window_days: int = 7,
    shadow_path: str = SHADOW_DB_PATH,
) -> dict:
    """Compute rolling expected value from settled shadow predictions.

    Expects a ``shadow_predictions`` table with columns:
        champion_pnl     – profit/loss per bet (negative for losses)
        champion_outcome – outcome string: ``'win'``, ``'loss'``, or ``'pending'``
        logged_at        – ISO-8601 timestamp when the prediction was logged

    Returns
    -------
    {
        ev_7d:        float – mean profit-per-unit over the window
        bets:         int   – number of settled bets in the window
        window_start: str   – ISO-8601 start of window
        window_end:   str   – ISO-8601 end of window
    }

    If the shadow DB does not exist or contains no settled bets in the window,
    returns ev_7d=0.0 and bets=0 (graceful fallback).
    """
    now = datetime.now(timezone.utc)
    # Go back window_days days from today (inclusive today)
    window_start_ts = now.timestamp() - window_days * 86400.0
    window_start = datetime.fromtimestamp(window_start_ts, tz=timezone.utc).isoformat()
    window_end = now.isoformat()

    conn = _open_shadow(shadow_path)
    if conn is None:
        return {"ev_7d": 0.0, "bets": 0, "window_start": window_start, "window_end": window_end}

    try:
        if not _shadow_schema_ok(conn):
            return {"ev_7d": 0.0, "bets": 0, "window_start": window_start, "window_end": window_end}

        cur = conn.execute(
            """
            SELECT champion_pnl
            FROM shadow_predictions
            WHERE champion_outcome IN ('win', 'loss')
              AND logged_at >= ?
              AND logged_at <= ?
            """,
            (window_start, window_end),
        )
        rows = cur.fetchall()
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()

    if not rows:
        return {"ev_7d": 0.0, "bets": 0, "window_start": window_start, "window_end": window_end}

    profits = [float(r[0]) if r[0] is not None else 0.0 for r in rows]

    ev_7d = statistics.mean(profits)
    return {
        "ev_7d": ev_7d,
        "bets": len(profits),
        "window_start": window_start,
        "window_end": window_end,
    }


# ---------------------------------------------------------------------------
# Hit rate
# ---------------------------------------------------------------------------

def compute_hit_rate(
    window_days: int = 7,
    shadow_path: str = SHADOW_DB_PATH,
) -> dict:
    """Compute rolling hit rate vs break-even (52.38% at -110 odds).

    Expects the ``shadow_predictions`` table with columns ``champion_outcome``
    (``'win'`` or ``'loss'``) and ``logged_at``.

    Returns
    -------
    {
        hit_rate:        float – fraction of bets won in the window (0-1)
        bets:            int   – number of settled bets
        breakeven:       float – break-even win rate (110/210 ≈ 0.5238)
        above_breakeven: bool  – True when hit_rate > breakeven
    }

    Gracefully returns hit_rate=0.0 and bets=0 when the DB is unavailable.
    """
    now = datetime.now(timezone.utc)
    window_start_ts = now.timestamp() - window_days * 86400.0
    window_start = datetime.fromtimestamp(window_start_ts, tz=timezone.utc).isoformat()
    window_end = now.isoformat()

    conn = _open_shadow(shadow_path)
    if conn is None:
        return {
            "hit_rate": 0.0,
            "bets": 0,
            "breakeven": _BREAKEVEN,
            "above_breakeven": False,
        }

    try:
        if not _shadow_schema_ok(conn):
            return {
                "hit_rate": 0.0,
                "bets": 0,
                "breakeven": _BREAKEVEN,
                "above_breakeven": False,
            }

        cur = conn.execute(
            """
            SELECT champion_outcome
            FROM shadow_predictions
            WHERE champion_outcome IN ('win', 'loss')
              AND logged_at >= ?
              AND logged_at <= ?
            """,
            (window_start, window_end),
        )
        rows = [(1 if r[0] == 'win' else 0,) for r in cur.fetchall()]
    except sqlite3.Error:
        rows = []
    finally:
        conn.close()

    if not rows:
        return {
            "hit_rate": 0.0,
            "bets": 0,
            "breakeven": _BREAKEVEN,
            "above_breakeven": False,
        }

    wins = sum(r[0] for r in rows)
    hit_rate = wins / len(rows)
    return {
        "hit_rate": hit_rate,
        "bets": len(rows),
        "breakeven": _BREAKEVEN,
        "above_breakeven": hit_rate > _BREAKEVEN,
    }


# ---------------------------------------------------------------------------
# Calibration drift
# ---------------------------------------------------------------------------

def _ece_from_games(
    games: list[dict],
    n_bins: int = 10,
    dispersion: float = 1.20,
    edge_thresh: float = 0.03,
) -> float:
    """Compute Expected Calibration Error (ECE) from a list of game prediction records.

    Each game dict is expected to contain:
        prob_over  – model probability for the over  (0–1)
        actual_over – 1 if the over hit, 0 otherwise

    Games missing these fields are skipped.  Returns 0.0 if no games are usable.

    The ECE is the weighted average of |accuracy - confidence| across equally-
    spaced confidence bins.
    """
    calibration_pts: list[tuple[float, int]] = []
    for g in games:
        prob = g.get("prob_over")
        actual = g.get("actual_over")
        if prob is None or actual is None:
            continue
        try:
            prob = float(prob)
            actual = int(actual)
        except (TypeError, ValueError):
            continue
        if not (0.0 <= prob <= 1.0):
            continue
        calibration_pts.append((prob, actual))

    if not calibration_pts:
        return 0.0

    # Bin edges: [0, 1/n_bins, 2/n_bins, ..., 1]
    bin_size = 1.0 / n_bins
    ece = 0.0
    n_total = len(calibration_pts)

    for b in range(n_bins):
        lo = b * bin_size
        hi = (b + 1) * bin_size
        # Include the upper bound for the last bin.
        if b == n_bins - 1:
            bin_pts = [(p, a) for p, a in calibration_pts if lo <= p <= hi]
        else:
            bin_pts = [(p, a) for p, a in calibration_pts if lo <= p < hi]

        if not bin_pts:
            continue

        avg_confidence = sum(p for p, _ in bin_pts) / len(bin_pts)
        avg_accuracy = sum(a for _, a in bin_pts) / len(bin_pts)
        ece += (len(bin_pts) / n_total) * abs(avg_accuracy - avg_confidence)

    return ece


def compute_calibration_drift(
    baseline_ece: float,
    recent_games: list[dict],
    dispersion: float = 1.20,
    edge_thresh: float = 0.03,
) -> dict:
    """Compute rolling ECE on recent predictions and compare to baseline.

    Parameters
    ----------
    baseline_ece:
        The ECE recorded during initial model training/validation.
    recent_games:
        List of game dicts with 'prob_over' and 'actual_over' fields.
    dispersion, edge_thresh:
        Passed through to internal ECE calculation (reserved for future use).

    Returns
    -------
    {
        rolling_ece:  float – ECE computed on recent_games
        baseline_ece: float – the baseline ECE passed in
        drift_factor: float – rolling_ece / baseline_ece  (inf if baseline=0)
        drifted:      bool  – True when drift_factor >= ECE_DRIFT_FACTOR
    }
    """
    rolling_ece = _ece_from_games(recent_games, dispersion=dispersion, edge_thresh=edge_thresh)

    if baseline_ece <= 0.0:
        drift_factor = math.inf if rolling_ece > 0 else 0.0
    else:
        drift_factor = rolling_ece / baseline_ece

    return {
        "rolling_ece": rolling_ece,
        "baseline_ece": baseline_ece,
        "drift_factor": drift_factor,
        "drifted": drift_factor >= ECE_DRIFT_FACTOR,
    }


# ---------------------------------------------------------------------------
# Alert thresholds
# ---------------------------------------------------------------------------

def check_thresholds(
    ev_result: dict,
    hit_rate_result: dict,
    calibration_result: dict,
    drift_result: dict,
) -> list[dict]:
    """Check monitoring results against configured thresholds.

    Returns a list of triggered alert dicts.  Each alert has:
        type      – 'ev_negative' | 'ece_doubled' | 'concept_drift' | 'hit_rate_low'
        severity  – 'warning' | 'critical'
        reason    – human-readable description
        value     – the observed metric value
        threshold – the threshold that was breached
    """
    alerts: list[dict] = []

    # 1. EV alert
    ev_7d = ev_result.get("ev_7d", 0.0) or 0.0
    if ev_7d < EV_7D_THRESHOLD:
        alerts.append(
            {
                "type": "ev_negative",
                "severity": "critical",
                "reason": (
                    f"7-day realized EV ({ev_7d:.4f}) is below threshold "
                    f"({EV_7D_THRESHOLD:.4f})"
                ),
                "value": ev_7d,
                "threshold": EV_7D_THRESHOLD,
            }
        )

    # 2. Calibration / ECE alert
    drift_factor = calibration_result.get("drift_factor", 0.0) or 0.0
    if calibration_result.get("drifted", False):
        alerts.append(
            {
                "type": "ece_doubled",
                "severity": "warning",
                "reason": (
                    f"Rolling ECE is {drift_factor:.2f}x the baseline "
                    f"(threshold: {ECE_DRIFT_FACTOR:.1f}x)"
                ),
                "value": drift_factor,
                "threshold": ECE_DRIFT_FACTOR,
            }
        )

    # 3. Concept / distribution drift alert
    any_drift = False
    if isinstance(drift_result, dict):
        # drift_result may be a feature-keyed dict or a single detect_score_drift result.
        # Detect single drift result by checking for the 'drift_detected' key directly.
        if "drift_detected" in drift_result:
            any_drift = bool(drift_result.get("drift_detected", False))
        else:
            # Feature-level dict: any feature drifted?
            for feat_result in drift_result.values():
                if isinstance(feat_result, dict) and feat_result.get("drift_detected"):
                    any_drift = True
                    break

    if any_drift:
        alerts.append(
            {
                "type": "concept_drift",
                "severity": "warning",
                "reason": "KS test detected statistically significant distribution shift",
                "value": KS_ALPHA,
                "threshold": KS_ALPHA,
            }
        )

    # 4. Hit-rate alert
    hit_rate = hit_rate_result.get("hit_rate", 0.0) or 0.0
    if hit_rate_result.get("bets", 0) > 0 and not hit_rate_result.get("above_breakeven", True):
        alerts.append(
            {
                "type": "hit_rate_low",
                "severity": "warning",
                "reason": (
                    f"Hit rate ({hit_rate:.4f}) is below break-even "
                    f"({_BREAKEVEN:.4f})"
                ),
                "value": hit_rate,
                "threshold": _BREAKEVEN,
            }
        )

    return alerts


# ---------------------------------------------------------------------------
# Retrain queue
# ---------------------------------------------------------------------------

def _load_queue(path: str) -> list[dict]:
    """Load the retrain queue JSON file, returning an empty list on failure."""
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, list):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return []


def _save_queue(queue: list[dict], path: str) -> None:
    """Atomically save the retrain queue to disk."""
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        json.dump(queue, fh, indent=2)
    os.replace(tmp_path, path)


def enqueue_retrain(
    reason: str,
    priority: str = "normal",
    path: str = RETRAIN_QUEUE_PATH,
) -> None:
    """Append a retrain job to the queue.

    Queue format: list of job dicts::

        {
          "id":          str  – UUID4
          "enqueued_at": str  – ISO-8601 UTC
          "reason":      str
          "priority":    str  – 'low' | 'normal' | 'high'
          "status":      str  – 'pending' | 'running' | 'done'
        }
    """
    queue = _load_queue(path)
    job: dict = {
        "id": str(uuid.uuid4()),
        "enqueued_at": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
        "priority": priority,
        "status": "pending",
    }
    queue.append(job)
    _save_queue(queue, path)


def dequeue_retrain(path: str = RETRAIN_QUEUE_PATH) -> Optional[dict]:
    """Pop the next *pending* retrain job (FIFO) and mark it as 'running'.

    Returns None if the queue is empty or no pending jobs remain.
    The job is written back to disk with status='running' before being returned,
    so if the process crashes the status can be detected on restart.
    """
    queue = _load_queue(path)
    for job in queue:
        if job.get("status") == "pending":
            job["status"] = "running"
            _save_queue(queue, path)
            return job
    return None


def mark_retrain_done(job_id: str, path: str = RETRAIN_QUEUE_PATH) -> None:
    """Mark a retrain job as 'done' by its UUID."""
    queue = _load_queue(path)
    for job in queue:
        if job.get("id") == job_id:
            job["status"] = "done"
    _save_queue(queue, path)


# ---------------------------------------------------------------------------
# Main monitoring cycle
# ---------------------------------------------------------------------------

def run_monitoring_cycle(
    recent_games: Optional[list[dict]] = None,
    reference_games: Optional[list[dict]] = None,
    baseline_ece: float = 0.021,
    shadow_path: str = SHADOW_DB_PATH,
    log_path: str = MONITOR_LOG_PATH,
    csv_path: Optional[str] = None,
) -> dict:
    """Run one full monitoring cycle.

    Steps
    -----
    1. compute_realized_ev  (7-day window from shadow DB)
    2. compute_hit_rate     (7-day window from shadow DB)
    3. compute_calibration_drift (using recent_games if provided)
    4. detect_feature_drift (reference_games vs recent_games)
    5. check_thresholds
    6. enqueue_retrain if any alerts were triggered
    7. Log the run to monitor_log.db

    Parameters
    ----------
    recent_games:
        Recent game records used for calibration ECE and as the "current"
        sample for drift detection.  Pass None to skip game-based checks.
    reference_games:
        Historical game records used as the "reference" sample.
        Pass None to skip drift detection.
    baseline_ece:
        ECE computed during initial training, used as the calibration baseline.
    shadow_path:
        Path to the shadow prediction DB.
    log_path:
        Path to the monitoring run log DB.

    Returns
    -------
    {
        ev:              dict  – output of compute_realized_ev
        hit_rate:        dict  – output of compute_hit_rate
        calibration:     dict  – output of compute_calibration_drift
        drift:           dict  – output of detect_feature_drift (or empty)
        alerts:          list  – triggered alert dicts
        retrain_enqueued: bool
    }
    """
    # Derive game windows from CSV when callers pass csv_path instead of game lists.
    if csv_path and (recent_games is None or reference_games is None):
        try:
            from optimizer.data_validator import load_and_validate
            all_games = load_and_validate(csv_path)
            if all_games:
                split = max(1, int(len(all_games) * 0.8))
                if reference_games is None:
                    reference_games = all_games[:split]
                if recent_games is None:
                    recent_games = all_games[split:]
        except Exception as exc:
            _log.warning("run_monitoring_cycle: failed to load CSV %s: %s", csv_path, exc)

    # Step 1 & 2: EV and hit-rate from shadow DB.
    ev_result = compute_realized_ev(window_days=7, shadow_path=shadow_path)
    hit_rate_result = compute_hit_rate(window_days=7, shadow_path=shadow_path)

    # Step 3: Calibration drift.
    cal_result = compute_calibration_drift(
        baseline_ece=baseline_ece,
        recent_games=recent_games if recent_games is not None else [],
    )

    # Step 4: Feature / concept drift.
    if recent_games is not None and reference_games is not None:
        drift_result = detect_feature_drift(reference_games, recent_games)
    else:
        drift_result = {}

    # Step 5: Check thresholds → build alert list.
    alerts = check_thresholds(ev_result, hit_rate_result, cal_result, drift_result)

    # Step 6: Enqueue retrain if any alert was triggered.
    retrain_enqueued = False
    if alerts:
        reasons = "; ".join(a["type"] for a in alerts)
        enqueue_retrain(
            reason=f"Automated monitoring alert(s): {reasons}",
            priority="high" if any(a["severity"] == "critical" for a in alerts) else "normal",
        )
        retrain_enqueued = True

    # Step 7: Log the run.
    any_drift_detected = any(
        (v.get("drift_detected") if isinstance(v, dict) else False)
        for v in drift_result.values()
    ) if isinstance(drift_result, dict) else False

    _log_run(
        ev_7d=ev_result.get("ev_7d"),
        hit_rate_7d=hit_rate_result.get("hit_rate"),
        ece_rolling=cal_result.get("rolling_ece"),
        ece_baseline=baseline_ece,
        drift_detected=any_drift_detected,
        alerts=alerts,
        retrain_enqueued=retrain_enqueued,
        path=log_path,
    )

    return {
        "ev": ev_result,
        "hit_rate": hit_rate_result,
        "calibration": cal_result,
        "drift": drift_result,
        "alerts": alerts,
        "retrain_enqueued": retrain_enqueued,
    }

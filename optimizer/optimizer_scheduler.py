#!/usr/bin/env python3
"""
optimizer_scheduler.py — APScheduler-based job scheduler for the GGBA optimizer pipeline.

Jobs:
  eval_job     — 4:00 AM UTC daily: run optimizer, champion/challenger gating
  monitor_job  — every 30 min: monitoring cycle, threshold checks
  retrain_job  — every 15 min: poll retrain queue, execute pending retrains

Config (environment variables):
  GGBA_OPT_EVAL_HOUR       — hour for daily eval job (default: 4)
  GGBA_OPT_EVAL_MINUTE     — minute for daily eval job (default: 0)
  GGBA_OPT_MONITOR_MIN     — monitoring interval in minutes (default: 30)
  GGBA_OPT_RETRAIN_MIN     — retrain queue poll interval in minutes (default: 15)
  GGBA_OPT_DATA_PATH       — path to walkforward CSV or directory of CSVs (default: ggba_data/)
  GGBA_OPT_CHAMPION_PATH   — path to champion JSON (default: optimizer/ggba_champion.json)
  GGBA_OPT_MIN_GP          — min GP filter for optimization (default: 10)
  GGBA_OPT_DAYS            — days window for CSV selection (default: 56)
"""
from __future__ import annotations

import json
import logging
import os
import glob as _glob_mod

from apscheduler.schedulers.background import BackgroundScheduler

log = logging.getLogger("ggba.optimizer_scheduler")

# ---------------------------------------------------------------------------
# Config from environment variables
# ---------------------------------------------------------------------------

def _int(name: str, default: int) -> int:
    """Read an integer environment variable, returning *default* if absent or non-numeric."""
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


EVAL_HOUR = _int("GGBA_OPT_EVAL_HOUR", 4)
EVAL_MINUTE = _int("GGBA_OPT_EVAL_MINUTE", 0)
MONITOR_MIN = _int("GGBA_OPT_MONITOR_MIN", 30)
RETRAIN_MIN = _int("GGBA_OPT_RETRAIN_MIN", 15)
DATA_PATH = os.environ.get("GGBA_OPT_DATA_PATH", "ggba_data/")
CHAMPION_PATH = os.environ.get("GGBA_OPT_CHAMPION_PATH", "optimizer/ggba_champion.json")
MIN_GP = _int("GGBA_OPT_MIN_GP", 10)
DAYS = _int("GGBA_OPT_DAYS", 56)

# ---------------------------------------------------------------------------
# Optional pipeline module imports (other units build these in parallel)
# ---------------------------------------------------------------------------

try:
    from optimizer.champion_challenger import (  # type: ignore[import]
        load_champion,
        run_gates,
        promote,
        reject_and_log,
    )
    from optimizer.init_registry import log_experiment  # type: ignore[import]
    from optimizer.monitor import (  # type: ignore[import]
        run_monitoring_cycle,
        dequeue_retrain,
        mark_retrain_done,
    )
    _HAS_FULL_PIPELINE = True
except ImportError:
    _HAS_FULL_PIPELINE = False
    log.debug("optimizer pipeline modules not available; jobs will no-op until they are installed")

# ---------------------------------------------------------------------------
# Internal scheduler state
# ---------------------------------------------------------------------------

_scheduler: BackgroundScheduler | None = None

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _find_best_csv(data_path: str, min_gp: int, days: int) -> str | None:
    """Find the best available CSV in *data_path*.

    Preference order:
    1. Exact preferred name: ``walkforward_gp{min_gp}_days{days}.csv``
    2. Any ``walkforward_*.csv`` in the directory (most-recently-modified wins)
    3. Any ``*.csv`` in the directory (most-recently-modified wins)

    Returns the absolute path to the chosen file, or ``None`` if nothing is found.
    """
    if not data_path:
        return None

    # Resolve relative paths from cwd
    data_path = os.path.abspath(data_path)

    # Direct file path
    if os.path.isfile(data_path):
        return data_path

    if not os.path.isdir(data_path):
        log.warning("data path %s is not a file or directory", data_path)
        return None

    # 1. Preferred exact name
    preferred = os.path.join(data_path, f"walkforward_gp{min_gp}_days{days}.csv")
    if os.path.isfile(preferred):
        return preferred

    # 2. Any walkforward CSV
    wf_files = _glob_mod.glob(os.path.join(data_path, "walkforward_*.csv"))
    if wf_files:
        return max(wf_files, key=os.path.getmtime)

    # 3. Any CSV
    csv_files = _glob_mod.glob(os.path.join(data_path, "*.csv"))
    if csv_files:
        return max(csv_files, key=os.path.getmtime)

    return None


def _load_json(path: str) -> dict | None:
    """Load a JSON file; return ``None`` on any error."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return None
    except Exception:
        log.exception("failed to load JSON from %s", path)
        return None


def _save_json(path: str, data: dict) -> None:
    """Save *data* to *path* as JSON, creating parent directories as needed."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)

# ---------------------------------------------------------------------------
# Scheduler jobs
# ---------------------------------------------------------------------------


def eval_job() -> None:
    """4am daily evaluation job.

    Steps:
    1. Load the best available CSV from GGBA_OPT_DATA_PATH
       (prefer ``walkforward_gp{MIN_GP}_days{DAYS}.csv``).
    2. Load current champion from ``ggba_champion.json`` (``None`` if first run).
    3. If no champion: run optimizer to create initial champion, save it, return.
    4. If champion exists: run optimizer in neighbourhood mode around champion params.
    5. Produce ``challenger.json`` from optimizer result.
    6. Run all gates (``run_gates``).
    7. If gates pass: promote challenger to champion.
    8. If gates fail: reject and log to experiments registry.
    9. Log the run to ``monitor_log.db``.

    Catches ALL exceptions and logs them — never crashes the scheduler.
    """
    try:
        if not _HAS_FULL_PIPELINE:
            log.warning("eval_job: optimizer pipeline modules not available; skipping")
            return

        csv_path = _find_best_csv(DATA_PATH, MIN_GP, DAYS)
        if csv_path is None:
            log.warning("eval_job: no CSV found in %s; skipping", DATA_PATH)
            return

        log.info("eval_job: using CSV %s", csv_path)

        # Load current champion (None on first run)
        champion = load_champion(CHAMPION_PATH)

        if champion is None:
            # First run — create initial champion from scratch
            log.info("eval_job: no existing champion; running initial optimization")
            from optimizer.champion_challenger import run_optimizer  # type: ignore[import]
            result = run_optimizer(csv_path, min_gp=MIN_GP, mode="full")
            if result is None:
                log.warning("eval_job: optimizer returned no result; aborting")
                return
            promote(result, CHAMPION_PATH)
            log.info("eval_job: initial champion saved to %s", CHAMPION_PATH)
            return

        # Champion exists — run neighbourhood search around its params
        log.info("eval_job: running neighbourhood optimization around champion params")
        from optimizer.champion_challenger import run_optimizer  # type: ignore[import]
        challenger_result = run_optimizer(
            csv_path,
            min_gp=MIN_GP,
            mode="neighbourhood",
            center=champion,
        )
        if challenger_result is None:
            log.warning("eval_job: optimizer returned no challenger; aborting")
            return

        # Gate the challenger against the champion
        gates_passed, gate_details = run_gates(champion, challenger_result, csv_path)

        if gates_passed:
            promote(challenger_result, CHAMPION_PATH)
            log.info("eval_job: challenger promoted to champion — %s", gate_details)
        else:
            reject_and_log(challenger_result, gate_details)
            log.info("eval_job: challenger rejected — %s", gate_details)

    except Exception:
        log.exception("eval_job failed")


def monitor_job() -> None:
    """30-minute monitoring cycle.

    1. Load recent games from data path.
    2. Load baseline ECE from champion JSON.
    3. Run ``run_monitoring_cycle()``.
    4. If retrain enqueued, log it.

    Catches ALL exceptions and logs them.
    """
    try:
        if not _HAS_FULL_PIPELINE:
            log.warning("monitor_job: optimizer pipeline modules not available; skipping")
            return

        csv_path = _find_best_csv(DATA_PATH, MIN_GP, DAYS)
        if csv_path is None:
            log.warning("monitor_job: no CSV found in %s; skipping", DATA_PATH)
            return

        champion = _load_json(CHAMPION_PATH)
        baseline_ece = champion.get("ece") if champion else None

        retrain_enqueued = run_monitoring_cycle(
            csv_path=csv_path,
            baseline_ece=baseline_ece,
        )
        if retrain_enqueued:
            log.info("monitor_job: retrain enqueued by monitoring cycle")
        else:
            log.debug("monitor_job: monitoring cycle complete, no retrain needed")

    except Exception:
        log.exception("monitor_job failed")


def retrain_job() -> None:
    """Poll retrain queue and execute pending retrains.

    1. ``dequeue_retrain()`` — get next pending job.
    2. If pending job: run ``eval_job()`` (which handles full optimisation).
    3. ``mark_retrain_done(job_id)``.

    Catches ALL exceptions.
    """
    try:
        if not _HAS_FULL_PIPELINE:
            log.warning("retrain_job: optimizer pipeline modules not available; skipping")
            return

        job = dequeue_retrain()
        if job is None:
            log.debug("retrain_job: no pending retrains")
            return

        job_id = job.get("id") if isinstance(job, dict) else str(job)
        log.info("retrain_job: executing retrain for job_id=%s", job_id)

        eval_job()

        mark_retrain_done(job_id)
        log.info("retrain_job: job_id=%s marked done", job_id)

    except Exception:
        log.exception("retrain_job failed")

# ---------------------------------------------------------------------------
# Scheduler lifecycle
# ---------------------------------------------------------------------------


def start() -> BackgroundScheduler | None:
    """Start the optimizer APScheduler.

    Registers:
    * ``opt_eval``    — cron at ``EVAL_HOUR:EVAL_MINUTE`` UTC
    * ``opt_monitor`` — interval every ``MONITOR_MIN`` minutes
    * ``opt_retrain`` — interval every ``RETRAIN_MIN`` minutes

    Returns ``None`` if all intervals are 0 (scheduler disabled).
    """
    global _scheduler

    has_eval = True  # cron job is always enabled (hour/minute config can disable by convention)
    has_monitor = MONITOR_MIN > 0
    has_retrain = RETRAIN_MIN > 0

    if not has_eval and not has_monitor and not has_retrain:
        log.info("optimizer scheduler disabled (all intervals are 0)")
        return None

    _scheduler = BackgroundScheduler(timezone="UTC")

    # 4am (or configured time) daily evaluation job
    _scheduler.add_job(
        eval_job,
        "cron",
        hour=EVAL_HOUR,
        minute=EVAL_MINUTE,
        id="opt_eval",
        max_instances=1,
        coalesce=True,
    )

    if has_monitor:
        _scheduler.add_job(
            monitor_job,
            "interval",
            minutes=MONITOR_MIN,
            id="opt_monitor",
            max_instances=1,
            coalesce=True,
        )

    if has_retrain:
        _scheduler.add_job(
            retrain_job,
            "interval",
            minutes=RETRAIN_MIN,
            id="opt_retrain",
            max_instances=1,
            coalesce=True,
        )

    _scheduler.start()
    log.info(
        "optimizer scheduler started (eval=%02d:%02dUTC monitor=%dm retrain=%dm)",
        EVAL_HOUR,
        EVAL_MINUTE,
        MONITOR_MIN,
        RETRAIN_MIN,
    )
    return _scheduler


def shutdown() -> None:
    """Gracefully stop the optimizer scheduler without waiting for running jobs."""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        log.info("optimizer scheduler stopped")

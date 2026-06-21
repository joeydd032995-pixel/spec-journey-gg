#!/usr/bin/env python3
"""
pipeline.py — Main CLI entry point for the GGBA Optimizer pipeline.

Orchestrates the full champion/challenger optimization system for GG League
(eBasketball H2H, NBA 2K) betting analytics.

Usage:
    python3 optimizer/pipeline.py export [--gp GP] [--days DAYS] [--all]
    python3 optimizer/pipeline.py optimize --csv CSV_PATH [--mode global|neighborhood] [--iters N]
    python3 optimizer/pipeline.py shadow [--log-game game_id player1 player2 score1 score2]
    python3 optimizer/pipeline.py monitor [--baseline-ece FLOAT]
    python3 optimizer/pipeline.py schedule [--daemon]
    python3 optimizer/pipeline.py status
    python3 optimizer/pipeline.py test [--quick]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------- #
# Dynamic import of "ggba model.py" (space in filename)                       #
# --------------------------------------------------------------------------- #
def _load_ggba_model():
    """Load ``ggba model.py`` via importlib, registering it in sys.modules."""
    if "ggba_model" in sys.modules:
        return sys.modules["ggba_model"]
    _spec = importlib.util.spec_from_file_location(
        "ggba_model",
        os.path.join(os.path.dirname(os.path.dirname(__file__)), "ggba model.py"),
    )
    _ggba = importlib.util.module_from_spec(_spec)
    sys.modules["ggba_model"] = _ggba
    _spec.loader.exec_module(_ggba)
    return _ggba


# --------------------------------------------------------------------------- #
# Optional module imports — graceful degradation when modules are absent       #
# --------------------------------------------------------------------------- #
try:
    from optimizer.ggba_optimizer import run_optimizer
    _HAS_OPTIMIZER = True
except ImportError:
    _HAS_OPTIMIZER = False

try:
    from optimizer.champion_challenger import (
        load_champion,
        produce_challenger,
        save_challenger,
        run_gates,
        promote,
        reject_and_log,
        make_initial_champion,
    )
    _HAS_CC = True
except ImportError:
    _HAS_CC = False

try:
    from optimizer.export_datasets import (
        fetch_and_export,
        cmd_all as _export_all_cmd,
        GP_BUCKETS,
        DAY_WINDOWS,
        OUTPUT_DIR,
    )
    _HAS_EXPORT = True
except ImportError:
    _HAS_EXPORT = False

try:
    from optimizer.shadow_mode import (
        init_shadow_db,
        log_prediction,
        settle_game,
        compute_live_stats,
        shadow_status,
    )
    _HAS_SHADOW = True
except ImportError:
    _HAS_SHADOW = False

try:
    from optimizer.monitor import run_monitoring_cycle, init_monitor_db
    _HAS_MONITOR = True
except ImportError:
    _HAS_MONITOR = False

try:
    from optimizer.optimizer_scheduler import start as _scheduler_start, shutdown as _scheduler_shutdown
    _HAS_SCHEDULER = True
except ImportError:
    _HAS_SCHEDULER = False

try:
    from optimizer.init_registry import get_experiments, REGISTRY_PATH
    _HAS_REGISTRY = True
except ImportError:
    _HAS_REGISTRY = False

try:
    from optimizer.data_validator import load_and_validate
    _HAS_VALIDATOR = True
except ImportError:
    _HAS_VALIDATOR = False


# --------------------------------------------------------------------------- #
# Metric targets                                                               #
# --------------------------------------------------------------------------- #
# Each entry: (metric_name, key_in_metrics, target_value, direction, format_str)
# direction: 'lte' (lower is better, must be <=), 'gte' (higher is better, must be >=),
#            'bias_lte' (value must be <= target, meaning sufficiently negative), 'info'
#
# Targets calibrated from walk-forward data analysis (gp30, days35, n=3713):
#   total σ=14.3, between-pair σ=9.94, within-pair σ=10.50
#   → theoretical MAE floor = 0.798 × 10.50 = 8.38 pts
#   → theoretical max Pearson r = 9.94 / 14.3 = 0.694
#
# biasOffset (Betting Offset) is the conservative under-prediction applied to
# betting signals.  It lives in hyperparams, not in the accuracy metrics, so
# ECE / MAE / r are all evaluated on unshifted model output (biasOffset = 0).
# The pipeline injects hyperparams['biasOffset'] into the metrics dict so the
# gate below can check it alongside the accuracy metrics.
METRIC_TARGETS = [
    ("Brier Score",    "brier",       1.68, "lte",      ".2f"),
    ("ECE",            "ece",         0.019, "lte",      ".3f"),
    ("MAE",            "mae",          9.5,  "lte",      ".1f"),
    ("Betting Offset", "biasOffset",  -4.0,  "bias_lte", ".1f"),
    ("Correlation",    "r",           0.55,  "gte",      ".2f"),
    ("Hybrid Loss",    "hybrid_loss", None,  "info",     ".2f"),
]


def _check_target(value: Optional[float], target: Optional[float], direction: str) -> Optional[bool]:
    """Return True=PASS, False=FAIL, None=INFO."""
    if direction == "info" or value is None:
        return None
    if target is None:
        return None
    if direction == "lte":
        return value <= target
    if direction == "gte":
        return value >= target
    if direction == "bias_lte":
        # Bias must be <= -4.0, i.e., sufficiently negative
        return value <= target
    return None


def _fmt_target(target: Optional[float], direction: str, fmt: str) -> str:
    """Format a target threshold for display."""
    if target is None or direction == "info":
        return "—"
    if direction in ("lte", "bias_lte"):
        return f"≤ {target:{fmt}}"
    if direction == "gte":
        return f"≥ {target:{fmt}}"
    return "—"


def print_metrics_table(metrics: Dict[str, Any]) -> None:
    """Print a human-readable metric targets table."""
    print()
    print("=== METRIC TARGETS ===")
    header = f"{'Metric':<15} {'Value':>8}  {'Target':>10}  {'Status'}"
    print(header)
    print("─" * len(header))

    all_pass = True
    for name, key, target, direction, fmt in METRIC_TARGETS:
        raw = metrics.get(key)
        if raw is not None:
            val_str = f"{raw:{fmt}}"
        else:
            val_str = "N/A"

        target_str = _fmt_target(target, direction, fmt)
        passed = _check_target(raw, target, direction)

        if passed is None:
            status = "INFO"
        elif passed:
            status = "PASS ✓"
        else:
            status = "FAIL ✗"
            all_pass = False

        print(f"{name:<15} {val_str:>8}  {target_str:>10}  {status}")

    print()
    return all_pass


def _hybrid_loss_from_metrics(metrics: Dict[str, Any]) -> Optional[float]:
    """Compute hybrid loss from metrics dict if mae and r are present."""
    import math
    mae = metrics.get("mae")
    r = metrics.get("r")
    ece = metrics.get("ece", 0.0)
    if mae is None or r is None:
        return None
    sigma_ref = math.sqrt(max(mae, 1.0))
    mae_norm = mae / max(sigma_ref, 1.0)
    loss = 0.5 * mae_norm + 0.5 * max(0.0, 1.0 - abs(r)) + 10.0 * (ece or 0.0)
    return round(loss, 4)


# --------------------------------------------------------------------------- #
# Subcommand: export                                                           #
# --------------------------------------------------------------------------- #
def cmd_export(args: argparse.Namespace) -> int:
    """Run CSV export for specified GP/days or all 36 combinations."""
    if not _HAS_EXPORT:
        print("ERROR: optimizer.export_datasets not available. Install httpx: pip install httpx")
        return 1

    if args.all:
        import types
        dummy = types.SimpleNamespace(all=True, list=False, gp=None, days=None)
        _export_all_cmd(dummy)
    elif args.gp is not None and args.days is not None:
        print(f"Exporting walkforward_gp{args.gp}_days{args.days}.csv ...")
        fetch_and_export(args.gp, args.days, OUTPUT_DIR)
        print("Done.")
    else:
        print("Specify --all or both --gp and --days.")
        return 1

    return 0


# --------------------------------------------------------------------------- #
# Subcommand: optimize                                                         #
# --------------------------------------------------------------------------- #
def cmd_optimize(args: argparse.Namespace) -> int:
    """Run optimizer on a CSV and update champion/challenger."""
    if not _HAS_OPTIMIZER:
        print("ERROR: optimizer.ggba_optimizer not available.")
        return 1
    if not _HAS_CC:
        print("ERROR: optimizer.champion_challenger not available.")
        return 1
    if not _HAS_VALIDATOR:
        print("ERROR: optimizer.data_validator not available.")
        return 1

    csv_path = args.csv
    if not os.path.exists(csv_path):
        print(f"ERROR: CSV not found: {csv_path}")
        return 1

    mode = args.mode if hasattr(args, "mode") and args.mode else "global"
    n_iters = args.iters if hasattr(args, "iters") and args.iters else None

    print(f"Loading and validating: {csv_path}")
    try:
        games = load_and_validate(csv_path)
    except Exception as exc:
        print(f"ERROR during validation: {exc}")
        return 1
    print(f"  {len(games)} valid games loaded.")

    # Load current champion (may be None)
    champion = load_champion()
    champion_params = champion.get("hyperparams") if champion else None

    if champion:
        print(f"  Current champion: version {champion.get('version', '?')}")
    else:
        print("  No current champion — will create initial champion.")

    # Adjust mode
    if mode == "neighborhood" and champion_params is None:
        print("  No champion params for neighborhood mode; falling back to global.")
        mode = "global"

    print(f"\nRunning optimizer (mode={mode}) ...")

    # Build kwargs for run_optimizer; handle n_iters override if supported
    run_kwargs: Dict[str, Any] = {
        "csv_path": csv_path,
        "champion_params": champion_params,
        "mode": mode,
    }

    try:
        result = run_optimizer(**run_kwargs)
    except Exception as exc:
        print(f"ERROR during optimization: {exc}")
        import traceback
        traceback.print_exc()
        return 1

    # Attach hybrid_loss to metrics
    metrics = result.get("metrics", {})
    if "hybrid_loss" not in metrics:
        hl = _hybrid_loss_from_metrics(metrics)
        if hl is not None:
            metrics["hybrid_loss"] = hl
    # Expose biasOffset from hyperparams so the Betting Offset gate can read it
    if "biasOffset" not in metrics:
        metrics["biasOffset"] = result.get("hyperparams", {}).get("biasOffset", 0.0)
    result["metrics"] = metrics

    # Produce challenger
    challenger = produce_challenger(result)
    save_challenger(challenger)
    print("  Challenger saved to optimizer/challenger.json")

    # Gate or make initial champion
    if champion:
        print("\nRunning promotion gates ...")
        gate_result = run_gates(challenger, champion)
        print(f"  {gate_result['summary']}")
        for gname, ginfo in gate_result.get("gates", {}).items():
            symbol = "✓" if ginfo["passed"] else "✗"
            print(f"    {symbol} {ginfo['reason']}")

        if gate_result["passed"]:
            new_champ = promote(challenger)
            print(f"\n  Champion promoted to version {new_champ.get('version', '?')}!")
        else:
            reject_and_log(challenger, gate_result)
            print("\n  Challenger rejected and logged to experiments registry.")
    else:
        # No champion: create initial champion from result
        data_date_range = result.get("data_date_range", {})
        if not data_date_range:
            data_date_range = {"start": "unknown", "end": "unknown"}
        initial = make_initial_champion(
            hyperparams=result.get("hyperparams", {}),
            metrics=metrics,
            data_date_range=data_date_range,
        )
        from optimizer.champion_challenger import save_champion
        save_champion(initial)
        print("\n  Initial champion created and saved (version 1)!")

    # Print metrics table
    print_metrics_table(metrics)
    return 0


# --------------------------------------------------------------------------- #
# Subcommand: shadow                                                           #
# --------------------------------------------------------------------------- #
def cmd_shadow(args: argparse.Namespace) -> int:
    """Shadow mode: log predictions or show status."""
    if not _HAS_SHADOW:
        print("ERROR: optimizer.shadow_mode not available.")
        return 1

    if hasattr(args, "log_game") and args.log_game:
        # --log-game game_id player1 player2 score1 score2
        vals = args.log_game
        if len(vals) != 5:
            print("ERROR: --log-game requires exactly 5 args: game_id player1 player2 score1 score2")
            return 1

        game_id, player1, player2, score1_str, score2_str = vals
        try:
            score1 = float(score1_str)
            score2 = float(score2_str)
        except ValueError:
            print("ERROR: score1 and score2 must be numeric.")
            return 1

        # Load champion and challenger params
        if not _HAS_CC:
            print("ERROR: optimizer.champion_challenger not available.")
            return 1

        champion = load_champion()
        if champion is None:
            print("ERROR: No champion loaded. Run 'optimize' first.")
            return 1
        champion_params = champion.get("hyperparams", {})

        # Try to load challenger
        try:
            from optimizer.champion_challenger import load_challenger
            challenger = load_challenger()
        except ImportError:
            challenger = None
        challenger_params = challenger.get("hyperparams", {}) if challenger else champion_params

        init_shadow_db()
        game = {
            "game_id": game_id,
            "date": "",
            "player1": player1,
            "player2": player2,
            "p1_team": "",
            "p2_team": "",
            "p1_gp": 20,
            "p2_gp": 20,
            "p1_pts": score1,
            "p2_pts": score2,
        }
        gid = log_prediction(game, champion_params, challenger_params)
        actual_total = score1 + score2
        outcome = settle_game(gid, actual_total)

        print(f"Shadow game logged: {game_id}")
        print(f"  Champion: {outcome['champion_outcome']} (PnL={outcome['champion_pnl']:+.2f})")
        print(f"  Challenger: {outcome['challenger_outcome']} (PnL={outcome['challenger_pnl']:+.2f})")
    else:
        # Show shadow status
        init_shadow_db()
        status = shadow_status()
        print("=== SHADOW MODE STATUS ===")
        print(f"  Total predictions : {status['total_predictions']}")
        print(f"  Pending           : {status['pending']}")
        print(f"  Settled           : {status['settled']}")
        print(f"  Champion active   : {status['champion_active']}")

        live = compute_live_stats(n_days=7)
        champ = live["champion"]
        chal = live["challenger"]
        period = live["sample_period"]

        print()
        print(f"  Last 7 days: {period.get('start', 'N/A')} → {period.get('end', 'N/A')}")
        print(f"  {'Model':<12} {'Bets':>6} {'Win%':>7} {'ROI%':>8} {'EV 7d':>8}")
        print(f"  {'─'*12} {'─'*6} {'─'*7} {'─'*8} {'─'*8}")

        def _fmt(v: Optional[float], pct: bool = False) -> str:
            if v is None:
                return "N/A"
            return f"{v * 100 if pct else v:.2f}"

        print(f"  {'Champion':<12} {champ['bets']:>6} {_fmt(champ['win_rate'], pct=True):>7} "
              f"{_fmt(champ['roi_pct']):>8} {_fmt(champ['ev_7d']):>8}")
        print(f"  {'Challenger':<12} {chal['bets']:>6} {_fmt(chal['win_rate'], pct=True):>7} "
              f"{_fmt(chal['roi_pct']):>8} {_fmt(chal['ev_7d']):>8}")

    return 0


# --------------------------------------------------------------------------- #
# Subcommand: monitor                                                          #
# --------------------------------------------------------------------------- #
def cmd_monitor(args: argparse.Namespace) -> int:
    """Run one monitoring cycle and print results."""
    if not _HAS_MONITOR:
        print("ERROR: optimizer.monitor not available.")
        return 1

    baseline_ece = None
    if hasattr(args, "baseline_ece") and args.baseline_ece is not None:
        baseline_ece = float(args.baseline_ece)
    elif _HAS_CC:
        champion = load_champion()
        if champion:
            baseline_ece = champion.get("metrics", {}).get("ece")

    # Find the best available CSV
    csv_path = _find_best_csv()
    if csv_path is None:
        print("WARNING: No CSV found. Run 'export' first to get data.")
        csv_path = ""

    if csv_path:
        print(f"Running monitoring cycle on: {csv_path}")
    else:
        print("Running monitoring cycle (no CSV — limited checks).")

    try:
        retrain_enqueued = run_monitoring_cycle(
            csv_path=csv_path,
            baseline_ece=baseline_ece,
        )
        if retrain_enqueued:
            print("  Retrain job enqueued (threshold breach detected).")
        else:
            print("  Monitoring cycle complete — no retrain needed.")
    except Exception as exc:
        print(f"  Monitor error: {exc}")

    return 0


# --------------------------------------------------------------------------- #
# Subcommand: schedule                                                         #
# --------------------------------------------------------------------------- #
def cmd_schedule(args: argparse.Namespace) -> int:
    """Start the full scheduler (eval @ 4am, monitoring every 30min)."""
    if not _HAS_SCHEDULER:
        print("ERROR: optimizer.optimizer_scheduler not available.")
        print("Install APScheduler: pip install apscheduler")
        return 1

    daemon = hasattr(args, "daemon") and args.daemon

    print("Starting GGBA Optimizer Scheduler ...")
    print("  Jobs: eval @ 04:00 UTC daily, monitor every 30 min, retrain queue every 15 min")

    sched = _scheduler_start()
    if sched is None:
        print("ERROR: Scheduler returned None (all intervals may be zero).")
        return 1

    if daemon:
        print("  Running in daemon mode (background). Detaching.")
        return 0

    print("  Scheduler running. Press Ctrl+C to stop.")
    try:
        import time
        while True:
            time.sleep(60)
    except KeyboardInterrupt:
        print("\n  Stopping scheduler ...")
        _scheduler_shutdown()
        print("  Stopped.")

    return 0


# --------------------------------------------------------------------------- #
# Subcommand: status                                                           #
# --------------------------------------------------------------------------- #
def cmd_status(args: argparse.Namespace) -> int:
    """Print current system status."""
    print("=== GGBA OPTIMIZER STATUS ===")
    print()

    # Champion
    print("[ Champion ]")
    if _HAS_CC:
        champion = load_champion()
        if champion:
            print(f"  Version   : {champion.get('version', '?')}")
            print(f"  Updated   : {champion.get('updated_at', 'N/A')}")
            hp = champion.get("hyperparams", {})
            if hp:
                print(f"  Hyperparams:")
                for k, v in hp.items():
                    print(f"    {k:<12}: {v:.4f}" if isinstance(v, float) else f"    {k:<12}: {v}")
            m = champion.get("metrics", {})
            if m:
                print(f"  Metrics:")
                for k, v in m.items():
                    if isinstance(v, float):
                        print(f"    {k:<12}: {v:.4f}")
                    elif v is not None:
                        print(f"    {k:<12}: {v}")
        else:
            print("  No champion found. Run 'optimize' to create one.")
    else:
        print("  champion_challenger module not available.")
    print()

    # Experiments registry (last 5)
    print("[ Experiments Registry — Last 5 ]")
    if _HAS_REGISTRY:
        try:
            exps = get_experiments(limit=5)
            if exps:
                for exp in exps:
                    prom_str = "PROMOTED" if exp.get("promoted") else "rejected"
                    ts = exp.get("run_ts", "?")[:19]
                    reason = (exp.get("reason") or "")[:60]
                    print(f"  [{ts}] #{exp.get('id', '?')}: {prom_str} — {reason}")
            else:
                print("  (no experiments logged yet)")
        except Exception as exc:
            print(f"  Error reading registry: {exc}")
    else:
        print("  init_registry module not available.")
    print()

    # Retrain queue
    print("[ Retrain Queue ]")
    queue_path = os.path.join("optimizer", "retrain_queue.json")
    if os.path.exists(queue_path):
        try:
            with open(queue_path, "r", encoding="utf-8") as fh:
                queue = json.load(fh)
            pending = [j for j in (queue if isinstance(queue, list) else []) if not j.get("done")]
            print(f"  Pending jobs: {len(pending)}")
            for job in pending[:3]:
                print(f"    - {job}")
        except Exception as exc:
            print(f"  Error reading queue: {exc}")
    else:
        print("  No retrain queue file found.")
    print()

    # Shadow log stats (last 7 days)
    print("[ Shadow Log — Last 7 Days ]")
    if _HAS_SHADOW:
        try:
            init_shadow_db()
            status = shadow_status()
            print(f"  Total: {status['total_predictions']}  "
                  f"Pending: {status['pending']}  "
                  f"Settled: {status['settled']}")
            live = compute_live_stats(n_days=7)
            champ = live["champion"]
            chal = live["challenger"]
            print(f"  Champion bets={champ['bets']} roi={champ['roi_pct']}%")
            print(f"  Challenger bets={chal['bets']} roi={chal['roi_pct']}%")
        except Exception as exc:
            print(f"  Shadow log error: {exc}")
    else:
        print("  shadow_mode module not available.")
    print()

    # Monitoring last run
    print("[ Monitoring ]")
    monitor_log = os.path.join("optimizer", "monitor_log.db")
    if os.path.exists(monitor_log):
        try:
            import sqlite3
            conn = sqlite3.connect(monitor_log)
            conn.row_factory = sqlite3.Row
            row = conn.execute(
                "SELECT run_ts, ev_7d, hit_rate_7d, ece_rolling, alerts_json, retrain_enqueued "
                "FROM monitor_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            conn.close()
            if row:
                print(f"  Last run   : {row['run_ts']}")
                print(f"  EV 7d      : {row['ev_7d']}")
                print(f"  Hit rate   : {row['hit_rate_7d']}")
                print(f"  ECE rolling: {row['ece_rolling']}")
                alerts = row["alerts_json"]
                if alerts:
                    try:
                        al = json.loads(alerts)
                        print(f"  Alerts     : {len(al)}")
                        for a in al[:3]:
                            print(f"    - {a}")
                    except Exception:
                        print(f"  Alerts     : {alerts}")
                print(f"  Retrain    : {'YES' if row['retrain_enqueued'] else 'no'}")
            else:
                print("  (no monitoring runs yet)")
        except Exception as exc:
            print(f"  Monitor log error: {exc}")
    else:
        print("  No monitor log found. Run 'monitor' to check thresholds.")

    return 0


# --------------------------------------------------------------------------- #
# Subcommand: test                                                             #
# --------------------------------------------------------------------------- #
def _synthetic() -> List[Dict[str, Any]]:
    """Generate a small synthetic game dataset for testing."""
    _ggba = _load_ggba_model()
    return _ggba._synthetic(n_games=500, seed=42)


def _find_best_csv(data_dir: str = "ggba_data") -> Optional[str]:
    """Find the best available CSV in ggba_data/."""
    import glob as _glob
    preferred = os.path.join(data_dir, "walkforward_gp10_days56.csv")
    if os.path.exists(preferred):
        return preferred
    pattern = os.path.join(data_dir, "walkforward_*.csv")
    files = _glob.glob(pattern)
    if files:
        return max(files, key=os.path.getmtime)
    return None


def cmd_test(args: argparse.Namespace) -> int:
    """End-to-end test using REAL CSV data if available, synthetic otherwise."""
    quick = hasattr(args, "quick") and args.quick

    print("=== GGBA OPTIMIZER END-TO-END TEST ===")
    print()

    # Step 1: Check for real data
    csv_path = _find_best_csv()
    use_synthetic = csv_path is None

    if use_synthetic:
        print("WARNING: No real CSV found in ggba_data/. Using SYNTHETIC data.")
        print("  Real data is preferred. Run: python3 optimizer/pipeline.py export --all")
        print()
    else:
        print(f"Using real CSV: {csv_path}")
        print()

    # Step 2: Ensure optimizer is available
    if not _HAS_OPTIMIZER:
        print("FAIL: optimizer.ggba_optimizer not available. Check installation.")
        return 1
    if not _HAS_CC:
        print("FAIL: optimizer.champion_challenger not available.")
        return 1

    # Step 3: Run the optimizer pipeline
    if use_synthetic:
        _ggba = _load_ggba_model()
        games = _ggba._synthetic(n_games=500, seed=42)
        # Write synthetic data to a temp CSV
        import csv as _csv
        import tempfile
        tf = tempfile.NamedTemporaryFile(
            mode="w", suffix=".csv", delete=False, prefix="ggba_synth_", newline=""
        )
        if games:
            writer = _csv.DictWriter(tf, fieldnames=list(games[0].keys()))
            writer.writeheader()
            writer.writerows(games)
        tf.close()
        test_csv = tf.name
        print(f"  Synthetic dataset: {len(games)} games → {test_csv}")
    else:
        test_csv = csv_path

    print(f"  Iterations: {'quick (50 random + 20 Bayesian)' if quick else 'default (200 random + 100 Bayesian)'}")
    print()

    # Monkey-patch iteration counts for --quick mode
    if quick:
        try:
            import optimizer.ggba_optimizer as _opt_mod
            _orig_random_search = _opt_mod.random_search
            _orig_bayesian_search = _opt_mod.bayesian_search

            def _quick_random(games, n_iter=200, seed=42):
                return _orig_random_search(games, n_iter=50, seed=seed)

            def _quick_bayesian(games, initial_params, n_iter=100):
                return _orig_bayesian_search(games, initial_params, n_iter=20)

            _opt_mod.random_search = _quick_random
            _opt_mod.bayesian_search = _quick_bayesian
        except Exception:
            pass  # If patching fails, run with defaults

    print("Running full optimizer pipeline ...")
    try:
        result = run_optimizer(
            csv_path=test_csv,
            champion_params=None,
            mode="global",
        )
    except Exception as exc:
        print(f"FAIL: Optimizer raised exception: {exc}")
        import traceback
        traceback.print_exc()
        if use_synthetic:
            try:
                os.unlink(test_csv)
            except OSError:
                pass
        return 1

    if use_synthetic:
        try:
            os.unlink(test_csv)
        except OSError:
            pass

    # Restore monkey-patched functions
    if quick:
        try:
            _opt_mod.random_search = _orig_random_search
            _opt_mod.bayesian_search = _orig_bayesian_search
        except Exception:
            pass

    print("  Optimizer complete.")
    print()

    # Step 4: Extract metrics and compute hybrid_loss
    metrics = result.get("metrics", {})
    if "hybrid_loss" not in metrics:
        hl = _hybrid_loss_from_metrics(metrics)
        if hl is not None:
            metrics["hybrid_loss"] = hl
    # Expose biasOffset from hyperparams so the Betting Offset gate can read it
    if "biasOffset" not in metrics:
        metrics["biasOffset"] = result.get("hyperparams", {}).get("biasOffset", 0.0)

    # Step 5: Check all metric targets
    print("=== TEST RESULTS ===")
    all_pass = True
    results_lines = []
    for name, key, target, direction, fmt in METRIC_TARGETS:
        raw = metrics.get(key)
        passed = _check_target(raw, target, direction)

        if raw is not None:
            val_str = f"{raw:{fmt}}"
        else:
            val_str = "N/A"

        target_str = _fmt_target(target, direction, fmt)

        if passed is None:
            status = "INFO"
            line = f"  INFO  {name:<15} {val_str:>8}  {target_str:>10}"
        elif passed:
            status = "PASS"
            line = f"  PASS  {name:<15} {val_str:>8}  {target_str:>10}"
        else:
            status = "FAIL"
            line = f"  FAIL  {name:<15} {val_str:>8}  {target_str:>10}"
            all_pass = False

        results_lines.append(line)
        print(line)

    print()
    leakage = result.get("leakage_diag", {})
    if leakage:
        clean = leakage.get("clean", True)
        print(f"  Leakage check: {'CLEAN' if clean else 'WARNING — overlap detected'}")
        if not clean:
            print(f"    overlap_count={leakage.get('overlap_count')} "
                  f"latest_train={leakage.get('latest_train')} "
                  f"earliest_test={leakage.get('earliest_test')}")

    rob = result.get("robustness", {})
    if rob:
        mae_std = rob.get("mae_std")
        if mae_std is not None:
            print(f"  MAE std across folds: {mae_std:.3f}")

    print()
    if all_pass:
        print("RESULT: ALL TARGETS PASS")
    else:
        print("RESULT: SOME TARGETS FAIL (may be expected with synthetic data)")

    return 0 if all_pass else 1


# --------------------------------------------------------------------------- #
# Argument parser                                                              #
# --------------------------------------------------------------------------- #
def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pipeline",
        description="GGBA Optimizer — champion/challenger pipeline for GG League betting analytics.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 optimizer/pipeline.py export --all
  python3 optimizer/pipeline.py export --gp 10 --days 56
  python3 optimizer/pipeline.py optimize --csv ggba_data/walkforward_gp10_days56.csv
  python3 optimizer/pipeline.py optimize --csv ggba_data/walkforward_gp10_days56.csv --mode neighborhood
  python3 optimizer/pipeline.py shadow
  python3 optimizer/pipeline.py shadow --log-game gid123 PlayerA PlayerB 68 72
  python3 optimizer/pipeline.py monitor
  python3 optimizer/pipeline.py schedule
  python3 optimizer/pipeline.py schedule --daemon
  python3 optimizer/pipeline.py status
  python3 optimizer/pipeline.py test
  python3 optimizer/pipeline.py test --quick
""",
    )

    sub = parser.add_subparsers(dest="command", metavar="COMMAND")
    sub.required = True

    # export
    exp_p = sub.add_parser("export", help="Export walk-forward CSV datasets")
    exp_mode = exp_p.add_mutually_exclusive_group()
    exp_mode.add_argument("--all", action="store_true", help="Export all 36 GP/days combos")
    exp_p.add_argument("--gp", type=int, metavar="GP", help="GP bucket (e.g. 10)")
    exp_p.add_argument("--days", type=int, metavar="DAYS", help="Day window (e.g. 56)")

    # optimize
    opt_p = sub.add_parser("optimize", help="Run optimizer and update champion/challenger")
    opt_p.add_argument("--csv", required=True, metavar="CSV_PATH", help="Path to walk-forward CSV")
    opt_p.add_argument(
        "--mode",
        choices=["global", "neighborhood"],
        default="global",
        help="Search mode: global (random+Bayesian) or neighborhood (around champion)",
    )
    opt_p.add_argument("--iters", type=int, default=None, metavar="N",
                       help="Override number of optimizer iterations")

    # shadow
    shad_p = sub.add_parser("shadow", help="Shadow mode predictions and status")
    shad_p.add_argument(
        "--log-game",
        nargs=5,
        metavar=("GAME_ID", "PLAYER1", "PLAYER2", "SCORE1", "SCORE2"),
        help="Log a completed game to shadow DB",
    )

    # monitor
    mon_p = sub.add_parser("monitor", help="Run one monitoring cycle")
    mon_p.add_argument("--baseline-ece", type=float, default=None,
                       metavar="FLOAT", help="Override baseline ECE threshold")

    # schedule
    sched_p = sub.add_parser("schedule", help="Start the full APScheduler")
    sched_p.add_argument("--daemon", action="store_true",
                         help="Run scheduler in background without blocking")

    # status
    sub.add_parser("status", help="Print current system status")

    # test
    test_p = sub.add_parser("test", help="Run end-to-end pipeline test")
    test_p.add_argument("--quick", action="store_true",
                        help="Use fewer iterations (50 random + 20 Bayesian) for speed")

    return parser


# --------------------------------------------------------------------------- #
# Main                                                                         #
# --------------------------------------------------------------------------- #
_COMMAND_MAP = {
    "export":   cmd_export,
    "optimize": cmd_optimize,
    "shadow":   cmd_shadow,
    "monitor":  cmd_monitor,
    "schedule": cmd_schedule,
    "status":   cmd_status,
    "test":     cmd_test,
}


def main() -> int:
    """Parse arguments and dispatch to the appropriate subcommand."""
    parser = _build_parser()
    args = parser.parse_args()

    handler = _COMMAND_MAP.get(args.command)
    if handler is None:
        parser.print_help()
        return 1

    return handler(args)


if __name__ == "__main__":
    sys.exit(main())

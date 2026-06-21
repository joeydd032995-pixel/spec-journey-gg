#!/usr/bin/env python3
"""
shadow_mode.py — Shadow Mode Service for the GGBA Optimizer pipeline.

Runs challenger predictions in parallel with champion predictions on live games.
Only champion predictions drive actual bet signals. Challenger runs in shadow-only
mode so we can validate it on real live data before promoting it to champion.

Usage:
    from optimizer.shadow_mode import (
        init_shadow_db, log_prediction, settle_game,
        compute_live_stats, check_promotion_trigger, shadow_status
    )
"""
from __future__ import annotations

import importlib.util
import math
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Optional

# ---------------------------------------------------------------------------
# Import ggba_model (handles the space in the filename)
# ---------------------------------------------------------------------------
import sys as _sys
_spec = importlib.util.spec_from_file_location(
    "ggba_model",
    os.path.join(os.path.dirname(__file__), "..", "ggba model.py")
)
_m = importlib.util.module_from_spec(_spec)
_sys.modules["ggba_model"] = _m  # register before exec so dataclasses can resolve __module__
_spec.loader.exec_module(_m)
OnlineRatings = _m.OnlineRatings
prob_over = _m.prob_over

# ---------------------------------------------------------------------------
# Default paths
# ---------------------------------------------------------------------------
SHADOW_DB_PATH = "optimizer/shadow_log.db"
CHAMPION_PATH = "optimizer/ggba_champion.json"
CHALLENGER_PATH = "optimizer/challenger.json"

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS shadow_predictions (
    id                  INTEGER PRIMARY KEY,
    game_id             TEXT NOT NULL,
    game_date           TEXT,
    player1             TEXT,
    player2             TEXT,
    champion_pred       REAL,
    challenger_pred     REAL,
    champion_sigma      REAL,
    challenger_sigma    REAL,
    actual_total        REAL,
    champion_bet        TEXT,
    challenger_bet      TEXT,
    champion_outcome    TEXT,
    challenger_outcome  TEXT,
    champion_pnl        REAL,
    challenger_pnl      REAL,
    logged_at           TEXT
)
"""

_CREATE_INDEX_SQL = """
CREATE UNIQUE INDEX IF NOT EXISTS idx_shadow_game_id
    ON shadow_predictions(game_id)
"""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _now_utc() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _connect(path: str) -> sqlite3.Connection:
    """Open a sqlite3 connection with WAL mode and foreign keys on."""
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _pnl(outcome: str, odds: float = -110) -> float:
    """Convert a bet outcome string to PnL per unit staked.

    'win'     ->  payout multiple at given American odds
    'loss'    -> -1
    'no_bet'  ->  0
    'pending' ->  0  (unresolved)
    """
    if outcome == "win":
        return 100.0 / -odds if odds < 0 else odds / 100.0
    if outcome == "loss":
        return -1.0
    return 0.0  # no_bet or pending


def _predict_for_params(game: dict, params: dict) -> tuple:
    """Generate a projected total and sigma for a live upcoming game.

    Since this is a live game (no full historical warm-up available), we use
    the player's supplied scoring averages (p1_pts, p2_pts) as the projection
    baseline.  The OnlineRatings model is initialised cold and seeded with
    those averages so that predict() gives us an opponent-adjusted projection
    with the correct league-mean accounting.

    Returns (proj, sigma) — both floats.
    """
    p1_pts = float(game.get("p1_pts") or 65.0)
    p2_pts = float(game.get("p2_pts") or 65.0)
    p1_gp = max(int(game.get("p1_gp") or 1), 1)
    p2_gp = max(int(game.get("p2_gp") or 1), 1)

    player1 = str(game.get("player1", "P1"))
    player2 = str(game.get("player2", "P2"))
    p1_team = str(game.get("p1_team", "T1") or "T1")
    p2_team = str(game.get("p2_team", "T2") or "T2")

    dispersion = float(params.get("dispersion", 1.20))

    # Warm up a fresh OnlineRatings instance with the players' historical
    # averages so that league_mean() and their ratings are meaningful.
    # We replay each player "gp" synthetic games against an anonymous opponent
    # at their known average score, giving the model a realistic prior.
    R = OnlineRatings(
        etaP=float(params.get("etaP", 0.08)),
        etaT=float(params.get("etaT", 0.04)),
        decay=float(params.get("decay", 0.0)),
    )

    # Feed historical performance into the model (opponent-blind warm-up).
    # We use neutral opponents so we don't bias their defensive ratings;
    # the goal is to seed each player's offensive rating from their averages.
    warmup_games = max(p1_gp, p2_gp)
    for i in range(warmup_games):
        if i < p1_gp:
            R.update(player1, p1_team, "__OPP__", "__OPP_T__", p1_pts, p2_pts)
        if i < p2_gp:
            R.update(player2, p2_team, "__OPP__", "__OPP_T__", p2_pts, p1_pts)

    # Now predict the actual matchup using learned ratings
    _, _, total = R.predict(player1, p1_team, player2, p2_team)
    proj = round(total, 1)
    sigma = math.sqrt(max(proj, 1.0) * dispersion)
    return proj, sigma


def _decide_bet(proj: float, sigma: float, params: dict) -> str:
    """Decide 'over', 'under', or 'no_bet' given a projection + model params.

    Uses the implied line (proj itself as a proxy when no external line is
    available) and the edge threshold from params.
    """
    edge_thresh = float(params.get("edge", 0.03))
    odds = float(params.get("odds", -110))

    # Implied probability at the juice level
    implied = (-odds) / (-odds + 100.0) if odds < 0 else 100.0 / (odds + 100.0)

    # Use rounded half-point line centred on the projection as a proxy line.
    line = round(proj) + 0.5
    p_over = prob_over(proj, sigma, line)
    if p_over is None:
        return "no_bet"

    if p_over - implied > edge_thresh:
        return "over"
    if (1.0 - p_over) - implied > edge_thresh:
        return "under"
    return "no_bet"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def init_shadow_db(path: str = SHADOW_DB_PATH) -> None:
    """Create shadow_log.db and its schema if not already present."""
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)

    with _connect(path) as conn:
        conn.execute(_CREATE_TABLE_SQL)
        conn.execute(_CREATE_INDEX_SQL)
        conn.commit()


def log_prediction(
    game: dict,
    champion_params: dict,
    challenger_params: dict,
    path: str = SHADOW_DB_PATH,
) -> str:
    """Generate and log predictions for a live upcoming game.

    Parameters
    ----------
    game : dict
        Must contain: game_id, date, player1, player2, p1_team, p2_team,
        p1_gp, p2_gp.  Optionally: p1_pts, p2_pts (recent scoring averages).
    champion_params : dict
        Model hyper-parameters for the champion: etaP, etaT, decay,
        dispersion, edge.
    challenger_params : dict
        Same structure for the challenger.
    path : str
        Path to shadow_log.db.

    Returns
    -------
    str
        The game_id that was logged.

    Notes
    -----
    Only the champion model generates real bet signals.  The challenger is
    shadow-only: its bet direction is stored but never acted upon until
    settle_game() reveals live performance.
    """
    game_id = str(game["game_id"])

    champ_proj, champ_sigma = _predict_for_params(game, champion_params)
    chal_proj, chal_sigma = _predict_for_params(game, challenger_params)

    # Champion decides a real bet signal; challenger is shadow-only.
    champ_bet = _decide_bet(champ_proj, champ_sigma, champion_params)
    chal_bet = _decide_bet(chal_proj, chal_sigma, challenger_params)

    now = _now_utc()

    with _connect(path) as conn:
        conn.execute(
            """
            INSERT INTO shadow_predictions (
                game_id, game_date, player1, player2,
                champion_pred, challenger_pred,
                champion_sigma, challenger_sigma,
                actual_total,
                champion_bet, challenger_bet,
                champion_outcome, challenger_outcome,
                champion_pnl, challenger_pnl,
                logged_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id) DO UPDATE SET
                game_date=excluded.game_date,
                player1=excluded.player1,
                player2=excluded.player2,
                champion_pred=excluded.champion_pred,
                challenger_pred=excluded.challenger_pred,
                champion_sigma=excluded.champion_sigma,
                challenger_sigma=excluded.challenger_sigma,
                champion_bet=excluded.champion_bet,
                challenger_bet=excluded.challenger_bet,
                logged_at=excluded.logged_at
            WHERE shadow_predictions.champion_outcome = 'pending'
            """,
            (
                game_id,
                str(game.get("date", "")),
                str(game.get("player1", "")),
                str(game.get("player2", "")),
                champ_proj,
                chal_proj,
                champ_sigma,
                chal_sigma,
                None,        # actual_total — unknown until game completes
                champ_bet,
                chal_bet,
                "pending",   # champion_outcome
                "pending",   # challenger_outcome
                0.0,         # champion_pnl — settled later
                0.0,         # challenger_pnl — settled later
                now,
            ),
        )
        conn.commit()

    return game_id


def settle_game(
    game_id: str,
    actual_total: float,
    edge_thresh: float = 0.03,
    odds: float = -110,
    path: str = SHADOW_DB_PATH,
) -> dict:
    """Update a pending prediction with the actual result.

    Computes outcomes ('win' | 'loss' | 'no_bet') and PnL for both champion
    and challenger.

    Parameters
    ----------
    game_id : str
    actual_total : float
        The real observed total score for this game.
    edge_thresh : float
        Edge threshold (informational; bet direction is already stored).
    odds : float
        American odds used to calculate PnL (default -110).
    path : str

    Returns
    -------
    dict
        {champion_outcome, challenger_outcome, champion_pnl, challenger_pnl}
    """
    with _connect(path) as conn:
        row = conn.execute(
            "SELECT champion_pred, challenger_pred, champion_bet, challenger_bet "
            "FROM shadow_predictions WHERE game_id = ?",
            (game_id,),
        ).fetchone()

        if row is None:
            raise ValueError(f"game_id {game_id!r} not found in shadow DB")

        champ_bet = row["champion_bet"]
        chal_bet = row["challenger_bet"]
        champ_pred = row["champion_pred"]
        chal_pred = row["challenger_pred"]

        # Use the half-point line centred on each model's own projection.
        champ_line = round(champ_pred) + 0.5
        chal_line = round(chal_pred) + 0.5

        def _outcome(bet: str, line: float, actual: float) -> str:
            if bet == "no_bet":
                return "no_bet"
            if bet == "over":
                return "win" if actual > line else "loss"
            if bet == "under":
                return "win" if actual < line else "loss"
            return "no_bet"

        champ_outcome = _outcome(champ_bet, champ_line, actual_total)
        chal_outcome = _outcome(chal_bet, chal_line, actual_total)

        champ_pnl = _pnl(champ_outcome, odds)
        chal_pnl = _pnl(chal_outcome, odds)

        conn.execute(
            """
            UPDATE shadow_predictions
               SET actual_total       = ?,
                   champion_outcome   = ?,
                   challenger_outcome = ?,
                   champion_pnl       = ?,
                   challenger_pnl     = ?
             WHERE game_id = ?
            """,
            (
                actual_total,
                champ_outcome,
                chal_outcome,
                champ_pnl,
                chal_pnl,
                game_id,
            ),
        )
        conn.commit()

    return {
        "champion_outcome": champ_outcome,
        "challenger_outcome": chal_outcome,
        "champion_pnl": champ_pnl,
        "challenger_pnl": chal_pnl,
    }


def compute_live_stats(
    n_days: Optional[int] = None,
    n_bets: Optional[int] = None,
    path: str = SHADOW_DB_PATH,
) -> dict:
    """Compute live ROI, win-rate, and mean PnL for both champion and challenger.

    Parameters
    ----------
    n_days : int or None
        Restrict to rows logged in the last n_days days (takes precedence over
        n_bets when both are specified).
    n_bets : int or None
        Restrict to the most recent n_bets settled bets per model.
    path : str

    Returns
    -------
    dict
        {
          'champion':   {roi_pct, win_rate, bets, mean_pnl, ev_7d},
          'challenger': {roi_pct, win_rate, bets, mean_pnl, ev_7d},
          'sample_period': {start, end, days}
        }
    """
    with _connect(path) as conn:
        if n_days is not None:
            cutoff_dt = datetime.now(timezone.utc) - timedelta(days=n_days)
            cutoff_str = cutoff_dt.strftime("%Y-%m-%dT%H:%M:%SZ")
            rows = conn.execute(
                """
                SELECT champion_outcome, challenger_outcome,
                       champion_pnl,    challenger_pnl,
                       champion_bet,    challenger_bet,
                       logged_at
                  FROM shadow_predictions
                 WHERE champion_outcome NOT IN ('pending')
                   AND logged_at >= ?
                 ORDER BY logged_at ASC
                """,
                (cutoff_str,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT champion_outcome, challenger_outcome,
                       champion_pnl,    challenger_pnl,
                       champion_bet,    challenger_bet,
                       logged_at
                  FROM shadow_predictions
                 WHERE champion_outcome NOT IN ('pending')
                 ORDER BY logged_at ASC
                """
            ).fetchall()

    # Apply n_bets trim (most recent settled bets); n_days takes precedence.
    if n_days is None and n_bets is not None and len(rows) > n_bets:
        rows = rows[-n_bets:]

    def _stats(outcome_key: str, pnl_key: str, bet_key: str) -> dict:
        bet_rows = [r for r in rows if r[bet_key] != "no_bet"]
        n = len(bet_rows)
        if n == 0:
            return {
                "roi_pct": None,
                "win_rate": None,
                "bets": 0,
                "mean_pnl": None,
                "ev_7d": None,
            }
        wins = sum(1 for r in bet_rows if r[outcome_key] == "win")
        total_pnl = sum(r[pnl_key] for r in bet_rows)
        roi_pct = (total_pnl / n) * 100.0
        win_rate = wins / n
        mean_pnl = total_pnl / n
        last7 = bet_rows[-7:] if len(bet_rows) >= 7 else bet_rows
        ev_7d = sum(r[pnl_key] for r in last7) / len(last7) if last7 else None
        return {
            "roi_pct": round(roi_pct, 4),
            "win_rate": round(win_rate, 4),
            "bets": n,
            "mean_pnl": round(mean_pnl, 4),
            "ev_7d": round(ev_7d, 4) if ev_7d is not None else None,
        }

    champion_stats = _stats("champion_outcome", "champion_pnl", "champion_bet")
    challenger_stats = _stats("challenger_outcome", "challenger_pnl", "challenger_bet")

    if rows:
        start_dt = rows[0]["logged_at"]
        end_dt = rows[-1]["logged_at"]
        try:
            s = datetime.strptime(start_dt, "%Y-%m-%dT%H:%M:%SZ")
            e = datetime.strptime(end_dt, "%Y-%m-%dT%H:%M:%SZ")
            days = (e - s).days + 1
        except (ValueError, TypeError):
            days = None
        sample_period = {"start": start_dt, "end": end_dt, "days": days}
    else:
        sample_period = {"start": None, "end": None, "days": 0}

    return {
        "champion": champion_stats,
        "challenger": challenger_stats,
        "sample_period": sample_period,
    }


def check_promotion_trigger(
    min_bets: int = 50,
    roi_margin: float = 2.0,
    path: str = SHADOW_DB_PATH,
) -> dict:
    """Check if the challenger dominates the champion on live shadow data.

    Promotion criteria (all must be true):
    - Challenger has at least ``min_bets`` settled bets.
    - Challenger ROI > Champion ROI + ``roi_margin`` (percentage points).
    - Challenger win_rate > Champion win_rate.

    Parameters
    ----------
    min_bets : int
        Minimum number of settled bets the challenger must have.
    roi_margin : float
        Minimum percentage-point ROI advantage the challenger needs.
    path : str

    Returns
    -------
    dict
        {should_promote: bool, reason: str, live_stats: dict}
    """
    live_stats = compute_live_stats(path=path)
    champ = live_stats["champion"]
    chal = live_stats["challenger"]

    chal_bets = chal["bets"]
    chal_roi = chal["roi_pct"]
    champ_roi = champ["roi_pct"]
    chal_wr = chal["win_rate"]
    champ_wr = champ["win_rate"]

    if chal_bets < min_bets:
        return {
            "should_promote": False,
            "reason": (
                f"Insufficient challenger sample: {chal_bets} bets "
                f"(need >= {min_bets})"
            ),
            "live_stats": live_stats,
        }

    if chal_roi is None or champ_roi is None:
        return {
            "should_promote": False,
            "reason": "ROI data unavailable for one or both models",
            "live_stats": live_stats,
        }

    if chal_wr is None or champ_wr is None:
        return {
            "should_promote": False,
            "reason": "Win-rate data unavailable for one or both models",
            "live_stats": live_stats,
        }

    roi_ok = chal_roi > champ_roi + roi_margin
    wr_ok = chal_wr > champ_wr

    if roi_ok and wr_ok:
        return {
            "should_promote": True,
            "reason": (
                f"Challenger dominates: ROI {chal_roi:.2f}% vs {champ_roi:.2f}% "
                f"(margin {chal_roi - champ_roi:.2f}pp >= {roi_margin}pp), "
                f"win_rate {chal_wr:.3f} vs {champ_wr:.3f}"
            ),
            "live_stats": live_stats,
        }

    reasons = []
    if not roi_ok:
        reasons.append(
            f"challenger ROI {chal_roi:.2f}% does not exceed champion "
            f"{champ_roi:.2f}% + {roi_margin}pp margin"
        )
    if not wr_ok:
        reasons.append(
            f"challenger win_rate {chal_wr:.3f} not > champion {champ_wr:.3f}"
        )

    return {
        "should_promote": False,
        "reason": "; ".join(reasons),
        "live_stats": live_stats,
    }


def get_pending_games(path: str = SHADOW_DB_PATH) -> list:
    """Return all games where the outcome is still 'pending'.

    Returns
    -------
    list[dict]
        Each dict has: game_id, game_date, player1, player2,
        champion_pred, challenger_pred, champion_bet, challenger_bet,
        logged_at.
    """
    with _connect(path) as conn:
        rows = conn.execute(
            """
            SELECT game_id, game_date, player1, player2,
                   champion_pred, challenger_pred,
                   champion_bet, challenger_bet,
                   logged_at
              FROM shadow_predictions
             WHERE champion_outcome = 'pending'
             ORDER BY logged_at ASC
            """
        ).fetchall()

    return [dict(r) for r in rows]


def shadow_status(path: str = SHADOW_DB_PATH) -> dict:
    """Return summary statistics for monitoring purposes.

    Returns
    -------
    dict
        {
          total_predictions: int,
          pending: int,
          settled: int,
          champion_active: bool   # True when champion has at least one bet
        }
    """
    with _connect(path) as conn:
        total = conn.execute(
            "SELECT COUNT(*) FROM shadow_predictions"
        ).fetchone()[0]

        pending = conn.execute(
            "SELECT COUNT(*) FROM shadow_predictions "
            "WHERE champion_outcome = 'pending'"
        ).fetchone()[0]

        settled = conn.execute(
            "SELECT COUNT(*) FROM shadow_predictions "
            "WHERE champion_outcome != 'pending'"
        ).fetchone()[0]

        champion_active = conn.execute(
            "SELECT COUNT(*) FROM shadow_predictions "
            "WHERE champion_bet != 'no_bet'"
        ).fetchone()[0] > 0

    return {
        "total_predictions": total,
        "pending": pending,
        "settled": settled,
        "champion_active": champion_active,
    }

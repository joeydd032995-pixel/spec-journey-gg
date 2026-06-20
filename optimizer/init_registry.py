#!/usr/bin/env python3
"""
init_registry.py — Initialize and manage the SQLite experiments registry for the
GGBA Optimizer champion/challenger system.

Each optimizer run is logged as an experiment row, capturing parameters, metrics,
whether the run was promoted to champion, the rejection reason (if any), and the
champion version at the time of the run.
"""

import json
import os
import sqlite3
from datetime import datetime, timezone

REGISTRY_PATH = "optimizer/experiments_registry.db"


def init_registry(path: str = REGISTRY_PATH) -> None:
    """Create the experiments_registry.db SQLite file and schema if not exists.

    Table: experiments(
        id                      INTEGER PRIMARY KEY,
        run_ts                  TEXT,
        version                 INTEGER,
        params_json             TEXT,
        metrics_json            TEXT,
        promoted                INTEGER,
        reason                  TEXT,
        champion_version_at_time INTEGER
    )
    """
    os.makedirs(os.path.dirname(path) if os.path.dirname(path) else ".", exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS experiments (
                id                       INTEGER PRIMARY KEY,
                run_ts                   TEXT NOT NULL,
                version                  INTEGER,
                params_json              TEXT,
                metrics_json             TEXT,
                promoted                 INTEGER NOT NULL DEFAULT 0,
                reason                   TEXT,
                champion_version_at_time INTEGER
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def log_experiment(
    params: dict,
    metrics: dict,
    promoted: bool,
    reason: str,
    champion_version: int = None,
    path: str = REGISTRY_PATH,
) -> int:
    """Insert one experiment row into the registry.

    Parameters
    ----------
    params:            Hyperparameter dict for this run.
    metrics:           Metric dict for this run.
    promoted:          True if this run was promoted to champion.
    reason:            Human-readable reason string (pass/fail summary).
    champion_version:  Version integer of the current champion at the time of this run.
    path:              Path to the SQLite database file.

    Returns
    -------
    int: The row id of the inserted record.
    """
    run_ts = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(path)
    try:
        cursor = conn.execute(
            """
            INSERT INTO experiments
                (run_ts, params_json, metrics_json, promoted, reason, champion_version_at_time)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                run_ts,
                json.dumps(params),
                json.dumps(metrics),
                1 if promoted else 0,
                reason,
                champion_version,
            ),
        )
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def get_experiments(path: str = REGISTRY_PATH, limit: int = 50) -> list:
    """Fetch recent experiments from the registry, newest first.

    Parameters
    ----------
    path:   Path to the SQLite database file.
    limit:  Maximum number of rows to return.

    Returns
    -------
    list[dict]: Each dict has keys: id, run_ts, version, params, metrics,
                promoted (bool), reason, champion_version_at_time.
    """
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.execute(
            """
            SELECT id, run_ts, version, params_json, metrics_json,
                   promoted, reason, champion_version_at_time
            FROM experiments
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = cursor.fetchall()
        results = []
        for row in rows:
            results.append(
                {
                    "id": row["id"],
                    "run_ts": row["run_ts"],
                    "version": row["version"],
                    "params": json.loads(row["params_json"]) if row["params_json"] else {},
                    "metrics": json.loads(row["metrics_json"]) if row["metrics_json"] else {},
                    "promoted": bool(row["promoted"]),
                    "reason": row["reason"],
                    "champion_version_at_time": row["champion_version_at_time"],
                }
            )
        return results
    finally:
        conn.close()

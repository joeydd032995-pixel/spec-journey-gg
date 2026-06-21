#!/usr/bin/env python3
"""
data_validator.py — Schema validation and chronological-order checks for GGBA CSV data.

Validates that a CSV file loaded from ``ggba model.py``'s ``load_csv()`` meets the
required schema before it is handed to the optimizer.
"""
from __future__ import annotations

import csv
import math
from datetime import date as _date
from typing import Any, Dict, List, Optional

REQUIRED_COLUMNS: List[str] = ['date', 'player1', 'player2', 'score1', 'score2']
OPTIONAL_STRING_COLUMNS: List[str] = ['p1_team', 'p2_team', 'p1_form', 'p2_form']
OPTIONAL_NUMERIC_COLUMNS: List[str] = [
    'p1_gp', 'p2_gp', 'actual_total',
    'p1_win_pct', 'p1_ppm', 'p2_win_pct', 'p2_ppm', 'hour_utc',
]
OPTIONAL_COLUMNS: List[str] = OPTIONAL_STRING_COLUMNS + OPTIONAL_NUMERIC_COLUMNS


def _parse_date(date_str: str) -> Optional[_date]:
    """Return a ``datetime.date`` for chronological comparison, or None on failure.

    Accepts YYYY-MM-DD and MM/DD/YYYY formats.
    """
    s = str(date_str).strip()
    if not s:
        return None
    # MM/DD/YYYY
    if len(s) == 10 and s[2] == '/' and s[5] == '/':
        try:
            return _date(int(s[6:]), int(s[:2]), int(s[3:5]))
        except (ValueError, TypeError):
            pass
    # YYYY-MM-DD
    try:
        return _date(int(s[:4]), int(s[5:7]), int(s[8:10]))
    except (ValueError, TypeError, IndexError):
        pass
    return None


def check_chronological(games: List[Dict[str, Any]]) -> bool:
    """Return True if *games* are sorted by date ascending (required for leakage-free walk-forward)."""
    prev: Optional[_date] = None
    for g in games:
        cur = _parse_date(g.get('date', ''))
        if cur is None:
            continue
        if prev is not None and cur < prev:
            return False
        prev = cur
    return True


def load_and_validate(csv_path: str) -> List[Dict[str, Any]]:
    """Load a CSV file and validate its schema and chronological order.

    Parameters
    ----------
    csv_path:
        Absolute or relative path to the walk-forward CSV.

    Returns
    -------
    list[dict]
        Validated list of game dicts (one per row).

    Raises
    ------
    ValueError
        With a clear human-readable message if the file is missing required
        columns, contains unparseable numeric fields, or is not in chronological
        order.
    FileNotFoundError
        If *csv_path* does not exist.
    """
    with open(csv_path, newline='', encoding='utf-8-sig') as fh:
        reader = csv.DictReader(fh)
        if reader.fieldnames is None:
            raise ValueError(f"CSV file '{csv_path}' appears to be empty (no header row).")
        header = [c.strip() for c in reader.fieldnames]
        missing = [col for col in REQUIRED_COLUMNS if col not in header]
        if missing:
            raise ValueError(
                f"CSV file '{csv_path}' is missing required column(s): {missing}. "
                f"Found columns: {header}"
            )
        games: List[Dict[str, Any]] = []
        for lineno, raw_row in enumerate(reader, start=2):
            row: Dict[str, Any] = {k.strip(): v for k, v in raw_row.items() if k is not None}

            # Validate required numeric fields
            for num_col in ('score1', 'score2'):
                val = row.get(num_col, '')
                if val in (None, ''):
                    raise ValueError(
                        f"Row {lineno}: required column '{num_col}' is empty."
                    )
                try:
                    f = float(val)
                    if not math.isfinite(f):
                        raise ValueError(f"Row {lineno}: '{num_col}' is not a finite number: {val!r}")
                    row[num_col] = f
                except (TypeError, ValueError) as exc:
                    raise ValueError(
                        f"Row {lineno}: cannot parse '{num_col}' as a number: {val!r}"
                    ) from exc

            # Validate required string fields are non-empty
            for str_col in ('date', 'player1', 'player2'):
                val = row.get(str_col, '')
                if not str(val).strip():
                    raise ValueError(
                        f"Row {lineno}: required column '{str_col}' is empty."
                    )

            # Coerce optional numeric fields if present
            for opt_col in OPTIONAL_NUMERIC_COLUMNS:
                val = row.get(opt_col, '')
                if val not in (None, ''):
                    try:
                        row[opt_col] = float(val)
                    except (TypeError, ValueError):
                        pass  # leave as string; model handles via _num()

            games.append(row)

    if not games:
        raise ValueError(f"CSV file '{csv_path}' contains no data rows (only a header).")

    if not check_chronological(games):
        raise ValueError(
            f"CSV file '{csv_path}' is NOT in chronological order. "
            "Walk-forward validation requires games sorted by date ascending."
        )

    return games

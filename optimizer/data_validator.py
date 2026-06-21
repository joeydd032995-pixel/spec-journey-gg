#!/usr/bin/env python3
"""
data_validator.py — Schema validation and chronological-order checks for GGBA CSV data.

Validates that a CSV file loaded from ``ggba model.py``'s ``load_csv()`` meets the
required schema before it is handed to the optimizer.
"""
from __future__ import annotations

import csv
import math
from typing import List, Dict, Any

REQUIRED_COLUMNS: List[str] = ['date', 'player1', 'player2', 'score1', 'score2']
OPTIONAL_COLUMNS: List[str] = ['p1_team', 'p2_team', 'p1_gp', 'p2_gp', 'actual_total']


def _parse_date(date_str: str) -> str:
    """Return a normalised ISO-8601 date string (YYYY-MM-DD) for comparison.

    Accepts YYYY-MM-DD and MM/DD/YYYY formats; otherwise returns the raw string
    so alphabetical comparison still works on consistent formats.
    """
    s = str(date_str).strip()
    if not s:
        return s
    # MM/DD/YYYY -> YYYY-MM-DD
    if len(s) == 10 and s[2] == '/' and s[5] == '/':
        try:
            mm, dd, yyyy = s[:2], s[3:5], s[6:]
            return f"{yyyy}-{mm}-{dd}"
        except Exception:
            pass
    return s


def check_chronological(games: List[Dict[str, Any]]) -> bool:
    """Return True if *games* are sorted by date ascending (required for leakage-free walk-forward).

    Compares adjacent normalised date strings lexicographically — works for
    ISO-8601 (YYYY-MM-DD) dates without importing datetime.
    """
    prev = None
    for g in games:
        cur = _parse_date(g.get('date', ''))
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
            row: Dict[str, Any] = {k.strip(): v for k, v in raw_row.items()}

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
            for opt_col in ('p1_gp', 'p2_gp', 'actual_total'):
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

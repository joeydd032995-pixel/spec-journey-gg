#!/usr/bin/env python3
"""
optimizer/export_datasets.py — CSV export engine for the GGBA Optimizer pipeline.

Fetches real game data from the h2hggl open API and exports walk-forward CSVs
covering all combinations of GP buckets and day windows used by the champion/
challenger optimization system.

Filename pattern: ggba_data/walkforward_gp{GP}_days{D}.csv

Usage:
  python3 optimizer/export_datasets.py --all              # export all 36 combos
  python3 optimizer/export_datasets.py --gp 10 --days 56 # single combo
  python3 optimizer/export_datasets.py --list             # print what would be exported

Requires only httpx:
  pip install httpx
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

try:
    import httpx
except ImportError:
    raise ImportError("httpx not installed. Run: pip install httpx") from None

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #
API_BASE = "https://api-h2h.hudstats.com/v1"
SPORT = "nba"
SITE_BASE = "https://h2hggl.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
POLITE_DELAY_S = 0.8
REQUEST_TIMEOUT = 25.0

# Optimizer grid
GP_BUCKETS = [10, 15, 20, 25, 30, 40]
DAY_WINDOWS = [14, 28, 35, 42, 49, 56]

# Bug 1 fix: OUTPUT_DIR is repo-root relative, not cwd relative
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUTPUT_DIR = os.path.join(_REPO_ROOT, "ggba_data")

ENDED = "MATCH_ENDED"


# --------------------------------------------------------------------------- #
# HTTP client (mirrors ggba_h2hggl.py _Client)
# --------------------------------------------------------------------------- #
class _Client:
    """Minimal polite HTTP client for the h2hggl/hudstats JSON API."""

    def __init__(self) -> None:
        """Initialize the HTTP client with polite-delay tracking."""
        self._last = 0.0
        self._http = httpx.Client(
            timeout=REQUEST_TIMEOUT,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Origin": SITE_BASE,
                "Referer": SITE_BASE + "/",
            },
        )

    def _get(self, path: str, params: dict | None = None) -> Any:
        """GET *path* with rate-limiting and exponential backoff for transient server errors.

        4xx client errors (including 400 "date out of range") are raised immediately
        without retry; only 429/5xx transient errors are retried.
        """
        url = f"{API_BASE}/{path.lstrip('/')}"
        for attempt in range(4):
            gap = POLITE_DELAY_S - (time.time() - self._last)
            if gap > 0:
                time.sleep(gap)
            try:
                resp = self._http.get(url, params=params)
                self._last = time.time()
                # Raise immediately on 4xx — client errors are not transient.
                if 400 <= resp.status_code < 500:
                    resp.raise_for_status()
                # 5xx and 429: retry with backoff.
                if resp.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                resp.raise_for_status()
                return resp.json()
            except httpx.HTTPStatusError as e:
                if 400 <= e.response.status_code < 500 or attempt == 3:
                    raise
                time.sleep(2 ** attempt)
            except httpx.HTTPError:
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
        raise RuntimeError("unreachable")

    def participants(self) -> list[dict]:
        """Return all participant records with full season stats."""
        data = self._get(f"participant/{SPORT}")
        return data if isinstance(data, list) else []

    def schedule_day(self, day: datetime) -> list[dict]:
        """Return fixtures for a single UTC calendar day, or [] if date is out of API range."""
        iso = day.astimezone(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
        try:
            data = self._get(f"schedule/{SPORT}", params={"date": iso})
            return data if isinstance(data, list) else []
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 400:
                return []  # API window exceeded — treat as no data
            raise

    def schedule_range(self, days: int) -> list[dict]:
        """Collect *days* daily schedules going backward, starting from yesterday.

        Bug 3 fix: start from d=1 (yesterday) so we fetch days 1..N inclusive.
        Day 0 (today) has mostly no ended games and is skipped.
        """
        out: list[dict] = []
        today = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        for d in range(1, days + 1):
            out.extend(self.schedule_day(today - timedelta(days=d)))
        return out

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        self._http.close()


# --------------------------------------------------------------------------- #
# Normalization helpers (mirrors ggba_h2hggl.py)
# --------------------------------------------------------------------------- #
def _num(v: Any) -> float | str:
    """Coerce *v* to a 2-decimal float, or return '' if absent or non-numeric."""
    if v is None:
        return ""
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return ""


def _parse_game(ev: dict) -> dict | None:
    """Map one schedule entry to an internal game dict, or None if participants missing."""
    a, b = ev.get("participantAName"), ev.get("participantBName")
    if not a or not b:
        return None
    ts, date, hour = 0, "", ""
    sd = ev.get("startDate")
    if sd:
        try:
            dt = datetime.fromisoformat(sd.replace("Z", "+00:00")).astimezone(timezone.utc)
            ts, date, hour = int(dt.timestamp()), dt.date().isoformat(), dt.hour
        except ValueError:
            pass
    return {
        "external_id": ev.get("externalId", ""),
        "ts": ts,
        "date": date,
        "hour_utc": hour,
        "p1": a,
        "p1_team": ev.get("teamAName", "") or "",
        "p2": b,
        "p2_team": ev.get("teamBName", "") or "",
        "s1": ev.get("teamAScore"),
        "s2": ev.get("teamBScore"),
        "status": ev.get("matchStatus", ""),
    }


def _ended_games(events: list[dict]) -> list[dict]:
    """Filter and sort ended games with valid numeric scores from a raw event list.

    Bug 2 fix: deduplicate by external_id to avoid double-counting games that
    appear in multiple day-windows when the schedule API returns overlapping data.
    """
    games = []
    seen: set[str] = set()
    for ev in events:
        g = _parse_game(ev)
        if not g or g["status"] != ENDED:
            continue
        if not isinstance(g["s1"], (int, float)) or not isinstance(g["s2"], (int, float)):
            continue
        ext_id = g["external_id"]
        if ext_id and ext_id in seen:
            continue
        if ext_id:
            seen.add(ext_id)
        games.append(g)
    games.sort(key=lambda g: (g["ts"], g["external_id"]))
    return games


# --------------------------------------------------------------------------- #
# Walk-forward builder (leakage-free, mirrors ggba_h2hggl.py _Agg / _build_walkforward)
# --------------------------------------------------------------------------- #
class _Agg:
    """Per-player stat accumulator for the leakage-free walk-forward builder."""

    def __init__(self) -> None:
        """Initialize all counters and history to zero/empty."""
        self.gp = self.w = self.l = 0
        self.pts = 0.0
        self.history: list[tuple[int, str]] = []

    def add(self, ts: int, scored: float, won: bool) -> None:
        """Record one game result into the accumulator."""
        self.gp += 1
        self.pts += scored
        if won:
            self.w += 1
        else:
            self.l += 1
        self.history.append((ts, "W" if won else "L"))

    def recent_form(self, n: int = 5) -> str:
        """Return the most recent *n* results as a string of 'W'/'L' characters."""
        return "".join(
            h[1]
            for h in sorted(self.history, key=lambda x: x[0], reverse=True)[:n]
        )

    def snap(self) -> dict:
        """Return a pre-game stats snapshot; empty strings signal no prior history."""
        if self.gp == 0:
            return {"win_pct": "", "ppm": "", "form": "", "gp": 0}
        return {
            "win_pct": round(self.w / self.gp * 100, 1),
            "ppm": round(self.pts / self.gp, 1),
            "form": self.recent_form(),
            "gp": self.gp,
        }


def _build_walkforward(
    games: list[dict],
    min_gp: int = 0,
    season_gp: dict[str, int] | None = None,
) -> list[dict]:
    """Build leakage-free walk-forward rows: pre-game snapshots then state update.

    Bug 6 fix: when *season_gp* is supplied (from the participants API), the GP
    filter uses max(in_window_gp, season_gp) so players with enough season games
    are not wrongly excluded from short windows.
    """
    state: dict[str, _Agg] = {}
    rows = []
    for g in games:
        a = state.setdefault(g["p1"], _Agg())
        b = state.setdefault(g["p2"], _Agg())
        s1, s2 = a.snap(), b.snap()

        # Bug 6: use season GP from participants API when available
        if season_gp is not None:
            p1_gp_eff = max(s1["gp"], season_gp.get(g["p1"], 0))
            p2_gp_eff = max(s2["gp"], season_gp.get(g["p2"], 0))
        else:
            p1_gp_eff = s1["gp"]
            p2_gp_eff = s2["gp"]

        if min_gp > 0 and (p1_gp_eff < min_gp or p2_gp_eff < min_gp):
            a.add(g["ts"], float(g["s1"]), g["s1"] > g["s2"])
            b.add(g["ts"], float(g["s2"]), g["s2"] > g["s1"])
            continue

        rows.append(
            {
                "date": g["date"],
                "player1": g["p1"],
                "player2": g["p2"],
                "p1_team": g["p1_team"],
                "p2_team": g["p2_team"],
                "p1_win_pct": s1["win_pct"],
                "p1_ppm": s1["ppm"],
                "p1_form": s1["form"],
                "p1_gp": s1["gp"],
                "p2_win_pct": s2["win_pct"],
                "p2_ppm": s2["ppm"],
                "p2_form": s2["form"],
                "p2_gp": s2["gp"],
                "score1": g["s1"],
                "score2": g["s2"],
                "actual_total": g["s1"] + g["s2"],
                "hour_utc": g["hour_utc"],
            }
        )
        a.add(g["ts"], float(g["s1"]), g["s1"] > g["s2"])
        b.add(g["ts"], float(g["s2"]), g["s2"] > g["s1"])
    return rows


# --------------------------------------------------------------------------- #
# Export logic
# --------------------------------------------------------------------------- #
def export_combo(
    wf_rows: list[dict],
    gp: int,
    days: int,
    out_dir: str,
    season_gp: dict[str, int] | None = None,
) -> str:
    """
    Filter *wf_rows* to rows where both players have effective GP >= *gp*,
    write a CSV, and return the output file path.

    Effective GP = max(in-window GP, season GP) so players with enough full-season
    games qualify even if the rolling window captured fewer completed games.
    """
    sgp = season_gp or {}

    def _eff_gp(row: dict, player_key: str, gp_key: str) -> int:
        raw = row.get(gp_key, 0)
        raw_int = int(raw) if isinstance(raw, (int, float)) else 0
        return max(raw_int, sgp.get(str(row.get(player_key, "")), 0))

    filtered = [
        r for r in wf_rows
        if _eff_gp(r, "player1", "p1_gp") >= gp and _eff_gp(r, "player2", "p2_gp") >= gp
    ]
    fname = f"walkforward_gp{gp}_days{days}.csv"
    path = os.path.join(out_dir, fname)
    if not filtered:
        print(f"  {fname}: no rows match gp>={gp} (skipped)")
        return path
    fieldnames = list(filtered[0].keys())
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(filtered)
    print(f"  {fname}: {len(filtered)} rows  →  {path}")
    return path


def fetch_and_export(gp: int, days: int, out_dir: str) -> str:
    """
    Fetch *days* days of games from the API, build walk-forward rows,
    filter by *gp*, and write the CSV.  Returns the output file path.
    """
    print(f"Fetching {days} days of schedule data...", end="", flush=True)
    client = _Client()
    try:
        events = client.schedule_range(days)
        # Bug 6: fetch season GP from participants API
        participants = client.participants()
    except httpx.HTTPStatusError as e:
        print()
        sys.exit(f"API error {e.response.status_code}: {e.request.url}")
    except httpx.HTTPError as e:
        print()
        sys.exit(f"Network error: {e}")
    finally:
        client.close()
    print(f" {len(events)} events.")

    # Build season_gp lookup from participants
    season_gp: dict[str, int] = {}
    for p in participants:
        name = p.get("participantName") or p.get("name") or ""
        gp_val = p.get("gp") or p.get("gamesPlayed") or 0
        if name:
            try:
                season_gp[name] = int(gp_val)
            except (TypeError, ValueError):
                pass

    games = _ended_games(events)
    print(f"  Completed games: {len(games)}")

    wf_rows = _build_walkforward(games, season_gp=season_gp)

    os.makedirs(out_dir, exist_ok=True)
    return export_combo(wf_rows, gp, days, out_dir, season_gp=season_gp)


def fetch_all_days(days: int) -> tuple[list[dict], dict[str, int]]:
    """
    Fetch *days* days of schedule data and return (ended_games, season_gp).
    Used by --all to share fetched data across GP buckets for the same day window.
    """
    print(f"  Fetching {days} days...", end="", flush=True)
    client = _Client()
    try:
        events = client.schedule_range(days)
        participants = client.participants()
    except httpx.HTTPStatusError as e:
        print()
        sys.exit(f"API error {e.response.status_code}: {e.request.url}")
    except httpx.HTTPError as e:
        print()
        sys.exit(f"Network error: {e}")
    finally:
        client.close()
    print(f" {len(events)} events, ", end="", flush=True)
    games = _ended_games(events)
    print(f"{len(games)} completed.")

    season_gp: dict[str, int] = {}
    for p in participants:
        name = p.get("participantName") or p.get("name") or ""
        gp_val = p.get("gp") or p.get("gamesPlayed") or 0
        if name:
            try:
                season_gp[name] = int(gp_val)
            except (TypeError, ValueError):
                pass

    return games, season_gp


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
def cmd_list(args: argparse.Namespace) -> None:
    """Print what would be exported without fetching any data."""
    # Bug 5 fix: replace hardcoded "36" with dynamic count
    total = f"{len(GP_BUCKETS) * len(DAY_WINDOWS)}"
    print(f"Would export the following {total} CSV files:")
    print(f"  Output directory: {OUTPUT_DIR}/")
    print()
    for days in DAY_WINDOWS:
        for gp in GP_BUCKETS:
            fname = f"walkforward_gp{gp}_days{days}.csv"
            print(f"  {fname}")


def cmd_single(args: argparse.Namespace) -> None:
    """Export a single GP/days combination."""
    gp, days = args.gp, args.days
    print(f"Exporting walkforward_gp{gp}_days{days}.csv")
    fetch_and_export(gp, days, OUTPUT_DIR)
    print("Done.")


def cmd_all(args: argparse.Namespace) -> None:
    """Export all GP/days combinations, sharing fetches per day window."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    total = len(GP_BUCKETS) * len(DAY_WINDOWS)
    print(f"Exporting all {total} CSV combinations to {OUTPUT_DIR}/")
    print()

    for days in DAY_WINDOWS:
        print(f"Day window = {days}:")
        games, season_gp = fetch_all_days(days)
        wf_rows = _build_walkforward(games, season_gp=season_gp)
        for gp in GP_BUCKETS:
            export_combo(wf_rows, gp, days, OUTPUT_DIR, season_gp=season_gp)
        print()

    print(f"All {total} exports complete.")


def _build_parser() -> argparse.ArgumentParser:
    """Build and return the CLI argument parser."""
    parser = argparse.ArgumentParser(
        prog="export_datasets",
        description=(
            "GGBA Optimizer CSV Export Engine — fetches h2hggl data and writes "
            "walk-forward CSVs for all GP-bucket / day-window combinations."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  python3 optimizer/export_datasets.py --all
  python3 optimizer/export_datasets.py --gp 10 --days 56
  python3 optimizer/export_datasets.py --list
""",
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--all",
        action="store_true",
        help="Export all 36 GP/days combinations",
    )
    mode.add_argument(
        "--list",
        action="store_true",
        help="Print what would be exported without fetching",
    )
    mode.add_argument(
        "--gp",
        type=int,
        choices=GP_BUCKETS,
        metavar="GP",
        help=f"GP bucket for single export (choices: {GP_BUCKETS})",
    )
    parser.add_argument(
        "--days",
        type=int,
        choices=DAY_WINDOWS,
        metavar="DAYS",
        help=f"Day window for single export (choices: {DAY_WINDOWS}); required with --gp",
    )
    return parser


def main() -> None:
    """Entry point: parse CLI arguments and dispatch to the requested command."""
    parser = _build_parser()
    args = parser.parse_args()

    if args.all:
        if args.days is not None:
            print("warning: --days is ignored in --all mode (all day windows are exported)", file=sys.stderr)
        cmd_all(args)
    elif args.list:
        if args.days is not None:
            print("warning: --days is ignored in --list mode", file=sys.stderr)
        cmd_list(args)
    elif args.gp is not None:
        if args.days is None:
            parser.error("--days is required when --gp is specified")
        cmd_single(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()

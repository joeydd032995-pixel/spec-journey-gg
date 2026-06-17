#!/usr/bin/env python3
"""
ggba_betsapi.py — GGBetAnalyzer data fetcher (BetsAPI, league 25067)
====================================================================

Authorized, server-side fetch for the *Ebasketball H2H GG League - 4x5mins*
(BetsAPI league_id 25067, sport_id 18 / Basketball). Runs locally with YOUR
BetsAPI token, so it never touches the browser — that's how it "sidesteps
CORS": the artifact can't call BetsAPI directly (cross-origin + token
exposure), but a Python process on your machine can, then hands the result to
the dashboard as a CSV import.

What it produces (in ./ggba_data/):
  - ggba_players.csv  -> import directly in GGBetAnalyzer > Data Manager
  - ggba_matches.csv  -> per-game results (date, player1/2, scores, total)
  - raw_ended.json    -> raw event payloads, for your own digging

Per-player fields are AGGREGATED from ended events:
  name, win_pct, pts_per_match, gp, w, l, recent_form, nba_team
fg_pct / steals / fouls are NOT in this esports feed and are left blank on
purpose — fill them from h2hggl if you want them in the model.

Endpoints used (confirmed against betsapi.com/docs):
  GET /v3/events/ended?sport_id=&league_id=&day=YYYYMMDD&page=   (history)
  GET /v3/events/upcoming?sport_id=&league_id=                    (slate)
  GET /v3/league?sport_id=                                        (--list-leagues)
All responses are JSON with a `success` key. Base host falls back from
api.b365api.com to api.betsapi.com automatically.

Usage:
  export BETSAPI_TOKEN=your_token_here
  python ggba_betsapi.py --days 7
  python ggba_betsapi.py --days 14 --min-gp 5 --out ./ggba_data
  python ggba_betsapi.py --list-leagues | grep -i "gg league"
  python ggba_betsapi.py --upcoming        # just print tonight's fixtures

Requires: requests  (pip install requests)
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

HOSTS = ["https://api.b365api.com", "https://api.betsapi.com"]  # primary + load-balancer fallback
DEFAULT_LEAGUE_ID = 25067     # Ebasketball H2H GG League - 4x5mins
DEFAULT_SPORT_ID = 18         # Basketball
PER_PAGE = 50                 # BetsAPI default page size
MAX_PAGES = 100               # BetsAPI hard cap
RATE_FLOOR = 25               # pause when X-RateLimit-Remaining drops below this
POLITE_DELAY = 0.4            # seconds between requests (well within rate limits)

# "DEN Nuggets (LANES)"  ->  team="DEN Nuggets", player="LANES"
NAME_RE = re.compile(r"^\s*(.*?)\s*\(([^()]+)\)\s*$")


# --------------------------------------------------------------------------- #
# HTTP client                                                                 #
# --------------------------------------------------------------------------- #
class BetsAPI:
    def __init__(self, token: str, sport_id: int, verbose: bool = True):
        if not token:
            sys.exit("ERROR: no token. Set BETSAPI_TOKEN or pass --token.")
        self.token = token
        self.sport_id = sport_id
        self.verbose = verbose
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json", "User-Agent": "GGBetAnalyzer/1.0"})
        self._host_idx = 0

    def _log(self, *a):
        if self.verbose:
            print(*a, file=sys.stderr, flush=True)

    def get(self, path: str, **params: Any) -> Dict[str, Any]:
        """GET a BetsAPI endpoint with token + retries/backoff and host failover."""
        params.setdefault("token", self.token)
        last_err: Optional[str] = None
        for attempt in range(1, 4):  # up to 3 tries per call
            host = HOSTS[self._host_idx % len(HOSTS)]
            url = f"{host}{path}"
            try:
                resp = self.session.get(url, params=params, timeout=25)
            except requests.RequestException as e:
                last_err = f"network error: {e}"
                self._host_idx += 1                      # try the other host
                time.sleep(1.5 * attempt)
                continue

            # Respect documented rate-limit headers.
            remaining = resp.headers.get("X-RateLimit-Remaining")
            reset = resp.headers.get("X-RateLimit-Reset")
            if remaining is not None and remaining.isdigit() and int(remaining) < RATE_FLOOR:
                wait = max(0, int(reset or 0) - int(time.time())) + 1 if reset else 60
                self._log(f"  rate limit low ({remaining}); sleeping {wait}s")
                time.sleep(min(wait, 120))

            if resp.status_code == 429 or resp.status_code >= 500:
                last_err = f"HTTP {resp.status_code}"
                time.sleep(2 ** attempt)                 # exponential backoff
                continue

            try:
                data = resp.json()
            except ValueError:
                last_err = "non-JSON response"
                time.sleep(1.5 * attempt)
                continue

            if not data.get("success"):
                # success:0 — surface the API's error and stop retrying (usually auth/param).
                raise RuntimeError(f"BetsAPI error on {path}: {json.dumps(data)[:300]}")

            time.sleep(POLITE_DELAY)
            return data

        raise RuntimeError(f"failed {path} after retries ({last_err})")

    def paged(self, path: str, **params: Any) -> Iterable[Dict[str, Any]]:
        """Yield all `results` across pages for an endpoint."""
        page = 1
        while page <= MAX_PAGES:
            data = self.get(path, page=page, **params)
            results = data.get("results") or []
            for r in results:
                yield r
            pager = data.get("pager") or {}
            total = int(pager.get("total", 0) or 0)
            per = int(pager.get("per_page", PER_PAGE) or PER_PAGE) or PER_PAGE
            if len(results) < per or page * per >= total:
                break
            page += 1


# --------------------------------------------------------------------------- #
# Parsing / aggregation                                                       #
# --------------------------------------------------------------------------- #
def split_name(raw: str) -> Tuple[str, str]:
    """'DEN Nuggets (LANES)' -> ('LANES', 'DEN Nuggets'). Falls back to (raw, '')."""
    if not raw:
        return ("", "")
    m = NAME_RE.match(raw)
    if m:
        return (m.group(2).strip(), m.group(1).strip())
    return (raw.strip(), "")


def parse_score(ss: Optional[str]) -> Optional[Tuple[int, int]]:
    """'62-66' -> (62, 66). Returns None if unparseable."""
    if not ss or "-" not in ss:
        return None
    a, _, b = ss.partition("-")
    try:
        return (int(a.strip()), int(b.strip()))
    except ValueError:
        return None


class PlayerAgg:
    __slots__ = ("name", "gp", "w", "l", "pts", "teams", "history")

    def __init__(self, name: str):
        self.name = name
        self.gp = 0
        self.w = 0
        self.l = 0
        self.pts = 0
        self.teams: Counter = Counter()
        self.history: List[Tuple[int, str]] = []  # (unix_time, 'W'/'L')

    def add(self, ts: int, team: str, scored: int, won: bool):
        self.gp += 1
        self.pts += scored
        self.w += int(won)
        self.l += int(not won)
        if team:
            self.teams[team] += 1
        self.history.append((ts, "W" if won else "L"))

    def recent_form(self, n: int = 5) -> str:
        # most recent first (matches the dashboard's form weighting)
        recent = sorted(self.history, key=lambda x: x[0], reverse=True)[:n]
        return "".join(r[1] for r in recent)

    def row(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "win_pct": round(self.w / self.gp * 100, 1) if self.gp else 0,
            "pts_per_match": round(self.pts / self.gp, 1) if self.gp else 0,
            "fg_pct": "", "steals": "", "fouls": "",   # not in feed — fill from h2hggl
            "gp": self.gp, "w": self.w, "l": self.l,
            "recent_form": self.recent_form(),
            "nba_team": self.teams.most_common(1)[0][0] if self.teams else "",
        }


def fetch_games(api: BetsAPI, league_id: int, days: int) -> List[Dict]:
    """Fetch ended events across `days` and return them parsed + sorted ASCENDING by time."""
    games: List[Dict] = []
    raw: List[Dict] = []
    today = datetime.now(timezone.utc).date()
    for d in range(days):
        day = (today - timedelta(days=d)).strftime("%Y%m%d")
        api._log(f"fetching ended events for {day} …")
        count = 0
        for ev in api.paged("/v3/events/ended", sport_id=api.sport_id, league_id=league_id, day=day):
            raw.append(ev)
            score = parse_score(ev.get("ss"))
            home = (ev.get("home") or {}).get("name", "")
            away = (ev.get("away") or {}).get("name", "")
            ts = int(ev.get("time", 0) or 0)
            if score is None or not home or not away:
                continue
            hs, as_ = score
            hp, ht = split_name(home)
            ap, at = split_name(away)
            games.append({
                "ts": ts,
                "date": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d") if ts else day,
                "hour_utc": datetime.fromtimestamp(ts, timezone.utc).hour if ts else "",
                "hp": hp, "ht": ht, "ap": ap, "at": at, "hs": hs, "as_": as_,
            })
            count += 1
        api._log(f"  {count} games on {day}")
    games.sort(key=lambda g: g["ts"])   # chronological — required for walk-forward
    api._raw = raw
    return games


def aggregate_players(games: List[Dict], min_gp: int) -> List[Dict]:
    """Full-sample per-player roster (current state) — for the dashboard roster."""
    players: Dict[str, PlayerAgg] = {}
    for g in games:
        players.setdefault(g["hp"], PlayerAgg(g["hp"])).add(g["ts"], g["ht"], g["hs"], g["hs"] > g["as_"])
        players.setdefault(g["ap"], PlayerAgg(g["ap"])).add(g["ts"], g["at"], g["as_"], g["as_"] > g["hs"])
    rows = [p.row() for p in players.values() if p.gp >= min_gp]
    rows.sort(key=lambda r: r["name"])
    return rows


def build_matches(games: List[Dict]) -> List[Dict]:
    """Flat results list (date, players, scores, total) — for the in-sample probe + h2h."""
    return [{"date": g["date"], "player1": g["hp"], "player2": g["ap"],
             "score1": g["hs"], "score2": g["as_"], "total": g["hs"] + g["as_"], "division": ""} for g in games]


def build_walkforward(games: List[Dict]) -> List[Dict]:
    """PER-GAME PRE-MATCH SNAPSHOTS (leakage-free).

    Replays games in time order. For each game we record each player's stats
    computed from ONLY their earlier games, then update state with the result.
    The dashboard re-projects these snapshots so every backtested projection
    used only information available at tip-off — a true out-of-sample test.
    """
    state: Dict[str, PlayerAgg] = {}
    rows: List[Dict] = []

    def snap(name: str) -> Dict[str, Any]:
        p = state.get(name)
        if not p or p.gp == 0:
            return {"win_pct": "", "ppm": "", "form": "", "gp": 0}   # no prior games
        return {"win_pct": round(p.w / p.gp * 100, 1), "ppm": round(p.pts / p.gp, 1),
                "form": p.recent_form(), "gp": p.gp}

    for g in games:
        s1, s2 = snap(g["hp"]), snap(g["ap"])
        rows.append({
            "date": g["date"], "player1": g["hp"], "player2": g["ap"],
            "p1_team": g["ht"], "p2_team": g["at"],
            "p1_win_pct": s1["win_pct"], "p1_ppm": s1["ppm"], "p1_form": s1["form"], "p1_gp": s1["gp"],
            "p2_win_pct": s2["win_pct"], "p2_ppm": s2["ppm"], "p2_form": s2["form"], "p2_gp": s2["gp"],
            "score1": g["hs"], "score2": g["as_"], "actual_total": g["hs"] + g["as_"], "hour_utc": g["hour_utc"],
        })
        # update AFTER snapshotting
        state.setdefault(g["hp"], PlayerAgg(g["hp"])).add(g["ts"], g["ht"], g["hs"], g["hs"] > g["as_"])
        state.setdefault(g["ap"], PlayerAgg(g["ap"])).add(g["ts"], g["at"], g["as_"], g["as_"] > g["hs"])
    return rows


# --------------------------------------------------------------------------- #
# Output                                                                       #
# --------------------------------------------------------------------------- #
PLAYER_COLS = ["name", "win_pct", "pts_per_match", "fg_pct", "steals",
               "fouls", "gp", "w", "l", "recent_form", "nba_team"]
MATCH_COLS = ["date", "player1", "player2", "score1", "score2", "total", "division"]
WF_COLS = ["date", "player1", "player2", "p1_team", "p2_team",
           "p1_win_pct", "p1_ppm", "p1_form", "p1_gp",
           "p2_win_pct", "p2_ppm", "p2_form", "p2_gp",
           "score1", "score2", "actual_total", "hour_utc"]


def write_csv(path: Path, cols: List[str], rows: List[Dict]):
    with path.open("w", newline="", encoding="utf-8") as f:
        wr = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(rows)


# --------------------------------------------------------------------------- #
# CLI                                                                          #
# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser(description="Fetch GG League (25067) data from BetsAPI for GGBetAnalyzer.")
    ap.add_argument("--token", default=os.environ.get("BETSAPI_TOKEN", ""), help="BetsAPI token (or set BETSAPI_TOKEN).")
    ap.add_argument("--league-id", type=int, default=DEFAULT_LEAGUE_ID)
    ap.add_argument("--sport-id", type=int, default=DEFAULT_SPORT_ID)
    ap.add_argument("--days", type=int, default=7, help="How many days back of ended events to aggregate.")
    ap.add_argument("--min-gp", type=int, default=1, help="Drop players with fewer than this many games.")
    ap.add_argument("--out", default="./ggba_data", help="Output directory.")
    ap.add_argument("--list-leagues", action="store_true", help="List basketball leagues (to confirm league_id) and exit.")
    ap.add_argument("--upcoming", action="store_true", help="Print upcoming fixtures for the league and exit.")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    api = BetsAPI(args.token, args.sport_id, verbose=not args.quiet)

    if args.list_leagues:
        for lg in api.paged("/v3/league", sport_id=args.sport_id):
            print(f"{lg.get('id'):>8}  {lg.get('name')}")
        return

    if args.upcoming:
        print(f"Upcoming — league {args.league_id}:")
        for ev in api.paged("/v3/events/upcoming", sport_id=args.sport_id, league_id=args.league_id):
            ts = int(ev.get("time", 0) or 0)
            when = datetime.fromtimestamp(ts, timezone.utc).strftime("%m-%d %H:%M UTC") if ts else "?"
            hp, _ = split_name((ev.get("home") or {}).get("name", ""))
            ap_, _ = split_name((ev.get("away") or {}).get("name", ""))
            print(f"  {when}  {hp}  vs  {ap_}")
        return

    games = fetch_games(api, args.league_id, args.days)
    rows = aggregate_players(games, args.min_gp)
    matches = build_matches(games)
    walkforward = build_walkforward(games)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_csv(out / "ggba_players.csv", PLAYER_COLS, rows)
    write_csv(out / "ggba_matches.csv", MATCH_COLS, matches)
    write_csv(out / "ggba_walkforward.csv", WF_COLS, walkforward)
    (out / "raw_ended.json").write_text(json.dumps(getattr(api, "_raw", []), indent=2), encoding="utf-8")

    print(f"\n✓ {len(rows)} players · {len(matches)} matches · {len(walkforward)} walk-forward rows "
          f"over {args.days}d -> {out}/")
    print("  Import in GGBetAnalyzer > Data Manager:")
    print("    ggba_players.csv      -> roster")
    print("    ggba_matches.csv      -> in-sample probe + h2h")
    print("    ggba_walkforward.csv  -> walk-forward backtest + calibration")
    if rows:
        top = sorted(rows, key=lambda r: r["win_pct"], reverse=True)[:5]
        print("  Top by win%:", ", ".join(f"{r['name']} {r['win_pct']}% ({r['gp']}gp)" for r in top))


if __name__ == "__main__":
    main()

"""Unit tests for the normalization layer, run against committed real-API
fixtures so CI never touches the network."""
import json
import os

import pytest

from app import normalize as N

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


@pytest.fixture
def participants():
    return load("participants_nba.json")


@pytest.fixture
def schedule_events():
    return load("schedule_2026-06-15.json") + load("schedule_2026-06-16.json")


# ----- player mapping: the previously-missing fields are now populated ----- #
def test_player_row_fills_missing_stats(participants):
    rows = N.aggregate_players(participants, min_gp=1)
    assert rows, "expected at least one player"
    r = rows[0]
    assert set(r) == {
        "name", "win_pct", "pts_per_match", "fg_pct", "steals", "fouls",
        "gp", "w", "l", "recent_form", "nba_team",
    }
    # fg_pct / steals / fouls must be real numbers, not "" like the BetsAPI path.
    for row in rows:
        assert isinstance(row["fg_pct"], (int, float)), row["name"]
        assert isinstance(row["steals"], (int, float)), row["name"]
        assert isinstance(row["fouls"], (int, float)), row["name"]


def test_player_row_values_match_source(participants):
    src = {p["participantName"]: p for p in participants}
    rows = {r["name"]: r for r in N.aggregate_players(participants)}
    name = next(iter(src))
    p, r = src[name], rows[name]
    assert r["fg_pct"] == round(p["avgFieldGoalsPercent"], 2)
    assert r["steals"] == round(p["avgSteals"], 2)
    assert r["fouls"] == round(p["avgTeamFouls"], 2)
    assert r["gp"] == p["matchesWon"] + p["matchesLost"]
    assert r["recent_form"] == "".join(c.upper() for c in p["matchForm"][:5])


def test_min_gp_filter(participants):
    everyone = N.aggregate_players(participants, min_gp=1)
    huge = N.aggregate_players(participants, min_gp=10_000_000)
    assert len(huge) < len(everyone)


# ----- games / matches / division ----- #
def test_ended_games_parsed_and_sorted(schedule_events):
    games = N.ended_games(schedule_events)
    assert games
    assert all(g["status"] == N.ENDED for g in games)
    assert all(isinstance(g["s1"], (int, float)) for g in games)
    ts = [g["ts"] for g in games]
    assert ts == sorted(ts)


def test_matches_carry_division(schedule_events):
    games = N.ended_games(schedule_events)
    matches = N.build_matches(games)
    assert matches
    assert all(m["total"] == m["score1"] + m["score2"] for m in matches)
    # division (was always "") is now populated from the stream name.
    assert any(m["division"] for m in matches)


# ----- leakage-free walk-forward ----- #
def test_walkforward_is_leakage_free(schedule_events):
    games = N.ended_games(schedule_events)
    wf = N.build_walkforward(games)
    assert len(wf) == len(games)
    # First appearance of any player must have an empty pre-match snapshot.
    seen = set()
    for row in wf:
        if row["player1"] not in seen:
            assert row["p1_gp"] == 0 and row["p1_win_pct"] == ""
        if row["player2"] not in seen:
            assert row["p2_gp"] == 0 and row["p2_win_pct"] == ""
        seen.add(row["player1"])
        seen.add(row["player2"])


def test_walkforward_gp_accumulates(schedule_events):
    games = N.ended_games(schedule_events)
    wf = N.build_walkforward(games)
    # A player's gp snapshot must never exceed the number of their prior games.
    counts: dict[str, int] = {}
    for row in wf:
        for who, gp_key in (("player1", "p1_gp"), ("player2", "p2_gp")):
            name = row[who]
            assert row[gp_key] == counts.get(name, 0)
            counts[name] = counts.get(name, 0) + 1


def test_team_map_and_standings(schedule_events, participants):
    games = N.ended_games(schedule_events)
    tmap = N.team_map(games)
    assert tmap  # players mapped to a modal NBA team skin
    standings = N.build_standings(participants)
    assert standings[0]["rank"] == 1
    wins = [r["win_pct"] for r in standings if isinstance(r["win_pct"], (int, float))]
    assert wins == sorted(wins, reverse=True)

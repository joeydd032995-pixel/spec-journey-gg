"""API-shape tests. The HTTP client is patched to read committed fixtures, so
these run fully offline."""
import json
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    """Load a JSON fixture file from the fixtures directory."""
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


@pytest.fixture
def client(monkeypatch, tmp_path):
    # Isolated DB + no background scheduler during tests.
    monkeypatch.setenv("H2HGGL_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("H2HGGL_REFRESH_GAMES_MIN", "0")
    monkeypatch.setenv("H2HGGL_REFRESH_PLAYERS_MIN", "0")

    # Reload config-bound modules so env overrides take effect.
    import importlib
    from app import config as _cfg
    importlib.reload(_cfg)
    from app import cache, db, client as _client, scraper, main
    importlib.reload(cache)
    importlib.reload(db)
    importlib.reload(_client)
    importlib.reload(scraper)
    importlib.reload(main)

    parts = load("participants_nba.json")
    events = load("schedule_2026-06-15.json") + load("schedule_2026-06-16.json")

    monkeypatch.setattr(_client.H2HGGLClient, "participants", lambda self: parts)
    monkeypatch.setattr(_client.H2HGGLClient, "schedule_range", lambda self, days: events)
    monkeypatch.setattr(_client.H2HGGLClient, "schedule_day", lambda self, day: events)
    monkeypatch.setattr(_client.H2HGGLClient, "close", lambda self: None)

    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def upcoming_client(monkeypatch, tmp_path):
    """Client fixture that returns upcoming (non-ended) fixtures for the schedule."""
    monkeypatch.setenv("H2HGGL_DB_PATH", str(tmp_path / "test_upcoming.db"))
    monkeypatch.setenv("H2HGGL_REFRESH_GAMES_MIN", "0")
    monkeypatch.setenv("H2HGGL_REFRESH_PLAYERS_MIN", "0")

    import importlib
    from app import config as _cfg
    importlib.reload(_cfg)
    from app import cache, db, client as _client, scraper, main
    importlib.reload(cache)
    importlib.reload(db)
    importlib.reload(_client)
    importlib.reload(scraper)
    importlib.reload(main)

    parts = load("participants_nba.json")
    # Historical events used by schedule_range (for archive/stats context).
    history_events = load("schedule_2026-06-15.json") + load("schedule_2026-06-16.json")
    # Upcoming events returned per day (not MATCH_ENDED).
    upcoming_events = load("schedule_upcoming.json")

    monkeypatch.setattr(_client.H2HGGLClient, "participants", lambda self: parts)
    monkeypatch.setattr(_client.H2HGGLClient, "schedule_range", lambda self, days: history_events)
    monkeypatch.setattr(_client.H2HGGLClient, "schedule_day", lambda self, day: upcoming_events)
    monkeypatch.setattr(_client.H2HGGLClient, "close", lambda self: None)

    with TestClient(main.app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_feed_shape_and_filled_stats(client):
    r = client.get("/api/feed?days=2&minGp=1")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"walkforward", "players", "matches", "meta"}
    assert body["players"], "feed should contain players"
    # The whole point: the previously-blank fields are now numeric.
    p = body["players"][0]
    assert isinstance(p["fg_pct"], (int, float))
    assert isinstance(p["steals"], (int, float))
    assert isinstance(p["fouls"], (int, float))
    assert body["meta"]["source"] == "h2hggl"


def test_standings_ranked(client):
    r = client.get("/api/standings")
    assert r.status_code == 200
    rows = r.json()
    assert rows and rows[0]["rank"] == 1


def test_player_lookup_and_404(client):
    name = client.get("/api/players").json()[0]["name"]
    assert client.get(f"/api/players/{name}").status_code == 200
    assert client.get("/api/players/__nope__").status_code == 404


def test_games_have_division(client):
    rows = client.get("/api/games?days=2").json()
    assert rows
    assert any(m["division"] for m in rows)


def test_upcoming_feed_shape(upcoming_client):
    """GET /api/upcoming-feed returns 200 with 'upcoming' list and 'meta' dict."""
    r = upcoming_client.get("/api/upcoming-feed?days=2&history_days=30")
    assert r.status_code == 200
    body = r.json()
    assert "upcoming" in body, "response must have 'upcoming' key"
    assert "meta" in body, "response must have 'meta' key"
    assert isinstance(body["upcoming"], list)
    assert body["meta"]["source"] == "h2hggl"
    assert body["meta"]["days_schedule"] == 2
    assert body["meta"]["days_history"] == 30


def test_upcoming_feed_analysis_shape(upcoming_client):
    """Each fixture card in 'upcoming' must carry an 'analysis' sub-dict."""
    r = upcoming_client.get("/api/upcoming-feed?days=2&history_days=30")
    assert r.status_code == 200
    body = r.json()
    if not body["upcoming"]:
        pytest.skip("no upcoming fixtures in test fixtures")
    card = body["upcoming"][0]
    assert "analysis" in card, "each card must have 'analysis'"
    analysis = card["analysis"]
    assert "score_bands" in analysis
    assert "ppm_model" in analysis
    assert "win_edge" in analysis
    # score_bands may be None when < 3 H2H games exist, which is the case for
    # a fresh test DB — verify it is either None or a dict with expected keys.
    if analysis["score_bands"] is not None:
        assert "total" in analysis["score_bands"]
        assert "p1" in analysis["score_bands"]
        assert "p2" in analysis["score_bands"]
    ppm = analysis["ppm_model"]
    assert "total" in ppm
    assert "p1" in ppm
    assert "p2" in ppm
    win_edge = analysis["win_edge"]
    assert "favored" in win_edge
    assert "edge_pct" in win_edge

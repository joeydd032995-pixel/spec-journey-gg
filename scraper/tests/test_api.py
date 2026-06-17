"""API-shape tests. The HTTP client is patched to read committed fixtures, so
these run fully offline."""
import json
import os
import tempfile

import pytest
from fastapi.testclient import TestClient

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
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

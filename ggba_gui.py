#!/usr/bin/env python3
"""ggba_gui.py — Desktop GUI for the H2H GG League Analyzer.

Wraps the data-fetching and analysis functions from ggba_h2hggl.py in a
point-and-click tkinter interface.  No additional dependencies beyond the
CLI's single requirement (httpx).

Build a single-file Windows .exe:
    pip install pyinstaller httpx
    pyinstaller --onefile --windowed --name "H2H_GG_Analyzer" ggba_gui.py
    # result: dist/H2H_GG_Analyzer.exe
"""
from __future__ import annotations

import csv
import os
import statistics
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk

# ---------------------------------------------------------------------------
# Import the data layer from the CLI module (same directory)
# ---------------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    from ggba_h2hggl import (
        _Client,
        _aggregate_players,
        _build_standings,
        _build_walkforward,
        _ended_games,
        _filter_h2h,
        _fmt,
    )
except ImportError as _exc:
    _msg = (
        f"Cannot import ggba_h2hggl:\n{_exc}\n\n"
        "Make sure ggba_h2hggl.py is in the same directory and run:\n"
        "  pip install httpx"
    )
    try:
        _r = tk.Tk()
        _r.withdraw()
        messagebox.showerror("Missing dependency", _msg)
        _r.destroy()
    except Exception:
        print(_msg, file=sys.stderr)
    sys.exit(1)


# ---------------------------------------------------------------------------
# Treeview helpers
# ---------------------------------------------------------------------------

def _tv_sort(tree: ttk.Treeview, col: str, state: dict) -> None:
    """Sort *tree* by *col*, toggling direction on repeated clicks."""
    rows = [(tree.set(k, col), k) for k in tree.get_children("")]
    reverse = state.get(col, False)
    try:
        rows.sort(
            key=lambda t: float(t[0]) if t[0] not in ("", "-") else float("-inf"),
            reverse=reverse,
        )
    except ValueError:
        rows.sort(key=lambda t: t[0].lower(), reverse=reverse)
    for i, (_, k) in enumerate(rows):
        tree.move(k, "", i)
    state[col] = not reverse


def _make_tree(parent: tk.Widget, columns: list[tuple[str, str, int]]) -> ttk.Treeview:
    """Create a scrollable Treeview; *columns* is (id, heading, pixel-width) triples."""
    wrapper = ttk.Frame(parent)
    wrapper.pack(fill="both", expand=True, padx=4, pady=4)

    col_ids = [c[0] for c in columns]
    tree = ttk.Treeview(wrapper, columns=col_ids, show="headings", selectmode="browse")

    sort_state: dict[str, bool] = {}
    for cid, heading, width in columns:
        tree.heading(cid, text=heading,
                     command=lambda c=cid: _tv_sort(tree, c, sort_state))
        tree.column(cid, width=width, minwidth=40, anchor="w")

    ys = ttk.Scrollbar(wrapper, orient="vertical", command=tree.yview)
    xs = ttk.Scrollbar(wrapper, orient="horizontal", command=tree.xview)
    tree.configure(yscrollcommand=ys.set, xscrollcommand=xs.set)

    ys.pack(side="right", fill="y")
    xs.pack(side="bottom", fill="x")
    tree.pack(fill="both", expand=True)
    return tree


def _fill_tree(tree: ttk.Treeview, rows: list[dict], cols: list[str]) -> None:
    """Clear and repopulate *tree* with *rows* using the given column order."""
    for item in tree.get_children():
        tree.delete(item)
    for r in rows:
        tree.insert("", "end", values=[_fmt(r.get(c, "")) for c in cols])


def _set_text(widget: scrolledtext.ScrolledText, text: str) -> None:
    """Replace the contents of a read-only ScrolledText widget."""
    widget.config(state="normal")
    widget.delete("1.0", "end")
    widget.insert("end", text)
    widget.config(state="disabled")


# ---------------------------------------------------------------------------
# Main application
# ---------------------------------------------------------------------------

class App:
    """Root window and tab controller for the H2H GG Analyzer GUI."""

    def __init__(self, root: tk.Tk) -> None:
        """Build the main window with a notebook and a bottom status bar."""
        self.root = root
        self.root.title("H2H GG League Analyzer")
        self.root.geometry("1120x700")
        self.root.minsize(820, 520)

        # Shared player cache (populated on startup)
        self._players: list[dict] = []
        self._player_names: list[str] = []
        # All Combobox widgets that show player names — populated after startup load
        self._player_combos: list[ttk.Combobox] = []

        # Status bar
        self.status = tk.StringVar(value="Ready")
        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w").pack(
            side="bottom", fill="x", ipady=2
        )

        # Notebook
        nb = ttk.Notebook(root)
        nb.pack(fill="both", expand=True, padx=6, pady=6)

        self._build_players_tab(nb)
        self._build_standings_tab(nb)
        self._build_h2h_tab(nb)       # initialises self._player_combos
        self._build_matchup_tab(nb)   # extends  self._player_combos
        self._build_analyze_tab(nb)
        self._build_export_tab(nb)

        # Pre-load the player list so dropdowns are ready immediately
        self._run(self._fetch_participants, self._on_participants_loaded, "Loading player list…")

    # -----------------------------------------------------------------------
    # Threading helper
    # -----------------------------------------------------------------------

    def _run(self, fn, on_done, label: str = "Fetching…") -> None:
        """Run *fn()* in a daemon thread and call *on_done(result)* on the UI thread."""
        self.status.set(label)

        def _worker() -> None:
            try:
                result = fn()
                self.root.after(0, lambda r=result: on_done(r))
            except Exception as exc:
                self.root.after(0, lambda e=exc: messagebox.showerror("Error", str(e)))
            finally:
                self.root.after(0, lambda: self.status.set("Ready"))

        threading.Thread(target=_worker, daemon=True).start()

    # -----------------------------------------------------------------------
    # Shared data fetcher
    # -----------------------------------------------------------------------

    def _fetch_participants(self) -> list[dict]:
        """Fetch the full participant list from the API."""
        c = _Client()
        try:
            return c.participants()
        finally:
            c.close()

    def _on_participants_loaded(self, parts: list[dict]) -> None:
        """Store participant data and populate all player-name Comboboxes."""
        self._players = _aggregate_players(parts, min_gp=1)
        self._player_names = [p["name"] for p in self._players]
        for cb in self._player_combos:
            cb["values"] = self._player_names
        self.status.set(f"Ready — {len(self._players)} players loaded")

    # -----------------------------------------------------------------------
    # Players tab
    # -----------------------------------------------------------------------

    def _build_players_tab(self, nb: ttk.Notebook) -> None:
        """Build the Players tab: controls + sortable stats table."""
        frame = ttk.Frame(nb)
        nb.add(frame, text="Players")

        ctrl = ttk.Frame(frame)
        ctrl.pack(fill="x", padx=6, pady=4)

        ttk.Label(ctrl, text="Min GP:").pack(side="left")
        self._p_mingp = tk.IntVar(value=1)
        ttk.Spinbox(ctrl, from_=1, to=999, width=5,
                    textvariable=self._p_mingp).pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Filter name:").pack(side="left")
        self._p_filter = tk.StringVar()
        ttk.Entry(ctrl, textvariable=self._p_filter, width=18).pack(side="left", padx=(2, 10))

        ttk.Button(ctrl, text="Fetch Players",
                   command=self._do_fetch_players).pack(side="left")

        self._p_count = tk.StringVar()
        ttk.Label(ctrl, textvariable=self._p_count).pack(side="left", padx=10)

        self._p_tree = _make_tree(frame, [
            ("name",         "Name",   160),
            ("gp",           "GP",      42),
            ("w",            "W",       38),
            ("l",            "L",       38),
            ("win_pct",      "Win%",    58),
            ("pts_per_match","PPM",     52),
            ("fg_pct",       "FG%",     52),
            ("steals",       "Steals",  58),
            ("fouls",        "Fouls",   52),
            ("recent_form",  "Form",    68),
        ])

    def _do_fetch_players(self) -> None:
        """Fetch and display the player list with current filter settings."""
        min_gp = self._p_mingp.get()
        filt    = self._p_filter.get().lower()

        def fetch() -> list[dict]:
            parts = self._fetch_participants()
            return _aggregate_players(parts, min_gp=min_gp)

        def done(players: list[dict]) -> None:
            if filt:
                players = [p for p in players if filt in p["name"].lower()]
            _fill_tree(self._p_tree, players,
                       ["name", "gp", "w", "l", "win_pct", "pts_per_match",
                        "fg_pct", "steals", "fouls", "recent_form"])
            self._p_count.set(f"{len(players)} players")
            # Refresh dropdowns when fetching without a name filter
            if not filt:
                self._players = players
                self._player_names = [p["name"] for p in players]
                for cb in self._player_combos:
                    cb["values"] = self._player_names

        self._run(fetch, done, "Fetching players…")

    # -----------------------------------------------------------------------
    # Standings tab
    # -----------------------------------------------------------------------

    def _build_standings_tab(self, nb: ttk.Notebook) -> None:
        """Build the Standings tab: a fetch button + rank-ordered table."""
        frame = ttk.Frame(nb)
        nb.add(frame, text="Standings")

        ctrl = ttk.Frame(frame)
        ctrl.pack(fill="x", padx=6, pady=4)
        ttk.Button(ctrl, text="Fetch Standings",
                   command=self._do_fetch_standings).pack(side="left")

        self._st_tree = _make_tree(frame, [
            ("rank",        "#",     38),
            ("name",        "Name", 160),
            ("w",           "W",     38),
            ("l",           "L",     38),
            ("gp",          "GP",    42),
            ("win_pct",     "Win%",  58),
            ("pts_for",     "PF",    55),
            ("pts_against", "PA",    55),
            ("fg_pct",      "FG%",   52),
        ])

    def _do_fetch_standings(self) -> None:
        """Fetch and display the league standings."""
        def fetch() -> list[dict]:
            return _build_standings(self._fetch_participants())

        def done(rows: list[dict]) -> None:
            _fill_tree(self._st_tree, rows,
                       ["rank", "name", "w", "l", "gp", "win_pct",
                        "pts_for", "pts_against", "fg_pct"])

        self._run(fetch, done, "Fetching standings…")

    # -----------------------------------------------------------------------
    # H2H tab
    # -----------------------------------------------------------------------

    def _build_h2h_tab(self, nb: ttk.Notebook) -> None:
        """Build the H2H tab: player dropdowns, summary label, and results table."""
        frame = ttk.Frame(nb)
        nb.add(frame, text="H2H")

        ctrl = ttk.Frame(frame)
        ctrl.pack(fill="x", padx=6, pady=4)

        ttk.Label(ctrl, text="Player 1:").pack(side="left")
        self._h2h_p1 = ttk.Combobox(ctrl, width=22)
        self._h2h_p1.pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Player 2:").pack(side="left")
        self._h2h_p2 = ttk.Combobox(ctrl, width=22)
        self._h2h_p2.pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Days:").pack(side="left")
        self._h2h_days = tk.IntVar(value=60)
        ttk.Spinbox(ctrl, from_=1, to=365, width=5,
                    textvariable=self._h2h_days).pack(side="left", padx=(2, 10))

        ttk.Button(ctrl, text="Fetch H2H",
                   command=self._do_fetch_h2h).pack(side="left")

        self._h2h_summary = tk.StringVar()
        ttk.Label(frame, textvariable=self._h2h_summary,
                  font=("TkDefaultFont", 10, "bold")).pack(anchor="w", padx=10, pady=2)

        self._h2h_tree = _make_tree(frame, [
            ("date",   "Date",     100),
            ("p1",     "Player 1", 160),
            ("s1",     "S1",        45),
            ("s2",     "S2",        45),
            ("p2",     "Player 2", 160),
            ("winner", "Winner",   160),
        ])

        # Seed the shared combo list (extended by Matchup tab)
        self._player_combos = [self._h2h_p1, self._h2h_p2]

    def _do_fetch_h2h(self) -> None:
        """Fetch and display H2H games for the two selected players."""
        p1   = self._h2h_p1.get().strip()
        p2   = self._h2h_p2.get().strip()
        days = self._h2h_days.get()
        if not p1 or not p2:
            messagebox.showwarning("Missing players", "Select both players first.")
            return

        def fetch() -> list[dict]:
            c = _Client()
            try:
                events = c.schedule_range(days)
            finally:
                c.close()
            return _filter_h2h(_ended_games(events), p1, p2)

        def done(h2h: list[dict]) -> None:
            if not h2h:
                self._h2h_summary.set(
                    f"No H2H games found between '{p1}' and '{p2}' in the last {days} days.")
                for item in self._h2h_tree.get_children():
                    self._h2h_tree.delete(item)
                return

            p1_wins = sum(1 for g in h2h if g["winner"].lower() == p1.lower())
            totals  = [g["s1"] + g["s2"] for g in h2h]
            avg_t   = statistics.mean(totals)
            std_t   = statistics.stdev(totals) if len(totals) > 1 else 0.0
            self._h2h_summary.set(
                f"{p1}  {p1_wins} – {len(h2h) - p1_wins}  {p2}  |  "
                f"{len(h2h)} games  |  avg total: {avg_t:.1f}  std: {std_t:.1f}"
            )
            _fill_tree(self._h2h_tree, h2h,
                       ["date", "p1", "s1", "s2", "p2", "winner"])

        self._run(fetch, done, f"Fetching H2H for {p1} vs {p2}…")

    # -----------------------------------------------------------------------
    # Matchup tab
    # -----------------------------------------------------------------------

    def _build_matchup_tab(self, nb: ttk.Notebook) -> None:
        """Build the Matchup tab: player dropdowns + full analysis text output."""
        frame = ttk.Frame(nb)
        nb.add(frame, text="Matchup")

        ctrl = ttk.Frame(frame)
        ctrl.pack(fill="x", padx=6, pady=4)

        ttk.Label(ctrl, text="Player 1:").pack(side="left")
        self._mu_p1 = ttk.Combobox(ctrl, width=22)
        self._mu_p1.pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Player 2:").pack(side="left")
        self._mu_p2 = ttk.Combobox(ctrl, width=22)
        self._mu_p2.pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Days:").pack(side="left")
        self._mu_days = tk.IntVar(value=30)
        ttk.Spinbox(ctrl, from_=1, to=365, width=5,
                    textvariable=self._mu_days).pack(side="left", padx=(2, 10))

        ttk.Button(ctrl, text="Analyze Matchup",
                   command=self._do_matchup).pack(side="left")

        self._mu_text = scrolledtext.ScrolledText(
            frame, state="disabled", wrap="word", font=("Courier", 10))
        self._mu_text.pack(fill="both", expand=True, padx=6, pady=4)

        self._player_combos += [self._mu_p1, self._mu_p2]

    def _do_matchup(self) -> None:
        """Fetch data and produce a full matchup analysis."""
        p1   = self._mu_p1.get().strip()
        p2   = self._mu_p2.get().strip()
        days = self._mu_days.get()
        if not p1 or not p2:
            messagebox.showwarning("Missing players", "Select both players first.")
            return

        def fetch() -> tuple:
            c = _Client()
            try:
                parts  = c.participants()
                events = c.schedule_range(days)
            finally:
                c.close()
            players = _aggregate_players(parts, min_gp=1)
            games   = _ended_games(events)
            h2h     = _filter_h2h(games, p1, p2)
            return players, h2h

        def done(result: tuple) -> None:
            players, h2h = result
            text = _matchup_text(p1, p2, days, players, h2h)
            _set_text(self._mu_text, text)

        self._run(fetch, done, f"Analyzing {p1} vs {p2}…")

    # -----------------------------------------------------------------------
    # Analyze tab
    # -----------------------------------------------------------------------

    def _build_analyze_tab(self, nb: ttk.Notebook) -> None:
        """Build the Analyze tab: days spinner + walk-forward summary output."""
        frame = ttk.Frame(nb)
        nb.add(frame, text="Analyze")

        ctrl = ttk.Frame(frame)
        ctrl.pack(fill="x", padx=6, pady=4)

        ttk.Label(ctrl, text="Days:").pack(side="left")
        self._an_days = tk.IntVar(value=30)
        ttk.Spinbox(ctrl, from_=1, to=365, width=5,
                    textvariable=self._an_days).pack(side="left", padx=(2, 10))

        ttk.Button(ctrl, text="Run Analysis",
                   command=self._do_analyze).pack(side="left")

        self._an_text = scrolledtext.ScrolledText(
            frame, state="disabled", wrap="word", font=("Courier", 10))
        self._an_text.pack(fill="both", expand=True, padx=6, pady=4)

    def _do_analyze(self) -> None:
        """Fetch game data and display a walk-forward analysis report."""
        days = self._an_days.get()

        def fetch() -> list[dict]:
            c = _Client()
            try:
                return _ended_games(c.schedule_range(days))
            finally:
                c.close()

        def done(games: list[dict]) -> None:
            _set_text(self._an_text, _analyze_text(games, days))

        self._run(fetch, done, f"Running analysis over {days} days…")

    # -----------------------------------------------------------------------
    # Export tab
    # -----------------------------------------------------------------------

    def _build_export_tab(self, nb: ttk.Notebook) -> None:
        """Build the Export tab: controls for CSV export + progress log."""
        frame = ttk.Frame(nb)
        nb.add(frame, text="Export")

        ctrl = ttk.Frame(frame)
        ctrl.pack(fill="x", padx=6, pady=4)

        ttk.Label(ctrl, text="Days:").pack(side="left")
        self._ex_days = tk.IntVar(value=30)
        ttk.Spinbox(ctrl, from_=1, to=365, width=5,
                    textvariable=self._ex_days).pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Min GP:").pack(side="left")
        self._ex_mingp = tk.IntVar(value=1)
        ttk.Spinbox(ctrl, from_=1, to=999, width=5,
                    textvariable=self._ex_mingp).pack(side="left", padx=(2, 10))

        ttk.Label(ctrl, text="Output dir:").pack(side="left")
        self._ex_dir = tk.StringVar(
            value=os.path.join(os.path.expanduser("~"), "ggba_data"))
        ttk.Entry(ctrl, textvariable=self._ex_dir, width=30).pack(
            side="left", padx=(2, 4))
        ttk.Button(ctrl, text="Browse…",
                   command=self._browse_export_dir).pack(side="left", padx=(0, 10))

        ttk.Button(ctrl, text="Export CSV",
                   command=self._do_export).pack(side="left")

        self._ex_text = scrolledtext.ScrolledText(
            frame, state="disabled", wrap="word", font=("Courier", 10))
        self._ex_text.pack(fill="both", expand=True, padx=6, pady=4)

    def _browse_export_dir(self) -> None:
        """Open a directory browser and update the export path field."""
        d = filedialog.askdirectory(initialdir=self._ex_dir.get())
        if d:
            self._ex_dir.set(d)

    def _do_export(self) -> None:
        """Fetch all data and write four CSV files to the chosen directory."""
        days    = self._ex_days.get()
        min_gp  = self._ex_mingp.get()
        out_dir = self._ex_dir.get()

        def fetch() -> tuple:
            c = _Client()
            try:
                parts  = c.participants()
                events = c.schedule_range(days)
            finally:
                c.close()
            return parts, events

        def done(result: tuple) -> None:
            parts, events = result
            log = _write_csvs(parts, events, out_dir, days, min_gp)
            _set_text(self._ex_text, log)

        self._run(fetch, done, "Fetching data for export…")


# ---------------------------------------------------------------------------
# Pure formatting functions (no tkinter — easy to unit-test)
# ---------------------------------------------------------------------------

def _matchup_text(p1: str, p2: str, days: int,
                  players: list[dict], h2h: list[dict]) -> str:
    """Build a full matchup analysis report as a plain-text string."""
    def _find(name: str) -> dict | None:
        return next((p for p in players if p["name"].lower() == name.lower()), None)

    pp1, pp2 = _find(p1), _find(p2)
    totals   = [g["s1"] + g["s2"] for g in h2h]
    p1_wins  = sum(1 for g in h2h if g["winner"].lower() == p1.lower())

    sep   = "=" * 62
    lines = [sep, f"  MATCHUP ANALYSIS:  {p1}  vs  {p2}", sep]

    def _show_player(label: str, p: dict | None) -> None:
        if not p:
            lines.append(f"\n  {label}: NOT FOUND — check the spelling (see Players tab)")
            return
        lines.append(f"\n  {label}: {p['name']}")
        lines.append(f"    Record : {p['w']}-{p['l']} ({p['gp']} GP)   Win%: {_fmt(p['win_pct'])}")
        lines.append(f"    PPM    : {_fmt(p['pts_per_match'])}   FG%: {_fmt(p['fg_pct'])}")
        lines.append(f"    Steals : {_fmt(p['steals'])}   Fouls: {_fmt(p['fouls'])}")
        lines.append(f"    Form   : {p['recent_form'] or '-'}")

    _show_player("Player 1", pp1)
    _show_player("Player 2", pp2)

    lines.append(f"\n  Head-to-head (last {days}d): {len(h2h)} games")
    if h2h:
        lines.append(f"    {p1}: {p1_wins} wins   {p2}: {len(h2h) - p1_wins} wins")
        if totals:
            avg_t = statistics.mean(totals)
            row   = f"    Avg total: {avg_t:.1f}"
            if len(totals) > 1:
                row += f"   Std dev: {statistics.stdev(totals):.1f}"
            lines.append(row)

    if pp1 and pp2:
        p1_ppm = pp1.get("pts_per_match")
        p2_ppm = pp2.get("pts_per_match")
        if isinstance(p1_ppm, (int, float)) and isinstance(p2_ppm, (int, float)):
            exp = p1_ppm + p2_ppm
            lines.append(f"\n  Expected total (PPM model): {exp:.1f}")
            if totals:
                avg_t = statistics.mean(totals)
                lines.append(
                    f"  vs H2H average:            {avg_t:.1f}  (diff: {exp - avg_t:+.1f})")

        wp1 = pp1.get("win_pct")
        wp2 = pp2.get("win_pct")
        if isinstance(wp1, (int, float)) and isinstance(wp2, (int, float)):
            edge    = abs(wp1 - wp2)
            favored = p1 if wp1 > wp2 else p2
            lines.append(f"\n  Win%-based edge: {favored} favored (+{edge:.1f}%)")

    lines.append("\n" + sep)

    if h2h:
        lines.append("\n  Recent H2H games (newest last):")
        hdr = f"  {'Date':<12} {'P1':<22} {'S1':>4}  {'S2':>4}  {'P2':<22} {'Winner'}"
        lines.append(hdr)
        lines.append("  " + "-" * len(hdr))
        for g in h2h[-25:]:
            lines.append(
                f"  {g['date']:<12} {g['p1']:<22} {g['s1']:>4}  {g['s2']:>4}  "
                f"{g['p2']:<22} {g['winner']}"
            )

    return "\n".join(lines) + "\n"


def _analyze_text(games: list[dict], days: int) -> str:
    """Build a walk-forward analysis report as a plain-text string."""
    if not games:
        return f"No completed games found in the last {days} days.\n"

    wf     = _build_walkforward(games)
    totals = [float(r["actual_total"])
              for r in wf if isinstance(r.get("actual_total"), (int, float))]

    lines = [
        f"Walk-forward summary — {len(wf)} games over {days} days",
        "─" * 54,
    ]

    if totals:
        avg_t = statistics.mean(totals)
        std_t = statistics.stdev(totals) if len(totals) > 1 else 0.0
        med_t = statistics.median(totals)
        over  = sum(1 for t in totals if t > med_t)
        lines += [
            "Combined score (total):",
            f"  avg    = {avg_t:.1f}",
            f"  std    = {std_t:.1f}",
            f"  median = {med_t:.1f}  ({over}/{len(totals)} games over median)",
            f"  range  = {min(totals):.0f} – {max(totals):.0f}",
        ]

    # Win%-model accuracy
    correct = usable = 0
    for r in wf:
        wp1, wp2 = r["p1_win_pct"], r["p2_win_pct"]
        if not isinstance(wp1, float) or not isinstance(wp2, float) or wp1 == wp2:
            continue
        usable += 1
        if (wp1 > wp2) == (float(r["score1"]) > float(r["score2"])):
            correct += 1

    lines.append("")
    if usable:
        lines.append(
            f"Win%-model accuracy: {correct / usable * 100:.1f}%"
            f"  ({correct}/{usable} games with unequal win%)"
        )
    else:
        lines.append("Win%-model accuracy: insufficient data (need pre-game win% snapshots)")

    # Per-player aggregate from raw game list
    pstats: dict[str, dict] = {}
    for g in games:
        for who, pts, opp in (
            (g["p1"], float(g["s1"]), float(g["s2"])),
            (g["p2"], float(g["s2"]), float(g["s1"])),
        ):
            s = pstats.setdefault(who, {"gp": 0, "w": 0, "l": 0, "pts": 0.0})
            s["gp"] += 1
            s["pts"] += pts
            if pts > opp:
                s["w"] += 1
            else:
                s["l"] += 1

    lines += [
        "",
        "Per-player summary (from this period's games):",
        f"  {'Player':<26} {'GP':>4}  {'W':>4}  {'L':>4}  {'Win%':>6}  {'Avg Pts':>8}",
        "  " + "-" * 60,
    ]
    for name in sorted(pstats):
        s   = pstats[name]
        wp  = s["w"] / s["gp"] * 100 if s["gp"] else 0.0
        avg = s["pts"] / s["gp"] if s["gp"] else 0.0
        lines.append(
            f"  {name:<26} {s['gp']:>4}  {s['w']:>4}  {s['l']:>4}  {wp:>5.1f}%  {avg:>8.1f}"
        )

    return "\n".join(lines) + "\n"


def _write_csvs(parts: list[dict], events: list[dict],
                out_dir: str, days: int, min_gp: int) -> str:
    """Write four CSV files and return a progress log string."""
    os.makedirs(out_dir, exist_ok=True)

    players   = _aggregate_players(parts, min_gp=min_gp)
    games     = _ended_games(events)
    wf        = _build_walkforward(games)
    standings = _build_standings(parts)
    matches   = [
        {
            "date":     g["date"],
            "player1":  g["p1"],
            "player2":  g["p2"],
            "score1":   g["s1"],
            "score2":   g["s2"],
            "total":    g["s1"] + g["s2"],
            "division": g["division"],
        }
        for g in games
    ]

    log: list[str] = [f"Export  —  {days} days, min-gp={min_gp}  →  {out_dir}\n"]

    def _save(fname: str, rows: list[dict]) -> None:
        if not rows:
            log.append(f"  {fname}: (no data)")
            return
        path = os.path.join(out_dir, fname)
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        log.append(f"  {fname}: {len(rows)} rows  →  {path}")

    _save("ggba_players.csv",    players)
    _save("ggba_standings.csv",  standings)
    _save("ggba_walkforward.csv", wf)
    _save("ggba_matches.csv",    matches)
    log.append("\nDone.")
    return "\n".join(log) + "\n"


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Launch the H2H GG Analyzer desktop GUI."""
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
ggba_optimizer.py — Walk-forward hyperparameter optimizer for the GGBA rating model.

Champion/challenger optimization pipeline:
  1. Load and validate the walk-forward CSV via data_validator.
  2. Build expanding-window folds (leakage-free, with a gap between train and val).
  3. Run random search or Bayesian search over PARAM_SPACE.
  4. Evaluate the best challenger on the held-out test fold.
  5. Return a challenger dict suitable for writing to challenger.json.

All feature computation, model training and evaluation delegate to ``ggba model.py``
(imported via importlib because the filename contains a space).

Dependencies: stdlib + scipy only.
"""
from __future__ import annotations

import importlib.util
import math
import os
import random as _random_module
import sys
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Dynamic import of "ggba model.py" (space in filename)                       #
# --------------------------------------------------------------------------- #
_MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "ggba model.py")

_MODULE_NAME = "ggba_model"


def _load_ggba_model():
    """Load ``ggba model.py`` via importlib, registering it in sys.modules so that
    the @dataclass decorator (which looks up cls.__module__ in sys.modules) works
    correctly even when the caller hasn't imported the module yet."""
    # If another unit already loaded it, reuse that copy.
    if _MODULE_NAME in sys.modules:
        return sys.modules[_MODULE_NAME]
    spec = importlib.util.spec_from_file_location(
        _MODULE_NAME,
        os.path.abspath(_MODEL_PATH),
    )
    mod = importlib.util.module_from_spec(spec)
    # Register BEFORE exec_module so @dataclass can resolve cls.__module__
    sys.modules[_MODULE_NAME] = mod
    spec.loader.exec_module(mod)
    return mod


_MODEL = _load_ggba_model()
walk_forward = _MODEL.walk_forward
accuracy = _MODEL.accuracy
calibration = _MODEL.calibration


# --------------------------------------------------------------------------- #
# Hyperparameter search space                                                  #
# --------------------------------------------------------------------------- #
PARAM_SPACE: Dict[str, Tuple[float, float]] = {
    'etaP':       (0.02, 0.20),   # player learning rate
    'etaT':       (0.01, 0.10),   # team learning rate
    'decay':      (0.0,  0.05),   # recency decay
    'dispersion': (0.80, 2.00),   # sigma multiplier
    'edge':       (0.01, 0.08),   # edge threshold
}

# Default min_gp — model needs this many games before a player is rated
_DEFAULT_MIN_GP: int = 5


# --------------------------------------------------------------------------- #
# Fold construction                                                            #
# --------------------------------------------------------------------------- #
def _parse_date(date_str: str) -> str:
    """Normalise a date string to YYYY-MM-DD for lexicographic comparison."""
    s = str(date_str).strip()
    if len(s) == 10 and s[2] == '/' and s[5] == '/':
        try:
            mm, dd, yyyy = s[:2], s[3:5], s[6:]
            return f"{yyyy}-{mm}-{dd}"
        except Exception:
            pass
    return s


def build_folds(
    games: List[Dict[str, Any]],
    n_folds: int = 5,
    gap_days: int = 7,
) -> List[Dict[str, Any]]:
    """Build expanding-window walk-forward folds.

    Parameters
    ----------
    games:
        Chronologically sorted list of game dicts.
    n_folds:
        Number of expanding windows to create (excluding the final test fold).
    gap_days:
        Minimum number of calendar days between the last training game and the
        first validation game.  Prevents boundary leakage when two legs of the
        same match day are split across the boundary.

    Returns
    -------
    list[dict]
        Each element is ``{'train': [...], 'val': [...], 'test': [...]}``.
        ``test`` is always the *last* chronological slice and is IDENTICAL
        across all folds — it is NEVER used during optimisation, only for
        final evaluation.
    """
    n = len(games)
    if n < n_folds * 3:
        raise ValueError(
            f"Too few games ({n}) for {n_folds} folds (need at least {n_folds * 3})."
        )

    # Reserve the last 20 % as the held-out test slice
    test_start_idx = max(n_folds * 2, int(n * 0.80))
    test_games = games[test_start_idx:]

    # The remaining games are used for train/val splits
    available = games[:test_start_idx]
    m = len(available)

    # Each fold gets an incrementally larger training window
    # Minimum training size: 40 % of available
    min_train = max(10, int(m * 0.40))

    folds: List[Dict[str, Any]] = []
    for fold_idx in range(n_folds):
        # Fraction of available data used as *training* in this fold
        fraction = 0.40 + fold_idx * (0.55 / max(n_folds - 1, 1))
        fraction = min(fraction, 0.95)
        train_end = max(min_train, int(m * fraction))

        train_games = available[:train_end]
        if not train_games:
            continue

        # Apply gap: skip games within gap_days of the last training game
        last_train_date = _parse_date(train_games[-1].get('date', ''))
        gap_start_idx = train_end
        if gap_days > 0:
            for k in range(train_end, m):
                candidate_date = _parse_date(available[k].get('date', ''))
                # Simple lexicographic date difference is not precise for
                # arbitrary formats, but for YYYY-MM-DD the diff in days can be
                # approximated by character comparison after converting to a
                # comparable form.  We do a best-effort ISO comparison.
                try:
                    from datetime import date as _date
                    ld = _date.fromisoformat(last_train_date)
                    cd = _date.fromisoformat(candidate_date)
                    if (cd - ld).days >= gap_days:
                        gap_start_idx = k
                        break
                except Exception:
                    # Fall back: skip no extra games if date parsing fails
                    gap_start_idx = train_end
                    break
            else:
                gap_start_idx = m  # no validation data after gap

        val_games = available[gap_start_idx:]
        if not val_games:
            # If gap consumed all remaining data, use a thin slice without gap
            val_games = available[train_end:]

        folds.append({
            'train': train_games,
            'val':   val_games,
            'test':  test_games,
        })

    if not folds:
        raise ValueError("Could not construct any valid folds from the supplied games.")

    return folds


# --------------------------------------------------------------------------- #
# Feature pre-computation (leakage-free)                                       #
# --------------------------------------------------------------------------- #
def precompute_features(games: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Add computed fields to each game using only information from prior games.

    Fields added per game dict (in-place, non-destructive to original keys):
    - ``rolling_avg_p1``: player-1 rolling points-per-game mean (prior games)
    - ``rolling_avg_p2``: player-2 rolling points-per-game mean (prior games)
    - ``form_p1``: last-5-game win/loss form string for player 1 (most recent first)
    - ``form_p2``: last-5-game win/loss form string for player 2 (most recent first)
    - ``days_since_last_p1``: calendar days since player 1's previous game (None if first)

    All values are derived from games that appear *before* the current game in
    the list, so there is zero forward leakage.
    """
    # Per-player state accumulated as we iterate forward
    p_pts: Dict[str, float] = {}
    p_gp:  Dict[str, int]   = {}
    p_form: Dict[str, List[str]] = {}   # list of 'W'/'L' strings, newest last
    p_last_date: Dict[str, Optional[str]] = {}

    result: List[Dict[str, Any]] = []
    for g in games:
        p1 = str(g.get('player1', ''))
        p2 = str(g.get('player2', ''))
        cur_date = _parse_date(g.get('date', ''))

        # --- rolling averages (prior info only) ---
        avg_p1 = (p_pts.get(p1, 0.0) / p_gp[p1]) if p_gp.get(p1) else None
        avg_p2 = (p_pts.get(p2, 0.0) / p_gp[p2]) if p_gp.get(p2) else None

        # --- form strings (most recent first, up to 5 games) ---
        form_p1 = ''.join(reversed(p_form.get(p1, [])))[-5:]
        form_p2 = ''.join(reversed(p_form.get(p2, [])))[-5:]

        # --- days since last game for p1 ---
        days_p1: Optional[int] = None
        if p_last_date.get(p1):
            try:
                from datetime import date as _date
                d_last = _date.fromisoformat(p_last_date[p1])
                d_cur  = _date.fromisoformat(cur_date)
                days_p1 = (d_cur - d_last).days
            except Exception:
                days_p1 = None

        enriched = dict(g)
        enriched['rolling_avg_p1'] = avg_p1
        enriched['rolling_avg_p2'] = avg_p2
        enriched['form_p1'] = form_p1
        enriched['form_p2'] = form_p2
        enriched['days_since_last_p1'] = days_p1
        result.append(enriched)

        # --- update state AFTER recording (leakage-free) ---
        s1 = float(g.get('score1', 0) or 0)
        s2 = float(g.get('score2', 0) or 0)
        won_p1 = 'W' if s1 > s2 else 'L'
        won_p2 = 'W' if s2 > s1 else 'L'

        p_pts[p1] = p_pts.get(p1, 0.0) + s1
        p_gp[p1]  = p_gp.get(p1, 0) + 1
        p_form.setdefault(p1, []).append(won_p1)

        p_pts[p2] = p_pts.get(p2, 0.0) + s2
        p_gp[p2]  = p_gp.get(p2, 0) + 1
        p_form.setdefault(p2, []).append(won_p2)

        p_last_date[p1] = cur_date
        p_last_date[p2] = cur_date

    return result


# --------------------------------------------------------------------------- #
# Objective function                                                           #
# --------------------------------------------------------------------------- #
def objective(
    params: Dict[str, float],
    fold_train: List[Dict[str, Any]],
    fold_val: List[Dict[str, Any]],
) -> float:
    """Score *params* on *fold_val* after training on *fold_train*.

    The returned loss is ``weighted_hybrid_loss + 10 * ECE`` (lower = better).

    weighted_hybrid_loss = 0.5 * MAE/sigma_ref + 0.5 * (1 - |r|)
        where sigma_ref = sqrt(league_mean_total) and r = Pearson correlation.

    Parameters are clipped to PARAM_SPACE bounds before use.
    """
    # Clip params to valid bounds
    p = {k: max(lo, min(hi, params.get(k, (lo + hi) / 2)))
         for k, (lo, hi) in PARAM_SPACE.items()}

    etaP       = p['etaP']
    etaT       = p['etaT']
    decay      = p['decay']
    dispersion = p['dispersion']
    edge       = p['edge']

    # Train the model on fold_train (state is captured in the returned model object)
    # We run walk_forward over the combined train+val sequence but we only
    # evaluate on val predictions — we feed train first to warm up the model,
    # then val.  Since walk_forward is leakage-free (predict before update),
    # running it sequentially is equivalent to "train then predict on val".
    combined = fold_train + fold_val
    try:
        rated_rows, _base_rows, _model = walk_forward(
            combined,
            etaP=etaP,
            etaT=etaT,
            decay=decay,
            dispersion=dispersion,
            min_gp=_DEFAULT_MIN_GP,
        )
    except Exception:
        return 1e9  # degenerate params

    # rated_rows correspond to games that *passed* the min_gp filter.
    # We cannot directly slice them to val-only rows because min_gp filtering
    # may drop different games.  Instead we re-run on val alone, initialised
    # with the model state after training.  However walk_forward does not
    # accept a pre-trained model object yet — so we approximate by noting that
    # `rated_rows` from the combined run includes predictions for both train
    # and val games; we need to keep only the val portion.
    #
    # Strategy: run walk_forward on combined and take the LAST len(fold_val)
    # predictions that could plausibly come from val.  Since predictions are
    # generated in chronological order and only when min_gp is met, we cannot
    # perfectly assign them without index tracking.  We use a conservative
    # approximation: take rows produced beyond the train-equivalent watermark.
    # This is safe because min_gp ensures warmup predictions only happen after
    # sufficient history, so the first few rated rows are from the early
    # train period.
    #
    # Better approach: run walk_forward twice — first on train (to warm up
    # the model), then re-run on train+val and use the rated_rows count
    # difference.  We do this here.

    # Count rows produced by train-only run
    try:
        train_rated, _, _ = walk_forward(
            fold_train,
            etaP=etaP,
            etaT=etaT,
            decay=decay,
            dispersion=dispersion,
            min_gp=_DEFAULT_MIN_GP,
        )
        n_train_rated = len(train_rated)
    except Exception:
        n_train_rated = 0

    val_rated = rated_rows[n_train_rated:]

    if len(val_rated) < 5:
        return 1e9  # too few rated games — degenerate

    acc  = accuracy(val_rated)
    cal  = calibration(val_rated, edge_thresh=edge)

    mae  = acc.get('mae') or 999.0
    r    = acc.get('r')   or 0.0
    ece  = cal.get('ece') or 1.0

    # Normalise MAE by approximate sigma_ref (sqrt of typical total)
    # Use 130 as a reasonable default total for NBA 2K / eBasketball
    sigma_ref = math.sqrt(max(mae, 1.0))  # use sqrt(mae) as scale-invariant ref
    mae_norm = mae / max(sigma_ref, 1.0)

    hybrid_loss = 0.5 * mae_norm + 0.5 * max(0.0, 1.0 - abs(r))
    loss = hybrid_loss + 10.0 * ece
    return loss


# --------------------------------------------------------------------------- #
# Random search                                                                #
# --------------------------------------------------------------------------- #
def random_search(
    games: List[Dict[str, Any]],
    n_iter: int = 200,
    seed: int = 42,
) -> List[Dict[str, Any]]:
    """Uniform random sampling over PARAM_SPACE across walk-forward folds.

    Parameters
    ----------
    games:
        Chronologically sorted game list.
    n_iter:
        Number of random parameter draws to evaluate.
    seed:
        Random seed for reproducibility.

    Returns
    -------
    list[dict]
        Each element: ``{'params': dict, 'val_score': float, 'fold_scores': list[float]}``,
        sorted ascending by ``val_score`` (best first).
    """
    rng = _random_module.Random(seed)
    folds = build_folds(games, n_folds=3, gap_days=0)

    results: List[Dict[str, Any]] = []
    for _ in range(n_iter):
        params = {
            k: rng.uniform(lo, hi)
            for k, (lo, hi) in PARAM_SPACE.items()
        }
        fold_scores: List[float] = []
        for fold in folds:
            score = objective(params, fold['train'], fold['val'])
            fold_scores.append(score)
        val_score = sum(fold_scores) / len(fold_scores)
        results.append({
            'params':      params,
            'val_score':   val_score,
            'fold_scores': fold_scores,
        })

    results.sort(key=lambda r: r['val_score'])
    return results


# --------------------------------------------------------------------------- #
# Bayesian search (L-BFGS-B via scipy)                                        #
# --------------------------------------------------------------------------- #
def bayesian_search(
    games: List[Dict[str, Any]],
    initial_params: Dict[str, float],
    n_iter: int = 100,
) -> Dict[str, Any]:
    """Bayesian-style optimisation using ``scipy.optimize.minimize`` (L-BFGS-B).

    Starts from *initial_params* (the champion or best from random search) and
    descends the objective landscape within PARAM_SPACE bounds.

    Parameters
    ----------
    games:
        Chronologically sorted game list.
    initial_params:
        Starting point — typically the champion params or best from random_search.
    n_iter:
        Maximum number of function evaluations.

    Returns
    -------
    dict
        ``{'params': dict, 'val_score': float}``
    """
    try:
        from scipy.optimize import minimize
    except ImportError as exc:
        raise ImportError("scipy is required for bayesian_search. Install with: pip install scipy") from exc

    folds = build_folds(games, n_folds=3, gap_days=0)
    param_keys = list(PARAM_SPACE.keys())
    bounds = [PARAM_SPACE[k] for k in param_keys]

    x0 = [
        max(lo, min(hi, float(initial_params.get(k, (lo + hi) / 2))))
        for k, (lo, hi) in PARAM_SPACE.items()
    ]

    def _obj(x: List[float]) -> float:
        params = dict(zip(param_keys, x))
        scores = [objective(params, f['train'], f['val']) for f in folds]
        return sum(scores) / len(scores)

    result = minimize(
        _obj,
        x0=x0,
        method='L-BFGS-B',
        bounds=bounds,
        options={'maxfun': n_iter, 'ftol': 1e-7, 'gtol': 1e-5},
    )

    best_params = dict(zip(param_keys, result.x.tolist()))
    return {
        'params':    best_params,
        'val_score': float(result.fun),
    }


# --------------------------------------------------------------------------- #
# Neighbourhood search                                                         #
# --------------------------------------------------------------------------- #
def neighborhood_search(
    games: List[Dict[str, Any]],
    champion_params: Dict[str, float],
    n_iter: int = 50,
) -> Dict[str, Any]:
    """Search within ±10 % of *champion_params*.

    More efficient than a global random search when the champion is already
    good — this refines the local landscape quickly.

    Parameters
    ----------
    games:
        Chronologically sorted game list.
    champion_params:
        Current best parameters to search around.
    n_iter:
        Number of random draws within the neighbourhood.

    Returns
    -------
    dict
        ``{'params': dict, 'val_score': float, 'fold_scores': list[float]}``
    """
    rng = _random_module.Random(0xDEADBEEF)
    folds = build_folds(games, n_folds=3, gap_days=0)

    best_score = float('inf')
    best_result: Optional[Dict[str, Any]] = None

    for _ in range(n_iter):
        params: Dict[str, float] = {}
        for k, (lo, hi) in PARAM_SPACE.items():
            center = float(champion_params.get(k, (lo + hi) / 2))
            width  = (hi - lo) * 0.10   # ±10 % of the full range
            lo_n   = max(lo, center - width)
            hi_n   = min(hi, center + width)
            params[k] = rng.uniform(lo_n, hi_n)

        fold_scores: List[float] = []
        for fold in folds:
            fold_scores.append(objective(params, fold['train'], fold['val']))

        val_score = sum(fold_scores) / len(fold_scores)
        if val_score < best_score:
            best_score = val_score
            best_result = {
                'params':      params,
                'val_score':   val_score,
                'fold_scores': fold_scores,
            }

    if best_result is None:
        # Fallback: return champion if all evaluations failed
        return {
            'params':      champion_params,
            'val_score':   float('inf'),
            'fold_scores': [],
        }
    return best_result


# --------------------------------------------------------------------------- #
# Final evaluation on held-out test fold                                       #
# --------------------------------------------------------------------------- #
def final_evaluation(
    best_params: Dict[str, float],
    test_games: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Evaluate *best_params* on the held-out test fold.

    This is called ONCE at the very end, after all hyperparameter search is
    complete.  The test fold must NEVER have been used during optimisation.

    Returns
    -------
    dict
        Full metrics: ``{n, mae, rmse, bias, r, ece, brier, flag_roi_pct, flags}``.
    """
    p = {k: max(lo, min(hi, best_params.get(k, (lo + hi) / 2)))
         for k, (lo, hi) in PARAM_SPACE.items()}

    try:
        rated_rows, _base, _model = walk_forward(
            test_games,
            etaP=p['etaP'],
            etaT=p['etaT'],
            decay=p['decay'],
            dispersion=p['dispersion'],
            min_gp=_DEFAULT_MIN_GP,
        )
    except Exception as exc:
        return {'error': str(exc)}

    if not rated_rows:
        return {'n': 0, 'mae': None, 'rmse': None, 'bias': None,
                'r': None, 'ece': None, 'brier': None,
                'flag_roi_pct': None, 'flags': None}

    acc = accuracy(rated_rows)
    cal = calibration(rated_rows, edge_thresh=p['edge'])
    return {
        'n':           acc.get('n'),
        'mae':         acc.get('mae'),
        'rmse':        acc.get('rmse'),
        'bias':        acc.get('bias'),
        'r':           acc.get('r'),
        'ece':         cal.get('ece'),
        'brier':       cal.get('brier'),
        'flag_roi_pct': cal.get('flag_roi_pct'),
        'flags':       cal.get('flags'),
    }


# --------------------------------------------------------------------------- #
# Leakage diagnostics                                                          #
# --------------------------------------------------------------------------- #
def leakage_diagnostics(
    train_games: List[Dict[str, Any]],
    test_games: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Verify that all test games come *after* all training games chronologically.

    Returns
    -------
    dict
        ``{'clean': bool, 'earliest_test': str, 'latest_train': str, 'overlap_count': int}``
    """
    if not train_games or not test_games:
        return {
            'clean':          True,
            'earliest_test':  None,
            'latest_train':   None,
            'overlap_count':  0,
        }

    train_dates = [_parse_date(g.get('date', '')) for g in train_games]
    test_dates  = [_parse_date(g.get('date', '')) for g in test_games]

    latest_train  = max(train_dates)
    earliest_test = min(test_dates)

    overlap_count = sum(1 for d in test_dates if d <= latest_train)
    clean = overlap_count == 0

    return {
        'clean':         clean,
        'earliest_test': earliest_test,
        'latest_train':  latest_train,
        'overlap_count': overlap_count,
    }


# --------------------------------------------------------------------------- #
# Robustness statistics across folds                                           #
# --------------------------------------------------------------------------- #
def robustness_stats(fold_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Compute cross-fold stability metrics.

    Parameters
    ----------
    fold_results:
        List of per-fold metric dicts (e.g., from successive ``final_evaluation``
        calls or from the ``fold_scores`` entries in random_search output).

    Returns
    -------
    dict
        ``{'mae_std': float, 'mae_worst': float, 'ece_std': float, 'ece_worst': float,
           'r_std': float, 'r_worst': float}``
    """
    def _std(vals: List[float]) -> Optional[float]:
        vals = [v for v in vals if v is not None]
        if len(vals) < 2:
            return None
        mu = sum(vals) / len(vals)
        var = sum((v - mu) ** 2 for v in vals) / (len(vals) - 1)
        return math.sqrt(var)

    def _worst(vals: List[float], lower_is_better: bool = True) -> Optional[float]:
        vals = [v for v in vals if v is not None]
        if not vals:
            return None
        return max(vals) if lower_is_better else min(vals)

    maes = [r.get('mae') for r in fold_results if isinstance(r, dict)]
    eces = [r.get('ece') for r in fold_results if isinstance(r, dict)]
    rs   = [r.get('r')   for r in fold_results if isinstance(r, dict)]

    return {
        'mae_std':   _std(maes),
        'mae_worst': _worst(maes, lower_is_better=True),
        'ece_std':   _std(eces),
        'ece_worst': _worst(eces, lower_is_better=True),
        'r_std':     _std(rs),
        'r_worst':   _worst(rs, lower_is_better=False),
    }


# --------------------------------------------------------------------------- #
# Top-level pipeline                                                           #
# --------------------------------------------------------------------------- #
def run_optimizer(
    csv_path: str,
    champion_params: Optional[Dict[str, float]] = None,
    mode: str = 'global',
) -> Dict[str, Any]:
    """Full optimizer pipeline.

    Parameters
    ----------
    csv_path:
        Path to the walk-forward CSV.
    champion_params:
        Current best hyperparameters (used as starting point for neighbourhood
        search or Bayesian refinement).  Pass ``None`` to start from scratch.
    mode:
        ``'global'`` — random search + Bayesian refinement.
        ``'neighborhood'`` — narrow search around *champion_params*.

    Returns
    -------
    dict
        Challenger dict::

            {
                'hyperparams':  {...},
                'metrics':      {...},   # final_evaluation on held-out test
                'fold_scores':  [...],   # per-fold val losses
                'leakage_diag': {...},   # leakage_diagnostics output
                'robustness':   {...},   # robustness_stats output
            }

        This dict is suitable for writing directly to ``challenger.json``.
    """
    # 1. Load and validate
    from optimizer.data_validator import load_and_validate
    games = load_and_validate(csv_path)

    # 2. Build folds
    folds = build_folds(games, n_folds=5, gap_days=7)
    test_games = folds[0]['test']  # same across all folds

    # 3. Search
    if mode == 'neighborhood':
        if champion_params is None:
            raise ValueError("champion_params must be provided for mode='neighborhood'.")
        best_result = neighborhood_search(games, champion_params, n_iter=50)
        best_params = best_result['params']
        fold_scores = best_result.get('fold_scores', [])
    else:
        # Global: random search then Bayesian refinement
        random_results = random_search(games, n_iter=200, seed=42)
        best_random = random_results[0]

        # Refine with Bayesian optimisation starting from best random result
        try:
            bayesian_result = bayesian_search(
                games,
                initial_params=best_random['params'],
                n_iter=100,
            )
            if bayesian_result['val_score'] < best_random['val_score']:
                best_params = bayesian_result['params']
                fold_scores = [bayesian_result['val_score']]
            else:
                best_params = best_random['params']
                fold_scores = best_random.get('fold_scores', [])
        except Exception:
            best_params = best_random['params']
            fold_scores = best_random.get('fold_scores', [])

    # 4. Leakage diagnostics (use first fold's train vs test)
    leakage_diag = leakage_diagnostics(folds[0]['train'], test_games)

    # 5. Final evaluation on held-out test fold
    metrics = final_evaluation(best_params, test_games)

    # 6. Robustness: evaluate best_params on each fold independently
    fold_metric_list: List[Dict[str, Any]] = []
    for fold in folds:
        fm = final_evaluation(best_params, fold['val'])
        fold_metric_list.append(fm)
    robustness = robustness_stats(fold_metric_list)

    return {
        'hyperparams':  best_params,
        'metrics':      metrics,
        'fold_scores':  fold_scores,
        'leakage_diag': leakage_diag,
        'robustness':   robustness,
    }

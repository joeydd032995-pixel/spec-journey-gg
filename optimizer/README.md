# GGBA Optimizer

Champion/challenger optimization pipeline for the GG League betting analytics stack.

## Installation
pip install httpx apscheduler scipy

## Quick Start
# Export real data (36 GP×days combinations)
python3 optimizer/export_datasets.py --all

# Run optimizer and set initial champion
python3 optimizer/pipeline.py optimize --csv ggba_data/walkforward_gp10_days56.csv

# Check system status
python3 optimizer/pipeline.py status

# Start full scheduler (4am eval + 30min monitoring)
python3 optimizer/pipeline.py schedule

## Subcommands
- export     Export walk-forward CSVs (--gp N --days N, or --all for all 36)
- optimize   Run optimizer and update champion
- shadow     Shadow-mode predictions and live stats
- monitor    Run one monitoring cycle
- schedule   Start APScheduler background jobs
- status     Print champion, queue, shadow stats
- test       End-to-end test (--quick for fast run)

## Environment Variables
GGBA_OPT_EVAL_HOUR=4          # Hour for daily optimizer run (UTC)
GGBA_OPT_MONITOR_MIN=30       # Monitoring interval (minutes)
GGBA_OPT_DATA_PATH=ggba_data/ # Path to CSV data directory
GGBA_OPT_MIN_GP=10            # Min GP filter
GGBA_OPT_DAYS=56              # Days window for CSV selection
GGBA_GATE_ROI_MARGIN=2.0      # Min ROI improvement to promote challenger
GGBA_GATE_MAE_MARGIN=0.2      # Min MAE improvement to promote challenger
GGBA_GATE_MIN_TRADES=50       # Min trades for valid challenger

## Metric Targets
Brier Score     ≤ 1.68
ECE             ≤ 0.019
MAE             ≤ 9.5 pts  (theoretical floor: 8.38 pts given within-pair σ=10.50)
biasOffset      ≤ -4.0     (betting strategy parameter, not accuracy metric)
Correlation (r) ≥ 0.55     (theoretical max ~0.694 given between-pair σ=9.94)

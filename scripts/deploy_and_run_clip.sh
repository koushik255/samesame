#!/usr/bin/env bash
# Run ONCE SSH to kouskous works. Copies code, installs deps if needed, encodes, restarts service.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST=kouskous
REMOTE=~/scene-browser

echo "== sync =="
rsync -av --exclude node_modules --exclude .venv --exclude data/shot_frames --exclude __pycache__ \
  "$ROOT/server.js" "$ROOT/public" "$ROOT/scripts" "$ROOT/CLIP_SCENES.md" "$ROOT/systemd" \
  "$HOST:$REMOTE/"

echo "== remote clip merge =="
ssh "$HOST" bash -s << 'REMOTE'
set -euo pipefail
cd ~/scene-browser
mkdir -p data scripts
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
  . .venv/bin/activate
  pip install -U pip
  # CPU torch by default; switch if nvidia-smi works
  if command -v nvidia-smi >/dev/null 2>&1; then
    pip install torch
  else
    pip install torch --index-url https://download.pytorch.org/whl/cpu
  fi
  pip install open_clip_torch pillow numpy
else
  . .venv/bin/activate
fi
nice -n 15 python scripts/clip_merge_scenes.py
systemctl --user restart scene-browser.service
sleep 1
systemctl --user is-active scene-browser.service
curl -sS "http://100.98.83.82:8788/api/scenes?mode=clip" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('mode'), d.get('count'), 'cuts', d.get('cutCount'), d.get('model'))"
curl -sS -o /dev/null -w "movie %{http_code}\n" "http://100.98.83.82:8788/movie"
REMOTE
echo "Done. Hard-refresh http://100.98.83.82:8788/"

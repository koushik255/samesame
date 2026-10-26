# CLIP narrative scenes

PySceneDetect cuts live in the CSV. CLIP merges reverse-shots into narrative scenes.

## Generate / refresh

```bash
cd ~/scene-browser
# once: create venv + deps
python3 -m venv .venv
. .venv/bin/activate
pip install torch --index-url https://download.pytorch.org/whl/cpu   # or cuda wheel if GPU
pip install open_clip_torch pillow numpy

nice -n 15 python scripts/clip_merge_scenes.py
# force re-encode frames/embeddings:
nice -n 15 python scripts/clip_merge_scenes.py --reembed
```

Outputs: `data/shot_embeddings.npy`, `data/clip_scenes.json`.

## Tune

| Env / flag | Default | Effect |
|---|---|---|
| `SIM_THRESHOLD` / `--sim` | 0.72 | Lower → longer scenes; higher → more splits |
| `SUSTAINED_DROP` / `--sustained-drop` | 2 | Low-sim shots in a row before a boundary |
| `MIN_SCENE_SEC` / `--min-sec` | 4 | Merge tiny leftovers into neighbors |
| `MAX_SCENE_SEC` / `--max-sec` | 180 | Cap so dark interiors don’t become one blob |
| `BLACK_MEAN` | 12 | Skip near-black frames |
| `FRAMES_PER_SHOT` / `--frames` | middle | Or `3` for start/mid/end |

UI: **CLIP scenes** vs **Cuts** toggle. API: `/api/scenes?mode=clip|cuts`.

## Caveats

Dark night interiors can smear together (CLIP place fingerprint is weak in near-black frames). Fades/blacks are skipped when mean luma &lt; `BLACK_MEAN`. Re-run after changing thresholds (embeddings cached; merge is cheap).

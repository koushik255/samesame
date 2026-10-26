#!/usr/bin/env python3
"""
CLIP narrative-scene merge for PySceneDetect shot cuts.

Pipeline:
  1. Load shot list from the PySceneDetect CSV (or scenes JSON).
  2. For each shot, extract middle (+ optional start/end) frame(s) via ffmpeg.
  3. Embed with open_clip ViT-B-32; average → one L2-normalized vector per shot.
  4. Temporal walk: grow a scene while cosine sim to running centroid stays high;
     require SUSTAINED_DROP consecutive low-sim shots before splitting (insert tolerance).
  5. Skip / down-weight near-black frames. Apply min/max duration heuristics.
  6. Write embeddings.npy + clip_scenes.json (cached; re-run skips encode if present).

Tune (env or flags):
  SIM_THRESHOLD   default 0.72   # lower → fewer, longer scenes; higher → more splits
  SUSTAINED_DROP  default 2
  MIN_SCENE_SEC   default 4.0
  MAX_SCENE_SEC   default 180.0
  BLACK_MEAN      default 12.0   # mean pixel < this → near-black, skip frame
  FRAMES_PER_SHOT default middle  # "middle" or "3" for start/mid/end

Re-run:
  nice -n 15 python scripts/clip_merge_scenes.py
  # force re-embed:  ... --reembed
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

# ---- defaults (documented above) ----
SIM_THRESHOLD = float(os.environ.get("SIM_THRESHOLD", "0.72"))
SUSTAINED_DROP = int(os.environ.get("SUSTAINED_DROP", "2"))
MIN_SCENE_SEC = float(os.environ.get("MIN_SCENE_SEC", "4.0"))
MAX_SCENE_SEC = float(os.environ.get("MAX_SCENE_SEC", "180.0"))
BLACK_MEAN = float(os.environ.get("BLACK_MEAN", "12.0"))
MODEL_NAME = os.environ.get("CLIP_MODEL", "ViT-B-32")
PRETRAINED = os.environ.get("CLIP_PRETRAINED", "openai")

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MOVIE = ROOT / "media" / "eyes-wide-shut-browser.mp4"
DEFAULT_CSV = Path(
    os.environ.get(
        "SCENE_BROWSER_SCENES",
        "/home/koushik/Downloads/eyes-wide-shut-scenes/"
        "Eyes Wide Shut 1999 Criterion 1080p BluRay HEVC x265 5.1 BONE-Scenes.csv",
    )
)
DATA_DIR = ROOT / "data"
EMB_PATH = DATA_DIR / "shot_embeddings.npy"
EMB_META = DATA_DIR / "shot_embeddings_meta.json"
OUT_JSON = DATA_DIR / "clip_scenes.json"
FRAMES_DIR = DATA_DIR / "shot_frames"


def parse_scenes_csv(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = [l for l in text.splitlines() if l.strip()]
    i = 0
    if lines[i].startswith("Timecode List:"):
        i += 1
    header = [h.strip() for h in lines[i].split(",")]
    i += 1
    idx = {h: n for n, h in enumerate(header)}
    scenes = []
    for line in lines[i:]:
        cols = line.split(",")
        if not cols[idx["Scene Number"]].strip():
            continue
        sc = {
            "number": int(cols[idx["Scene Number"]]),
            "startFrame": int(float(cols[idx["Start Frame"]])),
            "startTimecode": cols[idx["Start Timecode"]].strip(),
            "startSeconds": float(cols[idx["Start Time (seconds)"]]),
            "endFrame": int(float(cols[idx["End Frame"]])),
            "endTimecode": cols[idx["End Timecode"]].strip(),
            "endSeconds": float(cols[idx["End Time (seconds)"]]),
            "lengthFrames": int(float(cols[idx["Length (frames)"]])),
            "lengthTimecode": cols[idx["Length (timecode)"]].strip(),
            "lengthSeconds": float(cols[idx["Length (seconds)"]]),
        }
        scenes.append(sc)
    return scenes


def extract_frame(movie: Path, t: float, out: Path) -> bool:
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, t):.3f}",
        "-i", str(movie),
        "-frames:v", "1",
        "-q:v", "3",
        "-vf", "scale=224:-2",
        "-y", str(out),
    ]
    r = subprocess.run(cmd, capture_output=True)
    return r.returncode == 0 and out.is_file() and out.stat().st_size > 100


def frame_mean_luma(path: Path) -> float:
    # cheap black detect via ffmpeg signalstats or raw; use PIL if available
    try:
        from PIL import Image
        im = Image.open(path).convert("L")
        arr = np.asarray(im, dtype=np.float32)
        return float(arr.mean())
    except Exception:
        return 128.0  # assume not black if we can't measure


def load_clip(device: str):
    import open_clip
    import torch
    model, _, preprocess = open_clip.create_model_and_transforms(
        MODEL_NAME, pretrained=PRETRAINED, device=device
    )
    model.eval()
    return model, preprocess, torch


def embed_image(model, preprocess, torch, path: Path, device: str) -> np.ndarray | None:
    from PIL import Image
    im = Image.open(path).convert("RGB")
    with torch.no_grad():
        x = preprocess(im).unsqueeze(0).to(device)
        feat = model.encode_image(x)
        feat = feat / feat.norm(dim=-1, keepdim=True)
        return feat.cpu().numpy().astype(np.float32)[0]


def shot_times(sc: dict, mode: str) -> list[float]:
    start, end = sc["startSeconds"], sc["endSeconds"]
    mid = start + max(0.0, (end - start) * 0.5)
    if mode == "3":
        a = start + min(0.3, (end - start) * 0.15)
        b = mid
        c = end - min(0.3, (end - start) * 0.15)
        return [a, b, c]
    return [mid]


def encode_shots(shots: list[dict], movie: Path, frames_mode: str, reembed: bool) -> np.ndarray:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if EMB_PATH.is_file() and EMB_META.is_file() and not reembed:
        meta = json.loads(EMB_META.read_text())
        emb = np.load(EMB_PATH)
        if (
            meta.get("n") == len(shots)
            and meta.get("model") == MODEL_NAME
            and meta.get("pretrained") == PRETRAINED
            and emb.shape[0] == len(shots)
        ):
            print(f"Loaded cached embeddings {emb.shape} from {EMB_PATH}")
            return emb
        print("Cache mismatch; re-encoding…")

    import torch
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Encoding {len(shots)} shots with open_clip {MODEL_NAME}/{PRETRAINED} on {device}")
    model, preprocess, torch_mod = load_clip(device)

    vecs = []
    for i, sc in enumerate(shots):
        parts = []
        for j, t in enumerate(shot_times(sc, frames_mode)):
            fp = FRAMES_DIR / f"{sc['number']:04d}_{j}.jpg"
            if not fp.is_file() or reembed:
                ok = extract_frame(movie, t, fp)
                if not ok:
                    print(f"  warn: frame fail shot {sc['number']} t={t:.2f}")
                    continue
            if frame_mean_luma(fp) < BLACK_MEAN:
                continue
            v = embed_image(model, preprocess, torch_mod, fp, device)
            if v is not None:
                parts.append(v)
        if not parts:
            # fallback: zero vector (will tend to split / be ignored via low weight)
            vecs.append(np.zeros(512, dtype=np.float32))
        else:
            m = np.mean(np.stack(parts, axis=0), axis=0)
            n = np.linalg.norm(m) + 1e-8
            vecs.append((m / n).astype(np.float32))
        if (i + 1) % 50 == 0 or i == 0:
            print(f"  {i + 1}/{len(shots)}")

    emb = np.stack(vecs, axis=0)
    np.save(EMB_PATH, emb)
    EMB_META.write_text(
        json.dumps(
            {
                "n": len(shots),
                "dim": int(emb.shape[1]),
                "model": MODEL_NAME,
                "pretrained": PRETRAINED,
                "frames_mode": frames_mode,
                "movie": str(movie),
            },
            indent=2,
        )
    )
    print(f"Wrote {EMB_PATH} shape={emb.shape}")
    return emb


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-6 or nb < 1e-6:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def merge_shots(
    shots: list[dict],
    emb: np.ndarray,
    sim_threshold: float,
    sustained_drop: int,
    min_sec: float,
    max_sec: float,
) -> list[dict]:
    """Temporal walk with sustained-drop split and max-length cap."""
    n = len(shots)
    if n == 0:
        return []

    boundaries: list[tuple[int, int]] = []
    i = 0
    while i < n:
        start_i = i
        centroid = emb[i].copy()
        weight = 1.0 if np.linalg.norm(emb[i]) > 1e-6 else 0.0
        low_streak = 0
        pending: list[int] = []  # low-sim shots waiting for sustained_drop decision
        i += 1
        while i < n:
            scene_dur = shots[i]["endSeconds"] - shots[start_i]["startSeconds"]
            if scene_dur > max_sec and (i - start_i) >= 1:
                break
            if np.linalg.norm(emb[i]) < 1e-6:
                # near-empty embedding: absorb into current scene, clear streak
                pending.clear()
                low_streak = 0
                i += 1
                continue
            sim = cosine(emb[i], centroid) if weight > 0 else 0.0
            if sim >= sim_threshold:
                # absorb any pending inserts, then this shot
                for p in pending:
                    pass  # already counted in range via i advancement; centroid skip
                pending.clear()
                low_streak = 0
                centroid = centroid * weight + emb[i]
                weight += 1.0
                centroid = centroid / (np.linalg.norm(centroid) + 1e-8)
                i += 1
            else:
                pending.append(i)
                low_streak += 1
                i += 1
                if low_streak >= sustained_drop:
                    # split: scene ends before first pending low shot
                    i = pending[0]
                    pending.clear()
                    break
        end_i = i  # exclusive
        if end_i <= start_i:
            end_i = start_i + 1
            i = end_i
        boundaries.append((start_i, end_i))

    # Build scene dicts
    scenes = []
    for si, (a, b) in enumerate(boundaries):
        chunk = shots[a:b]
        start = chunk[0]["startSeconds"]
        end = chunk[-1]["endSeconds"]
        scenes.append(
            {
                "number": si + 1,
                "startSeconds": start,
                "endSeconds": end,
                "lengthSeconds": end - start,
                "startTimecode": chunk[0]["startTimecode"],
                "endTimecode": chunk[-1]["endTimecode"],
                "startFrame": chunk[0]["startFrame"],
                "endFrame": chunk[-1]["endFrame"],
                "lengthFrames": chunk[-1]["endFrame"] - chunk[0]["startFrame"] + 1,
                "lengthTimecode": "",
                "shotNumbers": [c["number"] for c in chunk],
                "shotIndexStart": a,
                "shotIndexEnd": b - 1,
            }
        )

    # Merge scenes shorter than min_sec into previous (or next if first)
    merged: list[dict] = []
    for sc in scenes:
        if merged and sc["lengthSeconds"] < min_sec:
            prev = merged[-1]
            if (sc["endSeconds"] - prev["startSeconds"]) <= max_sec * 1.25:
                prev["endSeconds"] = sc["endSeconds"]
                prev["endTimecode"] = sc["endTimecode"]
                prev["endFrame"] = sc["endFrame"]
                prev["lengthSeconds"] = prev["endSeconds"] - prev["startSeconds"]
                prev["lengthFrames"] = prev["endFrame"] - prev["startFrame"] + 1
                prev["shotNumbers"].extend(sc["shotNumbers"])
                prev["shotIndexEnd"] = sc["shotIndexEnd"]
                continue
        if not merged and sc["lengthSeconds"] < min_sec and len(scenes) > 1:
            # defer: attach to next by setting flag — handle by merging forward
            merged.append(sc)
            continue
        if (
            merged
            and merged[-1]["lengthSeconds"] < min_sec
            and (sc["endSeconds"] - merged[-1]["startSeconds"]) <= max_sec * 1.25
        ):
            prev = merged[-1]
            prev["endSeconds"] = sc["endSeconds"]
            prev["endTimecode"] = sc["endTimecode"]
            prev["endFrame"] = sc["endFrame"]
            prev["lengthSeconds"] = prev["endSeconds"] - prev["startSeconds"]
            prev["lengthFrames"] = prev["endFrame"] - prev["startFrame"] + 1
            prev["shotNumbers"].extend(sc["shotNumbers"])
            prev["shotIndexEnd"] = sc["shotIndexEnd"]
            continue
        merged.append(sc)

    # renumber
    for i, sc in enumerate(merged):
        sc["number"] = i + 1
    return merged


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--movie", type=Path, default=Path(os.environ.get("SCENE_BROWSER_MOVIE", str(DEFAULT_MOVIE))))
    ap.add_argument("--csv", type=Path, default=DEFAULT_CSV)
    ap.add_argument("--reembed", action="store_true")
    ap.add_argument("--frames", default=os.environ.get("FRAMES_PER_SHOT", "middle"), choices=["middle", "3"])
    ap.add_argument("--sim", type=float, default=SIM_THRESHOLD)
    ap.add_argument("--sustained-drop", type=int, default=SUSTAINED_DROP)
    ap.add_argument("--min-sec", type=float, default=MIN_SCENE_SEC)
    ap.add_argument("--max-sec", type=float, default=MAX_SCENE_SEC)
    args = ap.parse_args()

    if not args.movie.is_file():
        sys.exit(f"Movie not found: {args.movie}")
    if not args.csv.is_file():
        sys.exit(f"CSV not found: {args.csv}")

    shots = parse_scenes_csv(args.csv)
    print(f"Loaded {len(shots)} cuts from {args.csv}")
    emb = encode_shots(shots, args.movie, args.frames, args.reembed)
    scenes = merge_shots(
        shots, emb, args.sim, args.sustained_drop, args.min_sec, args.max_sec
    )
    print(
        f"Merged {len(shots)} cuts → {len(scenes)} CLIP scenes "
        f"(sim={args.sim}, sustained_drop={args.sustained_drop}, "
        f"min={args.min_sec}s, max={args.max_sec}s, model={MODEL_NAME}/{PRETRAINED})"
    )

    # Report car dialogue region ~ shots 227–239
    focus = [s for s in scenes if any(227 <= n <= 239 for n in s["shotNumbers"])]
    print("Focus shots 227–239 absorbed into CLIP scenes:")
    for s in focus:
        print(
            f"  CLIP #{s['number']}: shots {s['shotNumbers'][0]}–{s['shotNumbers'][-1]} "
            f"({len(s['shotNumbers'])} shots) "
            f"{s['startTimecode']} → {s['endTimecode']} ({s['lengthSeconds']:.1f}s)"
        )

    payload = {
        "title": "Eyes Wide Shut (1999)",
        "mode": "clip",
        "model": f"open_clip:{MODEL_NAME}:{PRETRAINED}",
        "params": {
            "sim_threshold": args.sim,
            "sustained_drop": args.sustained_drop,
            "min_scene_sec": args.min_sec,
            "max_scene_sec": args.max_sec,
            "black_mean": BLACK_MEAN,
            "frames": args.frames,
        },
        "cutCount": len(shots),
        "count": len(scenes),
        "scenes": scenes,
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {OUT_JSON}")


if __name__ == "__main__":
    main()

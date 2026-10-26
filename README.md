# Scene browser (Eyes Wide Shut demo)

Tailscale-only scene browser: PySceneDetect cuts + CLIP narrative-scene merge, single seekable H.264 `/movie`, scene-scoped scrub bar.

## What’s in this repo
- `server.js` — serves UI, Range `/movie`, `/api/scenes?mode=clip|cuts`
- `public/` — frontend (MediaBunny thumbs + HTML video seek)
- `scripts/clip_merge_scenes.py` — open_clip ViT-B-32 embed + temporal merge
- `scripts/deploy_and_run_clip.sh` — deploy helper
- `data/clip_scenes.json` — example CLIP merge output (no video)
- `CLIP_SCENES.md` — tuning notes

## What’s not in this repo
Movie files, per-scene clips, thumbnails cache, `.venv`, and embedding `.npy` (regenerate on the server).

## Run (server)
1. Put a browser-decodable H.264 MP4 at `media/eyes-wide-shut-browser.mp4` (or set paths in the server).
2. Point the PySceneDetect CSV path (see `clip_merge_scenes.py` / env).
3. `npm install` if needed, run `node server.js`.
4. CLIP merge: create `.venv`, install deps from the script/docs, then `python scripts/clip_merge_scenes.py`.

Bind to Tailscale only in production.

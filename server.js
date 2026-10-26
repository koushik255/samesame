#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.SCENE_BROWSER_HOST || '100.98.83.82';
const PORT = Number(process.env.SCENE_BROWSER_PORT || 8788);
const BROWSER_MP4 = path.join(__dirname, 'media', 'eyes-wide-shut-browser.mp4');
const SOURCE_MKV =
  process.env.SCENE_BROWSER_SOURCE ||
  '/home/koushik/Downloads/Eyes Wide Shut 1999 Criterion 1080p BluRay HEVC x265 5.1 BONE.mkv';
const SCENES_CSV =
  process.env.SCENE_BROWSER_SCENES ||
  '/home/koushik/Downloads/eyes-wide-shut-scenes/Eyes Wide Shut 1999 Criterion 1080p BluRay HEVC x265 5.1 BONE-Scenes.csv';
const CLIP_SCENES_JSON =
  process.env.SCENE_BROWSER_CLIP_SCENES ||
  path.join(__dirname, 'data', 'clip_scenes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, 'cache');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const CLIP_DIR = path.join(CACHE_DIR, 'clips');
const MB_BUNDLE = path.join(
  __dirname,
  'node_modules',
  'mediabunny',
  'dist',
  'bundles',
  'mediabunny.min.mjs',
);

await fsp.mkdir(THUMB_DIR, { recursive: true });
await fsp.mkdir(CLIP_DIR, { recursive: true });
await fsp.mkdir(path.dirname(BROWSER_MP4), { recursive: true });

function parseScenesCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let i = 0;
  if (lines[i] && lines[i].startsWith('Timecode List:')) i += 1;
  const header = lines[i].split(',').map((h) => h.trim());
  i += 1;
  const idx = Object.fromEntries(header.map((h, n) => [h, n]));
  const scenes = [];
  for (; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (!cols[idx['Scene Number']]) continue;
    const scene = {
      number: Number(cols[idx['Scene Number']]),
      startFrame: Number(cols[idx['Start Frame']]),
      startTimecode: cols[idx['Start Timecode']],
      startSeconds: Number(cols[idx['Start Time (seconds)']]),
      endFrame: Number(cols[idx['End Frame']]),
      endTimecode: cols[idx['End Timecode']],
      endSeconds: Number(cols[idx['End Time (seconds)']]),
      lengthFrames: Number(cols[idx['Length (frames)']]),
      lengthTimecode: cols[idx['Length (timecode)']],
      lengthSeconds: Number(cols[idx['Length (seconds)']]),
    };
    if (Number.isFinite(scene.number)) scenes.push(scene);
  }
  return scenes;
}

async function resolveMovie() {
  try {
    const st = await fsp.stat(BROWSER_MP4);
    if (st.size > 1_000_000) {
      return { path: BROWSER_MP4, type: 'video/mp4', kind: 'browser-mp4', size: st.size };
    }
  } catch {
    /* not ready */
  }
  const st = await fsp.stat(SOURCE_MKV);
  return { path: SOURCE_MKV, type: 'video/x-matroska', kind: 'source-mkv', size: st.size };
}

let movie = await resolveMovie();
const cutScenes = parseScenesCsv(await fsp.readFile(SCENES_CSV, 'utf8'));
const sceneByNumber = new Map(cutScenes.map((s) => [s.number, s]));

async function loadClipScenes() {
  try {
    const raw = JSON.parse(await fsp.readFile(CLIP_SCENES_JSON, 'utf8'));
    if (Array.isArray(raw.scenes) && raw.scenes.length) return raw;
  } catch {
    /* missing until clip_merge_scenes.py is run */
  }
  return null;
}

let clipPayload = await loadClipScenes();
setInterval(async () => {
  clipPayload = await loadClipScenes();
}, 15000).unref();

console.log(`Loaded ${cutScenes.length} cut scenes`);
if (clipPayload) console.log(`Loaded ${clipPayload.count} CLIP scenes from ${CLIP_SCENES_JSON}`);
else console.log(`CLIP scenes not ready (${CLIP_SCENES_JSON}) — run scripts/clip_merge_scenes.py`);
console.log(`Serving movie (${movie.kind}): ${movie.path} (${movie.size} bytes)`);

// Refresh movie path periodically in case transcode finishes after start
setInterval(async () => {
  try {
    const next = await resolveMovie();
    if (next.path !== movie.path || next.size !== movie.size) {
      movie = next;
      console.log(`Movie updated (${movie.kind}): ${movie.path} (${movie.size} bytes)`);
    }
  } catch (err) {
    console.error('movie refresh failed', err);
  }
}, 5000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mkv': 'video/x-matroska',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function sendFile(req, res, filePath, contentType, { cache = false } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }
  const size = stat.size;
  const range = req.headers.range;
  const headersBase = {
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  };
  if (cache) headersBase['Cache-Control'] = 'public, max-age=86400';
  else headersBase['Cache-Control'] = 'no-cache';

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    let start = m[1] === '' ? 0 : Number(m[1]);
    let end = m[2] === '' ? size - 1 : Number(m[2]);
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    end = Math.min(end, size - 1);
    const chunk = end - start + 1;
    res.writeHead(206, {
      ...headersBase,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': chunk,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    ...headersBase,
    'Content-Length': size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 8000) err = err.slice(-4000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(-1500)}`));
    });
  });
}

const inflight = new Map();

async function ensureThumb(scene) {
  const out = path.join(THUMB_DIR, `${scene.number}.jpg`);
  try {
    await fsp.access(out);
    return out;
  } catch {
    /* generate */
  }
  const key = `thumb:${scene.number}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const tmp = `${out}.tmp.jpg`;
    const src = movie.path;
    const t = Math.min(
      scene.startSeconds + Math.min(0.5, scene.lengthSeconds / 3),
      Math.max(0, scene.endSeconds - 0.05),
    );
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(t),
      '-i',
      src,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-vf',
      'scale=480:-2',
      '-y',
      tmp,
    ]);
    await fsp.rename(tmp, out);
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function ensureClip(scene) {
  const out = path.join(CLIP_DIR, `${scene.number}.mp4`);
  try {
    const st = await fsp.stat(out);
    if (st.size > 1000) return out;
  } catch {
    /* generate */
  }
  const key = `clip:${scene.number}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const tmp = `${out}.tmp.mp4`;
    const start = Math.max(0, scene.startSeconds);
    const duration = Math.max(0.1, scene.endSeconds - scene.startSeconds);
    await runFfmpeg([
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(start),
      '-i',
      movie.path,
      '-t',
      String(duration),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '2',
      '-movflags',
      '+faststart',
      '-y',
      tmp,
    ]);
    await fsp.rename(tmp, out);
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function safeJoin(root, rel) {
  const full = path.normalize(path.join(root, rel));
  if (!full.startsWith(root)) return null;
  return full;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/scenes') {
      const mode = (url.searchParams.get('mode') || 'clip').toLowerCase();
      if (mode === 'clip' && clipPayload) {
        sendJson(res, 200, {
          title: clipPayload.title || 'Eyes Wide Shut (1999)',
          mode: 'clip',
          movieKind: movie.kind,
          movieBytes: movie.size,
          moviePath: path.basename(movie.path),
          count: clipPayload.count,
          cutCount: clipPayload.cutCount || cutScenes.length,
          model: clipPayload.model || null,
          params: clipPayload.params || null,
          scenes: clipPayload.scenes,
        });
        return;
      }
      // cuts (PySceneDetect shots) — also fallback if CLIP not ready
      sendJson(res, 200, {
        title: 'Eyes Wide Shut (1999)',
        mode: 'cuts',
        movieKind: movie.kind,
        movieBytes: movie.size,
        moviePath: path.basename(movie.path),
        count: cutScenes.length,
        cutCount: cutScenes.length,
        clipReady: Boolean(clipPayload),
        scenes: cutScenes,
      });
      return;
    }

    if (pathname === '/api/status') {
      sendJson(res, 200, {
        movieKind: movie.kind,
        movieBytes: movie.size,
        browserMp4Ready: movie.kind === 'browser-mp4',
        sceneCount: cutScenes.length,
        clipReady: Boolean(clipPayload),
        clipCount: clipPayload ? clipPayload.count : 0,
      });
      return;
    }

    if (pathname === '/movie' || pathname === '/movie.mp4') {
      await sendFile(req, res, movie.path, movie.type);
      return;
    }

    const thumbMatch = pathname.match(/^\/api\/thumb\/(\d+)\.jpg$/);
    if (thumbMatch) {
      const n = Number(thumbMatch[1]);
      const scene = sceneByNumber.get(n);
      if (!scene) return sendText(res, 404, 'Unknown scene');
      const file = await ensureThumb(scene);
      await sendFile(req, res, file, 'image/jpeg', { cache: true });
      return;
    }

    // Emergency fallback only — not used by the primary UI path
    const clipMatch = pathname.match(/^\/api\/scene\/(\d+)\.mp4$/);
    if (clipMatch) {
      const n = Number(clipMatch[1]);
      const scene = sceneByNumber.get(n);
      if (!scene) return sendText(res, 404, 'Unknown scene');
      const file = await ensureClip(scene);
      await sendFile(req, res, file, 'video/mp4', { cache: true });
      return;
    }

    if (pathname === '/vendor/mediabunny.min.mjs') {
      await sendFile(req, res, MB_BUNDLE, 'text/javascript; charset=utf-8', {
        cache: true,
      });
      return;
    }

    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = safeJoin(PUBLIC_DIR, rel);
    if (!filePath) return sendText(res, 403, 'Forbidden');
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    await sendFile(req, res, filePath, type, {
      cache: ext !== '.html' && ext !== '.js',
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, String(err && err.message ? err.message : err));
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`scene-browser listening on http://${HOST}:${PORT}/`);
});

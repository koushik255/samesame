import {
  Input,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  VideoSampleSink,
  AudioBufferSink,
} from '/vendor/mediabunny.min.mjs';

const MOVIE_URL = '/movie';

const els = {
  banner: document.getElementById('banner'),
  filter: document.getElementById('filter'),
  loop: document.getElementById('loop'),
  status: document.getElementById('status'),
  list: document.getElementById('scene-list'),
  canvas: document.getElementById('canvas'),
  video: document.getElementById('fallback-video'),
  overlay: document.getElementById('overlay'),
  title: document.getElementById('scene-title'),
  times: document.getElementById('scene-times'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  play: document.getElementById('play'),
  stop: document.getElementById('stop'),
  scrubWrap: document.getElementById('scene-scrub'),
  scrub: document.getElementById('scrub'),
  scrubCur: document.getElementById('scrub-cur'),
  scrubEnd: document.getElementById('scrub-end'),
  scrubPlay: document.getElementById('scrub-play'),
  modeClip: document.getElementById('mode-clip'),
  modeCuts: document.getElementById('mode-cuts'),
};

const ctx = els.canvas.getContext('2d');
let scenes = [];
let filtered = [];
let selected = null;
let mode = 'unknown'; // 'mediabunny' | 'html-video' | 'ffmpeg'
let input = null;
let videoTrack = null;
let audioTrack = null;
let canvasSink = null;
let playToken = 0;
let audioCtx = null;
let scheduledSources = [];
let thumbObserver = null;
let movieReady = false;
let endWatcher = null;
let scrubbing = false;
let scrubRaf = 0;
let sceneMode = 'clip'; // 'clip' | 'cuts'
let metaExtra = {};

function thumbShotNumber(scene) {
  if (Array.isArray(scene.shotNumbers) && scene.shotNumbers.length) return scene.shotNumbers[0];
  return scene.number;
}

function hideBanner() {
  els.banner.classList.add('hidden');
  els.banner.textContent = '';
}

function setBanner(text, kind = 'warn') {
  els.banner.textContent = text;
  els.banner.classList.remove('hidden', 'ok', 'warn');
  els.banner.classList.add(kind);
}

function setStatus(text) {
  els.status.textContent = text;
}

function formatSceneClock(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
  }
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

/** Absolute movie range for the active scene, or 0→duration for per-clip fallback. */
function sceneWindow(scene = selected) {
  if (!scene) return null;
  if (mode === 'ffmpeg' && els.video.dataset.srcAttached !== '1') {
    const dur = Number.isFinite(els.video.duration) && els.video.duration > 0
      ? els.video.duration
      : scene.lengthSeconds;
    return { start: 0, end: dur, duration: dur, absolute: false };
  }
  const start = scene.startSeconds;
  const end = Math.max(start + 0.05, scene.endSeconds);
  return { start, end, duration: end - start, absolute: true };
}

function setScrubPlaying(isPlaying) {
  if (!els.scrubPlay) return;
  els.scrubPlay.textContent = isPlaying ? '❚❚' : '▶';
}

function syncScrubFromTime(absoluteTime) {
  const win = sceneWindow();
  if (!win || !els.scrub) return;
  const rel = Math.min(win.duration, Math.max(0, absoluteTime - win.start));
  const pct = win.duration > 0 ? rel / win.duration : 0;
  if (!scrubbing) {
    els.scrub.value = String(Math.round(pct * 1000));
  }
  els.scrubCur.textContent = formatSceneClock(rel);
  els.scrubEnd.textContent = formatSceneClock(win.duration);
  // Fill track visually via CSS variable
  els.scrub.style.setProperty('--pct', `${(pct * 100).toFixed(2)}%`);
}

function showSceneScrub(scene) {
  if (!els.scrubWrap) return;
  if (!scene) {
    els.scrubWrap.hidden = true;
    return;
  }
  els.scrubWrap.hidden = false;
  const win = sceneWindow(scene);
  els.scrubEnd.textContent = formatSceneClock(win.duration);
  els.scrub.disabled = false;
  syncScrubFromTime(win.start);
  setScrubPlaying(false);
}

function clampSceneTime(t, scene = selected) {
  const win = sceneWindow(scene);
  if (!win) return t;
  // Keep a tiny epsilon before end so loop/end watcher still fires cleanly
  return Math.min(win.end - 0.04, Math.max(win.start, t));
}

async function seekWithinScene(pct, { playAfter = false } = {}) {
  if (!selected) return;
  const win = sceneWindow();
  if (!win) return;
  const target = clampSceneTime(win.start + pct * win.duration);

  // Scrubbing always uses the HTML video path on the shared movie file
  if (movieReady || mode === 'html-video' || mode === 'mediabunny') {
    // Cancel MediaBunny canvas playback if any
    const wasPlaying = !els.video.paused && !els.video.ended;
    playToken += 1;
    for (const src of scheduledSources) {
      try { src.stop(); } catch {}
    }
    scheduledSources = [];
    if (endWatcher) {
      clearInterval(endWatcher);
      endWatcher = null;
    }

    ensureVideoSource();
    els.canvas.classList.add('hidden');
    els.video.classList.remove('hidden');
    els.overlay.classList.add('playing');
    els.overlay.textContent = '';

    if (els.video.readyState < 1) {
      await new Promise((resolve) => {
        els.video.addEventListener('loadedmetadata', resolve, { once: true });
      });
    }
    await waitForVideoSeek(els.video, target);
    syncScrubFromTime(els.video.currentTime);

    if (playAfter || wasPlaying) {
      // Resume scene-bounded playback from the scrubbed point
      await playWithHtmlVideoFrom(selected, target);
    } else {
      els.video.pause();
      setScrubPlaying(false);
    }
    return;
  }

  // ffmpeg per-scene clip fallback
  if (els.video.readyState < 1) {
    await new Promise((resolve) => {
      els.video.addEventListener('loadedmetadata', resolve, { once: true });
    });
  }
  await waitForVideoSeek(els.video, target);
  syncScrubFromTime(els.video.currentTime);
  if (playAfter) {
    els.video.play().catch(() => {});
    setScrubPlaying(true);
  }
}

async function playWithHtmlVideoFrom(scene, fromTime) {
  const token = ++playToken;
  ensureVideoSource();
  els.canvas.classList.add('hidden');
  els.video.classList.remove('hidden');
  els.overlay.classList.add('playing');
  els.overlay.textContent = '';
  els.video.loop = false;

  if (els.video.readyState < 1) {
    await new Promise((resolve) => {
      els.video.addEventListener('loadedmetadata', resolve, { once: true });
    });
  }
  const startAt = clampSceneTime(fromTime ?? scene.startSeconds, scene);
  await waitForVideoSeek(els.video, startAt);
  if (token !== playToken) return;

  const end = scene.endSeconds;
  const onTick = () => {
    if (token !== playToken) return;
    syncScrubFromTime(els.video.currentTime);
    if (els.video.currentTime >= end - 0.04) {
      if (els.loop.checked) {
        els.video.currentTime = scene.startSeconds;
        syncScrubFromTime(scene.startSeconds);
      } else {
        els.video.pause();
        els.overlay.classList.remove('playing');
        els.overlay.textContent = `Scene ${scene.number} ended`;
        els.video.ontimeupdate = null;
        syncScrubFromTime(end);
        setScrubPlaying(false);
      }
    }
  };
  els.video.ontimeupdate = onTick;
  try {
    await els.video.play();
    setScrubPlaying(true);
    setStatus(`Playing scene ${scene.number}`);
  } catch (err) {
    setScrubPlaying(false);
    setStatus('Play failed');
    els.overlay.classList.remove('playing');
    els.overlay.textContent = String(err.message || err);
  }
}


function stopPlayback() {
  playToken += 1;
  if (endWatcher) {
    clearInterval(endWatcher);
    endWatcher = null;
  }
  for (const src of scheduledSources) {
    try { src.stop(); } catch {}
  }
  scheduledSources = [];
  els.video.pause();
  els.video.ontimeupdate = null;
  els.video.onended = null;
  els.overlay.classList.remove('playing');
  els.overlay.textContent = selected ? `Scene ${selected.number}` : 'Select a scene';
  setScrubPlaying(false);
  if (selected) syncScrubFromTime(els.video.currentTime || selected.startSeconds);
}

function ensureVideoSource() {
  if (els.video.dataset.srcAttached === '1') return;
  els.video.src = MOVIE_URL;
  els.video.preload = 'auto';
  els.video.dataset.srcAttached = '1';
}

async function waitForVideoSeek(video, t) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('Seek failed'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    try {
      video.currentTime = Math.max(0, t);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function initMediaBunny() {
  setStatus('Opening movie with MediaBunny…');
  input = new Input({
    source: new UrlSource(MOVIE_URL),
    formats: ALL_FORMATS,
  });
  videoTrack = await input.getPrimaryVideoTrack();
  audioTrack = await input.getPrimaryAudioTrack();
  if (!videoTrack) throw new Error('No video track');

  const codec = videoTrack.codec || '';
  const can = await videoTrack.canDecode();
  movieReady = true;
  ensureVideoSource();

  if (can) {
    mode = 'mediabunny';
    canvasSink = new CanvasSink(videoTrack, { width: 320, poolSize: 2 });
    hideBanner();
    setStatus(`MediaBunny · ${codec || 'h264'} · seek scenes in one file`);
    return;
  }

  // H.264 should decode, but if WebCodecs can't, HTML video can still seek the same file
  mode = 'html-video';
  hideBanner();
  setStatus(`HTML video seek · ${codec || 'unknown'} (MediaBunny canDecode=false)`);
}

async function loadThumb(img, scene) {
  if (img.dataset.loaded === '1') return;
  img.dataset.loaded = '1';
  if (canvasSink) {
    try {
      const t = scene.startSeconds + Math.min(0.4, scene.lengthSeconds / 3);
      const wrapped = await canvasSink.getCanvas(t);
      if (!wrapped) throw new Error('no canvas');
      img.src = wrapped.canvas.toDataURL('image/jpeg', 0.82);
      return;
    } catch (err) {
      console.warn('CanvasSink thumb failed', err);
    }
  }
  // Server thumb from the same browser MP4 (or source while encoding)
  img.src = `/api/thumb/${thumbShotNumber(scene)}.jpg`;
}

function observeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target;
        const n = Number(img.dataset.scene);
        const scene = scenes.find((s) => s.number === n);
        if (scene) loadThumb(img, scene);
        thumbObserver.unobserve(img);
      }
    },
    { root: els.list.parentElement, rootMargin: '240px' },
  );
  for (const img of els.list.querySelectorAll('img[data-scene]')) {
    thumbObserver.observe(img);
  }
}

function renderList() {
  const q = els.filter.value.trim().toLowerCase();
  filtered = scenes.filter((s) => {
    if (!q) return true;
    return (
      String(s.number).includes(q) ||
      s.startTimecode.includes(q) ||
      s.endTimecode.includes(q) ||
      String(s.lengthSeconds).includes(q)
    );
  });
  els.list.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const s of filtered) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'card' + (selected && selected.number === s.number ? ' active' : '');
    btn.dataset.number = String(s.number);
    btn.innerHTML = `
      <div class="thumb">
        <div class="ph">…</div>
        <img data-scene="${s.number}" alt="" loading="lazy" />
      </div>
      <div class="info">
        <div class="num">${sceneMode === 'clip' ? 'Scene' : 'Cut'} ${s.number}</div>
        <div class="tc">${s.startTimecode} → ${s.endTimecode}</div>
        <div class="len">${s.lengthSeconds.toFixed(3)}s${s.lengthFrames ? ` · ${s.lengthFrames}f` : ''}</div>
        ${Array.isArray(s.shotNumbers) && s.shotNumbers.length > 1
          ? `<div class="shots">${s.shotNumbers.length} cuts · #${s.shotNumbers[0]}–${s.shotNumbers[s.shotNumbers.length - 1]}</div>`
          : ''}
      </div>`;
    btn.addEventListener('click', () => selectScene(s.number, { play: false }));
    frag.appendChild(btn);
  }
  els.list.appendChild(frag);
  observeThumbs();
}

function updateMeta() {
  if (!selected) {
    els.title.textContent = '—';
    els.times.textContent = '';
    return;
  }
  const label = sceneMode === 'clip' ? 'Scene' : 'Cut';
  const shots = Array.isArray(selected.shotNumbers) && selected.shotNumbers.length > 1
    ? ` · ${selected.shotNumbers.length} cuts`
    : '';
  els.title.textContent = `${label} ${selected.number}${shots}`;
  els.times.textContent = `${selected.startTimecode} → ${selected.endTimecode}  (${selected.lengthSeconds.toFixed(3)}s)`;
  for (const card of els.list.querySelectorAll('.card')) {
    card.classList.toggle('active', Number(card.dataset.number) === selected.number);
  }
}

async function showStill(scene) {
  // Prefer drawing a still from MediaBunny; otherwise seek HTML video and pause
  if (canvasSink) {
    els.video.classList.add('hidden');
    els.canvas.classList.remove('hidden');
    try {
      const wrapped = await canvasSink.getCanvas(scene.startSeconds);
      if (wrapped) {
        const c = wrapped.canvas;
        // Upscale draw onto preview canvas while keeping aspect
        const targetW = 1280;
        const scale = targetW / c.width;
        els.canvas.width = targetW;
        els.canvas.height = Math.round(c.height * scale);
        ctx.drawImage(c, 0, 0, els.canvas.width, els.canvas.height);
        els.overlay.classList.add('playing');
        return;
      }
    } catch (err) {
      console.warn(err);
    }
  }

  ensureVideoSource();
  els.canvas.classList.add('hidden');
  els.video.classList.remove('hidden');
  els.video.pause();
  try {
    if (els.video.readyState < 1) {
      await new Promise((resolve) => {
        els.video.addEventListener('loadedmetadata', resolve, { once: true });
      });
    }
    await waitForVideoSeek(els.video, scene.startSeconds);
  } catch (err) {
    console.warn(err);
  }
}

async function playWithMediaBunny(scene) {
  const token = ++playToken;
  els.video.classList.add('hidden');
  els.canvas.classList.remove('hidden');
  els.overlay.classList.add('playing');
  els.overlay.textContent = '';

  const vSink = new VideoSampleSink(videoTrack);
  let aSink = null;
  if (audioTrack && (await audioTrack.canDecode())) {
    aSink = new AudioBufferSink(audioTrack);
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  }

  const start = scene.startSeconds;
  const end = scene.endSeconds;
  const t0 = performance.now();

  if (aSink) {
    const base = audioCtx.currentTime + 0.05;
    (async () => {
      try {
        for await (const { buffer, timestamp } of aSink.buffers(start, end)) {
          if (token !== playToken) break;
          const src = audioCtx.createBufferSource();
          src.buffer = buffer;
          src.connect(audioCtx.destination);
          const when = base + (timestamp - start);
          src.start(Math.max(audioCtx.currentTime, when));
          scheduledSources.push(src);
        }
      } catch (err) {
        console.warn('audio', err);
      }
    })();
  }

  for await (const sample of vSink.samples(start, end)) {
    if (token !== playToken) {
      sample.close();
      break;
    }
    const target = (sample.timestamp - start) * 1000;
    const wait = target - (performance.now() - t0);
    if (wait > 2) await new Promise((r) => setTimeout(r, wait));
    if (token !== playToken) {
      sample.close();
      break;
    }
    const w = sample.displayWidth || sample.codedWidth;
    const h = sample.displayHeight || sample.codedHeight;
    if (els.canvas.width !== w || els.canvas.height !== h) {
      els.canvas.width = w;
      els.canvas.height = h;
    }
    sample.draw(ctx, 0, 0);
    sample.close();
  }

  if (token === playToken) {
    if (els.loop.checked) playScene();
    else {
      els.overlay.classList.remove('playing');
      els.overlay.textContent = `Scene ${scene.number} ended`;
    }
  }
}

async function playWithHtmlVideo(scene) {
  await playWithHtmlVideoFrom(scene, scene.startSeconds);
}

async function playScene() {
  if (!selected) return;
  stopPlayback();
  // Prefer HTML video seek on the shared MP4 (snappy A/V). MediaBunny still owns thumbs
  // and can optionally drive canvas playback if HTML video isn't available.
  if (movieReady) {
    playWithHtmlVideo(selected);
  } else if (mode === 'mediabunny' && videoTrack) {
    playWithMediaBunny(selected);
  } else {
    // Last-resort emergency: per-scene ffmpeg clip
    mode = 'ffmpeg';
    els.canvas.classList.add('hidden');
    els.video.classList.remove('hidden');
    els.video.dataset.srcAttached = '0';
    els.video.src = `/api/scene/${selected.number}.mp4`;
    els.video.loop = els.loop.checked;
    els.video.play().catch(() => {});
  }
}

async function selectScene(number, { play = false } = {}) {
  const scene = scenes.find((s) => s.number === number);
  if (!scene) return;
  selected = scene;
  updateMeta();
  stopPlayback();
  showSceneScrub(scene);
  els.overlay.textContent = `Scene ${scene.number}`;
  await showStill(scene);
  syncScrubFromTime(scene.startSeconds);
  const idx = scenes.findIndex((s) => s.number === number);
  for (const n of [idx - 1, idx + 1]) {
    if (n >= 0 && n < scenes.length && canvasSink) {
      // warm neighbor thumbs via MediaBunny lazily through observer
    }
  }
  const card = els.list.querySelector(`.card[data-number="${number}"]`);
  if (card) card.scrollIntoView({ block: 'nearest' });
  if (play) playScene();
}

function neighbor(delta) {
  if (!selected) {
    if (filtered.length) selectScene(filtered[0].number);
    return;
  }
  const idx = filtered.findIndex((s) => s.number === selected.number);
  const next = filtered[idx + delta];
  if (next) selectScene(next.number);
}

els.prev.addEventListener('click', () => neighbor(-1));
els.next.addEventListener('click', () => neighbor(1));
els.play.addEventListener('click', () => playScene());
els.stop.addEventListener('click', () => stopPlayback());
els.filter.addEventListener('input', () => renderList());
els.loop.addEventListener('change', () => {
  els.video.loop = false; // scene looping handled manually
});

els.scrub.addEventListener('pointerdown', () => {
  scrubbing = true;
  // Freeze scene-end watcher while dragging so it doesn't fight the scrub
  els.video.ontimeupdate = null;
});
els.scrub.addEventListener('pointerup', () => { scrubbing = false; });
els.scrub.addEventListener('pointercancel', () => { scrubbing = false; });
els.scrub.addEventListener('input', () => {
  const win = sceneWindow();
  if (!win) return;
  const pct = Number(els.scrub.value) / 1000;
  const rel = pct * win.duration;
  els.scrubCur.textContent = formatSceneClock(rel);
  els.scrub.style.setProperty('--pct', `${(pct * 100).toFixed(2)}%`);
  // Live-seek while dragging (throttled via rAF)
  if (scrubRaf) cancelAnimationFrame(scrubRaf);
  scrubRaf = requestAnimationFrame(() => {
    scrubRaf = 0;
    const t = clampSceneTime(win.start + rel);
    if (movieReady || mode === 'html-video' || mode === 'mediabunny') {
      ensureVideoSource();
      els.canvas.classList.add('hidden');
      els.video.classList.remove('hidden');
      try { els.video.currentTime = t; } catch {}
    } else {
      try { els.video.currentTime = t; } catch {}
    }
  });
});
els.scrub.addEventListener('change', async () => {
  scrubbing = false;
  const pct = Number(els.scrub.value) / 1000;
  const resume = !els.video.paused;
  await seekWithinScene(pct, { playAfter: resume });
});

els.scrubPlay.addEventListener('click', async () => {
  if (!selected) return;
  if (!els.video.paused && els.video.dataset.srcAttached === '1' && !els.video.classList.contains('hidden')) {
    // Pause in-place within the scene
    els.video.pause();
    setScrubPlaying(false);
    return;
  }
  // If already sitting inside the scene on the HTML video, resume from there
  const win = sceneWindow();
  if (
    win &&
    movieReady &&
    els.video.dataset.srcAttached === '1' &&
    !els.video.classList.contains('hidden') &&
    els.video.currentTime >= win.start - 0.05 &&
    els.video.currentTime < win.end - 0.05
  ) {
    await playWithHtmlVideoFrom(selected, els.video.currentTime);
    return;
  }
  playScene();
});

window.addEventListener('keydown', (e) => {
  if (e.target === els.filter) return;
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault();
    neighbor(1);
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    neighbor(-1);
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    playScene();
  } else if (e.key === 'Escape') {
    stopPlayback();
  }
});

async function waitForBrowserMp4(maxMs = 0) {
  // Optional: poll /api/status while encoding. UI works once MP4 is ready.
  const start = Date.now();
  while (true) {
    try {
      const res = await fetch('/api/status');
      const st = await res.json();
      if (st.browserMp4Ready) return st;
      setStatus(`Transcoding browser MP4… ${(st.movieBytes / 1e6).toFixed(0)} MB source`);
    } catch {
      /* ignore */
    }
    if (maxMs && Date.now() - start > maxMs) return null;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function syncModeButtons() {
  if (els.modeClip) els.modeClip.classList.toggle('active', sceneMode === 'clip');
  if (els.modeCuts) els.modeCuts.classList.toggle('active', sceneMode === 'cuts');
}

async function loadScenes(mode) {
  const want = mode || sceneMode || 'clip';
  const res = await fetch(`/api/scenes?mode=${encodeURIComponent(want)}`);
  const data = await res.json();
  sceneMode = data.mode === 'clip' ? 'clip' : 'cuts';
  scenes = data.scenes || [];
  metaExtra = data;
  syncModeButtons();
  const label = sceneMode === 'clip' ? 'CLIP scenes' : 'cuts';
  let status = `${scenes.length} ${label}`;
  if (sceneMode === 'clip' && data.cutCount) status += ` ← ${data.cutCount} cuts`;
  if (sceneMode === 'cuts' && data.clipReady === false) status += ' · CLIP not ready';
  setStatus(status);
  selected = null;
  stopPlayback();
  renderList();
  if (scenes.length) await selectScene(scenes[0].number);
  return data;
}

async function setSceneMode(mode) {
  if (mode === sceneMode && scenes.length) return;
  stopPlayback();
  await loadScenes(mode);
}

if (els.modeClip) els.modeClip.addEventListener('click', () => setSceneMode('clip'));
if (els.modeCuts) els.modeCuts.addEventListener('click', () => setSceneMode('cuts'));

async function main() {
  const data = await loadScenes(sceneMode);

  if (data.movieKind !== 'browser-mp4') {
    setBanner(
      'Browser MP4 is still encoding. The page will use the compressed H.264 file as soon as it’s ready (no per-scene downloads).',
      'warn',
    );
    // Poll until ready, then reload movie pipeline
    waitForBrowserMp4().then(async () => {
      hideBanner();
      try {
        await initMediaBunny();
        if (selected) await showStill(selected);
      } catch (err) {
        console.error(err);
        setBanner(`Failed to open browser MP4: ${err.message}`, 'warn');
      }
    });
    // Don't open HEVC with MediaBunny as primary — wait for MP4
    return;
  }

  try {
    await initMediaBunny();
  } catch (err) {
    console.error(err);
    mode = 'html-video';
    ensureVideoSource();
    movieReady = true;
    hideBanner();
    setStatus('HTML video seek (MediaBunny open failed)');
  }
}

main().catch((err) => {
  setBanner(String(err.message || err), 'warn');
  setStatus('Failed');
});

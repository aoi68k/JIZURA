/* ============================================================
   JIZURA spotify-view — what Spotify plays, drawn as a JIZURA lyric video
   bridge (spotify/bridge): /api/now (track + position), /api/lyrics (LRCLIB), /jizura.js (engine)
   ============================================================ */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const HUD_CHARS = '0123456789:./-_()【】・No.LYRICRECUNTITLEDXYlinebpminterlude—─／ ';
const LS_KEY = 'jizura.spotify.v1';
const POLL_MS = 500;

const prefs = Object.assign({ style: 'auto', aspect: '16:9', offset: 0, bg: 'fx' }, (() => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } })());
const savePrefs = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) {} };
const URLQ = new URLSearchParams(location.search);
const isObs = URLQ.has('obs') || URLQ.get('hud') === '0' || typeof window.obsStudio !== 'undefined';
if (URLQ.has('obs')) prefs.bg = 'clear';
if (URLQ.get('bg') === 'clear' || URLQ.get('bg') === 'fx') prefs.bg = URLQ.get('bg');   // ?bg=clear: an OBS source URL that is always transparent

const S = {
  found: false, key: null, info: null, lyr: null,       // current track, its synced LRC (or null)
  anchorPos: 0, anchorAt: 0, playing: false, rate: 1,   // playback clock: position at anchorAt (performance.now)
  plan: null, renderer: new J.Renderer(), reroll: {},
  loadGen: 0, buildGen: 0, need: true, lastT: -1, slow: false,
  localAudio: null, localAudioName: null,               // local audio element if playing local file
};

/* ---------- deterministic randomness per song (same song → same look, until 別の演出) ---------- */
const mulberry = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/* ---------- LRCLIB LRC → JIZURA lyrics ----------
   - JIZURA markup characters in the lyric text are swapped for full-width ones so the words stay as sung
     ( / chunk split, * emphasis, | note, trailing ! impact, leading # comment )
   - an empty / ♪ line with room after it, or a long gap after a line, becomes [間奏] (background + decorations) */
const tag = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = t - m * 60; return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`; };
const escapeMarkup = s => s.replace(/\//g, '／').replace(/\|/g, '｜').replace(/\*/g, '＊').replace(/!$/, '！').replace(/^#/, '＃');
const isCredit = s => /^(作[詞词]|作[曲]|編[曲]|編曲|Mix|Master|Produced|Lyricist|Composer|Arranger|純音楽|纯音乐)\s*[:：]/i.test(s.trim());

function toJizuraLyrics(lrc, duration) {
  const text = String(lrc || '').replace(/\r/g, '');
  const off = text.match(/^\[offset:\s*([+-]?\d+)\s*\]/im);
  const shift = off ? -(+off[1]) / 1000 : 0;               // LRC: a positive offset shows the lyrics earlier
  const rows = [];
  for (const raw of text.split('\n')) {
    const m = raw.trim().match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/);
    if (!m) continue;
    const body = m[2].trim();
    if (isCredit(body)) continue;
    for (const x of m[1].matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)) rows.push({ t: +x[1] * 60 + parseFloat(x[2].replace(':', '.')) + shift, text: body });
  }
  rows.sort((a, b) => a.t - b.t);
  const out = [];
  if (rows.length > 0 && rows[0].t >= 3.5) {
    out.push('[00:00.00][間奏]');
  }
  rows.forEach((r, i) => {
    const next = rows[i + 1] ? rows[i + 1].t : (duration > 0 ? duration : r.t + 8);
    if (!r.text || /^[♪♫♬\s]+$/.test(r.text)) { if (next - r.t >= 4) out.push(tag(r.t) + '[間奏]'); return; }
    out.push(tag(r.t) + escapeMarkup(r.text));
    const rest = J.clamp(0.8 + [...r.text].length * 0.17, 1.3, 5.2) + 1.5;
    if (next - r.t > rest + 4) out.push(tag(r.t + rest) + '[間奏]');
  });
  return out.join('\n');
}

function plainToLrc(plain, duration) {
  const rawLines = String(plain || '').replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean);
  const lines = rawLines.filter(l => !isCredit(l) && !l.startsWith('#'));
  if (!lines.length) return '';
  const dur = duration > 30 ? duration : Math.max(30, lines.length * 4);
  const intro = Math.min(12, Math.max(3, dur * 0.08));
  const outro = Math.min(15, Math.max(4, dur * 0.08));
  const vocalTime = Math.max(10, dur - intro - outro);
  const weights = lines.map(l => Math.max(1.5, Math.sqrt([...l].length) * 1.2));
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
  let curT = intro;
  const out = [];
  if (intro >= 3) out.push('[00:00.00][間奏]');
  for (let i = 0; i < lines.length; i++) {
    out.push(tag(curT) + escapeMarkup(lines[i]));
    curT += (weights[i] / totalWeight) * vocalTime;
  }
  return out.join('\n');
}

/* ---------- plan ---------- */
async function rebuild() {
  const gen = ++S.buildGen, info = S.info;
  if (!info) return;
  const P = J.defaultProject();
  const seed = (J.sid(S.key) + (S.reroll[S.key] | 0) * 7919) >>> 0;
  P.seed = seed;
  if (prefs.style === 'auto') {
    // 透明: only styles made for a dark background (light lyrics) — dark ink would vanish over most video
    const dark = k => J.lum((J.STYLES[k].schemes[0] || {}).bg || '#000') < 0.45;
    let r = null;
    for (let i = 0; i < 24; i++) { r = J.omakase(P, mulberry(seed + i * 104729)); if (prefs.bg !== 'clear' || dark(r.style)) break; }
    Object.assign(P, r);
  }
  else { P.style = J.STYLES[prefs.style] ? prefs.style : 'noir'; P.seed = Math.floor(mulberry(seed)() * 1e9); }
  P.title = info.title || ''; P.artist = info.artist || '';
  P.aspect = prefs.aspect;
  P.lyrics = (S.lyr && toJizuraLyrics(S.lyr, info.duration)) || '[00:00.00][間奏]';   // no synced lyrics: title over the background
  const audio = { duration: info.duration > 0 ? info.duration : 0, beats: [] };
  let plan = J.plan(P, audio);
  try { await J.ensureFonts(P.lyrics + P.title + P.artist + HUD_CHARS, J.fontsOfPlan(plan)); } catch (e) {}
  if (gen !== S.buildGen) return;
  plan = J.plan(P, audio);                                 // again, measured with the real faces
  S.plan = plan; S.need = true;
  sizeCanvas();
}

/* ---------- now playing ---------- */
function clock() {
  if (S.localAudio) return S.localAudio.currentTime;
  return S.anchorPos + (S.playing ? (performance.now() - S.anchorAt) / 1000 * S.rate : 0);
}
async function poll() {
  if (S.localAudio) return;                                 // local audio playback is active
  const t0 = performance.now();
  let r;
  try { r = await (await fetch('/api/now', { cache: 'no-store' })).json(); }
  catch (e) { goIdle('ブリッジに接続できません（JizuraSpotify を起動してください）'); return; }
  const mid = (t0 + performance.now()) / 2;                 // the server read the position about here
  if (!r.found) { goIdle(r.error || 'Windows 版 Spotify で曲を再生してください'); return; }
  const key = [r.title, r.artist, r.album, Math.round(r.duration)].join('\n');
  const predicted = S.anchorPos + (S.playing ? (mid - S.anchorAt) / 1000 * S.rate : 0);
  if (key !== S.key || r.playing !== S.playing || !S.found || Math.abs(r.position - predicted) > 0.3) { S.anchorPos = r.position; S.anchorAt = mid; }
  else if (r.playing) { S.anchorPos = predicted + (r.position - predicted) * 0.15; S.anchorAt = mid; }   // ease out small jitter
  S.playing = r.playing; S.rate = r.rate || 1; S.need = true;
  if (!S.found) { S.found = true; document.body.classList.add('live'); }
  if (key !== S.key) { S.key = key; S.info = r; loadTrack(false); }
}
function goIdle(msg) {
  $('idleMsg').textContent = msg;
  if (!S.found && S.key === null) return;
  S.found = false; S.key = null; S.info = null; S.lyr = null; S.plan = null; S.playing = false; ++S.loadGen; ++S.buildGen;
  document.body.classList.remove('live');
  $('tTitle').textContent = '—'; $('tArtist').textContent = ''; setStatus(msg);
  const c = $('view'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
}
async function loop() { await poll(); setTimeout(loop, POLL_MS); }

function stopLocalAudio() {
  if (!S.localAudio) return;
  try { S.localAudio.pause(); URL.revokeObjectURL(S.localAudio.src); } catch (e) {}
  S.localAudio = null;
  S.localAudioName = null;
  S.manualLrc = false;
  S.found = false; S.key = null; S.info = null; S.lyr = null;
  setStatus('ローカル再生を終了しました。Spotify に復帰します');
  poll();
}

function loadLocalAudio(file) {
  if (!file) return;
  if (S.localAudio) {
    try { S.localAudio.pause(); URL.revokeObjectURL(S.localAudio.src); } catch (e) {}
    S.localAudio = null;
  }
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  S.localAudio = audio;
  S.localAudioName = file.name;

  const rawName = file.name.replace(/\.[^.]+$/, '');
  let title = rawName, artist = 'ローカル音源';
  if (rawName.includes(' - ')) {
    const parts = rawName.split(' - ');
    artist = parts[0].trim();
    title = parts.slice(1).join(' - ').trim();
  }

  const startPlayback = () => {
    const dur = audio.duration || 0;
    const key = `local:${file.name}:${Math.round(dur)}`;
    S.found = true;
    S.key = key;
    S.info = { title, artist, album: 'Local', duration: dur, playing: true, rate: 1, position: 0 };
    S.playing = true;
    S.rate = 1;
    document.body.classList.add('live');
    $('tTitle').textContent = title;
    $('tArtist').textContent = artist;
    document.title = `${title} — JIZURA spotify-view`;
    setStatus(`ローカル楽曲再生中 · ${file.name}（Space: 再生/一時停止, Esc: 終了）`);
    if (!S.manualLrc) {
      loadTrack(false);
    } else {
      rebuild();
    }
    audio.play().catch(() => {});
  };

  if (audio.readyState >= 1) {
    startPlayback();
  } else {
    audio.addEventListener('loadedmetadata', startPlayback, { once: true });
  }

  audio.addEventListener('play', () => { S.playing = true; S.need = true; });
  audio.addEventListener('pause', () => { S.playing = false; S.need = true; });
  audio.addEventListener('timeupdate', () => { S.need = true; });
  audio.addEventListener('ended', () => {
    S.playing = false;
    S.need = true;
    setStatus(`再生終了 · ${file.name}（Space: 再開）`);
  });
}

function loadLocalLrc(text, name) {
  if (!text || !text.trim()) return;
  const hasTags = /\[\d{2}:\d{2}/.test(text);
  S.lyr = hasTags ? text : plainToLrc(text, (S.info && S.info.duration) || 0);
  S.manualLrc = true;
  setStatus(`手持ち歌詞 · ${name || (hasTags ? 'LRC' : 'テキスト')}`);
  rebuild();
}

async function loadTrack(refresh) {
  const gen = ++S.loadGen, info = S.info;
  $('tTitle').textContent = info.title || '—'; $('tArtist').textContent = info.artist || '';
  document.title = `${info.title} — JIZURA spotify-view`;
  if (S.manualLrc && !refresh) return;
  S.manualLrc = false;
  S.lyr = null; setStatus('LRCLIB から歌詞を取得中…');
  rebuild();                                                // the title card while the lyrics load
  try {
    const q = new URLSearchParams({ title: info.title, artist: info.artist, album: info.album, duration: String(info.duration || 0) });
    if (refresh) q.set('refresh', '1');
    const r = await (await fetch('/api/lyrics?' + q, { cache: 'no-store' })).json();
    if (gen !== S.loadGen) return;
    if (r.error) throw new Error(r.error);
    if (r.synced && r.synced.trim()) {
      S.lyr = r.synced;
      setStatus('同期歌詞 · LRCLIB');
    } else if (r.plain && r.plain.trim()) {
      S.lyr = plainToLrc(r.plain, info.duration);
      setStatus('通常歌詞（自動配分） · LRCLIB');
    } else if (r.instrumental) {
      setStatus('インストゥルメンタル');
    } else {
      setStatus('歌詞が見つかりません（手持ちのLRCを読込可能）');
    }
  } catch (e) {
    if (gen === S.loadGen) {
      const msg = e.message.includes('503') || e.message.includes('ServerOverloaded')
        ? 'LRCLIB 混雑中 (503)。少し待って「再取得」または LRC をドロップしてください'
        : '歌詞の取得: ' + e.message;
      setStatus(msg);
    }
  }
  if (gen === S.loadGen) rebuild();
}
function setStatus(s) { $('status').textContent = s; }

/* ---------- drawing ---------- */
function sizeCanvas() {
  const c = $('view');
  const [W, H] = S.plan ? [S.plan.W, S.plan.H] : J.designSize(prefs.aspect);
  const ar = W / H;
  let cssW = window.innerWidth, cssH = cssW / ar;
  if (cssH > window.innerHeight) { cssH = window.innerHeight; cssW = cssH * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.max(2, Math.round(Math.min(W, cssW * dpr))), ph = Math.max(2, Math.round(pw / ar));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
  S.need = true;
}
function tick() {
  requestAnimationFrame(tick);
  if (!S.plan || !S.found) return;
  const t = Math.max(0, clock() - prefs.offset);            // + offset = lyrics later
  const f = Math.floor(t * (S.plan.fps || 24));             // JIZURA moves on a 24 fps timebase: no need to redraw in between
  if (!S.need && f === S.lastT) return;
  const c = $('view'), ctx = c.getContext('2d');
  const t0 = performance.now();
  try { S.renderer.frame(ctx, S.plan, Math.min(t, S.plan.duration), { scale: c.width / S.plan.W, fast: S.playing && S.slow, transparent: prefs.bg === 'clear' }); }
  catch (e) { console.warn(e); }
  const dt = performance.now() - t0;
  S.slow = S.playing ? (dt > 30 ? true : dt < 14 ? false : S.slow) : false;
  S.lastT = f; S.need = false;
}

/* ---------- controls ---------- */
function initControls() {
  const sel = $('style');
  sel.add(new Option('おまかせ（曲ごと）', 'auto'));
  for (const k of J.STYLE_ORDER) if (J.STYLES[k]) sel.add(new Option(J.STYLES[k].name, k));
  sel.value = J.STYLES[prefs.style] || prefs.style === 'auto' ? prefs.style : 'auto';
  sel.addEventListener('change', () => { prefs.style = sel.value; savePrefs(); rebuild(); });
  const asp = $('aspect');
  asp.value = prefs.aspect;
  asp.addEventListener('change', () => { prefs.aspect = asp.value; savePrefs(); rebuild(); });
  const bg = $('bg');
  const applyBg = () => { document.documentElement.classList.toggle('clear', prefs.bg === 'clear'); S.need = true; };
  bg.value = prefs.bg; applyBg();
  bg.addEventListener('change', () => { prefs.bg = bg.value; savePrefs(); applyBg(); if (prefs.style === 'auto') rebuild(); });
  const showOff = () => { $('offVal').textContent = (prefs.offset > 0 ? '+' : '') + prefs.offset.toFixed(1) + 's'; };
  const nudge = d => { prefs.offset = Math.round(J.clamp(prefs.offset + d, -10, 10) * 10) / 10; savePrefs(); showOff(); S.need = true; };
  showOff();
  $('offMinus').addEventListener('click', () => nudge(-0.1));
  $('offPlus').addEventListener('click', () => nudge(0.1));
  const reroll = () => { if (!S.key) return; S.reroll[S.key] = (S.reroll[S.key] | 0) + 1; rebuild(); };
  $('reroll').addEventListener('click', reroll);
  $('reload').addEventListener('click', () => { if (S.info) loadTrack(true); });
  const fileAudio = $('fileAudio'), openAudio = $('openAudio');
  if (openAudio && fileAudio) {
    openAudio.addEventListener('click', () => fileAudio.click());
    fileAudio.addEventListener('change', e => {
      const file = e.target.files && e.target.files[0];
      if (file) loadLocalAudio(file);
      fileAudio.value = '';
    });
  }
  const fileLrc = $('fileLrc'), openLrc = $('openLrc');
  if (openLrc && fileLrc) {
    openLrc.addEventListener('click', () => fileLrc.click());
    fileLrc.addEventListener('change', async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try { loadLocalLrc(await file.text(), file.name); } catch (err) { setStatus('ファイルを読み込めませんでした'); }
      fileLrc.value = '';
    });
  }
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', async e => {
    e.preventDefault();
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (/\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(file.name)) {
      loadLocalAudio(file);
    } else if (/\.(lrc|txt)$/i.test(file.name)) {
      try { loadLocalLrc(await file.text(), file.name); } catch (err) { setStatus('ファイルを読み込めませんでした'); }
    }
  });
  const full = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); };
  $('full').addEventListener('click', full);
  const copyBtn = $('copyObs');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = `${location.origin}/?obs`;
      try {
        await navigator.clipboard.writeText(url);
        const prev = copyBtn.textContent;
        copyBtn.textContent = 'コピー完了!';
        setTimeout(() => { copyBtn.textContent = prev; }, 2000);
      } catch (e) {
        prompt('OBSのブラウザソースにこのURLを指定してください:', url);
      }
    });
  }
  window.addEventListener('keydown', e => {
    if (e.target && /^(SELECT|INPUT)$/.test(e.target.tagName)) return;
    if (e.code === 'Space' || e.key === ' ') {
      if (S.localAudio) {
        if (S.localAudio.paused) S.localAudio.play().catch(() => {});
        else S.localAudio.pause();
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Escape') {
      if (S.localAudio) {
        stopLocalAudio();
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'f' || e.key === 'F') full();
    else if (e.key === 'r' || e.key === 'R') reroll();
    else if (e.key === 'ArrowLeft') nudge(-0.1);
    else if (e.key === 'ArrowRight') nudge(0.1);
    else if (e.key === 'h' || e.key === 'H') { hudPinned = !hudPinned; poke(); }
    else return;
    e.preventDefault();
  });
  // the control bar and cursor fade out after a few idle seconds (OBS / full screen); ?hud=0 keeps it hidden
  let hideTimer = 0, hudPinned = false;
  const noHud = isObs || URLQ.get('hud') === '0';
  document.documentElement.classList.toggle('obs', isObs);   // OBS source: 透明 means nothing behind the lyrics
  const poke = () => {
    clearTimeout(hideTimer);
    if (noHud) { document.body.classList.add('hudOff', 'hideCursor'); return; }
    document.body.classList.remove('hudOff', 'hideCursor');
    if (!hudPinned) hideTimer = setTimeout(() => document.body.classList.add('hudOff', 'hideCursor'), 3000);
  };
  window.addEventListener('mousemove', poke);
  poke();
  window.addEventListener('resize', sizeCanvas);
}

initControls();
sizeCanvas();
requestAnimationFrame(tick);
loop();
J.spotifyView = { S, toJizuraLyrics };                       // for debugging from the console
})();

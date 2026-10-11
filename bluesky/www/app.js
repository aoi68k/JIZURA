/* ============================================================
   JIZURA bluesky-view — Bluesky timeline posts, drawn as a JIZURA lyric video
   ============================================================ */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const LS_KEY = 'jizura.bluesky.v1';
const HUD_CHARS = '0123456789:./-_()【】・No.LYRICRECUNTITLEDXYlinebpminterlude—─／@🦋Bluesky ';

// LocalStorage 設定
const defaultPrefs = {
  style: 'auto',
  aspect: '16:9',
  bg: 'fx',
  pollInterval: 60,
  displayDuration: 12,
  overlayMode: 'both' // both, canvas, card, none
};
const prefs = Object.assign({}, defaultPrefs, (() => {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
})());
const savePrefs = () => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch (e) {}
};

// URL クエリパラメータ
const URLQ = new URLSearchParams(location.search);
if (URLQ.get('bg') === 'clear' || URLQ.get('bg') === 'fx') prefs.bg = URLQ.get('bg');
const isObs = URLQ.get('hud') === '0' || URLQ.has('obs');
if (isObs) {
  document.body.classList.add('hudOff');
  if (prefs.bg === 'clear') document.documentElement.classList.add('obs');
}
if (URLQ.get('card') === '0') document.body.classList.add('cardOff');

// アプリ全体の状態
const S = {
  posts: [],             // 取得した全ポスト
  queue: [],             // これから表示するポストキュー
  history: [],           // 表示済みポスト履歴
  currentPost: null,     // 現在表示中のポスト
  postStartT: 0,         // 現在のポスト再生開始時刻 (performance.now)
  postDuration: 12,      // 現在のポスト表示秒数
  paused: false,         // 一時停止
  pauseAt: 0,            // 一時停止した時刻
  totalPausedMs: 0,      // 一時停止していた総時間

  plan: null,            // JIZURA plan
  renderer: new J.Renderer(),
  reroll: {},            // ポストごとのシード加算
  buildGen: 0,
  loadGen: 0,
  need: true,
  lastT: -1,
  slow: false,

  avatarImg: null,       // 現在のポストのアバター Image オブジェクト
  avatarLoaded: false,

  lastFetchTime: 0,      // 最終取得時刻 (ms)
  nextPollSeconds: 60,   // 次回取得までのカウントダウン
  pollTimerId: null,

  hudTimer: null,
  hudPinned: false
};

// 乱数生成器
const mulberry = seed => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/* ---------- JIZURA 歌詞フォーマッター ----------
   Blueskyの文章を自然なカットとタイミング付き歌詞 [mm:ss.xx]フレーズ に変換 */
const tag = t => {
  t = Math.max(0, t);
  const m = Math.floor(t / 60), s = t - m * 60;
  return `[${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}]`;
};

const escapeMarkup = s => {
  return String(s || '')
    .replace(/\//g, '／')
    .replace(/\|/g, '｜')
    .replace(/\*/g, '＊')
    .replace(/!$/, '！')
    .replace(/^#/, '＃');
};

// URLの省略・整形
function sanitizePostText(raw) {
  let text = String(raw || '').replace(/\r/g, '');
  // URL を [リンク] またはホスト名に短縮
  text = text.replace(/https?:\/\/([^\s/$.?#].[^\s]*)/gi, (match, p1) => {
    try {
      const u = new URL(match);
      return `【${u.hostname}】`;
    } catch (e) {
      return '【リンク】';
    }
  });
  return text.trim();
}

// 文字数に応じた適切な表示秒数を計算（短文なら縮めてテンポ良く、長文ならしっかり読ませる）
function calcPostDuration(text, baseDuration) {
  const len = [...(text || '')].length;
  if (len <= 6) return Math.min(4.5, baseDuration);
  if (len <= 15) return Math.min(5.8, baseDuration);
  if (len <= 30) return Math.min(7.5, baseDuration);
  if (len <= 60) return Math.min(10.0, baseDuration);
  return Math.max(8.0, baseDuration);
}

function postToJizuraLyrics(rawText, totalDuration) {
  const clean = sanitizePostText(rawText);
  if (!clean) return '[00:00.00]（メッセージなし）';

  // 改行や句読点で文を分割
  const rawLines = clean.split('\n').map(l => l.trim()).filter(Boolean);
  const phrases = [];

  for (const line of rawLines) {
    if (line.length <= 18) {
      phrases.push(line);
    } else {
      // 長い行は句読点で分割
      const parts = line.split(/(?<=[。！？!?、])/).map(p => p.trim()).filter(Boolean);
      let buf = '';
      for (const p of parts) {
        if (buf.length + p.length <= 22) {
          buf += p;
        } else {
          if (buf) phrases.push(buf);
          buf = p;
        }
      }
      if (buf) phrases.push(buf);
    }
  }

  if (phrases.length === 0) phrases.push(clean);

  const rows = [];
  const count = phrases.length;

  if (count === 1) {
    // 短い1フレーズの場合: 間を埋めるため、前半は通常、後半は強調・インパクト展開で2カット構成に
    const p = phrases[0];
    const half = Math.max(2.0, totalDuration * 0.45);
    rows.push(tag(0.0) + escapeMarkup(p));
    // 2カット目は強調リフレイン（文字PV演出）
    if (totalDuration >= 4.0 && p.length <= 25) {
      rows.push(tag(half) + '*' + escapeMarkup(p) + '*！');
    }
  } else {
    // 複数フレーズがある場合: 全体の時間に均等に散りばめて間を埋める
    const timeStep = Math.max(1.8, (totalDuration - 1.0) / count);
    let currentT = 0.0;
    for (let i = 0; i < count; i++) {
      rows.push(tag(currentT) + escapeMarkup(phrases[i]));
      currentT += timeStep;
    }
  }

  return rows.join('\n');
}

/* ---------- JIZURA Plan 構築 ---------- */
async function buildPlanForPost(post) {
  const gen = ++S.buildGen;
  if (!post) return;

  const duration = S.postDuration;
  const P = J.defaultProject();

  // シード決定: post.uri / cid からハッシュ生成
  const baseKey = (post.uri || post.cid || post.text);
  const seed = (J.sid(baseKey) + (S.reroll[baseKey] | 0) * 7919) >>> 0;
  P.seed = seed;

  // スタイル選択
  if (prefs.style === 'auto') {
    Object.assign(P, J.omakase(P, mulberry(seed)));
  } else {
    P.style = J.STYLES[prefs.style] ? prefs.style : 'noir';
    P.seed = Math.floor(mulberry(seed)() * 1e9);
  }

  P.title = post.authorName || post.authorHandle || 'Bluesky';
  P.artist = post.authorHandle ? `@${post.authorHandle}` : '';
  P.aspect = prefs.aspect;
  P.hud = true;
  P.lyrics = postToJizuraLyrics(post.text, duration);

  // カットの持続時間を長めに保つ設定（文字がすぐに消えて空白になるのを防ぐ）
  const charLen = [...(post.text || '')].length;
  P.timing = {
    lineScale: charLen <= 20 ? 1.6 : 1.25,
    tail: 0.5
  };

  // 擬似ビート（BPM 120）: キネティックタイポグラフィの動きをリズミカルにする

  const bpm = 120, beatStep = 60 / bpm;
  const beats = [];
  for (let b = 0; b <= duration; b += beatStep) beats.push(b);
  const audio = { duration, beats };

  let plan = J.plan(P, audio);

  // フォントロード
  try {
    const chars = P.lyrics + P.title + P.artist + HUD_CHARS;
    await J.ensureFonts(chars, J.fontsOfPlan(plan));
  } catch (e) {
    console.warn('Font load error:', e);
  }

  if (gen !== S.buildGen) return;

  plan = J.plan(P, audio); // 実際のフォントメトリクスで再計算
  S.plan = plan;
  S.need = true;
  sizeCanvas();
}

/* ---------- アバター画像 & 添付画像の読み込み ---------- */
function loadAvatar(avatarUrl) {
  S.avatarImg = null;
  S.avatarLoaded = false;
  if (!avatarUrl) return;

  const img = new Image();
  img.crossOrigin = 'anonymous';
  const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(avatarUrl)}`;
  img.src = proxyUrl;
  img.onload = () => {
    S.avatarImg = img;
    S.avatarLoaded = true;
    S.need = true;
  };
  img.onerror = () => {
    const directImg = new Image();
    directImg.crossOrigin = 'anonymous';
    directImg.src = avatarUrl;
    directImg.onload = () => {
      S.avatarImg = directImg;
      S.avatarLoaded = true;
      S.need = true;
    };
  };
}

function loadPostImage(post) {
  S.bgImg = null;
  S.bgImgLoaded = false;
  if (!post || !post.images || post.images.length === 0) return;

  const imgUrl = post.images[0];
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const proxyUrl = `/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;
  img.src = proxyUrl;
  img.onload = () => {
    S.bgImg = img;
    S.bgImgLoaded = true;
    S.need = true;
  };
  img.onerror = () => {
    const directImg = new Image();
    directImg.crossOrigin = 'anonymous';
    directImg.src = imgUrl;
    directImg.onload = () => {
      S.bgImg = directImg;
      S.bgImgLoaded = true;
      S.need = true;
    };
  };
}

/* ---------- ポストの切り替え・表示 ---------- */
async function showPost(post, resetClock = true) {
  if (!post) return;
  S.currentPost = post;
  document.body.classList.add('live');

  // 文字数に応じた動的表示秒数（短文なら縮めてテンポ良く、長文ならしっかり）
  S.postDuration = calcPostDuration(post.text, prefs.displayDuration || 12);
  if (resetClock) {
    S.postStartT = performance.now();
    S.totalPausedMs = 0;
    S.paused = false;
    $('playPause').textContent = '⏸';
  }


  // アバター＆添付背景画像読み込み
  loadAvatar(post.authorAvatar);
  loadPostImage(post);

  // HUD & カード情報更新
  updatePostUI(post);

  // JIZURAプラン生成
  await buildPlanForPost(post);
}


function updatePostUI(post) {
  const name = post.authorName || post.authorHandle || 'Bluesky';
  const handle = post.authorHandle ? `@${post.authorHandle}` : '';

  // HUD
  $('tAuthor').textContent = `${name} (${handle})`;
  const qPos = S.queue.indexOf(post);
  const qTotal = S.posts.length;
  $('tQueueIndex').textContent = qTotal > 0 ? `${(S.posts.indexOf(post) + 1 || 1)} / ${qTotal}` : '';
  $('tSummary').textContent = post.text ? post.text.replace(/\s+/g, ' ') : '';

  // DOM PostCard
  const card = $('postCard');
  if (prefs.overlayMode === 'both' || prefs.overlayMode === 'card') {
    $('cardName').textContent = name;
    $('cardHandle').textContent = handle;
    $('cardText').textContent = post.text;
    $('cardAvatar').src = post.authorAvatar ? `/api/proxy-image?url=${encodeURIComponent(post.authorAvatar)}` : '';
    $('cardAvatar').style.display = post.authorAvatar ? 'block' : 'none';

    if (post.createdAt) {
      try {
        const d = new Date(post.createdAt);
        $('cardTime').textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      } catch (e) {
        $('cardTime').textContent = '';
      }
    } else {
      $('cardTime').textContent = '';
    }

    const hasImgs = post.images && post.images.length > 0;
    const mediaBadge = $('cardMediaBadge');
    if (mediaBadge) {
      if (hasImgs) {
        mediaBadge.textContent = `🖼 絵・画像あり (${post.images.length})`;
        mediaBadge.style.display = 'inline-block';
      } else {
        mediaBadge.style.display = 'none';
      }
    }

    if (post.uri) {
      // at://did:.../app.bsky.feed.post/3... -> https://bsky.app/profile/.../post/...
      const m = post.uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
      if (m) {
        $('cardLink').href = `https://bsky.app/profile/${post.authorHandle || m[1]}/post/${m[2]}`;
        $('cardLink').style.display = 'inline';
      } else {
        $('cardLink').style.display = 'none';
      }
    } else {
      $('cardLink').style.display = 'none';
    }

    card.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
  }
}

/* ---------- タイムラインの定期取得 (60秒に1回) ---------- */
async function fetchTimeline(forceRefresh = false) {
  setStatus(forceRefresh ? 'Bluesky から更新中…' : 'タイムラインを確認中…');
  try {
    const url = `/api/timeline${forceRefresh ? '?refresh=1' : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.error) {
      setStatus(`エラー: ${data.error}`);
    } else {
      setStatus(`取得完了 (${new Date().toLocaleTimeString()})`);
    }

    if (data.pollIntervalSeconds) prefs.pollInterval = data.pollIntervalSeconds;
    if (data.displayDurationSeconds) prefs.displayDuration = data.displayDurationSeconds;

    const newPosts = data.posts || [];
    if (newPosts.length > 0) {
      // 既読ポストのURI判定
      const oldUris = new Set(S.posts.map(p => p.uri || p.cid));
      const fresh = newPosts.filter(p => !oldUris.has(p.uri || p.cid));

      S.posts = newPosts;

      if (!S.currentPost) {
        // 初回ロード
        S.queue = [...newPosts];
        const first = S.queue.shift();
        if (first) showPost(first);
      } else if (fresh.length > 0) {
        // 新着ポストをキューの先頭側に差し込む
        S.queue.unshift(...fresh);
        setStatus(`新着 ${fresh.length} 件を追加`);
      }
    } else if (!S.currentPost) {
      goIdle('タイムラインにポストがありません');
    }
  } catch (err) {
    console.error('Fetch timeline error:', err);
    setStatus(`接続エラー: ${err.message}`);
    if (!S.currentPost) {
      goIdle('サーバーに接続できません（起動.bat を確認してください）');
    }
  }
}

function startPollCountdown() {
  S.nextPollSeconds = prefs.pollInterval || 60;
  if (S.pollTimerId) clearInterval(S.pollTimerId);

  S.pollTimerId = setInterval(() => {
    S.nextPollSeconds--;
    $('nextCheckBadge').textContent = `確認: ${Math.max(0, S.nextPollSeconds)}s`;
    if (S.nextPollSeconds <= 0) {
      S.nextPollSeconds = prefs.pollInterval || 60;
      fetchTimeline(false);
    }
  }, 1000);
}

function setStatus(msg) {
  $('status').textContent = msg;
}

function goIdle(msg) {
  $('idleMsg').textContent = msg;
  document.body.classList.remove('live');
  $('postCard').classList.add('hidden');
  const c = $('view');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
}

/* ---------- 前へ / 次へ / キュー進行 ---------- */
function nextPost() {
  if (S.queue.length === 0) {
    // キューが空になったら全ポストからループ
    if (S.posts.length > 0) {
      S.queue = [...S.posts];
    }
  }
  const next = S.queue.shift();
  if (next) {
    if (S.currentPost) S.history.push(S.currentPost);
    showPost(next);
  }
}

function prevPost() {
  if (S.history.length > 0) {
    const prev = S.history.pop();
    if (S.currentPost) S.queue.unshift(S.currentPost);
    showPost(prev);
  } else if (S.posts.length > 1) {
    const curIdx = S.posts.indexOf(S.currentPost);
    const prevIdx = curIdx > 0 ? curIdx - 1 : S.posts.length - 1;
    showPost(S.posts[prevIdx]);
  }
}

function togglePlayPause() {
  S.paused = !S.paused;
  $('playPause').textContent = S.paused ? '▶' : '⏸';
  if (S.paused) {
    S.pauseAt = performance.now();
  } else {
    S.totalPausedMs += (performance.now() - S.pauseAt);
  }
}

/* ---------- Canvas オーバーレイ (アバターアイコン・名前描画) ---------- */
function drawBlueskyCanvasOverlay(ctx, plan, post, t, W, H, scale) {
  if (!post) return;
  if (prefs.overlayMode !== 'both' && prefs.overlayMode !== 'canvas') return;

  const u = H / 1080;
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // 左上にソーシャルバッジを表示
  const padX = 40 * u;
  const padY = 36 * u;
  const iconSize = 56 * u;
  const badgeH = iconSize + 16 * u;
  const badgeW = Math.min(W * 0.45, 420 * u);

  // 背景プレート（ダークグラス調）
  ctx.save();
  ctx.fillStyle = 'rgba(10, 14, 22, 0.75)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1.2 * u;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = 14 * u;
  ctx.shadowOffsetY = 4 * u;

  // 角丸四角形
  const r = 12 * u;
  ctx.beginPath();
  ctx.moveTo(padX + r, padY);
  ctx.lineTo(padX + badgeW - r, padY);
  ctx.quadraticCurveTo(padX + badgeW, padY, padX + badgeW, padY + r);
  ctx.lineTo(padX + badgeW, padY + badgeH - r);
  ctx.quadraticCurveTo(padX + badgeW, padY + badgeH, padX + badgeW - r, padY + badgeH);
  ctx.lineTo(padX + r, padY + badgeH);
  ctx.quadraticCurveTo(padX, padY + badgeH, padX, padY + badgeH - r);
  ctx.lineTo(padX, padY + r);
  ctx.quadraticCurveTo(padX, padY, padX + r, padY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // アバターアイコン
  const iconX = padX + 8 * u;
  const iconY = padY + 8 * u;
  const cx = iconX + iconSize / 2;
  const cy = iconY + iconSize / 2;
  const radius = iconSize / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (S.avatarLoaded && S.avatarImg) {
    try {
      ctx.drawImage(S.avatarImg, iconX, iconY, iconSize, iconSize);
    } catch (e) {
      // フォールバック
      ctx.fillStyle = '#1185fe';
      ctx.fillRect(iconX, iconY, iconSize, iconSize);
    }
  } else {
    // プレースホルダー（イニシャル丸）
    ctx.fillStyle = '#1185fe';
    ctx.fillRect(iconX, iconY, iconSize, iconSize);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(24 * u)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initChar = (post.authorName || post.authorHandle || 'B').charAt(0).toUpperCase();
    ctx.fillText(initChar, cx, cy);
  }
  ctx.restore();

  // アバターの円形枠線
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 2 * u;
  ctx.stroke();
  ctx.restore();

  // テキスト（名前・ハンドル）
  const textX = iconX + iconSize + 12 * u;
  const nameY = cy - 4 * u;
  const handleY = cy + 14 * u;
  const maxTextW = badgeW - (iconSize + 28 * u);

  ctx.save();
  // 送信者名
  ctx.font = `bold ${Math.round(18 * u)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = 4 * u;

  const dispName = post.authorName || post.authorHandle || 'Bluesky';
  ctx.fillText(dispName, textX, nameY, maxTextW);

  // ハンドル名 & 蝶アイコン
  ctx.font = `normal ${Math.round(13 * u)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillStyle = '#8da4be';
  const handleStr = post.authorHandle ? `@${post.authorHandle}` : '';
  ctx.fillText(handleStr, textX, handleY, maxTextW - 20 * u);

  // 蝶 & 画像アイコン
  ctx.font = `${Math.round(13 * u)}px sans-serif`;
  const hasImages = post.images && post.images.length > 0;
  const badgeIcons = (hasImages ? '🖼 ' : '') + '🦋';
  ctx.fillText(badgeIcons, padX + badgeW - (hasImages ? 40 * u : 24 * u), cy + 4 * u);
  ctx.restore();


  // 投稿の残り時間プログレスバー (バッジ下端)
  let maxCutEnd = S.postDuration;
  if (S.plan && S.plan.cuts && S.plan.cuts.length > 0) {
    maxCutEnd = S.plan.cuts[S.plan.cuts.length - 1].end;
  }
  const effectiveDuration = Math.min(S.postDuration, maxCutEnd + 0.65);
  const progress = Math.min(1, Math.max(0, t / effectiveDuration));
  ctx.save();
  ctx.fillStyle = '#1185fe';
  const barH = 2.5 * u;
  ctx.fillRect(padX + r, padY + badgeH - barH, (badgeW - r * 2) * progress, barH);
  ctx.restore();

  ctx.restore();
}

/* ---------- 描画ループ & キャンバスサイズ ---------- */
function sizeCanvas() {
  const c = $('view');
  const [W, H] = S.plan ? [S.plan.W, S.plan.H] : J.designSize(prefs.aspect);
  const ar = W / H;
  let cssW = window.innerWidth, cssH = cssW / ar;
  if (cssH > window.innerHeight) { cssH = window.innerHeight; cssW = cssH * ar; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.max(2, Math.round(Math.min(W, cssW * dpr))), ph = Math.max(2, Math.round(pw / ar));
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  c.style.width = cssW + 'px';
  c.style.height = cssH + 'px';
  S.need = true;
}

/* ---------- 添付画像 (絵) の背景スクロール描画 ---------- */
function drawPostBackground(ctx, W, H, scale, elapsed, duration) {
  if (!S.bgImgLoaded || !S.bgImg) return;
  const img = S.bgImg;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;

  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  // 進行度 (0.0 〜 1.0)
  const rawProgress = Math.min(1, Math.max(0, elapsed / (duration || 12)));
  // スムーズなイージング（始めと終わりを少し緩やかにして全体を移動）
  const progress = rawProgress * rawProgress * (3 - 2 * rawProgress);

  // 画面全体を隙間なく覆う基本スケール (cover fit)
  const scaleX = W / iw;
  const scaleY = H / ih;
  const baseScale = Math.max(scaleX, scaleY);

  // 微小ズームを入れて画面外の隙間を防止
  const zoom = 1.03;
  const finalScale = baseScale * zoom;

  const dw = iw * finalScale;
  const dh = ih * finalScale;

  // はみ出し量（スクロール可能な余白）
  const overflowX = Math.max(0, dw - W);
  const overflowY = Math.max(0, dh - H);

  let dx, dy;

  // 縦長画像の場合: 下端から上端へティルトアップ（足元・背景から、主要部分・顔のある上部へ向かってドラマチックに上昇）
  if (overflowY > overflowX && overflowY > 20) {
    dx = (W - dw) / 2; // 水平は中央揃え
    // 開始: 下端 (dy = -overflowY)、終了: 上端 (dy = 0)
    dy = -overflowY + overflowY * progress;
  }

  // 横長画像の場合: 左端から右端へスクロール
  else if (overflowX >= overflowY && overflowX > 20) {
    dy = (H - dh) / 2; // 垂直は中央揃え
    // 開始: 左端 (dx = 0)、終了: 右端 (dx = W - dw)
    dx = 0 - overflowX * progress;
  }
  // はみ出しが少ない正方形や画面比率に近い画像: 中央を基準に微ズーム＆微動
  else {
    const extraZoom = 1.0 + 0.05 * progress;
    const w2 = dw * extraZoom, h2 = dh * extraZoom;
    dx = (W - w2) / 2;
    dy = (H - h2) / 2;
  }

  // 1. スクロール位置での絵の描画
  ctx.drawImage(img, dx, dy, dw, dh);

  // 2. 文字の視認性を保つための暗幕オーバーレイ
  ctx.fillStyle = 'rgba(8, 10, 16, 0.44)';
  ctx.fillRect(0, 0, W, H);

  // 3. ビネット（四隅の減光）で映画的な文字PVに
  const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.58);
  grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.restore();
}


function tick() {
  requestAnimationFrame(tick);
  if (!S.plan || !S.currentPost) return;

  // 再生時間の計算
  let now = performance.now();
  if (S.paused) now = S.pauseAt;
  const elapsed = Math.max(0, (now - S.postStartT - S.totalPausedMs) / 1000);

  // 1投稿の時間が終わったら次の投稿へ
  // 最後のカットが終了していれば、無駄な空白時間を待たずにスムーズに次へ進む
  let cutEnd = S.postDuration;
  if (S.plan && S.plan.cuts && S.plan.cuts.length > 0) {
    cutEnd = S.plan.cuts[S.plan.cuts.length - 1].end;
  }
  const effectiveDuration = Math.min(S.postDuration, cutEnd + 0.65);

  if (!S.paused && elapsed >= effectiveDuration) {
    nextPost();
    return;
  }


  const f = Math.floor(elapsed * (S.plan.fps || 24));
  if (!S.need && f === S.lastT) return;

  const c = $('view'), ctx = c.getContext('2d');
  const scale = c.width / S.plan.W;
  const hasBgImg = S.bgImgLoaded && S.bgImg;

  try {
    if (hasBgImg) {
      // 絵が貼ってある場合:
      // 1. オフスクリーンキャンバスに JIZURA（transparent: true）を描画
      //    (JIZURA 内部で clearRect が走ってもメインキャンバスの絵を消さないように隔離)
      if (!S.textCanvas || S.textCanvas.width !== c.width || S.textCanvas.height !== c.height) {
        S.textCanvas = document.createElement('canvas');
        S.textCanvas.width = c.width;
        S.textCanvas.height = c.height;
      }
      const tctx = S.textCanvas.getContext('2d');

      S.renderer.frame(tctx, S.plan, Math.min(elapsed, S.plan.duration), {
        scale,
        fast: S.slow,
        transparent: true
      });

      // 2. メインキャンバスに背景として絵を描画 (Ken Burns エフェクト + 暗幕 + ビネット)
      ctx.clearRect(0, 0, c.width, c.height);
      drawPostBackground(ctx, S.plan.W, S.plan.H, scale, elapsed, S.postDuration);

      // 3. JIZURA の文字・エフェクトを絵の上に合成
      ctx.drawImage(S.textCanvas, 0, 0);
    } else {
      // 絵がない場合: 通常の JIZURA 背景で描画
      S.renderer.frame(ctx, S.plan, Math.min(elapsed, S.plan.duration), {
        scale,
        fast: S.slow,
        transparent: prefs.bg === 'clear'
      });
    }

    // 4. Bluesky アバター・名前・プログレスの Canvas オーバーレイ描画
    drawBlueskyCanvasOverlay(ctx, S.plan, S.currentPost, elapsed, S.plan.W, S.plan.H, scale);
  } catch (e) {
    console.warn('Frame render error:', e);
  }

  S.lastT = f;
  S.need = false;
}


/* ---------- UI イベント登録と初期設定 ---------- */
function setupUI() {
  // スタイル選択ドロップダウンの初期化
  const styleSelect = $('style');
  styleSelect.innerHTML = '<option value="auto">おまかせ（投稿ごと）</option>';
  for (const k of Object.keys(J.STYLES || {})) {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = (J.STYLES[k] && J.STYLES[k].name) || k;
    styleSelect.appendChild(opt);
  }
  styleSelect.value = prefs.style || 'auto';
  styleSelect.onchange = () => {
    prefs.style = styleSelect.value;
    savePrefs();
    if (S.currentPost) buildPlanForPost(S.currentPost);
  };

  // アスペクト比
  const aspectSelect = $('aspect');
  aspectSelect.value = prefs.aspect || '16:9';
  aspectSelect.onchange = () => {
    prefs.aspect = aspectSelect.value;
    savePrefs();
    sizeCanvas();
    if (S.currentPost) buildPlanForPost(S.currentPost);
  };

  // 背景
  const bgSelect = $('bg');
  bgSelect.value = prefs.bg || 'fx';
  bgSelect.onchange = () => {
    prefs.bg = bgSelect.value;
    savePrefs();
    document.documentElement.classList.toggle('clear', prefs.bg === 'clear');
    S.need = true;
  };
  document.documentElement.classList.toggle('clear', prefs.bg === 'clear');

  // コントロールボタン
  $('prevPost').onclick = prevPost;
  $('nextPost').onclick = nextPost;
  $('playPause').onclick = togglePlayPause;

  $('reroll').onclick = () => {
    if (!S.currentPost) return;
    const k = (S.currentPost.uri || S.currentPost.cid || S.currentPost.text);
    S.reroll[k] = (S.reroll[k] | 0) + 1;
    buildPlanForPost(S.currentPost);
  };

  $('refreshBtn').onclick = () => fetchTimeline(true);

  // 全画面
  $('fullBtn').onclick = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // マウスホバーでHUDを表示・3秒で自動フェードアウト
  window.addEventListener('mousemove', () => {
    document.body.classList.remove('hudOff', 'hideCursor');
    if (S.hudTimer) clearTimeout(S.hudTimer);
    if (!S.hudPinned && !isObs) {
      S.hudTimer = setTimeout(() => {
        document.body.classList.add('hudOff', 'hideCursor');
      }, 3500);
    }
  });

  // キーボードショートカット
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlayPause(); }
    else if (e.key === 'ArrowRight') { nextPost(); }
    else if (e.key === 'ArrowLeft') { prevPost(); }
    else if (e.key === 'r' || e.key === 'R') { $('reroll').click(); }
    else if (e.key === 'f' || e.key === 'F') { $('fullBtn').click(); }
    else if (e.key === 'h' || e.key === 'H') {
      S.hudPinned = !S.hudPinned;
      document.body.classList.toggle('hudOff', !S.hudPinned);
    }
  });

  window.addEventListener('resize', sizeCanvas);

  // 設定モーダル
  setupSettingsModal();
}

function setupSettingsModal() {
  const modal = $('settingsModal');
  const openBtn = $('settingsBtn');
  const closeBtn = $('closeSettings');
  const cancelBtn = $('cancelSettings');
  const saveBtn = $('saveSettings');

  openBtn.onclick = async () => {
    modal.classList.remove('hidden');
    $('saveStatus').textContent = '';
    // サーバーから最新設定を取得
    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      document.querySelector(`input[name="mode"][value="${cfg.mode || 'author'}"]`).checked = true;
      $('cfgIdentifier').value = cfg.identifier || '';
      $('cfgPassword').value = '';
      $('cfgPassword').placeholder = cfg.hasPassword ? '（設定済み・変更時のみ入力）' : 'xxxx-xxxx-xxxx-xxxx';
      $('cfgPoll').value = cfg.pollIntervalSeconds || 60;
      $('cfgDuration').value = cfg.displayDurationSeconds || 12;
      $('cfgOverlay').value = prefs.overlayMode || 'both';
      updateModeVisibility(cfg.mode || 'author');
    } catch (e) {
      console.warn('Failed to load config:', e);
    }
  };

  const close = () => modal.classList.add('hidden');
  closeBtn.onclick = close;
  cancelBtn.onclick = close;

  const modeRadios = document.querySelectorAll('input[name="mode"]');
  modeRadios.forEach(r => {
    r.onchange = () => updateModeVisibility(r.value);
  });

  function updateModeVisibility(mode) {
    $('pwdGroup').style.display = mode === 'timeline' ? 'flex' : 'none';
  }

  saveBtn.onclick = async () => {
    $('saveStatus').textContent = '保存中…';
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const identifier = $('cfgIdentifier').value.trim();
    const password = $('cfgPassword').value.trim();
    const pollInterval = parseInt($('cfgPoll').value, 10) || 60;
    const displayDuration = parseInt($('cfgDuration').value, 10) || 12;
    const overlayMode = $('cfgOverlay').value;

    prefs.overlayMode = overlayMode;
    prefs.displayDuration = displayDuration;
    prefs.pollInterval = pollInterval;
    savePrefs();

    const payload = {
      mode,
      identifier,
      pollIntervalSeconds: pollInterval,
      displayDurationSeconds: displayDuration
    };
    if (password) payload.password = password;

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        $('saveStatus').textContent = '保存しました！';
        setTimeout(() => {
          close();
          fetchTimeline(true);
          startPollCountdown();
        }, 600);
      } else {
        $('saveStatus').textContent = data.error || '保存に失敗しました';
      }
    } catch (e) {
      $('saveStatus').textContent = `エラー: ${e.message}`;
    }
  };
}

/* ---------- 起動エントリポイント ---------- */
async function init() {
  setupUI();
  sizeCanvas();
  tick();

  // タイムラインの初回取得 & 60秒カウントダウンタイマースタート
  await fetchTimeline(false);
  startPollCountdown();
}

// 開始
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();

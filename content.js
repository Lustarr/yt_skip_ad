// YouTube Auto Skip Ads (MV3 content script) — Ad-only polling (fixed scope)
// //留著以後擴充
// const OVERLAY_CLOSE_SELECTORS = [
//   '.ytp-ad-overlay-close-button',
//   '.ytp-ad-overlay-close-container'
// ];
// //留著以後擴充
// function findOverlayClose() {
//   const player = getPlayer();
//   if (!player) return null;

//   for (const sel of OVERLAY_CLOSE_SELECTORS) {
//     const el = player.querySelector(sel);
//     if (el && isClickable(el)) return el;
//   }
//   return null;
// }

// 更嚴格的按鈕選擇器（僅限 ytp-* 的真正 skip 按鈕）
const BUTTON_SELECTORS = [
  'button.ytp-skip-ad-button',
  'button.ytp-ad-skip-button',
  'button.ytp-ad-skip-button-modern',
  '.ytp-ad-skip-button-modern',  // 有些是 div 但有 ytp-* 類名
  '.ytp-skip-ad-button',          // 舊類名
];

const LOG_PREFIX = '[YT Auto Skip Ads]';
const AD_POLL_INTERVAL = 1000;   // 只在廣告時輪詢
const CLICK_COOLDOWN_MS = 2*AD_POLL_INTERVAL;     // 點過 skip 後的全域冷卻
const INFLIGHT_WINDOW_MS = 2*AD_POLL_INTERVAL;     // 一次只允許一筆 trusted click
const MAX_WAIT_MS = 8000; // 最多等 8 秒
const SPA_CHECK_INTERVAL = Math.min(400, AD_POLL_INTERVAL);
const MAX_TRIES = Math.ceil(MAX_WAIT_MS / SPA_CHECK_INTERVAL);
let adPollTimer = null;
let clickCooldownUntil = 0;
let inflightUntil = 0;
let clickedOnce = new WeakSet();  // 同一顆按鈕只點一次
let domObserver = null;
let playerObserver = null;

function canClickNow() {
  const now = Date.now();
  return now >= clickCooldownUntil && now >= inflightUntil;
}
function armInflight() {
  inflightUntil = Date.now() + INFLIGHT_WINDOW_MS;
}
function armCooldown() {
  clickCooldownUntil = Date.now() + CLICK_COOLDOWN_MS;
}
function resetClickedOnce() {
  clickedOnce = new WeakSet();
}
function getPlayer() {
  return document.querySelector('.html5-video-player') || document.querySelector('#movie_player');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function raf() { return new Promise(r => requestAnimationFrame(r)); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function hitTestContains(el, x, y) {
  const hit = document.elementFromPoint(x, y);
  return hit && (hit === el || el.contains(hit));
}
function fullyInView(el) {
  const r = el.getBoundingClientRect();
  return r.top >= 0 && r.left >= 0 &&
         r.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
         r.right  <= (window.innerWidth  || document.documentElement.clientWidth);
}

// 取安全點（往內縮，避開邊界）
function getSafeViewportXY(el) {
  const r = el.getBoundingClientRect();
  const pad = Math.min(6, Math.floor(Math.min(r.width, r.height) / 6));
  const cx = r.left + r.width  / 2;
  const cy = r.top  + r.height / 2;
  const x  = Math.round(clamp(cx, r.left  + pad, r.right  - pad));
  const y  = Math.round(clamp(cy, r.top   + pad, r.bottom - pad));
  return { x, y };
}

function withVisualViewport(x, y) {
  const vv = window.visualViewport;
  if (!vv) return { x, y };
  return { x: x + vv.offsetLeft, y: y + vv.offsetTop };
}

function pickProbes(el) {
  const r = el.getBoundingClientRect();
  const pad = Math.min(6, Math.floor(Math.min(r.width, r.height)/6));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const cx = r.left + r.width/2, cy = r.top + r.height/2;
  const center = { x: Math.round(clamp(cx, r.left+pad, r.right-pad)),
                   y: Math.round(clamp(cy, r.top+pad,  r.bottom-pad)) };
  const up     = { x: center.x, y: Math.round(clamp(center.y-12, r.top+pad, r.bottom-pad))};
  const left   = { x: Math.round(clamp(center.x-12, r.left+pad, r.right-pad)), y: center.y };
  return [center, up, left];
}

function withMutedChromeBottom(fn, ms = 400) {
  const style = document.createElement('style');
  style.textContent = `
    .ytp-chrome-bottom,
    .ytp-gradient-bottom,
    .ytp-gradient-top,
    .ytp-size-button,
    .ytp-fullscreen-button {
      pointer-events: none !important;
    }`;
  document.documentElement.appendChild(style);
  const cleanup = () => { style.remove(); };
  const timer = setTimeout(cleanup, ms);
  return Promise.resolve()
    .then(fn)
    .finally(() => { clearTimeout(timer); cleanup(); });
}

function isClickable(el) {
  if (!el) return false;
  // 避免隱藏/不可點
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
  if (s.pointerEvents === 'none') return false;
  return true;
}

// 可靠點擊：優先用 DevTools（trusted），失敗再 fallback
async function trustedClick(el, label = "button") {
  if (!el) return false;
  if (clickedOnce.has(el)) return false;
  if (!canClickNow()) return false;

  if (!fullyInView(el)) {
    try { el.scrollIntoView({block:"nearest", inline:"nearest", behavior:"auto"}); } catch {}
    await raf(); // 讓版面穩定再取座標
  }

  if (!el.isConnected || !isClickable(el)) return false;
  let { x, y } = getSafeViewportXY(el);
  ({ x, y } = withVisualViewport(x, y));
  const probes = pickProbes(el);
  let point = null;
  for (const p of probes) {
    if (hitTestContains(el, p.x, p.y)) { point = p; break; }
  }
  if (!point) return false; // 這輪放掉，交給下輪

  armInflight(); // 鎖住一小段時間，避免連點 

  const ok = await withMutedChromeBottom(async () => {
    return await new Promise((resolve) => {
      chrome.runtime.sendMessage({ 
        type: "DEVTOOLS_TRUSTED_CLICK", 
        x, 
        y, 
        dpr: window.devicePixelRatio ?? 1
      }, (res) => {
        resolve(res?.ok === true);
      });
    });
  }, AD_POLL_INTERVAL / 2); // 依你 AD_POLL_INTERVAL 微調

  // 不要在 DevTools 成功後再補合成事件，避免多點
  if (ok) {
    // 標記這顆按鈕已處理，避免 interval/observer 重複點
    clickedOnce.add(el);
    // 立刻進入全域冷卻，並暫停輪詢，避免下一個 tick 再打到影片
    armCooldown();
    stopAdPolling();
    console.debug("[YT Auto Skip Ads] trusted (DevTools) clicked", label);
    return true;
  }

  return false;
}

function isAdShowing() {
  const player = getPlayer();
  if (!player) return false;
  return (
    player.classList.contains('ad-showing') ||
    player.classList.contains('ad-interrupting') ||
    !!player.querySelector('.ytp-ad-player-overlay, .ytp-ad-image-overlay, .video-ads, .ytp-ad-module')
  );
}

// 只在「播放器容器內」找按鈕，避免點到頁首 Skip navigation
function findSkipButton() {
  const player = getPlayer();
  if (!player) return null;

  for (const sel of BUTTON_SELECTORS) {
    const btn = player.querySelector(sel);
    if (btn && isClickable(btn)) return btn;
  }

  // 最後備援（仍限定在 player 內，且 aria-label 必須包含 "Skip" 關鍵字）
  const fallback = player.querySelector('[aria-label*="Skip" i], [aria-label*="略過"]');
  if (fallback && isClickable(fallback)) return fallback;

  return null;
}

// ---------- 廣告期間輪詢 ----------
function startAdPolling() {
  if (adPollTimer) return;
  adPollTimer = setInterval(async () => {
    // 嚴格：僅 ad-showing 才行動
    if (!isAdShowing()) { stopAdPolling(); return; }
    if (!canClickNow()) return; // 冷卻中就先別動

    const btn = findSkipButton();
    if (btn) {
      const did = await trustedClick(btn, "skip");
      if (did) return; // 本輪已處理，避免同一 tick 又去點 overlay 或落到影片
    }
  }, AD_POLL_INTERVAL);

  console.debug(`${LOG_PREFIX} ad polling started (${AD_POLL_INTERVAL}ms).`);
}

function stopAdPolling() {
  if (adPollTimer) {
    clearInterval(adPollTimer);
    adPollTimer = null;
    console.debug(`${LOG_PREFIX} ad polling stopped.`);
  }
}

function attachDOMObserver() {
  if (domObserver) return;
  domObserver = new MutationObserver(() => {
    if (isAdShowing()) startAdPolling();
    // 有 DOM 變化就先試一次（只在 player 內找）
    const btn = findSkipButton();
    if (btn && canClickNow()) { trustedClick(btn, "skip").catch(() => {}); }
  });

  domObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
}

function attachPlayerObserver() {
  const player = getPlayer();
  if (!player || playerObserver) return;

  playerObserver = new MutationObserver(() => {
    // 只在廣告狀態下動作
    if (isAdShowing()) {
      startAdPolling();
      const btn = findSkipButton();
      if (btn && canClickNow()) { trustedClick(btn, "skip").catch(() => {}); }
    } else {
      stopAdPolling();
      resetClickedOnce();
    }
  });

  playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
}

// YouTube 是 SPA，需要在導航後重掛 observer
function onSpaNavigate() {
  stopAdPolling();
  playerObserver?.disconnect();
  playerObserver = null;
  resetClickedOnce();

  let tries = 0;
  const finder = setInterval(async () => {
    tries++;
    if (getPlayer() || tries > MAX_TRIES) {
      clearInterval(finder);
      attachPlayerObserver();
      if (isAdShowing()) startAdPolling();
    }
  }, SPA_CHECK_INTERVAL);
}

// ---------- 初始化 ----------
function setupAutoSkip() {
  attachDOMObserver();
  attachPlayerObserver();

  if (isAdShowing()) startAdPolling();

  window.addEventListener('yt-navigate-finish', onSpaNavigate);
  window.addEventListener('yt-page-data-updated', onSpaNavigate);

  console.debug(`${LOG_PREFIX} initialized (ad-only polling; scoped to player).`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupAutoSkip);
} else {
  setupAutoSkip();
}

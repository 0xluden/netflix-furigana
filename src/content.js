/**
 * Netflix Japanese - Content Script
 *
 * Architecture: Overlay approach.
 * We do NOT modify Netflix's subtitle DOM at all.
 * Instead:
 *   1. Poll for Netflix subtitle text every 200ms
 *   2. If text changed, render our annotated version into OUR overlay div
 *   3. Position our overlay to match Netflix's subtitle container
 *   4. Hide Netflix's original text with CSS (color: transparent)
 *
 * This means Netflix can re-render its DOM as much as it wants — we just
 * re-read the text and update our own overlay independently.
 */

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  furiganaVisible: true,
  worker: null,
  tokenizerReady: false,
  tooltipEl: null,
  overlayEl: null,
  activeToken: null,
  hoveringTooltip: false,
  lookupCache: new Map(),
  pendingTokenize: new Map(),
  tokenizeIdCounter: 0,
  pollTimer: null,
  lastSubtitleKey: '',   // hash of last rendered subtitle block
  // Language of Netflix's currently selected text track (BCP-47, e.g. 'ja',
  // 'zh-Hans'; 'off' when subtitles are disabled; null until the page hook
  // reports it — then a kana heuristic is used instead)
  selectedTrackLang: null,
  // Dual-subtitle mode: official Japanese track rendered above the chosen subs
  dualEnabled: false,
  dualEl: null,
  dualTracks: new Map(),      // movieId -> track list from the page hook
  dualCues: null,             // parsed cues for the current movie
  dualCuesMovieId: null,
  dualFetchPending: false,
  dualFetchFailures: new Map(), // movieId -> failed fetch attempts
  lastDualKey: '',
};

const renderCache = new Map(); // text → tokens[]

// Persistent name memory: accumulates Netflix ruby annotations across ALL subtitle renders.
// Key: surface text (e.g. "梢枝"), Value: reading (e.g. "コズエ")
// This persists for the entire session so names seen in side subtitles are
// remembered when they appear later in main subtitles.
const nameMemory = new Map();

// ─── Web Worker ───────────────────────────────────────────────────────────────
function initWorker() {
  return new Promise((resolve, reject) => {
    const kuromojiUrl = chrome.runtime.getURL('src/kuromoji.js');
    const workerUrl   = chrome.runtime.getURL('src/tokenizer-worker.js');
    const dicPath     = chrome.runtime.getURL('dict');
    const bootstrap   = `self.kuromojiUrl=${JSON.stringify(kuromojiUrl)};importScripts(${JSON.stringify(workerUrl)});`;
    const blob        = new Blob([bootstrap], { type: 'application/javascript' });
    const blobUrl     = URL.createObjectURL(blob);
    const worker      = new Worker(blobUrl);
    state.worker      = worker;

    worker.onmessage = ({ data }) => {
      if (data.type === 'INIT_OK') {
        state.tokenizerReady = true;
        console.log('[NJ] Tokenizer ready ✓');
        URL.revokeObjectURL(blobUrl);
        resolve();
      } else if (data.type === 'INIT_ERROR') {
        URL.revokeObjectURL(blobUrl);
        reject(new Error(data.error));
      } else if (data.type === 'TOKENIZE_RESULT') {
        const p = state.pendingTokenize.get(data.id);
        if (p) { state.pendingTokenize.delete(data.id); p(data.tokens); }
      }
    };
    worker.onerror = reject;
    worker.postMessage({ type: 'INIT', payload: { dicPath } });
    setTimeout(() => { if (!state.tokenizerReady) reject(new Error('timeout')); }, 30000);
  });
}

function tokenize(text) {
  return new Promise(resolve => {
    if (!state.tokenizerReady) return resolve([]);
    const id = ++state.tokenizeIdCounter;
    state.pendingTokenize.set(id, resolve);
    state.worker.postMessage({ type: 'TOKENIZE', id, payload: { text } });
  });
}

// ─── Dictionary ───────────────────────────────────────────────────────────────
async function lookupWord(word, reading) {
  const key = `${word}|${reading}`;
  if (state.lookupCache.has(key)) return state.lookupCache.get(key);
  const fallback = { word, reading, definitions: [], jlpt: null, partsOfSpeech: [] };
  try {
    // Fetch via background service worker to bypass Netflix's CSP
    const resp = await chrome.runtime.sendMessage({ type: 'JISHO_LOOKUP', word });
    if (resp?.ok && resp.json) {
      const result = parseJisho(resp.json, word, reading);
      if (result) { state.lookupCache.set(key, result); return result; }
    }
  } catch (_) {}
  state.lookupCache.set(key, fallback);
  return fallback;
}

function parseJisho(json, word, reading) {
  if (!json.data?.length) return null;
  const entry = json.data.find(e => (e.japanese||[]).some(f => f.word===word||f.reading===reading))
             || json.data[0];
  const senses = entry.senses || [];
  return {
    word,
    reading: entry.japanese?.[0]?.reading || reading,
    definitions: senses.slice(0,3).map(s => ({
      text: (s.english_definitions||[]).join('; '),
      info: (s.info||[]).join(', ')
    })),
    jlpt: entry.jlpt?.[0]?.replace('jlpt-','').toUpperCase() || null,
    partsOfSpeech: [...new Set(senses.flatMap(s => s.parts_of_speech||[]))].slice(0,3),
  };
}

// ─── Rendering ────────────────────────────────────────────────────────────────
const hasKanji = s => /[\u4E00-\u9FAF\u3400-\u4DBF]/.test(s);
const hasKana  = s => /[\u3040-\u309F\u30A0-\u30FF]/.test(s);

// Chinese subtitles also contain kanji, so a character-class check alone is not
// enough to know the text is Japanese.
// Primary signal: the selected track's language reported by the page hook.
// Fallback (track unknown or subtitles 'off'): kana only appear in Japanese.
function isJapaneseSubtitle(blockText) {
  const lang = state.selectedTrackLang;
  if (lang && lang !== 'off') return lang.startsWith('ja');
  return hasKana(blockText);
}

function setNativeHidden(hidden) {
  document.documentElement.classList.toggle('nj-hide-native', hidden);
}
const k2h = s => s.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// Proper nouns stay katakana; common words shown in hiragana (standard for learners)
function getDisplayReading(token) {
  if (!token.reading) return null;
  const isProperNoun = token.pos === '\u540d\u8a5e' && token.pos_detail_1 === '\u56fa\u6709\u540d\u8a5e';
  return isProperNoun ? token.reading : k2h(token.reading);
}

// Build a line element from tokens, applying Netflix ruby overrides where available.
// rubyOverrides: Map<surface, reading> extracted from Netflix's own <ruby> tags.
//
// Key challenge: Netflix may annotate "梢枝"→"コズエ" as a unit, but kuromoji may
// split it into ["梢", "枝"]. We handle this by checking if a sequence of consecutive
// tokens concatenates to match an override key.
function buildLineEl(tokens, rubyOverrides = new Map()) {
  const line = document.createElement('div');
  line.className = 'nj-line';

  // Merge per-subtitle overrides with persistent name memory
  // nameMemory covers names first seen in side subtitles, then recurring in main subs
  const allOverrides = new Map([...nameMemory, ...rubyOverrides]);

  let i = 0;
  while (i < tokens.length) {
    // Try to match a multi-token sequence against allOverrides
    // Check lengths from longest possible match down to 1
    let matched = false;
    if (allOverrides.size > 0) {
      for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
        const seq = tokens.slice(i, i + len).map(t => t.surface_form).join('');
        const netflixReading = allOverrides.get(seq);
        if (netflixReading) {
          // Netflix annotated this sequence — render as single ruby with Netflix's reading
          const ruby = document.createElement('ruby');
          ruby.className = 'nj-token';
          ruby.dataset.surface = seq;
          ruby.dataset.reading = k2h(netflixReading);
          ruby.dataset.pos = 'netflix';
          ruby.appendChild(document.createTextNode(seq));
          const rt = document.createElement('rt');
          rt.className = 'nj-rt';
          rt.textContent = netflixReading;
          ruby.appendChild(rt);
          line.appendChild(ruby);
          i += len;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    // Normal token rendering
    const t = tokens[i];
    const surface = t.surface_form;
    const pos = [t.pos, t.pos_detail_1].filter(Boolean).join('/');
    const displayReading = getDisplayReading(t);
    const lookupReading  = displayReading ? k2h(displayReading) : null;
    if (hasKanji(surface) && displayReading) {
      const ruby = document.createElement('ruby');
      ruby.className = 'nj-token';
      ruby.dataset.surface = surface;
      ruby.dataset.reading = lookupReading;
      ruby.dataset.pos = pos;
      ruby.appendChild(document.createTextNode(surface));
      const rt = document.createElement('rt');
      rt.className = 'nj-rt';
      rt.textContent = displayReading;
      ruby.appendChild(rt);
      line.appendChild(ruby);
    } else {
      const span = document.createElement('span');
      span.className = 'nj-token';
      span.dataset.surface = surface;
      span.dataset.reading = lookupReading || '';
      span.dataset.pos = pos;
      span.textContent = surface;
      line.appendChild(span);
    }
    i++;
  }
  return line;
}

// ─── Subtitle Detection ───────────────────────────────────────────────────────
function getNetflixSubtitleContainer() {
  return document.querySelector('.player-timedtext')
      || document.querySelector('[data-uia="player-timedtext"]')
      || document.querySelector('.nfp-captions');
}

// Extract base text from a subtitle element, excluding <rt> ruby reading text.
function getBaseText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('rt').forEach(rt => rt.remove());
  return clone.textContent.trim();
}

/**
 * Extract Netflix's own ruby readings from a subtitle element.
 * Stores them in the persistent nameMemory so names seen in side subtitles
 * are remembered for all future subtitle renders this session.
 * Returns a Map of { surfaceText -> reading } for this specific element.
 */
function extractNetflixRubyReadings(el) {
  const map = new Map();
  el.querySelectorAll('ruby').forEach(ruby => {
    const rt = ruby.querySelector('rt');
    if (!rt) return;
    const surface = ruby.childNodes[0]?.textContent?.trim();
    const reading = rt.textContent.trim();
    if (surface && reading) {
      map.set(surface, reading);
      // Persist into session-wide name memory
      if (!nameMemory.has(surface)) {
        nameMemory.set(surface, reading);
        console.log(`[NJ] Name learned: ${surface} → ${reading}`);
      }
    }
  });
  return map;
}

// All subtitle line elements — covers both main bottom subs and side/sign subs
function extractSubtitleLines(container) {
  const lineEls = [...container.querySelectorAll('.player-timedtext-text-container')];
  if (lineEls.length) {
    return lineEls.map(el => ({
      text: getBaseText(el),
      el,
      rubyOverrides: extractNetflixRubyReadings(el),
    })).filter(l => l.text);
  }
  return [...container.children]
    .map(el => ({
      text: getBaseText(el),
      el,
      rubyOverrides: extractNetflixRubyReadings(el),
    }))
    .filter(l => l.text);
}

// ─── Dual Subtitles (official Japanese track over the chosen subs) ────────────
// The page hook (src/page-hook.js, MAIN world) captures Netflix's manifest,
// which lists every available subtitle track with a WebVTT download URL, and
// fetches the Japanese one for us. We parse the cues and sync them against
// video.currentTime in the existing poll loop.

function getCurrentMovieId() {
  const m = location.pathname.match(/\/watch\/(\d+)/);
  return m ? m[1] : null;
}

function parseVttTimestamp(ts) {
  const m = ts.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})/);
  if (!m) return null;
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function parseWebVTT(text) {
  const cues = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean);
    const timeIdx = lines.findIndex(l => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [startRaw, endRaw] = lines[timeIdx].split('-->');
    const start = parseVttTimestamp(startRaw.trim());
    const end   = parseVttTimestamp(endRaw.trim());
    if (start == null || end == null) continue;
    const raw = lines.slice(timeIdx + 1).join('\n');

    // Netflix's Japanese VTT may carry ruby name annotations — harvest them
    // as overrides (and into nameMemory) before stripping markup
    const rubyOverrides = new Map();
    raw.replace(/<ruby[^>]*>([^<]+)<rt[^>]*>([^<]+)<\/rt>\s*<\/ruby>/g, (full, surface, reading) => {
      surface = surface.trim(); reading = reading.trim();
      if (surface && reading) {
        rubyOverrides.set(surface, reading);
        if (!nameMemory.has(surface)) nameMemory.set(surface, reading);
      }
      return full;
    });

    const clean = raw
      .replace(/<rt[^>]*>[^<]*<\/rt>/g, '')   // ruby readings are not base text
      .replace(/<[^>]+>/g, '')                // strip remaining VTT/HTML tags
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .trim();
    if (clean) cues.push({ start, end, text: clean, rubyOverrides });
  }
  return cues;
}

function pickJapaneseTrack(tracks) {
  const ja = tracks.filter(t => t.language && t.language.startsWith('ja'));
  return ja.find(t => !t.isClosedCaptions) || ja[0] || null;
}

// Request the Japanese VTT for the current movie if we don't have it yet
function ensureDualCues(movieId) {
  if (state.dualFetchPending) return;
  if ((state.dualFetchFailures.get(movieId) || 0) >= 3) return;
  const tracks = state.dualTracks.get(movieId);
  if (!tracks) return; // manifest not captured (yet)
  const track = pickJapaneseTrack(tracks);
  if (!track) return;  // title has no official Japanese subs
  state.dualFetchPending = true;
  window.postMessage({ nj: true, type: 'FETCH_TRACK', url: track.url, movieId }, '*');
}

function createDualEl() {
  const el = document.createElement('div');
  el.id = 'nj-dual';
  document.body.appendChild(el);
  state.dualEl = el;
}

function hideDual() {
  if (state.lastDualKey !== '' && state.dualEl) {
    state.dualEl.style.display = 'none';
    state.dualEl.innerHTML = '';
  }
  state.lastDualKey = '';
}

// Anchor the dual line just above Netflix's visible subtitle block; when no
// native subtitle is on screen, sit near the bottom of the video instead
function positionDualEl(video) {
  const el = state.dualEl;
  const vr = video.getBoundingClientRect();
  let anchorTop = null;
  const container = getNetflixSubtitleContainer();
  if (container) {
    container.querySelectorAll('.player-timedtext-text-container').forEach(lineEl => {
      const r = lineEl.getBoundingClientRect();
      if (r.width && r.height) anchorTop = anchorTop === null ? r.top : Math.min(anchorTop, r.top);
    });
  }
  const bottom = anchorTop !== null ? anchorTop - 8 : vr.bottom - vr.height * 0.1;
  el.style.left     = vr.left + 'px';
  el.style.width    = vr.width + 'px';
  el.style.bottom   = Math.max(0, window.innerHeight - bottom) + 'px';
  el.style.fontSize = Math.max(20, Math.round(vr.height * 0.043)) + 'px';
}

let dualRendering = false;

async function renderDualSubtitle() {
  if (!state.dualEnabled || !state.dualEl) { hideDual(); return; }
  // When Japanese subs are already selected the main overlay annotates them
  if (state.selectedTrackLang && state.selectedTrackLang.startsWith('ja')) { hideDual(); return; }

  const movieId = getCurrentMovieId();
  const video = document.querySelector('video');
  if (!movieId || !video) { hideDual(); return; }
  if (state.dualCuesMovieId !== movieId) {
    ensureDualCues(movieId);
    hideDual();
    return;
  }

  const t = video.currentTime;
  const active = state.dualCues.filter(c => t >= c.start && t <= c.end);
  // One rendered line per VTT text line, each with its cue's ruby overrides
  const lines = active.flatMap(c =>
    c.text.split('\n').map(text => ({ text, rubyOverrides: c.rubyOverrides })));
  const key = lines.map(l => l.text).join('\n');

  if (!lines.length) { hideDual(); return; }
  positionDualEl(video);
  if (key === state.lastDualKey || dualRendering) return;

  dualRendering = true;
  try {
    const tokenizedLines = await Promise.all(lines.map(async l => {
      let tokens = renderCache.get(l.text);
      if (!tokens) {
        tokens = await tokenize(l.text);
        if (tokens.length) renderCache.set(l.text, tokens);
      }
      return { ...l, tokens };
    }));

    state.lastDualKey = key;
    const el = state.dualEl;
    el.innerHTML = '';
    for (const { text, tokens, rubyOverrides } of tokenizedLines) {
      const lineEl = tokens && tokens.length
        ? buildLineEl(tokens, rubyOverrides || new Map())
        : (() => { const d = document.createElement('div'); d.className = 'nj-line'; d.textContent = text; return d; })();
      el.appendChild(lineEl);
    }
    el.querySelectorAll('.nj-token').forEach(attachHover);
    el.style.display = 'block';
  } finally {
    dualRendering = false;
  }
}

function setDualEnabled(value, showHud) {
  state.dualEnabled = value;
  chrome.storage.local.set({ dualSubsEnabled: value });
  if (!value) hideDual();
  if (showHud) {
    let hud = document.getElementById('nj-hud');
    if (!hud) { hud = document.createElement('div'); hud.id = 'nj-hud'; document.body.appendChild(hud); }
    hud.textContent = value ? '日本語字幕 ON' : '日本語字幕 OFF';
    hud.classList.add('nj-hud-show');
    setTimeout(() => hud.classList.remove('nj-hud-show'), 1500);
  }
}

// ─── Page Hook Messages ───────────────────────────────────────────────────────
window.addEventListener('message', evt => {
  if (evt.source !== window || !evt.data || evt.data.nj !== true) return;
  const d = evt.data;
  if (d.type === 'SELECTED_TRACK') {
    if (state.selectedTrackLang !== d.bcp47) {
      state.selectedTrackLang = d.bcp47;
      state.lastSubtitleKey = ''; // language changed — re-evaluate current subtitle
      console.log('[NJ] Selected subtitle track:', d.bcp47);
    }
  } else if (d.type === 'TRACKS') {
    state.dualTracks.set(d.movieId, d.tracks);
    console.log(`[NJ] Captured ${d.tracks.length} subtitle tracks for movie ${d.movieId}`);
  } else if (d.type === 'TRACK_VTT') {
    state.dualFetchPending = false;
    if (d.movieId === getCurrentMovieId()) {
      state.dualCues = parseWebVTT(d.text);
      state.dualCuesMovieId = d.movieId;
      console.log(`[NJ] Japanese track loaded: ${state.dualCues.length} cues`);
    }
  } else if (d.type === 'TRACK_VTT_ERROR') {
    state.dualFetchPending = false;
    state.dualFetchFailures.set(d.movieId, (state.dualFetchFailures.get(d.movieId) || 0) + 1);
    console.warn('[NJ] Japanese track fetch failed:', d.error);
  }
});

// ─── Overlay ──────────────────────────────────────────────────────────────────
function createOverlay() {
  const el = document.createElement('div');
  el.id = 'nj-overlay';
  el.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483640;overflow:visible;';
  document.body.appendChild(el);
  state.overlayEl = el;
}

function getNetflixLineStyle(lineEl) {
  const span = lineEl.querySelector('span[lang]')
            || lineEl.querySelector('span span')
            || lineEl.querySelector('span')
            || lineEl;
  const s = window.getComputedStyle(span);
  return {
    fontSize:   s.fontSize !== '0px' ? s.fontSize : '32px',
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    lineHeight: s.lineHeight,
  };
}

// Create one positioned overlay div per Netflix subtitle line.
//
// Two-layer approach to solve the overflow/sizing problem:
//   outer: position:fixed, matches Netflix rect exactly, acts as anchor
//   inner: display:inline-block, sizes to its content (no wrapping issues)
//
// This is necessary because width:max-content on position:fixed is unreliable,
// and a fixed block element always stretches to 100vw.
function buildLineOverlay(lineEl) {
  const r = lineEl.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;

  const style     = getNetflixLineStyle(lineEl);
  const lineStyle = window.getComputedStyle(lineEl);
  const fs        = parseFloat(style.fontSize) || 32;
  const rtPad     = Math.round(fs * 0.65);
  const textAlign = lineStyle.textAlign || 'center';
  // Copy writing-mode from Netflix — side subs may use vertical-rl
  const writingMode = lineStyle.writingMode || 'horizontal-tb';
  // For vertical text the rt padding direction changes
  const isVertical  = writingMode.includes('vertical');
  const padStyle    = isVertical
    ? `padding-right:${rtPad}px`  // furigana sits to the right in vertical-rl
    : `padding-top:${rtPad}px`;   // furigana sits above in horizontal

  // Outer: fixed anchor at Netflix's position
  const outer = document.createElement('div');
  outer.style.cssText = [
    'position:fixed',
    `left:${r.left}px`,
    `top:${r.top}px`,
    `width:${r.width}px`,
    `height:${r.height}px`,
    'pointer-events:none',
    'display:flex',
    textAlign === 'center' ? 'justify-content:center' : 'justify-content:flex-start',
    'align-items:center',
    'overflow:visible',
  ].join(';');

  // Inner: inline-block so it sizes to content, not to container width
  const inner = document.createElement('div');
  inner.style.cssText = [
    'display:inline-block',
    `font-size:${style.fontSize}`,
    `font-family:${style.fontFamily}`,
    `font-weight:${style.fontWeight}`,
    `line-height:${style.lineHeight}`,
    `writing-mode:${writingMode}`,
    'color:#ffffff',
    `text-align:${textAlign}`,
    'text-shadow:#000000 0px 0px 7px',
    'pointer-events:auto',
    padStyle,
    'box-sizing:border-box',
    'white-space:nowrap',  // no wrapping inside the inner — each Netflix line is one line
  ].join(';');

  outer.appendChild(inner);
  // Return outer, but callers append content to inner via outer.firstChild
  outer._inner = inner;
  return outer;
}

let rendering = false;

async function renderSubtitles(container) {
  if (rendering) return;
  rendering = true;
  try {
    const lines = extractSubtitleLines(container);
    const key   = lines.map(l => l.text).join('\n');

    if (key === state.lastSubtitleKey) return;
    state.lastSubtitleKey = key;

    const overlay = state.overlayEl;
    if (!lines.length || !lines.some(l => /[\u3040-\u9FAF\u4E00-\u9FAF]/.test(l.text))) {
      overlay.innerHTML = '';
      setNativeHidden(false);
      return;
    }

    // Non-Japanese subtitles (e.g. Chinese): leave Netflix's own text alone
    if (!isJapaneseSubtitle(key)) {
      overlay.innerHTML = '';
      setNativeHidden(false);
      return;
    }
    setNativeHidden(true);

    const tokenizedLines = await Promise.all(lines.map(async l => {
      if (!/[\u3040-\u9FAF\u4E00-\u9FAF]/.test(l.text)) return { ...l, tokens: null };
      let tokens = renderCache.get(l.text);
      if (!tokens) {
        tokens = await tokenize(l.text);
        if (tokens.length) renderCache.set(l.text, tokens);
      }
      return { ...l, tokens };
    }));

    const newKey = extractSubtitleLines(container).map(l => l.text).join('\n');
    if (newKey !== key) return;

    overlay.innerHTML = '';

    for (const { text, tokens, el: netflixLineEl, rubyOverrides } of tokenizedLines) {
      const wrapper = buildLineOverlay(netflixLineEl);
      if (!wrapper) continue;
      const lineEl = tokens && tokens.length ? buildLineEl(tokens, rubyOverrides || new Map()) : (() => {
        const d = document.createElement('div');
        d.className = 'nj-line';
        d.textContent = text;
        return d;
      })();
      // Append content to inner div (sized to content), not outer (fixed anchor)
      (wrapper._inner || wrapper).appendChild(lineEl);
      overlay.appendChild(wrapper);
    }

    overlay.querySelectorAll('.nj-token').forEach(attachHover);

  } finally {
    rendering = false;
  }
}

// ─── Poll Loop ────────────────────────────────────────────────────────────────
function startPolling() {
  state.pollTimer = setInterval(() => {
    if (!state.tokenizerReady) return;
    const container = getNetflixSubtitleContainer();
    if (container) renderSubtitles(container);
    renderDualSubtitle();
  }, 200);
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function createTooltip() {
  const el = document.createElement('div');
  el.id = 'nj-tooltip';
  el.style.display = 'none';
  document.body.appendChild(el);
  state.tooltipEl = el;
  el.addEventListener('mouseenter', () => { state.hoveringTooltip = true; });
  el.addEventListener('mouseleave', () => { state.hoveringTooltip = false; hideTooltip(); });
  document.addEventListener('click', hideTooltip);
}

function showTooltip(data, cx, cy) {
  const el = state.tooltipEl;
  if (!el) return;
  const jlpt = data.jlpt ? `<span class="nj-jlpt nj-jlpt-${data.jlpt.toLowerCase()}">${data.jlpt}</span>` : '';
  const pos  = data.partsOfSpeech.map(p => `<span>${p}</span>`).join('');
  const defs = data.definitions.length
    ? data.definitions.map((d,i) =>
        `<div class="nj-def">
          <span class="nj-def-num">${i+1}</span>
          <span class="nj-def-text">${d.text}</span>
          ${d.info ? `<span class="nj-def-info">${d.info}</span>` : ''}
        </div>`).join('')
    : '<div class="nj-def nj-no-def">定義が見つかりませんでした</div>';

  el.innerHTML = `
    <div class="nj-tooltip-header">
      <span class="nj-word">${data.word}</span>
      ${data.reading ? `<span class="nj-reading">${data.reading}</span>` : ''}
      ${jlpt}
    </div>
    ${pos ? `<div class="nj-pos">${pos}</div>` : ''}
    <div class="nj-defs">${defs}</div>
    <div class="nj-tooltip-footer">Jisho辞書</div>`;

  el.style.display = 'block';
  const w = 320, h = el.offsetHeight || 180;
  let left = cx + 16, top = cy - h - 16;
  if (left + w > window.innerWidth - 8) left = cx - w - 8;
  if (top < 8) top = cy + 24;
  el.style.left = left + 'px';
  el.style.top  = top  + 'px';
}

function hideTooltip() {
  if (state.hoveringTooltip) return;
  if (state.tooltipEl) state.tooltipEl.style.display = 'none';
  state.activeToken = null;
}

function attachHover(tokenEl) {
  tokenEl.addEventListener('mouseenter', async (e) => {
    e.stopPropagation();
    const { surface, reading } = tokenEl.dataset;
    if (!surface) return;
    const cx = e.clientX, cy = e.clientY;
    state.activeToken = tokenEl;
    state.hoveringTooltip = false;
    state.tooltipEl.innerHTML = '<div class="nj-loading">読み込み中…</div>';
    state.tooltipEl.style.display = 'block';
    state.tooltipEl.style.left = (cx + 16) + 'px';
    state.tooltipEl.style.top  = (cy - 50) + 'px';
    const data = await lookupWord(surface, reading);
    if (state.activeToken !== tokenEl) return;
    showTooltip(data, cx, cy);
  });
  tokenEl.addEventListener('mouseleave', () => {
    setTimeout(() => { if (state.activeToken === tokenEl && !state.hoveringTooltip) hideTooltip(); }, 150);
  });
}

// ─── Furigana Toggle ─────────────────────────────────────────────────────────
function toggleFurigana() {
  state.furiganaVisible = !state.furiganaVisible;
  document.documentElement.classList.toggle('nj-furigana-hidden', !state.furiganaVisible);
  let hud = document.getElementById('nj-hud');
  if (!hud) { hud = document.createElement('div'); hud.id = 'nj-hud'; document.body.appendChild(hud); }
  hud.textContent = state.furiganaVisible ? 'ふりがな ON' : 'ふりがな OFF';
  hud.classList.add('nj-hud-show');
  setTimeout(() => hud.classList.remove('nj-hud-show'), 1500);
  chrome.storage.local.set({ furiganaVisible: state.furiganaVisible });
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey ||
      ['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (e.key === 'f') toggleFurigana();
  else if (e.key === 'j') setDualEnabled(!state.dualEnabled, true);
});

// Popup toggles
chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === 'SET_DUAL') {
    setDualEnabled(!!msg.value, false);
  } else if (msg?.type === 'SET_FURIGANA') {
    state.furiganaVisible = !!msg.value;
    document.documentElement.classList.toggle('nj-furigana-hidden', !state.furiganaVisible);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  console.log('[NJ] Booting...');
  chrome.storage.local.get(['furiganaVisible', 'dualSubsEnabled'], r => {
    if (r.furiganaVisible === false) {
      state.furiganaVisible = false;
      document.documentElement.classList.add('nj-furigana-hidden');
    }
    state.dualEnabled = r.dualSubsEnabled === true;
  });
  createTooltip();
  createOverlay();
  createDualEl();
  try {
    await initWorker();
  } catch(e) {
    console.error('[NJ] Worker failed:', e);
    return;
  }
  startPolling();
  console.log('[NJ] Ready! Press F to toggle furigana.');
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', boot)
  : boot();

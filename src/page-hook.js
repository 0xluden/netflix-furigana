/**
 * Netflix Furigana - Page Hook (runs in MAIN world at document_start)
 *
 * Runs in the page's own JS context, before Netflix's player scripts, to:
 *   1. Hook JSON.stringify so manifest requests ask for the WebVTT subtitle
 *      profile ('webvtt-lssdh-ios8') in addition to Netflix's defaults.
 *   2. Hook JSON.parse to capture manifest responses, which list ALL available
 *      subtitle tracks (timedtexttracks) with direct download URLs.
 *   3. Report the currently selected subtitle track language via Netflix's
 *      internal player API (best-effort; content script has a fallback).
 *   4. Fetch subtitle files on request — page context is allowed by Netflix's
 *      CSP to reach *.nflxvideo.net, unlike the content script.
 *
 * Communicates with the content script via window.postMessage using
 * { nj: true, type, ... } envelopes. (Same technique as Subadub.)
 */
(() => {
  'use strict';

  const WEBVTT_FMT = 'webvtt-lssdh-ios8';
  // Strings that identify Netflix's media-profile arrays inside request payloads
  const KNOWN_PROFILES = ['heaac-2-dash', 'playready-h264mpl30-dash', 'dfxp-ls-sdh', 'simplesdh', 'nflx-cmisc'];

  const trackListsByMovie = new Map(); // movieId -> [{id, language, languageDescription, isClosedCaptions, url}]

  function post(msg) {
    window.postMessage(Object.assign({ nj: true }, msg), '*');
  }

  // ── JSON.stringify hook: request the WebVTT profile ──────────────────────
  function findProfilesArrays(value, out, depth) {
    if (!value || typeof value !== 'object' || depth > 8) return;
    if (Array.isArray(value)) {
      if (value.some(v => typeof v === 'string' && KNOWN_PROFILES.includes(v))) {
        out.push(value);
      } else {
        for (const v of value) findProfilesArrays(v, out, depth + 1);
      }
      return;
    }
    for (const k of Object.keys(value)) findProfilesArrays(value[k], out, depth + 1);
  }

  const origStringify = JSON.stringify;
  JSON.stringify = function (value) {
    try {
      const arrays = [];
      findProfilesArrays(value, arrays, 0);
      for (const arr of arrays) {
        if (!arr.includes(WEBVTT_FMT)) arr.unshift(WEBVTT_FMT);
      }
    } catch (_) {}
    return origStringify.apply(this, arguments);
  };

  // ── JSON.parse hook: capture manifests with timedtexttracks ──────────────
  function extractTrackUrl(track) {
    const dl = track.ttDownloadables && track.ttDownloadables[WEBVTT_FMT];
    if (!dl) return null;
    // Manifest versions differ: downloadUrls is an object map, urls is [{url}]
    if (dl.downloadUrls && typeof dl.downloadUrls === 'object') {
      const urls = Object.values(dl.downloadUrls);
      if (urls.length) return urls[0];
    }
    if (Array.isArray(dl.urls) && dl.urls.length) {
      return dl.urls[0].url || dl.urls[0];
    }
    return null;
  }

  function handleManifest(result) {
    const movieId = String(result.movieId);
    const tracks = [];
    for (const track of result.timedtexttracks) {
      if (track.isNoneTrack || track.isForcedNarrative) continue;
      const url = extractTrackUrl(track);
      if (!url) continue;
      tracks.push({
        id: track.new_track_id || track.id || null,
        language: track.language || null,
        languageDescription: track.languageDescription || '',
        isClosedCaptions: track.rawTrackType === 'closedcaptions',
        url,
      });
    }
    trackListsByMovie.set(movieId, tracks);
    post({ type: 'TRACKS', movieId, tracks });
  }

  const origParse = JSON.parse;
  JSON.parse = function () {
    const value = origParse.apply(this, arguments);
    try {
      if (value && value.result && value.result.movieId && Array.isArray(value.result.timedtexttracks)) {
        handleManifest(value.result);
      }
    } catch (_) {}
    return value;
  };

  // ── Selected track polling (best-effort, internal API) ───────────────────
  let lastSelectedLang;
  setInterval(() => {
    try {
      const videoPlayer = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const sessionIds = videoPlayer.getAllPlayerSessionIds();
      if (!sessionIds.length) return;
      const player = videoPlayer.getVideoPlayerBySessionId(sessionIds[0]);
      const track = player.getTimedTextTrack();
      // trackId 'off' / bcp47 null when subtitles are disabled
      const lang = (track && track.bcp47) || 'off';
      if (lang !== lastSelectedLang) {
        lastSelectedLang = lang;
        post({ type: 'SELECTED_TRACK', bcp47: lang });
      }
    } catch (_) {
      // Internal API unavailable or changed — content script uses its heuristic
    }
  }, 1000);

  // ── Subtitle fetch on behalf of the content script ────────────────────────
  window.addEventListener('message', evt => {
    if (evt.source !== window || !evt.data || !evt.data.nj) return;
    if (evt.data.type !== 'FETCH_TRACK') return;
    const { url, movieId } = evt.data;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(text => post({ type: 'TRACK_VTT', movieId, text }))
      .catch(err => post({ type: 'TRACK_VTT_ERROR', movieId, error: String(err) }));
  });

  console.log('[NJ] Page hook installed');
})();

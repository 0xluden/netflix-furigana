// Background service worker — handles Jisho API requests to bypass Netflix's CSP
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'JISHO_LOOKUP') {
    fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(msg.word)}`)
      .then(r => r.ok ? r.json() : null)
      .then(json => sendResponse({ ok: true, json }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async response
  }
});

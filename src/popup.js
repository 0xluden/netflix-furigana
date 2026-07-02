// Popup script — syncs toggles with chrome.storage

const furiganaToggle = document.getElementById('toggle-furigana');
const tooltipToggle = document.getElementById('toggle-tooltip');
const dualToggle = document.getElementById('toggle-dual');
const statusEl = document.getElementById('status');

// Load saved prefs
chrome.storage.local.get(['furiganaVisible', 'tooltipEnabled', 'dualSubsEnabled'], (result) => {
  furiganaToggle.checked = result.furiganaVisible !== false;
  tooltipToggle.checked = result.tooltipEnabled !== false;
  dualToggle.checked = result.dualSubsEnabled === true; // off by default
});

// Save on change and message content script
furiganaToggle.addEventListener('change', () => {
  const val = furiganaToggle.checked;
  chrome.storage.local.set({ furiganaVisible: val });
  sendToContent({ type: 'SET_FURIGANA', value: val });
});

tooltipToggle.addEventListener('change', () => {
  const val = tooltipToggle.checked;
  chrome.storage.local.set({ tooltipEnabled: val });
  sendToContent({ type: 'SET_TOOLTIP', value: val });
});

dualToggle.addEventListener('change', () => {
  const val = dualToggle.checked;
  chrome.storage.local.set({ dualSubsEnabled: val });
  sendToContent({ type: 'SET_DUAL', value: val });
});

function sendToContent(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, message).catch(() => {});
    }
  });
}

// Show active status
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && tabs[0].url && tabs[0].url.includes('netflix.com')) {
    statusEl.innerHTML = 'アクティブ <span>●</span>';
  } else {
    statusEl.innerHTML = '<span style="color:#e57373">●</span> Netflixで開いてください';
  }
});

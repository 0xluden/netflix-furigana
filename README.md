# 🎌 Netflix Japanese

A Chrome extension to learn Japanese while watching Netflix — furigana above kanji, hover tooltips with definitions, JLPT levels, and parts of speech.

---

## ⚠️ Required First Step — Bundle Kuromoji

Netflix blocks external CDN scripts via its Content Security Policy. You **must** bundle Kuromoji locally before the extension works. Open a terminal in this folder and run:

```bash
npm install kuromoji
cp node_modules/kuromoji/build/kuromoji.js src/kuromoji.js
cp -r node_modules/kuromoji/dict dict
```

This copies the tokenizer (~2MB) and dictionary files into the extension. Do this once.

---

## 🚀 Install in Chrome

1. Complete the **Required First Step** above
2. Open Chrome → `chrome://extensions`
3. Enable **Developer Mode** (top-right toggle)
4. Click **Load unpacked** → select this folder
5. Open Netflix, play a show with Japanese subtitles
6. Hover any word to see its definition. Press **`F`** to toggle furigana!

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `F` | Toggle furigana on/off |
| `Esc` | Close tooltip |

---

## 🔧 How It Works

```
Netflix Subtitle DOM
        │
        ▼
 MutationObserver (watches for subtitle changes)
        │
        ▼
  Kuromoji.js (local bundle — CSP safe)
  Splits Japanese text into words + readings
        │
        ▼
  <ruby> tags wrap kanji with <rt> furigana
        │
        ▼
  Hover → Jisho API lookup
  (definitions, JLPT, parts of speech)
        │
        ▼
  Tooltip displayed near hovered word
```

### If subtitles stop being processed

Netflix occasionally changes their player DOM. If it breaks, open DevTools on Netflix, inspect the subtitle text element, and update `SUBTITLE_SELECTORS` in `src/content.js` to match the new class names.

---

## 📚 Dictionary

Definitions come from the [Jisho.org API](https://jisho.org) (JMdict — 200k+ entries). Results are cached per session so each word is only fetched once.

---

## 🗂 File Structure

```
netflix-japanese/
├── manifest.json
├── dict/                  ← Created by npm install step
├── src/
│   ├── kuromoji.js        ← Created by npm install step
│   ├── kuromoji-bundle.js
│   ├── content.js
│   ├── content.css
│   ├── popup.html
│   └── popup.js
└── icons/
```

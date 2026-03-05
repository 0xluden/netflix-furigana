/**
 * tokenizer-worker.js
 * Runs kuromoji entirely off the main thread so Netflix never freezes.
 */

importScripts(self.kuromojiUrl); // injected before worker creation

let tokenizer = null;

self.onmessage = function (e) {
  const { type, id, payload } = e.data;

  if (type === 'INIT') {
    kuromoji.builder({ dicPath: payload.dicPath })
      .build((err, tok) => {
        if (err) {
          self.postMessage({ type: 'INIT_ERROR', error: String(err) });
          return;
        }
        tokenizer = tok;
        self.postMessage({ type: 'INIT_OK' });
      });
    return;
  }

  if (type === 'TOKENIZE') {
    if (!tokenizer) {
      self.postMessage({ type: 'TOKENIZE_RESULT', id, tokens: [] });
      return;
    }
    try {
      const tokens = tokenizer.tokenize(payload.text);
      self.postMessage({ type: 'TOKENIZE_RESULT', id, tokens });
    } catch (err) {
      self.postMessage({ type: 'TOKENIZE_RESULT', id, tokens: [] });
    }
    return;
  }
};

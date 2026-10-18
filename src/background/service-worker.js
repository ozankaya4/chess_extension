// Relays analysis requests from content scripts to the offscreen document,
// creating that document on demand. The engine itself never runs here.

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

let offscreenCreationPromise = null;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });
  if (existingContexts.length > 0) return;

  // Only one offscreen document may exist; share a single in-flight creation.
  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Run the Stockfish WASM chess engine in a Web Worker.',
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }
  await offscreenCreationPromise;
}

async function relayAnalysisRequest(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'analyse-position',
    fen: message.fen,
    options: message.options ?? {},
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return false;

  if (message.type === 'analyse-position') {
    relayAnalysisRequest(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ status: 'error', errorMessage: String(error?.message ?? error) }));
    return true; // Keep the channel open for the async response.
  }

  return false;
});

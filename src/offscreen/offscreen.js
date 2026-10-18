import { StockfishEngine, isAnalysisCancelledError } from '../engine/stockfish-engine.js';

const STOCKFISH_WORKER_PATH = 'vendor/stockfish/stockfish-19-lite-single.js';

const engine = new StockfishEngine(chrome.runtime.getURL(STOCKFISH_WORKER_PATH));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Content-script messages for the background also reach this page; ignore them.
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'analyse-position') {
    engine
      .analysePosition(message.fen, message.options)
      .then((analysisResult) => sendResponse({ status: 'ok', result: analysisResult }))
      .catch((error) => {
        if (isAnalysisCancelledError(error)) {
          sendResponse({ status: 'cancelled' });
        } else {
          sendResponse({ status: 'error', errorMessage: String(error?.message ?? error) });
        }
      });
    return true; // Keep the channel open for the async response.
  }

  return false;
});

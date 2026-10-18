# Lichess Stockfish Helper

An open-source Chrome extension (Manifest V3) that runs Stockfish locally, as WebAssembly, to analyse positions on the Lichess analysis board (lichess.org/analysis). Nothing is sent to remote servers.

**Status: foundation only.** The extension reads the current position, analyses it, and logs the evaluation and best move to the page's DevTools console. The evaluation bar, move arrows and Elo-limited suggestions will come later.

## Project layout

```
manifest.json
src/
  background/service-worker.js   Creates the offscreen document and relays analysis requests
  offscreen/offscreen.html|js    Hidden extension page that hosts the Stockfish Web Worker
  engine/stockfish-engine.js     UCI wrapper: analysePosition(fen, options) -> Promise
  content/page-bridge.js         MAIN-world script that reads Lichess's own FEN
  content/position-reader.js     Gets a validated full FEN (page controller first, FEN box as fallback)
  content/content-script.js      MutationObserver + debounce, sends positions, logs results
vendor/stockfish/                Stockfish 19 "lite single-threaded" WASM build (npm "stockfish" 19.0.1)
```

How a message flows:

```
content script ──runtime message──▶ service worker ──runtime message──▶ offscreen document
                                                                         └─ Web Worker (Stockfish WASM)
```

## Load it in Chrome (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this folder (the one containing `manifest.json`).
4. Open https://lichess.org/analysis, then open DevTools (F12) and go to **Console**.
5. You should see lines like:
   ```
   [Lichess Stockfish] depth 18 | eval +0.31 (White's view) | best move e2e4  {fen: ..., principalVariation: ...}
   ```
6. Make a move or step through moves with the arrow keys. A new line is logged for each new position. If you move again before a search finishes, the old search is stopped and only the newest position is reported.

After you edit the code, click the reload icon on the extension's card in `chrome://extensions`, then refresh the Lichess tab.

To see the engine's own page, click **offscreen.html** under "Inspect views" on the extension's card. The service worker can be inspected from the same place.

Requires Chrome 116 or newer.

## Engine API

```js
import { StockfishEngine } from './src/engine/stockfish-engine.js';

const engine = new StockfishEngine(chrome.runtime.getURL('vendor/stockfish/stockfish-19-lite-single.js'));
const result = await engine.analysePosition(fen, { depth: 18 /* or movetimeMs: 1000 */ });
// result: { fen, sideToMove, bestMove, ponderMove, depth,
//           evaluation: { type: 'cp' | 'mate', value } /* White's point of view */,
//           principalVariation: [...] }
```

Calling `analysePosition` while a search is running sends `stop`, waits for that search's `bestmove`, and rejects its promise with `AnalysisCancelledError`. Only then does it send the new `position` and `go`.

## Known limitations

- A single engine is shared by every tab, so analysing in two Lichess tabs at once makes them cancel each other.
- Only lichess.org/analysis is supported. Study pages are disabled until there is a reliable full-FEN source for them (their FEN is only in the DOM while the Share tab is open).
- The FEN is never guessed. If no complete, valid FEN can be read, analysis is skipped and a warning is logged.
- Variants other than standard chess (including Chess960) are skipped for now.

## License

GPL-3.0. See [LICENSE](LICENSE). Stockfish and Stockfish.js are also GPL-3.0; their license is in `vendor/stockfish/Copying.txt`.

// Thin UCI wrapper around a Stockfish Web Worker.
//
// Only one search runs at a time. Starting a new analysis while another is in
// progress sends "stop", waits for the old search's "bestmove" (so its output
// can never be mistaken for the new search's), rejects the old promise with an
// AnalysisCancelledError, and only then sends the new "position" + "go".

const DEFAULT_SEARCH_DEPTH = 18;

export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis was cancelled because a newer position was requested.');
    this.name = 'AnalysisCancelledError';
  }
}

export function isAnalysisCancelledError(error) {
  return error instanceof AnalysisCancelledError;
}

export class StockfishEngine {
  #workerUrl;
  #worker = null;
  #readyPromise = null;
  #pendingHandshake = null;
  #activeSearch = null;
  #queuedSearch = null;

  constructor(workerUrl) {
    this.#workerUrl = workerUrl;
  }

  /**
   * Analyse a position.
   * @param {string} fenString Full six-field FEN.
   * @param {{ depth?: number, movetimeMs?: number }} [options]
   * @returns {Promise<{
   *   fen: string,
   *   bestMove: string | null,
   *   ponderMove: string | null,
   *   depth: number,
   *   evaluation: { type: 'cp' | 'mate', value: number } | null,
   *   principalVariation: string[],
   * }>} evaluation.value is from White's point of view.
   */
  analysePosition(fenString, options = {}) {
    return new Promise((resolve, reject) => {
      const searchRequest = {
        fen: fenString,
        options,
        resolve,
        reject,
        cancelled: false,
        latestInfo: null,
      };

      // A request still waiting in the queue is now obsolete.
      if (this.#queuedSearch) {
        this.#queuedSearch.reject(new AnalysisCancelledError());
      }
      this.#queuedSearch = searchRequest;

      if (this.#activeSearch) {
        if (!this.#activeSearch.cancelled) {
          this.#activeSearch.cancelled = true;
          this.#send('stop');
        }
        // The queued search starts once the stopped search emits "bestmove".
      } else {
        this.#startQueuedSearch().catch((error) => this.#failAllSearches(error));
      }
    });
  }

  terminate() {
    this.#failAllSearches(new Error('Engine terminated.'));
    this.#worker?.terminate();
    this.#worker = null;
    this.#readyPromise = null;
  }

  #ensureReady() {
    if (!this.#readyPromise) {
      this.#readyPromise = this.#startWorker();
    }
    return this.#readyPromise;
  }

  async #startWorker() {
    this.#worker = new Worker(this.#workerUrl);
    this.#worker.addEventListener('message', (messageEvent) => this.#handleEngineLine(String(messageEvent.data)));
    this.#worker.addEventListener('error', (errorEvent) => {
      const engineError = new Error(`Stockfish worker error: ${errorEvent.message || 'unknown error'}`);
      this.#pendingHandshake?.reject(engineError);
      this.#failAllSearches(engineError);
      this.#readyPromise = null;
    });

    await this.#sendAndWaitFor('uci', 'uciok');
    await this.#sendAndWaitFor('isready', 'readyok');
  }

  #sendAndWaitFor(command, expectedLine) {
    return new Promise((resolve, reject) => {
      this.#pendingHandshake = { expectedLine, resolve, reject };
      this.#send(command);
    });
  }

  async #startQueuedSearch() {
    await this.#ensureReady();
    // Another call may have started a search while we awaited readiness.
    if (this.#activeSearch || !this.#queuedSearch) return;

    const searchRequest = this.#queuedSearch;
    this.#queuedSearch = null;
    this.#activeSearch = searchRequest;

    this.#send(`position fen ${searchRequest.fen}`);
    this.#send(buildGoCommand(searchRequest.options));
  }

  #handleEngineLine(engineLine) {
    if (this.#pendingHandshake && engineLine.trim() === this.#pendingHandshake.expectedLine) {
      const handshake = this.#pendingHandshake;
      this.#pendingHandshake = null;
      handshake.resolve();
      return;
    }

    if (!this.#activeSearch) return;

    if (engineLine.startsWith('info ')) {
      const parsedInfo = parseInfoLine(engineLine);
      if (parsedInfo) this.#activeSearch.latestInfo = parsedInfo;
      return;
    }

    if (engineLine.startsWith('bestmove')) {
      const finishedSearch = this.#activeSearch;
      this.#activeSearch = null;

      if (finishedSearch.cancelled) {
        finishedSearch.reject(new AnalysisCancelledError());
      } else {
        finishedSearch.resolve(buildResult(finishedSearch, engineLine));
      }

      if (this.#queuedSearch) {
        this.#startQueuedSearch().catch((error) => this.#failAllSearches(error));
      }
    }
  }

  #failAllSearches(error) {
    for (const searchRequest of [this.#activeSearch, this.#queuedSearch]) {
      searchRequest?.reject(error);
    }
    this.#activeSearch = null;
    this.#queuedSearch = null;
  }

  #send(command) {
    this.#worker?.postMessage(command);
  }
}

function buildGoCommand(options) {
  const commandParts = ['go'];
  const hasMovetime = Number.isFinite(options.movetimeMs) && options.movetimeMs > 0;
  const hasDepth = Number.isFinite(options.depth) && options.depth > 0;

  if (hasDepth || !hasMovetime) {
    commandParts.push('depth', String(hasDepth ? Math.floor(options.depth) : DEFAULT_SEARCH_DEPTH));
  }
  if (hasMovetime) {
    commandParts.push('movetime', String(Math.floor(options.movetimeMs)));
  }
  return commandParts.join(' ');
}

// Parses e.g. "info depth 12 seldepth 18 multipv 1 score cp 34 nodes 1234 ... pv e2e4 e7e5".
// Returns null for lines without a usable score (e.g. "info string ...", "currmove" updates,
// lowerbound/upperbound aspiration results, or secondary MultiPV lines).
function parseInfoLine(engineLine) {
  const tokens = engineLine.trim().split(/\s+/);
  const parsedInfo = { depth: 0, score: null, principalVariation: [] };
  let isBoundScore = false;
  let multiPvIndex = 1;

  for (let tokenIndex = 1; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token === 'string') return null;
    if (token === 'depth') {
      parsedInfo.depth = Number(tokens[++tokenIndex]);
    } else if (token === 'multipv') {
      multiPvIndex = Number(tokens[++tokenIndex]);
    } else if (token === 'score') {
      const scoreType = tokens[++tokenIndex];
      const scoreValue = Number(tokens[++tokenIndex]);
      if (scoreType === 'cp' || scoreType === 'mate') {
        parsedInfo.score = { type: scoreType, value: scoreValue };
      }
    } else if (token === 'lowerbound' || token === 'upperbound') {
      isBoundScore = true;
    } else if (token === 'pv') {
      parsedInfo.principalVariation = tokens.slice(tokenIndex + 1);
      break;
    }
  }

  if (!parsedInfo.score || isBoundScore || multiPvIndex !== 1) return null;
  return parsedInfo;
}

function buildResult(finishedSearch, bestMoveLine) {
  // "bestmove e2e4 ponder e7e5" or "bestmove (none)" when there is no legal move.
  const bestMoveTokens = bestMoveLine.trim().split(/\s+/);
  const bestMove = bestMoveTokens[1] && bestMoveTokens[1] !== '(none)' ? bestMoveTokens[1] : null;
  const ponderIndex = bestMoveTokens.indexOf('ponder');
  const ponderMove = ponderIndex !== -1 ? bestMoveTokens[ponderIndex + 1] ?? null : null;

  const latestInfo = finishedSearch.latestInfo;
  const sideToMove = finishedSearch.fen.split(/\s+/)[1] === 'b' ? 'black' : 'white';

  // UCI scores are relative to the side to move; normalise to White's perspective
  // so later UI (eval bar) does not need to know whose turn it is.
  let evaluation = null;
  if (latestInfo?.score) {
    const perspectiveMultiplier = sideToMove === 'white' ? 1 : -1;
    evaluation = {
      type: latestInfo.score.type,
      value: latestInfo.score.value * perspectiveMultiplier,
    };
  }

  return {
    fen: finishedSearch.fen,
    sideToMove,
    bestMove,
    ponderMove,
    depth: latestInfo?.depth ?? 0,
    evaluation,
    principalVariation: latestInfo?.principalVariation ?? [],
  };
}

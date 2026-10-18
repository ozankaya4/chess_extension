// Watches the Lichess analysis board, and whenever the position changes asks
// the extension's Stockfish engine to analyse it, logging the result.
(() => {
  const LOG_PREFIX = '[Lichess Stockfish]';
  const POSITION_CHANGE_DEBOUNCE_MS = 200;
  const ANALYSIS_OPTIONS = { depth: 18 };
  // Stockfish only plays standard chess (Chess960 needs extra UCI setup, not done yet).
  const SUPPORTED_VARIANTS = new Set(['standard', 'fromPosition']);

  let lastRequestedFen = null;
  let lastWarningMessage = null;
  let debounceTimerId = null;

  function isAllowedAnalysisPage(pageLocation) {
    // TODO: Study pages (/study/...) are disabled because their FEN is only in the
    // DOM while the "Share" tab is open. Re-enable them (here and in manifest.json
    // "matches") once we have a reliable full-FEN source for studies.
    if (pageLocation.hostname !== 'lichess.org') return false;
    return pageLocation.pathname === '/analysis' || pageLocation.pathname.startsWith('/analysis/');
  }

  // Warn once per distinct problem so a stuck page does not flood the console.
  function warnOnce(warningMessage) {
    if (warningMessage === lastWarningMessage) return;
    lastWarningMessage = warningMessage;
    console.warn(LOG_PREFIX, warningMessage);
  }

  function formatEvaluation(evaluation) {
    if (!evaluation) return 'n/a';
    if (evaluation.type === 'mate') {
      return evaluation.value === 0 ? 'checkmate' : `#${evaluation.value}`;
    }
    const pawnUnits = evaluation.value / 100;
    return `${pawnUnits >= 0 ? '+' : ''}${pawnUnits.toFixed(2)}`;
  }

  async function analyseCurrentPosition() {
    if (!isAllowedAnalysisPage(window.location)) return;

    const currentPosition = globalThis.LichessPositionReader.readCurrentPosition();
    if (currentPosition.status !== 'ok') {
      warnOnce(`No reliable full FEN available, skipping analysis (${currentPosition.reason}).`);
      return;
    }
    lastWarningMessage = null;

    if (currentPosition.fen === lastRequestedFen) return;
    lastRequestedFen = currentPosition.fen;

    if (!SUPPORTED_VARIANTS.has(currentPosition.variant)) {
      console.info(LOG_PREFIX, `Variant "${currentPosition.variant}" is not supported; skipping.`);
      return;
    }

    console.debug(LOG_PREFIX, `Analysing (FEN from ${currentPosition.source}):`, currentPosition.fen);

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        target: 'background',
        type: 'analyse-position',
        fen: currentPosition.fen,
        options: ANALYSIS_OPTIONS,
      });
    } catch (error) {
      // Typically "Extension context invalidated" after reloading the extension; refresh the tab.
      console.warn(LOG_PREFIX, 'Could not reach the extension:', error?.message ?? error);
      return;
    }

    if (!response) return;
    if (response.status === 'cancelled') return; // Superseded by a newer position.
    if (response.status === 'error') {
      console.error(LOG_PREFIX, 'Engine error:', response.errorMessage);
      return;
    }

    const analysisResult = response.result;
    // Ignore results that arrive after the user has already moved on.
    if (analysisResult.fen !== lastRequestedFen) return;

    console.log(
      LOG_PREFIX,
      `depth ${analysisResult.depth} | eval ${formatEvaluation(analysisResult.evaluation)} (White's view)` +
        ` | best move ${analysisResult.bestMove ?? '(none: checkmate or stalemate)'}`,
      { fen: analysisResult.fen, principalVariation: analysisResult.principalVariation.join(' ') },
    );
  }

  function scheduleAnalysis() {
    clearTimeout(debounceTimerId);
    debounceTimerId = setTimeout(analyseCurrentPosition, POSITION_CHANGE_DEBOUNCE_MS);
  }

  if (!isAllowedAnalysisPage(window.location)) return;

  // Lichess re-renders the board (<cg-board> piece nodes and their transforms)
  // and the move list on every position change. The debounce plus the FEN
  // comparison keeps observing the whole page cheap.
  const positionObserver = new MutationObserver(scheduleAnalysis);
  positionObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });

  scheduleAnalysis();
})();

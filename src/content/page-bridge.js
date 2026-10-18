// Runs in the page's MAIN world (see manifest.json) so it can read Lichess's
// own analysis controller, which isolated content scripts cannot see.
//
// Lichess assigns its AnalyseCtrl to `window.site.analysis` (lila:
// ui/analyse/src/start.ts). `ctrl.node.fen` is the full six-field FEN of the
// node currently shown on the /analysis board.
//
// The isolated content script asks for the position by dispatching a DOM
// event; we answer with another DOM event. dispatchEvent is synchronous, so
// the answer arrives before the request call returns.
(() => {
  const REQUEST_EVENT_NAME = 'lichess-stockfish-helper:request-position';
  const RESPONSE_EVENT_NAME = 'lichess-stockfish-helper:position';

  document.addEventListener(REQUEST_EVENT_NAME, () => {
    let positionSnapshot = null;
    try {
      const analysisController = window.site?.analysis;
      const currentFen = analysisController?.node?.fen;
      if (typeof currentFen === 'string') {
        positionSnapshot = {
          fen: currentFen,
          variant: analysisController.data?.game?.variant?.key ?? null,
        };
      }
    } catch {
      positionSnapshot = null;
    }

    // Send a plain string: only primitives cross the MAIN/isolated world boundary reliably.
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT_NAME, { detail: positionSnapshot ? JSON.stringify(positionSnapshot) : '' }),
    );
  });
})();

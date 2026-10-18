// Reads the current Lichess board position as a full FEN.
//
// Why this approach (checked against the lila source, ui/analyse):
//
// 1. Primary: Lichess's own analysis controller (`window.site.analysis.node.fen`),
//    read through page-bridge.js. It is the exact FEN Lichess uses internally,
//    so side to move, castling rights, en passant and move counters are all
//    correct, and it works identically on /analysis and /study pages.
//
// 2. Fallback: the FEN text input Lichess renders under the board. On
//    /analysis it is `.analyse__underboard .copyables` (label "FEN" + input);
//    on server-analysed games it is `.analyse__underboard__fen input`; on
//    studies it only exists while the "Share" tab is open. Lichess sets the
//    input's `.value` property (not the attribute), so we read `.value`.
//
// We deliberately do NOT rebuild the FEN from the <piece> elements in
// <cg-board>: the board DOM has no side to move, castling or en passant
// information, so a reconstructed FEN would be guesswork.
(() => {
  const REQUEST_EVENT_NAME = 'lichess-stockfish-helper:request-position';
  const RESPONSE_EVENT_NAME = 'lichess-stockfish-helper:position';

  // Piece placement, side to move, castling (standard or Shredder/X-FEN letters),
  // en passant, halfmove clock, fullmove number.
  const FULL_FEN_PATTERN =
    /^([pnbrqkPNBRQK1-8]+\/){7}[pnbrqkPNBRQK1-8]+ [wb] (-|[KQkqA-Ha-h]{1,4}) (-|[a-h][36]) \d+ \d+$/;

  function isFullFen(candidateFen) {
    return typeof candidateFen === 'string' && FULL_FEN_PATTERN.test(candidateFen.trim());
  }

  function readFromPageBridge() {
    let rawResponse = '';
    const handleResponse = (responseEvent) => {
      rawResponse = typeof responseEvent.detail === 'string' ? responseEvent.detail : '';
    };

    document.addEventListener(RESPONSE_EVENT_NAME, handleResponse, { once: true });
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT_NAME));
    document.removeEventListener(RESPONSE_EVENT_NAME, handleResponse);

    if (!rawResponse) return null;
    try {
      const positionSnapshot = JSON.parse(rawResponse);
      if (!isFullFen(positionSnapshot.fen)) return null;
      return { fen: positionSnapshot.fen.trim(), variant: positionSnapshot.variant ?? null, source: 'page-controller' };
    } catch {
      return null;
    }
  }

  function readFromFenInput() {
    const analysisRoot = document.querySelector('main.analyse') ?? document;
    const candidateInputs = [
      ...analysisRoot.querySelectorAll('.analyse__underboard__fen input'),
      ...[...analysisRoot.querySelectorAll('label')]
        .filter((labelElement) => labelElement.textContent.trim() === 'FEN')
        .map((labelElement) => labelElement.parentElement?.querySelector('input'))
        .filter(Boolean),
    ];

    for (const inputElement of candidateInputs) {
      // While the user is typing into the editable FEN box, its value is not the board position.
      if (inputElement === document.activeElement) continue;
      if (isFullFen(inputElement.value)) {
        return { fen: inputElement.value.trim(), variant: null, source: 'fen-input' };
      }
    }
    return null;
  }

  globalThis.LichessPositionReader = {
    /** @returns {{ fen: string, variant: string | null, source: string } | null} */
    readCurrentPosition() {
      return readFromPageBridge() ?? readFromFenInput();
    },
  };
})();

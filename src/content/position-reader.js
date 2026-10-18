// Reads the current position on lichess.org/analysis as a full FEN.
//
// Why this approach (checked against the lila source, ui/analyse):
//
// 1. Primary: Lichess's own analysis controller (`window.site.analysis.node.fen`),
//    read through page-bridge.js. It is the exact FEN Lichess uses internally,
//    so side to move, castling rights, en passant and move counters are all
//    authoritative rather than inferred.
//
// 2. Fallback: the FEN text box Lichess always shows under the /analysis board
//    (`.analyse__underboard .copyables`, label "FEN" + input). Lichess sets the
//    input's `.value` property (not the attribute), so we read `.value`. The
//    variant comes from the `variant-<key>` class Lichess puts on `main.analyse`.
//
// No part of the FEN is ever guessed. We do NOT rebuild it from the <piece>
// elements in <cg-board>, because the board DOM has no side to move, castling
// or en passant information. If neither source yields a FEN that passes strict
// validation, we return an "unavailable" result and the caller skips analysis.
(() => {
  const REQUEST_EVENT_NAME = 'lichess-stockfish-helper:request-position';
  const RESPONSE_EVENT_NAME = 'lichess-stockfish-helper:position';

  const PIECE_PLACEMENT_RANK_PATTERN = /^[pnbrqkPNBRQK1-8]+$/;
  const CASTLING_PATTERN = /^(-|K?Q?k?q?)$/;
  const NON_NEGATIVE_INTEGER_PATTERN = /^\d+$/;

  // Returns null when the FEN is complete and well-formed, otherwise a reason string.
  function findFenProblem(candidateFen) {
    if (typeof candidateFen !== 'string') return 'no FEN text';

    const fenFields = candidateFen.trim().split(/\s+/);
    if (fenFields.length !== 6) return `expected 6 FEN fields, got ${fenFields.length}`;
    const [piecePlacement, sideToMove, castlingRights, enPassantSquare, halfmoveClock, fullmoveNumber] = fenFields;

    const ranks = piecePlacement.split('/');
    if (ranks.length !== 8) return `expected 8 ranks, got ${ranks.length}`;
    for (const rankText of ranks) {
      if (!PIECE_PLACEMENT_RANK_PATTERN.test(rankText)) return `invalid characters in rank "${rankText}"`;
      let squareCount = 0;
      for (const rankCharacter of rankText) {
        squareCount += /\d/.test(rankCharacter) ? Number(rankCharacter) : 1;
      }
      if (squareCount !== 8) return `rank "${rankText}" does not cover 8 squares`;
    }
    const whiteKingCount = piecePlacement.split('K').length - 1;
    const blackKingCount = piecePlacement.split('k').length - 1;
    if (whiteKingCount !== 1 || blackKingCount !== 1) return 'each side must have exactly one king';

    if (sideToMove !== 'w' && sideToMove !== 'b') return `invalid side to move "${sideToMove}"`;
    if (castlingRights === '' || !CASTLING_PATTERN.test(castlingRights)) {
      return `invalid castling field "${castlingRights}"`;
    }

    const expectedEnPassantRank = sideToMove === 'w' ? '6' : '3';
    if (enPassantSquare !== '-' && !new RegExp(`^[a-h]${expectedEnPassantRank}$`).test(enPassantSquare)) {
      return `invalid en passant square "${enPassantSquare}"`;
    }

    if (!NON_NEGATIVE_INTEGER_PATTERN.test(halfmoveClock)) return `invalid halfmove clock "${halfmoveClock}"`;
    if (!NON_NEGATIVE_INTEGER_PATTERN.test(fullmoveNumber) || Number(fullmoveNumber) < 1) {
      return `invalid fullmove number "${fullmoveNumber}"`;
    }
    return null;
  }

  function readFromPageController() {
    let rawResponse = '';
    const handleResponse = (responseEvent) => {
      rawResponse = typeof responseEvent.detail === 'string' ? responseEvent.detail : '';
    };

    document.addEventListener(RESPONSE_EVENT_NAME, handleResponse, { once: true });
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT_NAME));
    document.removeEventListener(RESPONSE_EVENT_NAME, handleResponse);

    if (!rawResponse) return { problem: 'Lichess analysis controller not found' };

    let positionSnapshot;
    try {
      positionSnapshot = JSON.parse(rawResponse);
    } catch {
      return { problem: 'unreadable response from page bridge' };
    }

    const fenProblem = findFenProblem(positionSnapshot.fen);
    if (fenProblem) return { problem: `controller FEN rejected: ${fenProblem}` };
    if (typeof positionSnapshot.variant !== 'string') return { problem: 'controller did not report a variant' };

    return { fen: positionSnapshot.fen.trim(), variant: positionSnapshot.variant, source: 'page-controller' };
  }

  function readVariantFromDom() {
    const analysisMain = document.querySelector('main.analyse');
    if (!analysisMain) return null;
    const variantClass = [...analysisMain.classList].find((className) => className.startsWith('variant-'));
    return variantClass ? variantClass.slice('variant-'.length) : null;
  }

  function readFromFenInput() {
    const fenInput = [...document.querySelectorAll('.analyse__underboard .copyables .pair')]
      .find((pairElement) => pairElement.querySelector('label')?.textContent.trim() === 'FEN')
      ?.querySelector('input');

    if (!fenInput) return { problem: 'FEN box not found under the board' };
    // While the user is typing into the FEN box, its value is not the board position.
    if (fenInput === document.activeElement) return { problem: 'FEN box is being edited' };

    const fenProblem = findFenProblem(fenInput.value);
    if (fenProblem) return { problem: `FEN box rejected: ${fenProblem}` };

    const variant = readVariantFromDom();
    if (!variant) return { problem: 'variant could not be determined from the page' };

    return { fen: fenInput.value.trim(), variant, source: 'fen-input' };
  }

  globalThis.LichessPositionReader = {
    /**
     * @returns {{ status: 'ok', fen: string, variant: string, source: string }
     *         | { status: 'unavailable', reason: string }}
     */
    readCurrentPosition() {
      const controllerReading = readFromPageController();
      if (!controllerReading.problem) return { status: 'ok', ...controllerReading };

      const inputReading = readFromFenInput();
      if (!inputReading.problem) return { status: 'ok', ...inputReading };

      return { status: 'unavailable', reason: `${controllerReading.problem}; ${inputReading.problem}` };
    },
  };
})();

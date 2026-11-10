/* ChessCoach UI */

const state = {
  game: null,
  plyIndex: 0,          // 0 = start position, N = position after ply N
  flipped: false,
  variation: null,      // { label, startFen, uciMoves, moves: [{uci, san, color, fen}], fens, step }
  tpByPly: {},
  chats: {},            // plyIndex -> html of chat messages for that position
  selectedSquare: null, // e.g. "e2"
  legalDestinations: [], // array of { to: "e4", isCapture: false, promotion: false }
  dragSquare: null,     // square of piece being dragged
};

/* ---------------- FEN and Chess Helpers ---------------- */
function parseFenBoard(fen) {
  const parts = fen.split(" ");
  const rows = parts[0].split("/");
  const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r]) {
      if (ch >= "1" && ch <= "8") c += parseInt(ch, 10);
      else { grid[r][c] = ch; c++; }
    }
  }
  return { grid, turn: parts[1] || "w" };
}

function currentPly() {
  return state.plyIndex > 0 ? state.game.plies[state.plyIndex - 1] : null;
}

function movePrefix(p) {
  return p.color === "white" ? `${p.move_number}. ` : `${p.move_number}... `;
}

function getCurrentFen() {
  if (state.variation) {
    return state.variation.fens[state.variation.step];
  }
  const ply = currentPly();
  return ply ? ply.fen_after : (state.game ? state.game.initial_fen : "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
}

function getCurrentChess() {
  const fen = getCurrentFen();
  return new window.Chess(fen);
}

/* ---------------- Position Evaluation & Live Cache ---------------- */
const fenEvalCache = new Map();
let evalFetchSeq = 0;

function applyEvalToUI(winProb, evalStr) {
  const thermo = document.getElementById("thermoFill");
  const thermoContainer = document.getElementById("evalThermo");
  const evalLabel = document.getElementById("currentEvalLabel");

  if (thermo) {
    const clampedProb = Math.max(0, Math.min(1, winProb));
    thermo.style.height = `${Math.round(clampedProb * 100)}%`;
  }
  if (thermoContainer) {
    thermoContainer.style.justifyContent = state.flipped ? "flex-start" : "flex-end";
    const whitePct = Math.round(Math.max(0, Math.min(1, winProb)) * 100);
    thermoContainer.title = `Eval: ${evalStr} (${whitePct}% White / ${100 - whitePct}% Black)`;
  }
  if (evalLabel) {
    evalLabel.textContent = evalStr;
    evalLabel.classList.remove("eval-positive", "eval-negative", "eval-even");
    if (evalStr === "…" || evalStr === "loading") {
      evalLabel.classList.add("eval-even");
    } else if (evalStr.startsWith("+") || (evalStr.startsWith("#") && !evalStr.startsWith("-#"))) {
      evalLabel.classList.add("eval-positive");
    } else if (evalStr.startsWith("-")) {
      evalLabel.classList.add("eval-negative");
    } else {
      evalLabel.classList.add("eval-even");
    }
  }
}

async function requestPositionEval(fen) {
  if (fenEvalCache.has(fen)) {
    return fenEvalCache.get(fen);
  }

  const mySeq = ++evalFetchSeq;
  try {
    const resp = await fetch(`/api/eval?fen=${encodeURIComponent(fen)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    fenEvalCache.set(fen, data);

    if (getCurrentFen() === fen && mySeq === evalFetchSeq) {
      applyEvalToUI(data.win_prob_white, data.eval_str);
      if (state.variation) {
        renderNote();
        if (state.variation.step === state.variation.moves.length && data.best_move_uci) {
          renderBoard();
        }
      }
    }
    return data;
  } catch (err) {
    console.warn("Live eval error:", err);
    return null;
  }
}

/* ---------------- Markdown-lite ---------------- */
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
function renderMarkdown(md) {
  if (!md) return "";
  let html = "", inList = false;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line) { if (inList) { html += "</ul>"; inList = false; } continue; }
    if (line.startsWith("### ")) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h3>${inlineMd(line.slice(4))}</h3>`;
    } else if (line.startsWith("- ")) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(line.slice(2))}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${inlineMd(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

/* ---------------- Board & Arrow Rendering ---------------- */
function sqCenter(sq) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const col = state.flipped ? 7 - file : file;
  const row = state.flipped ? rank : 7 - rank;
  return [col * 100 + 50, row * 100 + 50];
}

function drawArrows(arrows) {
  const colors = { best: "#5fae3c", played: "#e2574c", line: "#6ea8e8" };
  let defs = "<defs>";
  for (const [k, c] of Object.entries(colors)) {
    defs += `<marker id="ah-${k}" markerWidth="4" markerHeight="4" refX="2.4" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill="${c}"/></marker>`;
  }
  defs += "</defs>";
  let body = "";
  for (const a of arrows) {
    if (!a.uci || a.uci.length < 4) continue;
    const [x1, y1] = sqCenter(a.uci.slice(0, 2));
    const [x2, y2] = sqCenter(a.uci.slice(2, 4));
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    body += `<line x1="${x1 + (dx / len) * 15}" y1="${y1 + (dy / len) * 15}" x2="${x2 - (dx / len) * 26}" y2="${y2 - (dy / len) * 26}"
      stroke="${colors[a.kind]}" stroke-width="16" stroke-linecap="round" opacity="0.85" marker-end="url(#ah-${a.kind})"/>`;
  }
  document.getElementById("arrowLayer").innerHTML = defs + body;
}

function renderBoard() {
  if (!state.game) return;
  const fen = getCurrentFen();
  const cInst = new window.Chess(fen);
  const currentTurn = cInst.turn();

  const hl = new Set();
  const arrows = [];
  const ply = currentPly();

  let winProb = 0.5;
  let evalStr = "0.00";
  let bestReplyUci = null;

  if (fenEvalCache.has(fen)) {
    const cached = fenEvalCache.get(fen);
    winProb = cached.win_prob_white;
    evalStr = cached.eval_str;
    bestReplyUci = cached.best_move_uci;
  } else if (!state.variation && ply) {
    winProb = ply.win_prob_white;
    evalStr = ply.eval_white_str;
    fenEvalCache.set(fen, {
      fen,
      eval_str: ply.eval_white_str,
      win_prob_white: ply.win_prob_white,
      best_move_uci: ply.best_before_uci || null,
      best_move_san: ply.best_before_san || null
    });
  } else {
    // Dynamic position evaluation on board
    evalStr = "…";
    requestPositionEval(fen);
  }

  if (state.variation) {
    const v = state.variation;
    // Arrow for next move in the variation
    if (v.step < v.moves.length) {
      arrows.push({ uci: v.moves[v.step].uci, kind: "line" });
    } else if (bestReplyUci) {
      arrows.push({ uci: bestReplyUci, kind: "best" });
    }
  } else {
    if (ply) {
      const tp = state.tpByPly[ply.ply];
      if (tp) {
        arrows.push({ uci: tp.best_uci, kind: "best" });
      }
    }
  }

  // Destination squares lookup map
  const destMap = {};
  for (const d of state.legalDestinations) {
    destMap[d.to] = d;
  }

  const { grid } = parseFenBoard(fen);
  let html = "";
  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = state.flipped ? 7 - vr : vr;
      const c = state.flipped ? 7 - vc : vc;
      const sq = String.fromCharCode(97 + c) + (8 - r);
      const piece = grid[r][c];
      const isSelected = state.selectedSquare === sq;
      const dest = destMap[sq];
      const hasFriendlyPiece = piece && ((currentTurn === "w" && piece === piece.toUpperCase()) || (currentTurn === "b" && piece === piece.toLowerCase()));

      let inner = "";
      if (piece && PIECE_SVGS[piece]) {
        inner += PIECE_SVGS[piece];
      }
      if (dest) {
        if (dest.isCapture) {
          inner += `<div class="capture-ring"></div>`;
        } else {
          inner += `<div class="move-dot"></div>`;
        }
      }
      if (vc === 0) inner += `<span class="coord-rank">${8 - r}</span>`;
      if (vr === 7) inner += `<span class="coord-file">${String.fromCharCode(97 + c)}</span>`;

      const classes = [
        "sq",
        (r + c) % 2 === 0 ? "light" : "dark",
        hl.has(sq) ? "hl" : "",
        isSelected ? "selected" : "",
        dest ? (dest.isCapture ? "can-dest is-capture" : "can-dest") : "",
        hasFriendlyPiece ? "has-piece" : ""
      ].filter(Boolean).join(" ");

      html += `<div class="${classes}" data-sq="${sq}">${inner}</div>`;
    }
  }

  const boardEl = document.getElementById("boardGrid");
  boardEl.innerHTML = html;
  drawArrows(arrows);

  // Bind square pointer events for click-to-move and drag-and-drop
  boardEl.querySelectorAll(".sq").forEach((sqEl) => {
    const sq = sqEl.dataset.sq;
    sqEl.onpointerdown = (e) => onSquarePointerDown(e, sq);
  });

  // Top header status
  applyEvalToUI(winProb, evalStr);
  if (state.variation) {
    const v = state.variation;
    const curMove = v.step > 0 && v.moves[v.step - 1] ? v.moves[v.step - 1].san : "start";
    document.getElementById("currentMoveLabel").textContent = `${v.label} (${curMove})`;
  } else {
    document.getElementById("currentMoveLabel").textContent = ply ? movePrefix(ply) + ply.san : "Start position";
  }
}

/* ---------------- Piece Movement & Drag-and-Drop Interaction ---------------- */
let activeDrag = null;

function highlightSelectionAndDestinations() {
  const destMap = {};
  for (const d of state.legalDestinations) {
    destMap[d.to] = d;
  }
  document.querySelectorAll(".sq").forEach((sqEl) => {
    const sq = sqEl.dataset.sq;
    const isSelected = state.selectedSquare === sq;
    const dest = destMap[sq];
    sqEl.classList.toggle("selected", isSelected);
    sqEl.classList.toggle("can-dest", Boolean(dest));
    sqEl.classList.toggle("is-capture", Boolean(dest && dest.isCapture));

    const existingMarker = sqEl.querySelector(".move-dot, .capture-ring");
    if (dest) {
      if (!existingMarker) {
        const marker = document.createElement("div");
        marker.className = dest.isCapture ? "capture-ring" : "move-dot";
        sqEl.appendChild(marker);
      } else {
        existingMarker.className = dest.isCapture ? "capture-ring" : "move-dot";
      }
    } else if (existingMarker) {
      existingMarker.remove();
    }
  });
}

function getSquareFromPoint(x, y) {
  // 1. Try DOM element directly under coordinates
  const el = document.elementFromPoint(x, y)?.closest(".sq");
  if (el && el.dataset.sq) return el.dataset.sq;

  // 2. Geometric projection onto the 8x8 chessboard
  const grid = document.getElementById("boardGrid");
  if (!grid) return null;
  const rect = grid.getBoundingClientRect();
  if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
    const col = Math.floor(((x - rect.left) / rect.width) * 8);
    const row = Math.floor(((y - rect.top) / rect.height) * 8);
    const clampedCol = Math.max(0, Math.min(7, col));
    const clampedRow = Math.max(0, Math.min(7, row));
    const r = state.flipped ? 7 - clampedRow : clampedRow;
    const c = state.flipped ? 7 - clampedCol : clampedCol;
    return String.fromCharCode(97 + c) + (8 - r);
  }
  return null;
}

function onSquarePointerDown(e, sq) {
  // Only primary mouse button or touch
  if (e.button !== 0 && e.pointerType === "mouse") return;

  const c = getCurrentChess();

  // 1. If a square is already selected and clicked square is one of legal destinations:
  const dest = state.legalDestinations.find((d) => d.to === sq);
  if (state.selectedSquare && dest) {
    const from = state.selectedSquare;
    state.selectedSquare = null;
    state.legalDestinations = [];
    highlightSelectionAndDestinations();
    makeUserMove(from, sq, dest.promotion ? "q" : undefined);
    return;
  }

  // If clicked on the already selected square: deselect
  if (state.selectedSquare === sq) {
    state.selectedSquare = null;
    state.legalDestinations = [];
    highlightSelectionAndDestinations();
    return;
  }

  // 2. Check if clicked square has a piece belonging to the side to move:
  const piece = c.get(sq);
  if (piece && piece.color === c.turn()) {
    if (activeDrag) {
      if (activeDrag.avatarEl) activeDrag.avatarEl.remove();
      if (activeDrag.sqEl) activeDrag.sqEl.classList.remove("dragging-source");
      activeDrag = null;
    }

    state.selectedSquare = sq;
    const verboseMoves = c.moves({ square: sq, verbose: true });
    state.legalDestinations = verboseMoves.map((m) => ({
      to: m.to,
      isCapture: Boolean(m.captured || m.flags.includes("c") || m.flags.includes("e")),
      promotion: Boolean(m.promotion || m.flags.includes("p"))
    }));

    // Highlight in place without destroying DOM nodes
    highlightSelectionAndDestinations();

    const sqEl = document.querySelector(`.sq[data-sq="${sq}"]`);
    const rect = sqEl ? sqEl.getBoundingClientRect() : { width: 80, height: 80 };
    const pieceChar = piece.color === "w" ? piece.type.toUpperCase() : piece.type.toLowerCase();

    activeDrag = {
      fromSq: sq,
      pieceChar,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      avatarEl: null,
      sqEl,
      size: Math.min(rect.width, rect.height) || 80,
      pointerId: e.pointerId,
      target: e.currentTarget
    };

    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (_) {}

    e.preventDefault();
    return;
  }

  // 3. Clicking anywhere else deselects
  if (state.selectedSquare) {
    state.selectedSquare = null;
    state.legalDestinations = [];
    highlightSelectionAndDestinations();
  }
}

// Prevent browser native drag ghost on chess pieces
window.addEventListener("dragstart", (e) => {
  e.preventDefault();
  return false;
});

// Global pointer movement and release listeners
window.addEventListener("pointermove", (e) => {
  if (!activeDrag) return;

  const d = activeDrag;
  const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);

  if (!d.isDragging) {
    if (dist >= 4) {
      d.isDragging = true;
      const avatar = document.createElement("div");
      avatar.className = "drag-avatar";
      avatar.style.width = `${d.size}px`;
      avatar.style.height = `${d.size}px`;
      avatar.style.left = `${e.clientX}px`;
      avatar.style.top = `${e.clientY}px`;
      avatar.innerHTML = PIECE_SVGS[d.pieceChar] || "";
      document.body.appendChild(avatar);
      d.avatarEl = avatar;

      if (d.sqEl) d.sqEl.classList.add("dragging-source");
      document.body.classList.add("is-dragging-piece");
    }
  }

  if (d.isDragging && d.avatarEl) {
    d.avatarEl.style.left = `${e.clientX}px`;
    d.avatarEl.style.top = `${e.clientY}px`;

    const targetSq = getSquareFromPoint(e.clientX, e.clientY);

    document.querySelectorAll(".sq.drag-hover").forEach((s) => s.classList.remove("drag-hover"));
    if (targetSq && state.legalDestinations.some((m) => m.to === targetSq)) {
      const destEl = document.querySelector(`.sq[data-sq="${targetSq}"]`);
      if (destEl) destEl.classList.add("drag-hover");
    }
  }
});

window.addEventListener("pointerup", (e) => {
  if (!activeDrag) return;

  const d = activeDrag;
  activeDrag = null;

  if (d.target && d.pointerId !== undefined) {
    try {
      d.target.releasePointerCapture(d.pointerId);
    } catch (_) {}
  }

  document.body.classList.remove("is-dragging-piece");
  document.querySelectorAll(".sq.drag-hover").forEach((s) => s.classList.remove("drag-hover"));
  if (d.sqEl) d.sqEl.classList.remove("dragging-source");
  if (d.avatarEl) d.avatarEl.remove();

  if (d.isDragging) {
    const targetSq = getSquareFromPoint(e.clientX, e.clientY);

    if (targetSq && targetSq !== d.fromSq) {
      const dest = state.legalDestinations.find((m) => m.to === targetSq);
      if (dest) {
        state.selectedSquare = null;
        state.legalDestinations = [];
        highlightSelectionAndDestinations();
        makeUserMove(d.fromSq, targetSq, dest.promotion ? "q" : undefined);
        return;
      }

      // Check if dropped onto another friendly piece -> select that piece instead!
      const c = getCurrentChess();
      const piece = c.get(targetSq);
      if (piece && piece.color === c.turn()) {
        state.selectedSquare = targetSq;
        const verboseMoves = c.moves({ square: targetSq, verbose: true });
        state.legalDestinations = verboseMoves.map((m) => ({
          to: m.to,
          isCapture: Boolean(m.captured || m.flags.includes("c") || m.flags.includes("e")),
          promotion: Boolean(m.promotion || m.flags.includes("p"))
        }));
        highlightSelectionAndDestinations();
        return;
      }
    }

    state.selectedSquare = null;
    state.legalDestinations = [];
    highlightSelectionAndDestinations();
  }
});

window.addEventListener("pointercancel", () => {
  if (!activeDrag) return;
  const d = activeDrag;
  activeDrag = null;
  if (d.avatarEl) d.avatarEl.remove();
  if (d.sqEl) d.sqEl.classList.remove("dragging-source");
  if (d.target && d.pointerId !== undefined) {
    try {
      d.target.releasePointerCapture(d.pointerId);
    } catch (_) {}
  }
  document.body.classList.remove("is-dragging-piece");
  document.querySelectorAll(".sq.drag-hover").forEach((s) => s.classList.remove("drag-hover"));
  state.selectedSquare = null;
  state.legalDestinations = [];
  highlightSelectionAndDestinations();
});

function makeUserMove(from, to, promotion = "q") {
  const currentFen = getCurrentFen();
  const c = new window.Chess(currentFen);
  const moveNum = parseInt(c.fen().split(" ")[5] || "1", 10);
  const m = c.move({ from, to, promotion });
  if (!m) return;
  
  const uci = m.from + m.to + (m.promotion || "");
  
  if (state.variation) {
    const v = state.variation;
    if (v.step < v.moves.length && v.moves[v.step].uci === uci) {
      v.step += 1;
    } else {
      v.moves = v.moves.slice(0, v.step);
      v.fens = v.fens.slice(0, v.step + 1);
      v.moves.push({
        uci,
        san: m.san,
        color: m.color,
        fen: c.fen(),
        move_number: moveNum
      });
      v.fens.push(c.fen());
      v.uciMoves = v.moves.map((x) => x.uci);
      v.step = v.moves.length;
    }
  } else {
    const ply = currentPly();
    const tp = ply ? state.tpByPly[ply.ply] : null;
    const label = ply ? `What-if from ${movePrefix(ply)}${ply.san}` : "What-if from start";
    state.variation = {
      label,
      kind: "user_move",
      originTp: tp,
      startFen: currentFen,
      uciMoves: [uci],
      moves: [{
        uci,
        san: m.san,
        color: m.color,
        fen: c.fen(),
        move_number: moveNum
      }],
      fens: [currentFen, c.fen()],
      step: 1
    };
  }
  
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
  renderNote();
}

/* ---------------- Variation System ---------------- */
function startVariation(label, startFen, uciMoves, startStep = null, kind = "line", originTp = null) {
  const c = new window.Chess(startFen);
  const moves = [];
  const fens = [startFen];
  for (const u of uciMoves) {
    const from = u.slice(0, 2);
    const to = u.slice(2, 4);
    const piece = c.get(from);
    const promo = u[4] || (piece && piece.type === "p" && (to[1] === "8" || to[1] === "1") ? "q" : undefined);
    const moveNum = parseInt(c.fen().split(" ")[5] || "1", 10);
    const m = c.move({ from, to, promotion: promo });
    if (!m) break;
    moves.push({
      uci: m.from + m.to + (m.promotion || ""),
      san: m.san,
      color: m.color,
      fen: c.fen(),
      move_number: moveNum
    });
    fens.push(c.fen());
  }
  const step = startStep !== null ? Math.max(0, Math.min(moves.length, startStep)) : 0;
  state.variation = {
    label,
    kind,
    originTp,
    startFen,
    uciMoves: moves.map((m) => m.uci),
    moves,
    fens,
    step
  };
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
  renderNote();
}

function stepVariation(delta) {
  if (!state.variation) return;
  const v = state.variation;
  v.step = Math.max(0, Math.min(v.moves.length, v.step + delta));
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
  renderNote();
}

let autoPlayInterval = null;

function stopAutoPlay() {
  if (autoPlayInterval) {
    clearInterval(autoPlayInterval);
    autoPlayInterval = null;
  }
  const btn = document.getElementById("btnVarPlay");
  if (btn) {
    btn.innerHTML = "&#9654; Auto-play";
    btn.classList.remove("playing");
  }
}

function toggleAutoPlay(delayMs = 1100) {
  if (autoPlayInterval) {
    stopAutoPlay();
    return;
  }
  if (!state.variation) return;
  const v = state.variation;
  if (v.step >= v.moves.length) {
    v.step = 0;
    renderBoard();
    renderVariationBanner();
    renderNote();
  }
  const btn = document.getElementById("btnVarPlay");
  if (btn) {
    btn.innerHTML = "&#10074;&#10074; Pause";
    btn.classList.add("playing");
  }
  autoPlayInterval = setInterval(() => {
    if (!state.variation) {
      stopAutoPlay();
      return;
    }
    if (state.variation.step >= state.variation.moves.length) {
      stopAutoPlay();
      return;
    }
    stepVariation(1);
    if (state.variation.step >= state.variation.moves.length) {
      stopAutoPlay();
    }
  }, delayMs);
}

function jumpVariationStep(step) {
  stopAutoPlay();
  if (!state.variation) return;
  const v = state.variation;
  v.step = Math.max(0, Math.min(v.moves.length, step));
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
  renderNote();
}

function exitVariation() {
  stopAutoPlay();
  if (window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (e) {}
  }
  state.variation = null;
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  document.getElementById("variationBanner").classList.add("hidden");
  renderNote();
}

function renderVariationBanner() {
  const banner = document.getElementById("variationBanner");
  if (!state.variation) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const v = state.variation;
  document.getElementById("varTitle").textContent = v.label;
  document.getElementById("varStepLabel").textContent = `(${v.step} / ${v.moves.length} moves)`;

  const strip = document.getElementById("varMoveStrip");
  if (!strip) return;

  let html = `<span class="var-chip ${v.step === 0 ? "active" : ""}" data-step="0" title="Start of line">&#9679; Start</span>`;
  v.moves.forEach((m, idx) => {
    const isAct = v.step === (idx + 1);
    html += `<span class="var-chip ${isAct ? "active" : ""}" data-step="${idx + 1}">${esc(m.san)}</span>`;
  });
  strip.innerHTML = html;
  strip.querySelectorAll(".var-chip").forEach((chip) => {
    chip.onclick = () => jumpVariationStep(parseInt(chip.dataset.step, 10));
  });
}

/* ---------------- Notes Rendering ---------------- */
function splitOnce(text, marker) {
  const i = (text || "").indexOf(marker);
  return i < 0 ? [text || "", ""] : [text.slice(0, i).trim(), text.slice(i).trim()];
}

function whiteBoxDetails(wb) {
  if (!wb) return "";
  const labels = wb.dimension_labels || {};
  const dims = wb.dimensions_cp || {};
  const rows = Object.keys(labels).map((k) => {
    const v = dims[k] || 0;
    const pct = Math.min(50, (Math.abs(v) / 220) * 50);
    return `<div class="wb-row"><span>${esc(labels[k])}</span>
      <div class="wb-track"><div class="wb-mid"></div>
      <div class="wb-fill" style="left:${v >= 0 ? 50 : 50 - pct}%;width:${pct}%;background:${v >= 0 ? "#7fb65a" : "#e2574c"}"></div></div>
      <span class="wb-val">${v >= 0 ? "+" : ""}${v}</span></div>`;
  }).join("");
  const facts = (wb.facts || []).slice(0, 8).map((f) => `<li>${esc(f.description)}</li>`).join("");
  return `<details class="more"><summary>Positional breakdown (your perspective)</summary>
    <div class="more-body">${rows}${facts ? `<ul class="fact-list">${facts}</ul>` : ""}</div></details>`;
}

function renderTurningPointNote(ply, tp) {
  const c = tp.coaching || {};
  const refUci = [tp.played_uci, ...(tp.refutation_pv_uci || []).slice(0, 6)];
  const bestUci = (tp.candidates[0]?.pv_uci || []).slice(0, 7);

  const badgeIcon = tp.severity === "blunder" ? "?? Blunder" : tp.severity === "mistake" ? "? Mistake" : "⁈ Inaccuracy";
  const badgeCls = `badge-${tp.severity}`;

  const intent = c.your_likely_intent || "";
  const backfire = c.why_it_backfired ? c.why_it_backfired.split("Structurally at the end")[0].trim() : "";
  const whyBest = c.why_best_works ? c.why_best_works.split("**Answering the OTB Doubt:**")[0].split("Positionally, this line achieves")[0].trim() : "";

  return {
    cls: `tp-${tp.severity}`,
    html: `
      <div class="badge-group">
        <span class="move-badge ${badgeCls}">${badgeIcon}</span>
        <span class="small muted">${(tp.wp_loss * 100).toFixed(1)}% win chance lost</span>
      </div>

      <div class="coach-explanation">
        <p>You played <strong>${esc(ply.san)}</strong> (${esc(tp.played_eval_white_str)}). ${inlineMd(intent)}</p>
        <p style="margin-top:6px;">However, this was a ${tp.severity}: ${inlineMd(backfire)}</p>
        <p style="margin-top:6px; color:#a8d88a;">Best was <strong>${esc(tp.best_san)}</strong> (${esc(tp.best_eval_white_str)}). ${inlineMd(whyBest)}</p>
      </div>

      <div class="coach-action-row">
        <button class="btn-coach-action primary btn-play-line" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(bestUci)}' data-label="Best Line: ${esc(tp.best_san)}" data-kind="best" data-tp-ply="${tp.ply}">
          ⭐ Show Best Move (${esc(tp.best_san)})
        </button>
        <button class="btn-coach-action btn-play-line" data-fen="${esc(tp.fen_before)}" data-uci='[]' data-label="Decision before ${esc(ply.san)}" data-kind="try_moves" data-tp-ply="${tp.ply}">
          ⟲ Retry Move
        </button>
        <button class="btn-coach-action btn-play-line refutation" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(refUci)}' data-label="Refutation: ${esc(ply.san)}" data-kind="refutation" data-tp-ply="${tp.ply}">
          ⚡ Punishment Line
        </button>
      </div>

      ${c.otb_trigger ? `
        <details class="more" style="margin-top:8px;"><summary style="cursor:pointer; color:var(--muted); font-size:12px;">Coach takeaway rule</summary>
          <div style="margin-top:6px; font-size:13px; color:var(--text); background:var(--panel-2); padding:8px 10px; border-radius:6px; border:1px solid var(--border);">
            <strong>Rule:</strong> When ${esc(c.otb_trigger.signal.toLowerCase())} &rarr; <strong>${esc(c.otb_trigger.action)}</strong>
          </div>
        </details>
      ` : ""}
    `,
  };
}

function renderVariationNote(v) {
  const currentFen = getCurrentFen();
  const cached = fenEvalCache.get(currentFen) || {};
  const totalMoves = v.moves.length;
  const curMove = v.step > 0 && v.moves[v.step - 1] ? v.moves[v.step - 1] : null;

  let badgeText = "Exploring Line";
  let badgeCls = "badge-good";
  if (v.kind === "refutation") {
    badgeText = "Refutation Line";
    badgeCls = "badge-blunder";
  } else if (v.kind === "best") {
    badgeText = "Best Line";
    badgeCls = "badge-best";
  }

  const stepDesc = v.step === 0
    ? `Starting position (0 of ${totalMoves} moves)`
    : `Move ${v.step} of ${totalMoves}: ${curMove ? curMove.san : ""}`;

  return {
    cls: "",
    html: `
      <div class="badge-group">
        <span class="move-badge ${badgeCls}">${badgeText}</span>
        <span class="small muted">${stepDesc}</span>
      </div>
      <div class="coach-explanation">
        <p>Line: <strong>${esc(v.label)}</strong></p>
        <p style="margin-top:4px;">Stockfish eval: <strong>${esc(cached.eval_str || "evaluating…")}</strong></p>
      </div>
      <div class="coach-action-row">
        <button class="btn-coach-action" onclick="stepVariation(-1)">◀ Prev</button>
        <button class="btn-coach-action primary" onclick="toggleAutoPlay(1100)">▶ Auto-play</button>
        <button class="btn-coach-action" onclick="stepVariation(1)">Next ▶</button>
        <button class="btn-coach-action btn-danger-soft" onclick="exitVariation()">✕ Exit to Game</button>
      </div>
    `,
  };
}

function renderOrdinaryNote(ply) {
  const mine = ply.color === state.game.player_color;
  let badgeHtml = "";
  let commentHtml = "";

  if (!mine) {
    badgeHtml = `<span class="move-badge badge-book">Opponent's Move</span>`;
    commentHtml = `<p>Opponent played <strong>${esc(ply.san)}</strong>. Evaluation: <strong>${esc(ply.eval_white_str)}</strong>.</p>`;
  } else if (ply.san === ply.best_before_san || ply.severity === "best") {
    badgeHtml = `<span class="move-badge badge-best">★ Best Move</span>`;
    commentHtml = `<p>You played <strong>${esc(ply.san)}</strong>! This is the engine's top choice (Eval: <strong>${esc(ply.eval_white_str)}</strong>).</p>`;
  } else if (ply.severity === "good") {
    badgeHtml = `<span class="move-badge badge-good">✓ Good Move</span>`;
    commentHtml = `<p>Solid move. You played <strong>${esc(ply.san)}</strong>. Keeps a solid position (Eval: <strong>${esc(ply.eval_white_str)}</strong>).</p>`;
  } else {
    badgeHtml = `<span class="move-badge badge-good">Playable Move</span>`;
    commentHtml = `<p>You played <strong>${esc(ply.san)}</strong>. The engine slightly preferred <code>${esc(ply.best_before_san || "")}</code>.</p>`;
  }

  const nextTp = (state.game.turning_points || []).find((t) => t.ply > ply.ply);

  return {
    cls: "",
    html: `
      <div class="badge-group">${badgeHtml}</div>
      <div class="coach-explanation">${commentHtml}</div>
      <div class="coach-action-row">
        <button class="btn-coach-action" onclick="jumpToPly(${state.plyIndex + 1})">Next Move ▶</button>
        ${nextTp ? `<button class="btn-coach-action primary" onclick="jumpToPly(${nextTp.ply})">Jump to Key Moment (Move ${nextTp.move_number}) ⚡</button>` : ""}
      </div>
    `,
  };
}

function renderSummaryNote() {
  const s = state.game.summary || {};
  const tps = state.game.turning_points || [];
  const firstTp = tps[0];
  const blunders = tps.filter((t) => t.severity === "blunder").length;
  const mistakes = tps.filter((t) => t.severity === "mistake").length;
  const inaccuracies = tps.filter((t) => t.severity === "inaccuracy").length;

  return {
    cls: "",
    html: `
      <div class="badge-group">
        <span class="move-badge badge-best">Game Review Ready</span>
      </div>
      <div class="coach-explanation">
        <p style="font-size:15px; font-weight:600;">Welcome to your Game Review!</p>
        <p style="margin-top:6px;">Your estimated accuracy: <strong style="color:var(--good); font-size:16px;">${s.accuracy_pct || "—"}%</strong></p>
        <p style="margin-top:6px; color:var(--muted); font-size:13.5px;">Found <strong>${blunders}</strong> blunders, <strong>${mistakes}</strong> mistakes, and <strong>${inaccuracies}</strong> inaccuracies.</p>
      </div>
      <div class="coach-action-row" style="margin-top:8px;">
        ${firstTp ? `
          <button class="btn-coach-action primary" onclick="jumpToPly(${firstTp.ply})">
            ▶ Start Game Review (First key move: ${firstTp.move_number}. ${firstTp.played_san})
          </button>
        ` : `
          <button class="btn-coach-action primary" onclick="jumpToPly(1)">
            ▶ Step Through Game
          </button>
        `}
      </div>
    `,
  };
}

let lastRenderedNoteKey = null;

function renderNote() {
  const el = document.getElementById("noteContent");
  let note;
  let currentKey;
  if (state.variation) {
    note = renderVariationNote(state.variation);
    currentKey = `var_${state.variation.label}_${state.variation.step}`;
  } else {
    const ply = currentPly();
    if (!ply) {
      note = renderSummaryNote();
      currentKey = "summary";
    } else if (state.tpByPly[ply.ply]) {
      note = renderTurningPointNote(ply, state.tpByPly[ply.ply]);
      currentKey = `tp_${ply.ply}`;
    } else {
      note = renderOrdinaryNote(ply);
      currentKey = `ord_${ply.ply}`;
    }
  }
  el.className = `note ${note.cls}`;
  el.innerHTML = note.html;
  bindLineButtons(el);
  el.querySelectorAll(".habit-link").forEach((a) => (a.onclick = () => jumpToPly(parseInt(a.dataset.ply, 10))));
  if (currentKey !== lastRenderedNoteKey) {
    const pane = document.getElementById("paneCoach");
    if (pane) pane.scrollTop = 0;
    if (el) el.scrollTop = 0;
    lastRenderedNoteKey = currentKey;
  }
}

function bindLineButtons(root) {
  root.querySelectorAll(".btn-play-line:not(#btnPlayEngineResponse), .btn-var").forEach((b) => {
    b.onclick = () => {
      const uciMoves = JSON.parse(b.dataset.uci || "[]");
      const kind = b.dataset.kind || "line";
      const tpPly = b.dataset.tpPly ? parseInt(b.dataset.tpPly, 10) : null;
      const originTp = tpPly !== null ? state.tpByPly[tpPly] : (currentPly() ? state.tpByPly[currentPly().ply] : null);
      const startStep = b.dataset.step !== undefined ? parseInt(b.dataset.step, 10) : 0;
      startVariation(b.dataset.label, b.dataset.fen, uciMoves, startStep, kind, originTp);
      toggleAutoPlay(1100);
    };
  });

  root.querySelectorAll(".btn-var-step").forEach((b) => {
    b.onclick = () => stepVariation(parseInt(b.dataset.delta, 10));
  });

  root.querySelectorAll(".btn-var-exit").forEach((b) => {
    b.onclick = () => exitVariation();
  });

  const btnResp = root.querySelector("#btnPlayEngineResponse");
  if (btnResp) {
    btnResp.onclick = () => {
      const uciMoves = JSON.parse(btnResp.dataset.uci || "[]");
      if (uciMoves.length > 0) {
        const u = uciMoves[0];
        makeUserMove(u.slice(0, 2), u.slice(2, 4), u[4] || "q");
      }
    };
  }
}

/* ---------------- Move list (Chess.com Notation style) ---------------- */
function renderMoveList() {
  const el = document.getElementById("moveList");
  if (!el || !state.game) return;
  const plies = state.game.plies || [];
  let html = "";

  for (let i = 0; i < plies.length; i += 2) {
    const whitePly = plies[i];
    const blackPly = plies[i + 1] || null;
    const moveNum = whitePly.move_number || Math.floor(i / 2) + 1;

    const tpW = state.tpByPly[whitePly.ply];
    const dotW = tpW ? `<span class="eval-dot ${tpW.severity}"></span>` : "";

    let blackCellHtml = "";
    if (blackPly) {
      const tpB = state.tpByPly[blackPly.ply];
      const dotB = tpB ? `<span class="eval-dot ${tpB.severity}"></span>` : "";
      blackCellHtml = `
        <span class="move-cell" data-ply="${blackPly.ply}">
          <span>${esc(blackPly.san)}</span>
          ${dotB}
        </span>`;
    } else {
      blackCellHtml = `<span></span>`;
    }

    html += `
      <div class="move-sheet-row">
        <span class="move-sheet-num">${moveNum}.</span>
        <span class="move-cell" data-ply="${whitePly.ply}">
          <span>${esc(whitePly.san)}</span>
          ${dotW}
        </span>
        ${blackCellHtml}
      </div>`;
  }

  el.innerHTML = html;
  el.querySelectorAll(".move-cell").forEach((m) => {
    m.onclick = () => jumpToPly(parseInt(m.dataset.ply, 10));
  });
}

function highlightMoveList() {
  document.querySelectorAll(".move-cell").forEach((m) => {
    const on = parseInt(m.dataset.ply, 10) === state.plyIndex;
    m.classList.toggle("active", on);
    if (on) m.scrollIntoView({ block: "nearest" });
  });
}

function renderEvalGraph() {
  const svg = document.getElementById("evalGraph");
  if (!svg || !state.game) return;
  const plies = state.game.plies || [];
  const W = 600, H = 80, n = plies.length || 1;
  const pts = [`0,${H / 2}`, ...plies.map((p, i) => `${(((i + 1) / n) * W).toFixed(1)},${(H - p.win_prob_white * H).toFixed(1)}`)];
  const markers = (state.game.turning_points || []).map((tp) => {
    const p = plies[tp.ply - 1];
    const col = tp.severity === "blunder" ? "#fa412d" : tp.severity === "mistake" ? "#e6912c" : "#f0c15c";
    return `<circle cx="${((tp.ply / n) * W).toFixed(1)}" cy="${(H - p.win_prob_white * H).toFixed(1)}" r="4.5" fill="${col}"/>`;
  }).join("");
  svg.innerHTML = `
    <polygon points="0,${H} ${pts.join(" ")} ${W},${H}" fill="rgba(129, 182, 76, 0.4)"/>
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#4e4b44" stroke-dasharray="3,3"/>
    ${markers}
    <line id="graphCursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#5c8bb0" stroke-width="2"/>`;
  svg.onclick = (ev) => {
    const rect = svg.getBoundingClientRect();
    jumpToPly(Math.round(((ev.clientX - rect.left) / rect.width) * n));
  };
}

function moveGraphCursor() {
  const cur = document.getElementById("graphCursor");
  if (!cur || !state.game) return;
  const x = ((state.plyIndex / (state.game.plies.length || 1)) * 600).toFixed(1);
  cur.setAttribute("x1", x); cur.setAttribute("x2", x);
}

function renderAnalysisTab() {
  if (!state.game) return;
  const summaryEl = document.getElementById("gameSummaryStats");
  if (summaryEl) {
    const tps = state.game.turning_points || [];
    const blunders = tps.filter((t) => t.severity === "blunder").length;
    const mistakes = tps.filter((t) => t.severity === "mistake").length;
    const inaccuracies = tps.filter((t) => t.severity === "inaccuracy").length;
    const acc = state.game.summary?.accuracy_pct ? `${state.game.summary.accuracy_pct}%` : "—";

    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-title">Accuracy</span>
        <span class="stat-card-val" style="color:var(--good);">${acc}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-title">Blunders</span>
        <span class="stat-card-val" style="color:var(--danger);">${blunders}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-title">Mistakes</span>
        <span class="stat-card-val" style="color:var(--warn);">${mistakes}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-title">Inaccuracies</span>
        <span class="stat-card-val" style="color:#f0c15c;">${inaccuracies}</span>
      </div>
    `;
  }

  renderEvalGraph();

  const wbEl = document.getElementById("whiteBoxAnalysis");
  if (wbEl) {
    const ply = currentPly();
    const tp = ply ? state.tpByPly[ply.ply] : null;
    const currentFen = getCurrentFen();
    const cached = fenEvalCache.get(currentFen) || {};
    const wb = tp?.whitebox?.root || cached.whitebox || ply?.whitebox_after;
    if (wb) {
      wbEl.innerHTML = `<div class="chart-title" style="margin-top:6px;">Positional Breakdown (Move ${state.plyIndex})</div>` + whiteBoxRows(wb);
    } else {
      wbEl.innerHTML = `<div class="small muted" style="margin-top:6px;">Step through moves to inspect positional factors.</div>`;
    }
  }
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      const targetPane = document.getElementById(btn.dataset.tab);
      if (targetPane) {
        targetPane.classList.remove("hidden");
        if (btn.dataset.tab === "paneAnalysis") renderAnalysisTab();
        if (btn.dataset.tab === "paneMoves") highlightMoveList();
      }
    };
  });
}

/* ---------------- Q&A ---------------- */
function saveChat() {
  state.chats[state.plyIndex] = document.getElementById("qaMessages").innerHTML;
}

function renderQA() {
  const msgs = document.getElementById("qaMessages");
  msgs.innerHTML = state.chats[state.plyIndex] || "";
  bindLineButtons(msgs);

  const ply = currentPly();
  let chips = [];
  if (!ply) {
    chips = ["What are the main plans in this opening?"];
  } else {
    const tp = state.tpByPly[ply.ply];
    if (tp) {
      chips.push(`Why was ${ply.san} a ${tp.severity}?`);
      if (tp.candidates[1]) chips.push(`What if I played ${tp.candidates[1].san} instead?`);
    } else {
      chips.push("What is the plan here?");
    }
    chips.push("What is my opponent threatening?");
  }
  const sug = document.getElementById("qaSuggestions");
  sug.innerHTML = chips.map((q) => `<span class="chip-q">${esc(q)}</span>`).join("");
  sug.querySelectorAll(".chip-q").forEach((c) => (c.onclick = () => askCoach(c.textContent)));
}

/* ---------------- Conversational Coach & Voice Dialogue ---------------- */
let voiceNarrationEnabled = true; // Speech synthesis active by default
let voiceModeActive = false;      // Two-way hands-free continuous dialogue
let recognitionInstance = null;
let isCurrentlyListening = false;
let isCoachCurrentlySpeaking = false;

function getConversationKey() {
  if (state.variation) {
    return `var_${state.variation.label}_${state.variation.step}`;
  }
  const ply = currentPly();
  return ply ? `ply_${ply.ply}` : "start";
}

function getConversationThread(key = null) {
  const k = key || getConversationKey();
  if (!state.conversations) state.conversations = {};
  if (!state.conversations[k]) state.conversations[k] = [];
  return state.conversations[k];
}

function toSpokenChessText(text) {
  if (!text) return "";
  let s = text;
  // Strip markdown formatting
  s = s.replace(/#{1,6}\s+/g, "");
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  s = s.replace(/[-*]\s+/g, "");

  // Castling
  s = s.replace(/\bO-O-O\b/g, "castles queenside");
  s = s.replace(/\bO-O\b/g, "castles kingside");
  s = s.replace(/\b0-0-0\b/g, "castles queenside");
  s = s.replace(/\b0-0\b/g, "castles kingside");

  // Evaluations
  s = s.replace(/\+([0-9]+\.?[0-9]*)/g, "plus $1");
  s = s.replace(/-([0-9]+\.?[0-9]*)/g, "minus $1");
  s = s.replace(/#0/g, "checkmate");
  s = s.replace(/#([0-9]+)/g, "mate in $1");

  // Spoken Piece Moves
  s = s.replace(/\bK([a-h][1-8])\b/g, "King to $1");
  s = s.replace(/\bQ([a-h][1-8])\b/g, "Queen to $1");
  s = s.replace(/\bR([a-h1-8]?)([a-h][1-8])\b/g, "Rook $1 to $2");
  s = s.replace(/\bB([a-h][1-8])\b/g, "Bishop to $1");
  s = s.replace(/\bN([a-h1-8]?)([a-h][1-8])\b/g, "Knight $1 to $2");

  s = s.replace(/\bKx([a-h][1-8])\b/g, "King takes $1");
  s = s.replace(/\bQx([a-h][1-8])\b/g, "Queen takes $1");
  s = s.replace(/\bRx([a-h][1-8])\b/g, "Rook takes $1");
  s = s.replace(/\bBx([a-h][1-8])\b/g, "Bishop takes $1");
  s = s.replace(/\bNx([a-h][1-8])\b/g, "Knight takes $1");
  s = s.replace(/\b([a-h])x([a-h][1-8])\b/g, "$1 takes $2");

  // Keep speech concise and pleasant for voice dialogue (first 2-3 sentences)
  const sentences = s.split(/(?<=[.?!])\s+/).filter(Boolean);
  if (sentences.length > 4) {
    s = sentences.slice(0, 4).join(" ");
  }

  return s.replace(/[!?;:]+/g, ".").replace(/\s+/g, " ").trim();
}

function updateVoiceStatus(status, text = "") {
  const banner = document.getElementById("voiceStatusBanner");
  const textEl = document.getElementById("voiceStatusText");
  const micBtn = document.getElementById("btnMic");
  if (!banner || !textEl) return;

  if (!status || status === "idle") {
    banner.classList.add("hidden");
    if (micBtn) micBtn.classList.remove("recording");
    return;
  }

  banner.classList.remove("hidden");
  if (status === "listening") {
    textEl.textContent = text || "Listening to you... speak now";
    if (micBtn) micBtn.classList.add("recording");
  } else if (status === "speaking") {
    textEl.textContent = text || "Coach speaking...";
    if (micBtn) micBtn.classList.remove("recording");
  } else if (status === "thinking") {
    textEl.textContent = text || "Analyzing position...";
    if (micBtn) micBtn.classList.remove("recording");
  }
}

function stopAllVoiceActivity() {
  if (window.speechSynthesis) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }
  isCoachCurrentlySpeaking = false;
  if (recognitionInstance && isCurrentlyListening) {
    try { recognitionInstance.stop(); } catch (_) {}
  }
  isCurrentlyListening = false;
  updateVoiceStatus("idle");
}

function speakCoachDialogue(text, onComplete = null) {
  if (!window.speechSynthesis || (!voiceNarrationEnabled && !voiceModeActive)) {
    if (onComplete) onComplete();
    return;
  }

  stopAllVoiceActivity();
  const spokenText = toSpokenChessText(text);
  if (!spokenText) {
    if (onComplete) onComplete();
    return;
  }

  try {
    const utter = new SpeechSynthesisUtterance(spokenText);
    utter.rate = 1.05;
    utter.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const naturalVoice = voices.find(
      (v) => v.lang.startsWith("en") && (v.name.includes("Natural") || v.name.includes("Online") || v.name.includes("David") || v.name.includes("Guy") || v.name.includes("Jenny"))
    );
    if (naturalVoice) utter.voice = naturalVoice;

    utter.onstart = () => {
      isCoachCurrentlySpeaking = true;
      updateVoiceStatus("speaking", "Coach speaking...");
    };

    utter.onend = () => {
      isCoachCurrentlySpeaking = false;
      updateVoiceStatus("idle");
      if (onComplete) onComplete();
    };

    utter.onerror = (err) => {
      console.warn("Speech synthesis error:", err);
      isCoachCurrentlySpeaking = false;
      updateVoiceStatus("idle");
      if (onComplete) onComplete();
    };

    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn("Could not speak coach text:", err);
    if (onComplete) onComplete();
  }
}

function startListeningForVoiceReply() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    updateVoiceStatus("idle");
    return;
  }

  if (isCurrentlyListening || isCoachCurrentlySpeaking) return;

  if (!recognitionInstance) {
    recognitionInstance = new SpeechRec();
    recognitionInstance.continuous = false;
    recognitionInstance.interimResults = true;
    recognitionInstance.lang = "en-US";

    recognitionInstance.onstart = () => {
      isCurrentlyListening = true;
      updateVoiceStatus("listening", "Listening to you... speak now");
    };

    recognitionInstance.onresult = (e) => {
      let transcript = "";
      for (let i = e.resultIndex; i < e.results.length; ++i) {
        transcript += e.results[i][0].transcript;
      }
      const inp = document.getElementById("qaInput");
      if (inp) inp.value = transcript;

      if (e.results[0].isFinal && transcript.trim()) {
        isCurrentlyListening = false;
        updateVoiceStatus("thinking", "Analyzing your idea...");
        askCoach(transcript);
      }
    };

    recognitionInstance.onerror = (e) => {
      console.warn("Voice recognition notice:", e.error);
      isCurrentlyListening = false;
      if (voiceModeActive && e.error === "no-speech") {
        // In continuous voice mode, prompt user or keep ready
        updateVoiceStatus("idle");
      } else {
        updateVoiceStatus("idle");
      }
    };

    recognitionInstance.onend = () => {
      isCurrentlyListening = false;
      if (!isCoachCurrentlySpeaking && voiceModeActive) {
        updateVoiceStatus("idle");
      }
    };
  }

  try {
    recognitionInstance.start();
  } catch (err) {
    console.warn("Recognition already active or failed to start:", err);
  }
}

function renderQA() {
  const msgsEl = document.getElementById("qaMessages");
  const sugEl = document.getElementById("qaSuggestions");
  if (!msgsEl) return;

  const k = getConversationKey();
  const thread = getConversationThread(k);
  const ply = currentPly();

  if (thread.length === 0) {
    const tp = ply ? state.tpByPly[ply.ply] : null;
    let welcome = "";
    if (state.variation) {
      welcome = `I'm with you on line <strong>${esc(state.variation.label)}</strong>. Test any move on the board or ask me questions about this line!`;
    } else if (tp) {
      welcome = `We're at turning point <strong>move ${tp.move_number} (${esc(tp.played_san)})</strong>. Why do you think ${esc(tp.best_san)} is stronger than ${esc(tp.played_san)}? Let's discuss it!`;
    } else if (ply) {
      welcome = `We're looking at <strong>${movePrefix(ply)}${esc(ply.san)}</strong>. What would you like to explore here?`;
    } else {
      welcome = `Welcome to the game! What strategic plan or opening ideas would you like to look at?`;
    }

    msgsEl.innerHTML = `
      <div class="qa-msg coach">
        <div class="qa-bubble">
          <div class="qa-bubble-header"><span>&#128104;&#8205;&#127979; Coach</span></div>
          <div>${welcome}</div>
        </div>
      </div>
    `;
  } else {
    let html = "";
    thread.forEach((msg, idx) => {
      if (msg.role === "user") {
        html += `
          <div class="qa-msg user">
            <div class="qa-bubble">
              <div class="qa-bubble-header"><span>You</span></div>
              <div>${esc(msg.content)}</div>
            </div>
          </div>
        `;
      } else {
        const btns = (msg.interactive_lines || []).map((l) => `
          <button class="btn-play-line" data-fen="${esc(l.fen)}" data-uci='${JSON.stringify(l.uci_moves)}' data-label="${esc(l.label)}">
            &#9654; ${esc(l.label)}
          </button>`).join("");

        html += `
          <div class="qa-msg coach">
            <div class="qa-bubble">
              <div class="qa-bubble-header">
                <span>&#128104;&#8205;&#127979; Coach</span>
                <button class="btn-speak-msg" data-msg-idx="${idx}" title="Listen to coach speak">&#128266; Listen</button>
              </div>
              <div>${renderMarkdown(msg.content)}</div>
              ${btns ? `<div class="line-btns" style="margin-top:8px;">${btns}</div>` : ""}
            </div>
          </div>
        `;
      }
    });
    msgsEl.innerHTML = html;
  }

  msgsEl.querySelectorAll(".btn-speak-msg").forEach((b) => {
    b.onclick = () => {
      const idx = parseInt(b.dataset.msgIdx, 10);
      const msg = thread[idx];
      if (msg && msg.content) speakCoachDialogue(msg.content);
    };
  });
  bindLineButtons(msgsEl);

  // Suggestion chips
  if (sugEl) {
    let chips = [];
    const lastCoachMsg = [...thread].reverse().find((m) => m.role === "coach");
    if (lastCoachMsg && lastCoachMsg.suggested_followups && lastCoachMsg.suggested_followups.length > 0) {
      chips = lastCoachMsg.suggested_followups;
    } else if (ply) {
      const tp = state.tpByPly[ply.ply];
      if (tp) {
        chips.push(`Why was ${ply.san} a ${tp.severity}?`);
        if (tp.candidates[1]) chips.push(`What if I played ${tp.candidates[1].san} instead?`);
      } else {
        chips.push("What is the plan here?");
      }
      chips.push("What is my opponent threatening?");
    } else {
      chips = ["What are the main plans in this opening?", "What is opponent threatening?"];
    }

    sugEl.innerHTML = chips.map((q) => `<span class="chip-q">${esc(q)}</span>`).join("");
    sugEl.querySelectorAll(".chip-q").forEach((c) => (c.onclick = () => askCoach(c.textContent)));
  }

  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function askCoach(question) {
  const q = question.trim();
  if (!q || !state.game) return;

  const k = getConversationKey();
  const thread = getConversationThread(k);
  const inp = document.getElementById("qaInput");
  if (inp) inp.value = "";

  // Append user message
  thread.push({ role: "user", content: q });
  renderQA();

  const msgsEl = document.getElementById("qaMessages");
  const tempId = `temp_${Date.now()}`;
  msgsEl.insertAdjacentHTML(
    "beforeend",
    `<div class="qa-msg coach" id="${tempId}"><div class="qa-bubble"><em>&#129504; Coach is analyzing...</em></div></div>`
  );
  msgsEl.scrollTop = msgsEl.scrollHeight;

  const ply = currentPly();
  let fenCurrent = getCurrentFen(), fenBefore = null;
  if (!state.variation && ply) {
    fenBefore = ply.fen_before;
  }

  // History payload for conversational memory
  const historyPayload = thread.slice(0, -1).map((m) => ({
    role: m.role,
    content: m.content,
  })).slice(-8);

  try {
    const resp = await fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: q,
        fen_current: fenCurrent,
        fen_before: fenBefore,
        ply_meta: state.variation ? null : ply,
        perspective: state.game.player_color || "white",
        history: historyPayload,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Request failed");

    // Remove temp indicator
    const tempEl = document.getElementById(tempId);
    if (tempEl) tempEl.remove();

    // Append coach message to thread
    thread.push({
      role: "coach",
      content: data.answer_markdown,
      interactive_lines: data.interactive_lines || [],
      suggested_followups: data.suggested_followups || [],
    });
    renderQA();

    // Speak response if voice narration or Voice Mode is active
    if (voiceNarrationEnabled || voiceModeActive) {
      speakCoachDialogue(data.answer_markdown, () => {
        // If two-way voice mode is active, automatically listen for user reply!
        if (voiceModeActive) {
          startListeningForVoiceReply();
        }
      });
    }
  } catch (err) {
    const tempEl = document.getElementById(tempId);
    if (tempEl) tempEl.remove();
    thread.push({
      role: "coach",
      content: `Sorry — ${err.message}`,
      interactive_lines: [],
    });
    renderQA();
  }
}

function setupConversationalUI() {
  const btnVoiceMode = document.getElementById("btnVoiceMode");
  const btnVoiceToggle = document.getElementById("btnVoiceToggle");
  const btnClearChat = document.getElementById("btnClearChat");
  const btnVoiceStop = document.getElementById("btnVoiceStop");
  const btnMic = document.getElementById("btnMic");

  if (btnVoiceMode) {
    btnVoiceMode.onclick = () => {
      voiceModeActive = !voiceModeActive;
      if (voiceModeActive) {
        voiceNarrationEnabled = true;
        btnVoiceMode.classList.add("active");
        btnVoiceMode.innerHTML = "&#127908; Voice Mode: ON";
        btnVoiceMode.title = "Hands-free voice mode: ON (Click to turn off)";
        if (btnVoiceToggle) {
          btnVoiceToggle.innerHTML = "&#128266;";
          btnVoiceToggle.classList.remove("muted");
        }

        const k = getConversationKey();
        const thread = getConversationThread(k);
        const greeting = thread.length > 0
          ? "I'm listening. Ask me anything or explore a move on the board."
          : "Hello! I'm your chess coach. What would you like to explore in this position?";

        speakCoachDialogue(greeting, () => {
          if (voiceModeActive) startListeningForVoiceReply();
        });
      } else {
        btnVoiceMode.classList.remove("active");
        btnVoiceMode.innerHTML = "&#127908; Voice Mode: OFF";
        btnVoiceMode.title = "Hands-free voice mode: OFF (Click to turn on)";
        stopAllVoiceActivity();
      }
    };
  }

  if (btnVoiceToggle) {
    btnVoiceToggle.onclick = () => {
      voiceNarrationEnabled = !voiceNarrationEnabled;
      if (voiceNarrationEnabled) {
        btnVoiceToggle.innerHTML = "&#128266;";
        btnVoiceToggle.classList.remove("muted");
        btnVoiceToggle.title = "Voice narration: ON (Click to mute)";
      } else {
        btnVoiceToggle.innerHTML = "&#128263;";
        btnVoiceToggle.classList.add("muted");
        btnVoiceToggle.title = "Voice narration: OFF (Click to unmute)";
        stopAllVoiceActivity();
      }
    };
  }

  if (btnClearChat) {
    btnClearChat.onclick = () => {
      const k = getConversationKey();
      if (state.conversations) state.conversations[k] = [];
      stopAllVoiceActivity();
      renderQA();
    };
  }

  if (btnVoiceStop) {
    btnVoiceStop.onclick = () => {
      stopAllVoiceActivity();
      if (voiceModeActive) {
        voiceModeActive = false;
        if (btnVoiceMode) {
          btnVoiceMode.classList.remove("active");
          btnVoiceMode.innerHTML = "&#127908; Voice Mode: OFF";
        }
      }
    };
  }

  if (btnMic) {
    btnMic.onclick = () => {
      if (isCurrentlyListening) {
        stopAllVoiceActivity();
      } else {
        stopAllVoiceActivity();
        startListeningForVoiceReply();
      }
    };
  }
}

/* ---------------- Navigation ---------------- */
function jumpToPly(ply) {
  if (!state.game) return;
  saveChat();
  exitVariation();
  state.plyIndex = Math.max(0, Math.min(state.game.plies.length, ply));
  renderAll();
}

function renderAll() {
  renderBoard();
  renderNote();
  renderQA();
  renderVariationBanner();
  highlightMoveList();
  moveGraphCursor();
  renderAnalysisTab();
}

/* ---------------- Data Loading ---------------- */
async function loadGameList(selectId = null) {
  const data = await (await fetch("/api/games")).json();
  const sel = document.getElementById("gameSelect");
  sel.innerHTML = (data.games || []).map((g) => `<option value="${g.id}">${esc(g.title)}</option>`).join("");
  const target = selectId || data.games[0]?.id;
  if (target) { sel.value = target; await loadGame(target); }
  else {
    document.getElementById("noteContent").innerHTML =
      `<h2>Welcome to ChessCoach</h2><p>Click <strong>+ Analyze Game</strong> to load a PGN.</p>`;
  }
}

async function loadGame(id) {
  const resp = await fetch(`/api/games/${id}`);
  if (!resp.ok) return;
  state.game = await resp.json();
  state.plyIndex = 0;
  state.variation = null;
  state.selectedSquare = null;
  state.legalDestinations = [];
  state.chats = {};
  state.flipped = state.game.player_color === "black";
  state.tpByPly = {};
  for (const tp of state.game.turning_points || []) state.tpByPly[tp.ply] = tp;

  // Pre-seed evaluation cache for starting position and all game plies
  fenEvalCache.clear();
  const initFen = state.game.initial_fen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  fenEvalCache.set(initFen, {
    fen: initFen,
    eval_str: "+0.20",
    win_prob_white: 0.52,
    best_move_uci: null,
    best_move_san: null
  });
  for (const p of state.game.plies || []) {
    if (p.fen_after) {
      fenEvalCache.set(p.fen_after, {
        fen: p.fen_after,
        eval_str: p.eval_white_str ?? "0.00",
        win_prob_white: p.win_prob_white ?? 0.5,
        best_move_uci: p.best_before_uci || null,
        best_move_san: p.best_before_san || null
      });
    }
  }

  renderMoveList();
  renderEvalGraph();
  const m = location.hash.match(/ply=(\d+)/);
  if (m) state.plyIndex = Math.min(state.game.plies.length, parseInt(m[1], 10));
  renderAll();
}

async function refreshSettings() {
  const s = await (await fetch("/api/settings")).json();
  document.getElementById("selProvider").value = s.provider || "deterministic";
  document.getElementById("inputModel").value = s.model || "";
  document.getElementById("inputBaseUrl").value = s.base_url || "";
  document.getElementById("inputApiKey").value = s.has_api_key ? "***KEEP***" : "";
}

async function pollEngineStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    const banner = document.getElementById("engineBanner");
    if (s.engine_ready) { banner.classList.add("hidden"); return; }
    banner.textContent = s.engine_message || "Preparing chess engine…";
    banner.classList.remove("hidden");
  } catch (_) { /* server not ready */ }
  setTimeout(pollEngineStatus, 1500);
}

/* ---------------- Event Wiring ---------------- */
window.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  pollEngineStatus();
  await refreshSettings();
  await loadGameList();

  const $ = (id) => document.getElementById(id);
  $("gameSelect").onchange = (e) => loadGame(e.target.value);
  $("btnFirst").onclick = () => jumpToPly(0);
  $("btnLast").onclick = () => jumpToPly(state.game ? state.game.plies.length : 0);
  
  $("btnPrev").onclick = () => {
    if (state.variation) stepVariation(-1);
    else jumpToPly(state.plyIndex - 1);
  };
  
  $("btnNext").onclick = () => {
    if (state.variation) stepVariation(1);
    else jumpToPly(state.plyIndex + 1);
  };
  
  $("btnFlip").onclick = () => { state.flipped = !state.flipped; renderBoard(); };
  $("btnVarPrev").onclick = () => stepVariation(-1);
  if ($("btnVarPlay")) $("btnVarPlay").onclick = () => toggleAutoPlay(1100);
  $("btnVarNext").onclick = () => stepVariation(1);
  $("btnVarExit").onclick = () => exitVariation();

  setupConversationalUI();

  window.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.key === "ArrowLeft") {
      if (state.variation) stepVariation(-1);
      else $("btnPrev").click();
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      if (state.variation) stepVariation(1);
      else $("btnNext").click();
      e.preventDefault();
    } else if (e.key === "Home") {
      jumpToPly(0);
      e.preventDefault();
    } else if (e.key === "End") {
      jumpToPly(state.game ? state.game.plies.length : 0);
      e.preventDefault();
    } else if (e.key === " " && state.variation) {
      toggleAutoPlay(1100);
      e.preventDefault();
    } else if (e.key === "Escape") {
      if (state.variation) {
        exitVariation();
        e.preventDefault();
      } else if (state.selectedSquare) {
        state.selectedSquare = null;
        state.legalDestinations = [];
        renderBoard();
        e.preventDefault();
      }
    }
  });

  $("qaForm").onsubmit = (e) => { e.preventDefault(); askCoach($("qaInput").value); };

  $("btnNewGame").onclick = () => $("modalNewGame").classList.remove("hidden");
  $("btnSettings").onclick = () => $("modalSettings").classList.remove("hidden");
  document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => $(b.dataset.close).classList.add("hidden")));

  $("filePgn").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $("inputPgn").value = await f.text();
    if (!$("inputTitle").value) $("inputTitle").value = f.name.replace(/\.pgn$/i, "");
  };

  $("btnRunAnalyze").onclick = async () => {
    const btn = $("btnRunAnalyze");
    $("analyzeStatus").classList.remove("hidden");
    btn.disabled = true;
    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pgn_text: $("inputPgn").value,
          player_color: document.querySelector("input[name='playerColor']:checked").value,
          title: $("inputTitle").value,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.detail || "Analysis failed");
      $("modalNewGame").classList.add("hidden");
      await loadGameList(data.id);
    } catch (err) {
      alert("Analysis error: " + err.message);
    } finally {
      $("analyzeStatus").classList.add("hidden");
      btn.disabled = false;
    }
  };

  $("btnSaveSettings").onclick = async () => {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: $("selProvider").value, api_key: $("inputApiKey").value,
        model: $("inputModel").value, base_url: $("inputBaseUrl").value,
      }),
    });
    await refreshSettings();
    $("modalSettings").classList.add("hidden");
  };
});

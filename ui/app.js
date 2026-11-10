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
    if (v.step > 0 && v.moves[v.step - 1]) {
      const last = v.moves[v.step - 1].uci;
      hl.add(last.slice(0, 2));
      hl.add(last.slice(2, 4));
    }
    // Arrow for next move in the variation
    if (v.step < v.moves.length) {
      arrows.push({ uci: v.moves[v.step].uci, kind: "line" });
    } else if (bestReplyUci) {
      arrows.push({ uci: bestReplyUci, kind: "best" });
    }
  } else {
    if (ply) {
      hl.add(ply.uci.slice(0, 2));
      hl.add(ply.uci.slice(2, 4));
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
  const c = tp.coaching;
  const [problem, problemStructure] = splitOnce(c.why_it_backfired, "Structurally at the end");
  let [better, doubt] = splitOnce(c.why_best_works, "**Answering the OTB Doubt:**");
  const [betterMain, betterStructure] = splitOnce(better, "Positionally, this line achieves");
  doubt = doubt.replace("**Answering the OTB Doubt:**", "").replace("Why couldn't Black punish this? Because ", "").replace("Why couldn't White punish this? Because ", "");

  const refUci = [tp.played_uci, ...(tp.refutation_pv_uci || []).slice(0, 6)];
  const bestUci = (tp.candidates[0]?.pv_uci || []).slice(0, 7);
  const bestSanPv = tp.candidates[0]?.pv_formatted || tp.best_san;
  const refSanPv = tp.refutation_pv_formatted || tp.played_san;

  const cfCards = (tp.counterfactual_replies_to_best || []).map((cf) => {
    const fullUci = [tp.best_uci, cf.opponent_try_uci, ...(cf.continuation_uci || [])];
    const preview = cf.continuation_formatted || `${cf.opponent_try_san} ${cf.refutation_san}!`;
    return `
      <div class="line-box">
        <div class="line-box-info">
          <div class="line-box-title">If ${esc(cf.opponent_try_san)} &rarr; ${esc(cf.refutation_san)}!</div>
          <div class="line-box-preview">${esc(preview)}</div>
        </div>
        <button class="btn-play-line counterfactual" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(fullUci)}' data-label="If ${esc(cf.opponent_try_san)} vs ${esc(tp.best_san)}" data-kind="counterfactual" data-tp-ply="${tp.ply}">
          &#9654; Play on board
        </button>
      </div>`;
  }).join("");

  return {
    cls: `tp-${tp.severity}`,
    html: `
      <h2><span class="verdict ${tp.severity}">${tp.severity.toUpperCase()}</span>${esc(movePrefix(ply) + ply.san)}</h2>
      <div class="sub">Better was <code>${esc(tp.best_san)}</code> (${esc(tp.best_eval_white_str)} instead of ${esc(tp.played_eval_white_str)}) &middot; ${esc(tp.root_cause_title)}</div>

      <div style="margin: 8px 0 12px; display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn btn-sm btn-play-line" data-fen="${esc(tp.fen_before)}" data-uci='[]' data-label="Decision before ${esc(ply.san)}" data-kind="try_moves" data-tp-ply="${tp.ply}">
          &#8630; Reset to before ${esc(ply.san)} (Try your moves)
        </button>
      </div>

      <h4>What you were going for</h4>
      <p>${inlineMd(c.your_likely_intent)}</p>

      <h4>What went wrong</h4>
      <p>${inlineMd(problem)}</p>
      <div class="line-box">
        <div class="line-box-info">
          <div class="line-box-title">The Refutation Line</div>
          <div class="line-box-preview">${esc(refSanPv)}</div>
        </div>
        <button class="btn-play-line refutation" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(refUci)}' data-label="Refutation of ${esc(ply.san)}" data-kind="refutation" data-tp-ply="${tp.ply}">
          &#9654; Play on board
        </button>
      </div>

      <h4>Why ${esc(tp.best_san)} is better</h4>
      <p>${inlineMd(betterMain)}</p>
      <div class="line-box">
        <div class="line-box-info">
          <div class="line-box-title">Recommended Best Line</div>
          <div class="line-box-preview">${esc(bestSanPv)}</div>
        </div>
        <button class="btn-play-line" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(bestUci)}' data-label="Best Line: ${esc(tp.best_san)}" data-kind="best" data-tp-ply="${tp.ply}">
          &#9654; Play on board
        </button>
      </div>

      ${doubt ? `<h4>"But what if they…"</h4><p>${inlineMd(doubt.charAt(0).toUpperCase() + doubt.slice(1))}</p>` : ""}
      ${cfCards}

      <div class="takeaway"><strong>Take-away for future games:</strong> when ${esc(c.otb_trigger.signal.charAt(0).toLowerCase() + c.otb_trigger.signal.slice(1))} &rarr; ${esc(c.otb_trigger.action)}</div>

      <details class="more"><summary>Engine & Positional details</summary><div class="more-body">
        ${problemStructure ? `<p>${inlineMd(problemStructure)}</p>` : ""}
        ${betterStructure ? `<p>${inlineMd(betterStructure)}</p>` : ""}
        <p class="small muted">Win-chance lost: ${(tp.wp_loss * 100).toFixed(1)}% &middot; Refutation appears at depth ${tp.depth_curve.crossover_depth} &middot; ${esc(tp.singularity.replace(/_/g, " ").toLowerCase())} &middot; Threat: ${esc(tp.null_threat.threat_diagnosis.replace(/_/g, " ").toLowerCase())}</p>
      </div></details>
      ${whiteBoxDetails(tp.whitebox.root)}
    `,
  };
}

function renderVariationNote(v) {
  const currentFen = getCurrentFen();
  const cached = fenEvalCache.get(currentFen) || {};
  const tp = v.originTp || (state.game && currentPly() ? state.tpByPly[currentPly().ply] : null);
  const totalMoves = v.moves.length;
  const curMove = v.step > 0 && v.moves[v.step - 1] ? v.moves[v.step - 1] : null;

  let badgeCls = "good";
  let badgeText = "EXPLORING LINE";
  if (v.kind === "refutation" || v.label.toLowerCase().includes("refutation")) {
    badgeCls = "blunder";
    badgeText = "REFUTATION LINE";
  } else if (v.kind === "best" || v.label.toLowerCase().includes("best")) {
    badgeCls = "good";
    badgeText = "RECOMMENDED BEST LINE";
  } else if (v.kind === "counterfactual" || v.label.toLowerCase().includes("if ")) {
    badgeCls = "mistake";
    badgeText = "COUNTERFACTUAL TRY";
  } else if (v.kind === "user_move" || v.kind === "try_moves" || v.label.toLowerCase().includes("what-if") || v.label.toLowerCase().includes("decision before")) {
    badgeCls = "line";
    badgeText = "WHAT-IF EXPERIMENT";
  }

  // 1. Step Title & Subtitle
  let stepTitle = "";
  if (v.step === 0) {
    stepTitle = `Position before line starts (Move 0 of ${totalMoves})`;
  } else {
    const moveNum = curMove.move_number || Math.floor((v.step + 1) / 2);
    const prefix = curMove.color === "w" ? `${moveNum}. ` : `${moveNum}... `;
    stepTitle = `Move ${v.step} of ${totalMoves}: <code>${esc(prefix + curMove.san)}</code>`;
  }

  // 2. Dynamic Move-by-Move Coaching Commentary
  let commentaryHtml = "";
  const evalDisplay = cached.eval_str || "evaluating…";

  if (v.kind === "refutation" || v.label.toLowerCase().includes("refutation")) {
    if (v.step === 0) {
      commentaryHtml = `
        <h4>Why this position is critical</h4>
        <p>In the game, you played <code>${esc(tp ? tp.played_san : "")}</code>. This refutation line proves why that choice backfired.</p>
        <p class="muted small">Click <strong>Next Move ▶</strong> or press <strong>Right Arrow (&rarr;)</strong> to step through how opponent punishes it.</p>
      `;
    } else if (v.step === 1) {
      commentaryHtml = `
        <h4>The Game Move: <code>${esc(curMove.san)}</code></h4>
        <p>This is where the mistake occurred. Stockfish eval: <strong>${esc(evalDisplay)}</strong>.</p>
        <p><strong>Root Cause:</strong> ${esc(tp ? tp.root_cause_title : "")}</p>
        <p>${inlineMd(tp ? tp.coaching.your_likely_intent : "")}</p>
        <p class="small muted">Notice the square and piece weaknesses this move leaves behind.</p>
      `;
    } else if (v.step === 2) {
      const whyBackfired = tp ? tp.coaching.why_it_backfired : "";
      commentaryHtml = `
        <h4>Opponent's Punishment: <code>${esc(curMove.san)}</code>!</h4>
        <p>Opponent strikes! Stockfish eval swings to <strong>${esc(evalDisplay)}</strong>.</p>
        <p>${inlineMd(whyBackfired)}</p>
      `;
    } else {
      const isPlayer = state.game && curMove.color === state.game.player_color;
      const actor = isPlayer ? "Your defense" : "Opponent's attack";
      commentaryHtml = `
        <h4>${actor}: <code>${esc(curMove.san)}</code></h4>
        <p>Position evaluation: <strong>${esc(evalDisplay)}</strong>.</p>
        ${v.step === totalMoves ? `
          <div class="takeaway"><strong>End of Refutation Line:</strong> Opponent has established decisive tactical or positional control (Eval: <strong>${esc(evalDisplay)}</strong>). Notice the difference compared to playing the Recommended Best Line!</div>
        ` : `
          <p class="small muted">Follow the forcing sequence to see how material or space is conceded.</p>
        `}
      `;
    }
  } else if (v.kind === "best" || v.label.toLowerCase().includes("best")) {
    if (v.step === 0) {
      commentaryHtml = `
        <h4>The Recommended Master Line</h4>
        <p>Stockfish strongly recommends <code>${esc(tp ? tp.best_san : "")}</code> instead of the game move (<code>${esc(tp ? tp.played_san : "")}</code>).</p>
        <p class="muted small">Click <strong>Next Move ▶</strong> or press <strong>Right Arrow (&rarr;)</strong> to follow the active plan.</p>
      `;
    } else if (v.step === 1) {
      const whyBest = tp ? tp.coaching.why_best_works.split("**Answering the OTB Doubt:**")[0] : "";
      commentaryHtml = `
        <h4>Engine Choice: <code>${esc(curMove.san)}</code>!</h4>
        <p>Stockfish eval: <strong>${esc(evalDisplay)}</strong> (White win chance: ${cached.win_prob_white ? Math.round(cached.win_prob_white * 100) + "%" : "..."}).</p>
        <p>${inlineMd(whyBest)}</p>
      `;
    } else {
      const isPlayer = state.game && curMove.color === state.game.player_color;
      const actor = isPlayer ? "Active initiative" : "Opponent's defensive try";
      commentaryHtml = `
        <h4>${actor}: <code>${esc(curMove.san)}</code></h4>
        <p>Position evaluation: <strong>${esc(evalDisplay)}</strong>.</p>
        ${v.step === totalMoves ? `
          <div class="takeaway"><strong>End of Master Line:</strong> You retain a commanding advantage (Eval: <strong>${esc(evalDisplay)}</strong>). Pieces are active and central control is established.</div>
        ` : `
          <p class="small muted">Notice how each piece coordinates smoothly to control key squares.</p>
        `}
      `;
    }
  } else if (v.kind === "counterfactual" || v.label.toLowerCase().includes("if ")) {
    if (v.step === 0) {
      commentaryHtml = `
        <h4>Testing Opponent's Alternate Defense</h4>
        <p>Testing what happens if opponent tries an alternative defense against your best line.</p>
      `;
    } else if (v.step === 1) {
      commentaryHtml = `
        <h4>Your Best Move: <code>${esc(curMove.san)}</code></h4>
        <p>Establishing the active threat. Eval: <strong>${esc(evalDisplay)}</strong>.</p>
      `;
    } else if (v.step === 2) {
      commentaryHtml = `
        <h4>Opponent's Try: <code>${esc(curMove.san)}</code></h4>
        <p>Opponent tries to deflect or challenge your plan. Eval: <strong>${esc(evalDisplay)}</strong>.</p>
      `;
    } else {
      commentaryHtml = `
        <h4>Tactical Refutation: <code>${esc(curMove.san)}</code>!</h4>
        <p>This defuses opponent's idea and wins decisive advantage (Eval: <strong>${esc(evalDisplay)}</strong>).</p>
      `;
    }
  } else {
    // Custom user moves on board (What-if testing)
    if (v.step === 0) {
      commentaryHtml = `
        <h4>Try Your Own Moves</h4>
        <p>The board is set before the critical decision (<code>${esc(tp ? tp.played_san : "")}</code>). <strong>Drag and drop any piece to test a move you would have chosen!</strong></p>
        <p class="muted small">Stockfish will evaluate it in real time and show you the best continuation.</p>
      `;
    } else {
      let verdictBadge = "";
      let verdictMsg = "";
      if (cached.eval_cp !== undefined && tp) {
        const diff = cached.eval_cp - tp.played_eval_cp;
        const colorFactor = (tp.color === "white" || tp.color === "w") ? 1 : -1;
        const gain = diff * colorFactor;

        if (curMove.san === tp.best_san) {
          verdictBadge = `<span class="verdict good">BEST MOVE</span>`;
          verdictMsg = `<p style="color:#a8d88a;font-weight:600">🌟 Outstanding! You found the engine's top recommendation (<code>${esc(tp.best_san)}</code>)!</p>`;
        } else if (gain >= 40) {
          verdictBadge = `<span class="verdict good">STRONG CHOICE</span>`;
          verdictMsg = `<p style="color:#a8d88a">✅ Much better than your game move! You gained +${(gain/100).toFixed(2)} in evaluation.</p>`;
        } else if (gain <= -70) {
          verdictBadge = `<span class="verdict blunder">BLUNDER / RISK</span>`;
          verdictMsg = `<p style="color:#f08a80">⚠️ This gives opponent a strong counter-attack (loses ${(Math.abs(gain)/100).toFixed(2)} eval).</p>`;
        } else {
          verdictBadge = `<span class="verdict good">PLAYABLE</span>`;
          verdictMsg = `<p>Solid move. Keeps the position playable.</p>`;
        }
      }

      commentaryHtml = `
        <h4>Your Move: <code>${esc(curMove.san)}</code> ${verdictBadge}</h4>
        ${verdictMsg}
        <p>Stockfish eval: <strong>${esc(evalDisplay)}</strong> (White win chance: ${cached.win_prob_white ? Math.round(cached.win_prob_white * 100) + "%" : "..."}).</p>
        ${cached.best_move_san ? `
          <div class="line-box" style="margin-top:12px;">
            <div class="line-box-info">
              <div class="line-box-title">Stockfish's Response: <code>${esc(cached.best_move_san)}</code></div>
              <div class="line-box-preview">${esc(cached.pv_formatted || cached.best_move_san)}</div>
            </div>
            <button class="btn-play-line" id="btnPlayEngineResponse" data-uci='${JSON.stringify([cached.best_move_uci])}' data-label="Play ${esc(cached.best_move_san)}">
              &#9654; Play Response
            </button>
          </div>
        ` : ""}
      `;
    }
  }

  // 3. Navigation Controls
  const navHtml = `
    <div style="display:flex;gap:8px;margin:12px 0;flex-wrap:wrap;">
      <button class="btn btn-sm btn-var-step" data-delta="-1" ${v.step === 0 ? "disabled" : ""}>&#9664; Prev Move</button>
      <button class="btn btn-sm btn-primary btn-var-step" data-delta="1" ${v.step >= totalMoves ? "disabled" : ""}>Next Move &#9654;</button>
      <button class="btn btn-sm btn-danger-soft btn-var-exit">&#10005; Back to Game</button>
    </div>
  `;

  // 4. Positional White-Box breakdown
  const wbHtml = cached.whitebox ? whiteBoxDetails(cached.whitebox) : "";

  return {
    cls: `tp-${badgeCls}`,
    html: `
      <h2><span class="verdict ${badgeCls}">${badgeText}</span>${esc(v.label)}</h2>
      <div class="sub">${stepTitle}</div>
      ${navHtml}
      ${commentaryHtml}
      ${wbHtml}
    `
  };
}

function renderOrdinaryNote(ply) {
  const mine = ply.color === state.game.player_color;
  let verdict;
  if (!mine) {
    verdict = `<div class="sub">Opponent's move &middot; eval ${esc(ply.eval_white_str)}</div>`;
  } else if (ply.san === ply.best_before_san || ply.severity === "best") {
    verdict = `<p><span class="verdict good">BEST</span>The engine's top choice.</p>`;
  } else if (ply.severity === "good") {
    verdict = `<p><span class="verdict good">GOOD</span>Solid move. The engine slightly preferred <code>${esc(ply.best_before_san)}</code>, but the difference is small.</p>`;
  } else {
    verdict = `<p><span class="verdict ${ply.severity}">${ply.severity.toUpperCase()}</span>The engine preferred <code>${esc(ply.best_before_san)}</code>.</p>`;
  }
  const nextTp = (state.game.turning_points || []).find((t) => t.ply > ply.ply);
  return {
    cls: "",
    html: `${verdict}
      ${nextTp ? `<p class="muted small" style="margin-top:10px">Next key moment: <a class="habit-link" data-ply="${nextTp.ply}" style="color:var(--blue);cursor:pointer">move ${nextTp.move_number} (${esc(nextTp.played_san)})</a></p>` : ""}
      ${whiteBoxDetails(ply.whitebox_after)}`,
  };
}

function renderSummaryNote() {
  const s = state.game.summary;
  const ps = s.phase_summary || {};
  const habits = (s.top_habits || []).map((h) => {
    const links = h.moves.map((m) => {
      const tp = state.game.turning_points.find((t) => `${t.move_number}. ${t.played_san}` === m);
      return tp ? `<a class="habit-link" data-ply="${tp.ply}">${esc(m)}</a>` : esc(m);
    }).join(", ");
    return `<div class="habit"><div class="habit-title">${esc(h.title)}</div>
      <div class="small">${links}</div>
      <div class="small" style="margin-top:4px"><strong>When</strong> ${esc(h.otb_signal.charAt(0).toLowerCase() + h.otb_signal.slice(1))} <strong>&rarr;</strong> ${esc(h.otb_action)}</div></div>`;
  }).join("");
  return {
    cls: "",
    html: `<h2>Game summary</h2>
      <div class="stat-row">
        <div class="stat"><div class="k">Accuracy</div><div class="v">${s.accuracy_pct}%</div></div>
        <div class="stat"><div class="k">Opening</div><div class="v">${ps.Opening?.accuracy ?? "–"}%</div></div>
        <div class="stat"><div class="k">Middlegame</div><div class="v">${ps.Middlegame?.accuracy ?? "–"}%</div></div>
        <div class="stat"><div class="k">Endgame</div><div class="v">${ps.Endgame?.accuracy ?? "–"}%</div></div>
      </div>
      <h4>Habits to work on</h4>
      ${habits || "<p>No recurring issues found.</p>"}
      <p class="muted small" style="margin-top:12px">Use &#9654; / &rarr; to step through the game, or pick up any piece on the board to test moves! Coloured dots in the move list mark key moments.</p>`,
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
    document.querySelector(".note-scroll").scrollTop = 0;
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

/* ---------------- Move list & graph ---------------- */
function renderMoveList() {
  const el = document.getElementById("moveList");
  let html = "";
  const plies = state.game.plies;
  for (let i = 0; i < plies.length; i++) {
    const p = plies[i];
    if (p.color === "white" || i === 0) {
      html += `<span class="ml-num">${p.move_number}.</span>`;
      if (p.color === "black") html += `<span></span>`;
    }
    const tp = state.tpByPly[p.ply];
    html += `<span class="ml-move" data-ply="${p.ply}">${esc(p.san)}${tp ? `<span class="ml-dot ${tp.severity}"></span>` : ""}</span>`;
  }
  el.innerHTML = html;
  el.querySelectorAll(".ml-move").forEach((m) => (m.onclick = () => jumpToPly(parseInt(m.dataset.ply, 10))));
}

function highlightMoveList() {
  document.querySelectorAll(".ml-move").forEach((m) => {
    const on = parseInt(m.dataset.ply, 10) === state.plyIndex;
    m.classList.toggle("active", on);
    if (on) m.scrollIntoView({ block: "nearest" });
  });
}

function renderEvalGraph() {
  const svg = document.getElementById("evalGraph");
  const plies = state.game.plies;
  const W = 600, H = 60, n = plies.length || 1;
  const pts = [`0,${H / 2}`, ...plies.map((p, i) => `${(((i + 1) / n) * W).toFixed(1)},${(H - p.win_prob_white * H).toFixed(1)}`)];
  const markers = (state.game.turning_points || []).map((tp) => {
    const p = plies[tp.ply - 1];
    const col = tp.severity === "blunder" ? "#e2574c" : tp.severity === "mistake" ? "#e0a83a" : "#6ea8e8";
    return `<circle cx="${((tp.ply / n) * W).toFixed(1)}" cy="${(H - p.win_prob_white * H).toFixed(1)}" r="4" fill="${col}"/>`;
  }).join("");
  svg.innerHTML = `
    <polygon points="0,${H} ${pts.join(" ")} ${W},${H}" fill="rgba(244,241,234,0.85)"/>
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#6b665d" stroke-dasharray="3,3"/>
    ${markers}
    <line id="graphCursor" x1="0" y1="0" x2="0" y2="${H}" stroke="#6ea8e8" stroke-width="2"/>`;
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

let voiceEnabled = false;

function cleanMarkdownForSpeech(md) {
  if (!md) return "";
  return md
    .replace(/###/g, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[.*?\]\(.*?\)/g, "")
    .replace(/[-+]\d+\.?\d*(?:\s*cp|\s*%)?/g, "")
    .replace(/\n+/g, ". ")
    .trim();
}

function speakExplanation(md) {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const clean = cleanMarkdownForSpeech(md);
    if (!clean) return;
    const utter = new SpeechSynthesisUtterance(clean);
    utter.rate = 1.0;
    utter.pitch = 1.0;
    window.speechSynthesis.speak(utter);
  } catch (err) {
    console.warn("Speech synthesis error:", err);
  }
}

let isListening = false;
function setupVoiceInput() {
  const btnMic = document.getElementById("btnMic");
  if (!btnMic) return;
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    btnMic.title = "Voice input is not supported in this browser window";
    btnMic.style.opacity = "0.45";
    btnMic.onclick = () => {
      alert("Voice input (SpeechRecognition) is not available in this browser window. You can type in the question box!");
    };
    return;
  }

  const recog = new SpeechRec();
  recog.continuous = false;
  recog.interimResults = true;
  recog.lang = "en-US";

  function stopListening() {
    isListening = false;
    btnMic.classList.remove("recording");
    btnMic.title = "Talk to coach (Click to speak)";
    document.getElementById("qaInput").placeholder = "e.g. What if I played f4 instead? (or click 🎤 to talk)";
  }

  recog.onstart = () => {
    isListening = true;
    btnMic.classList.add("recording");
    btnMic.title = "Listening... Speak your chess question!";
    document.getElementById("qaInput").placeholder = "Listening... speak now!";
  };

  recog.onresult = (e) => {
    let transcript = "";
    for (let i = e.resultIndex; i < e.results.length; ++i) {
      transcript += e.results[i][0].transcript;
    }
    document.getElementById("qaInput").value = transcript;
    if (e.results[0].isFinal) {
      stopListening();
      askCoach(transcript);
    }
  };

  recog.onerror = (e) => {
    console.warn("Speech recognition error:", e.error);
    stopListening();
  };

  recog.onend = () => {
    stopListening();
  };

  btnMic.onclick = () => {
    if (isListening) {
      recog.stop();
      stopListening();
    } else {
      try {
        recog.start();
      } catch (err) {
        console.error("Speech recognition start failed:", err);
      }
    }
  };
}

function setupVoiceToggle() {
  const btn = document.getElementById("btnVoiceToggle");
  if (!btn) return;
  btn.onclick = () => {
    voiceEnabled = !voiceEnabled;
    if (voiceEnabled) {
      btn.innerHTML = "&#128266;";
      btn.classList.remove("muted");
      btn.title = "Voice narration: ON (Click to mute)";
    } else {
      btn.innerHTML = "&#128263;";
      btn.classList.add("muted");
      btn.title = "Voice narration: OFF (Click to unmute)";
      if (window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) {}
      }
    }
  };
}

async function askCoach(question) {
  if (!question.trim() || !state.game) return;
  const askedAt = state.plyIndex;
  const msgs = document.getElementById("qaMessages");
  document.getElementById("qaInput").value = "";
  msgs.insertAdjacentHTML("beforeend", `<div class="qa-msg user"><div class="qa-bubble">${esc(question)}</div></div>`);
  const id = `a${Date.now()}`;
  msgs.insertAdjacentHTML("beforeend", `<div class="qa-msg" id="${id}"><div class="qa-bubble"><em>Thinking…</em></div></div>`);
  const loadingEl = document.getElementById(id);
  if (loadingEl) loadingEl.scrollIntoView({ block: "nearest" });
  saveChat();

  const ply = currentPly();
  let fenCurrent = getCurrentFen(), fenBefore = null;
  if (!state.variation && ply) {
    fenBefore = ply.fen_before;
  }

  let answerHtml;
  try {
    const resp = await fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        fen_current: fenCurrent,
        fen_before: fenBefore,
        ply_meta: state.variation ? null : ply,
        perspective: state.game.player_color || "white",
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Request failed");
    const btns = (data.interactive_lines || []).map((l) => `
      <button class="btn-play-line" data-fen="${esc(l.fen)}" data-uci='${JSON.stringify(l.uci_moves)}' data-label="${esc(l.label)}">
        &#9654; ${esc(l.label)}
      </button>`).join("");
    answerHtml = `<div class="qa-bubble">${renderMarkdown(data.answer_markdown)}${btns ? `<div class="line-btns">${btns}</div>` : ""}</div>`;

    // Automatically demonstrate primary variation line on the board
    if (data.interactive_lines && data.interactive_lines.length > 0) {
      const l0 = data.interactive_lines[0];
      startVariation(l0.label, l0.fen, l0.uci_moves, 0);
      toggleAutoPlay(1100);
    }
    if (voiceEnabled) {
      speakExplanation(data.answer_markdown);
    }
  } catch (err) {
    answerHtml = `<div class="qa-bubble">Sorry — ${esc(err.message)}</div>`;
  }

  if (state.plyIndex === askedAt) {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = answerHtml; bindLineButtons(el); el.scrollIntoView({ block: "nearest" }); }
    saveChat();
  } else {
    const tmp = document.createElement("div");
    tmp.innerHTML = state.chats[askedAt] || "";
    const el = tmp.querySelector(`#${id}`);
    if (el) el.innerHTML = answerHtml;
    state.chats[askedAt] = tmp.innerHTML;
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

  setupVoiceInput();
  setupVoiceToggle();

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

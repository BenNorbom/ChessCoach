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
      if (state.variation && state.variation.step === state.variation.moves.length && data.best_move_uci) {
        renderBoard();
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

  // Bind square clicks and drag events
  boardEl.querySelectorAll(".sq").forEach((sqEl) => {
    const sq = sqEl.dataset.sq;
    sqEl.onclick = () => onSquareClick(sq);

    // Drag-and-drop
    sqEl.ondragover = (e) => e.preventDefault();
    sqEl.ondrop = (e) => onDrop(e, sq);

    const svg = sqEl.querySelector(".piece-svg");
    if (svg && sqEl.classList.contains("has-piece")) {
      svg.setAttribute("draggable", "true");
      svg.ondragstart = (e) => onDragStart(e, sq);
    }
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

/* ---------------- Piece Movement & Interaction ---------------- */
function onSquareClick(sq) {
  const c = getCurrentChess();
  
  // If a square is already selected and clicked square is a destination:
  const dest = state.legalDestinations.find((d) => d.to === sq);
  if (state.selectedSquare && dest) {
    makeUserMove(state.selectedSquare, sq, dest.promotion ? "q" : undefined);
    return;
  }
  
  // If clicked square has a piece belonging to the side to move:
  const piece = c.get(sq);
  if (piece && piece.color === c.turn()) {
    state.selectedSquare = sq;
    const verboseMoves = c.moves({ square: sq, verbose: true });
    state.legalDestinations = verboseMoves.map((m) => ({
      to: m.to,
      isCapture: Boolean(m.captured || m.flags.includes("c") || m.flags.includes("e")),
      promotion: Boolean(m.promotion || m.flags.includes("p"))
    }));
    renderBoard();
    return;
  }
  
  // Clicking anywhere else deselects
  if (state.selectedSquare) {
    state.selectedSquare = null;
    state.legalDestinations = [];
    renderBoard();
  }
}

function onDragStart(e, sq) {
  const c = getCurrentChess();
  const piece = c.get(sq);
  if (!piece || piece.color !== c.turn()) {
    e.preventDefault();
    return;
  }
  state.selectedSquare = sq;
  state.dragSquare = sq;
  const verboseMoves = c.moves({ square: sq, verbose: true });
  state.legalDestinations = verboseMoves.map((m) => ({
    to: m.to,
    isCapture: Boolean(m.captured || m.flags.includes("c") || m.flags.includes("e")),
    promotion: Boolean(m.promotion || m.flags.includes("p"))
  }));
  renderBoard();
  e.dataTransfer.setData("text/plain", sq);
  e.dataTransfer.effectAllowed = "move";
}

function onDrop(e, sq) {
  e.preventDefault();
  const from = state.dragSquare || state.selectedSquare;
  state.dragSquare = null;
  if (!from) return;
  const dest = state.legalDestinations.find((d) => d.to === sq);
  if (dest) {
    makeUserMove(from, sq, dest.promotion ? "q" : undefined);
  } else {
    state.selectedSquare = null;
    state.legalDestinations = [];
    renderBoard();
  }
}

function makeUserMove(from, to, promotion = "q") {
  const currentFen = getCurrentFen();
  const c = new window.Chess(currentFen);
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
        fen: c.fen()
      });
      v.fens.push(c.fen());
      v.uciMoves = v.moves.map((x) => x.uci);
      v.step = v.moves.length;
    }
  } else {
    const ply = currentPly();
    const label = ply ? `What-if from ${movePrefix(ply)}${ply.san}` : "What-if from start";
    state.variation = {
      label,
      startFen: currentFen,
      uciMoves: [uci],
      moves: [{
        uci,
        san: m.san,
        color: m.color,
        fen: c.fen()
      }],
      fens: [currentFen, c.fen()],
      step: 1
    };
  }
  
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
}

/* ---------------- Variation System ---------------- */
function startVariation(label, startFen, uciMoves, startStep = null) {
  const c = new window.Chess(startFen);
  const moves = [];
  const fens = [startFen];
  for (const u of uciMoves) {
    const from = u.slice(0, 2);
    const to = u.slice(2, 4);
    const piece = c.get(from);
    const promo = u[4] || (piece && piece.type === "p" && (to[1] === "8" || to[1] === "1") ? "q" : undefined);
    const m = c.move({ from, to, promotion: promo });
    if (!m) break;
    moves.push({
      uci: m.from + m.to + (m.promotion || ""),
      san: m.san,
      color: m.color,
      fen: c.fen()
    });
    fens.push(c.fen());
  }
  const step = startStep !== null ? Math.max(0, Math.min(moves.length, startStep)) : Math.min(1, moves.length);
  state.variation = {
    label,
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
}

function stepVariation(delta) {
  if (!state.variation) return;
  const v = state.variation;
  v.step = Math.max(0, Math.min(v.moves.length, v.step + delta));
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
}

function jumpVariationStep(step) {
  if (!state.variation) return;
  const v = state.variation;
  v.step = Math.max(0, Math.min(v.moves.length, step));
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  renderVariationBanner();
}

function exitVariation() {
  state.variation = null;
  state.selectedSquare = null;
  state.legalDestinations = [];
  renderBoard();
  document.getElementById("variationBanner").classList.add("hidden");
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
        <button class="btn-play-line counterfactual" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(fullUci)}' data-label="If ${esc(cf.opponent_try_san)} vs ${esc(tp.best_san)}">
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
        <button class="btn btn-sm btn-play-line" data-fen="${esc(tp.fen_before)}" data-uci='[]' data-label="Decision before ${esc(ply.san)}">
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
        <button class="btn-play-line refutation" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(refUci)}' data-label="Refutation of ${esc(ply.san)}">
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
        <button class="btn-play-line" data-fen="${esc(tp.fen_before)}" data-uci='${JSON.stringify(bestUci)}' data-label="Best Line: ${esc(tp.best_san)}">
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

function renderNote() {
  const el = document.getElementById("noteContent");
  const ply = currentPly();
  let note;
  if (!ply) note = renderSummaryNote();
  else if (state.tpByPly[ply.ply]) note = renderTurningPointNote(ply, state.tpByPly[ply.ply]);
  else note = renderOrdinaryNote(ply);
  el.className = `note ${note.cls}`;
  el.innerHTML = note.html;
  bindLineButtons(el);
  el.querySelectorAll(".habit-link").forEach((a) => (a.onclick = () => jumpToPly(parseInt(a.dataset.ply, 10))));
  document.querySelector(".note-scroll").scrollTop = 0;
}

function bindLineButtons(root) {
  root.querySelectorAll(".btn-play-line, .btn-var").forEach((b) => {
    b.onclick = () => {
      const uciMoves = JSON.parse(b.dataset.uci || "[]");
      startVariation(b.dataset.label, b.dataset.fen, uciMoves, uciMoves.length > 0 ? 1 : 0);
    };
  });
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
  $("btnVarNext").onclick = () => stepVariation(1);
  $("btnVarExit").onclick = () => exitVariation();

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

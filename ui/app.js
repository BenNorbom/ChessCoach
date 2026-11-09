/* ChessCoach UI */

const state = {
  game: null,
  plyIndex: 0,          // 0 = start position, N = position after ply N
  flipped: false,
  variation: null,      // { label, uciMoves, fens, step }
  tpByPly: {},
  chats: {},            // plyIndex -> html of chat messages for that position
};

/* ---------------- FEN helpers ---------------- */
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

function boardToFen(grid, turn) {
  const rows = grid.map((row) => {
    let s = "", empty = 0;
    for (const p of row) {
      if (!p) empty++;
      else { if (empty) { s += empty; empty = 0; } s += p; }
    }
    return s + (empty || "");
  });
  return `${rows.join("/")} ${turn} - - 0 1`;
}

function sqToRC(sq) {
  return [8 - parseInt(sq[1], 10), sq.charCodeAt(0) - 97];
}

function applyUciToFen(fen, uci) {
  const { grid, turn } = parseFenBoard(fen);
  const [r1, c1] = sqToRC(uci.slice(0, 2));
  const [r2, c2] = sqToRC(uci.slice(2, 4));
  const promo = uci[4] || null;
  const piece = grid[r1][c1];
  if (!piece) return fen;
  if ((piece === "P" || piece === "p") && c1 !== c2 && !grid[r2][c2]) grid[r1][c2] = null; // en passant
  if ((piece === "K" || piece === "k") && Math.abs(c2 - c1) === 2) {               // castling
    if (c2 === 6) { grid[r1][5] = grid[r1][7]; grid[r1][7] = null; }
    else { grid[r1][3] = grid[r1][0]; grid[r1][0] = null; }
  }
  grid[r1][c1] = null;
  grid[r2][c2] = promo ? (turn === "w" ? promo.toUpperCase() : promo.toLowerCase()) : piece;
  return boardToFen(grid, turn === "w" ? "b" : "w");
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

/* ---------------- Board ---------------- */
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

function currentPly() {
  return state.plyIndex > 0 ? state.game.plies[state.plyIndex - 1] : null;
}

function movePrefix(p) {
  return p.color === "white" ? `${p.move_number}. ` : `${p.move_number}... `;
}

function renderBoard() {
  if (!state.game) return;
  let fen = state.game.initial_fen;
  const hl = new Set();
  const arrows = [];
  let winProb = 0.5;
  const ply = currentPly();

  if (state.variation) {
    const v = state.variation;
    fen = v.fens[v.step];
    if (v.step > 0) {
      const last = v.uciMoves[v.step - 1];
      hl.add(last.slice(0, 2)); hl.add(last.slice(2, 4));
    }
    if (v.step < v.uciMoves.length) arrows.push({ uci: v.uciMoves[v.step], kind: "line" });
    document.getElementById("variationBanner").classList.remove("hidden");
    document.getElementById("varTitle").textContent = v.label;
    document.getElementById("varStepLabel").textContent = `move ${v.step} of ${v.uciMoves.length}`;
  } else {
    document.getElementById("variationBanner").classList.add("hidden");
    if (ply) {
      fen = ply.fen_after;
      hl.add(ply.uci.slice(0, 2)); hl.add(ply.uci.slice(2, 4));
      winProb = ply.win_prob_white;
      const tp = state.tpByPly[ply.ply];
      if (tp) arrows.push({ uci: tp.best_uci, kind: "best" });
    }
  }

  const { grid } = parseFenBoard(fen);
  let html = "";
  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = state.flipped ? 7 - vr : vr;
      const c = state.flipped ? 7 - vc : vc;
      const sq = String.fromCharCode(97 + c) + (8 - r);
      const piece = grid[r][c];
      let inner = piece && PIECE_SVGS[piece] ? PIECE_SVGS[piece] : "";
      if (vc === 0) inner += `<span class="coord-rank">${8 - r}</span>`;
      if (vr === 7) inner += `<span class="coord-file">${String.fromCharCode(97 + c)}</span>`;
      html += `<div class="sq ${(r + c) % 2 === 0 ? "light" : "dark"} ${hl.has(sq) ? "hl" : ""}">${inner}</div>`;
    }
  }
  document.getElementById("boardGrid").innerHTML = html;
  drawArrows(arrows);

  document.getElementById("thermoFill").style.height = `${Math.round(winProb * 100)}%`;
  document.getElementById("currentMoveLabel").textContent = ply ? movePrefix(ply) + ply.san : "Start position";
  document.getElementById("currentEvalLabel").textContent = ply ? ply.eval_white_str : "0.00";
}

/* ---------------- Notes (only for the current move) ---------------- */
function splitOnce(text, marker) {
  const i = (text || "").indexOf(marker);
  return i < 0 ? [text || "", ""] : [text.slice(0, i).trim(), text.slice(i).trim()];
}

function lineButton(label, fen, uciMoves) {
  return `<button class="btn-var" data-fen="${esc(fen)}" data-uci='${JSON.stringify(uciMoves)}' data-label="${esc(label)}">▶ ${esc(label)}</button>`;
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
  const cfBtns = (tp.counterfactual_replies_to_best || []).map((cf) =>
    lineButton(`If ${cf.opponent_try_san} after ${tp.best_san}`, tp.fen_before, [tp.best_uci, cf.opponent_try_uci, ...(cf.continuation_uci || [])])
  ).join("");

  return {
    cls: `tp-${tp.severity}`,
    html: `
      <h2><span class="verdict ${tp.severity}">${tp.severity.toUpperCase()}</span>${esc(movePrefix(ply) + ply.san)}</h2>
      <div class="sub">Better was <code>${esc(tp.best_san)}</code> (${esc(tp.best_eval_white_str)} instead of ${esc(tp.played_eval_white_str)}) · ${esc(tp.root_cause_title)}</div>

      <h4>What you were going for</h4>
      <p>${inlineMd(c.your_likely_intent)}</p>

      <h4>What went wrong</h4>
      <p>${inlineMd(problem)}</p>

      <h4>Why ${esc(tp.best_san)} is better</h4>
      <p>${inlineMd(betterMain)}</p>
      ${doubt ? `<h4>"But what if they…"</h4><p>${inlineMd(doubt.charAt(0).toUpperCase() + doubt.slice(1))}</p>` : ""}

      <div class="takeaway"><strong>Take-away for future games:</strong> when ${esc(c.otb_trigger.signal.charAt(0).toLowerCase() + c.otb_trigger.signal.slice(1))} → ${esc(c.otb_trigger.action)}</div>

      <div class="line-btns">
        ${lineButton(`Best line: ${tp.best_san}`, tp.fen_before, bestUci)}
        ${lineButton(`Why ${ply.san} fails`, tp.fen_before, refUci)}
        ${cfBtns}
      </div>

      <details class="more"><summary>Engine details</summary><div class="more-body">
        ${problemStructure ? `<p>${inlineMd(problemStructure)}</p>` : ""}
        ${betterStructure ? `<p>${inlineMd(betterStructure)}</p>` : ""}
        <p>Win-chance lost: ${(tp.wp_loss * 100).toFixed(1)}% · Refutation appears at depth ${tp.depth_curve.crossover_depth} · ${esc(tp.singularity.replace(/_/g, " ").toLowerCase())} · threat probe: ${esc(tp.null_threat.threat_diagnosis.replace(/_/g, " ").toLowerCase())}</p>
      </div></details>
      ${whiteBoxDetails(tp.whitebox.root)}
    `,
  };
}

function renderOrdinaryNote(ply) {
  const mine = ply.color === state.game.player_color;
  let verdict;
  if (!mine) {
    verdict = `<div class="sub">Opponent's move · eval ${esc(ply.eval_white_str)}</div>`;
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
      <div class="small" style="margin-top:4px"><strong>When</strong> ${esc(h.otb_signal.charAt(0).toLowerCase() + h.otb_signal.slice(1))} <strong>→</strong> ${esc(h.otb_action)}</div></div>`;
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
      <p class="muted small" style="margin-top:12px">Use ▶ / → to step through the game. Coloured dots in the move list mark the key moments; a note appears when you reach one.</p>`,
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
  root.querySelectorAll(".btn-var").forEach((b) => {
    b.onclick = () => startVariation(b.dataset.label, b.dataset.fen, JSON.parse(b.dataset.uci || "[]"));
  });
}

function startVariation(label, startFen, uciMoves) {
  const fens = [startFen];
  for (const u of uciMoves) fens.push(applyUciToFen(fens[fens.length - 1], u));
  state.variation = { label, uciMoves, fens, step: Math.min(1, uciMoves.length) };
  renderBoard();
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
  if (!cur) return;
  const x = ((state.plyIndex / (state.game.plies.length || 1)) * 600).toFixed(1);
  cur.setAttribute("x1", x); cur.setAttribute("x2", x);
}

/* ---------------- Q&A (scoped per move) ---------------- */
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
  document.getElementById(id).scrollIntoView({ block: "nearest" });
  saveChat();

  const ply = currentPly();
  let fenCurrent = state.game.initial_fen, fenBefore = null;
  if (state.variation) fenCurrent = state.variation.fens[state.variation.step];
  else if (ply) { fenCurrent = ply.fen_after; fenBefore = ply.fen_before; }

  let answerHtml;
  try {
    const resp = await fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question, fen_current: fenCurrent, fen_before: fenBefore,
        ply_meta: state.variation ? null : ply, perspective: state.game.player_color || "white",
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.detail || "Request failed");
    const btns = (data.interactive_lines || []).map((l) => lineButton(l.label, l.fen, l.uci_moves)).join("");
    answerHtml = `<div class="qa-bubble">${renderMarkdown(data.answer_markdown)}${btns ? `<div class="line-btns">${btns}</div>` : ""}</div>`;
  } catch (err) {
    answerHtml = `<div class="qa-bubble">Sorry — ${esc(err.message)}</div>`;
  }

  if (state.plyIndex === askedAt) {
    const el = document.getElementById(id);
    if (el) { el.innerHTML = answerHtml; bindLineButtons(el); el.scrollIntoView({ block: "nearest" }); }
    saveChat();
  } else {
    // User moved on; store the answer in that move's chat history.
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
  state.variation = null;
  state.plyIndex = Math.max(0, Math.min(state.game.plies.length, ply));
  renderAll();
}

function renderAll() {
  renderBoard();
  renderNote();
  renderQA();
  highlightMoveList();
  moveGraphCursor();
}

function stepVariation(delta) {
  const v = state.variation;
  v.step = Math.max(0, Math.min(v.uciMoves.length, v.step + delta));
  renderBoard();
}

/* ---------------- Data loading ---------------- */
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
  state.chats = {};
  state.flipped = state.game.player_color === "black";
  state.tpByPly = {};
  for (const tp of state.game.turning_points || []) state.tpByPly[tp.ply] = tp;
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

/* ---------------- Wiring ---------------- */
window.addEventListener("DOMContentLoaded", async () => {
  pollEngineStatus();
  await refreshSettings();
  await loadGameList();

  const $ = (id) => document.getElementById(id);
  $("gameSelect").onchange = (e) => loadGame(e.target.value);
  $("btnFirst").onclick = () => jumpToPly(0);
  $("btnLast").onclick = () => jumpToPly(state.game ? state.game.plies.length : 0);
  $("btnPrev").onclick = () => (state.variation ? stepVariation(-1) : jumpToPly(state.plyIndex - 1));
  $("btnNext").onclick = () => (state.variation ? stepVariation(1) : jumpToPly(state.plyIndex + 1));
  $("btnFlip").onclick = () => { state.flipped = !state.flipped; renderBoard(); };
  $("btnVarPrev").onclick = () => stepVariation(-1);
  $("btnVarNext").onclick = () => stepVariation(1);
  $("btnVarExit").onclick = () => { state.variation = null; renderBoard(); };

  window.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.key === "ArrowLeft") $("btnPrev").click();
    else if (e.key === "ArrowRight") $("btnNext").click();
    else if (e.key === "Home") $("btnFirst").click();
    else if (e.key === "End") $("btnLast").click();
    else if (e.key === "Escape" && state.variation) $("btnVarExit").click();
    else return;
    e.preventDefault();
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

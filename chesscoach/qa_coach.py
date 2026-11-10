"""Live Interactive Chess Coach Q&A Engine.

Parses natural-language chess questions ("What if I played f4?", "Why was Kh1
a mistake?", "What is Black threatening?", "What is the plan here?"), executes
real-time Stockfish + White-Box + Counterfactual probes, and synthesizes an
articulate 1850+ coaching response (via grounded LLM if configured, or rich
deterministic IM-style synthesis out of the box).
"""

from __future__ import annotations

import json
import re
from typing import Any

import chess

from chesscoach.config import LLMSettings
from chesscoach.interrogator import HybridInterrogator
from chesscoach.llm_client import call_grounded_llm, is_llm_configured
from chesscoach.synthesizer import (
    _build_backfire_explanation,
    _build_best_plan_explanation,
    _build_intent_explanation,
    _classify_root_cause,
    HABIT_CATALOG,
)


def _extract_candidate_move(
    question: str,
    board: chess.Board,
    exclude_uci: str | None = None,
) -> chess.Move | None:
    """Match any legal SAN or UCI move referenced inside a natural-language question."""
    norm = question.replace("0-0-0", "O-O-O").replace("0-0", "O-O")
    # Strip move numbers like "13." or "13..."
    norm = re.sub(r"\b\d+\.+", " ", norm)
    raw_tokens = re.split(r"[\s,;:()\[\]\"'`]+", norm)
    tokens = [t.strip("?!.") for t in raw_tokens if t.strip("?!.")]

    legal_moves = list(board.legal_moves)
    san_map: dict[str, chess.Move] = {}
    san_no_check_map: dict[str, chess.Move] = {}
    uci_map: dict[str, chess.Move] = {}

    for m in legal_moves:
        s = board.san(m)
        san_map[s] = m
        san_no_check_map[s.rstrip("+#")] = m
        uci_map[m.uci()] = m

    matched: list[chess.Move] = []
    # Exact case-sensitive SAN match first (critical so "b3" doesn't collide with "Bb3" or English words like "be")
    common_english = {"a", "in", "on", "to", "is", "it", "be", "by", "or", "at", "do", "go", "no", "so", "if"}
    for tok in tokens:
        if tok in san_map:
            matched.append(san_map[tok])
        elif tok in san_no_check_map:
            matched.append(san_no_check_map[tok])
        elif tok.lower() in uci_map and tok.lower() not in common_english:
            matched.append(uci_map[tok.lower()])

    if not matched:
        # Case-insensitive fallback ONLY for explicit piece moves / castling (length >= 3 or captures 'x')
        lower_san = {k.lower(): v for k, v in san_no_check_map.items() if len(k) >= 3 or "x" in k}
        for tok in tokens:
            tl = tok.lower()
            if tl in lower_san and tl not in common_english:
                matched.append(lower_san[tl])

    if not matched:
        return None

    # Prefer a move different from the already-played move if user wrote "What if f4 instead of Kh1?"
    for m in matched:
        if m.uci() != exclude_uci:
            return m
    return matched[0]


def _format_move_comparison_answer(
    question: str,
    board_before: chess.Board,
    candidate_move: chess.Move,
    probe_decision: dict[str, Any],
    game_played_san: str | None = None,
    game_played_eval_str: str | None = None,
    conversational_history: list[dict[str, str]] | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Build a conversational 1850-level coaching dialogue answer."""
    cand_san = probe_decision["played_san"]
    best_san = probe_decision["best_san"]
    cand_eval = probe_decision["played_eval_white_str"]
    best_eval = probe_decision["best_eval_white_str"]
    sev = probe_decision["severity"]
    wp_loss_pct = probe_decision["wp_loss"] * 100.0

    lines_out: list[str] = []
    interactive_lines: list[dict[str, Any]] = []

    opener = "Looking closer at your idea:\n\n" if conversational_history else ""

    if cand_san == best_san or wp_loss_pct < 2.5:
        lines_out.append(
            f"{opener}### Great eye! **`{cand_san}`** is a strong move ({cand_eval})\n\n"
            f"You're right on target. `{cand_san}` is {'the engine\'s top choice' if cand_san == best_san else f'just as strong as `{best_san}` ({best_eval})'} here."
        )
        best_pv = probe_decision["candidates"][0]["pv_formatted"]
        lines_out.append(
            f"**The Master Plan:** `{best_pv}`\n\n"
            f"Playing this immediately seizes the initiative and coordinates your pieces onto commanding squares."
        )
        d_best = probe_decision["whitebox"]["delta_root_to_best"]
        if d_best["primary_drivers"]:
            drivers = ", ".join(
                f"{d['label']} ({d['delta_cp']:+d} cp)"
                for d in d_best["primary_drivers"][:2]
            )
            lines_out.append(f"**Positional Advantage:** This directly improves your {drivers}.")

        cfs = probe_decision.get("counterfactual_replies_to_best", [])
        if cfs and cfs[0].get("refutation_san"):
            c0 = cfs[0]
            lines_out.append(
                f"**If opponent tries to counter:** Against `...{c0['opponent_try_san']}`, you answer with `{c0['refutation_san']}!` (`{c0['continuation_formatted']}`), keeping total control."
            )

        lines_out.append("Try playing this line on the board below—see how smoothly your pieces control the center.")
        interactive_lines.append(
            {
                "label": f"Best line: {cand_san}",
                "fen": board_before.fen(),
                "uci_moves": probe_decision["candidates"][0]["pv_uci"],
            }
        )
    else:
        pseudo_tp = {
            "fen_before": board_before.fen(),
            "color": "white" if board_before.turn == chess.WHITE else "black",
            **probe_decision,
        }
        rc_code = _classify_root_cause(pseudo_tp)
        habit = HABIT_CATALOG[rc_code]
        backfire = _build_backfire_explanation(pseudo_tp).replace("**", "")
        best_plan = _build_best_plan_explanation(pseudo_tp).replace("**", "")

        compare_game = ""
        if game_played_san and game_played_san != cand_san and game_played_eval_str:
            compare_game = f" (in the game you played `{game_played_san}` `{game_played_eval_str}`)"

        lines_out.append(
            f"{opener}### Analysis of **`{cand_san}`** ({sev.capitalize()}{compare_game})\n\n"
            f"I see why you're considering **`{cand_san}`**—it looks tempting on the surface. But here is the tactical catch:\n\n"
            f"{backfire}\n\n"
            f"Stockfish rates this at **`{cand_eval}`** (a loss of about {wp_loss_pct:.1f}% win equity) compared to the master move **`{best_san}`** (**`{best_eval}`**)."
        )

        lines_out.append(
            f"**Why `{best_san}` is much stronger:**\n{best_plan}."
        )

        lines_out.append(
            f"**Mental Trigger for Your Next Game:**\n*When {habit['otb_signal'].lower()}* &rarr; **{habit['otb_action']}**"
        )

        lines_out.append(
            f"I've added the refutation line to your board below. How would you handle opponent's reply?"
        )

        if probe_decision["refutation_pv_uci"]:
            interactive_lines.append(
                {
                    "label": f"Refutation of {cand_san}: {probe_decision['opponent_best_reply_san']}",
                    "fen": board_before.fen(),
                    "uci_moves": [probe_decision["played_uci"]]
                    + probe_decision["refutation_pv_uci"][:5],
                }
            )
        interactive_lines.append(
            {
                "label": f"Recommended Best: {best_san}",
                "fen": board_before.fen(),
                "uci_moves": probe_decision["candidates"][0]["pv_uci"][:6],
            }
        )

    return "\n\n".join(lines_out), interactive_lines


def _format_position_overview_answer(
    overview: dict[str, Any],
) -> tuple[str, list[dict[str, Any]]]:
    """Build a conversational 1850-level coaching overview for position plans and threats."""
    turn_cap = overview["turn"].capitalize()
    opp_cap = "Black" if overview["turn"] == "white" else "White"
    top_lines = overview["top_lines"]
    wb = overview["whitebox"]
    opp_threat = overview.get("opponent_threat_if_pass")
    phase = wb.get("phase_label", "Game")

    lines_out: list[str] = []
    interactive_lines: list[dict[str, Any]] = []

    lead_eval = top_lines[0]["eval_white_str"] if top_lines else "0.00"
    lines_out.append(
        f"### Position Overview ({phase} &middot; {turn_cap} to move &middot; `{lead_eval}`)\n\n"
        f"Let's look at the big picture on the board right now."
    )

    if opp_threat and opp_threat.get("threat_san"):
        lines_out.append(
            f"**Opponent's Plan to Watch:** If you pass the turn, {opp_cap} is ready to strike with **`{opp_threat['threat_san']}`** (`{opp_threat['threat_pv']}`). Anticipating this threat is your first priority."
        )

    facts = wb.get("facts", [])
    high_impact = sorted(facts, key=lambda f: abs(f["impact_cp"]), reverse=True)[:3]
    if high_impact:
        fact_bullets = "; ".join(f["description"] for f in high_impact)
        lines_out.append(f"**Key Imbalances:** {fact_bullets}.")

    if top_lines:
        best_plan = top_lines[0]
        lines_out.append(
            f"**Recommended Master Plan:** Your strongest continuation is **`{best_plan['san']}`** (`{best_plan['eval_white_str']}`), continuing with `{best_plan['pv_formatted']}`. This gives your pieces the most active squares."
        )
        for tl in top_lines[:3]:
            interactive_lines.append(
                {
                    "label": f"Plan #{tl['rank']}: {tl['san']} ({tl['eval_white_str']})",
                    "fen": overview["fen"],
                    "uci_moves": tl["pv_uci"],
                }
            )

    lines_out.append("What move would you like to explore or test in this position?")
    return "\n\n".join(lines_out), interactive_lines


def answer_coaching_question(
    interrogator: HybridInterrogator,
    question: str,
    fen_current: str,
    fen_before: str | None = None,
    ply_meta: dict[str, Any] | None = None,
    perspective_str: str = "white",
    history: list[dict[str, str]] | None = None,
    settings: LLMSettings | None = None,
) -> dict[str, Any]:
    """Answer a free-form coaching question on the selected move/position."""
    perspective = (
        chess.WHITE if perspective_str.lower().startswith("w") else chess.BLACK
    )
    q_lower = question.lower().strip()
    board_curr = chess.Board(fen_current)
    board_prev = chess.Board(fen_before) if fen_before else None

    played_uci = ply_meta.get("uci") if ply_meta else None
    played_san = ply_meta.get("san") if ply_meta else None
    played_eval_str = ply_meta.get("eval_white_str") if ply_meta else None

    # Check for context from prior conversational turns
    prior_user_moves = []
    if history:
        for msg in reversed(history):
            if msg.get("role") == "user":
                prior_m = _extract_candidate_move(msg.get("content", ""), board_prev or board_curr)
                if prior_m:
                    prior_user_moves.append(prior_m)

    # 1. Check if the user asked about an alternative move on `board_prev` ("What if I played f4 instead?")
    cand_prev = (
        _extract_candidate_move(question, board_prev, exclude_uci=played_uci)
        if board_prev is not None
        else None
    )
    cand_curr = _extract_candidate_move(question, board_curr)

    # If user asked a short follow-up like "What if they take?" or "Why does that fail?", inherit prior candidate
    if cand_prev is None and cand_curr is None and prior_user_moves and board_prev is not None:
        if any(w in q_lower for w in ("why", "what if", "how", "explain", "does that", "take", "instead")):
            cand_prev = prior_user_moves[0]

    asking_alternative = any(
        kw in q_lower
        for kw in ("instead", "what if i", "why not", "could i", "should i have", "how about")
    )

    dossier: dict[str, Any]
    det_markdown: str
    interactive_lines: list[dict[str, Any]]
    suggested_followups: list[str] = []

    if cand_prev is not None and (asking_alternative or cand_curr is None or cand_prev.uci() != played_uci):
        decision = interrogator.interrogate_decision(
            board_prev, cand_prev, board_prev.turn, deep_depth=15
        )
        cand_san = board_prev.san(cand_prev)
        dossier = {
            "query_type": "alternative_move_probe",
            "question": question,
            "fen_probed": board_prev.fen(),
            "candidate_move": cand_san,
            "game_move": played_san,
            "probe": decision,
        }
        det_markdown, interactive_lines = _format_move_comparison_answer(
            question,
            board_prev,
            cand_prev,
            decision,
            game_played_san=played_san,
            game_played_eval_str=played_eval_str,
            conversational_history=history,
        )
        opp_reply = decision.get("opponent_best_reply_san")
        best_san = decision.get("best_san")
        if opp_reply:
            suggested_followups.append(f"What if opponent doesn't play {opp_reply}?")
        if best_san and best_san != cand_san:
            suggested_followups.append(f"Why is {best_san} the master choice?")
        suggested_followups.append("What is opponent's biggest threat here?")

    elif cand_curr is not None:
        decision = interrogator.interrogate_decision(
            board_curr, cand_curr, board_curr.turn, deep_depth=15
        )
        cand_san = board_curr.san(cand_curr)
        dossier = {
            "query_type": "continuation_move_probe",
            "question": question,
            "fen_probed": board_curr.fen(),
            "candidate_move": cand_san,
            "probe": decision,
        }
        det_markdown, interactive_lines = _format_move_comparison_answer(
            question, board_curr, cand_curr, decision, conversational_history=history
        )
        suggested_followups.append(f"What is the follow-up after {cand_san}?")
        suggested_followups.append("What is opponent threatening right now?")

    elif (
        board_prev is not None
        and played_uci
        and any(
            kw in q_lower
            for kw in ("why was", "why is", "mistake", "blunder", "wrong", "miss", "explain this move")
        )
    ):
        mv_played = chess.Move.from_uci(played_uci)
        decision = interrogator.interrogate_decision(
            board_prev, mv_played, board_prev.turn, deep_depth=15
        )
        dossier = {
            "query_type": "played_move_diagnosis",
            "question": question,
            "fen_probed": board_prev.fen(),
            "played_move": played_san,
            "probe": decision,
        }
        det_markdown, interactive_lines = _format_move_comparison_answer(
            question, board_prev, mv_played, decision, conversational_history=history
        )
        best_san = decision.get("best_san")
        if best_san:
            suggested_followups.append(f"How does {best_san} prevent opponent's counterplay?")
        suggested_followups.append("What mental trigger helps avoid this in tournament games?")

    else:
        overview = interrogator.probe_position_and_move(
            fen_current, None, perspective=perspective, depth=15
        )
        dossier = {
            "query_type": "position_plan_and_threats",
            "question": question,
            "fen_probed": fen_current,
            "overview": overview,
        }
        det_markdown, interactive_lines = _format_position_overview_answer(overview)
        top_lines = overview.get("top_lines", [])
        if top_lines:
            suggested_followups.append(f"What if I play {top_lines[0]['san']}?")
            if len(top_lines) > 1:
                suggested_followups.append(f"How about {top_lines[1]['san']} instead?")
        suggested_followups.append("What is opponent's biggest threat?")

    # Optional LLM conversational synthesis grounded strictly on `dossier`
    cfg = settings or LLMSettings.load()
    llm_answer = None
    if is_llm_configured(cfg):
        prompt = (
            f"The 1850 USCF student asks: \"{question}\"\n\n"
            "You are having a spoken, 1-on-1 coaching conversation with your student. "
            "Respond warmly, conversationally, and insightfully. Explain the 'why' behind moves clearly, "
            "and invite the student to explore lines on the board. Use ONLY the verified moves, "
            "evaluations, counterfactuals, and White-Box features in this live probe dossier:\n"
            + json.dumps(dossier, indent=2)
        )
        llm_answer = call_grounded_llm(prompt, cfg, history=history)

    return {
        "answer_markdown": llm_answer or det_markdown,
        "llm_used": bool(llm_answer),
        "query_type": dossier["query_type"],
        "interactive_lines": interactive_lines,
        "suggested_followups": suggested_followups,
    }

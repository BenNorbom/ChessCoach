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
) -> tuple[str, list[dict[str, Any]]]:
    """Build a deterministic 1850-level coaching answer for 'What if [move]?' or 'Why was [move] bad?'."""
    cand_san = probe_decision["played_san"]
    best_san = probe_decision["best_san"]
    cand_eval = probe_decision["played_eval_white_str"]
    best_eval = probe_decision["best_eval_white_str"]
    sev = probe_decision["severity"]
    wp_loss_pct = probe_decision["wp_loss"] * 100.0

    lines_out: list[str] = []
    interactive_lines: list[dict[str, Any]] = []

    if cand_san == best_san or wp_loss_pct < 2.5:
        lines_out.append(
            f"### Verdict on `{cand_san}`: **Strong Choice** (`{cand_eval}`)\n"
            f"`{cand_san}` is {'the top engine choice' if cand_san == best_san else f'virtually equal to `{best_san}` ({best_eval})'} here!"
        )
        best_pv = probe_decision["candidates"][0]["pv_formatted"]
        lines_out.append(f"- **Main Continuation:** `{best_pv}`")
        interactive_lines.append(
            {
                "label": f"Best line: {cand_san}",
                "fen": board_before.fen(),
                "uci_moves": probe_decision["candidates"][0]["pv_uci"],
            }
        )
        # Explain structural upside
        d_best = probe_decision["whitebox"]["delta_root_to_best"]
        if d_best["primary_drivers"]:
            drivers = ", ".join(
                f"**{d['label']}** ({d['delta_cp']:+d} cp)"
                for d in d_best["primary_drivers"][:3]
            )
            lines_out.append(f"- **Positional Drivers:** Improves {drivers}.")
        cfs = probe_decision.get("counterfactual_replies_to_best", [])
        if cfs:
            cf_txt = "; ".join(
                f"against `{c['opponent_try_san']}`, `{c['refutation_san']}!` (`{c['continuation_formatted']}`, `{c['eval_white_str']}`)"
                for c in cfs[:2]
                if c["refutation_san"]
            )
            if cf_txt:
                lines_out.append(f"- **Why Opponent Replies Fail:** {cf_txt}.")
    else:
        verdict_badge = sev.capitalize()
        compare_game = ""
        if game_played_san and game_played_san != cand_san and game_played_eval_str:
            compare_game = f" (compared to `{game_played_san}` `{game_played_eval_str}` in the game)"

        lines_out.append(
            f"### Verdict on `{cand_san}`: **{verdict_badge}** (`{cand_eval}` vs best `{best_san}` `{best_eval}`, `-{wp_loss_pct:.1f}%` win equity){compare_game}"
        )

        # Build dummy tp structure to reuse rich causal helpers
        pseudo_tp = {
            "fen_before": board_before.fen(),
            "color": "white" if board_before.turn == chess.WHITE else "black",
            **probe_decision,
        }
        rc_code = _classify_root_cause(pseudo_tp)
        habit = HABIT_CATALOG[rc_code]

        lines_out.append(f"- **What Goes Wrong:** {_build_backfire_explanation(pseudo_tp)}")
        lines_out.append(f"- **Why `{best_san}` Is Stronger:** {_build_best_plan_explanation(pseudo_tp)}")
        lines_out.append(
            f"- **Transferable OTB Trigger ({habit['title']}):** *When {habit['otb_signal'].lower()}* → **{habit['otb_action']}**"
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
                "label": f"Best plan: {best_san}",
                "fen": board_before.fen(),
                "uci_moves": probe_decision["candidates"][0]["pv_uci"][:6],
            }
        )

    return "\n\n".join(lines_out), interactive_lines


def _format_position_overview_answer(
    overview: dict[str, Any],
) -> tuple[str, list[dict[str, Any]]]:
    """Build a deterministic 1850-level coaching overview for 'What is the plan / threat here?'."""
    turn_cap = overview["turn"].capitalize()
    opp_cap = "Black" if overview["turn"] == "white" else "White"
    top_lines = overview["top_lines"]
    wb = overview["whitebox"]
    opp_threat = overview.get("opponent_threat_if_pass")

    lines_out: list[str] = []
    interactive_lines: list[dict[str, Any]] = []

    if top_lines:
        lead = top_lines[0]
        lines_out.append(
            f"### Position Assessment ({wb['phase_label']} — {turn_cap} to move, `{lead['eval_white_str']}`)"
        )
    else:
        lines_out.append(f"### Position Assessment ({wb['phase_label']})")

    # Key positional imbalances from White-Box facts
    facts = wb.get("facts", [])
    high_impact = sorted(facts, key=lambda f: abs(f["impact_cp"]), reverse=True)[:4]
    if high_impact:
        fact_bullets = "; ".join(f["description"] for f in high_impact)
        lines_out.append(f"- **Key Imbalances on the Board:** {fact_bullets}.")

    if opp_threat and opp_threat.get("threat_san"):
        lines_out.append(
            f"- **{opp_cap}'s Immediate Idea (Null-Move Check):** If {turn_cap} passes, {opp_cap} wants `{opp_threat['threat_san']}` (`{opp_threat['threat_pv']}`, `{opp_threat['eval_white_str']}`)."
        )

    if top_lines:
        plan_strs = []
        for tl in top_lines[:3]:
            plan_strs.append(f"`{tl['san']}` (`{tl['eval_white_str']}`: `{tl['pv_formatted']}`)")
            interactive_lines.append(
                {
                    "label": f"#{tl['rank']} Plan: {tl['san']} ({tl['eval_white_str']})",
                    "fen": overview["fen"],
                    "uci_moves": tl["pv_uci"],
                }
            )
        lines_out.append("- **Top Candidate Plans:** " + " | ".join(plan_strs))

    return "\n\n".join(lines_out), interactive_lines


def answer_coaching_question(
    interrogator: HybridInterrogator,
    question: str,
    fen_current: str,
    fen_before: str | None = None,
    ply_meta: dict[str, Any] | None = None,
    perspective_str: str = "white",
    settings: LLMSettings | None = None,
) -> dict[str, Any]:
    """Answer a free-form coaching question on the selected move/position."""
    perspective = (
        chess.WHITE if perspective_str.lower().startswith("w") else chess.BLACK
    )
    q_lower = question.lower()
    board_curr = chess.Board(fen_current)
    board_prev = chess.Board(fen_before) if fen_before else None

    played_uci = ply_meta.get("uci") if ply_meta else None
    played_san = ply_meta.get("san") if ply_meta else None
    played_eval_str = ply_meta.get("eval_white_str") if ply_meta else None

    # 1. Check if the user asked about an alternative move on `board_prev` ("What if I played f4 instead?")
    cand_prev = (
        _extract_candidate_move(question, board_prev, exclude_uci=played_uci)
        if board_prev is not None
        else None
    )
    cand_curr = _extract_candidate_move(question, board_curr)

    asking_alternative = any(
        kw in q_lower
        for kw in ("instead", "what if i", "why not", "could i", "should i have", "how about")
    )

    dossier: dict[str, Any]
    det_markdown: str
    interactive_lines: list[dict[str, Any]]

    if cand_prev is not None and (asking_alternative or cand_curr is None or cand_prev.uci() != played_uci):
        decision = interrogator.interrogate_decision(
            board_prev, cand_prev, board_prev.turn, deep_depth=15
        )
        dossier = {
            "query_type": "alternative_move_probe",
            "question": question,
            "fen_probed": board_prev.fen(),
            "candidate_move": board_prev.san(cand_prev),
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
        )

    elif cand_curr is not None:
        decision = interrogator.interrogate_decision(
            board_curr, cand_curr, board_curr.turn, deep_depth=15
        )
        dossier = {
            "query_type": "continuation_move_probe",
            "question": question,
            "fen_probed": board_curr.fen(),
            "candidate_move": board_curr.san(cand_curr),
            "probe": decision,
        }
        det_markdown, interactive_lines = _format_move_comparison_answer(
            question, board_curr, cand_curr, decision
        )

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
            question, board_prev, mv_played, decision
        )

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

    # Optional LLM conversational synthesis grounded strictly on `dossier`
    cfg = settings or LLMSettings.load()
    llm_answer = None
    if is_llm_configured(cfg):
        prompt = (
            f"The 1850 USCF student asks: \"{question}\"\n\n"
            "Answer directly, concisely, and insightfully using ONLY the verified moves, "
            "evaluations, counterfactuals, and White-Box features in this live probe dossier:\n"
            + json.dumps(dossier, indent=2)
        )
        llm_answer = call_grounded_llm(prompt, cfg)

    return {
        "answer_markdown": llm_answer or det_markdown,
        "llm_used": bool(llm_answer),
        "query_type": dossier["query_type"],
        "interactive_lines": interactive_lines,
    }

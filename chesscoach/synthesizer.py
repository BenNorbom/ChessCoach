"""1850+ USCF Coaching Synthesizer & Cross-Game Habit Tracker.

Translates verified Search-Tree Interrogation + White-Box Positional Deltas
into International-Master-style causal explanations, counterfactual answers,
and transferable Over-The-Board (OTB) decision triggers.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from typing import Any

import chess

from chesscoach.config import PROFILE_PATH, LLMSettings
from chesscoach.llm_client import call_grounded_llm, is_llm_configured

HABIT_CATALOG: dict[str, dict[str, str]] = {
    "PASSIVE_PROPHYLAXIS_MISSED_LEVER": {
        "title": "Passive Prophylaxis Over Active Pawn Levers",
        "summary": "Playing automatic 'safety' or tidying moves while the opponent's king is uncastled or an opponent piece maneuver is brewing, missing immediate pawn breaks.",
        "otb_signal": "Opponent pushes wing pawns aggressively (e.g., ...g5) with an uncastled king, or prepares to trade off your strongest central piece.",
        "otb_action": "Before touching your king or making a quiet retreat, calculate every immediate pawn lever (h4, f4, c4) and forcing piece challenge first.",
    },
    "KING_SHIELD_SELF_WEAKENING": {
        "title": "Touching Pawns / Stepping Into Active Enemy King Files",
        "summary": "Pushing king-shield pawns or stepping the king onto exposed lines while enemy rooks/queens are aligned, expecting a retreat instead of a counter-pin or sacrifice.",
        "otb_signal": "Enemy heavy pieces already eye your king's file/diagonal and you want to kick an enemy piece with a king-shield pawn (like g3).",
        "otb_action": "Ask: 'What if they do NOT move the attacked piece and instead double rooks, pin my pawn, or sacrifice on the square I just weakened?'",
    },
    "RECAPTURE_AVOIDANCE_CONCESSION": {
        "title": "Avoiding Forced Recaptures & Conceding Dangerous Passers",
        "summary": "Sidestepping a direct recapture out of discomfort with piece trades or open files, leaving an enemy pawn alive deep in your territory.",
        "otb_signal": "Opponent captures near your king (e.g., ...hxg3+) and only one recapture eliminates the intruder.",
        "otb_action": "Never reject the natural recapture on intuition—calculate the forced exchange sequence all the way to the quiet board and compare against leaving the enemy passer alive.",
    },
    "ENDGAME_TEMPO_VS_CONSOLIDATION": {
        "title": "Slow Endgame King Moves Over Active Passed-Pawn Tempo",
        "summary": "Making tidy defensive king steps in major-piece endgames instead of using an advanced passed pawn to tie down the enemy rook, allowing 1st/2nd-rank rook infiltration.",
        "otb_signal": "Rook/minor-piece endgame where you own a 5th/6th-rank passed pawn and the opponent's rook eyes your back rank.",
        "otb_action": "Always calculate pushing your passed pawn FIRST—an advancing passer on the 6th/7th rank paralyzes an enemy rook far better than passive king defense.",
    },
    "MISSED_OPPONENT_PAWN_BREAK": {
        "title": "Allowing Liberating Opponent Pawn Breaks",
        "summary": "Moving a piece off central/file restraint in a locked middlegame, allowing the opponent a liberating pawn break (like ...f6 or ...c5) that opens lines against you.",
        "otb_signal": "Locked pawn chains where your space edge depends on keeping the opponent's chain spearhead restrained.",
        "otb_action": "Before relocating your queen or rooks, run a 2-move check on the opponent's key pawn breaks (...f6, ...c5, ...b5).",
    },
    "PIECE_QUALITY_NEGLECT": {
        "title": "Leaving Restricted Minor Pieces Unimproved",
        "summary": "Entering tactical skirmishes while a minor piece (such as a hemmed-in bishop) remains passive instead of rerouting it to an active diagonal/outpost.",
        "otb_signal": "One of your minor pieces is hemmed in by your own central pawn chain.",
        "otb_action": "Look for a 2-step reroute (e.g., Ba3-d6) to trade off or activate your worst piece before initiating wing contact.",
    },
    "SHARP_TACTICAL_HORIZON": {
        "title": "Deep Tactical Calculation Horizon",
        "summary": "A complex multi-move tactical sequence where the refutation lay several moves deep along a narrow forcing path.",
        "otb_signal": "Both kings are exposed with heavy pieces on open files and candidate moves diverge sharply.",
        "otb_action": "Switch from general positional rules to strict candidate-move elimination: list checks, captures, and rook lifts at every ply.",
    },
}


def _classify_root_cause(tp: dict[str, Any]) -> str:
    """Map structured tree-interrogation & White-Box signals to a root-cause habit."""
    board = chess.Board(tp["fen_before"])
    played_move = chess.Move.from_uci(tp["played_uci"])
    best_move = chess.Move.from_uci(tp["best_uci"])
    phase = tp["whitebox"]["root"]["phase"]
    nt = tp["null_threat"]
    dc = tp["depth_curve"]
    piece_moved = board.piece_at(played_move.from_square)
    piece_best = board.piece_at(best_move.from_square)

    # 1. Endgame passed-pawn tempo vs slow king/rook move
    if phase < 0.42:
        if (
            piece_best is not None
            and piece_best.piece_type == chess.PAWN
            and piece_moved is not None
            and piece_moved.piece_type == chess.KING
        ):
            return "ENDGAME_TEMPO_VS_CONSOLIDATION"
        if piece_moved is not None and piece_moved.piece_type == chess.KING and tp["cp_loss"] >= 120:
            return "ENDGAME_TEMPO_VS_CONSOLIDATION"

    # 2. Avoiding a direct recapture (especially in check or after pawn capture)
    if board.is_capture(best_move) and not board.is_capture(played_move):
        if nt["in_check"] or tp["singularity"] == "ONLY_MOVE_TACTICAL":
            return "RECAPTURE_AVOIDANCE_CONCESSION"

    # 3. Passive prophylaxis / slow king move missing active lever or ignoring threat
    root_facts = tp["whitebox"]["root"]["facts"]
    has_lever = any(
        f["kind"] == "pawn_lever" and f["color"].lower() == tp["color"]
        for f in root_facts
    )
    if (
        piece_moved is not None
        and piece_moved.piece_type == chess.KING
        and phase >= 0.50
        and not nt["in_check"]
    ):
        if nt["threat_diagnosis"] == "IGNORED_EXISTING_THREAT" or (
            has_lever and piece_best and piece_best.piece_type == chess.PAWN
        ):
            return "PASSIVE_PROPHYLAXIS_MISSED_LEVER"

    # 4. Self-weakening king shield / stepping into king-file pin/counterattack
    ksq = board.king(board.turn)
    if (
        ksq is not None
        and phase >= 0.35
        and piece_moved is not None
        and piece_moved.piece_type in (chess.PAWN, chess.KING)
    ):
        near_king = chess.square_distance(played_move.to_square, ksq) <= 2 or (
            piece_moved.piece_type == chess.KING
        )
        opp_king_pressure = any(
            f["kind"] in ("king_file_attack", "king_zone_convergence", "rook_semi_open_file")
            for f in root_facts
        )
        if (
            near_king
            and opp_king_pressure
            and nt["threat_diagnosis"] == "CREATED_NEW_TARGET"
        ):
            return "KING_SHIELD_SELF_WEAKENING"

    # 4b. Pawn-grab / tactical capture walking into counter-tactic (e.g., 35. Qxd5? Bc6!)
    if (
        board.is_capture(played_move)
        and not board.is_capture(best_move)
        and nt["threat_diagnosis"] == "CREATED_NEW_TARGET"
    ):
        return "SHARP_TACTICAL_HORIZON"

    # 5. Allowing liberating opponent pawn break
    opp_reply_san = tp.get("opponent_best_reply_san") or ""
    if (
        nt["threat_diagnosis"] == "CREATED_NEW_TARGET"
        and opp_reply_san[:1].islower()
        and phase >= 0.40
    ):
        return "MISSED_OPPONENT_PAWN_BREAK"

    # 6. Neglecting piece activation
    wb_drivers = {
        d["dimension"]: d["delta_cp"]
        for d in tp["whitebox"]["delta_played_vs_best"]["primary_drivers"]
    }
    if wb_drivers.get("piece_activity", 0) >= 35:
        return "PIECE_QUALITY_NEGLECT"

    if dc["crossover_depth"] >= 9:
        return "SHARP_TACTICAL_HORIZON"

    return "MISSED_OPPONENT_PAWN_BREAK"


def _build_intent_explanation(tp: dict[str, Any]) -> str:
    """Infer why a strong club player played `played_san` and note horizon depth."""
    board = chess.Board(tp["fen_before"])
    mv = chess.Move.from_uci(tp["played_uci"])
    piece = board.piece_at(mv.from_square)
    dc = tp["depth_curve"]
    nt = tp["null_threat"]

    intent_core = f"You played `{tp['played_san']}`"
    if nt["in_check"]:
        intent_core += " to step out of check while keeping pieces on the board rather than entering immediate simplifications"
    elif piece and piece.piece_type == chess.KING and tp["whitebox"]["root"]["phase"] >= 0.5:
        intent_core += " as a prophylactic king-tucking move, clearing the g1/f-pawn line before committing to active operations"
    elif piece and piece.piece_type == chess.KING and tp["whitebox"]["root"]["phase"] < 0.45:
        intent_core += " to bring your king closer to the queenside/back-rank action and tidy up your coordination"
    elif piece and piece.piece_type == chess.PAWN:
        # Check if pawn move attacks an enemy piece
        sim = board.copy(stack=False)
        sim.push(mv)
        attacked_pieces = [
            f"{sim.piece_at(sq).symbol().upper()} on {chess.square_name(sq)}"
            for sq in sim.attacks(mv.to_square)
            if sim.piece_at(sq) and sim.color_at(sq) != board.turn and sim.piece_type_at(sq) != chess.PAWN
        ]
        if attacked_pieces:
            intent_core += f" to challenge Black's {', '.join(attacked_pieces)} and contest the kingside"
        else:
            intent_core += " to claim space and alter the pawn structure"
    elif board.is_capture(mv):
        intent_core += " to grab material and force the issue concretely"
    else:
        intent_core += " to reposition and maintain tension without forcing premature trades"

    if dc["tempting_at_shallow"]:
        horizon_note = (
            f" At shallow calculation (`depth 1–2`), `{tp['played_san']}` actually looks completely playable—the drawback only emerges around **ply depth {dc['crossover_depth']}**."
        )
    elif dc["crossover_depth"] <= 3:
        horizon_note = (
            f" The tactical/positional refutation shows up quickly (**depth {dc['crossover_depth']}**, i.e., within 1–2 full moves)—making this a high-return calculation habit to tighten."
        )
    elif dc["crossover_depth"] <= 7:
        horizon_note = (
            f" Separating `{tp['best_san']}` from `{tp['played_san']}` requires calculating to **ply depth {dc['crossover_depth']}** (~3 moves deep)."
        )
    else:
        horizon_note = (
            f" Fair context: the decisive swing only stabilizes at **ply depth {dc['crossover_depth']}**, so treat this as a subtle warning-signal lesson rather than an elementary blunder."
        )

    return intent_core + "." + horizon_note


def _build_backfire_explanation(tp: dict[str, Any]) -> str:
    """Explain concretely why `played_san` got punished using Threat + White-Box deltas."""
    nt = tp["null_threat"]
    opp_san = tp.get("opponent_best_reply_san") or ""
    ref_line = tp.get("refutation_pv_formatted") or ""

    parts: list[str] = []
    if nt["threat_diagnosis"] == "IGNORED_EXISTING_THREAT" and nt["pre_existing_threat_san"]:
        parts.append(
            f"**Ignored Pre-Existing Plan:** Even before your move, Black was already threatening `{nt['pre_existing_threat_san']}`. Playing `{tp['played_san']}` left that plan completely unchallenged, allowing `{ref_line}`."
        )
    elif nt["threat_diagnosis"] == "CREATED_NEW_TARGET" and opp_san:
        only_tag = (
            " (an **only-move** punishment by Black)"
            if tp.get("opponent_only_punishment")
            else ""
        )
        parts.append(
            f"**Created a New Target:** `{tp['played_san']}` directly enabled `{opp_san}`{only_tag}, leading to `{ref_line}`."
        )
    elif nt["threat_diagnosis"] == "FORCED_CHECK_RESPONSE" and opp_san:
        parts.append(
            f"**Conceded Initiative Out of Check:** Stepping away with `{tp['played_san']}` gave Black `{opp_san}` (`{ref_line}`)."
        )
    else:
        parts.append(
            f"After `{tp['played_san']}`, Black seizes the initiative with `{ref_line}`."
        )

    # Add concrete White-Box positional shifts from root to played settled board
    d_played = tp["whitebox"]["delta_root_to_played"]
    d_vs = tp["whitebox"]["delta_played_vs_best"]

    key_losses = [
        f["description"]
        for f in d_played["removed_facts"]
        if f["color"].lower() == tp["color"] and f["impact_cp"] > 0
    ]
    opp_gains = [
        f["description"]
        for f in d_played["new_facts"]
        if (f["color"].lower() != tp["color"] and f["impact_cp"] > 0)
        or (f["color"].lower() == tp["color"] and f["impact_cp"] < 0)
    ]

    structural_bullets: list[str] = []
    if key_losses:
        structural_bullets.append(f"you surrendered: *{'; '.join(key_losses[:2])}*")
    if opp_gains:
        structural_bullets.append(f"Black gained: *{'; '.join(opp_gains[:2])}*")

    if structural_bullets:
        parts.append("Structurally at the end of the forcing line, " + ", while ".join(structural_bullets) + ".")
    elif d_vs["primary_drivers"]:
        top_d = d_vs["primary_drivers"][0]
        parts.append(
            f"Once immediate tactics settle, `{tp['played_san']}` leaves you significantly worse in **{top_d['label']}** compared to `{tp['best_san']}`."
        )

    return " ".join(parts)


def _build_best_plan_explanation(tp: dict[str, Any]) -> str:
    """Explain why `best_san` works AND refute natural 'what if they play X?' objections."""
    best_cand = tp["candidates"][0]
    sing = tp["singularity"]
    parts: list[str] = []

    if sing == "ONLY_MOVE_TACTICAL":
        parts.append(
            f"**Narrow Tactical Tightrope:** `{tp['best_san']}` (`{best_cand['eval_white_str']}`) was the **only move** that held the balance (the #2 choice already drops {tp['wp_gap_top2'] * 100:.0f}% win equity)."
        )
    elif sing == "STRATEGIC_LANDMINE":
        alt_names = [c["san"] for c in tp["candidates"][1:3]]
        parts.append(
            f"**Flexible Position, Specific Landmine:** Several constructive moves worked here (`{tp['best_san']}`, or `{', '.join(alt_names)}`), so you didn't need a miracle move—just avoiding `{tp['played_san']}`'s concession."
        )
    else:
        parts.append(
            f"**Strongest Continuation:** `{tp['best_san']}` (`{best_cand['eval_white_str']}`) sets the agenda via `{best_cand['pv_formatted']}`."
        )

    # White-Box positive assets of best line
    d_best = tp["whitebox"]["delta_root_to_best"]
    player_gains = [
        f["description"]
        for f in d_best["new_facts"]
        if (f["color"].lower() == tp["color"] and f["impact_cp"] > 0)
        or (f["color"].lower() != tp["color"] and f["impact_cp"] < 0)
    ]
    if player_gains:
        parts.append(f"Positionally, this line achieves: *{'; '.join(player_gains[:2])}*.")

    # Counterfactual "Wait, what if Black plays X?" refutations!
    cfs = tp.get("counterfactual_replies_to_best", [])
    if cfs:
        cf_sentences = []
        for cf in cfs[:2]:
            if cf["refutation_san"]:
                cf_sentences.append(
                    f"if Black tries `{cf['opponent_try_san']}`, you answer `{cf['refutation_san']}!` (`{cf['continuation_formatted']}`, `{cf['eval_white_str']}`)"
                )
        if cf_sentences:
            parts.append(
                "**Answering the OTB Doubt:** Why couldn't Black punish this? Because "
                + "; and ".join(cf_sentences)
                + "."
            )

    return " ".join(parts)


def synthesize_coaching_report(
    raw_analysis: dict[str, Any],
    settings: LLMSettings | None = None,
    persist_profile: bool = True,
) -> dict[str, Any]:
    """Enrich `HybridInterrogator.analyze_pgn` output with full 1850+ coaching insights."""
    player_color = raw_analysis["player_color"]
    plies = raw_analysis["plies"]
    turning_points = raw_analysis["turning_points"]

    # Compute phase-level accuracy & win-prob loss stats for player
    player_plies = [p for p in plies if p["color"] == player_color]
    phase_losses: dict[str, list[float]] = {
        "Opening": [],
        "Middlegame": [],
        "Endgame": [],
    }
    severity_counts: Counter[str] = Counter()
    for p in player_plies:
        ph_label = p["whitebox_after"]["phase_label"]
        phase_losses[ph_label].append(p["wp_loss"])
        severity_counts[p["severity"]] += 1

    avg_wp_loss = (
        sum(p["wp_loss"] for p in player_plies) / max(1, len(player_plies))
    )
    # Calibrated accuracy score [0..100]
    accuracy_pct = round(max(0.0, min(100.0, 103.1668 * (2.71828 ** (-4.0 * avg_wp_loss)) - 3.1669)), 1)

    phase_summary = {}
    for ph_name, losses in phase_losses.items():
        if losses:
            ph_avg = sum(losses) / len(losses)
            ph_acc = round(max(0.0, min(100.0, 103.1668 * (2.71828 ** (-4.0 * ph_avg)) - 3.1669)), 1)
            phase_summary[ph_name] = {
                "moves": len(losses),
                "accuracy": ph_acc,
                "total_wp_loss_pct": round(sum(losses) * 100, 1),
            }
        else:
            phase_summary[ph_name] = {"moves": 0, "accuracy": 100.0, "total_wp_loss_pct": 0.0}

    # Synthesize each turning point
    habit_counts: Counter[str] = Counter()
    coached_turning_points: list[dict[str, Any]] = []

    for tp in turning_points:
        rc_code = _classify_root_cause(tp)
        habit_counts[rc_code] += 1
        habit_meta = HABIT_CATALOG[rc_code]

        move_prefix = (
            f"{tp['move_number']}. "
            if tp["color"] == "white"
            else f"{tp['move_number']}..."
        )
        headline = (
            f"Move {tp['move_number']} (`{move_prefix}{tp['played_san']}` → `{move_prefix}{tp['best_san']}`): "
            f"{habit_meta['title']}"
        )

        coached_tp = {
            **tp,
            "root_cause_code": rc_code,
            "root_cause_title": habit_meta["title"],
            "coaching": {
                "headline": headline,
                "your_likely_intent": _build_intent_explanation(tp),
                "why_it_backfired": _build_backfire_explanation(tp),
                "why_best_works": _build_best_plan_explanation(tp),
                "otb_trigger": {
                    "signal": habit_meta["otb_signal"],
                    "action": habit_meta["otb_action"],
                },
            },
        }
        coached_turning_points.append(coached_tp)

    # Aggregate top recurring themes & OTB triggers across the whole game
    top_habits = []
    for code, count in habit_counts.most_common(4):
        meta = HABIT_CATALOG[code]
        matching_moves = [
            f"{tp['move_number']}. {tp['played_san']}"
            for tp in coached_turning_points
            if tp["root_cause_code"] == code
        ]
        top_habits.append(
            {
                "code": code,
                "title": meta["title"],
                "occurrences_in_game": count,
                "moves": matching_moves,
                "summary": meta["summary"],
                "otb_signal": meta["otb_signal"],
                "otb_action": meta["otb_action"],
            }
        )

    # Build deterministic executive narrative
    weakest_phase = min(
        [k for k, v in phase_summary.items() if v["moves"] >= 4] or ["Middlegame"],
        key=lambda k: phase_summary[k]["accuracy"],
    )
    strongest_phase = max(
        [k for k, v in phase_summary.items() if v["moves"] >= 4] or ["Opening"],
        key=lambda k: phase_summary[k]["accuracy"],
    )

    exec_paragraphs = [
        f"Playing **{player_color.capitalize()}** across **{len(player_plies)} moves** (overall move accuracy **{accuracy_pct}%**), your cleanest phase was the **{strongest_phase}** ({phase_summary[strongest_phase]['accuracy']}% accuracy) while the biggest equity swings occurred in the **{weakest_phase}** ({phase_summary[weakest_phase]['accuracy']}% accuracy).",
    ]
    if top_habits:
        lead = top_habits[0]
        exec_paragraphs.append(
            f"Instead of treating this game as {len(player_plies)} isolated computer numbers, almost all lost win-equity clusters into **{len(top_habits)} repeatable decision habits**—headlined by **{lead['title']}** ({', '.join(lead['moves'])}). Fixing how you respond when *{lead['otb_signal'].lower()}* immediately converts directly into rating points."
        )

    executive_narrative = "\n\n".join(exec_paragraphs)
    llm_used = False

    # Optional grounded LLM narrative polish if user configured an API key
    cfg = settings or LLMSettings.load()
    if is_llm_configured(cfg) and coached_turning_points:
        compact_dossier = {
            "player_color": player_color,
            "accuracy_pct": accuracy_pct,
            "phase_summary": phase_summary,
            "top_habits": top_habits,
            "turning_points": [
                {
                    "move": f"{tp['move_number']}. {tp['played_san']}",
                    "best": tp["best_san"],
                    "eval_swing": f"{tp['best_eval_white_str']} to {tp['played_eval_white_str']}",
                    "root_cause": tp["root_cause_title"],
                    "threat_diagnosis": tp["null_threat"]["threat_diagnosis"],
                    "refutation": tp["refutation_pv_formatted"],
                    "best_pv": tp["candidates"][0]["pv_formatted"],
                    "counterfactuals": tp["counterfactual_replies_to_best"],
                }
                for tp in coached_turning_points
            ],
        }
        prompt = (
            "Write a concise 2-paragraph Executive Coaching Assessment for this 1850 USCF player's game "
            "based strictly on this verified Engine + White-Box Dossier:\n"
            + json.dumps(compact_dossier, indent=2)
        )
        llm_text = call_grounded_llm(prompt, cfg)
        if llm_text:
            executive_narrative = llm_text
            llm_used = True

    profile_snapshot = (
        _update_player_profile(top_habits, accuracy_pct)
        if persist_profile
        else _load_player_profile()
    )

    return {
        **raw_analysis,
        "turning_points": coached_turning_points,
        "summary": {
            "accuracy_pct": accuracy_pct,
            "severity_counts": dict(severity_counts),
            "phase_summary": phase_summary,
            "executive_narrative": executive_narrative,
            "llm_enhanced": llm_used,
            "top_habits": top_habits,
        },
        "player_profile": profile_snapshot,
    }


def _load_player_profile() -> dict[str, Any]:
    if PROFILE_PATH.is_file():
        try:
            return json.loads(PROFILE_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"games_analyzed": 0, "average_accuracy": 0.0, "habit_totals": {}}


def _update_player_profile(
    top_habits: list[dict[str, Any]], accuracy_pct: float
) -> dict[str, Any]:
    prof = _load_player_profile()
    prev_games = prof.get("games_analyzed", 0)
    prev_avg = prof.get("average_accuracy", 0.0)
    new_games = prev_games + 1
    new_avg = round((prev_avg * prev_games + accuracy_pct) / new_games, 1)

    totals: dict[str, dict[str, Any]] = prof.get("habit_totals", {})
    for h in top_habits:
        code = h["code"]
        entry = totals.get(
            code,
            {
                "title": h["title"],
                "count": 0,
                "otb_signal": h["otb_signal"],
                "otb_action": h["otb_action"],
            },
        )
        entry["count"] += h["occurrences_in_game"]
        totals[code] = entry

    updated = {
        "games_analyzed": new_games,
        "average_accuracy": new_avg,
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "habit_totals": totals,
    }
    PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    PROFILE_PATH.write_text(json.dumps(updated, indent=2), encoding="utf-8")
    return updated

"""Hybrid Search-Tree & Counterfactual Interrogator.

Combines Stockfish 19 UCI search with four diagnostic tree probes and
quiet-settlement White-Box evaluation deltas to uncover *why* a move
succeeds or fails.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Any

import chess
import chess.engine
import chess.pgn

from chesscoach.config import find_stockfish_path
from chesscoach.whitebox_eval import (
    WhiteBoxEval,
    diff_whitebox,
    evaluate_whitebox,
)


def score_to_cp(pov_score: chess.engine.Score) -> int:
    """Convert a python-chess POV Score into clamped centipawns."""
    mate = pov_score.mate()
    if mate is not None:
        if mate > 0:
            return max(1500, 3000 - mate * 25)
        elif mate < 0:
            return min(-1500, -3000 - mate * 25)
        else:
            return 3000
    cp = pov_score.score()
    return int(cp) if cp is not None else 0


def cp_to_win_prob(cp: int) -> float:
    """Convert centipawns to expected win probability [0.0, 1.0] (Lichess/SF logistic)."""
    clamped = max(-2000, min(2000, cp))
    return 1.0 / (1.0 + math.exp(-0.00368208 * clamped))


def format_score(pov_score_white: chess.engine.Score) -> str:
    """Format score string from White's perspective (+1.25, -0.40, #3, -#2)."""
    mate = pov_score_white.mate()
    if mate is not None:
        return f"#{mate}" if mate > 0 else f"-#{abs(mate)}"
    cp = pov_score_white.score() or 0
    return f"{cp / 100.0:+.2f}"


def pv_to_san_list(board: chess.Board, pv: list[chess.Move], max_len: int = 8) -> list[str]:
    """Convert a list of UCI Moves from `board` into SAN strings."""
    sim = board.copy(stack=False)
    sans: list[str] = []
    for m in pv[:max_len]:
        if m not in sim.legal_moves:
            break
        sans.append(sim.san(m))
        sim.push(m)
    return sans


def format_pv_numbered(board: chess.Board, pv: list[chess.Move], max_len: int = 8) -> str:
    """Format a PV with standard move numbers (e.g., '13. f4 gxf4 14. Qxf4')."""
    sim = board.copy(stack=False)
    parts: list[str] = []
    for i, m in enumerate(pv[:max_len]):
        if m not in sim.legal_moves:
            break
        san = sim.san(m)
        if sim.turn == chess.WHITE:
            parts.append(f"{sim.fullmove_number}. {san}")
        else:
            if i == 0:
                parts.append(f"{sim.fullmove_number}...{san}")
            else:
                parts.append(san)
        sim.push(m)
    return " ".join(parts)


def walk_to_quiet_settlement(
    board: chess.Board, pv: list[chess.Move], min_plies: int = 2, max_plies: int = 8
) -> tuple[chess.Board, list[str]]:
    """Walk along a PV until immediate captures/checks settle so White-Box eval isn't mid-trade."""
    sim = board.copy(stack=False)
    walked_san: list[str] = []
    limit = min(len(pv), max_plies)

    idx = 0
    while idx < limit:
        move = pv[idx]
        if move not in sim.legal_moves:
            break
        is_tactical_continuation = (
            sim.is_check()
            or sim.is_capture(move)
            or move.promotion is not None
        )
        if idx >= min_plies and not is_tactical_continuation:
            break
        walked_san.append(sim.san(move))
        sim.push(move)
        idx += 1

    return sim, walked_san


def classify_move_severity(wp_loss: float, is_best: bool) -> str:
    """Classify a move based on expected win-probability drop."""
    if is_best:
        return "best"
    if wp_loss >= 0.18:
        return "blunder"
    if wp_loss >= 0.10:
        return "mistake"
    if wp_loss >= 0.055:
        return "inaccuracy"
    return "good"


class HybridInterrogator:
    """Manages Stockfish UCI and runs multi-depth, null-move, and counterfactual probes."""

    def __init__(
        self,
        stockfish_path: str | None = None,
        threads: int = 4,
        hash_mb: int = 256,
    ) -> None:
        self.stockfish_path = stockfish_path or find_stockfish_path()
        self.threads = threads
        self.hash_mb = hash_mb
        self._engine: chess.engine.SimpleEngine | None = None

    def start(self) -> None:
        if self._engine is None:
            self._engine = chess.engine.SimpleEngine.popen_uci(self.stockfish_path)
            self._engine.configure({"Threads": self.threads, "Hash": self.hash_mb})

    def close(self) -> None:
        if self._engine is not None:
            try:
                self._engine.quit()
            except Exception:
                pass
            self._engine = None

    def __enter__(self) -> "HybridInterrogator":
        self.start()
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    @property
    def engine(self) -> chess.engine.SimpleEngine:
        if self._engine is None:
            self.start()
        assert self._engine is not None
        return self._engine

    def interrogate_decision(
        self,
        board_before: chess.Board,
        played_move: chess.Move,
        perspective: chess.Color,
        deep_depth: int = 17,
    ) -> dict[str, Any]:
        """Run all 4 diagnostic probes + quiet-settlement White-Box comparison on a critical move."""
        eng = self.engine
        played_san = board_before.san(played_move)

        # 1. Multi-PV Root Search (Singularity & Top Candidate Plans)
        mpv_infos = eng.analyse(
            board_before, chess.engine.Limit(depth=deep_depth), multipv=3
        )
        if not isinstance(mpv_infos, list):
            mpv_infos = [mpv_infos]

        candidates: list[dict[str, Any]] = []
        for rank_idx, info in enumerate(mpv_infos):
            pv = info.get("pv", [])
            if not pv:
                continue
            cand_move = pv[0]
            pov = info["score"].pov(perspective)
            cp = score_to_cp(pov)
            wp = cp_to_win_prob(cp)
            candidates.append(
                {
                    "rank": rank_idx + 1,
                    "uci": cand_move.uci(),
                    "san": board_before.san(cand_move),
                    "eval_cp": cp,
                    "eval_white_str": format_score(info["score"].white()),
                    "win_prob": round(wp, 4),
                    "pv_uci": [m.uci() for m in pv[:8]],
                    "pv_san": pv_to_san_list(board_before, pv, 8),
                    "pv_formatted": format_pv_numbered(board_before, pv, 8),
                }
            )

        best_cand = candidates[0]
        best_move = chess.Move.from_uci(best_cand["uci"])
        best_pv = [chess.Move.from_uci(u) for u in best_cand["pv_uci"]]

        if len(candidates) >= 2:
            wp_gap_1_2 = candidates[0]["win_prob"] - candidates[1]["win_prob"]
        else:
            wp_gap_1_2 = 0.50

        # 2. Played-Move Refutation Search (What actually punishes `played_move`?)
        board_after_played = board_before.copy(stack=False)
        board_after_played.push(played_move)

        if board_after_played.is_game_over():
            played_cp = 3000 if board_after_played.is_checkmate() else 0
            played_wp = cp_to_win_prob(played_cp)
            played_white_str = (
                ("#1" if perspective == chess.WHITE else "-#1")
                if board_after_played.is_checkmate()
                else "+0.00"
            )
            refutation_pv: list[chess.Move] = []
            opponent_only_punishment = False
            opp_second_reply_san = None
        else:
            ref_infos = eng.analyse(
                board_after_played, chess.engine.Limit(depth=deep_depth), multipv=2
            )
            if not isinstance(ref_infos, list):
                ref_infos = [ref_infos]
            top_ref = ref_infos[0]
            played_pov = top_ref["score"].pov(perspective)
            played_cp = score_to_cp(played_pov)
            played_wp = cp_to_win_prob(played_cp)
            played_white_str = format_score(top_ref["score"].white())
            refutation_pv = top_ref.get("pv", [])

            if len(ref_infos) >= 2 and ref_infos[1].get("pv"):
                opp_wp_1 = cp_to_win_prob(score_to_cp(ref_infos[0]["score"].pov(not perspective)))
                opp_wp_2 = cp_to_win_prob(score_to_cp(ref_infos[1]["score"].pov(not perspective)))
                opponent_only_punishment = (opp_wp_1 - opp_wp_2) >= 0.11
                opp_second_reply_san = board_after_played.san(ref_infos[1]["pv"][0])
            else:
                opponent_only_punishment = True
                opp_second_reply_san = None

        wp_loss = max(0.0, best_cand["win_prob"] - played_wp) if played_move != best_move else 0.0
        cp_loss = max(0, best_cand["eval_cp"] - played_cp) if played_move != best_move else 0

        if wp_gap_1_2 >= 0.11:
            singularity = "ONLY_MOVE_TACTICAL"
        elif wp_gap_1_2 <= 0.045 and wp_loss >= 0.08:
            singularity = "STRATEGIC_LANDMINE"
        else:
            singularity = "CLEAR_BEST_PLAN"

        # 3. Streaming Depth-Horizon Curve (d = 1..15 on [played_move, best_move])
        # Clear TT hash first so depth 1..6 reflects genuine shallow search, not cached d=17 entries!
        depth_curve: dict[str, dict[int, int]] = {"played": {}, "best": {}}
        max_curve_depth = min(15, deep_depth)
        if played_move != best_move:
            eng.configure({"Clear Hash": None})
            with eng.analysis(
                board_before,
                chess.engine.Limit(depth=max_curve_depth),
                multipv=2,
                root_moves=[played_move, best_move],
            ) as stream:
                for info in stream:
                    d = info.get("depth")
                    pv = info.get("pv")
                    sc = info.get("score")
                    if d is None or not pv or sc is None:
                        continue
                    if d > max_curve_depth:
                        break
                    rm = pv[0]
                    rm_cp = score_to_cp(sc.pov(perspective))
                    if rm == played_move:
                        depth_curve["played"][d] = rm_cp
                    elif rm == best_move:
                        depth_curve["best"][d] = rm_cp

        # Analyze depth horizon behavior
        shallow_played = depth_curve["played"].get(2, depth_curve["played"].get(1, played_cp))
        shallow_best = depth_curve["best"].get(2, depth_curve["best"].get(1, best_cand["eval_cp"]))
        tempting_at_shallow = (
            played_move != best_move and (shallow_played >= shallow_best - 15)
        )
        best_looks_scary_shallow = (best_cand["eval_cp"] - shallow_best) >= 75

        crossover_depth = 1
        if played_move != best_move:
            crossover_depth = max_curve_depth
            for d in sorted(set(depth_curve["played"].keys()) & set(depth_curve["best"].keys())):
                if (depth_curve["best"][d] - depth_curve["played"][d]) >= 50:
                    crossover_depth = d
                    break

        if crossover_depth <= 2:
            horizon_category = "IMMEDIATE_OVERSIGHT"
        elif crossover_depth <= 6:
            horizon_category = "SHORT_CALCULATION_GAP"
        elif crossover_depth <= 11:
            horizon_category = "MEDIUM_HORIZON_PLAN"
        else:
            horizon_category = "DEEP_ENGINE_RESOURCE"

        # 4. Null-Move Pre-Existing Threat Probe
        null_threat_info: dict[str, Any] = {
            "in_check": board_before.is_check(),
            "pre_existing_threat_san": None,
            "pre_existing_threat_pv": "",
            "threat_gain_cp": 0,
            "threat_diagnosis": "POSITIONAL_CONCESSION",
        }
        opp_reply_move = refutation_pv[0] if refutation_pv else None
        opp_reply_san = board_after_played.san(opp_reply_move) if opp_reply_move else None

        if not board_before.is_check():
            null_board = board_before.copy(stack=False)
            null_board.turn = not board_before.turn
            null_board.ep_square = None
            if not null_board.is_game_over():
                n_info = eng.analyse(null_board, chess.engine.Limit(depth=12))
                n_pv = n_info.get("pv", [])
                if n_pv:
                    pre_move = n_pv[0]
                    pre_san = null_board.san(pre_move)
                    opp_cp_if_pass = score_to_cp(n_info["score"].pov(not perspective))
                    opp_cp_root = -best_cand["eval_cp"]
                    threat_gain = max(0, opp_cp_if_pass - opp_cp_root)
                    null_threat_info["pre_existing_threat_san"] = pre_san
                    null_threat_info["pre_existing_threat_pv"] = format_pv_numbered(
                        null_board, n_pv, 5
                    )
                    null_threat_info["threat_gain_cp"] = threat_gain

                    if opp_reply_move is not None and threat_gain >= 45:
                        same_idea = (
                            pre_move == opp_reply_move
                            or pre_move.to_square == opp_reply_move.to_square
                        )
                        if same_idea:
                            null_threat_info["threat_diagnosis"] = "IGNORED_EXISTING_THREAT"
                        else:
                            null_threat_info["threat_diagnosis"] = "CREATED_NEW_TARGET"
                    elif opp_reply_move is not None and cp_loss >= 80:
                        null_threat_info["threat_diagnosis"] = "CREATED_NEW_TARGET"
        else:
            null_threat_info["threat_diagnosis"] = "FORCED_CHECK_RESPONSE"

        # 5. Counterfactual "What If Opponent Plays X Against Best Move?" Refuter
        counterfactuals: list[dict[str, Any]] = []
        board_after_best = board_before.copy(stack=False)
        board_after_best.push(best_move)
        if not board_after_best.is_game_over():
            # Shallow multi-PV on board_after_best to spot tempting opponent tries
            shallow_opp_infos = eng.analyse(
                board_after_best, chess.engine.Limit(depth=3), multipv=4
            )
            if not isinstance(shallow_opp_infos, list):
                shallow_opp_infos = [shallow_opp_infos]

            main_opp_reply = best_pv[1] if len(best_pv) >= 2 else None
            try_moves: list[chess.Move] = []

            # Collect captures on best_move.to_square, checks, and top shallow moves
            for m in board_after_best.legal_moves:
                if m == main_opp_reply:
                    continue
                if m.to_square == best_move.to_square and board_after_best.is_capture(m):
                    try_moves.append(m)
            for sinfo in shallow_opp_infos:
                spv = sinfo.get("pv", [])
                if spv and spv[0] != main_opp_reply and spv[0] not in try_moves:
                    try_moves.append(spv[0])

            for alt_opp in try_moves[:2]:
                alt_san = board_after_best.san(alt_opp)
                sim_alt = board_after_best.copy(stack=False)
                sim_alt.push(alt_opp)
                if sim_alt.is_game_over():
                    continue
                alt_res = eng.analyse(sim_alt, chess.engine.Limit(depth=12))
                alt_pv = alt_res.get("pv", [])
                alt_cp_player = score_to_cp(alt_res["score"].pov(perspective))
                counterfactuals.append(
                    {
                        "opponent_try_san": alt_san,
                        "opponent_try_uci": alt_opp.uci(),
                        "eval_for_player_cp": alt_cp_player,
                        "eval_white_str": format_score(alt_res["score"].white()),
                        "refutation_san": sim_alt.san(alt_pv[0]) if alt_pv else "",
                        "continuation_formatted": format_pv_numbered(sim_alt, alt_pv, 5),
                        "continuation_uci": [m.uci() for m in alt_pv[:5]],
                    }
                )

        # 6. Quiet-Settlement White-Box Evaluation Deltas
        wb_root = evaluate_whitebox(board_before)
        full_played_pv = [played_move] + refutation_pv
        played_quiet_board, played_settled_san = walk_to_quiet_settlement(
            board_before, full_played_pv, min_plies=4, max_plies=8
        )
        wb_played_leaf = evaluate_whitebox(played_quiet_board)

        best_quiet_board, best_settled_san = walk_to_quiet_settlement(
            board_before, best_pv, min_plies=4, max_plies=8
        )
        wb_best_leaf = evaluate_whitebox(best_quiet_board)

        delta_root_to_played = diff_whitebox(wb_root, wb_played_leaf, perspective)
        delta_root_to_best = diff_whitebox(wb_root, wb_best_leaf, perspective)
        delta_played_vs_best = diff_whitebox(wb_played_leaf, wb_best_leaf, perspective)

        return {
            "played_san": played_san,
            "played_uci": played_move.uci(),
            "played_eval_cp": played_cp,
            "played_eval_white_str": played_white_str,
            "played_win_prob": round(played_wp, 4),
            "best_san": best_cand["san"],
            "best_uci": best_cand["uci"],
            "best_eval_cp": best_cand["eval_cp"],
            "best_eval_white_str": best_cand["eval_white_str"],
            "best_win_prob": best_cand["win_prob"],
            "cp_loss": cp_loss,
            "wp_loss": round(wp_loss, 4),
            "severity": classify_move_severity(wp_loss, played_move == best_move),
            "candidates": candidates,
            "singularity": singularity,
            "wp_gap_top2": round(wp_gap_1_2, 4),
            "opponent_best_reply_san": opp_reply_san,
            "opponent_only_punishment": opponent_only_punishment,
            "opponent_second_reply_san": opp_second_reply_san,
            "refutation_pv_uci": [m.uci() for m in refutation_pv[:8]],
            "refutation_pv_san": pv_to_san_list(board_after_played, refutation_pv, 8),
            "refutation_pv_formatted": format_pv_numbered(
                board_after_played, refutation_pv, 8
            ),
            "depth_curve": {
                "played": {str(k): v for k, v in sorted(depth_curve["played"].items())},
                "best": {str(k): v for k, v in sorted(depth_curve["best"].items())},
                "tempting_at_shallow": tempting_at_shallow,
                "best_looks_scary_shallow": best_looks_scary_shallow,
                "crossover_depth": crossover_depth,
                "horizon_category": horizon_category,
            },
            "null_threat": null_threat_info,
            "counterfactual_replies_to_best": counterfactuals,
            "whitebox": {
                "root": wb_root.to_dict(perspective),
                "played_settled": wb_played_leaf.to_dict(perspective),
                "played_settled_line": played_settled_san,
                "best_settled": wb_best_leaf.to_dict(perspective),
                "best_settled_line": best_settled_san,
                "delta_root_to_played": delta_root_to_played,
                "delta_root_to_best": delta_root_to_best,
                "delta_played_vs_best": delta_played_vs_best,
            },
        }

    def analyze_pgn(
        self,
        pgn_text: str,
        player_color_str: str = "white",
        scan_depth: int = 13,
        deep_depth: int = 17,
        max_turning_points: int = 8,
    ) -> dict[str, Any]:
        """Run Pass 1 (whole-game scan) + Pass 2 (deep tree interrogation on critical moments)."""
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            raise ValueError("Could not parse PGN input.")

        perspective = (
            chess.WHITE if player_color_str.lower().startswith("w") else chess.BLACK
        )
        eng = self.engine

        headers = dict(game.headers)
        board = game.board()
        initial_fen = board.fen()

        # Pass 1: Evaluate all states (0 .. N)
        nodes: list[chess.pgn.GameNode] = []
        curr: chess.pgn.GameNode = game
        while curr.variations:
            nxt = curr.variation(0)
            nodes.append(nxt)
            curr = nxt

        # Evaluate initial position
        scan_limit = chess.engine.Limit(depth=scan_depth, time=0.09)
        init_info = eng.analyse(board, scan_limit)
        prev_info = init_info
        prev_wb = evaluate_whitebox(board)

        plies_data: list[dict[str, Any]] = []
        player_candidates_for_deep: list[tuple[float, int, chess.Board, chess.Move]] = []

        for idx, node in enumerate(nodes):
            ply_num = idx + 1
            mover = board.turn
            move = node.move
            san = board.san(move)
            fen_before = board.fen()
            original_nags = sorted(list(node.nags))

            best_before_pv = prev_info.get("pv", [])
            best_before_move = best_before_pv[0] if best_before_pv else move
            best_before_san = (
                board.san(best_before_move)
                if best_before_move in board.legal_moves
                else san
            )
            cp_before_mover = score_to_cp(prev_info["score"].pov(mover))
            wp_before_mover = cp_to_win_prob(cp_before_mover)

            board_before_copy = board.copy(stack=False)
            board.push(move)
            fen_after = board.fen()
            wb_after = evaluate_whitebox(board)

            if board.is_game_over():
                if board.is_checkmate():
                    cp_after_mover = 3000
                    eval_white_str = "#0" if mover == chess.WHITE else "-#0"
                    cp_white = 3000 if mover == chess.WHITE else -3000
                else:
                    cp_after_mover = 0
                    eval_white_str = "+0.00"
                    cp_white = 0
                curr_info = prev_info
            else:
                curr_info = eng.analyse(board, scan_limit)
                cp_after_mover = score_to_cp(curr_info["score"].pov(mover))
                eval_white_str = format_score(curr_info["score"].white())
                cp_white = score_to_cp(curr_info["score"].white())

            wp_after_mover = cp_to_win_prob(cp_after_mover)
            is_best = move == best_before_move
            wp_loss = 0.0 if is_best else max(0.0, wp_before_mover - wp_after_mover)
            cp_loss = 0 if is_best else max(0, cp_before_mover - cp_after_mover)
            severity = classify_move_severity(wp_loss, is_best)

            ply_entry = {
                "ply": ply_num,
                "move_number": (ply_num + 1) // 2,
                "color": "white" if mover == chess.WHITE else "black",
                "san": san,
                "uci": move.uci(),
                "fen_before": fen_before,
                "fen_after": fen_after,
                "eval_white_cp": cp_white,
                "eval_white_str": eval_white_str,
                "win_prob_white": round(cp_to_win_prob(cp_white), 4),
                "best_before_san": best_before_san,
                "best_before_uci": best_before_move.uci(),
                "cp_loss": cp_loss,
                "wp_loss": round(wp_loss, 4),
                "severity": severity,
                "original_nags": original_nags,
                "whitebox_after": wb_after.to_dict(perspective),
            }
            plies_data.append(ply_entry)

            if mover == perspective and wp_loss >= 0.055:
                player_candidates_for_deep.append(
                    (wp_loss, idx, board_before_copy, move)
                )

            prev_info = curr_info
            prev_wb = wb_after

        # Select top turning points by win-probability loss, then sort chronologically
        player_candidates_for_deep.sort(key=lambda item: item[0], reverse=True)
        selected = sorted(
            player_candidates_for_deep[:max_turning_points], key=lambda item: item[1]
        )

        turning_points: list[dict[str, Any]] = []
        for _, ply_idx, b_before, mv in selected:
            deep_probe = self.interrogate_decision(
                b_before, mv, perspective, deep_depth=deep_depth
            )
            # Keep only confirmed inaccuracies/mistakes/blunders at deep depth
            if deep_probe["wp_loss"] < 0.055:
                continue
            ply_meta = plies_data[ply_idx]
            # Update ply entry with more accurate deep severity/eval
            ply_meta["severity"] = deep_probe["severity"]
            ply_meta["wp_loss"] = deep_probe["wp_loss"]
            ply_meta["cp_loss"] = deep_probe["cp_loss"]
            ply_meta["best_before_san"] = deep_probe["best_san"]
            ply_meta["best_before_uci"] = deep_probe["best_uci"]

            turning_points.append(
                {
                    "ply": ply_meta["ply"],
                    "move_number": ply_meta["move_number"],
                    "color": ply_meta["color"],
                    "fen_before": ply_meta["fen_before"],
                    "fen_after": ply_meta["fen_after"],
                    "original_nags": ply_meta["original_nags"],
                    **deep_probe,
                }
            )

        return {
            "headers": headers,
            "initial_fen": initial_fen,
            "initial_whitebox": evaluate_whitebox(chess.Board(initial_fen)).to_dict(
                perspective
            ),
            "player_color": "white" if perspective == chess.WHITE else "black",
            "total_plies": len(plies_data),
            "plies": plies_data,
            "turning_points": turning_points,
        }

    def probe_position_and_move(
        self,
        fen: str,
        candidate_move_str: str | None = None,
        perspective: chess.Color = chess.WHITE,
        depth: int = 15,
    ) -> dict[str, Any]:
        """Probe any FEN (and optional SAN/UCI candidate move) live for Q&A."""
        board = chess.Board(fen)
        eng = self.engine

        if candidate_move_str:
            cleaned = candidate_move_str.strip().rstrip("?!+#")
            parsed_move: chess.Move | None = None
            for attempt in (candidate_move_str.strip(), cleaned):
                try:
                    parsed_move = board.parse_san(attempt)
                    break
                except ValueError:
                    try:
                        mv = chess.Move.from_uci(attempt.lower())
                        if mv in board.legal_moves:
                            parsed_move = mv
                            break
                    except ValueError:
                        pass
            if parsed_move is not None:
                return {
                    "mode": "move_comparison",
                    "fen": fen,
                    "turn": "white" if board.turn == chess.WHITE else "black",
                    "decision": self.interrogate_decision(
                        board, parsed_move, board.turn, deep_depth=depth
                    ),
                }

        # Position-level Multi-PV + Null-Move Threat + White-Box breakdown
        mpv = eng.analyse(board, chess.engine.Limit(depth=depth), multipv=3)
        if not isinstance(mpv, list):
            mpv = [mpv]

        top_lines = []
        for idx, info in enumerate(mpv):
            pv = info.get("pv", [])
            if not pv:
                continue
            top_lines.append(
                {
                    "rank": idx + 1,
                    "san": board.san(pv[0]),
                    "uci": pv[0].uci(),
                    "eval_cp_turn": score_to_cp(info["score"].pov(board.turn)),
                    "eval_white_str": format_score(info["score"].white()),
                    "pv_formatted": format_pv_numbered(board, pv, 7),
                    "pv_uci": [m.uci() for m in pv[:7]],
                }
            )

        opp_threat = None
        if not board.is_check():
            nb = board.copy(stack=False)
            nb.turn = not board.turn
            nb.ep_square = None
            if not nb.is_game_over():
                ninfo = eng.analyse(nb, chess.engine.Limit(depth=12))
                npv = ninfo.get("pv", [])
                if npv:
                    opp_threat = {
                        "threat_san": nb.san(npv[0]),
                        "threat_pv": format_pv_numbered(nb, npv, 5),
                        "eval_white_str": format_score(ninfo["score"].white()),
                    }

        wb = evaluate_whitebox(board)
        return {
            "mode": "position_overview",
            "fen": fen,
            "turn": "white" if board.turn == chess.WHITE else "black",
            "top_lines": top_lines,
            "opponent_threat_if_pass": opp_threat,
            "whitebox": wb.to_dict(perspective),
        }

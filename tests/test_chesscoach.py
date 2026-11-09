"""Automated test suite for ChessCoach White-Box Eval, Tree Interrogator, Q&A, and API."""

from __future__ import annotations

import chess
from fastapi.testclient import TestClient

from chesscoach.interrogator import HybridInterrogator, walk_to_quiet_settlement
from chesscoach.qa_coach import answer_coaching_question
from chesscoach.server import app
from chesscoach.whitebox_eval import diff_whitebox, evaluate_whitebox


def test_whitebox_eval_starting_symmetry():
    board = chess.Board()
    wb = evaluate_whitebox(board)
    assert wb.total_white_cp == 0
    for val in wb.dimensions_white_cp.values():
        assert val == 0


def test_whitebox_detects_levers_and_uncastled_king():
    # Position from user's game right before 13. Kh1
    fen = "r1bqk2r/1p2bp1p/p3p2n/3pP1p1/3N4/2NP2Q1/PP3PPP/R1B2RK1 w kq - 0 13"
    board = chess.Board(fen)
    wb = evaluate_whitebox(board)
    kinds = {(f.color, f.kind) for f in wb.facts}

    assert ("White", "pawn_lever") in kinds
    assert ("Black", "uncastled_king_weak_wing") in kinds
    assert ("White", "central_knight_perch") in kinds


def test_quiet_settlement_finishes_recaptures():
    # Before 13. Kh1: test 13. Kh1 Nf5 14. Nxf5 exf5 15. f4
    fen = "r1bqk2r/1p2bp1p/p3p2n/3pP1p1/3N4/2NP2Q1/PP3PPP/R1B2RK1 w kq - 0 13"
    board = chess.Board(fen)
    pv = [
        chess.Move.from_uci("g1h1"),
        chess.Move.from_uci("h6f5"),
        chess.Move.from_uci("d4f5"),
        chess.Move.from_uci("e6f5"),
        chess.Move.from_uci("f2f4"),
    ]
    settled_board, sans = walk_to_quiet_settlement(board, pv, min_plies=2, max_plies=8)
    # Must include both Nxf5 AND exf5 so material isn't distorted mid-trade!
    assert sans == ["Kh1", "Nf5", "Nxf5", "exf5"]
    wb_before = evaluate_whitebox(board)
    wb_after = evaluate_whitebox(settled_board)
    delta = diff_whitebox(wb_before, wb_after, chess.WHITE)
    assert abs(delta["dimension_deltas_cp"]["material"]) < 50


def test_interrogator_and_live_qa():
    fen_before_13 = "r1bqk2r/1p2bp1p/p3p2n/3pP1p1/3N4/2NP2Q1/PP3PPP/R1B2RK1 w kq - 0 13"
    board = chess.Board(fen_before_13)
    played_kh1 = chess.Move.from_uci("g1h1")

    with HybridInterrogator() as hi:
        probe = hi.interrogate_decision(board, played_kh1, chess.WHITE, deep_depth=16)
        cand_sans = [c["san"] for c in probe["candidates"]]
        assert "h4" in cand_sans
        assert probe["best_san"] != "Kh1"
        assert probe["severity"] in ("mistake", "blunder", "inaccuracy")
        assert probe["null_threat"]["pre_existing_threat_san"] == "Nf5"

        # Test Q&A: "What if I played 13. f4 instead?"
        board_after_kh1 = board.copy()
        board_after_kh1.push(played_kh1)
        qa_res = answer_coaching_question(
            interrogator=hi,
            question="What if I played 13. f4 instead?",
            fen_current=board_after_kh1.fen(),
            fen_before=fen_before_13,
            ply_meta={"san": "Kh1", "uci": "g1h1", "eval_white_str": "-0.03"},
            perspective_str="white",
        )
        assert qa_res["query_type"] == "alternative_move_probe"
        assert "f4" in qa_res["answer_markdown"]
        assert len(qa_res["interactive_lines"]) >= 1


def test_api_endpoints():
    client = TestClient(app)
    r_settings = client.get("/api/settings")
    assert r_settings.status_code == 200
    r_games = client.get("/api/games")
    assert r_games.status_code == 200
    r_idx = client.get("/")
    assert r_idx.status_code == 200
    assert "ChessCoach" in r_idx.text

    # Test position evaluation GET and POST
    test_fen = "r1bqk2r/pppp1ppp/2n5/4p3/1bB1n3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 6"
    r_eval_get = client.get(f"/api/eval?fen={test_fen}")
    assert r_eval_get.status_code == 200
    data_get = r_eval_get.json()
    assert "eval_str" in data_get
    assert "win_prob_white" in data_get
    assert 0.0 <= data_get["win_prob_white"] <= 1.0

    r_eval_post = client.post("/api/eval", json={"fen": test_fen})
    assert r_eval_post.status_code == 200
    data_post = r_eval_post.json()
    assert abs(data_post["win_prob_white"] - data_get["win_prob_white"]) < 0.10


def test_auto_heal_engine_event_loop():
    """Verify that when an engine event loop dies or terminates, HybridInterrogator auto-restarts seamlessly."""
    with HybridInterrogator() as interrogator:
        interrogator.start()
        assert interrogator.is_alive()
        # Simulate unexpected engine termination / dead event loop
        interrogator._engine.close()
        assert not interrogator.is_alive()

        # Operation should transparently auto-heal and succeed
        res = interrogator.evaluate_position("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1")
        assert res["eval_str"]
        assert 0.0 <= res["win_prob_white"] <= 1.0
        assert interrogator.is_alive()

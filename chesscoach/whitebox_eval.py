"""White-Box Classical Positional Evaluator & Board Fact Extractor.

Computes a transparent, human-decomposable 6-dimension evaluation vector
alongside concrete board facts (outposts, pawn levers, open king files,
trapped/restricted pieces, pins, loose pieces, passed pawns, bad bishops).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import chess

PIECE_VALUES_MG = {
    chess.PAWN: 100,
    chess.KNIGHT: 315,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 950,
    chess.KING: 0,
}

PIECE_VALUES_EG = {
    chess.PAWN: 120,
    chess.KNIGHT: 305,
    chess.BISHOP: 335,
    chess.ROOK: 530,
    chess.QUEEN: 980,
    chess.KING: 0,
}

PHASE_WEIGHTS = {
    chess.KNIGHT: 1,
    chess.BISHOP: 1,
    chess.ROOK: 2,
    chess.QUEEN: 4,
}
MAX_PHASE = 24

CORE_CENTER = chess.SquareSet([chess.D4, chess.E4, chess.D5, chess.E5])
EXTENDED_CENTER = chess.SquareSet(
    [
        chess.C3, chess.D3, chess.E3, chess.F3,
        chess.C4, chess.D4, chess.E4, chess.F4,
        chess.C5, chess.D5, chess.E5, chess.F5,
        chess.C6, chess.D6, chess.E6, chess.F6,
    ]
)

LIGHT_SQUARES = chess.BB_LIGHT_SQUARES
DARK_SQUARES = chess.BB_DARK_SQUARES

DIMENSION_LABELS = {
    "material": "Material & Imbalances",
    "pawn_structure": "Pawn Structure & Levers",
    "piece_activity": "Piece Mobility & Outposts",
    "king_safety": "King Safety & File Exposure",
    "space_and_center": "Space & Central Control",
    "tactical_vulnerability": "Tactical Stability (Loose/Pinned)",
}


def compute_game_phase(board: chess.Board) -> float:
    """Return game phase from 1.0 (opening) down to 0.0 (pure pawn endgame)."""
    phase = 0
    for pt, w in PHASE_WEIGHTS.items():
        phase += w * (
            len(board.pieces(pt, chess.WHITE)) + len(board.pieces(pt, chess.BLACK))
        )
    return min(1.0, phase / MAX_PHASE)


def _side_name(color: chess.Color) -> str:
    return "White" if color == chess.WHITE else "Black"


def _piece_name(pt: chess.PieceType) -> str:
    return {
        chess.PAWN: "Pawn",
        chess.KNIGHT: "Knight",
        chess.BISHOP: "Bishop",
        chess.ROOK: "Rook",
        chess.QUEEN: "Queen",
        chess.KING: "King",
    }[pt]


@dataclass
class BoardFact:
    """A concrete, human-named positional or tactical feature on the board."""

    category: str
    kind: str
    color: str  # "White" or "Black"
    squares: list[str]
    description: str
    impact_cp: int  # positive means favorable to `color`, negative means liability for `color`

    def to_dict(self) -> dict[str, Any]:
        return {
            "category": self.category,
            "kind": self.kind,
            "color": self.color,
            "squares": self.squares,
            "description": self.description,
            "impact_cp": self.impact_cp,
        }


@dataclass
class WhiteBoxEval:
    """Full 6-dimension white-box evaluation from White's centipawn perspective."""

    fen: str
    phase: float  # 1.0 = opening/middlegame, 0.0 = endgame
    dimensions_white_cp: dict[str, int]
    total_white_cp: int
    facts: list[BoardFact] = field(default_factory=list)

    def for_side(self, color: chess.Color) -> dict[str, int]:
        sign = 1 if color == chess.WHITE else -1
        return {k: sign * v for k, v in self.dimensions_white_cp.items()}

    def total_for_side(self, color: chess.Color) -> int:
        return self.total_white_cp if color == chess.WHITE else -self.total_white_cp

    def to_dict(self, perspective: chess.Color = chess.WHITE) -> dict[str, Any]:
        dims = self.for_side(perspective)
        return {
            "fen": self.fen,
            "phase": round(self.phase, 2),
            "phase_label": (
                "Opening"
                if self.phase >= 0.80
                else ("Middlegame" if self.phase >= 0.35 else "Endgame")
            ),
            "total_cp": self.total_for_side(perspective),
            "dimensions_cp": dims,
            "dimension_labels": DIMENSION_LABELS,
            "facts": [f.to_dict() for f in self.facts],
        }


def _pawn_attacks_by_side(board: chess.Board, color: chess.Color) -> chess.SquareSet:
    attacks = chess.SquareSet()
    for sq in board.pieces(chess.PAWN, color):
        attacks |= board.attacks(sq)
    return attacks


def _eval_material(board: chess.Board, phase: float, facts: list[BoardFact]) -> int:
    """Evaluate material + bishop pair + minor piece structure fit (White - Black)."""
    score = 0.0
    for color in (chess.WHITE, chess.BLACK):
        sign = 1 if color == chess.WHITE else -1
        sname = _side_name(color)
        side_mat = 0.0
        for pt in (chess.PAWN, chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN):
            cnt = len(board.pieces(pt, color))
            val = phase * PIECE_VALUES_MG[pt] + (1.0 - phase) * PIECE_VALUES_EG[pt]
            side_mat += cnt * val

        bishops = board.pieces(chess.BISHOP, color)
        if len(bishops) >= 2:
            bonus = int(30 + 15 * (1.0 - phase))
            side_mat += bonus
            facts.append(
                BoardFact(
                    category="material",
                    kind="bishop_pair",
                    color=sname,
                    squares=[chess.square_name(sq) for sq in bishops],
                    description=f"{sname} holds the bishop pair",
                    impact_cp=bonus,
                )
            )
        score += sign * side_mat
    return int(round(score))


def _eval_pawns(board: chess.Board, phase: float, facts: list[BoardFact]) -> int:
    """Evaluate pawn structure: isolated, doubled, backward, passed, chains, levers."""
    score = 0
    w_pawns = board.pieces(chess.PAWN, chess.WHITE)
    b_pawns = board.pieces(chess.PAWN, chess.BLACK)

    for color in (chess.WHITE, chess.BLACK):
        sign = 1 if color == chess.WHITE else -1
        sname = _side_name(color)
        own_pawns = w_pawns if color == chess.WHITE else b_pawns
        opp_pawns = b_pawns if color == chess.WHITE else w_pawns
        own_pawn_attacks = _pawn_attacks_by_side(board, color)
        opp_pawn_attacks = _pawn_attacks_by_side(board, not color)

        files_counts = [0] * 8
        for sq in own_pawns:
            files_counts[chess.square_file(sq)] += 1

        # Doubled pawns
        for f in range(8):
            if files_counts[f] >= 2:
                pen = 14 * (files_counts[f] - 1)
                score -= sign * pen
                doubled_sqs = [
                    chess.square_name(sq)
                    for sq in own_pawns
                    if chess.square_file(sq) == f
                ]
                facts.append(
                    BoardFact(
                        category="pawn_structure",
                        kind="doubled_pawns",
                        color=sname,
                        squares=doubled_sqs,
                        description=f"{sname} has doubled pawns on the {chr(ord('a') + f)}-file ({', '.join(doubled_sqs)})",
                        impact_cp=-pen,
                    )
                )

        levers_found: list[str] = []
        iso_files_reported: set[int] = set()

        for sq in own_pawns:
            f = chess.square_file(sq)
            r = chess.square_rank(sq)
            rel_rank = r if color == chess.WHITE else (7 - r)
            sq_name = chess.square_name(sq)

            # Isolated pawn check
            has_neighbor = (f > 0 and files_counts[f - 1] > 0) or (
                f < 7 and files_counts[f + 1] > 0
            )
            if not has_neighbor:
                opp_on_file = any(chess.square_file(osq) == f for osq in opp_pawns)
                pen = 16 if opp_on_file else 24
                score -= sign * pen
                if f not in iso_files_reported:
                    iso_files_reported.add(f)
                    iso_sqs = [
                        chess.square_name(psq)
                        for psq in own_pawns
                        if chess.square_file(psq) == f
                    ]
                    facts.append(
                        BoardFact(
                            category="pawn_structure",
                            kind="isolated_pawn",
                            color=sname,
                            squares=iso_sqs,
                            description=f"{sname} has isolated pawn(s) on {', '.join(iso_sqs)}",
                            impact_cp=-pen * len(iso_sqs),
                        )
                    )

            # Pawn chain / phalanx support
            if sq in own_pawn_attacks:
                score += sign * 7

            # Passed pawn check
            is_passed = True
            for osq in opp_pawns:
                of = chess.square_file(osq)
                orank = chess.square_rank(osq)
                if abs(of - f) <= 1:
                    if color == chess.WHITE and orank > r:
                        is_passed = False
                        break
                    if color == chess.BLACK and orank < r:
                        is_passed = False
                        break

            if is_passed:
                rank_bonus = [0, 12, 20, 35, 62, 105, 165, 0][rel_rank]
                eg_mult = 1.0 + 0.45 * (1.0 - phase)
                bonus = int(round(rank_bonus * eg_mult))
                protected = sq in own_pawn_attacks
                if protected:
                    bonus += 18
                # Blockaded by enemy piece?
                step = 8 if color == chess.WHITE else -8
                stop_sq = sq + step
                if 0 <= stop_sq < 64 and board.piece_at(stop_sq) is not None and board.color_at(stop_sq) != color:
                    bonus = int(bonus * 0.72)
                score += sign * bonus
                if rel_rank >= 3 or phase < 0.5:
                    desc_kind = "protected passed pawn" if protected else "passed pawn"
                    facts.append(
                        BoardFact(
                            category="pawn_structure",
                            kind="passed_pawn",
                            color=sname,
                            squares=[sq_name],
                            description=f"{sname} has a {desc_kind} on {sq_name}",
                            impact_cp=bonus,
                        )
                    )
            else:
                # Advanced space spearhead (like White's e5 in Advance Caro-Kann / French)
                if rel_rank == 4 and f in (3, 4) and sq in own_pawn_attacks:
                    score += sign * 14
                    facts.append(
                        BoardFact(
                            category="pawn_structure",
                            kind="pawn_spearhead",
                            color=sname,
                            squares=[sq_name],
                            description=f"{sname} holds a supported central pawn wedge on {sq_name}",
                            impact_cp=14,
                        )
                    )

            # Backward pawn check (has neighbor ahead, cannot safely advance)
            if has_neighbor and not is_passed and sq not in own_pawn_attacks:
                step = 8 if color == chess.WHITE else -8
                stop_sq = sq + step
                behind_all_neighbors = True
                for nsq in own_pawns:
                    nf = chess.square_file(nsq)
                    nr = chess.square_rank(nsq)
                    if abs(nf - f) == 1:
                        if color == chess.WHITE and nr <= r:
                            behind_all_neighbors = False
                        elif color == chess.BLACK and nr >= r:
                            behind_all_neighbors = False
                if behind_all_neighbors and 0 <= stop_sq < 64 and stop_sq in opp_pawn_attacks:
                    score -= sign * 15
                    facts.append(
                        BoardFact(
                            category="pawn_structure",
                            kind="backward_pawn",
                            color=sname,
                            squares=[sq_name],
                            description=f"{sname} has a backward pawn on {sq_name} (stop square {chess.square_name(stop_sq)} controlled by enemy pawns)",
                            impact_cp=-15,
                        )
                    )

            # Available pawn break / lever (can push 1 or 2 squares to challenge an enemy pawn)
            step = 8 if color == chess.WHITE else -8
            start_rank = 1 if color == chess.WHITE else 6
            for push_steps in (1, 2):
                if push_steps == 2 and r != start_rank:
                    continue
                target_sq = sq + step * push_steps
                if not (0 <= target_sq < 64):
                    continue
                if board.piece_at(sq + step) is not None:
                    continue
                if push_steps == 2 and board.piece_at(target_sq) is not None:
                    continue
                if board.piece_at(target_sq) is None:
                    # Would a pawn on target_sq attack an enemy pawn?
                    tf = chess.square_file(target_sq)
                    tr = chess.square_rank(target_sq)
                    att_rank = tr + (1 if color == chess.WHITE else -1)
                    if 0 <= att_rank <= 7:
                        challenged = []
                        for df in (-1, 1):
                            if 0 <= tf + df <= 7:
                                csq = chess.square(tf + df, att_rank)
                                if csq in opp_pawns:
                                    challenged.append(chess.square_name(csq))
                        if challenged:
                            lever_str = f"{sq_name}-{chess.square_name(target_sq)} (challenging {', '.join(challenged)})"
                            levers_found.append(lever_str)

        if levers_found:
            facts.append(
                BoardFact(
                    category="pawn_structure",
                    kind="pawn_lever",
                    color=sname,
                    squares=[lv.split("-")[1].split(" ")[0] for lv in levers_found[:3]],
                    description=f"{sname} has pawn break(s) available: {'; '.join(levers_found[:3])}",
                    impact_cp=6,
                )
            )

    return score


def _eval_piece_activity(board: chess.Board, phase: float, facts: list[BoardFact]) -> int:
    """Evaluate safe mobility, outposts, bad bishops, rook files/7th, trapped pieces, endgame king."""
    score = 0
    w_pawns = board.pieces(chess.PAWN, chess.WHITE)
    b_pawns = board.pieces(chess.PAWN, chess.BLACK)

    for color in (chess.WHITE, chess.BLACK):
        sign = 1 if color == chess.WHITE else -1
        sname = _side_name(color)
        own_pawns = w_pawns if color == chess.WHITE else b_pawns
        opp_pawns = b_pawns if color == chess.WHITE else w_pawns
        own_pawn_attacks = _pawn_attacks_by_side(board, color)
        opp_pawn_attacks = _pawn_attacks_by_side(board, not color)
        own_occ = board.occupied_co[color]

        # 1. Knights: mobility + outposts
        for sq in board.pieces(chess.KNIGHT, color):
            sq_name = chess.square_name(sq)
            f = chess.square_file(sq)
            r = chess.square_rank(sq)
            rel_rank = r if color == chess.WHITE else (7 - r)
            safe_sqs = [
                tsq
                for tsq in board.attacks(sq)
                if not (own_occ & chess.BB_SQUARES[tsq]) and tsq not in opp_pawn_attacks
            ]
            mob_cp = (len(safe_sqs) - 4) * 4
            score += sign * mob_cp

            if len(safe_sqs) == 0:
                score -= sign * 28
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="restricted_piece",
                        color=sname,
                        squares=[sq_name],
                        description=f"{sname} Knight on {sq_name} has 0 safe squares",
                        impact_cp=-28,
                    )
                )

            # Outpost / strong central perch check: ranks 4, 5, 6 (rel_rank 3, 4, 5), files b..g
            if rel_rank in (3, 4, 5) and 1 <= f <= 6 and sq not in opp_pawn_attacks:
                can_enemy_pawn_chase = False
                enemy_chasers_blocked = True
                opp_step = -8 if color == chess.WHITE else 8
                for osq in opp_pawns:
                    of = chess.square_file(osq)
                    orank = chess.square_rank(osq)
                    if abs(of - f) == 1:
                        if (color == chess.WHITE and orank > r) or (
                            color == chess.BLACK and orank < r
                        ):
                            can_enemy_pawn_chase = True
                            front_sq = osq + opp_step
                            if 0 <= front_sq < 64 and board.piece_at(front_sq) is None:
                                enemy_chasers_blocked = False
                if not can_enemy_pawn_chase:
                    supported = sq in own_pawn_attacks
                    central = f in (2, 3, 4, 5)
                    bonus = (28 if central else 16) + (12 if supported else 0)
                    score += sign * bonus
                    facts.append(
                        BoardFact(
                            category="piece_activity",
                            kind="knight_outpost",
                            color=sname,
                            squares=[sq_name],
                            description=f"{sname} Knight occupies {'a pawn-supported' if supported else 'an'} outpost on {sq_name}",
                            impact_cp=bonus,
                        )
                    )
                elif enemy_chasers_blocked and f in (2, 3, 4, 5):
                    bonus = 20
                    score += sign * bonus
                    facts.append(
                        BoardFact(
                            category="piece_activity",
                            kind="central_knight_perch",
                            color=sname,
                            squares=[sq_name],
                            description=f"{sname} Knight holds a strong central perch on {sq_name} (adjacent enemy pawn(s) blocked)",
                            impact_cp=bonus,
                        )
                    )

        # 2. Bishops: mobility + bad bishop + trapped bishop detection
        for sq in board.pieces(chess.BISHOP, color):
            sq_name = chess.square_name(sq)
            safe_sqs = [
                tsq
                for tsq in board.attacks(sq)
                if not (own_occ & chess.BB_SQUARES[tsq]) and tsq not in opp_pawn_attacks
            ]
            mob_cp = (len(safe_sqs) - 5) * 4
            score += sign * mob_cp

            # Bad bishop check (central/chain pawns on same square color)
            on_light = bool(chess.BB_SQUARES[sq] & LIGHT_SQUARES)
            same_color_mask = LIGHT_SQUARES if on_light else DARK_SQUARES
            central_same_pawns = [
                psq
                for psq in own_pawns
                if (chess.BB_SQUARES[psq] & same_color_mask)
                and (psq in EXTENDED_CENTER)
            ]
            if len(central_same_pawns) >= 3 and len(safe_sqs) <= 4:
                pen = 22
                score -= sign * pen
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="bad_bishop",
                        color=sname,
                        squares=[sq_name],
                        description=f"{sname} {'light' if on_light else 'dark'}-squared Bishop on {sq_name} is hemmed in by own central pawns",
                        impact_cp=-pen,
                    )
                )

            if len(safe_sqs) <= 1:
                pen = 35 if len(safe_sqs) == 0 else 18
                score -= sign * pen
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="restricted_bishop",
                        color=sname,
                        squares=[sq_name],
                        description=f"{sname} Bishop on {sq_name} is severely restricted ({len(safe_sqs)} safe square{'s' if len(safe_sqs) != 1 else ''})",
                        impact_cp=-pen,
                    )
                )

        # 3. Rooks: open/semi-open files, 7th rank, battery, mobility
        rooks = list(board.pieces(chess.ROOK, color))
        rook_files: dict[int, list[str]] = {}
        for sq in rooks:
            sq_name = chess.square_name(sq)
            f = chess.square_file(sq)
            r = chess.square_rank(sq)
            rel_rank = r if color == chess.WHITE else (7 - r)
            rook_files.setdefault(f, []).append(sq_name)

            safe_sqs = [
                tsq
                for tsq in board.attacks(sq)
                if not (own_occ & chess.BB_SQUARES[tsq]) and tsq not in opp_pawn_attacks
            ]
            score += sign * ((len(safe_sqs) - 6) * 2)

            own_pawn_on_f = any(chess.square_file(psq) == f for psq in own_pawns)
            opp_pawn_on_f = any(chess.square_file(psq) == f for psq in opp_pawns)
            file_letter = chr(ord("a") + f)
            if not own_pawn_on_f and not opp_pawn_on_f:
                score += sign * 24
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="rook_open_file",
                        color=sname,
                        squares=[sq_name],
                        description=f"{sname} Rook on {sq_name} controls the open {file_letter}-file",
                        impact_cp=24,
                    )
                )
            elif not own_pawn_on_f and opp_pawn_on_f:
                score += sign * 14
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="rook_semi_open_file",
                        color=sname,
                        squares=[sq_name],
                        description=f"{sname} Rook on {sq_name} pressures the semi-open {file_letter}-file",
                        impact_cp=14,
                    )
                )

            if rel_rank == 6:
                score += sign * 28
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="rook_seventh_rank",
                        color=sname,
                        squares=[sq_name],
                        description=f"{sname} Rook penetrates to the 7th rank ({sq_name})",
                        impact_cp=28,
                    )
                )

        for f, r_sqs in rook_files.items():
            if len(r_sqs) >= 2:
                file_letter = chr(ord("a") + f)
                score += sign * 18
                facts.append(
                    BoardFact(
                        category="piece_activity",
                        kind="doubled_rooks",
                        color=sname,
                        squares=r_sqs,
                        description=f"{sname} has doubled rooks on the {file_letter}-file ({', '.join(r_sqs)})",
                        impact_cp=18,
                    )
                )

        # 4. Queen mobility
        for sq in board.pieces(chess.QUEEN, color):
            safe_sqs = [
                tsq
                for tsq in board.attacks(sq)
                if not (own_occ & chess.BB_SQUARES[tsq])
                and tsq not in opp_pawn_attacks
            ]
            score += sign * ((len(safe_sqs) - 9) * 1)

        # 5. Endgame King Centralization (when phase < 0.45)
        if phase < 0.45:
            ksq = board.king(color)
            if ksq is not None:
                kf = chess.square_file(ksq)
                kr = chess.square_rank(ksq)
                center_dist = abs(kf - 3.5) + abs(kr - 3.5)
                eg_weight = (0.45 - phase) / 0.45
                king_act = int(round((4.0 - center_dist) * 14 * eg_weight))
                score += sign * king_act
                if king_act >= 14:
                    facts.append(
                        BoardFact(
                            category="piece_activity",
                            kind="active_endgame_king",
                            color=sname,
                            squares=[chess.square_name(ksq)],
                            description=f"{sname} King is actively centralized in the endgame ({chess.square_name(ksq)})",
                            impact_cp=king_act,
                        )
                    )

    return score


def _eval_king_safety(board: chess.Board, phase: float, facts: list[BoardFact]) -> int:
    """Evaluate king shelter, open/semi-open king files, uncastled exposure, and king-zone attacks."""
    if phase < 0.20:
        return 0

    score = 0
    w_pawns = board.pieces(chess.PAWN, chess.WHITE)
    b_pawns = board.pieces(chess.PAWN, chess.BLACK)

    attacker_weights = {
        chess.KNIGHT: 2,
        chess.BISHOP: 2,
        chess.ROOK: 3,
        chess.QUEEN: 5,
    }

    for color in (chess.WHITE, chess.BLACK):
        sign = 1 if color == chess.WHITE else -1
        sname = _side_name(color)
        opp_name = _side_name(not color)
        ksq = board.king(color)
        if ksq is None:
            continue

        opp_has_queen = len(board.pieces(chess.QUEEN, not color)) > 0
        opp_heavy_count = (
            len(board.pieces(chess.QUEEN, not color)) * 2
            + len(board.pieces(chess.ROOK, not color))
        )
        if opp_heavy_count == 0:
            continue

        scale = phase * (1.15 if opp_has_queen else 0.55)
        kf = chess.square_file(ksq)
        kr = chess.square_rank(ksq)
        own_pawns = w_pawns if color == chess.WHITE else b_pawns
        opp_pawns = b_pawns if color == chess.WHITE else w_pawns

        danger = 0

        # 1. Central / uncastled king exposure
        home_rank = 0 if color == chess.WHITE else 7
        if kf in (3, 4) and phase >= 0.45:
            danger += 36
            # Extra danger if wing pawns already pushed aggressively while king is stuck in center
            advanced_wing_pawns = [
                psq
                for psq in own_pawns
                if chess.square_file(psq) in (5, 6, 7)
                and abs(chess.square_rank(psq) - home_rank) >= 3
            ]
            if advanced_wing_pawns:
                danger += 22
                facts.append(
                    BoardFact(
                        category="king_safety",
                        kind="uncastled_king_weak_wing",
                        color=sname,
                        squares=[chess.square_name(ksq)]
                        + [chess.square_name(p) for p in advanced_wing_pawns],
                        description=f"{sname} King remains uncastled in the center ({chess.square_name(ksq)}) with weakened kingside pawns",
                        impact_cp=-int(round(58 * scale)),
                    )
                )
            else:
                facts.append(
                    BoardFact(
                        category="king_safety",
                        kind="central_king",
                        color=sname,
                        squares=[chess.square_name(ksq)],
                        description=f"{sname} King is still in the center ({chess.square_name(ksq)})",
                        impact_cp=-int(round(36 * scale)),
                    )
                )

        # 2. Open / semi-open files in the king zone (kf-1 .. kf+1)
        exposed_files = []
        enemy_heavy_on_king_files = []
        for f in range(max(0, kf - 1), min(7, kf + 1) + 1):
            own_p = any(chess.square_file(psq) == f for psq in own_pawns)
            opp_p = any(chess.square_file(psq) == f for psq in opp_pawns)
            file_letter = chr(ord("a") + f)
            if not own_p:
                file_danger = 26 if not opp_p else 18
                danger += file_danger
                exposed_files.append(file_letter)
                # Check if opponent has rooks or queen on this file!
                for pt in (chess.ROOK, chess.QUEEN):
                    for osq in board.pieces(pt, not color):
                        if chess.square_file(osq) == f:
                            danger += 24
                            enemy_heavy_on_king_files.append(
                                f"{_piece_name(pt)} on {chess.square_name(osq)}"
                            )

        if enemy_heavy_on_king_files:
            pen_est = int(round(45 * scale))
            facts.append(
                BoardFact(
                    category="king_safety",
                    kind="king_file_attack",
                    color=sname,
                    squares=[chess.square_name(ksq)],
                    description=f"{sname} King ({chess.square_name(ksq)}) faces {opp_name} heavy-piece pressure along open/semi-open king file(s) ({', '.join(enemy_heavy_on_king_files)})",
                    impact_cp=-pen_est,
                )
            )
        elif exposed_files and kf not in (3, 4):
            pen_est = int(round(22 * len(exposed_files) * scale))
            facts.append(
                BoardFact(
                    category="king_safety",
                    kind="missing_pawn_shield",
                    color=sname,
                    squares=[chess.square_name(ksq)],
                    description=f"{sname} King lacks a pawn shield on the {', '.join(exposed_files)}-file(s)",
                    impact_cp=-pen_est,
                )
            )

        # 3. Direct attackers into King Zone (king ring + forward shield)
        king_zone = chess.SquareSet(board.attacks(ksq)) | chess.SquareSet([ksq])
        fwd = 1 if color == chess.WHITE else -1
        for df in (-1, 0, 1):
            if 0 <= kf + df <= 7 and 0 <= kr + 2 * fwd <= 7:
                king_zone.add(chess.square(kf + df, kr + 2 * fwd))

        att_units = 0
        att_count = 0
        for pt, w in attacker_weights.items():
            for osq in board.pieces(pt, not color):
                hits = board.attacks(osq) & king_zone
                if hits:
                    att_count += 1
                    att_units += w * min(3, len(hits))

        if att_count >= 2:
            zone_danger = min(140, att_units * att_count * 2)
            danger += zone_danger
            facts.append(
                BoardFact(
                    category="king_safety",
                    kind="king_zone_convergence",
                    color=sname,
                    squares=[chess.square_name(ksq)],
                    description=f"{opp_name} has {att_count} pieces converging on {sname}'s king zone",
                    impact_cp=-int(round(zone_danger * scale)),
                )
            )

        score -= sign * int(round(danger * scale))

    return score


def _eval_space_and_center(board: chess.Board, phase: float, facts: list[BoardFact]) -> int:
    """Evaluate central square control and safe space behind pawn chains."""
    score = 0
    for sq in CORE_CENTER:
        w_att = len(board.attackers(chess.WHITE, sq))
        b_att = len(board.attackers(chess.BLACK, sq))
        score += (w_att - b_att) * 5
        piece = board.piece_at(sq)
        if piece is not None:
            s = 1 if piece.color == chess.WHITE else -1
            if piece.piece_type == chess.PAWN:
                score += s * 10
            elif piece.piece_type in (chess.KNIGHT, chess.BISHOP):
                score += s * 8

    # Space advantage on ranks 2..4 (White) vs 5..7 (Black), files c..f
    if phase >= 0.35:
        w_space = 0
        b_space = 0
        b_pawn_att = _pawn_attacks_by_side(board, chess.BLACK)
        w_pawn_att = _pawn_attacks_by_side(board, chess.WHITE)
        for f in range(1, 7):
            for r in (1, 2, 3):
                sq = chess.square(f, r)
                if sq not in b_pawn_att and not (
                    board.piece_at(sq) and board.color_at(sq) == chess.BLACK
                ):
                    w_space += 1
            for r in (4, 5, 6):
                sq = chess.square(f, r)
                if sq not in w_pawn_att and not (
                    board.piece_at(sq) and board.color_at(sq) == chess.WHITE
                ):
                    b_space += 1
        space_diff = (w_space - b_space) * 2
        score += space_diff
        if abs(space_diff) >= 12:
            leader = "White" if space_diff > 0 else "Black"
            facts.append(
                BoardFact(
                    category="space_and_center",
                    kind="space_advantage",
                    color=leader,
                    squares=[],
                    description=f"{leader} holds a clear territorial space advantage",
                    impact_cp=abs(space_diff),
                )
            )

    return score


def _eval_tactical_vulnerability(
    board: chess.Board, phase: float, facts: list[BoardFact]
) -> int:
    """Evaluate loose/undefended pieces, lower-value attacks, absolute pins, and 1-move pawn traps."""
    score = 0
    for color in (chess.WHITE, chess.BLACK):
        sign = 1 if color == chess.WHITE else -1
        sname = _side_name(color)
        opp = not color

        for pt in (chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN, chess.PAWN):
            for sq in board.pieces(pt, color):
                sq_name = chess.square_name(sq)

                # 1. Absolute pin to own king
                if board.is_pinned(color, sq):
                    pen = 22 if pt != chess.PAWN else 14
                    score -= sign * pen
                    facts.append(
                        BoardFact(
                            category="tactical_vulnerability",
                            kind="pinned_piece",
                            color=sname,
                            squares=[sq_name],
                            description=f"{sname} {_piece_name(pt)} on {sq_name} is pinned to the King",
                            impact_cp=-pen,
                        )
                    )

                if pt == chess.PAWN:
                    continue

                defenders = board.attackers(color, sq)
                attackers = board.attackers(opp, sq)

                # 2. Loose / undefended piece
                if len(defenders) == 0:
                    if len(attackers) > 0:
                        pen = 45
                        score -= sign * pen
                        facts.append(
                            BoardFact(
                                category="tactical_vulnerability",
                                kind="hanging_piece",
                                color=sname,
                                squares=[sq_name],
                                description=f"{sname} {_piece_name(pt)} on {sq_name} is undefended and directly attacked",
                                impact_cp=-pen,
                            )
                        )
                    elif not (
                        pt == chess.ROOK
                        and sq in (chess.A1, chess.H1, chess.A8, chess.H8)
                    ):
                        pen = 10
                        score -= sign * pen
                        facts.append(
                            BoardFact(
                                category="tactical_vulnerability",
                                kind="loose_piece",
                                color=sname,
                                squares=[sq_name],
                                description=f"{sname} {_piece_name(pt)} on {sq_name} is undefended (loose piece)",
                                impact_cp=-pen,
                            )
                        )
                elif len(attackers) > 0:
                    # Attacked by strictly lower-value piece?
                    min_att_val = min(
                        PIECE_VALUES_MG[board.piece_type_at(asq)] for asq in attackers
                    )
                    my_val = PIECE_VALUES_MG[pt]
                    if min_att_val < my_val:
                        pen = 28
                        score -= sign * pen
                        facts.append(
                            BoardFact(
                                category="tactical_vulnerability",
                                kind="attacked_by_lesser",
                                color=sname,
                                squares=[sq_name],
                                description=f"{sname} {_piece_name(pt)} on {sq_name} is under attack by a lower-value piece",
                                impact_cp=-pen,
                            )
                        )

                # 3. 1-step pawn-trap vulnerability for minor pieces & queen
                if pt in (chess.KNIGHT, chess.BISHOP):
                    f = chess.square_file(sq)
                    r = chess.square_rank(sq)
                    # Check if an enemy pawn push can attack `sq` next move and leave 0 safe retreats
                    pawn_dir = 1 if opp == chess.WHITE else -1
                    att_from_rank = r - pawn_dir
                    push_src_rank = att_from_rank - pawn_dir
                    if 0 <= att_from_rank <= 7 and 0 <= push_src_rank <= 7:
                        for df in (-1, 1):
                            pf = f + df
                            if 0 <= pf <= 7:
                                target_push_sq = chess.square(pf, att_from_rank)
                                src_pawn_sq = chess.square(pf, push_src_rank)
                                if (
                                    board.piece_at(src_pawn_sq)
                                    == chess.Piece(chess.PAWN, opp)
                                    and board.piece_at(target_push_sq) is None
                                ):
                                    # Check if piece has any safe retreat if that pawn pushes
                                    sim = board.copy(stack=False)
                                    sim.turn = opp
                                    push_move = chess.Move(src_pawn_sq, target_push_sq)
                                    if push_move in sim.legal_moves:
                                        sim.push(push_move)
                                        safe_escapes = []
                                        for m in sim.legal_moves:
                                            if m.from_square == sq:
                                                sim.push(m)
                                                # Safe if not attacked by lower value or undefended vs any attacker
                                                new_att = sim.attackers(opp, m.to_square)
                                                new_def = sim.attackers(color, m.to_square)
                                                is_safe = True
                                                if new_att:
                                                    min_a = min(
                                                        PIECE_VALUES_MG[sim.piece_type_at(a)]
                                                        for a in new_att
                                                    )
                                                    if min_a < PIECE_VALUES_MG[pt] or not new_def:
                                                        is_safe = False
                                                sim.pop()
                                                if is_safe:
                                                    safe_escapes.append(chess.square_name(m.to_square))
                                        if len(safe_escapes) == 0:
                                            pen = 40
                                            score -= sign * pen
                                            push_san = f"{chess.square_name(src_pawn_sq)}-{chess.square_name(target_push_sq)}"
                                            facts.append(
                                                BoardFact(
                                                    category="tactical_vulnerability",
                                                    kind="pawn_trap_danger",
                                                    color=sname,
                                                    squares=[sq_name, chess.square_name(target_push_sq)],
                                                    description=f"{sname} {_piece_name(pt)} on {sq_name} is vulnerable to being trapped by {push_san} (0 safe retreats)",
                                                    impact_cp=-pen,
                                                )
                                            )
                                            break

    return score


def evaluate_whitebox(board: chess.Board) -> WhiteBoxEval:
    """Compute full 6-dimension White-Box evaluation and concrete board facts."""
    phase = compute_game_phase(board)
    facts: list[BoardFact] = []

    dims = {
        "material": _eval_material(board, phase, facts),
        "pawn_structure": _eval_pawns(board, phase, facts),
        "piece_activity": _eval_piece_activity(board, phase, facts),
        "king_safety": _eval_king_safety(board, phase, facts),
        "space_and_center": _eval_space_and_center(board, phase, facts),
        "tactical_vulnerability": _eval_tactical_vulnerability(board, phase, facts),
    }
    total = sum(dims.values())
    return WhiteBoxEval(
        fen=board.fen(),
        phase=phase,
        dimensions_white_cp=dims,
        total_white_cp=total,
        facts=facts,
    )


def diff_whitebox(
    baseline: WhiteBoxEval,
    target: WhiteBoxEval,
    perspective: chess.Color,
) -> dict[str, Any]:
    """Compare two WhiteBoxEval snapshots (`target` minus `baseline`) from `perspective`."""
    base_dims = baseline.for_side(perspective)
    targ_dims = target.for_side(perspective)
    deltas = {k: targ_dims[k] - base_dims[k] for k in DIMENSION_LABELS}

    ranked = sorted(
        deltas.items(),
        key=lambda kv: abs(kv[1]),
        reverse=True,
    )
    primary_drivers = [
        {
            "dimension": k,
            "label": DIMENSION_LABELS[k],
            "delta_cp": v,
            "direction": "improved" if v > 0 else "worsened",
        }
        for k, v in ranked
        if abs(v) >= 12
    ]

    base_fact_descs = {f.description: f for f in baseline.facts}
    targ_fact_descs = {f.description: f for f in target.facts}

    new_facts = [
        f.to_dict() for desc, f in targ_fact_descs.items() if desc not in base_fact_descs
    ]
    removed_facts = [
        f.to_dict() for desc, f in base_fact_descs.items() if desc not in targ_fact_descs
    ]

    return {
        "total_delta_cp": target.total_for_side(perspective)
        - baseline.total_for_side(perspective),
        "dimension_deltas_cp": deltas,
        "primary_drivers": primary_drivers,
        "new_facts": new_facts,
        "removed_facts": removed_facts,
    }

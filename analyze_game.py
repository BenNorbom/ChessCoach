"""CLI Entrypoint for ChessCoach Analysis & Interactive Web Studio.

Usage examples:
  python analyze_game.py "__vs_______.__.__.pgn" --color white --title "GCC Classic (Caro-Kann)"
  python analyze_game.py --serve
"""

from __future__ import annotations

import argparse
import hashlib
import sys
import time
import webbrowser
from pathlib import Path

import uvicorn

from chesscoach.config import LLMSettings
from chesscoach.interrogator import HybridInterrogator
from chesscoach.server import save_analysis_dossier
from chesscoach.synthesizer import synthesize_coaching_report


def run_cli_analysis(
    pgn_path: Path,
    color: str = "white",
    title: str = "",
    markdown_out: Path | None = None,
) -> dict:
    pgn_text = pgn_path.read_text(encoding="utf-8")
    digest = hashlib.sha1(f"{color.lower()}::{pgn_text.strip()}".encode("utf-8")).hexdigest()[:10]
    game_id = f"game_{digest}"

    print(f"[ChessCoach] Analyzing {pgn_path.name} from {color.capitalize()}'s perspective...")
    t0 = time.time()
    with HybridInterrogator() as hi:
        raw = hi.analyze_pgn(
            pgn_text,
            player_color_str=color,
            scan_depth=13,
            deep_depth=17,
            max_turning_points=8,
        )

    report = synthesize_coaching_report(raw, settings=LLMSettings.load(), persist_profile=True)
    report["id"] = game_id
    report["title"] = title or f"{pgn_path.stem} ({color.capitalize()})"
    saved_path = save_analysis_dossier(game_id, report)
    elapsed = time.time() - t0

    print(f"[ChessCoach] Completed in {elapsed:.1f}s -> Saved dossier to {saved_path}")
    print("=" * 76)
    print(f"EXECUTIVE SUMMARY (Accuracy: {report['summary']['accuracy_pct']}%)")
    print("=" * 76)
    print(report["summary"]["executive_narrative"])
    print("\n--- TOP TRANSFERABLE OTB TRIGGERS ---")
    for h in report["summary"]["top_habits"]:
        print(f"* [{h['title']}] ({', '.join(h['moves'])})")
        print(f"  Signal: When {h['otb_signal']}")
        print(f"  Action: {h['otb_action']}")

    print("\n--- CRITICAL TURNING POINTS ---")
    for tp in report["turning_points"]:
        c = tp["coaching"]
        print(f"\n{c['headline']}")
        print(
            f"  [{tp['severity'].upper()} | -{tp['wp_loss']*100:.1f}% win eq | {tp['best_eval_white_str']} -> {tp['played_eval_white_str']} | Horizon d={tp['depth_curve']['crossover_depth']} | {tp['null_threat']['threat_diagnosis']}]"
        )
        print(f"  * Intent:    {c['your_likely_intent']}")
        print(f"  * Backfired: {c['why_it_backfired']}")
        print(f"  * Best Plan: {c['why_best_works']}")

    if markdown_out is not None:
        md = format_report_as_markdown(report)
        markdown_out.write_text(md, encoding="utf-8")
        print(f"\n[ChessCoach] Wrote Markdown report to {markdown_out}")

    return report


def format_report_as_markdown(report: dict) -> str:
    s = report["summary"]
    ps = s["phase_summary"]
    lines = [
        f"# ChessCoach Game Analysis: {report.get('title', 'Game')}",
        "",
        f"- **Perspective:** {report['player_color'].capitalize()}",
        f"- **Overall Accuracy:** {s['accuracy_pct']}% (Opening: {ps['Opening']['accuracy']}%, Middlegame: {ps['Middlegame']['accuracy']}%, Endgame: {ps['Endgame']['accuracy']}%)",
        "",
        "## Executive Assessment",
        s["executive_narrative"],
        "",
        "## Transferable Over-The-Board (OTB) Triggers",
    ]
    for h in s["top_habits"]:
        lines.extend(
            [
                f"### {h['title']} ({', '.join(h['moves'])})",
                f"- **Pattern:** {h['summary']}",
                f"- **OTB Signal:** *When {h['otb_signal']}*",
                f"- **OTB Action:** **{h['otb_action']}**",
                "",
            ]
        )

    lines.append("## Critical Turning Points")
    for tp in report["turning_points"]:
        c = tp["coaching"]
        lines.extend(
            [
                f"### {c['headline']}",
                f"- **Diagnostics:** `{tp['severity'].upper()}` (`-{tp['wp_loss']*100:.1f}%` win equity, `{tp['best_eval_white_str']}` → `{tp['played_eval_white_str']}`) | Singularity: `{tp['singularity']}` | Refutation Horizon: `depth {tp['depth_curve']['crossover_depth']}` | Threat Probe: `{tp['null_threat']['threat_diagnosis']}`",
                f"- **Your Likely Intent:** {c['your_likely_intent']}",
                f"- **Why It Backfired:** {c['why_it_backfired']}",
                f"- **Why the Best Plan Works:** {c['why_best_works']}",
                f"- **OTB Trigger:** *When {c['otb_trigger']['signal'].lower()}* → **{c['otb_trigger']['action']}**",
                "",
            ]
        )
    return "\n".join(lines)


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="ChessCoach Hybrid Analysis & Studio CLI")
    parser.add_argument("pgn", nargs="?", help="Path to a .pgn file to analyze")
    parser.add_argument("--color", default="white", choices=["white", "black"], help="Player perspective")
    parser.add_argument("--title", default="", help="Optional game title")
    parser.add_argument("--md-out", default="", help="Optional path to export Markdown report")
    parser.add_argument("--serve", action="store_true", help="Launch the interactive web studio")
    parser.add_argument("--port", type=int, default=8000, help="Port for the web studio")
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser on --serve")
    args = parser.parse_args()

    if args.pgn:
        md_path = Path(args.md_out) if args.md_out else None
        run_cli_analysis(Path(args.pgn), color=args.color, title=args.title, markdown_out=md_path)

    if args.serve or not args.pgn:
        url = f"http://127.0.0.1:{args.port}"
        print(f"\n[ChessCoach Studio] Running at {url}")
        if not args.no_browser:
            webbrowser.open(url)
        uvicorn.run("chesscoach.server:app", host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()

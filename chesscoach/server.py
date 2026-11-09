"""FastAPI Backend for the ChessCoach Interactive Studio & Live Q&A."""

from __future__ import annotations

import hashlib
import json
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from chesscoach.config import ANALYSES_DIR, UI_DIR, LLMSettings, ensure_stockfish, migrate_legacy_data
from chesscoach.interrogator import HybridInterrogator
from chesscoach.llm_client import is_llm_configured
from chesscoach.qa_coach import answer_coaching_question
from chesscoach.synthesizer import _load_player_profile, synthesize_coaching_report


_engine_lock = threading.Lock()
_shared_interrogator: HybridInterrogator | None = None


def get_interrogator() -> HybridInterrogator:
    global _shared_interrogator
    if _shared_interrogator is None:
        _shared_interrogator = HybridInterrogator()
        _shared_interrogator.start()
    return _shared_interrogator


_engine_status: dict[str, Any] = {"engine_ready": False, "engine_message": "Checking chess engine…"}


def _provision_engine() -> None:
    def say(msg: str) -> None:
        _engine_status["engine_message"] = msg

    try:
        ensure_stockfish(say)
        _engine_status.update(engine_ready=True, engine_message="Engine ready")
    except Exception as exc:  # pragma: no cover - network dependent
        _engine_status.update(
            engine_ready=False,
            engine_message=f"Could not download Stockfish ({exc}). Check your internet connection and restart.",
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    migrate_legacy_data()
    ANALYSES_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_provision_engine, daemon=True).start()
    yield
    global _shared_interrogator
    if _shared_interrogator is not None:
        _shared_interrogator.close()
        _shared_interrogator = None


app = FastAPI(title="ChessCoach Studio", version="0.1.0", lifespan=lifespan)


class AnalyzeRequest(BaseModel):
    pgn_text: str
    player_color: str = "white"
    title: str = ""


class QARequest(BaseModel):
    question: str
    fen_current: str
    fen_before: str | None = None
    ply_meta: dict[str, Any] | None = None
    perspective: str = "white"


class SettingsUpdateRequest(BaseModel):
    provider: str = "deterministic"
    api_key: str = ""
    model: str = ""
    base_url: str = ""


def save_analysis_dossier(game_id: str, report: dict[str, Any]) -> Path:
    ANALYSES_DIR.mkdir(parents=True, exist_ok=True)
    out_path = ANALYSES_DIR / f"{game_id}.json"
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return out_path


@app.get("/api/status")
def engine_status() -> dict[str, Any]:
    return dict(_engine_status)


@app.get("/api/games")
def list_analyzed_games() -> dict[str, Any]:
    ANALYSES_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for p in sorted(ANALYSES_DIR.glob("*.json"), key=lambda x: x.stat().st_mtime, reverse=True):
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            hdrs = raw.get("headers", {})
            items.append(
                {
                    "id": p.stem,
                    "title": raw.get("title")
                    or f"{hdrs.get('White', '?')} vs {hdrs.get('Black', '?')} ({raw.get('player_color', 'white').capitalize()})",
                    "player_color": raw.get("player_color", "white"),
                    "total_plies": raw.get("total_plies", 0),
                    "accuracy_pct": raw.get("summary", {}).get("accuracy_pct", 0.0),
                    "turning_points_count": len(raw.get("turning_points", [])),
                }
            )
        except Exception:
            continue
    return {"games": items, "player_profile": _load_player_profile()}


@app.get("/api/games/{game_id}")
def get_game_analysis(game_id: str) -> dict[str, Any]:
    safe_id = Path(game_id).name
    target = ANALYSES_DIR / f"{safe_id}.json"
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Game analysis not found.")
    return json.loads(target.read_text(encoding="utf-8"))


@app.post("/api/analyze")
def analyze_new_game(req: AnalyzeRequest) -> dict[str, Any]:
    if not req.pgn_text.strip():
        raise HTTPException(status_code=400, detail="PGN text cannot be empty.")

    digest = hashlib.sha1(
        f"{req.player_color.lower()}::{req.pgn_text.strip()}".encode("utf-8")
    ).hexdigest()[:10]
    game_id = f"game_{digest}"

    with _engine_lock:
        interrogator = get_interrogator()
        try:
            raw = interrogator.analyze_pgn(
                req.pgn_text,
                player_color_str=req.player_color,
                scan_depth=13,
                deep_depth=17,
                max_turning_points=8,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    report = synthesize_coaching_report(raw, settings=LLMSettings.load(), persist_profile=True)
    report["id"] = game_id
    report["title"] = (
        req.title.strip()
        or f"Analyzed Game ({req.player_color.capitalize()} Perspective)"
    )
    save_analysis_dossier(game_id, report)
    return report


@app.post("/api/qa")
def ask_coach(req: QARequest) -> dict[str, Any]:
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty.")

    with _engine_lock:
        interrogator = get_interrogator()
        try:
            res = answer_coaching_question(
                interrogator=interrogator,
                question=req.question,
                fen_current=req.fen_current,
                fen_before=req.fen_before,
                ply_meta=req.ply_meta,
                perspective_str=req.perspective,
                settings=LLMSettings.load(),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return res


@app.get("/api/settings")
def get_settings() -> dict[str, Any]:
    cfg = LLMSettings.load()
    return {
        "provider": cfg.provider,
        "has_api_key": bool(cfg.api_key.strip()),
        "model": cfg.model,
        "base_url": cfg.base_url,
        "llm_active": is_llm_configured(cfg),
    }


@app.post("/api/settings")
def update_settings(req: SettingsUpdateRequest) -> dict[str, Any]:
    existing = LLMSettings.load()
    key = req.api_key.strip() if req.api_key != "***KEEP***" else existing.api_key
    cfg = LLMSettings(
        provider=req.provider.strip() or "deterministic",
        api_key=key,
        model=req.model.strip(),
        base_url=req.base_url.strip(),
    )
    cfg.save()
    return {
        "provider": cfg.provider,
        "has_api_key": bool(cfg.api_key.strip()),
        "model": cfg.model,
        "base_url": cfg.base_url,
        "llm_active": is_llm_configured(cfg),
    }


if UI_DIR.is_dir():
    app.mount("/static", StaticFiles(directory=str(UI_DIR)), name="static")


@app.get("/")
def serve_index() -> FileResponse:
    return FileResponse(str(UI_DIR / "index.html"))

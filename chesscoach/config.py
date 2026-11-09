"""Configuration, path discovery, and Stockfish provisioning for ChessCoach."""

from __future__ import annotations

import io
import json
import os
import shutil
import sys
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

FROZEN = bool(getattr(sys, "frozen", False))

# Source checkout root (dev) or PyInstaller extraction dir (frozen)
ROOT_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
# Directory containing the running executable (frozen) or the repo root (dev)
APP_DIR = Path(sys.executable).resolve().parent if FROZEN else ROOT_DIR
UI_DIR = ROOT_DIR / "ui"

# Per-user writable location shared by the desktop app and dev runs
USER_DIR = Path(
    os.environ.get("CHESSCOACH_HOME")
    or Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "share") / "ChessCoach"
)
DATA_DIR = USER_DIR / "data"
BIN_DIR = USER_DIR / "bin"
ANALYSES_DIR = DATA_DIR / "analyses"
PROFILE_PATH = DATA_DIR / "player_profile.json"
SETTINGS_PATH = DATA_DIR / "llm_settings.json"


def _candidate_stockfish_paths() -> list[Path]:
    dirs = [BIN_DIR, APP_DIR / "bin", APP_DIR, ROOT_DIR / "bin"]
    out: list[Path] = []
    for d in dirs:
        if d.is_dir():
            out.extend(sorted(d.rglob("stockfish*.exe")))
            out.extend(p for p in sorted(d.rglob("stockfish*")) if p.is_file() and os.access(p, os.X_OK) and p.suffix == "")
    return out


def find_stockfish_path() -> str:
    """Locate the Stockfish UCI binary."""
    env_path = os.environ.get("STOCKFISH_PATH")
    if env_path and Path(env_path).is_file():
        return env_path
    for cand in _candidate_stockfish_paths():
        return str(cand)
    which_sf = shutil.which("stockfish")
    if which_sf:
        return which_sf
    raise FileNotFoundError(
        "Stockfish not found. ChessCoach downloads it automatically on first launch; "
        "or set STOCKFISH_PATH."
    )


def ensure_stockfish(progress: Callable[[str], None] | None = None) -> str:
    """Return a Stockfish path, downloading the official Windows build if missing."""
    try:
        return find_stockfish_path()
    except FileNotFoundError:
        pass

    say = progress or (lambda _msg: None)
    say("Downloading Stockfish chess engine (one-time, ~50 MB)…")
    api = "https://api.github.com/repos/official-stockfish/Stockfish/releases/latest"
    req = urllib.request.Request(api, headers={"User-Agent": "ChessCoach"})
    release = json.loads(urllib.request.urlopen(req, timeout=30).read())
    asset = next(
        a for a in release["assets"]
        if a["name"].startswith("stockfish-windows-x86-64") and a["name"].endswith(".zip")
        and ("universal" in a["name"] or "avx2" in a["name"])
    )
    raw = urllib.request.urlopen(asset["browser_download_url"], timeout=300).read()
    say("Installing Stockfish…")
    target = BIN_DIR / "stockfish"
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        for name in zf.namelist():
            base = Path(name).name
            if base.endswith(".exe") or base in ("Copying.txt", "AUTHORS"):
                (target / base).write_bytes(zf.read(name))
    return find_stockfish_path()


def migrate_legacy_data() -> None:
    """Copy bundled or repo ./data folder into the per-user data dir (one-time)."""
    if ANALYSES_DIR.exists() and any(ANALYSES_DIR.glob("*.json")):
        return
    for legacy in (ROOT_DIR / "data", APP_DIR / "data"):
        if legacy.is_dir() and legacy.resolve() != DATA_DIR.resolve():
            shutil.copytree(legacy, DATA_DIR, dirs_exist_ok=True)
            break


@dataclass
class LLMSettings:
    """Optional LLM provider configuration for live narrative polish and Q&A."""

    provider: str = "auto"  # "auto", "deterministic", "gemini", "openai", "anthropic", "ollama"
    api_key: str = ""
    model: str = ""
    base_url: str = ""

    @classmethod
    def load(cls) -> "LLMSettings":
        if SETTINGS_PATH.is_file():
            try:
                raw = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
                return cls(
                    provider=raw.get("provider", "auto"),
                    api_key=raw.get("api_key", ""),
                    model=raw.get("model", ""),
                    base_url=raw.get("base_url", ""),
                )
            except Exception:
                pass
        # Check environment fallbacks
        if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
            return cls(
                provider="gemini",
                api_key=os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY", ""),
                model="gemini-2.5-flash",
            )
        if os.environ.get("OPENAI_API_KEY"):
            return cls(
                provider="openai",
                api_key=os.environ.get("OPENAI_API_KEY", ""),
                model="gpt-4o-mini",
            )
        if os.environ.get("ANTHROPIC_API_KEY"):
            return cls(
                provider="anthropic",
                api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
                model="claude-3-5-sonnet-latest",
            )
        return cls(provider="deterministic")

    def save(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        SETTINGS_PATH.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")

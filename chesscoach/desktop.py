"""Desktop application launcher for ChessCoach.

Starts the local FastAPI/Stockfish coaching backend on a free port and opens
ChessCoach in a standalone chromeless desktop window (`--app` mode).
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

import uvicorn


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _start_server(port: int) -> uvicorn.Server:
    from chesscoach.server import app

    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", log_config=None
    )
    server = uvicorn.Server(config)
    threading.Thread(target=server.run, daemon=True).start()
    url = f"http://127.0.0.1:{port}/api/status"
    for _ in range(100):
        try:
            urllib.request.urlopen(url, timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    return server


def _open_standalone_app_window(url: str) -> bool:
    """Open a dedicated chromeless desktop window via Edge or Chrome `--app` mode."""
    candidates = [
        shutil.which("msedge"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        shutil.which("chrome"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
    ]
    exe = next((c for c in candidates if c and Path(c).is_file()), None)
    if not exe:
        return False

    profile_dir = Path(tempfile.mkdtemp(prefix="ChessCoachApp_"))
    try:
        proc = subprocess.Popen(
            [
                exe,
                f"--app={url}",
                f"--user-data-dir={profile_dir}",
                "--window-size=1440,920",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
            ]
        )
        proc.wait()
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)
    return True


def main() -> None:
    port = _free_port()
    server = _start_server(port)
    url = f"http://127.0.0.1:{port}/"

    opened = _open_standalone_app_window(url)
    if not opened:
        webbrowser.open(url)
        print(f"ChessCoach is running at {url} — press Ctrl+C to quit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass

    server.should_exit = True
    time.sleep(0.25)
    sys.exit(0)


if __name__ == "__main__":
    main()

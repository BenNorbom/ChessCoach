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


def _is_server_alive(port: int) -> bool:
    url = f"http://127.0.0.1:{port}/api/status"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ChessCoachLauncher"})
        with urllib.request.urlopen(req, timeout=0.8) as resp:
            return resp.status == 200
    except Exception:
        return False


def _find_free_port() -> int:
    for candidate in (28140, 28141, 28142, 28143, 28144, 28145):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", candidate))
                return candidate
            except Exception:
                continue
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _start_server(port: int) -> tuple[uvicorn.Server, bool]:
    from chesscoach.server import app

    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning", log_config=None
    )
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()

    # Wait until server is confirmed healthy and accepting connections
    for _ in range(120):
        if _is_server_alive(port):
            return server, True
        time.sleep(0.08)
    return server, False


def _open_native_window(url: str) -> bool:
    """Open a true native standalone desktop window via pywebview (embedded WebView2).

    This launches a dedicated desktop application window with its own taskbar identity,
    custom icon, and native window frame without running as an Edge browser instance.
    """
    try:
        import webview

        ico_path = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"
        icon_arg = str(ico_path) if ico_path.is_file() else None

        window = webview.create_window(
            title="ChessCoach",
            url=url,
            width=1440,
            height=920,
            min_size=(960, 600),
            background_color="#161512",
            text_select=True,
        )
        webview.start(icon=icon_arg, private_mode=False)
        return True
    except Exception as e:
        print(f"pywebview native window unavailable, falling back: {e}", file=sys.stderr)
        return False


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
    try:
        from install_shortcut import install_start_menu_shortcut
        install_start_menu_shortcut()
    except Exception:
        pass

    # 1. Check if ChessCoach backend is already running on a known port
    active_port = None
    for cand in (28140, 28141, 28142, 28143):
        if _is_server_alive(cand):
            active_port = cand
            break

    server = None
    if active_port is not None:
        url = f"http://127.0.0.1:{active_port}/"
    else:
        port = _find_free_port()
        server, ready = _start_server(port)
        if not ready:
            with socket.socket() as s:
                s.bind(("127.0.0.1", 0))
                port = int(s.getsockname()[1])
            server, ready = _start_server(port)
        url = f"http://127.0.0.1:{port}/"

    opened = _open_native_window(url)
    if not opened:
        opened = _open_standalone_app_window(url)
    if not opened:
        webbrowser.open(url)
        print(f"ChessCoach is running at {url} — press Ctrl+C to quit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass

    if server is not None:
        server.should_exit = True
        time.sleep(0.25)
    sys.exit(0)


if __name__ == "__main__":
    main()

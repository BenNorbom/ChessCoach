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


APP_USER_MODEL_ID = "ChessCoach.DesktopApp.1.0"


def _set_process_app_id() -> None:
    """Set the Windows Application User Model ID so the taskbar groups and shows our icon."""
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_USER_MODEL_ID)
        except Exception:
            pass


def _open_native_window(url: str) -> bool:
    """Open a true native standalone desktop window via pywebview (embedded WebView2).

    This launches a dedicated desktop application window with its own taskbar identity,
    custom icon, and native window frame without running as an Edge browser instance.
    """
    try:
        import ctypes
        import webview

        _set_process_app_id()

        ico_path = Path(__file__).resolve().parent.parent / "assets" / "icon.ico"
        icon_str = str(ico_path.resolve()) if ico_path.is_file() else None

        # Pre-seed pywebview internal state so WinForms Form constructor receives the icon
        if icon_str:
            webview._state["icon"] = icon_str

        window = webview.create_window(
            title="ChessCoach",
            url=url,
            width=1440,
            height=920,
            min_size=(960, 600),
            background_color="#161512",
            text_select=True,
        )

        def _apply_windows_taskbar_icon() -> None:
            if sys.platform != "win32" or not icon_str:
                return
            try:
                from webview.platforms import winforms
                browser = winforms.BrowserView.instances.get(window.uid)
                if not browser:
                    return

                hwnd = browser.Handle.ToInt64()
                WM_SETICON = 0x0080
                ICON_SMALL = 0
                ICON_BIG = 1
                IMAGE_ICON = 1
                LR_LOADFROMFILE = 0x00000010
                LR_DEFAULTSIZE = 0x00000040

                # Load both 32x32/48x48 (taskbar) and 16x16 (window header) native icon handles
                hicon_big = ctypes.windll.user32.LoadImageW(
                    None, icon_str, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE
                )
                hicon_small = ctypes.windll.user32.LoadImageW(
                    None, icon_str, IMAGE_ICON, 16, 16, LR_LOADFROMFILE
                )

                if hicon_big:
                    ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, hicon_big)
                    GCLP_HICON = -14
                    try:
                        ctypes.windll.user32.SetClassLongPtrW(hwnd, GCLP_HICON, hicon_big)
                    except Exception:
                        pass
                if hicon_small:
                    ctypes.windll.user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, hicon_small)
                    GCLP_HICONSM = -34
                    try:
                        ctypes.windll.user32.SetClassLongPtrW(hwnd, GCLP_HICONSM, hicon_small)
                    except Exception:
                        pass
            except Exception:
                pass

        window.events.shown += _apply_windows_taskbar_icon
        window.events.loaded += _apply_windows_taskbar_icon

        webview.start(icon=icon_str, private_mode=False)
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
    _set_process_app_id()
    try:
        from install_shortcut import install_start_menu_shortcut
        install_start_menu_shortcut(force=True)
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

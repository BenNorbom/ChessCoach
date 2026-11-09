"""Build the standalone Windows desktop launcher `ChessCoach.exe` with embedded icon."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

CPP_LAUNCHER = r"""
#include <windows.h>
#include <string>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, LPWSTR, int) {
    wchar_t exePath[MAX_PATH];
    GetModuleFileNameW(NULL, exePath, MAX_PATH);
    std::wstring dir(exePath);
    size_t pos = dir.find_last_of(L"\\/");
    if (pos != std::wstring::npos) {
        dir = dir.substr(0, pos);
    }
    std::wstring script = L"\"" + dir + L"\\ChessCoach.py\"";
    std::wstring cmd = L"pythonw.exe " + script;

    STARTUPINFOW si{};
    PROCESS_INFORMATION pi{};
    si.cb = sizeof(si);

    if (!CreateProcessW(NULL, &cmd[0], NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir.c_str(), &si, &pi)) {
        std::wstring fallback = L"python.exe " + script;
        if (!CreateProcessW(NULL, &fallback[0], NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir.c_str(), &si, &pi)) {
            MessageBoxW(NULL, L"Could not launch Python to start ChessCoach.", L"ChessCoach Error", MB_ICONERROR);
            return 1;
        }
    }
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    return 0;
}
"""


def build() -> Path:
    # Ensure icon exists
    ico_path = ROOT / "assets" / "icon.ico"
    if not ico_path.is_file():
        from create_icon import main as make_icon
        make_icon()

    build_dir = ROOT / "build"
    build_dir.mkdir(exist_ok=True)
    cpp_path = build_dir / "launcher.cpp"
    rc_path = build_dir / "icon.rc"
    res_path = build_dir / "icon.res"
    out_exe = ROOT / "ChessCoach.exe"

    cpp_path.write_text(CPP_LAUNCHER, encoding="utf-8")
    
    # Format path with forward slashes for windres
    ico_forward = str(ico_path.resolve()).replace("\\", "/")
    rc_path.write_text(f'1 ICON "{ico_forward}"\n', encoding="utf-8")

    # Compile resource
    subprocess.check_call(["windres", str(rc_path), "-O", "coff", "-o", str(res_path)])

    # Compile launcher
    subprocess.check_call(
        [
            "g++",
            "-O2",
            "-mwindows",
            "-municode",
            "-static",
            str(cpp_path),
            str(res_path),
            "-o",
            str(out_exe),
        ]
    )
    print(f"Built native desktop app launcher with embedded icon: {out_exe} ({out_exe.stat().st_size:,} bytes)")

    # Install/update start menu shortcut
    from install_shortcut import install_start_menu_shortcut
    install_start_menu_shortcut()

    return out_exe


if __name__ == "__main__":
    sys.exit(0 if build() else 1)

"""Build the standalone Windows desktop launcher `ChessCoach.exe`."""

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
    build_dir = ROOT / "build"
    build_dir.mkdir(exist_ok=True)
    cpp_path = build_dir / "launcher.cpp"
    out_exe = ROOT / "ChessCoach.exe"
    cpp_path.write_text(CPP_LAUNCHER, encoding="utf-8")

    subprocess.check_call(
        [
            "g++",
            "-O2",
            "-mwindows",
            "-municode",
            "-static",
            str(cpp_path),
            "-o",
            str(out_exe),
        ]
    )
    print(f"Built native desktop app launcher: {out_exe} ({out_exe.stat().st_size:,} bytes)")
    return out_exe


if __name__ == "__main__":
    sys.exit(0 if build() else 1)

"""Install ChessCoach shortcut to Windows Start Menu."""

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXE_PATH = ROOT / "ChessCoach.exe"
ICO_PATH = ROOT / "assets" / "icon.ico"

def install_start_menu_shortcut(force: bool = False):
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise RuntimeError("APPDATA environment variable not found.")
    
    programs_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    programs_dir.mkdir(parents=True, exist_ok=True)
    shortcut_path = programs_dir / "ChessCoach.lnk"

    if not force and shortcut_path.is_file():
        return shortcut_path

    ps_script = f"""
    $WshShell = New-Object -ComObject WScript.Shell
    $Shortcut = $WshShell.CreateShortcut("{shortcut_path}")
    $Shortcut.TargetPath = "{EXE_PATH}"
    $Shortcut.WorkingDirectory = "{ROOT}"
    $Shortcut.IconLocation = "{ICO_PATH},0"
    $Shortcut.Description = "ChessCoach - AI Chess Coach"
    $Shortcut.Save()
    """
    cmd = ["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", ps_script]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    subprocess.check_call(cmd, creationflags=creationflags)
    print(f"Created Start Menu shortcut: {shortcut_path}")
    return shortcut_path

if __name__ == "__main__":
    install_start_menu_shortcut()

"""Install ChessCoach shortcut to Windows Start Menu."""

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXE_PATH = ROOT / "ChessCoach.exe"
ICO_PATH = ROOT / "assets" / "icon.ico"

def install_start_menu_shortcut(force: bool = True):
    appdata = os.environ.get("APPDATA")
    userprofile = os.environ.get("USERPROFILE")
    if not appdata:
        raise RuntimeError("APPDATA environment variable not found.")
    
    programs_dir = Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs"
    programs_dir.mkdir(parents=True, exist_ok=True)
    shortcut_path = programs_dir / "ChessCoach.lnk"

    desktop_dir = Path(userprofile) / "Desktop" if userprofile else None

    # PowerShell script to create/refresh both Start Menu and Desktop shortcuts
    # with explicit icon location and AppUserModelID metadata
    ps_targets = [str(shortcut_path)]
    if desktop_dir and desktop_dir.is_dir():
        ps_targets.append(str(desktop_dir / "ChessCoach.lnk"))

    targets_ps_array = "@(" + ", ".join(f'"{t}"' for t in ps_targets) + ")"

    ps_script = f"""
    $WshShell = New-Object -ComObject WScript.Shell
    $targets = {targets_ps_array}
    foreach ($path in $targets) {{
        $Shortcut = $WshShell.CreateShortcut($path)
        $Shortcut.TargetPath = "{EXE_PATH}"
        $Shortcut.WorkingDirectory = "{ROOT}"
        $Shortcut.IconLocation = "{ICO_PATH},0"
        $Shortcut.Description = "ChessCoach - AI Chess Coach"
        $Shortcut.Save()
    }}
    """
    cmd = ["powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", ps_script]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    subprocess.check_call(cmd, creationflags=creationflags)
    print(f"Refreshed shortcuts with icon: {shortcut_path}")
    return shortcut_path

if __name__ == "__main__":
    install_start_menu_shortcut()

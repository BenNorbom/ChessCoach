"""Generate clean, high-contrast icons for ChessCoach.

Renders an authentic Staunton black knight with subtle emerald green accents
on a pure white background.

Generates:
  - assets/logo.svg
  - assets/icon.png (512x512)
  - assets/icon.ico (multi-resolution Windows ICO)
"""

from pathlib import Path
import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def get_logo_svg(size: int = 512) -> str:
    """Returns clean vector SVG with pure white background, black knight, and emerald accents."""
    # Scale & centering for 512x512 canvas
    s = 9.4
    tx = 256 - 22 * s
    ty = 256 - 24 * s

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <!-- Pure solid white background across entire logo -->
  <rect width="{size}" height="{size}" rx="108" fill="#ffffff"/>

  <!-- Subtle crisp emerald outer boundary border -->
  <rect x="12" y="12" width="{size - 24}" height="{size - 24}" rx="96" fill="none" stroke="#7fb65a" stroke-width="8"/>

  <!-- Concentric coaching target rings in soft emerald -->
  <circle cx="256" cy="256" r="210" fill="none" stroke="#8ec868" stroke-width="2.5" stroke-dasharray="10 10" opacity="0.6"/>
  <circle cx="256" cy="256" r="196" fill="none" stroke="#a9db8c" stroke-width="1.5" opacity="0.4"/>

  <!-- Staunton Black Knight with emerald coach accents -->
  <g transform="translate({tx:.2f}, {ty:.2f}) scale({s:.2f})">
    <!-- Back of neck / mane arch (deep black with subtle depth) -->
    <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18"
          fill="#111111" stroke="#000000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Head, ears, muzzle, nostrils, throat, and chest (rich satin black) -->
    <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10"
          fill="#1e1e1e" stroke="#000000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Mane locks & contour highlights (vibrant emerald green) -->
    <path d="M 24.5 12.5 C 28.5 14 31 17.5 31.5 22" fill="none" stroke="#7fb65a" stroke-width="1.5" stroke-linecap="round"/>
    <path d="M 28 19 C 32.5 22 34.5 26.5 35 31.5" fill="none" stroke="#7fb65a" stroke-width="1.5" stroke-linecap="round"/>

    <!-- Jaw contour line (subtle emerald green) -->
    <path d="M 16 27 C 18 24 21 21 23 20" fill="none" stroke="#5da03b" stroke-width="1.2" stroke-linecap="round"/>

    <!-- Flared Nostril (pure white cutout for crisp contrast against the black face) -->
    <path d="M 9.5 25.5 A 0.6 0.6 0 1 1 8.3,25.5 A 0.6 0.6 0 1 1 9.5 25.5 z"
          fill="#ffffff" stroke="#000000" stroke-width="0.3"/>

    <!-- Alert Almond Eye (white sclera with sharp emerald pupil) -->
    <path d="M 15 15.5 A 0.7 1.5 0 1 1 13.6,15.5 A 0.7 1.5 0 1 1 15 15.5 z"
          transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)"
          fill="#ffffff" stroke="#000000" stroke-width="0.5"/>
    <circle cx="14.3" cy="14.8" r="0.45" fill="#7fb65a"/>

    <!-- Classic Staunton pedestal base: emerald accent ring on solid black plinth -->
    <rect x="13.5" y="38.5" width="26" height="2.2" rx="0.8" fill="#7fb65a" stroke="#000000" stroke-width="0.8"/>
    <rect x="11.5" y="40.7" width="30" height="2" rx="0.8" fill="#111111" stroke="#000000" stroke-width="0.8"/>
  </g>
</svg>"""


def main():
    svg_content = get_logo_svg(512)

    # 1. Save SVG
    svg_path = ASSETS / "logo.svg"
    svg_path.write_text(svg_content, encoding="utf-8")
    print(f"Saved {svg_path}")

    # 2. Render high-res 512x512 RGBA PNG
    doc = fitz.open(stream=svg_content.encode("utf-8"), filetype="svg")
    pix = doc[0].get_pixmap(alpha=True)
    img_512 = Image.frombytes("RGBA", [pix.width, pix.height], pix.samples)

    png_path = ASSETS / "icon.png"
    img_512.save(png_path, "PNG")
    print(f"Saved {png_path} ({img_512.size})")

    # 3. Save multi-resolution Windows ICO
    ico_path = ASSETS / "icon.ico"
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    img_512.save(ico_path, format="ICO", sizes=sizes)
    print(f"Saved {ico_path} with sizes {sizes}")


if __name__ == "__main__":
    main()

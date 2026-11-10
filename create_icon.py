"""Generate icons for ChessCoach.

Renders an authentic, classical Staunton knight logo into:
  - assets/logo.svg
  - assets/icon.png (512x512)
  - assets/icon.ico (16, 24, 32, 48, 64, 128, 256)
"""

from pathlib import Path
import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)


def get_logo_svg(size: int = 512) -> str:
    """Returns SVG markup for the ChessCoach Staunton Knight badge logo."""
    s = 9.4
    tx = 256 - 22 * s
    ty = 256 - 24 * s

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <defs>
    <!-- Background rich dark emerald gradient -->
    <radialGradient id="badgeGlow" cx="35%" cy="28%" r="75%">
      <stop offset="0%" stop-color="#244d34"/>
      <stop offset="50%" stop-color="#162e20"/>
      <stop offset="100%" stop-color="#0c1811"/>
    </radialGradient>

    <!-- Outer rim border gradient -->
    <linearGradient id="rimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#9ce672"/>
      <stop offset="45%" stop-color="#5ca84b"/>
      <stop offset="100%" stop-color="#235a29"/>
    </linearGradient>

    <!-- Knight body gradient (creamy marble ivory) -->
    <linearGradient id="ivoryGrad" x1="20%" y1="10%" x2="80%" y2="90%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="55%" stop-color="#f5f1e8"/>
      <stop offset="100%" stop-color="#dfd8c6"/>
    </linearGradient>

    <!-- Mane shadow gradient -->
    <linearGradient id="maneShadow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#eae4d4"/>
      <stop offset="100%" stop-color="#cbbfab"/>
    </linearGradient>

    <!-- Pedestal accent gradient -->
    <linearGradient id="pedestalGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#93db68"/>
      <stop offset="100%" stop-color="#4f8f3b"/>
    </linearGradient>

    <!-- Drop shadow for the knight piece -->
    <filter id="knightDropShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="9"/>
      <feOffset dx="0" dy="10" result="offsetblur"/>
      <feFlood flood-color="#000000" flood-opacity="0.55"/>
      <feComposite in2="offsetblur" operator="in"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Squircle rounded badge -->
  <rect x="20" y="20" width="472" height="472" rx="116" fill="url(#badgeGlow)" stroke="url(#rimGrad)" stroke-width="8"/>

  <!-- Inner coaching rings -->
  <circle cx="256" cy="256" r="206" fill="none" stroke="#7fb65a" stroke-width="2.5" stroke-dasharray="9 9" opacity="0.32"/>
  <circle cx="256" cy="256" r="194" fill="none" stroke="#7fb65a" stroke-width="1.2" opacity="0.18"/>

  <!-- Subtle chessboard corner squares -->
  <g opacity="0.08" fill="#ffffff">
    <rect x="64" y="64" width="28" height="28" rx="4"/>
    <rect x="92" y="92" width="28" height="28" rx="4"/>
    <rect x="420" y="64" width="28" height="28" rx="4"/>
    <rect x="392" y="92" width="28" height="28" rx="4"/>
  </g>

  <!-- Classical Staunton Knight -->
  <g filter="url(#knightDropShadow)">
    <g transform="translate({tx:.2f}, {ty:.2f}) scale({s:.2f})">
      <!-- Mane / back arch shadow layer -->
      <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18"
            fill="url(#maneShadow)" stroke="#16291e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Front head, alert ears, muzzle, nostrils, throat, and chest -->
      <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10"
            fill="url(#ivoryGrad)" stroke="#16291e" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Mane locks detail -->
      <path d="M 24.5 12.5 C 28.5 14 31 17.5 31.5 22" fill="none" stroke="#b2aa96" stroke-width="1.3" stroke-linecap="round"/>
      <path d="M 28 19 C 32.5 22 34.5 26.5 35 31.5" fill="none" stroke="#b2aa96" stroke-width="1.3" stroke-linecap="round"/>

      <!-- Flared Nostril -->
      <path d="M 9.5 25.5 A 0.6 0.6 0 1 1 8.3,25.5 A 0.6 0.6 0 1 1 9.5 25.5 z"
            fill="#16291e" stroke="#16291e" stroke-width="0.5"/>

      <!-- Focused almond eye with pupil highlight -->
      <path d="M 15 15.5 A 0.65 1.5 0 1 1 13.7,15.5 A 0.65 1.5 0 1 1 15 15.5 z"
            transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)"
            fill="#16291e" stroke="#16291e" stroke-width="0.5"/>
      <circle cx="14.3" cy="14.8" r="0.35" fill="#ffffff"/>

      <!-- Jaw definition line -->
      <path d="M 16 27 C 18 24 21 21 23 20" fill="none" stroke="#b8b09e" stroke-width="1.2" stroke-linecap="round"/>

      <!-- Classic Staunton pedestal tiered base -->
      <rect x="13.5" y="38.5" width="26" height="2.2" rx="0.8" fill="url(#pedestalGrad)" stroke="#16291e" stroke-width="0.8"/>
      <rect x="11.5" y="40.7" width="30" height="2" rx="0.8" fill="#e8e2d4" stroke="#16291e" stroke-width="0.8"/>
    </g>
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

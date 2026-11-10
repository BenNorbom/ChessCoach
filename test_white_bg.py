import fitz
from PIL import Image

# Design A: Rich Forest Green Staunton Knight on Pure White Badge
def generate_green_knight_white_bg(size=512):
    s = 9.4
    tx = 256 - 22 * s
    ty = 256 - 24 * s

    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <defs>
    <!-- White badge subtle radial / linear lighting -->
    <radialGradient id="whiteBadgeGrad" cx="35%" cy="25%" r="80%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="70%" stop-color="#fdfdfd"/>
      <stop offset="100%" stop-color="#f0f3f1"/>
    </radialGradient>

    <!-- Outer rim border gradient: sleek emerald -->
    <linearGradient id="rimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7fb65a"/>
      <stop offset="50%" stop-color="#3c8046"/>
      <stop offset="100%" stop-color="#1e4d28"/>
    </linearGradient>

    <!-- Deep forest emerald knight gradient -->
    <linearGradient id="knightGrad" x1="20%" y1="10%" x2="80%" y2="90%">
      <stop offset="0%" stop-color="#2d5e3c"/>
      <stop offset="50%" stop-color="#1c3f27"/>
      <stop offset="100%" stop-color="#122a1a"/>
    </linearGradient>

    <!-- Mane highlight / shadow gradient -->
    <linearGradient id="maneGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38734a"/>
      <stop offset="100%" stop-color="#16331f"/>
    </linearGradient>

    <!-- Drop shadow for the knight on white background -->
    <filter id="knightDropShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="8"/>
      <feOffset dx="0" dy="6" result="offsetblur"/>
      <feFlood flood-color="#122618" flood-opacity="0.32"/>
      <feComposite in2="offsetblur" operator="in"/>
      <feMerge>
        <feMergeNode/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  </defs>

  <!-- Crisp pure white squircle badge -->
  <rect x="20" y="20" width="472" height="472" rx="116" fill="url(#whiteBadgeGrad)" stroke="url(#rimGrad)" stroke-width="8"/>

  <!-- Inner subtle coaching accent rings -->
  <circle cx="256" cy="256" r="206" fill="none" stroke="#7fb65a" stroke-width="2.5" stroke-dasharray="9 9" opacity="0.45"/>
  <circle cx="256" cy="256" r="194" fill="none" stroke="#7fb65a" stroke-width="1.2" opacity="0.25"/>

  <!-- Subtle chessboard accent squares in corners -->
  <g opacity="0.06" fill="#1b4026">
    <rect x="64" y="64" width="28" height="28" rx="4"/>
    <rect x="92" y="92" width="28" height="28" rx="4"/>
    <rect x="420" y="64" width="28" height="28" rx="4"/>
    <rect x="392" y="92" width="28" height="28" rx="4"/>
  </g>

  <!-- Staunton Knight in deep rich forest green -->
  <g filter="url(#knightDropShadow)">
    <g transform="translate({tx:.2f}, {ty:.2f}) scale({s:.2f})">
      <!-- Mane / back arch shadow layer -->
      <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18"
            fill="url(#maneGrad)" stroke="#0e2114" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Front head, alert ears, muzzle, nostrils, throat, and chest -->
      <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10"
            fill="url(#knightGrad)" stroke="#0e2114" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

      <!-- Mane locks detail (light emerald accent) -->
      <path d="M 24.5 12.5 C 28.5 14 31 17.5 31.5 22" fill="none" stroke="#7fb65a" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M 28 19 C 32.5 22 34.5 26.5 35 31.5" fill="none" stroke="#7fb65a" stroke-width="1.4" stroke-linecap="round"/>

      <!-- Flared Nostril -->
      <path d="M 9.5 25.5 A 0.6 0.6 0 1 1 8.3,25.5 A 0.6 0.6 0 1 1 9.5 25.5 z"
            fill="#ffffff" stroke="#ffffff" stroke-width="0.3"/>

      <!-- Focused almond eye with white highlight -->
      <path d="M 15 15.5 A 0.65 1.5 0 1 1 13.7,15.5 A 0.65 1.5 0 1 1 15 15.5 z"
            transform="matrix(0.866,0.5,-0.5,0.866,9.693,-5.173)"
            fill="#ffffff" stroke="#ffffff" stroke-width="0.3"/>
      <circle cx="14.3" cy="14.8" r="0.4" fill="#7fb65a"/>

      <!-- Jaw definition line -->
      <path d="M 16 27 C 18 24 21 21 23 20" fill="none" stroke="#529964" stroke-width="1.2" stroke-linecap="round"/>

      <!-- Classic Staunton pedestal tiered base with bright accent -->
      <rect x="13.5" y="38.5" width="26" height="2.2" rx="0.8" fill="#7fb65a" stroke="#0e2114" stroke-width="0.8"/>
      <rect x="11.5" y="40.7" width="30" height="2" rx="0.8" fill="#1b4026" stroke="#0e2114" stroke-width="0.8"/>
    </g>
  </g>
</svg>"""

svg = generate_green_knight_white_bg()
doc = fitz.open(stream=svg.encode("utf-8"), filetype="svg")
pix = doc[0].get_pixmap(alpha=True)
img = Image.frombytes("RGBA", [pix.width, pix.height], pix.samples)
img.save("assets/test_white_bg.png")
print("Saved assets/test_white_bg.png successfully!")

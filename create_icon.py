"""Generate icons for ChessCoach."""

import math
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)

def draw_knight(size: int = 512) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded background badge (forest / emerald chess theme)
    pad = int(size * 0.05)
    r = int(size * 0.22)
    bg_box = [pad, pad, size - pad, size - pad]
    draw.rounded_rectangle(bg_box, radius=r, fill=(28, 45, 34, 255), outline=(78, 145, 90, 255), width=max(2, int(size * 0.025)))

    # Inner circular highlight
    inner_pad = int(size * 0.12)
    draw.ellipse([inner_pad, inner_pad, size - inner_pad, size - inner_pad], fill=(36, 60, 44, 255))

    # Knight silhouette points normalized to [0, 1] relative to center
    # Scaled to size
    pts_norm = [
        (0.28, 0.78), (0.72, 0.78), (0.72, 0.72), (0.64, 0.72),
        (0.64, 0.64), (0.68, 0.52), (0.62, 0.38), (0.58, 0.32),
        (0.60, 0.24), (0.54, 0.22), (0.46, 0.28), (0.42, 0.28),
        (0.32, 0.38), (0.28, 0.44), (0.34, 0.48), (0.36, 0.52),
        (0.30, 0.54), (0.26, 0.60), (0.28, 0.72), (0.28, 0.78)
    ]
    pts = [(int(x * size), int(y * size)) for x, y in pts_norm]
    draw.polygon(pts, fill=(244, 241, 234, 255))

    # Eye
    eye_x, eye_y = int(0.42 * size), int(0.38 * size)
    eye_r = max(2, int(size * 0.022))
    draw.ellipse([eye_x - eye_r, eye_y - eye_r, eye_x + eye_r, eye_y + eye_r], fill=(28, 45, 34, 255))

    # Base rim detail
    draw.line([(int(0.25 * size), int(0.78 * size)), (int(0.75 * size), int(0.78 * size))], fill=(127, 182, 90, 255), width=max(2, int(size * 0.03)))

    return img

def main():
    base = draw_knight(512)
    png_path = ASSETS / "icon.png"
    base.save(png_path, "PNG")
    print(f"Saved {png_path}")

    ico_path = ASSETS / "icon.ico"
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base.save(ico_path, format="ICO", sizes=sizes)
    print(f"Saved {ico_path} with sizes {sizes}")

if __name__ == "__main__":
    main()

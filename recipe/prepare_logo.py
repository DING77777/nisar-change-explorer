# AI-assisted code (Claude, Codex); see README, Use of AI.
"""
Resize the team logo for the web page and stamp it as AI-generated.
The logo artwork was produced with an AI image tool, so the label must stay visible.

Usage:
  uv run --with pillow python prepare_logo.py SOURCE.png ../docs/assets/logo.png
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

LABEL = "AI-generated logo"
SIZE = 320


def main(src, dst):
    im = Image.open(src).convert("RGBA")
    im.thumbnail((SIZE, SIZE), Image.LANCZOS)
    canvas = Image.new("RGBA", (im.width, im.height + 22), (255, 255, 255, 255))
    canvas.alpha_composite(im, (0, 0))
    font_path = Path("C:/Windows/Fonts/arial.ttf")
    font = ImageFont.truetype(str(font_path), 14) if font_path.exists() else ImageFont.load_default()
    draw = ImageDraw.Draw(canvas)
    width = draw.textlength(LABEL, font=font)
    draw.text(((canvas.width - width) / 2, im.height + 3), LABEL, fill=(60, 60, 60, 255), font=font)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(dst, optimize=True)
    print(f"wrote {dst} ({canvas.width} x {canvas.height})")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

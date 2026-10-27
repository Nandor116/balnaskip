from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)
SCALE = 8
SIZE = 128 * SCALE

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Circular badge
margin = 4 * SCALE
draw.ellipse(
    (margin, margin, SIZE - margin, SIZE - margin),
    fill=(11, 18, 32, 255),
    outline=(45, 212, 191, 255),
    width=5 * SCALE,
)

# Inner subtle ring
inner = 12 * SCALE
draw.ellipse(
    (inner, inner, SIZE - inner, SIZE - inner),
    outline=(45, 212, 191, 40),
    width=2 * SCALE,
)

# Double fast-forward glyph
white = (248, 250, 252, 255)
teal = (94, 234, 212, 255)
# First triangle
draw.polygon(
    [
        (29 * SCALE, 35 * SCALE),
        (29 * SCALE, 93 * SCALE),
        (61 * SCALE, 64 * SCALE),
    ],
    fill=white,
)
# Second triangle
draw.polygon(
    [
        (60 * SCALE, 35 * SCALE),
        (60 * SCALE, 93 * SCALE),
        (92 * SCALE, 64 * SCALE),
    ],
    fill=white,
)
# Small teal underline/wave
draw.rounded_rectangle(
    (33 * SCALE, 101 * SCALE, 95 * SCALE, 108 * SCALE),
    radius=4 * SCALE,
    fill=teal,
)

for size in (16, 32, 48, 96, 128):
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(OUT / f"icon-{size}.png", optimize=True)

print("Wrote icons to", OUT)

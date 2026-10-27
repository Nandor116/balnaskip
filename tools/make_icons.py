from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "sulytalan-avatar.png"
OUT = ROOT / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# Draw at a high resolution and downsample so the small toolbar sizes stay crisp.
SIZE = 2048
INSET = int(SIZE * 0.034)
BADGE_R = int(SIZE * 0.225)
BADGE_CX = int(SIZE * 0.755)
BADGE_CY = int(SIZE * 0.755)

NAVY = (11, 18, 32, 255)
TEAL = (45, 212, 191, 255)
WHITE = (248, 250, 252, 255)


def circle_mask(size):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask


def avatar_image():
    image = Image.open(SOURCE).convert("RGBA")
    width, height = image.size
    side = min(width, height)
    # Slight zoom on the helmet/face, otherwise the details disappear at 16 px.
    crop_side = int(side * 0.88)
    center_x = int(width * 0.47)
    center_y = int(height * 0.43)
    left = max(0, min(width - crop_side, center_x - crop_side // 2))
    top = max(0, min(height - crop_side, center_y - crop_side // 2))
    image = image.crop((left, top, left + crop_side, top + crop_side))
    return image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def build_icon():
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Soft shadow behind the circular avatar.
    shadow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).ellipse(
        (INSET, INSET + int(SIZE * 0.012), SIZE - INSET, SIZE - INSET + int(SIZE * 0.012)),
        fill=(0, 0, 0, 110),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(SIZE * 0.016))
    canvas.alpha_composite(shadow)

    # Dark outer ring, then the cropped channel avatar inside it.
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((INSET, INSET, SIZE - INSET, SIZE - INSET), fill=NAVY)
    inner = INSET + int(SIZE * 0.012)
    avatar = avatar_image().resize((SIZE - 2 * inner, SIZE - 2 * inner), Image.Resampling.LANCZOS)
    canvas.paste(avatar, (inner, inner), circle_mask(SIZE - 2 * inner))

    # Thin teal ring that ties the icon to the extension's accent colour.
    ring_width = max(2, int(SIZE * 0.008))
    draw.ellipse(
        (inner, inner, SIZE - inner, SIZE - inner),
        outline=TEAL,
        width=ring_width,
    )

    # Skip badge: a dark teal-ringed circle with a double fast-forward glyph.
    halo = int(SIZE * 0.012)
    draw.ellipse(
        (
            BADGE_CX - BADGE_R - halo,
            BADGE_CY - BADGE_R - halo,
            BADGE_CX + BADGE_R + halo,
            BADGE_CY + BADGE_R + halo,
        ),
        fill=WHITE,
    )
    draw.ellipse(
        (
            BADGE_CX - BADGE_R,
            BADGE_CY - BADGE_R,
            BADGE_CX + BADGE_R,
            BADGE_CY + BADGE_R,
        ),
        fill=NAVY,
        outline=TEAL,
        width=int(SIZE * 0.011),
    )

    # Two solid triangles read as a skip symbol even at 16 px.
    top = BADGE_CY - int(BADGE_R * 0.42)
    bottom = BADGE_CY + int(BADGE_R * 0.42)
    first_left = BADGE_CX - int(BADGE_R * 0.40)
    first_right = BADGE_CX - int(BADGE_R * 0.02)
    second_left = BADGE_CX + int(BADGE_R * 0.02)
    second_right = BADGE_CX + int(BADGE_R * 0.40)
    draw.polygon(
        [(first_left, top), (first_left, bottom), (first_right, BADGE_CY)],
        fill=WHITE,
    )
    draw.polygon(
        [(second_left, top), (second_left, bottom), (second_right, BADGE_CY)],
        fill=WHITE,
    )

    return canvas


icon = build_icon()
for size in (16, 32, 48, 96, 128):
    resized = icon.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(OUT / f"icon-{size}.png", optimize=True)

# Preview sheet for manual inspection (not part of the extension).
preview = Image.new("RGBA", (420, 160), (11, 18, 32, 255))
x = 10
for size in (16, 32, 48, 96, 128):
    preview.alpha_composite(icon.resize((size, size), Image.Resampling.LANCZOS), (x, 16 + (128 - size) // 2))
    x += size + 10
preview.save(ROOT / "dist" / "icon-preview.png", optimize=True)

print("Wrote icons to", OUT)

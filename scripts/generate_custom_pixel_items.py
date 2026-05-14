#!/usr/bin/env python3
from pathlib import Path

from PIL import Image, ImageDraw


OUT_DIR = Path(__file__).resolve().parents[1] / "assets" / "item" / "custom"

T = (0, 0, 0, 0)

COLORS = {
    "black": (35, 27, 28, 255),
    "red_dark": (112, 24, 28, 255),
    "red": (196, 35, 39, 255),
    "red_light": (238, 77, 57, 255),
    "red_shadow": (139, 31, 34, 255),
    "white": (255, 232, 184, 255),
    "brown_dark": (83, 48, 26, 255),
    "brown": (133, 78, 38, 255),
    "brown_light": (190, 117, 55, 255),
    "tan": (216, 151, 78, 255),
    "tan_light": (242, 185, 105, 255),
    "yellow_dark": (151, 91, 19, 255),
    "yellow": (224, 151, 35, 255),
    "yellow_light": (255, 203, 66, 255),
    "green_black": (22, 58, 34, 255),
    "green_dark": (38, 91, 42, 255),
    "green": (61, 143, 55, 255),
    "green_light": (108, 181, 70, 255),
    "leaf_dark": (28, 84, 55, 255),
    "leaf": (49, 132, 69, 255),
    "leaf_light": (94, 176, 88, 255),
}


def new_canvas(size):
    return Image.new("RGBA", size, T)


def put(img, x, y, color):
    if 0 <= x < img.width and 0 <= y < img.height:
        img.putpixel((x, y), color)


def rect(draw, xy, color):
    draw.rectangle(xy, fill=color)


def draw_span_rows(img, rows, color):
    for y, spans in rows.items():
        if spans and isinstance(spans[0], int):
            spans = [spans]
        for x0, x1 in spans:
            for x in range(x0, x1 + 1):
                put(img, x, y, color)


def draw_apple():
    img = new_canvas((16, 16))
    draw = ImageDraw.Draw(img)

    outline = {
        4: (5, 10),
        5: (3, 12),
        6: (2, 13),
        7: (2, 13),
        8: (1, 14),
        9: (1, 14),
        10: (2, 13),
        11: (2, 13),
        12: (3, 12),
        13: (5, 10),
    }
    body = {
        5: (5, 10),
        6: (3, 12),
        7: (3, 12),
        8: (2, 13),
        9: (2, 13),
        10: (3, 12),
        11: (3, 12),
        12: (4, 11),
    }
    light = {6: (4, 8), 7: (3, 8), 8: (3, 7), 9: (3, 5)}
    shadow = {8: (11, 13), 9: (10, 13), 10: (9, 12), 11: (8, 11), 12: (8, 10)}

    draw_span_rows(img, outline, COLORS["red_dark"])
    draw_span_rows(img, body, COLORS["red"])
    draw_span_rows(img, light, COLORS["red_light"])
    draw_span_rows(img, shadow, COLORS["red_shadow"])

    rect(draw, (7, 1, 8, 4), COLORS["brown_dark"])
    rect(draw, (8, 1, 8, 3), COLORS["brown"])
    draw.polygon([(9, 2), (13, 1), (14, 2), (12, 4), (9, 4)], fill=COLORS["green_black"])
    draw.polygon([(10, 2), (13, 2), (12, 3), (10, 3)], fill=COLORS["leaf"])
    put(img, 5, 6, COLORS["white"])
    put(img, 4, 7, COLORS["white"])

    return img


def draw_pineapple():
    img = new_canvas((16, 16))
    draw = ImageDraw.Draw(img)

    crown_dark = COLORS["green_black"]
    crown_mid = COLORS["leaf"]
    crown_hi = COLORS["leaf_light"]
    draw.polygon([(7, 0), (8, 0), (8, 5), (6, 5)], fill=crown_dark)
    draw.polygon([(4, 1), (7, 5), (5, 5), (3, 3)], fill=crown_dark)
    draw.polygon([(11, 1), (9, 5), (11, 5), (13, 3)], fill=crown_dark)
    draw.polygon([(6, 2), (8, 5), (6, 5), (4, 4)], fill=crown_mid)
    draw.polygon([(9, 2), (8, 5), (10, 5), (12, 4)], fill=crown_mid)
    draw.polygon([(8, 1), (9, 5), (7, 5)], fill=crown_hi)

    outline = {
        5: (5, 10),
        6: (4, 11),
        7: (3, 12),
        8: (3, 12),
        9: (3, 12),
        10: (3, 12),
        11: (4, 11),
        12: (4, 11),
        13: (5, 10),
        14: (6, 9),
    }
    fill = {
        6: (5, 10),
        7: (4, 11),
        8: (4, 11),
        9: (4, 11),
        10: (4, 11),
        11: (5, 10),
        12: (5, 10),
        13: (6, 9),
    }
    draw_span_rows(img, outline, COLORS["yellow_dark"])
    draw_span_rows(img, fill, COLORS["yellow"])
    draw_span_rows(img, {7: (5, 8), 8: (4, 7), 9: (5, 7), 10: (5, 6)}, COLORS["yellow_light"])

    for x0, y0, x1, y1 in [(5, 6, 11, 12), (4, 8, 9, 13), (8, 6, 12, 10)]:
        draw.line((x0, y0, x1, y1), fill=COLORS["brown_dark"])
    for x0, y0, x1, y1 in [(10, 6, 4, 12), (12, 8, 7, 13), (7, 6, 3, 10)]:
        draw.line((x0, y0, x1, y1), fill=COLORS["tan"])
    for p in [(6, 8), (9, 8), (5, 10), (8, 11), (10, 10), (7, 13)]:
        put(img, *p, COLORS["yellow_light"])

    return img


def draw_apple_tree():
    img = new_canvas((32, 48))
    draw = ImageDraw.Draw(img)

    # Trunk and roots.
    rect(draw, (13, 27, 19, 43), COLORS["brown_dark"])
    rect(draw, (15, 27, 19, 42), COLORS["brown"])
    rect(draw, (17, 28, 18, 40), COLORS["brown_light"])
    draw.polygon([(13, 40), (8, 45), (16, 43)], fill=COLORS["brown_dark"])
    draw.polygon([(19, 40), (24, 45), (16, 43)], fill=COLORS["brown_dark"])

    # Chunky canopy lobes with darker outline and interior leaf clusters.
    canopy_outline = [
        (7, 9, 23, 28),
        (3, 15, 16, 33),
        (15, 14, 29, 34),
        (8, 3, 21, 20),
        (13, 6, 27, 24),
    ]
    for box in canopy_outline:
        draw.ellipse(box, fill=COLORS["green_black"])
    canopy_mid = [
        (8, 10, 22, 27),
        (5, 16, 16, 31),
        (16, 15, 27, 32),
        (9, 5, 20, 19),
        (14, 8, 25, 23),
    ]
    for box in canopy_mid:
        draw.ellipse(box, fill=COLORS["green"])
    for box in [(9, 12, 17, 21), (16, 11, 23, 20), (7, 20, 15, 29), (18, 22, 25, 30)]:
        draw.ellipse(box, fill=COLORS["green_light"])
    for box in [(5, 23, 12, 31), (20, 16, 27, 25), (12, 6, 18, 13)]:
        draw.ellipse(box, fill=COLORS["green_dark"])

    apples = [(11, 14), (19, 13), (8, 22), (15, 23), (23, 24), (18, 30)]
    for x, y in apples:
        rect(draw, (x, y, x + 2, y + 2), COLORS["red_dark"])
        put(img, x + 1, y, COLORS["red_light"])
        put(img, x + 1, y + 1, COLORS["red"])

    # Leaf-edge bite marks and separation pixels keep the canopy from reading as one blob.
    for p in [(4, 18), (6, 13), (25, 12), (28, 20), (3, 25), (26, 31), (10, 4), (21, 7)]:
        put(img, *p, T)
    for p in [(13, 9), (21, 18), (10, 28), (17, 20), (23, 27)]:
        put(img, *p, COLORS["green_black"])

    return img


def draw_pineapple_tree():
    img = new_canvas((32, 48))
    draw = ImageDraw.Draw(img)

    # Slightly curved palm trunk, built from stacked pixel blocks.
    trunk_rows = [
        (15, 16, 22), (15, 16, 23), (14, 17, 24), (14, 17, 25),
        (14, 18, 26), (13, 18, 27), (13, 18, 28), (13, 19, 29),
        (12, 19, 30), (12, 19, 31), (12, 20, 32), (11, 20, 33),
        (11, 20, 34), (11, 21, 35), (10, 21, 36), (10, 21, 37),
        (10, 22, 38), (10, 22, 39), (9, 22, 40), (9, 22, 41),
    ]
    for x0, x1, y in trunk_rows:
        for x in range(x0, x1 + 1):
            put(img, x, y, COLORS["brown_dark"])
        for x in range(x0 + 1, x1 + 1):
            put(img, x, y, COLORS["brown"])
    for y in range(24, 41, 4):
        draw.line((13, y, 18, y + 2), fill=COLORS["tan"])
    draw.polygon([(9, 41), (5, 45), (14, 43)], fill=COLORS["brown_dark"])
    draw.polygon([(21, 41), (26, 45), (14, 43)], fill=COLORS["brown_dark"])

    # Palm fronds radiate from the top; outline underneath, highlight on top.
    fronds = [
        [(16, 18), (5, 7), (2, 10), (11, 19)],
        [(17, 18), (14, 3), (11, 3), (13, 18)],
        [(18, 18), (27, 6), (30, 9), (21, 20)],
        [(16, 20), (3, 18), (2, 22), (15, 23)],
        [(18, 20), (30, 18), (29, 23), (18, 23)],
        [(17, 19), (9, 12), (6, 15), (14, 21)],
        [(18, 19), (24, 13), (27, 15), (20, 22)],
    ]
    for poly in fronds:
        draw.polygon(poly, fill=COLORS["green_black"])
    for poly in [
        [(16, 18), (6, 9), (4, 11), (12, 18)],
        [(17, 17), (15, 4), (13, 5), (14, 18)],
        [(18, 18), (26, 8), (28, 10), (21, 19)],
        [(16, 20), (4, 19), (4, 21), (15, 22)],
        [(18, 20), (28, 19), (27, 21), (18, 22)],
        [(17, 19), (10, 13), (8, 15), (15, 20)],
        [(18, 19), (23, 14), (25, 15), (20, 20)],
    ]:
        draw.polygon(poly, fill=COLORS["leaf"])
    for line in [(7, 10, 15, 18), (15, 5, 17, 18), (26, 9, 18, 18), (5, 20, 16, 21), (27, 20, 18, 21)]:
        draw.line(line, fill=COLORS["leaf_light"])

    # Pineapple fruit tucked just below the frond base.
    fruit_outline = {19: (14, 19), 20: (13, 20), 21: (13, 20), 22: (13, 20), 23: (14, 19), 24: (15, 18)}
    fruit_fill = {20: (14, 19), 21: (14, 19), 22: (14, 19), 23: (15, 18)}
    draw_span_rows(img, fruit_outline, COLORS["yellow_dark"])
    draw_span_rows(img, fruit_fill, COLORS["yellow"])
    draw.line((14, 20, 19, 23), fill=COLORS["brown_dark"])
    draw.line((19, 20, 15, 24), fill=COLORS["tan"])
    put(img, 15, 21, COLORS["yellow_light"])
    put(img, 17, 22, COLORS["yellow_light"])

    return img


def draw_log_wood():
    img = new_canvas((16, 16))
    draw = ImageDraw.Draw(img)

    # Horizontal bark cylinder.
    rect(draw, (3, 5, 12, 11), COLORS["brown_dark"])
    rect(draw, (4, 5, 12, 10), COLORS["brown"])
    rect(draw, (4, 6, 11, 7), COLORS["brown_light"])
    rect(draw, (5, 9, 12, 10), COLORS["brown_dark"])
    for x in [5, 8, 11]:
        draw.line((x, 5, x + 1, 10), fill=COLORS["brown_dark"])
    for p in [(6, 6), (9, 7), (7, 10), (12, 8)]:
        put(img, *p, COLORS["tan"])

    # Round cut end with visible rings.
    draw.ellipse((1, 4, 7, 12), fill=COLORS["brown_dark"])
    draw.ellipse((2, 5, 7, 11), fill=COLORS["tan"])
    draw.ellipse((3, 6, 6, 10), fill=COLORS["brown_light"])
    draw.point([(4, 7), (5, 8), (4, 9)], fill=COLORS["brown_dark"])
    draw.arc((3, 6, 6, 10), 80, 300, fill=COLORS["yellow_dark"])
    put(img, 3, 6, COLORS["tan_light"])
    put(img, 2, 7, COLORS["tan_light"])

    # Dark bottom lip and right rim sell the cylinder shape.
    rect(draw, (8, 11, 12, 12), COLORS["brown_dark"])
    rect(draw, (12, 6, 13, 10), COLORS["brown_dark"])
    put(img, 13, 8, COLORS["brown"])

    return img


def save(name, image):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / name
    image.save(path)
    return path


def main():
    assets = {
        "apple.png": draw_apple(),
        "pineapple.png": draw_pineapple(),
        "tree_apple.png": draw_apple_tree(),
        "tree_pineapple.png": draw_pineapple_tree(),
        "log_wood.png": draw_log_wood(),
    }
    for name, image in assets.items():
        save(name, image)
        print(f"wrote {OUT_DIR / name} {image.size[0]}x{image.size[1]}")


if __name__ == "__main__":
    main()

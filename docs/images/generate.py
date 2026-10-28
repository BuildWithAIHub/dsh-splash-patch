"""Generate the README illustrations for dsh-splash-patch.

Everything here is drawn from scratch: no DSH assets, no screenshots of a real
desktop, no user data. Run:

    python docs/images/generate.py

Outputs into docs/images/: splash.png, splash.gif, flow.png
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = 1600, 900

CJK_FONTS = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\NotoSansCJK-Regular.ttc",
]
MONO_FONTS = [
    r"C:\Windows\Fonts\consola.ttf",
    r"C:\Windows\Fonts\consolab.ttf",
    r"C:\Windows\Fonts\lucon.ttf",
]


def font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default(size)


def mono(size: int) -> ImageFont.FreeTypeFont:
    return font(MONO_FONTS, size)


def cjk(size: int) -> ImageFont.FreeTypeFont:
    return font(CJK_FONTS, size)


def draw_scanlines(img: Image.Image, step: int = 3, alpha: int = 26) -> None:
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for y in range(0, img.size[1], step):
        draw.line([(0, y), (img.size[0], y)], fill=(255, 255, 255, alpha))
    img.alpha_composite(overlay)


def draw_grid(img: Image.Image, step: int = 64, color=(255, 255, 255, 14)) -> None:
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    for x in range(0, img.size[0], step):
        draw.line([(x, 0), (x, img.size[1])], fill=color)
    for y in range(0, img.size[1], step):
        draw.line([(0, y), (img.size[0], y)], fill=color)
    img.alpha_composite(overlay)


def arc(draw: ImageDraw.ImageDraw, cx: int, cy: int, radius: int, start: int, end: int, width: int, fill) -> None:
    draw.arc([cx - radius, cy - radius, cx + radius, cy + radius], start=start, end=end, fill=fill, width=width)


def splash_frame(width: int, height: int, progress: float, label: str = "LOADING WORKSPACE") -> Image.Image:
    img = Image.new("RGBA", (width, height), (5, 6, 8, 255))
    draw = ImageDraw.Draw(img)
    draw_grid(img, step=72)
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    cx, cy = int(width * 0.80), int(height * 0.34)
    for radius, start, end, wide in (
        (int(height * 0.42), 150, 330, 3),
        (int(height * 0.52), 170, 300, 2),
        (int(height * 0.30), 120, 250, 2),
    ):
        arc(ld, cx, cy, radius, start, end, wide, (255, 122, 26, 150))
    for i in range(18):
        angle = math.radians(200 + i * 3.2)
        r0 = int(height * 0.40)
        r1 = r0 + (12 if i % 3 else 24)
        x0, y0 = cx + math.cos(angle) * r0, cy + math.sin(angle) * r0
        x1, y1 = cx + math.cos(angle) * r1, cy + math.sin(angle) * r1
        ld.line([(x0, y0), (x1, y1)], fill=(255, 122, 26, 120), width=1)
    img.alpha_composite(layer)

    pad = int(width * 0.045)
    draw.text((pad, int(height * 0.055)), "DSH // SPLASH", font=mono(int(height * 0.026)), fill=(255, 122, 26, 240))
    draw.text((int(width * 0.36), int(height * 0.055)), "BOOT SEQUENCE", font=mono(int(height * 0.020)), fill=(232, 236, 240, 160))
    right = "SYSTEM READY"
    font_r = mono(int(height * 0.020))
    draw.text((width - pad - draw.textlength(right, font=font_r), int(height * 0.055)), right, font=font_r, fill=(232, 236, 240, 160))

    left = int(width * 0.09)
    y = int(height * 0.34)
    draw.text((left, y), "DEEPSEEK HARNESS", font=mono(int(height * 0.085)), fill=(244, 248, 252, 255))
    y += int(height * 0.115)
    draw.text((left, y), "SPLASH PATCH // STARTUP", font=mono(int(height * 0.033)), fill=(255, 122, 26, 240))
    y += int(height * 0.065)
    draw.line([(left, y), (left + int(width * 0.30), y)], fill=(255, 122, 26, 220), width=2)
    y += int(height * 0.045)
    draw.text((left, y), "The workspace is loading behind this clip.", font=mono(int(height * 0.026)), fill=(232, 236, 240, 185))
    y += int(height * 0.05)
    draw.text((left, y), label, font=mono(int(height * 0.024)), fill=(232, 236, 240, 160))

    bar_x = left
    bar_y = int(height * 0.815)
    bar_w = int(width * 0.26)
    draw.rectangle([bar_x, bar_y, bar_x + bar_w, bar_y + 4], fill=(255, 255, 255, 30))
    draw.rectangle([bar_x, bar_y, bar_x + int(bar_w * max(0.02, min(1.0, progress))), bar_y + 4], fill=(255, 122, 26, 245))
    draw.text((bar_x + bar_w + int(width * 0.02), bar_y - int(height * 0.012)),
              f"{int(progress * 100):02d}%", font=mono(int(height * 0.022)), fill=(232, 236, 240, 180))

    c = int(width * 0.045)
    m = int(width * 0.02)
    for (x, y0, dx, dy) in (
        (m, int(height * 0.045), 1, 1),
        (width - m, int(height * 0.045), -1, 1),
        (m, height - int(height * 0.045), 1, -1),
        (width - m, height - int(height * 0.045), -1, -1),
    ):
        draw.line([(x, y0), (x + dx * c, y0)], fill=(255, 122, 26, 200), width=3)
        draw.line([(x, y0), (x, y0 + dy * c)], fill=(255, 122, 26, 200), width=3)

    note = "generated illustration"
    draw.text((width - pad - draw.textlength(note, font=mono(int(height * 0.018))), height - int(height * 0.05)),
              note, font=mono(int(height * 0.018)), fill=(255, 255, 255, 70))

    draw_scanlines(img)
    # Soft vignette that keeps the centre at full brightness.
    vign = Image.new("L", (width, height), 0)
    vd = ImageDraw.Draw(vign)
    vd.ellipse([-int(width * 0.30), -int(height * 0.30), int(width * 1.30), int(height * 1.30)], fill=255)
    vign = vign.filter(ImageFilter.GaussianBlur(int(width * 0.07)))
    black = Image.new("RGBA", (width, height), (0, 0, 0, 255))
    img = Image.composite(img, black, vign)
    return img.convert("RGB")


def arrow(draw: ImageDraw.ImageDraw, x0: int, y0: int, x1: int, y1: int, color, width: int = 3) -> None:
    draw.line([(x0, y0), (x1, y1)], fill=color, width=width)
    size = 10 + width * 2
    angle = math.atan2(y1 - y0, x1 - x0)
    for delta in (math.radians(28), -math.radians(28)):
        xa = x1 - size * math.cos(angle + delta)
        ya = y1 - size * math.sin(angle + delta)
        draw.line([(x1, y1), (xa, ya)], fill=color, width=width)


def flow_chart() -> Image.Image:
    width, height = 1600, 760
    img = Image.new("RGBA", (width, height), (13, 17, 23, 255))
    draw = ImageDraw.Draw(img)
    draw_grid(img, step=64, color=(255, 255, 255, 10))

    title_font = mono(40)
    sub_font = mono(22)
    box_title = mono(26)
    box_text = mono(20)
    cjk_font = cjk(20)
    orange = (255, 122, 26)
    grey = (139, 148, 158)
    white = (230, 237, 243)

    draw.text((70, 46), "HOW THE SPLASH STARTUP WORKS", font=title_font, fill=white)
    draw.text((70, 100), "启动流程示意（示意图，不是截图）", font=cjk_font, fill=grey)

    boxes = [
        {"x": 70, "y": 220, "w": 260, "h": 130, "title": "Shortcut",
         "lines": ["desktop / start menu"]},
        {"x": 400, "y": 220, "w": 300, "h": 130, "title": "Launcher",
         "lines": ["repair patch if needed", "then start DSH"]},
        {"x": 770, "y": 140, "w": 340, "h": 130, "title": "Splash window",
         "lines": ["fullscreen clip plays"]},
        {"x": 770, "y": 320, "w": 340, "h": 130, "title": "Hidden main window",
         "lines": ["DSH loads in parallel"]},
        {"x": 1180, "y": 230, "w": 340, "h": 130, "title": "Workspace",
         "lines": ["shown when the clip ends", "or the user presses Esc"]},
    ]
    for box in boxes:
        x, y, w, h = box["x"], box["y"], box["w"], box["h"]
        draw.rounded_rectangle([x, y, x + w, y + h], radius=14, outline=(48, 54, 61), width=2, fill=(22, 27, 34))
        draw.text((x + 18, y + 16), box["title"], font=box_title, fill=orange)
        for index, line in enumerate(box["lines"]):
            draw.text((x + 18, y + 58 + index * 28), line, font=box_text, fill=white)

    arrow(draw, 330, 285, 400, 285, orange)
    arrow(draw, 700, 285, 745, 230, orange)
    draw.line([(745, 230), (770, 230)], fill=orange, width=3)
    arrow(draw, 700, 285, 745, 360, orange)
    draw.line([(745, 360), (770, 360)], fill=orange, width=3)
    arrow(draw, 1110, 205, 1180, 270, orange)
    arrow(draw, 1110, 385, 1180, 320, orange)

    draw.text((70, 600), "1  start   ->   2  repair   ->   3  clip plays while the app boots   ->   4  seamless entry",
              font=sub_font, fill=grey)
    draw.text((70, 650), "No network access. Nothing leaves your machine.", font=sub_font, fill=orange)
    return img.convert("RGB")


def main() -> None:
    splash = splash_frame(W, H, progress=0.62)
    splash.save(os.path.join(HERE, "splash.png"), optimize=True)

    frames = []
    small_w, small_h = 800, 450
    for i in range(10):
        alpha = (i + 1) / 10
        base = splash_frame(small_w, small_h, progress=0.10 + 0.02 * i)
        black = Image.new("RGB", (small_w, small_h), (0, 0, 0))
        frames.append(Image.blend(black, base, alpha))
    for i in range(14):
        frames.append(splash_frame(small_w, small_h, progress=0.30 + 0.05 * i))
    frames[0].save(
        os.path.join(HERE, "splash.gif"),
        save_all=True,
        append_images=frames[1:],
        duration=120,
        loop=0,
        optimize=True,
    )

    flow = flow_chart()
    flow.save(os.path.join(HERE, "flow.png"), optimize=True)
    print("wrote splash.png, splash.gif, flow.png into", HERE)


if __name__ == "__main__":
    main()

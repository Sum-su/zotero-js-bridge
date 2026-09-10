#!/usr/bin/env python3
"""生成 Zotero JS Bridge 的图标。

输出到 addon/icons/：
    favicon.png       96×96
    favicon@0.5x.png  48×48

图标不是二进制素材，是画出来的：先用 SS 倍超采样，再 LANCZOS 缩下去，
边缘才干净。改配色改构图直接改这个脚本重跑。

    python make_icon.py              # 按默认方案写出两个 PNG
    python make_icon.py --preview    # 各方案对比图，不动文件
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "addon", "icons")
SS = 4                      # 超采样倍数

# Zotero 的红 + 一个暖金点缀，色相拉开，缩到 16px 也不糊
RED_HI = (198, 40, 46)
RED_LO = (122, 14, 22)
GOLD_HI = (255, 208, 96)
GOLD_LO = (238, 158, 28)
WHITE = (255, 255, 255)

# 花括号必须用字体画（手搓的笔画小尺寸下全是断笔）。
# 各平台常见粗体依次找，找不到就退回 Pillow 内置位图字体。
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\seguisb.ttf",
    r"C:\Windows\Fonts\segoeuib.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]


def find_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    raise SystemExit(
        "找不到可用的粗体字体，花括号画不出来。\n"
        "装一个（如 fonts-dejavu / fonts-liberation），或把路径加进 FONT_CANDIDATES。"
    )


def gradient(size, hi, lo):
    """竖直线性渐变。"""
    g = Image.new("RGB", (1, size), hi)
    px = g.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(hi[i] + (lo[i] - hi[i]) * t) for i in range(3))
    return g.resize((size, size), Image.BILINEAR)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1],
                                        radius=radius, fill=255)
    return m


def make_base(size):
    """圆角红底 + 顶部一道很淡的高光。"""
    bg = gradient(size, RED_HI, RED_LO).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), rounded_mask(size, int(size * 0.22)))

    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hl).rounded_rectangle(
        [int(size * 0.05), int(size * 0.035), int(size * 0.95), int(size * 0.52)],
        radius=int(size * 0.19), fill=(255, 255, 255, 24))
    return Image.alpha_composite(canvas, hl)


def draw_braces(canvas):
    """{ } 夹一根金色连线 —— 读作「JS 与 Zotero 之间有通道」。

    花括号用字体画。手搓的笔画在小尺寸下全是断笔，不值当。
    """
    S = canvas.size[0]
    d = ImageDraw.Draw(canvas)

    font = find_font(int(S * 0.62))
    for ch, cx in (("{", S * 0.27), ("}", S * 0.73)):
        # anchor="mm" 按字形包围盒居中，比按基线摆靠谱
        d.text((cx, S * 0.50), ch, font=font, fill=WHITE, anchor="mm")

    cy = S * 0.50
    x0, x1 = S * 0.40, S * 0.60
    d.line([(x0, cy), (x1, cy)], fill=GOLD_HI, width=int(S * 0.048))
    r = S * 0.056
    d.ellipse([S * 0.5 - r, cy - r, S * 0.5 + r, cy + r], fill=GOLD_LO)
    d.ellipse([S * 0.5 - r * 0.45, cy - r * 0.45, S * 0.5 + r * 0.45,
               cy + r * 0.45], fill=GOLD_HI)
    return canvas


def draw_bridge(canvas):
    """单孔拱桥：一道半圆拱 + 桥面 + 三颗金色数据点。

    只要一个形状就够认了 —— 塔柱、吊索那些在小尺寸下全是噪点。
    """
    S = canvas.size[0]
    d = ImageDraw.Draw(canvas)

    deck_y = S * 0.70
    span = S * 0.62
    x0, x1 = S * 0.5 - span / 2, S * 0.5 + span / 2
    thick = int(S * 0.058)

    # 桥面
    d.line([(x0 - S * 0.045, deck_y), (x1 + S * 0.045, deck_y)],
           fill=WHITE, width=thick)
    # 半圆拱，两端正好落在桥面上
    d.arc([x0, deck_y - span / 2, x1, deck_y + span / 2],
          start=180, end=360, fill=WHITE, width=thick)

    # 桥面下的金色数据点
    for t in (0.30, 0.50, 0.70):
        x = (x0 - S * 0.045) + (x1 - x0 + S * 0.09) * t
        r = S * 0.031
        d.ellipse([x - r, deck_y + thick * 1.1 - r,
                   x + r, deck_y + thick * 1.1 + r], fill=GOLD_HI)
    return canvas


VARIANTS = {"braces": draw_braces, "bridge": draw_bridge}


def render(kind, size):
    return VARIANTS[kind](make_base(size * SS)).resize((size, size),
                                                       Image.LANCZOS)


def main():
    import argparse

    ap = argparse.ArgumentParser(description="生成插件图标")
    ap.add_argument("--variant", default="braces", choices=sorted(VARIANTS))
    ap.add_argument("--preview", action="store_true", help="只出对比图，不写字形文件")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    if args.preview:
        sheet = Image.new("RGBA", (512 * 3, 512 * 2), (245, 245, 247, 255))
        for row, kind in enumerate(sorted(VARIANTS)):
            for col, size in enumerate((256, 96, 48)):
                im = render(kind, size)
                cell = Image.new("RGBA", (512, 512), (245, 245, 247, 255))
                cell.paste(im, ((512 - size) // 2, (512 - size) // 2), im)
                sheet.paste(cell, (col * 512, row * 512))
        sheet.resize((1152, 768), Image.LANCZOS).save(
            os.path.join(OUT_DIR, "_preview.png"))
        print("预览:", os.path.join(OUT_DIR, "_preview.png"))
        return

    # 目录里只留这两个，别把预览图打包进 xpi
    for junk in os.listdir(OUT_DIR):
        if junk.startswith("_preview"):
            os.remove(os.path.join(OUT_DIR, junk))

    for size, name in ((96, "favicon.png"), (48, "favicon@0.5x.png")):
        p = os.path.join(OUT_DIR, name)
        render(args.variant, size).save(p)
        print(f"{name:20s} {size}×{size}  {os.path.getsize(p)} bytes")


if __name__ == "__main__":
    main()

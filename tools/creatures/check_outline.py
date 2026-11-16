#!/usr/bin/env python3
"""Verify the outline landed, and preview creatures over the REAL tank.

The contact sheet drops alpha, so an outline is invisible on it. This
composites the actual atlas frames over the same background the PSP scene
uses (water gradient + colourful rocks) so contrast can be judged honestly.
"""
import sys
sys.path.insert(0, "/home/alpha/Development/psp-buddy/tools/creatures")
from PIL import Image, ImageDraw

SRC = "/home/alpha/Development/psp-buddy/src"
OUT = "/home/alpha/Development/psp-buddy/build/creature-preview"

# --- 1. does the outline exist? ---
a = Image.open(f"{SRC}/fish.png").convert("RGBA")
px = a.load()
w, h = a.size
opaque = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 128)
dark_opaque = sum(1 for y in range(h) for x in range(w)
                  if px[x, y][3] > 128 and max(px[x, y][:3]) < 40)
print(f"fish.png {w}x{h}: {opaque} opaque px, {dark_opaque} near-black px "
      f"({100*dark_opaque/max(1,opaque):.1f}% of body)")

# --- 2. composite over the real tank background ---
TANK_W, TANK_H = 456, 196
FLOOR_H = 30
CREATURE = 52

bg = Image.new("RGB", (TANK_W, TANK_H), (4, 10, 22))
d = ImageDraw.Draw(bg)
for y in range(TANK_H):
    t = y / max(1, TANK_H - 1)
    bg.paste((int(14 + (4 - 14) * t), int(32 + (10 - 32) * t), int(56 + (22 - 56) * t)),
             (0, y, TANK_W, y + 1))
rocks = [(18, 46, 22, "#7c3aed"), (70, 34, 16, "#0ea5e9"), (128, 52, 26, "#e11d48"),
         (196, 38, 18, "#f59e0b"), (258, 56, 24, "#10b981"), (330, 40, 20, "#6366f1"),
         (392, 48, 22, "#ec4899")]
for l, rw, rh, col in rocks:
    d.rounded_rectangle([l, TANK_H - FLOOR_H - rh + 6, l + rw, TANK_H - FLOOR_H + 14],
                        radius=8, fill=col)
d.rectangle([0, TANK_H - FLOOR_H, TANK_W, TANK_H], fill=(27, 36, 54))

names = ["fish", "jellyfish", "butterfly", "crab"]
sheet = Image.new("RGB", (TANK_W * len(names), TANK_H), (0, 0, 0))
for i, n in enumerate(names):
    at = Image.open(f"{SRC}/{n}.png").convert("RGBA")
    cell = at.size[0] // 4
    frame = at.crop((0, 0, cell, cell)).resize((CREATURE, CREATURE), Image.LANCZOS)
    tile = bg.copy()
    # place the creature in the water, above the sand
    tile.paste(frame, (60, TANK_H - FLOOR_H - CREATURE - 30), frame)
    sheet.paste(tile, (TANK_W * i, 0))
sheet.save(f"{OUT}/on-background.png")
print(f"wrote {OUT}/on-background.png  ({sheet.size[0]}x{sheet.size[1]})")

#!/usr/bin/env python3
"""
Procedural creature generator for the PSP Token Aquarium.

Everything is generated from maths -- no reference artwork is extracted, so
there is nothing to hand-edit and every asset is reproducible from source.

Design notes (why it looks the way it does):

  * FILLED, not outlined. A jellyfish is a filled bell plus filled
    tentacles. The silhouette is rendered as a mask, then a FIXED jittered
    lattice of dots is sampled against that mask. Only lit lattice points
    are drawn, so the texture covers the whole body instead of tracing an
    outline (which reads as wireframe).

  * CONSISTENT TEXTURE BETWEEN FRAMES. The lattice is fixed in cell space
    and reused for every frame; only the silhouette moves. So a dot keeps
    its identity as the body deforms, instead of the whole stipple
    re-randomising each frame and flickering.

  * SEAMLESS LOOP BY CONSTRUCTION. Every motion term is a sinusoid of
    period 1.0 in the frame phase, so frame 0 and frame N are identical.
    Nothing is sampled from a finite sequence that cannot wrap.

  * SUBTLE RGB FRINGES, not saturated primary outlines. Dots are painted
    in a pale, slightly-hued colour; the tracer then offsets the R/G/B
    planes by a pixel or two, so the colour separation is a fringe at the
    edges rather than a hard three-colour graphic.

Usage
-----
    python3 tools/creatures/generate.py --all
    python3 tools/creatures/generate.py --creature jellyfish --preview

Writes PNG atlases into src/ and updates src/sprites.json.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter

# --------------------------------------------------------------------------
# Palette + effect chain
#
# 16-entry RGB-primary palette. Kept deliberately small: the PSP screen is
# 480x272 and a big palette both costs texture memory and looks muddy.
# --------------------------------------------------------------------------

PALETTE = [
    (0, 0, 0),        # 0  void
    (85, 0, 0),       # 1
    (170, 0, 0),      # 2
    (255, 0, 0),      # 3  red bright
    (0, 85, 0),       # 4
    (0, 170, 0),      # 5
    (0, 255, 0),      # 6  green bright
    (0, 0, 85),       # 7
    (0, 0, 170),      # 8
    (0, 0, 255),      # 9  blue bright
    (255, 255, 0),    # 10 yellow
    (255, 0, 255),    # 11 magenta
    (0, 255, 255),    # 12 cyan
    (255, 255, 255),  # 13 white
    (128, 128, 128),  # 14 grey
    (48, 48, 48),     # 15 dark grey
]

SUPERSAMPLE = 4       # silhouette mask rendered at 4x then downsampled
LATTICE_STEP = 1.85  # px between candidate stipple dots (in cell space)
DOT_RADIUS = 1.05    # px

# Outline width, in ATLAS pixels (the cell is 128px but is drawn on the PSP
# at ~52px, so 3 atlas px is ~1.2 screen px of hard contour).
#
# Why an outline at all: a stipple body on a busy background (water gradient
# + colourful rocks) has no defined edge, so the creature dissolves into the
# scenery. A dark contour that sits OUTSIDE the silhouette restores a clean
# read without touching the stipple texture.
OUTLINE_PX = 0
OUTLINE_COLOR = (0, 0, 0)   # palette entry 0 -- maximum separation

# A bright RIM is drawn just INSIDE the silhouette, on the body's own edge.
#
# The earlier attempt used a black contour OUTSIDE the silhouette, which
# helped the body read against the background but made the thin parts --
# tentacles, legs, antennae -- disappear: a 2px black band around a 2px
# tentacle swallows it entirely when the atlas is downscaled onto the
# screen.
#
# A light rim inside the edge does the opposite: it brightens the very
# features that are hardest to see, so a tentacle gains a highlighted edge
# instead of losing its body.
#
# ONE pixel only. These creatures have features just 2-3px wide in cell
# space, so even a 2px rim inside the edge consumed the whole tentacle and
# left a white blob. At 1px the rim highlights the edge without eating
# the feature.
RIM_PX = 1
RIM_COLOR = (255, 255, 255)   # palette entry 13 -- white


def posterize(img: Image.Image, levels: int = 4) -> Image.Image:
    """Quantise each channel to N levels, keeping several shades per channel."""
    step = 255 // max(1, levels - 1)
    out = img.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y][:3]
            px[x, y] = (
                min(255, (r * (levels - 1) // 255) * step),
                min(255, (g * (levels - 1) // 255) * step),
                min(255, (b * (levels - 1) // 255) * step),
            ) + tuple(px[x, y][3:])
    return out


def tracer(img: Image.Image, offset: int = 2) -> Image.Image:
    """Chromatic aberration: shift R one way and B the other, keep G centred.

    This is what turns a pale stipple into the obtainer look: the colour
    separation lives in the FRINGE at the edge of each shape rather than in
    the body of the shape.
    """
    w, h = img.size
    r, g, b, a = img.split()

    def ghost(channel: Image.Image, dx: int, dy: int) -> Image.Image:
        s = Image.new("L", (w, h), 0)
        s.paste(channel, (dx, dy))
        return s

    out = Image.merge("RGBA", (
        ghost(r, offset, offset),
        g,
        ghost(b, -offset, -offset),
        a,
    ))
    return out


def quantize_rgb(img: Image.Image, alpha: Image.Image) -> Image.Image:
    """Map RGB to the fixed palette while preserving a separate alpha ramp.

    The cooker rejects palette-indexed PNGs, so the result is written as
    8-bit RGBA: palette colour in RGB, the stipple's own coverage in A.
    """
    w, h = img.size
    px = img.load()
    apx = alpha.load()
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            av = apx[x, y]
            if av <= 4:
                continue
            r, g, b = px[x, y][:3]
            best, best_d = 0, None
            for i, (pr, pg, pb) in enumerate(PALETTE):
                d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
                if best_d is None or d < best_d:
                    best_d, best = d, i
            pr, pg, pb = PALETTE[best]
            opx[x, y] = (pr, pg, pb, av)
    return out


# --------------------------------------------------------------------------
# Lattice
# --------------------------------------------------------------------------

def make_lattice(cell: int, step: float = LATTICE_STEP, seed: int = 7):
    """Fixed jittered lattice of candidate dot centres, in cell space.

    Fixed (not per-frame) so the stipple texture is stable as the creature
    deforms. That stability is what stops the animation flickering.
    """
    import random
    rng = random.Random(seed)
    pts = []
    y = step * 0.5
    row = 0
    while y < cell:
        # stagger alternate rows so the lattice has no visible grid
        x = step * 0.5 + (step * 0.5 if row % 2 else 0.0)
        while x < cell:
            pts.append((
                x + rng.uniform(-step * 0.32, step * 0.32),
                y + rng.uniform(-step * 0.32, step * 0.32),
            ))
            x += step
        y += step * 0.86
        row += 1
    return pts


# --------------------------------------------------------------------------
# Silhouettes -- each returns a list of filled shapes in cell space
# --------------------------------------------------------------------------

def _jellyfish_shapes(cell: int, phase: float, dormant: bool = False):
    """Jellyfish: a pulsing bell with trailing tentacles.

    The bell contracts (narrows, elongates) then relaxes, and the
    tentacles LAG behind the bell -- that lag is what makes it read as
    living rather than as a rigid shape being scaled.

    phase is in [0,1) and every term is a period-1.0 sinusoid, so the
    animation wraps exactly.
    """
    cx = cell * 0.5
    two_pi = 2.0 * math.pi

    # bell pulse: contract then relax
    pulse = math.sin(two_pi * phase)
    # bell rim trails the bell itself
    rim_pulse = math.sin(two_pi * phase - 0.9)

    if dormant:
        bell_w = cell * 0.26
        bell_h = cell * 0.12
        droop = 1.0
    else:
        bell_w = cell * (0.27 + 0.045 * pulse)
        bell_h = cell * (0.235 - 0.030 * pulse)
        droop = 0.55 + 0.45 * (0.5 - 0.5 * rim_pulse)

    bell_top = cell * 0.10
    rim_y = bell_top + bell_h

    shapes = []

    # --- bell: dome + rim ---
    bell = []
    steps = 44
    # --- dome: peaks at the CENTRE, edges lower. A jellyfish bell is an
    # umbrella cap, not a bowl: the top of the dome is the highest point.
    for i in range(steps + 1):
        t = i / steps                      # 0 = left rim, 1 = right rim
        x = cx - bell_w + 2.0 * bell_w * t
        # flat-ish top with rounded shoulders
        dome = math.sin(math.pi * t) ** 0.62
        y = bell_top + bell_h * (1.0 - dome)
        bell.append((x, y))
    # --- rim: back across the bottom, bowing DOWN in the middle (the
    # scalloped underside of a bell). Contracting pulls the rim in.
    for i in range(steps + 1):
        t = 1.0 - i / steps
        x = cx - bell_w + 2.0 * bell_w * t
        sag = math.sin(math.pi * t) * bell_h * 0.30 * (0.55 + 0.45 * pulse)
        y = bell_top + bell_h + sag
        bell.append((x, y))
    shapes.append(bell)

    # --- tentacles ---
    n_tent = 9
    for k in range(n_tent):
        # spread across the rim, with a couple of short inner ones
        t = (k + 0.5) / n_tent
        root_x = cx - bell_w + 2.0 * bell_w * t
        # outer tentacles are longer
        rel = abs(t - 0.5) * 2.0
        length = cell * (0.40 - 0.10 * rel) * droop
        if k % 3 == 1:
            length *= 0.62              # shorter inner strands
        segs = 18
        pts = []
        # travelling wave down the strand; its phase also lags the bell
        wave_amp = cell * 0.045 * (0.4 + 0.6 * rel)
        for i in range(segs + 1):
            u = i / segs
            y = rim_y + length * u
            # amplitude grows toward the tip (free end swings more)
            swing = wave_amp * (0.25 + 0.75 * u)
            # the strand curves OUTWARD then trails back in, so the tips
            # do not all hang as a flat fringe
            spread = cell * 0.055 * rel * math.sin(math.pi * u * 0.85)
            x = (root_x + spread
                 + swing * math.sin(two_pi * (phase - 0.55 * u) + k * 0.8))
            pts.append((x, y))
        width = max(1.0, cell * (0.030 - 0.008 * (k % 3 == 1)))
        shapes.append(("ribbon", pts, width))

    # --- oral arms: four shorter frilly strands under the centre ---
    for k in range(4):
        t = (k + 0.5) / 4.0
        root_x = cx + (t - 0.5) * bell_w * 0.85
        length = cell * 0.20 * droop
        segs = 12
        pts = []
        for i in range(segs + 1):
            u = i / segs
            y = rim_y + length * u
            swing = cell * 0.028 * (0.2 + 0.8 * u)
            x = root_x + swing * math.sin(two_pi * (phase - 0.4 * u) + k * 1.7)
            pts.append((x, y))
        shapes.append(("ribbon", pts, max(1.0, cell * 0.038)))

    return shapes


def _fish_shapes(cell: int, phase: float, dormant: bool = False):
    """Fish: a body that undulates, with a swishing tail."""
    cx = cell * 0.5
    cy = cell * 0.5
    two_pi = 2.0 * math.pi
    body_l = cell * 0.34
    body_h = cell * 0.115

    # travelling wave along the body
    def wave(u):
        return math.sin(two_pi * (phase - 0.85 * u)) * body_h * 0.55 * u

    top = []
    bottom = []
    steps = 30
    for i in range(steps + 1):
        u = i / steps                     # 0 = nose, 1 = tail root
        x = cx - body_l + 2.0 * body_l * u
        w = body_h * math.sin(math.pi * (0.18 + 0.82 * u)) ** 0.75
        y0 = cy + wave(u)
        top.append((x, y0 - w))
        bottom.append((x, y0 + w))
    shapes = [top + list(reversed(bottom))]

    # tail fin
    tail = []
    tx = cx + body_l
    ty = cy + wave(1.0)
    for i in range(steps + 1):
        u = i / steps
        y = ty - cell * 0.115 * u
        x = tx + cell * 0.10 * math.sin(math.pi * u) + wave(1.0) * 0.4
        tail.append((x, y))
    for i in range(steps + 1):
        u = 1.0 - i / steps
        y = ty + cell * 0.115 * u
        x = tx + cell * 0.10 * math.sin(math.pi * u) + wave(1.0) * 0.4
        tail.append((x, y))
    shapes.append(tail)

    # dorsal + pectoral fins
    dorsal = []
    for i in range(steps + 1):
        u = i / steps
        x = cx - body_l * 0.25 + body_l * 0.55 * u
        y = cy + wave(u) - body_h * 0.85 - cell * 0.055 * math.sin(math.pi * u)
        dorsal.append((x, y))
    shapes.append(dorsal)

    fin = []
    for i in range(steps + 1):
        u = i / steps
        x = cx - body_l * 0.05 + cell * 0.10 * u
        y = cy + wave(u) + body_h * 0.55 + cell * 0.045 * math.sin(math.pi * u)
        fin.append((x, y))
    shapes.append(fin)

    return shapes


def _butterfly_shapes(cell: int, phase: float, dormant: bool = False):
    """Butterfly: broad wings that beat up and down, foreshortening as they lift.

    A butterfly's wings are broad PLATES, not thin lines, so an in-plane
    swing reads as a wingbeat (a thin line swinging about the body reads as
    a windshield wiper instead). Each wing has its own spine angle that
    sweeps through the beat, and the plate narrows as it lifts -- so the
    wing tips travel an arc AND the wing foreshortens, which is what makes
    the motion read as 3D.
    """
    cx = cell * 0.5
    cy = cell * 0.52
    two_pi = 2.0 * math.pi

    # beat: the wings sweep up and back down
    beat = math.sin(two_pi * phase)
    # separate, slightly-lagged term for the upper vs lower wing so the
    # pair does not move as one rigid board
    beat2 = math.sin(two_pi * phase - 0.55)

    if dormant:
        lift, drop = 0.34, 0.34
        width_scale = 0.9
    else:
        lift = 0.70 + 0.40 * beat        # upper wing angle above horizontal
        drop = 0.40 + 0.26 * beat2       # lower wing trails the upper
        width_scale = 1.0

    shapes = []

    def wing(side: int, angle: float, span_len: float, chord: float,
             tip_bias: float):
        """One wing: a broad rounded plate on a spine at `angle`."""
        pts = []
        steps = 26
        # trailing edge (behind the spine): narrow at the body, wide at
        # mid-span, tapering to a rounded tip
        for i in range(steps + 1):
            u = i / steps
            hw = chord * (math.sin(math.pi * (u ** 0.62)) ** 0.7)
            pts.append((u * span_len, hw))
        # leading edge (in front of the spine), back to the body
        for i in range(steps + 1):
            u = 1.0 - i / steps
            hw = chord * (math.sin(math.pi * (u ** 0.62)) ** 0.7) * 0.62
            pts.append((u * span_len, -hw))
        ca, sa = math.cos(angle), math.sin(angle)
        out = []
        for lx, ly in pts:
            # foreshorten the plate as it lifts: the chord narrows
            ly *= width_scale * (1.0 - 0.28 * max(0.0, math.sin(angle)))
            x = cx + side * (lx * ca - ly * sa)
            y = cy + (lx * sa + ly * ca)
            out.append((x, y))
        return out

    # upper wings: the big pair, swept up and out
    for side in (-1, 1):
        shapes.append(wing(side, lift, cell * 0.33, cell * 0.115, 1.0))
    # lower wings: smaller, below and out, lagging the upper pair
    for side in (-1, 1):
        shapes.append(wing(side, -drop, cell * 0.22, cell * 0.080, 0.25))

    # body: head, thorax, abdomen, tapering
    body = []
    for i in range(25):
        u = i / 24
        y = cy - cell * 0.115 + cell * 0.245 * u
        w = cell * 0.020 * (1.0 - 0.62 * u)
        body.append((cx + w, y))
    shapes.append(("ribbon", body, cell * 0.030))

    # antennae
    for side in (-1, 1):
        ant = []
        for i in range(9):
            u = i / 8
            ant.append((cx + side * cell * 0.022 * u * u,
                        cy - cell * 0.115 - cell * 0.065 * u))
        shapes.append(("ribbon", ant, cell * 0.020))

    return shapes


def _crab_shapes(cell: int, phase: float, dormant: bool = False):
    """Crab: a domed shell on splayed legs, with two raised claws.

    The legs must read as SEPARATE appendages, so they start below the
    shell's widest point and splay outward and downward, clear of the
    shell silhouette.
    """
    cx = cell * 0.5
    two_pi = 2.0 * math.pi

    bob = cell * 0.012 * math.sin(two_pi * phase)
    shell_cy = cell * 0.44 + bob
    w = cell * 0.20
    h = cell * 0.135

    shapes = []

    # --- shell: a domed carapace (proper ellipse arc) ---
    shell = []
    steps = 30
    for i in range(steps + 1):
        t = i / steps
        ang = math.pi * t
        shell.append((cx - math.cos(ang) * w,
                      shell_cy - math.sin(ang) * h))
    # flat-ish underside back across
    for i in range(steps + 1):
        t = 1.0 - i / steps
        ang = math.pi * t
        shell.append((cx - math.cos(ang) * w,
                      shell_cy + math.sin(ang) * h * 0.34))
    shapes.append(shell)

    # --- legs: 3 per side, splayed out and down, each pair offset in time ---
    for side in (-1, 1):
        for k in range(3):
            leg_phase = two_pi * (phase + (0.5 if k % 2 else 0.0))
            # the front leg starts nearest the claw, the back leg furthest
            root_x = cx + side * w * (0.30 + 0.28 * k)
            root_y = shell_cy + h * 0.12
            reach = cell * (0.115 + 0.022 * k)
            drop = cell * (0.085 + 0.020 * k)
            pts = []
            for i in range(13):
                u = i / 12
                # knee: out and slightly up, then down to the tip
                x = root_x + side * reach * u
                y = root_y + drop * (u ** 1.7) \
                    - cell * 0.022 * math.sin(math.pi * u) \
                    + cell * 0.010 * math.sin(leg_phase) * u
                pts.append((x, y))
            shapes.append(("ribbon", pts, cell * 0.028))

    # --- eye stalks ---
    for side in (-1, 1):
        ex = cx + side * cell * 0.045
        stalk = []
        for i in range(9):
            u = i / 8
            stalk.append((ex + side * cell * 0.010 * u,
                          shell_cy - h * 0.62 - cell * 0.048 * u + bob))
        shapes.append(("ribbon", stalk, cell * 0.024))

    # --- claws: on arms, raised in front of the shell ---
    for side in (-1, 1):
        ax = cx + side * w * 0.80
        ay = shell_cy + h * 0.05
        arm = []
        for i in range(11):
            u = i / 10
            arm.append((ax + side * cell * 0.075 * u,
                        ay - cell * 0.075 * u + cell * 0.008 * math.sin(two_pi * phase)))
        shapes.append(("ribbon", arm, cell * 0.026))

        # pincer: two curved halves meeting at a point
        hx = ax + side * cell * 0.075
        hy = ay - cell * 0.075
        for sign in (1, -1):
            claw = []
            for i in range(11):
                u = i / 10
                ang = math.pi * (0.08 + 0.80 * u)
                claw.append((hx + side * cell * 0.048 * math.sin(ang),
                             hy - cell * 0.042 * (1.0 - math.cos(ang)) * sign
                             - cell * 0.012 * u))
            shapes.append(claw)

    return shapes


def _snail_shapes(cell: int, phase: float, dormant: bool = False):
    """Snail: a coiled shell with a foot and two eye stalks.

    Distinct from the crab at a glance: the shell is a SPIRAL disc on the
    creature's back, the body is a long low foot, and the eye stalks rise
    from the FRONT. The spiral is what makes it read as a snail rather
    than a generic shelled blob.
    """
    cx = cell * 0.42
    two_pi = 2.0 * math.pi

    bob = cell * 0.010 * math.sin(two_pi * phase)
    shell_cy = cell * 0.44 + bob
    r = cell * 0.155

    shapes = []

    # --- foot: a long low body running to the RIGHT, ending in a head ---
    # Drawn FIRST so the shell overlaps its back end, and the head and
    # eye stalks stay clear of the coil.
    foot = []
    for i in range(22):
        u = i / 21
        x = cx - r * 0.80 + (r * 3.1) * u
        y = shell_cy + r * 0.78 + cell * 0.026 * math.sin(math.pi * u) \
            + cell * 0.010 * math.sin(two_pi * phase + u * 1.4)
        foot.append((x, y))
    shapes.append(("ribbon", foot, cell * 0.070))

    # head: a rounded nub at the front (right side)
    hx = cx + r * 2.28
    hy = shell_cy + r * 0.72
    head = []
    for i in range(18):
        ang = two_pi * i / 17
        head.append((hx + math.cos(ang) * cell * 0.048,
                     hy + math.sin(ang) * cell * 0.042))
    shapes.append(head)

    # --- eye stalks: two, rising from the head ---
    for side in (1, -1):
        stalk = []
        for i in range(10):
            u = i / 9
            stalk.append((hx + side * cell * 0.022 * u,
                          hy - cell * 0.075 * u
                          + cell * 0.008 * math.sin(two_pi * phase + side)))
        shapes.append(("ribbon", stalk, cell * 0.018))
        tipx = hx + side * cell * 0.022
        tipy = hy - cell * 0.075
        ball = []
        for i in range(12):
            ang = two_pi * i / 11
            ball.append((tipx + math.cos(ang) * cell * 0.019,
                         tipy + math.sin(ang) * cell * 0.019))
        shapes.append(ball)

    # --- shell: a spiral drawn as a tapering ribbon, sitting on the foot ---
    # The spiral's inner end is thicker, so it reads as a coil.
    spiral_pts = []
    turns = 2.4
    steps = 40
    for i in range(steps + 1):
        t = i / steps
        ang = two_pi * turns * t
        rad = r * (0.18 + 0.82 * t)
        x = cx + math.cos(ang) * rad
        y = shell_cy + math.sin(ang) * rad * 0.92
        spiral_pts.append((x, y))
    segs = 40
    for i in range(segs):
        t0 = i / segs
        t1 = (i + 1) / segs
        p0 = spiral_pts[i]
        p1 = spiral_pts[i + 1]
        w0 = r * (0.34 - 0.22 * t0)
        w1 = r * (0.34 - 0.22 * t1)
        dx = p1[0] - p0[0]
        dy = p1[1] - p0[1]
        length = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / length, dx / length
        shapes.append([
            (p0[0] + nx * w0, p0[1] + ny * w0),
            (p1[0] + nx * w1, p1[1] + ny * w1),
            (p1[0] - nx * w1, p1[1] - ny * w1),
            (p0[0] - nx * w0, p0[1] - ny * w0),
        ])

    return shapes


def _rock_shapes(cell: int, phase: float, dormant: bool = False, seed: int = 1):
    """A rock: a lumpy, irregular blob that sits on the sand.

    The earlier attempt drew rocks as rounded rectangles, which read as
    coloured blocks, not stone. A rock silhouette needs an uneven outline:
    the radius is modulated by several harmonics so no edge is straight and
    no two rocks share a profile. The bottom is flattened so it beds into
    the sand instead of floating on it.
    """
    cx = cell * 0.5
    cy = cell * 0.55
    base = cell * 0.27

    # (harmonic, amplitude, phase) -- lower harmonics give the big lumps,
    # higher ones give the chipped edges.
    harmonics = [
        (2, 0.10, seed * 1.31),
        (3, 0.13, seed * 2.17 + 0.7),
        (5, 0.075, seed * 0.93 + 2.1),
        (7, 0.045, seed * 3.07 + 1.3),
    ]

    pts = []
    steps = 52
    for i in range(steps + 1):
        t = i / steps
        ang = 2.0 * math.pi * t
        r = base
        for k, amp, ph in harmonics:
            r += base * amp * math.sin(k * ang + ph)
        x = cx + math.cos(ang) * r
        y = cy + math.sin(ang) * r * 0.95
        # bed the underside into the sand: pull the bottom edge flat
        if y > cy:
            y = cy + (y - cy) * 0.62
        pts.append((x, y))

    shapes = [pts]

    # Pebbles at the foot of the rock. They must OVERLAP the rock's lower
    # edge, otherwise they read as separate blobs floating in the water
    # rather than as stones resting against the rock.
    for idx, (ox, oy, rr) in enumerate([
        (-0.24, 0.15, 0.060), (0.20, 0.14, 0.050),
    ]):
        pcx = cx + ox * cell
        pcy = cy + oy * cell
        pebble = []
        for i in range(16):
            ang = 2.0 * math.pi * i / 15
            rr2 = cell * rr * (1.0 + 0.20 * math.sin(3 * ang + seed + idx))
            pebble.append((pcx + math.cos(ang) * rr2,
                           pcy + math.sin(ang) * rr2 * 0.80))
        shapes.append(pebble)

    return shapes


def _ground_shapes(cell: int, phase: float, dormant: bool = False, seed: int = 3):
    """The aquarium floor: a wide band of sand with a rippled surface.

    The flat rectangle used for the floor read as a UI panel, and the rock
    sprites sitting on it read as inactive sprites dropped onto it. Real
    sand has texture, so the band is drawn with an undulating surface line
    and a scatter of grains, and the top edge is broken up so it does not
    read as a straight horizontal rule.
    """
    cx = cell * 0.5
    two_pi = 2.0 * math.pi

    # The surface line: a low ripple across the band.
    top = cell * 0.30
    surface = []
    steps = 48
    for i in range(steps + 1):
        t = i / steps
        x = t * cell
        y = top + math.sin(t * two_pi * 2.0 + seed) * cell * 0.035 \
            + math.sin(t * two_pi * 5.0 + seed * 2.0) * cell * 0.018
        surface.append((x, y))

    # Close the band along the bottom.
    bottom = [(x, cell * 1.02) for x, _ in reversed(surface)]
    shapes = [surface + bottom]

    # Grains scattered in the upper part of the band, denser near the
    # surface where the light catches them.
    grains = 46
    for i in range(grains):
        t = ((i * 0.6180339887 + seed * 0.31) % 1.0)
        u = ((i * 0.3819660113 + seed * 0.17) % 1.0)
        gx = t * cell
        gy = top + cell * 0.06 + u * cell * 0.55
        # skip grains that would land above the rippled surface
        sx = gx
        idx = min(steps, max(0, int(sx / cell * steps)))
        if gy < surface[idx][1] + cell * 0.03:
            continue
        rr = cell * (0.012 + 0.010 * ((i * 7) % 5) / 4.0)
        grain = []
        for k in range(10):
            ang = two_pi * k / 9
            rr2 = rr * (1.0 + 0.25 * math.sin(3 * ang + i))
            grain.append((gx + math.cos(ang) * rr2, gy + math.sin(ang) * rr2 * 0.85))
        shapes.append(grain)

    return shapes


def _floor_shapes(width: int, height: int, phase: float = 0.0):
    """The whole aquarium floor as ONE shape set: rippled sand.

    An earlier version baked rocks into this strip. Casey rejected them:
    they looked like crude sprites rather than aquarium decoration, and he
    wanted a TEXTURE applied to the ground surface, not objects added on
    top. So the floor is now pure sand -- a rippled surface line with a
    scatter of grains -- and nothing sits on it but the bottom dwellers.

    Returns a list of shapes.
    """
    two_pi = 2.0 * math.pi
    shapes = []

    # --- the sand surface line: a long low ripple ---
    surface = []
    steps = 90
    for i in range(steps + 1):
        t = i / steps
        x = t * width
        y = height * 0.30 + math.sin(t * two_pi * 3.0) * height * 0.045 \
            + math.sin(t * two_pi * 7.0 + 1.1) * height * 0.022
        surface.append((x, y))
    bottom = [(x, height * 1.04) for x, _ in reversed(surface)]
    shapes.append(surface + bottom)

    # --- grains in the sand ---
    grains = 190
    for i in range(grains):
        t = ((i * 0.6180339887) % 1.0)
        u = ((i * 0.3819660113) % 1.0)
        gx = t * width
        gy = height * 0.34 + u * height * 0.60
        rr = height * (0.014 + 0.012 * ((i * 7) % 5) / 4.0)
        grain = []
        for k in range(10):
            ang = two_pi * k / 9
            rr2 = rr * (1.0 + 0.25 * math.sin(3 * ang + i))
            grain.append((gx + math.cos(ang) * rr2, gy + math.sin(ang) * rr2 * 0.85))
        shapes.append(grain)

    return shapes


def build_floor(width: int = 512, height: int = 128,
                hues=((170, 128, 85), (255, 200, 128), (255, 255, 255))):
    """Render the aquarium floor as one wide RGBA strip.

    Deliberately NOT a cell-grid atlas: the floor is a single wide
    surface, not a set of animation frames.
    """
    # The lattice must be in the FLOOR'S OWN pixel space. The creature
    # generator works in a square cell and the tile grid handles the
    # scaling; the floor has no grid, so a 64px lattice scaled up to 512
    # would space the grains 8px apart and leave the sand nearly bare.
    lattice = []
    rng = random.Random(19)
    y = 1.4
    row = 0
    while y < height:
        x = 1.4 + (1.4 if row % 2 else 0.0)
        while x < width:
            lattice.append((x + rng.uniform(-0.9, 0.9), y + rng.uniform(-0.9, 0.9)))
            x += 2.9
        y += 2.5
        row += 1

    shapes = _floor_shapes(width, height)

    rgb = Image.new("RGB", (width, height), (0, 0, 0))
    alpha = Image.new("L", (width, height), 0)
    rp = rgb.load()
    ap = alpha.load()

    for idx, (lx, ly) in enumerate(lattice):
        x = int(lx)
        y = int(ly)
        if not (0 <= x < width and 0 <= y < height):
            continue

        # is this point inside the floor? test against the shapes
        inside = False
        for shape in shapes:
            if isinstance(shape, tuple) and shape and shape[0] == "ribbon":
                continue
            if _point_in_poly(x, y, shape):
                inside = True
                break
        if not inside:
            continue

        hx = int(lx * 7.3) * 73856093 ^ int(ly * 7.3) * 19349663
        pick = ((hx >> 3) % 100) / 100.0
        if pick < 0.60:
            h = hues[0]
        elif pick < 0.86:
            h = hues[1]
        else:
            h = hues[2]
        jitter = ((hx >> 11) % 1000) / 1000.0
        bright = 0.58 + 0.42 * jitter
        r = min(255, int(h[0] * bright))
        g = min(255, int(h[1] * bright))
        b = min(255, int(h[2] * bright))

        rad = 1.7
        x0, x1 = max(0, int(x - rad)), min(width - 1, int(x + rad))
        y0, y1 = max(0, int(y - rad)), min(height - 1, int(y + rad))
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                d2 = ((xx - lx) ** 2 + (yy - ly) ** 2) ** 0.5
                if d2 > rad:
                    continue
                a = int(255 * (1.0 - d2 / rad))
                if a <= ap[xx, yy]:
                    continue
                ap[xx, yy] = a
                rp[xx, yy] = (r, g, b)

    # soft edges
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.4))
    rgb = rgb.filter(ImageFilter.GaussianBlur(0.3))
    return quantize_rgb(rgb, alpha)


def _point_in_poly(x: float, y: float, pts) -> bool:
    """Even-odd point-in-polygon test."""
    inside = False
    n = len(pts)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
                inside = not inside
        j = i
    return inside


CREATURES = {
    "fish": {
        "shapes": _fish_shapes,
        # Codex / OpenAI -- yellow / red / white.
        "hues": [(255, 255, 0), (255, 0, 0), (255, 255, 255)],
        "cell": 128,
    },
    "jellyfish": {
        "shapes": _jellyfish_shapes,
        # MiniMax -- cyan / magenta / white. These map to DISTINCT entries in
        # the 16-colour palette (12 cyan, 11 magenta, 13 white). Choosing
        # hues that collapse onto the same palette entry (e.g. two blues)
        # flattens the creature and kills the RGB spread.
        "hues": [(0, 255, 255), (255, 0, 255), (255, 255, 255)],
        "cell": 128,
    },
    "butterfly": {
        "shapes": _butterfly_shapes,
        # Kimi -- magenta / green / white
        "hues": [(255, 0, 255), (0, 255, 0), (255, 255, 255)],
        "cell": 128,
    },
    "crab": {
        "shapes": _crab_shapes,
        # Muse -- red / yellow / white
        "hues": [(255, 0, 0), (255, 255, 0), (255, 255, 255)],
        "cell": 128,
    },
    "snail": {
        "shapes": _snail_shapes,
        # Meta -- green / cyan / white. Cool hues so it reads as a
        # different species from the crab's warm red/yellow.
        "hues": [(0, 255, 0), (0, 255, 255), (255, 255, 255)],
        "cell": 128,
    },
    "ground": {
        "shapes": _ground_shapes,
        # Sand -- warm tan / pale gold / white grains. Warm, so it reads as
        # a floor and separates from the blue water above it.
        "hues": [(170, 128, 85), (255, 200, 128), (255, 255, 255)],
        "cell": 128,
        "seed": 3,
        "scenery": True,
    },
}


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------

def render_mask(shapes, cell: int) -> Image.Image:
    """Render the silhouette to an antialiased coverage mask (L)."""
    big = Image.new("L", (cell * SUPERSAMPLE, cell * SUPERSAMPLE), 0)
    d = ImageDraw.Draw(big)
    s = SUPERSAMPLE

    def emit(shape):
        if isinstance(shape, tuple) and shape and shape[0] == "ribbon":
            _, pts, width = shape
            scaled = [(x * s, y * s) for x, y in pts]
            d.line(scaled, fill=255, width=max(1, int(width * s)), joint="curve")
            # round the ends so the strand reads as a tube, not a cut
            for px, py in (scaled[0], scaled[-1]):
                r = max(1, int(width * s * 0.5))
                d.ellipse((px - r, py - r, px + r, py + r), fill=255)
        else:
            pts = [(x * s, y * s) for x, y in shape]
            d.polygon(pts, fill=255)

    for shape in shapes:
        emit(shape)
    return big.resize((cell, cell), Image.LANCZOS)


def outline_band(mask: Image.Image, px: int = OUTLINE_PX) -> Image.Image:
    """The ring that sits just OUTSIDE the silhouette.

    The mask is ANTIALIASED: pixels on the body edge carry partial
    coverage (e.g. 200 of 255). Dilating that and subtracting the original
    therefore fires INSIDE the body too, because the interior edge pixels
    have m=200 while the dilation gives g=255. That paints the body black.

    So the shape is thresholded to a HARD mask first, the ring is computed
    from that, and only then is it blurred slightly so it does not alias
    into a staircase when the atlas is downscaled onto the PSP screen.
    """
    if px <= 0:
        return Image.new("L", mask.size, 0)
    # hard shape: inside (>=128) or outside
    hard = mask.point(lambda v: 255 if v >= 128 else 0, mode="L")
    size = px * 2 + 1
    grown = hard.filter(ImageFilter.MaxFilter(size))
    hp = hard.load()
    gp = grown.load()
    band = Image.new("L", mask.size, 0)
    bp = band.load()
    w, h = mask.size
    for y in range(h):
        for x in range(w):
            if gp[x, y] and not hp[x, y]:
                bp[x, y] = 255
    return band.filter(ImageFilter.GaussianBlur(0.4))


def rim_band(mask: Image.Image, px: int = RIM_PX) -> Image.Image:
    """The ring just INSIDE the silhouette, where a bright rim belongs.

    Erode the hard shape by `px` and subtract from the shape itself: the
    difference is the band of body that sits within `px` of the edge. That
    is where the highlight goes, so the thin features -- tentacles, legs,
    antennae -- are outlined in LIGHT instead of being smothered by a dark
    contour.
    """
    if px <= 0:
        return Image.new("L", mask.size, 0)
    hard = mask.point(lambda v: 255 if v >= 128 else 0, mode="L")
    size = px * 2 + 1
    shrunk = hard.filter(ImageFilter.MinFilter(size))
    hp = hard.load()
    sp = shrunk.load()
    band = Image.new("L", mask.size, 0)
    bp = band.load()
    w, h = mask.size
    for y in range(h):
        for x in range(w):
            if hp[x, y] and not sp[x, y]:
                bp[x, y] = 255
    return band.filter(ImageFilter.GaussianBlur(0.35))


def render_cell(shapes, cell: int, lattice, hues, dormant: bool = False):
    """Stipple one frame: sample the fixed lattice against the silhouette.

    Returns (rgb, alpha, outline).
    """
    mask = render_mask(shapes, cell)
    mp = mask.load()

    rgb = Image.new("RGB", (cell, cell), (0, 0, 0))
    alpha = Image.new("L", (cell, cell), 0)
    rp = rgb.load()
    ap = alpha.load()

    n_hues = len(hues)
    for idx, (lx, ly) in enumerate(lattice):
        # nearest-pixel coverage; the mask is antialiased so edge dots fade
        x = int(lx)
        y = int(ly)
        if not (0 <= x < cell and 0 <= y < cell):
            continue
        cov = mp[x, y]
        if cov < 40:
            continue

        # Colour keyed off the dot's POSITION, not its enumeration index.
        # The lattice is walked row by row, so index-cycling paints colour
        # bands along x -- visible as vertical stripes across the body.
        # A position hash scatters the hues instead.
        hx = int(lx * 7.3) * 73856093 ^ int(ly * 7.3) * 19349663
        pick = ((hx >> 3) % 100) / 100.0
        # WEIGHTED hue mix. Equal thirds of three saturated hues read as
        # confetti -- no cohesion, no recognisable body. A dominant hue
        # with a minority accent keeps the creature's colour identity
        # while still varying across the stipple.
        if pick < 0.62:
            h = hues[0]
        elif pick < 0.86:
            h = hues[1]
        else:
            h = hues[2]
        # brightness varies with a stable hash of the lattice position
        jitter = ((hx >> 11) % 1000) / 1000.0
        bright = 0.62 + 0.38 * jitter
        if dormant:
            bright *= 0.5

        r = min(255, int(h[0] * bright))
        g = min(255, int(h[1] * bright))
        b = min(255, int(h[2] * bright))

        # draw the dot as a soft blob
        rad = DOT_RADIUS
        x0, x1 = max(0, int(x - rad)), min(cell - 1, int(x + rad))
        y0, y1 = max(0, int(y - rad)), min(cell - 1, int(y + rad))
        for yy in range(y0, y1 + 1):
            for xx in range(x0, x1 + 1):
                d2 = ((xx - lx) ** 2 + (yy - ly) ** 2) ** 0.5
                if d2 > rad:
                    continue
                a = int(255 * (1.0 - d2 / rad) * (cov / 255.0))
                if a <= ap[xx, yy]:
                    continue
                ap[xx, yy] = a
                rp[xx, yy] = (r, g, b)

    outline = outline_band(mask)
    rim = rim_band(mask)
    return rgb, alpha, outline, rim


def build_atlas(name: str, frames: int = 8, cols: int = 4, cell: int = 128,
                dormant: bool = False, tracer_px: int = 2, shades: int = 4,
                blur: float = 0.35):
    """Render a creature to an RGBA atlas + return the per-frame cells."""
    spec = CREATURES[name]
    lattice = make_lattice(cell, seed=7 + sum(ord(c) for c in name))
    rows = (frames + cols - 1) // cols
    atlas = Image.new("RGBA", (cell * cols, cell * rows), (0, 0, 0, 0))

    cells = []
    for i in range(frames):
        phase = i / frames
        # A rock's profile is fixed by its seed -- a rock must not morph
        # between frames, it only has to sit still and catch the light.
        if "seed" in spec:
            shapes = spec["shapes"](cell, phase, dormant, spec["seed"])
        else:
            shapes = spec["shapes"](cell, phase, dormant)
        rgb, alpha, outline, rim = render_cell(shapes, cell, lattice, spec["hues"], dormant)

        # effect chain: posterize -> chromatic tracer -> soft edges -> palette
        rgb = posterize(rgb, shades)
        rgba = rgb.convert("RGBA")
        rgba.putalpha(alpha)
        rgba = tracer(rgba, tracer_px)
        alpha = rgba.getchannel("A")
        rgb = rgba.convert("RGB")
        # blur the alpha so dots are soft, but keep the colour crisp
        alpha = alpha.filter(ImageFilter.GaussianBlur(blur))
        rgb = rgb.filter(ImageFilter.GaussianBlur(blur * 0.6))

        # Stamp the outline AFTER the tracer and blur, so the contour stays a
        # clean solid black instead of picking up the RGB separation or being
        # softened by the dot blur. It sits outside the silhouette, so the
        # stipple texture is untouched.
        opx = outline.load()
        rpx = rgb.load()
        apx = alpha.load()
        for y in range(cell):
            for x in range(cell):
                o = opx[x, y]
                if o <= 4:
                    continue
                rpx[x, y] = OUTLINE_COLOR
                if o > apx[x, y]:
                    apx[x, y] = o

        # Bright rim INSIDE the silhouette. This is what makes the thin
        # features legible: a tentacle gains a lit edge instead of being
        # smothered by the dark contour.
        rmx = rim.load()
        for y in range(cell):
            for x in range(cell):
                m = rmx[x, y]
                if m <= 4:
                    continue
                rpx[x, y] = RIM_COLOR
                if m > apx[x, y]:
                    apx[x, y] = m

        cellimg = quantize_rgb(rgb, alpha)
        cells.append(cellimg)
        atlas.paste(cellimg, ((i % cols) * cell, (i // cols) * cell))

    return atlas, cells


def contact_sheet(cells, path: str, cols: int = 4, cell: int = 128, scale: int = 2):
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cell * cols * scale, cell * rows * scale), (0, 0, 0))
    for i, c in enumerate(cells):
        up = c.convert("RGB").resize((cell * scale, cell * scale), Image.NEAREST)
        sheet.paste(up, ((i % cols) * cell * scale, (i // cols) * cell * scale))
    sheet.save(path)
    return path


def preview_gif(cells, path: str, cell: int = 128, duration: int = 140):
    frames = [c.convert("RGB") for c in cells]
    frames[0].save(path, save_all=True, append_images=frames[1:],
                   duration=duration, loop=0)
    return path


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creature", action="append", default=None,
                    help="creature name (repeatable); default all")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--frames", type=int, default=8)
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--cell", type=int, default=128)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--preview", action="store_true",
                    help="also write contact sheet + gif preview")
    ap.add_argument("--dry-run", action="store_true",
                    help="render previews but do not touch src/ or sprites.json")
    ap.add_argument("--floor", action="store_true",
                    help="also write the wide aquarium floor strip (src/floor.png)")
    args = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.abspath(os.path.join(here, "..", ".."))
    out_dir = args.out_dir or os.path.join(repo, "src")
    prev_dir = os.path.join(repo, "build", "creature-preview")

    names = args.creature or (list(CREATURES.keys()) if args.all else
                              ["jellyfish"])
    os.makedirs(prev_dir, exist_ok=True)

    sprites = {}
    sp_path = os.path.join(repo, "src", "sprites.json")
    if os.path.exists(sp_path):
        try:
            with open(sp_path) as f:
                sprites = json.load(f)
        except Exception:
            sprites = {}

    # Prune entries for creatures that no longer exist, so a removed sprite
    # cannot linger in sprites.json and keep being baked into the pak.
    #
    # This must consider EVERY known creature, not just the ones passed on
    # this run: pruning against the requested subset would delete every
    # other creature's entry whenever a single one is regenerated.
    live = set()
    for name in CREATURES:
        live.add(f"{name}.png")
        if not CREATURES[name].get("scenery"):
            live.add(f"{name}-sleep.png")
    sprites = {k: v for k, v in sprites.items() if k in live}

    for name in names:
        if name not in CREATURES:
            print(f"unknown creature: {name}", file=sys.stderr)
            return 2

        is_scenery = bool(CREATURES[name].get("scenery"))
        if is_scenery:
            # Scenery is STATIC: one 128x128 frame, not an 8-frame grid.
            # An 8-frame atlas of a rock that never moves would be 8x the
            # texture memory for nothing.
            atlas, cells = build_atlas(name, frames=1, cols=1,
                                        cell=args.cell)
            atlas_d, cells_d = atlas, cells
        else:
            atlas, cells = build_atlas(name, frames=args.frames, cols=args.cols,
                                        cell=args.cell)
            # a second, dormant variant for the sleeping look
            atlas_d, cells_d = build_atlas(name, frames=args.frames, cols=args.cols,
                                           cell=args.cell, dormant=True)

        if args.preview or args.dry_run:
            contact_sheet(cells, os.path.join(prev_dir, f"{name}-sheet.png"),
                          cols=args.cols, cell=args.cell)
            preview_gif(cells, os.path.join(prev_dir, f"{name}.gif"), cell=args.cell)
            if not is_scenery:
                contact_sheet(cells_d, os.path.join(prev_dir, f"{name}-sleep-sheet.png"),
                              cols=args.cols, cell=args.cell)
                preview_gif(cells_d, os.path.join(prev_dir, f"{name}-sleep.gif"), cell=args.cell)
            print(f"preview: {prev_dir}/{name}-sheet.png  {name}.gif")

        if args.dry_run:
            print(f"{name}: {atlas.size} (dry run, nothing written to src/)")
            continue

        # Scenery has no sleeping variant -- a rock does not nap.
        variants = [("", atlas)] if is_scenery else [
            ("", atlas), ("-sleep", atlas_d)]
        for suffix, img in variants:
            fname = f"{name}{suffix}.png"
            path = os.path.join(out_dir, fname)
            img.save(path, optimize=True)
            # 8-bit RGBA is a hard cooker requirement
            im = Image.open(path)
            if im.mode != "RGBA" or im.size[0] & (im.size[0] - 1) or \
               im.size[1] & (im.size[1] - 1):
                raise SystemExit(f"{fname}: must be 8-bit RGBA on a pow2 canvas")
            if is_scenery:
                sprites[fname] = {"cols": 1, "rows": 1, "frames": 1,
                                  "step": 1, "psm": 2}
            else:
                sprites[fname] = {"cols": args.cols,
                                  "rows": (args.frames + args.cols - 1) // args.cols,
                                  "frames": args.frames, "step": 5, "psm": 2}
            print(f"wrote {path} {img.size} "
                  f"{os.path.getsize(path)} bytes")

        # keep the awake atlas as the "default" sprite name too
        sprites[f"{name}.png"] = dict(sprites[f"{name}.png"])

    # The floor is a single wide strip, not a cell-grid atlas, so it is
    # written directly rather than through the sprite pipeline.
    if args.floor:
        floor = build_floor(512, 128)
        floor_path = os.path.join(out_dir, "floor.png")
        floor.save(floor_path, optimize=True)
        im = Image.open(floor_path)
        if im.mode != "RGBA" or im.size[0] & (im.size[0] - 1) or im.size[1] & (im.size[1] - 1):
            raise SystemExit("floor.png: must be 8-bit RGBA on a pow2 canvas")
        print(f"wrote {floor_path} {floor.size} "
              f"{os.path.getsize(floor_path)} bytes")
        if args.preview or args.dry_run:
            flat = Image.new("RGB", floor.size, (10, 24, 44))
            flat.paste(floor, (0, 0), floor)
            flat.save(os.path.join(prev_dir, "floor.png"))
            print(f"preview: {prev_dir}/floor.png")

    if not args.dry_run:
        with open(sp_path, "w") as f:
            json.dump(sprites, f, indent=2, sort_keys=True)
        print(f"wrote {sp_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

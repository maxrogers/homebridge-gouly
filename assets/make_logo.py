"""
Generates assets/logo.svg (an iOS-style rounded icon) from a few parameters. Run from the repo root:

    python3 assets/make_logo.py assets/logo.svg

Garage wing GX0..JX with eave height EAVE_G; main house JX..MX1 with eave EAVE_M (higher).
Both roofs share PITCH (rise over run). The main roof overhangs past its wall until it meets
the garage roof; that join sits straight below the dip in the light string. WIRE_GAP is the
spacing between roof and light string. Then copy logo.svg to homebridge-ui/public/icon.svg
and regenerate icon.png.
"""
import math, sys


def squircle(size=1024, n=5.0, steps=720):
    """iOS-style icon outline: a superellipse |x|^n + |y|^n = 1 (continuous corners)."""
    r, pts = size / 2, []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        c, s = math.cos(t), math.sin(t)
        pts.append((r + r * math.copysign(abs(c) ** (2 / n), c), r + r * math.copysign(abs(s) ** (2 / n), s)))
    return 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + ' Z'

def build(GROUND=823, EAVE_M=517, EAVE_G=597, GX0=120, JX=420, MX1=906, PITCH=0.9, WIRE_GAP=40,
          GARAGE_DOOR=0.82, FRONT_DOOR=0.74, FILL=0.92):
    P = PITCH
    gpx, gpy = (GX0 + JX) / 2, EAVE_G - P * (JX - GX0) / 2          # garage peak
    mpx, mpy = (JX + MX1) / 2, EAVE_M - P * (MX1 - JX) / 2          # main peak
    # Where the main roof (extended past its wall) meets the garage roof.
    ix, iy = JX + (EAVE_M - EAVE_G) / (2 * P), (EAVE_M + EAVE_G) / 2

    up = WIRE_GAP * math.sqrt(1 + P * P)                            # roofline moved up, square to the slope
    ext = 34
    wire = [(GX0 - ext, EAVE_G - up + P * ext), (gpx, gpy - up), (ix, iy - up), (mpx, mpy - up), (MX1 + ext, EAVE_M - up + P * ext)]

    def along(p, q, t): return (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
    w = wire
    pos = [w[0], along(w[0], w[1], 1/3), along(w[0], w[1], 2/3), w[1],
           along(w[1], w[2], 0.55),
           along(w[2], w[3], 0.33), along(w[2], w[3], 0.67), w[3],
           along(w[3], w[4], 1/3), along(w[3], w[4], 2/3), w[4]]
    seq = ['red', 'orange', 'green', 'blue', 'purple', 'blue', 'purple', 'red', 'orange', 'green', 'blue']
    pal = {'red': ('#c0444f', '#f2b4b6'), 'orange': ('#d97f3f', '#f8c895'), 'green': ('#3f9a5e', '#bfe6cb'),
           'blue': ('#1e8ce6', '#cfe6ff'), 'purple': ('#7c69cc', '#e2d9fb')}

    # Fit the artwork (including the outer glows) to FILL of the width and centre it.
    left, right = w[0][0] - 60, w[-1][0] + 60
    top, bottom = min(y for _, y in pos) - 60, GROUND + 4
    s = FILL * 1024 / (right - left)
    tx, ty = 512 - s * (left + right) / 2, 512 - s * (top + bottom) / 2

    f = lambda v: f'{v:.1f}'.rstrip('0').rstrip('.')
    defs = []
    for name, (ring, core) in pal.items():
        defs.append(f'    <radialGradient id="glow-{name}"><stop offset="0" stop-color="{ring}" stop-opacity=".7"/>'
                    f'<stop offset=".45" stop-color="{ring}" stop-opacity=".3"/><stop offset="1" stop-color="{ring}" stop-opacity="0"/></radialGradient>')
        defs.append(f'    <radialGradient id="core-{name}" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/>'
                    f'<stop offset=".55" stop-color="{core}"/><stop offset="1" stop-color="{core}"/></radialGradient>')
    pts = ' '.join(f'{f(x)},{f(y)}' for x, y in wire)
    bulbs = '\n'.join(
        f'    <circle cx="{f(x)}" cy="{f(y)}" r="60" fill="url(#glow-{c})"/>\n'
        f'    <circle cx="{f(x)}" cy="{f(y)}" r="27" fill="{pal[c][0]}"/>\n'
        f'    <circle cx="{f(x)}" cy="{f(y)}" r="18" fill="url(#core-{c})"/>' for (x, y), c in zip(pos, seq))

    garage = f'M{GX0} {GROUND} L{GX0} {EAVE_G} L{f(gpx)} {f(gpy)} L{f(ix)} {f(iy)} L{JX} {f(iy)} L{JX} {GROUND} Z'
    main = f'M{f(ix)} {f(iy)} L{f(mpx)} {f(mpy)} L{MX1} {EAVE_M} L{MX1} {GROUND} L{JX} {GROUND} L{JX} {f(iy)} Z'

    gw = JX - GX0; gdw = round(gw * 0.74); gdx = gpx - gdw / 2; gdh = round((GROUND - EAVE_G) * GARAGE_DOOR); gdy = GROUND - gdh
    slats = ''.join(f'<line x1="{f(gdx + 12)}" y1="{f(gdy + 11 + i * (gdh - 11) / 7)}" x2="{f(gdx + gdw - 12)}" y2="{f(gdy + 11 + i * (gdh - 11) / 7)}"/>' for i in range(1, 7))
    dw, dh = 118, round((GROUND - EAVE_M) * FRONT_DOOR); dx = mpx - dw / 2; dy = GROUND - dh

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Gouly Permanent Lights">
  <title>Gouly Permanent Lights</title>
  <defs>
    <clipPath id="icon"><path d="{squircle()}"/></clipPath>
{chr(10).join(defs)}
  </defs>
  <g clip-path="url(#icon)">
  <rect width="1024" height="1024" fill="#18151f"/>
  <g transform="translate({f(tx)} {f(ty)}) scale({s:.4f})">
    <!-- houses: garage wing (lower roof) and main house, whose roof overhangs to meet it -->
    <g fill="#3d3756" stroke="#120f19" stroke-width="8" stroke-linejoin="round">
      <path d="{garage}"/>
      <path d="{main}"/>
    </g>
    <!-- garage door -->
    <rect x="{f(gdx)}" y="{gdy}" width="{gdw}" height="{gdh}" fill="#48415f"/>
    <rect x="{f(gdx + 11)}" y="{gdy + 11}" width="{gdw - 22}" height="{gdh - 11}" fill="#2f2a41"/>
    <g stroke="#221e30" stroke-width="3.5">{slats}</g>
    <!-- front door, knob and step -->
    <rect x="{f(dx)}" y="{dy}" width="{dw}" height="{dh}" fill="#48415f"/>
    <rect x="{f(dx + 13)}" y="{dy + 13}" width="{dw - 26}" height="{dh - 13}" fill="#27233a"/>
    <circle cx="{f(dx + dw - 28)}" cy="{f(dy + dh * 0.53)}" r="8.5" fill="#575071"/>
    <rect x="{f(dx - 8)}" y="{GROUND - 11}" width="{dw + 16}" height="11" rx="2" fill="#48415f"/>
    <!-- wire: shadow, cable, highlight -->
    <polyline points="{pts}" fill="none" stroke="#0e0c14" stroke-width="32" stroke-linejoin="round" stroke-linecap="round" opacity=".7"/>
    <polyline points="{pts}" fill="none" stroke="#4a4560" stroke-width="17" stroke-linejoin="round" stroke-linecap="round"/>
    <polyline points="{pts}" fill="none" stroke="#6b6584" stroke-width="5" stroke-linejoin="round" stroke-linecap="round" opacity=".55" transform="translate(0 -3)"/>
    <!-- bulbs: glow, coloured ring, lit core -->
{bulbs}
  </g>
  </g>
</svg>
'''

if __name__ == '__main__':
    open(sys.argv[1] if len(sys.argv) > 1 else 'gouly-logo.svg', 'w').write(build())

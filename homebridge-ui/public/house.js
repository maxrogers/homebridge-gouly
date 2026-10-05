/*
 * Virtual house pattern preview for the Gouly settings UI.
 *
 * LED order follows a typical install: index 0 at the bottom left, along the
 * lower rooflines to the bottom right, then top left along the upper rooflines
 * to the top right. Direction "Right" moves from index 0 toward the end; "Left"
 * the reverse (starting top right). The effects are recreations of the Gouly
 * firmware animations from the app's descriptions and observation, not the real
 * algorithms: simple motion effects are close, sparkle/glitch style ones are
 * approximations. "Show on house" in the UI plays the real thing.
 *
 * Works in the browser (window.GoulyHouse) and in Node (module.exports) for tests.
 */
(function (root) {
  'use strict';

  const VIEW = { w: 400, h: 215 };

  // Rooflines (viewBox units). Runs are drawn in LED order; gaps between runs have no LEDs.
  const LOWER_RUNS = [
    [[26, 128], [86, 72], [140, 122]],                 // garage gable
    [[150, 128], [168, 128]],                          // short gutter
    [[178, 122], [212, 90], [247, 122]],               // porch gable
  ];
  const UPPER_RUNS = [
    [[110, 71], [166, 71]],                            // upper left eave
    [[176, 59], [205, 32], [234, 58]],                 // middle gable
    [[231, 71], [270, 71]],                            // middle eave
    [[276, 59], [320, 17], [367, 61]],                 // right gable
  ];
  // Roughly the density of the Gouly app's own house preview.
  const LOWER_DOTS = 22;
  const UPPER_DOTS = 34;
  const DOTS = LOWER_DOTS + UPPER_DOTS;

  function runLength(run) {
    let len = 0;
    for (let i = 1; i < run.length; i++) len += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
    return len;
  }

  function pointAt(run, dist) {
    for (let i = 1; i < run.length; i++) {
      const [x0, y0] = run[i - 1];
      const [x1, y1] = run[i];
      const seg = Math.hypot(x1 - x0, y1 - y0);
      if (dist <= seg || i === run.length - 1) {
        const t = seg === 0 ? 0 : Math.min(1, dist / seg);
        return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
      }
      dist -= seg;
    }
    return run[run.length - 1];
  }

  /** Evenly space `count` dots along a group of runs, in order. */
  function placeDots(runs, count) {
    const lengths = runs.map(runLength);
    const total = lengths.reduce((a, b) => a + b, 0);
    const out = [];
    for (let k = 0; k < count; k++) {
      let d = ((k + 0.5) / count) * total;
      let r = 0;
      while (r < runs.length - 1 && d > lengths[r]) d -= lengths[r++];
      out.push(pointAt(runs[r], d));
    }
    return out;
  }

  const POSITIONS = [...placeDots(LOWER_RUNS, LOWER_DOTS), ...placeDots(UPPER_RUNS, UPPER_DOTS)];


  // ------------------------------------------------------------------ frame parsing

  function parseFrame(hex) {
    const b = hex.replace(/[^0-9a-f]/gi, '').match(/../g).map(h => parseInt(h, 16));
    const count = b[6];
    const colours = [];
    for (let i = 0; i < count; i++) colours.push(b.slice(11 + 4 * i, 15 + 4 * i));
    return { effect: b[1], speed: b[2], b4: b[3], direction: b[4], b6: b[5], background: b.slice(7, 11), colours };
  }

  // ------------------------------------------------------------------ colour helpers

  /** RGBW to displayable RGB; the warm white LED is approximated as a warm tint. */
  function toRgb([r, g, b, w]) {
    const k = w / 255;
    return [
      Math.min(255, r + 255 * k),
      Math.min(255, g + 190 * k),
      Math.min(255, b + 110 * k),
    ];
  }
  const scale = (c, f) => [c[0] * f, c[1] * f, c[2] * f];
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const mod = (a, n) => ((a % n) + n) % n;

  function hsv(h) {
    const x = (1 - Math.abs(((h / 60) % 2) - 1)) * 255;
    const s = Math.floor(h / 60) % 6;
    return [[255, x, 0], [x, 255, 0], [0, 255, x], [0, x, 255], [x, 0, 255], [255, 0, x]][s];
  }

  /** Deterministic pseudo-random in [0, 1) for sparkle effects. */
  function rand(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ------------------------------------------------------------------ direction

  /**
   * Position of LED i along the direction of motion, and the motion offset at time t.
   * Center-to-sides folds the string at its middle so the pattern flows outward;
   * sides-to-center flows inward; elastic loop bounces back and forth.
   */
  function positionOf(i, n, dir) {
    const c = (n - 1) / 2;
    switch (dir) {
      case 1: return n - 1 - i;
      case 2: return Math.abs(i - c);
      case 3: return c - Math.abs(i - c);
      default: return i;
    }
  }

  function offsetAt(t, speed, dir, n) {
    const rate = 1 + speed * 1.6; // preview dots per second
    if (dir === 4) {
      const span = n / 2;
      const x = mod(t * rate, 2 * span);
      return x < span ? x : 2 * span - x;
    }
    return t * rate;
  }

  // ------------------------------------------------------------------ effects

  /**
   * Colours for every LED at time t (seconds).
   * @returns {number[][]} [r,g,b] per LED, 0-255
   */
  function frameAt(p, t, n = DOTS) {
    const cols = (p.colours.length ? p.colours : [[255, 255, 255, 0]]).map(toRgb);
    const k = cols.length;
    const bg = toRgb(p.background);
    const speed = Math.max(1, Math.min(10, p.speed || 5));
    const f = 0.05 + speed * 0.06; // cycles per second for pulsing effects
    const off = offsetAt(t, speed, p.direction, n);
    const seq = pos => cols[mod(Math.floor(pos), k)];
    const out = new Array(n);

    for (let i = 0; i < n; i++) {
      const pos = positionOf(i, n, p.direction);
      const moving = pos - off;
      let c;
      switch (p.effect) {
        case 0x01: // Static
          c = seq(i);
          break;
        case 0x02: // Breathing
          c = scale(seq(i), 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(2 * Math.PI * f * t)));
          break;
        case 0x03: { // Gradual: whole string blends colour to colour
          const ph = t * f * 1.5;
          c = mix(cols[mod(Math.floor(ph), k)], cols[mod(Math.floor(ph) + 1, k)], ph % 1);
          break;
        }
        case 0x04: // Follow: colours as blocks following each other
          c = seq(moving / 4);
          break;
        case 0x05: // Scroll
          c = seq(moving);
          break;
        case 0x06: { // Stream: smooth flow between neighbours
          const a = Math.floor(moving);
          c = mix(seq(a), seq(a + 1), moving - a);
          break;
        }
        case 0x07: { // Encircle: a moving band of the sequence over the background
          const band = mod(moving, n) < n / 3;
          c = band ? seq(moving) : bg;
          break;
        }
        case 0x08: { // Star: twinkles on the background
          const ph = mod(t * f * 0.8 + rand(i, 1), 1);
          const tw = Math.max(0, Math.sin(ph * Math.PI * 2)) ** 3;
          c = mix(bg, cols[mod(Math.floor(rand(i, 2) * k), k)], tw);
          break;
        }
        case 0x09: { // Layer: successive colours wipe over the previous
          const cycle = t * (0.3 + speed * 0.12);
          const layer = Math.floor(cycle);
          const fill = (cycle % 1) * n;
          c = pos < fill ? cols[mod(layer, k)] : cols[mod(layer - 1, k)];
          break;
        }
        case 0x0a: { // Phantom: fading shapes drifting
          const w = Math.max(0, Math.sin((2 * Math.PI * moving) / 24));
          c = mix(bg, seq(moving / 24), w * w);
          break;
        }
        case 0x0b: // Pixel Chase: single pixels running
          c = mod(Math.floor(moving), 8) === 0 ? seq(moving / 8) : bg;
          break;
        case 0x0c: // Undulation: brightness wave through the colours
          c = scale(seq(pos), 0.2 + 0.8 * (0.5 + 0.5 * Math.sin((2 * Math.PI * moving) / 16)));
          break;
        case 0x0d: { // Multi Pulse: several heartbeats
          let best = 0;
          let colour = cols[0];
          for (let j = 0; j < k; j++) {
            const centre = mod(off * 1.5 + (j * n) / k, n);
            const d = Math.min(Math.abs(pos - centre), n - Math.abs(pos - centre));
            const v = Math.exp(-(d * d) / 8);
            if (v > best) { best = v; colour = cols[j]; }
          }
          c = mix(bg, colour, best);
          break;
        }
        case 0x0e: { // Expanse: blooms outward from the centre
          const dist = Math.abs(i - (n - 1) / 2);
          const ring = (dist - off / 2) / 6;
          c = seq(-ring);
          break;
        }
        case 0x0f: // Spectrum: rainbow (ignores the pattern colours)
          c = hsv(mod(pos * 7 - off * 12, 360));
          break;
        case 0x10: { // Spotlight: a bright window moving over the background
          const d = mod(moving, n);
          c = d < 8 ? seq(d / 8 + Math.floor(off / n)) : scale(bg, 1);
          break;
        }
        case 0x11: { // Flicker: rapid random pulses
          const step = Math.floor(t * (4 + speed * 2));
          c = rand(i, step) > 0.55 ? seq(i) : bg;
          break;
        }
        case 0x12: { // Glitch: blocks jump around
          const step = Math.floor(t * (2 + speed));
          const block = Math.floor(i / 6);
          const shift = rand(block, step) > 0.7 ? Math.floor(rand(block, step + 99) * 12) : 0;
          c = seq(pos + shift);
          break;
        }
        case 0x13: { // Burst: explosions from random points
          const step = Math.floor(t * f * 1.2);
          const centre = Math.floor(rand(step, 7) * n);
          const age = (t * f * 1.2) % 1;
          const d = Math.abs(i - centre);
          const edge = age * 14;
          const v = d <= edge ? (1 - age) * Math.max(0, 1 - Math.abs(d - edge) / 4) : 0;
          c = mix(bg, cols[mod(step, k)], v);
          break;
        }
        case 0x14: // Drift: slow wandering back and forth
          c = seq(pos - 6 * Math.sin(t * (0.2 + speed * 0.08)));
          break;
        case 0x15: { // Sync Fade: all together, fade out and in to the next colour.
          // Direction byte is a duty cycle here: high nibble LEDs on, low nibble LEDs off.
          const on = (p.direction >> 4) || 1;
          const offCount = p.direction & 15;
          const ph = t * f;
          const v = Math.sin(Math.PI * (ph % 1));
          c = mod(i, on + offCount) < on ? scale(cols[mod(Math.floor(ph), k)], v) : bg;
          break;
        }
        case 0x19: // Roll: moving sequence with rolling brightness
          c = scale(seq(moving / 2), 0.35 + 0.65 * (0.5 + 0.5 * Math.cos((2 * Math.PI * moving) / 20)));
          break;
        case 0x1a: { // Extend: a trail stretches along the string, then restarts
          const len = mod(off, n + 10);
          c = pos < len ? seq((len - pos) / 3) : bg;
          break;
        }
        case 0x1b: { // Flame: flickering warm variation of the colours
          const step = Math.floor(t * (6 + speed * 2));
          c = scale(seq(i / 3), 0.45 + 0.55 * rand(i, step));
          break;
        }
        default:
          c = seq(i);
      }
      out[i] = c;
    }
    return out;
  }

  // ------------------------------------------------------------------ SVG

  const NS = 'http://www.w3.org/2000/svg';
  let uid = 0;

  function houseSvg(id) {
    return `
<svg viewBox="0 0 ${VIEW.w} ${VIEW.h}" xmlns="${NS}" style="width:100%;display:block">
  <defs><filter id="glow${id}" x="-2" y="-2" width="5" height="5"><feGaussianBlur stdDeviation="2.2"/></filter></defs>
  <rect width="${VIEW.w}" height="${VIEW.h}" rx="10" fill="#0f1420"/>
  <g stroke="none">
    <!-- upper storey -->
    <rect x="113" y="71" width="155" height="120" fill="#9a9a9a"/>
    <rect x="266" y="58" width="98" height="133" fill="#8f8f8f"/>
    <polygon points="104,72 125,40 185,40 176,59 205,31 236,58 266,40 305,40 276,59 320,16 368,61 360,72" fill="#2c2f36"/>
    <polygon points="178,60 205,34 232,60 232,72 178,72" fill="#a7a7a7"/>
    <polygon points="281,60 320,21 359,60" fill="#999"/>
    <!-- lower storey -->
    <rect x="34" y="120" width="104" height="72" fill="#8c8c8c"/>
    <polygon points="24,128 86,70 146,126" fill="#2c2f36"/>
    <polygon points="38,124 86,80 132,124" fill="#939393"/>
    <rect x="150" y="124" width="100" height="68" fill="#959595"/>
    <polygon points="176,124 212,89 249,124" fill="#2c2f36"/>
    <polygon points="186,121 212,96 238,121" fill="#b0b0b0"/>
    <!-- doors, windows, trim -->
    <rect x="46" y="145" width="80" height="46" fill="#b9b9b9"/>
    <rect x="154" y="145" width="26" height="46" fill="#b0b0b0"/>
    <rect x="205" y="152" width="14" height="39" fill="#3b2d27"/>
    <rect x="189" y="124" width="4" height="67" fill="#ddd"/><rect x="232" y="124" width="4" height="67" fill="#ddd"/>
    <rect x="137" y="80" width="26" height="22" fill="#d7dde6"/><rect x="196" y="75" width="18" height="24" fill="#d7dde6"/>
    <rect x="244" y="80" width="26" height="22" fill="#d7dde6"/><rect x="302" y="75" width="36" height="30" fill="#d7dde6"/>
    <rect x="302" y="140" width="36" height="30" fill="#d7dde6"/><rect x="310" y="40" width="20" height="16" fill="#d7dde6"/>
    <rect x="80" y="98" width="12" height="16" fill="#d7dde6"/>
    <rect x="0" y="191" width="${VIEW.w}" height="24" fill="#1a2230"/>
  </g>
  <g filter="url(#glow${id})" class="glow"></g>
  <g class="dots"></g>
</svg>`;
  }

  /**
   * Render an animated preview into `el` for a pattern frame (hex, starting f6).
   * Animates only while visible. Returns { update(hex), stop() }.
   */
  function mount(el, hex) {
    const id = ++uid;
    el.innerHTML = houseSvg(id);
    const svg = el.querySelector('svg');
    const glow = svg.querySelector('.glow');
    const dots = svg.querySelector('.dots');
    const halo = [];
    const core = [];
    for (const [x, y] of POSITIONS) {
      const h = document.createElementNS(NS, 'circle');
      h.setAttribute('cx', x); h.setAttribute('cy', y); h.setAttribute('r', 4.4);
      glow.appendChild(h); halo.push(h);
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 2.6);
      dots.appendChild(c); core.push(c);
    }
    let pattern = parseFrame(hex);
    let visible = true;
    let raf = 0;
    const start = performance.now();
    let last = 0;
    const draw = now => {
      raf = requestAnimationFrame(draw);
      if (!visible || now - last < 33) return; // ~30 fps
      last = now;
      const frame = frameAt(pattern, (now - start) / 1000);
      for (let i = 0; i < frame.length; i++) {
        const [r, g, b] = frame[i];
        const css = `rgb(${r | 0},${g | 0},${b | 0})`;
        core[i].setAttribute('fill', css);
        halo[i].setAttribute('fill', css);
      }
    };
    raf = requestAnimationFrame(draw);
    let observer;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; });
      observer.observe(el);
    }
    return {
      update(newHex) { pattern = parseFrame(newHex); },
      stop() { cancelAnimationFrame(raf); observer && observer.disconnect(); },
    };
  }

  const api = { DOTS, LOWER_DOTS, POSITIONS, parseFrame, frameAt, positionOf, mount, toRgb };
  // Node (tests) gets a module export; the browser gets window.GoulyHouse.
  // eslint-disable-next-line no-undef
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GoulyHouse = api;
})(typeof window !== 'undefined' ? window : globalThis);

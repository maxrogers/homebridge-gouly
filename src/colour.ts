/**
 * HomeKit <-> Gouly colour mapping.
 *
 * Colour mode: Hue/Saturation become full-value RGB with W = 0 (brightness is a
 * separate controller command, so colours are always sent at full value).
 *
 * White mode: HomeKit colour temperature runs from 140 mired (cool) to 500
 * (warm). The pixels have RGB plus one warm white LED; see miredToRgbw.
 */
import { rgbToHue } from './patterns/describe';

export const MIRED_MIN = 140;
export const MIRED_MAX = 500;

export type Rgbw = [number, number, number, number];

export function hsToRgbw(hue: number, saturation: number): Rgbw {
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const c = s;
  const hp = ((hue % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = 1 - c;
  return [...rgb.map(v => Math.round((v + m) * 255)), 0] as Rgbw;
}

/**
 * Warm-biased white mapping (the dedicated warm white LED looks better than mixed RGB):
 *   140 mired (~7100K) .. PURE : RGB white, W rising 0 -> full   (CW -> PW)
 *   PURE .. WARM              : W full, RGB falling full -> 0   (PW -> WW)
 *   WARM (~2700K) .. 500      : W only                          (WW)
 */
export const MIRED_PURE = 255;  // ~3900K, the app's "PW"
export const MIRED_WARM = 370;  // ~2700K and warmer = warm white LED only

export function miredToRgbw(mired: number): Rgbw {
  const m = Math.max(MIRED_MIN, Math.min(MIRED_MAX, mired));
  if (m <= MIRED_PURE) {
    const w = Math.round((255 * (m - MIRED_MIN)) / (MIRED_PURE - MIRED_MIN));
    return [255, 255, 255, w];
  }
  if (m < MIRED_WARM) {
    const rgb = Math.round((255 * (MIRED_WARM - m)) / (MIRED_WARM - MIRED_PURE));
    return [rgb, rgb, rgb, 255];
  }
  return [0, 0, 0, 255];
}

export type HomeKitColour =
  | { mode: 'colour'; hue: number; saturation: number }
  | { mode: 'white'; mired: number };

/** Interpret an RGBW value reported by the controller in HomeKit terms. */
export function rgbwToHomeKit([r, g, b, w]: Rgbw): HomeKitColour {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const isWhite = max === 0 || (max - min) / max < 0.05;
  if (isWhite && (w > 0 || max > 0)) {
    let mired: number;
    if (max === 0) mired = MIRED_WARM;                                   // W only
    else if (w < max) mired = MIRED_MIN + ((w / max) * (MIRED_PURE - MIRED_MIN));
    else mired = MIRED_WARM - ((max / w) * (MIRED_WARM - MIRED_PURE));
    return { mode: 'white', mired: Math.round(mired) };
  }
  const saturation = max === 0 ? 0 : Math.round(((max - min) / max) * 100);
  return { mode: 'colour', hue: Math.round(rgbToHue(r, g, b)), saturation };
}

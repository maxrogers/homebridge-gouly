/**
 * Human readable interpretation of a recorded classic pattern body, used for
 * suggested names and the pattern list in the settings UI.
 */
import { PATTERN } from '../protocol/classic';
import { directionName, directionSet, effectName } from '../protocol/effects';

export type Rgbw = [number, number, number, number];

export interface PatternInfo {
  effect: number;
  effectName: string;
  speed: number;
  direction: number;
  directionName: string;
  background: Rgbw;
  colours: Rgbw[];
  colourNames: string[]; // unique, in order of first appearance
  suggestedName: string;
  summary: string;
}

export function readColours(body: Buffer): Rgbw[] {
  const count = body[PATTERN.COUNT];
  const out: Rgbw[] = [];
  for (let i = 0; i < count; i++) {
    const o = PATTERN.COLOURS + 4 * i;
    out.push([body[o], body[o + 1], body[o + 2], body[o + 3]]);
  }
  return out;
}

/** Plain-English name for an RGBW value, matching the Gouly app's PW/CW/WW where exact. */
export function colourName([r, g, b, w]: Rgbw): string {
  const max = Math.max(r, g, b);
  if (max === 0 && w === 0) return 'off';
  if (max === 0) return 'warm white';
  const min = Math.min(r, g, b);
  const sat = (max - min) / max;
  if (sat < 0.15) {
    if (w > 0) return 'pure white';
    return max < 90 ? 'gray' : 'cool white';
  }
  const hue = rgbToHue(r, g, b);
  const dim = max < 80 ? 'dark ' : '';
  const names: [number, string][] = [
    [15, 'red'], [45, 'orange'], [70, 'yellow'], [160, 'green'], [200, 'cyan'],
    [255, 'blue'], [320, 'purple'], [345, 'pink'], [360, 'red'],
  ];
  const name = names.find(([limit]) => hue < limit)?.[1] ?? 'red';
  return dim + name;
}

export function rgbToHue(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export function describePattern(body: Buffer): PatternInfo {
  const colours = readColours(body);
  const names = [...new Set(colours.map(colourName))];
  const bg = body.subarray(PATTERN.BACKGROUND, PATTERN.BACKGROUND + 4);
  const background: Rgbw = [bg[0], bg[1], bg[2], bg[3]];
  const info = {
    effect: body[PATTERN.EFFECT],
    effectName: effectName(body[PATTERN.EFFECT]),
    speed: body[PATTERN.SPEED],
    direction: body[PATTERN.DIRECTION],
    directionName: directionName(body[PATTERN.DIRECTION]),
    background,
    colours,
    colourNames: names,
  };
  const colourText = names.length > 4 ? `${names.slice(0, 4).join('/')} +${names.length - 4}` : names.join('/');
  const bgName = colourName(background);
  const moving = info.effect !== 0x01;
  const suggestedName = `${info.effectName} ${colourText}`.replace(/\b\w/g, c => c.toUpperCase());
  const parts = [info.effectName, colourText];
  const dirs = directionSet(info.effect);
  if (dirs === 'duty') parts.push(`${info.direction >> 4} on ${info.direction & 15} off`, `speed ${info.speed}`);
  else if (moving) {
    // Only mention direction when the effect offers a choice.
    if (dirs !== 'right') parts.push(info.directionName.toLowerCase());
    parts.push(`speed ${info.speed}`);
  }
  if (bgName !== 'off') parts.push(`${bgName} background`);
  return { ...info, suggestedName, summary: parts.join(' · ') };
}

/** Classic controller effect ids = position in the Gouly app's effect list (0x16-0x18 unused). */
export const CLASSIC_EFFECTS: Record<number, string> = {
  0x01: 'Static', 0x02: 'Breathing', 0x03: 'Gradual', 0x04: 'Follow', 0x05: 'Scroll',
  0x06: 'Stream', 0x07: 'Encircle', 0x08: 'Star', 0x09: 'Layer', 0x0a: 'Phantom',
  0x0b: 'Pixel Chase', 0x0c: 'Undulation', 0x0d: 'Multi Pulse', 0x0e: 'Expanse', 0x0f: 'Spectrum',
  0x10: 'Spotlight', 0x11: 'Flicker', 0x12: 'Glitch', 0x13: 'Burst', 0x14: 'Drift',
  0x15: 'Sync Fade', 0x19: 'Roll', 0x1a: 'Extend', 0x1b: 'Flame',
};

export const DIRECTIONS: Record<number, string> = {
  0: 'Right', 1: 'Left', 2: 'Center to Sides', 3: 'Sides to Center', 4: 'Elastic Loop',
};

export const effectName = (id: number): string => CLASSIC_EFFECTS[id] ?? `Effect ${id}`;
export const directionName = (id: number): string => DIRECTIONS[id] ?? `Direction ${id}`;

/**
 * Motion options the Gouly app offers per effect: "all" = the five directions,
 * "lr" = Right and Left, "right" = Right only, "duty" = Sync Fade's duty cycle
 * (the direction byte holds LEDs on/off counts instead).
 */
export type DirectionSet = 'all' | 'lr' | 'right' | 'duty';

export const EFFECT_DIRECTIONS: Record<number, DirectionSet> = {
  0x01: 'right', 0x02: 'right', 0x03: 'right',
  0x04: 'all', 0x05: 'all', 0x06: 'all', 0x07: 'all',
  0x08: 'right', 0x09: 'right',
  0x0a: 'all', 0x0b: 'all',
  0x0c: 'right', 0x0d: 'right',
  0x0e: 'lr',
  0x0f: 'right', 0x10: 'right', 0x11: 'right', 0x12: 'right',
  0x13: 'all',
  0x14: 'right',
  0x15: 'duty',
  0x19: 'right',
  0x1a: 'lr',
  0x1b: 'all',
};

export const directionSet = (effect: number): DirectionSet => EFFECT_DIRECTIONS[effect] ?? 'all';

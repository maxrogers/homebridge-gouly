/**
 * Command set of the single-output GOULY controller (firmware V50 and V55).
 * See PROTOCOL.md for the full reference.
 *
 *   power       AA F1 01|00
 *   brightness  AA F3 vv
 *   colour      AA F2 R G B W          W = warm white; the app's "CW" is RGB white
 *   pattern     AA F6 fx speed b4 dir b6 count bgRGBW count*RGBW   (variable length)
 *   commit      AA E5                  sent by the app after every change (not required)
 *   query       AA FC  ->  BB FC on bri speed(last pattern) 00 pixels(2) 01 icType 01 rgbOrder 01 07 00 13 00
 *   effects 0x16-0x18 exist but the app does not offer them (0x16 flashes in sync, 0x17 does
 *   nothing visible, 0x18 renders a few garbled pixels): never offered by the plugin.
 *   settings    AA F8 hi lo (pixel count), AA FA nn (IC type), AA F7 nn (RGB order)  (not sent by the plugin)
 *   schedules   AA E1 list -> BB E1 x n (114 bytes each, embeds a pattern), AA FD write, AA E6 nn delete
 *   clock       AA EE yyyy mm dd hh mm ss 00 latSign lat*100 lonSign lon*100 tzSign tzHours
 *
 * Sync Fade (0x15) reuses the direction byte as a duty cycle: high nibble = LEDs on,
 * low nibble = LEDs off (0x11 = "1 ON, 1 OFF"), with b4 = 01.
 */
import {
  buildFrame, clampByte, Driver, FrameError, HEADER_COMMAND, HEADER_REPORT, StateUpdate, verifyFrame,
} from './frame';

export const CMD = {
  POWER: 0xf1,
  COLOUR: 0xf2,
  BRIGHTNESS: 0xf3,
  PATTERN: 0xf6,
  COMMIT: 0xe5,
  QUERY: 0xfc,
  CLOCK: 0xee,
} as const;

/** Offsets inside a pattern body (body[0] is the 0xF6 command byte). */
export const PATTERN = {
  EFFECT: 1,
  SPEED: 2,
  B4: 3,
  DIRECTION: 4,
  B6: 5,
  COUNT: 6,
  BACKGROUND: 7,
  COLOURS: 11,
  MAX_COLOURS: 15,
} as const;

export class ClassicDriver implements Driver {
  readonly kind = 'classic' as const;

  constructor(private readonly sendCommit = true) {}

  private withCommit(frames: Buffer[]): Buffer[] {
    return this.sendCommit ? [...frames, buildFrame(CMD.COMMIT)] : frames;
  }

  power(on: boolean): Buffer[] {
    return [buildFrame(CMD.POWER, Uint8Array.of(on ? 1 : 0))];
  }

  brightness(value: number): Buffer[] {
    return this.withCommit([buildFrame(CMD.BRIGHTNESS, Uint8Array.of(clampByte(value)))]);
  }

  colour(r: number, g: number, b: number, w: number): Buffer[] {
    const rgbw = Uint8Array.of(clampByte(r), clampByte(g), clampByte(b), clampByte(w));
    return this.withCommit([buildFrame(CMD.COLOUR, rgbw)]);
  }

  pattern(body: Buffer): Buffer[] {
    validatePatternBody(body);
    return this.withCommit([buildFrame(body[0], body.subarray(1), body.length + 2)]);
  }

  query(): Buffer[] {
    return [buildFrame(CMD.QUERY)];
  }

  commit(): Buffer[] {
    return [buildFrame(CMD.COMMIT)];
  }

  parse(frame: Buffer): StateUpdate {
    verifyFrame(frame);
    const header = frame[0];
    const command = frame[1];
    const data = frame.subarray(2, frame.length - 1);
    if (header === HEADER_COMMAND) {
      switch (command) {
        case CMD.POWER: return { on: data[0] === 1 };
        case CMD.BRIGHTNESS: return { brightness: data[0] };
        case CMD.COLOUR: return { rgbw: [data[0], data[1], data[2], data[3]] };
        case CMD.PATTERN: return { pattern: Buffer.from(frame.subarray(1, frame.length - 1)) };
      }
    } else if (header === HEADER_REPORT && command === CMD.QUERY && data.length >= 3) {
      // BB FC <on> <brightness> <speed> ?? <pixels:2> ?? <icType> ?? <rgbOrder> ...
      const update: StateUpdate = { on: data[0] === 1, brightness: data[1], speed: data[2] };
      if (data.length >= 10) {
        update.info = { pixels: (data[4] << 8) | data[5], icType: data[7], rgbOrder: data[9] };
      }
      return update;
    }
    return {};
  }
}

export function validatePatternBody(body: Buffer): void {
  if (body[0] !== CMD.PATTERN) {
    throw new FrameError('not a pattern (expected 0xF6)');
  }
  const count = body[PATTERN.COUNT];
  if (count < 1 || count > PATTERN.MAX_COLOURS) {
    throw new FrameError(`bad color count ${count}`);
  }
  if (body.length !== PATTERN.COLOURS + 4 * count) {
    throw new FrameError(`pattern is ${body.length} bytes, but ${count} colors need ${PATTERN.COLOURS + 4 * count}`);
  }
}

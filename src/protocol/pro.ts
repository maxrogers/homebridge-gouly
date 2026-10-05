/**
 * Gouly Pro (4-output) command set, ported from mikemaat/ha-gouly docs/PROTOCOL.md.
 * EXPERIMENTAL: not tested against real hardware in this project.
 * Pattern replay for Pro controllers is not implemented (scenes span several frames).
 */
import {
  buildFrame, clampByte, Driver, HEADER_COMMAND, HEADER_REPORT, StateUpdate, verifyFrame,
} from './frame';

const CMD = { APPLY: 0xa0, QUERY: 0xb6, MUSIC: 0xc7, POWER: 0xf1, BRIGHTNESS: 0xf2, PROGRAM: 0xf3, SOLID: 0xf6 } as const;
const LEN = { QUERY: 9, SHORT: 11, SCENE_HEADER: 14, SOLID: 19, SEGMENT: 113 } as const;

const STATIC_SCENE_HEADER = Buffer.from('a1019000640064006400' + '64', 'hex');
const STATIC_COLOUR_LIST_HEADER = Buffer.from('a20000010000063e000000ff00', 'hex');

export class ProDriver implements Driver {
  readonly kind = 'pro' as const;

  power(on: boolean): Buffer[] {
    return [buildFrame(CMD.POWER, Uint8Array.of(on ? 1 : 0), LEN.SHORT)];
  }

  brightness(value: number): Buffer[] {
    return [buildFrame(CMD.BRIGHTNESS, Uint8Array.of(Math.max(1, clampByte(value))), LEN.SHORT)];
  }

  colour(r: number, g: number, b: number, w: number): Buffer[] {
    const rgbw = Buffer.from([r, g, b, w].map(clampByte));
    return [
      buildFrame(CMD.MUSIC, new Uint8Array(), LEN.SHORT),
      buildFrame(CMD.PROGRAM, STATIC_SCENE_HEADER, LEN.SCENE_HEADER),
      buildFrame(CMD.PROGRAM, Buffer.concat([STATIC_COLOUR_LIST_HEADER, rgbw]), LEN.SEGMENT),
      buildFrame(CMD.SOLID, rgbw, LEN.SOLID),
      buildFrame(CMD.APPLY, new Uint8Array(), LEN.SHORT),
    ];
  }

  query(): Buffer[] {
    return [buildFrame(CMD.QUERY, new Uint8Array(), LEN.QUERY)];
  }

  parse(frame: Buffer): StateUpdate {
    verifyFrame(frame);
    const header = frame[0];
    const command = frame[1];
    const data = frame.subarray(2, frame.length - 1);
    if (header === HEADER_COMMAND) {
      if (command === CMD.POWER) return { on: data[0] === 1 };
      if (command === CMD.BRIGHTNESS) return { brightness: data[0] };
      if (command === CMD.SOLID && data.length >= 4) return { rgbw: [data[0], data[1], data[2], data[3]] };
    } else if (header === HEADER_REPORT && command === CMD.QUERY && data.length >= 2) {
      return { on: data[0] === 1, brightness: data[1] };
    }
    return {};
  }
}

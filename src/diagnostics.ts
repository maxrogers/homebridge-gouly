/**
 * What the plugin knows about one controller, for the settings page and the debug
 * report: what the controller reported about itself, connection history,
 * unrecognized commands and a rolling buffer of recent frames.
 *
 * Saved to <storage>/gouly/info-<deviceId>.json (debounced). Contains no key.
 */
import { promises as fs } from 'fs';
import path from 'path';

const RECENT_FRAMES = 150;
const RECENT_EVENTS = 40;
const SAVE_DELAY_MS = 1000;

const IC_TYPES: Record<number, string> = { 0x03: 'UCS2904 (RGBW)' };
const RGB_ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'];

export interface ControllerInfo {
  name: string;
  deviceId: string;
  updated: string;
  type: string; // 'classic' | 'pro' | 'detecting' | 'unknown'
  host?: string;
  protocol?: string;
  firmware?: string;
  pixels?: number;
  icType?: string;
  rgbOrder?: string;
  lastStateReport?: string; // hex
  lastStateAt?: string;
  connectedSince?: string;
  connects: number;
  disconnects: number;
  lastError?: string;
  unrecognized: string[]; // hex frames, first of each command
  events: string[]; // "ISO message"
  frames: string[]; // "ISO -> hex" or "ISO <- hex"
}

export class ControllerDiagnostics {
  private readonly info: ControllerInfo;
  private saveTimer?: NodeJS.Timeout;

  constructor(private readonly file: string, name: string, deviceId: string) {
    this.info = { name, deviceId, updated: new Date().toISOString(), type: 'detecting',
      connects: 0, disconnects: 0, unrecognized: [], events: [], frames: [] };
  }

  static fileFor(storagePath: string, deviceId: string): string {
    return path.join(storagePath, 'gouly', `info-${deviceId}.json`);
  }

  get current(): Readonly<ControllerInfo> {
    return this.info;
  }

  setType(type: string): void {
    this.info.type = type;
    this.event(`controller type: ${type}`);
  }

  connected(host: string, protocol: string): void {
    Object.assign(this.info, { host, protocol, connectedSince: new Date().toISOString() });
    this.info.connects++;
    this.event(`connected to ${host} (protocol ${protocol})`);
  }

  disconnected(reason: string): void {
    this.info.disconnects++;
    this.info.connectedSince = undefined;
    this.info.lastError = reason;
    this.event(`disconnected: ${reason}`);
  }

  event(message: string): void {
    push(this.info.events, `${new Date().toISOString()} ${message}`, RECENT_EVENTS);
    this.save();
  }

  sent(frame: Buffer): void {
    push(this.info.frames, `${new Date().toISOString()} -> ${frame.toString('hex')}`, RECENT_FRAMES);
    this.save();
  }

  /**
   * A frame from the controller: echoes of commands, its state report, or the
   * clock reply (which carries the firmware version; only seen when the Gouly app
   * connects, since sending the clock command would overwrite the controller's
   * location setting).
   */
  received(frame: Buffer): void {
    push(this.info.frames, `${new Date().toISOString()} <- ${frame.toString('hex')}`, RECENT_FRAMES);
    if (frame[0] === 0xbb && frame[1] === 0xfc && frame.length >= 12) {
      this.info.pixels = frame.readUInt16BE(6);
      this.info.icType = IC_TYPES[frame[9]] ?? `0x${frame[9].toString(16).padStart(2, '0')}`;
      this.info.rgbOrder = RGB_ORDERS[frame[11]] ?? `0x${frame[11].toString(16)}`;
      this.info.lastStateReport = frame.toString('hex');
      this.info.lastStateAt = new Date().toISOString();
    } else if (frame[0] === 0xbb && frame[1] === 0xb6) {
      this.info.lastStateReport = frame.toString('hex');
      this.info.lastStateAt = new Date().toISOString();
    } else if (frame[0] === 0xbb && frame[1] === 0xee && frame.length > 7) {
      const firmware = `V${frame[7]}`;
      if (firmware !== this.info.firmware) {
        this.info.firmware = firmware;
        this.event(`firmware ${firmware}`);
      }
    }
    this.save();
  }

  unrecognized(frame: Buffer): void {
    this.info.unrecognized.push(frame.toString('hex'));
    this.save();
  }

  /** One-line summary for the log. */
  summary(): string {
    const i = this.info;
    const parts = [i.type === 'classic' ? 'GOULY single output' : i.type === 'pro' ? 'Gouly Pro' : `type ${i.type}`];
    if (i.firmware) parts.push(`firmware ${i.firmware}`);
    if (i.pixels !== undefined) parts.push(`${i.pixels} pixels`);
    if (i.icType) parts.push(`IC ${i.icType}`);
    if (i.rgbOrder) parts.push(`order ${i.rgbOrder}`);
    if (i.protocol) parts.push(`protocol ${i.protocol}`);
    return parts.join(', ');
  }

  save(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, SAVE_DELAY_MS);
  }

  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.info.updated = new Date().toISOString();
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.info, null, 2));
      await fs.rename(tmp, this.file);
    } catch {
      // diagnostics are best effort
    }
  }
}

function push(list: string[], item: string, max: number): void {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * Pattern inbox. Every pattern frame the controller echoes (whoever sent it,
 * usually the Gouly app) is stored here, de-duplicated, for the settings UI to
 * list. Favourites live in the plugin config, not here: this file is scratch.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { toHex } from '../protocol/frame';
import { describePattern } from './describe';

export interface CapturedPattern {
  frame: string;       // pattern body hex, e.g. "f6 03 07 00 00 ff 03 ..."
  firstSeen: string;
  lastSeen: string;
  seen: number;
  suggestedName: string;
  summary: string;
}

const MAX_ENTRIES = 200;

export class PatternStore {
  private entries: CapturedPattern[] = [];
  private loaded = false;
  private writing = Promise.resolve();

  constructor(readonly file: string) {}

  static fileFor(storagePath: string, deviceId: string): string {
    return path.join(storagePath, 'gouly', `captured-${deviceId}.json`);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.entries = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      this.entries = [];
    }
    this.loaded = true;
  }

  /** Record a pattern body. Returns true when it had not been seen before. */
  async add(body: Buffer): Promise<boolean> {
    await this.load();
    const frame = toHex(body);
    const now = new Date().toISOString();
    const existing = this.entries.find(e => e.frame === frame);
    if (existing) {
      existing.lastSeen = now;
      existing.seen++;
    } else {
      const info = describePattern(body);
      this.entries.unshift({ frame, firstSeen: now, lastSeen: now, seen: 1, suggestedName: info.suggestedName, summary: info.summary });
      this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    }
    this.writing = this.writing.then(() => this.save()).catch(() => undefined);
    await this.writing;
    return !existing;
  }

  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.entries, null, 2));
    await fs.rename(tmp, this.file);
  }
}

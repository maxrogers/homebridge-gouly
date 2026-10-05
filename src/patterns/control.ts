/**
 * File-based control channel between the settings UI (a separate process) and
 * the running plugin, inside Homebridge storage:
 *
 *   gouly/recording-<id>.json  { "until": ISO }            record while now < until
 *   gouly/preview-<id>.json    { "frame": hex|null, "at": ISO }  play a pattern on the house,
 *                                                         null = end preview, restore
 *   gouly/refresh-<id>.json    { "at": ISO }               re-read the controller's state
 * Polled every POLL_MS (fs.watch is unreliable in Docker and on network mounts).
 */
import { promises as fs } from 'fs';
import path from 'path';

const POLL_MS = 1500;

export interface PreviewRequest {
  frame: string | null;
  at: string;
}

export class ControlChannel {
  private timer?: NodeJS.Timeout;
  private recordingUntil = 0;
  private lastPreviewAt = '';
  private lastRefreshAt = '';

  constructor(
    private readonly dir: string,
    private readonly deviceId: string,
    private readonly onPreview: (req: PreviewRequest) => void,
    private readonly onRecording: (active: boolean, until?: Date) => void = () => undefined,
    private readonly onRefresh: () => void = () => undefined,
  ) {}

  static dirFor(storagePath: string): string {
    return path.join(storagePath, 'gouly');
  }

  get isRecording(): boolean {
    return Date.now() < this.recordingUntil;
  }

  start(): void {
    // Ignore a preview request left over from before a restart.
    void this.readJson<PreviewRequest>('preview').then(p => { this.lastPreviewAt = p?.at ?? ''; });
    void this.readJson<{ at: string }>('refresh').then(r => { this.lastRefreshAt = r?.at ?? ''; });
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async poll(): Promise<void> {
    try {
      await this.pollUnsafe();
    } catch {
      // unreadable control files are skipped; try again next tick
    }
  }

  private async pollUnsafe(): Promise<void> {
    const rec = await this.readJson<{ until: string }>('recording');
    const wasRecording = this.isRecording;
    this.recordingUntil = rec ? Date.parse(rec.until) || 0 : 0;
    if (this.isRecording !== wasRecording) {
      this.onRecording(this.isRecording, this.isRecording ? new Date(this.recordingUntil) : undefined);
    }
    const preview = await this.readJson<PreviewRequest>('preview');
    if (preview && preview.at !== this.lastPreviewAt) {
      this.lastPreviewAt = preview.at;
      try {
        this.onPreview(preview);
      } catch {
        // the handler logs its own errors; never let one stop polling
      }
    }
    const refresh = await this.readJson<{ at: string }>('refresh');
    if (refresh && refresh.at !== this.lastRefreshAt) {
      this.lastRefreshAt = refresh.at;
      try {
        this.onRefresh();
      } catch {
        // as above
      }
    }
  }

  private async readJson<T>(kind: string): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(path.join(this.dir, `${kind}-${this.deviceId}.json`), 'utf8')) as T;
    } catch {
      return undefined;
    }
  }
}

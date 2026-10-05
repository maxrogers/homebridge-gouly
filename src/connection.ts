/**
 * Local connection to one controller, via a small Python bridge that uses
 * tinytuya (python/gouly_bridge.py, with tinytuya and pyaes bundled).
 *
 * Why not tuyapi: on protocol 3.4 tuyapi tracks reply sequence numbers itself,
 * and devices that push unsolicited status packets (this controller does) knock
 * that tracking out of step, so commands silently stop working
 * (codetheweb/tuyapi#634). tinytuya handles these devices correctly and is what
 * ha-gouly uses.
 *
 * The bridge speaks JSON lines: see gouly_bridge.py for the message set.
 */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import readline from 'readline';

export interface ConnectionOptions {
  id: string;
  key: string;
  host?: string;
  version: string; // '3.3' | '3.4' | '3.5'
  pythonPath?: string;
  log: { debug(msg: string): void; info(msg: string): void; warn(msg: string): void };
}

const RESTART_DELAY_MS = 3_000;
export const BRIDGE_SCRIPT = path.join(__dirname, '..', 'python', 'gouly_bridge.py');

export class GoulyConnection extends EventEmitter {
  // Typed events.
  on(event: 'frame', listener: (frame: Buffer) => void): this;
  on(event: 'switch', listener: (on: boolean) => void): this;
  on(event: 'connected', listener: (info: { host: string; protocol: string }) => void): this;
  on(event: 'disconnected', listener: (reason: string) => void): this;
  /** Emitted after repeated failures to connect; the IP may have changed. */
  on(event: 'unreachable', listener: () => void): this;
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private proc?: ChildProcessWithoutNullStreams;
  private host?: string;
  private connected = false;
  private stopped = true;
  private restartTimer?: NodeJS.Timeout;

  constructor(private readonly opts: ConnectionOptions) {
    super();
    this.host = opts.host;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get currentHost(): string | undefined {
    return this.host;
  }

  start(): void {
    this.stopped = false;
    this.spawnBridge();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    this.write(proc, { cmd: 'stop' });
    proc.stdin.end();
    setTimeout(() => proc.exitCode === null && proc.kill(), 2_000).unref();
  }

  /** Point the connection at a (new) address and reconnect. */
  setHost(host: string): void {
    this.host = host;
    if (this.proc) this.write(this.proc, { cmd: 'host', host });
    else if (!this.stopped) this.spawnBridge();
  }

  /** Send a group of frames, in order, paced by the bridge. */
  send(frames: Buffer[]): void {
    if (frames.length === 0 || !this.proc) return;
    this.write(this.proc, { cmd: 'send', frames: frames.map(f => f.toString('hex')) });
  }

  // ------------------------------------------------------------------ bridge process

  private spawnBridge(): void {
    if (this.proc || this.stopped || !this.host) return;
    const config = JSON.stringify({ id: this.opts.id, key: this.opts.key, host: this.host, version: this.opts.version });
    const python = this.opts.pythonPath || 'python3';
    // Config (including the local key) goes through the environment, not argv,
    // so it does not show up in process listings.
    const proc = spawn(python, ['-u', BRIDGE_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GOULY_BRIDGE_CONFIG: config },
    });
    this.proc = proc;

    // Writing to a bridge that just exited raises EPIPE on stdin; the exit handler
    // restarts it, so the write error itself is harmless and must not crash Homebridge.
    proc.stdin.on('error', err => this.opts.log.debug(`bridge stdin: ${err.message}`));
    readline.createInterface({ input: proc.stdout }).on('line', line => this.onLine(line));
    readline.createInterface({ input: proc.stderr }).on('line', line => this.opts.log.debug(`bridge: ${line}`));
    proc.on('error', err => {
      this.opts.log.warn(`Could not run the Python bridge with "${python}": ${err.message}. `
        + 'Python 3 is required; set "pythonPath" in the plugin config if it is not on the PATH.');
    });
    proc.on('exit', code => {
      if (this.proc === proc) this.proc = undefined;
      this.setDisconnected();
      if (!this.stopped) {
        this.opts.log.warn(`Python bridge exited (code ${code}); restarting`);
        this.scheduleRestart();
      }
    });
  }

  private scheduleRestart(): void {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.spawnBridge(), RESTART_DELAY_MS);
  }

  private write(proc: ChildProcessWithoutNullStreams, msg: object): void {
    if (proc.exitCode !== null || !proc.stdin.writable) return;
    proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private setDisconnected(reason = 'bridge stopped'): void {
    if (!this.connected) return;
    this.connected = false;
    this.emit('disconnected', reason);
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.opts.log.debug(`bridge (non-JSON): ${line}`);
      return;
    }
    switch (msg.event) {
      case 'connected':
        this.connected = true;
        this.opts.log.info(`Connected to ${msg.host} (protocol ${msg.version ?? this.opts.version})`);
        this.emit('connected', { host: String(msg.host), protocol: String(msg.version ?? this.opts.version) });
        break;
      case 'disconnected':
        this.opts.log.warn(`Connection lost (${msg.reason}); reconnecting`);
        this.setDisconnected(String(msg.reason));
        break;
      case 'unreachable':
        this.emit('unreachable');
        break;
      case 'frame': {
        this.opts.log.debug(`<- ${msg.hex}`);
        this.emit('frame', Buffer.from(String(msg.hex), 'hex'));
        break;
      }
      case 'switch':
        this.emit('switch', Boolean(msg.on));
        break;
      case 'log':
        if (msg.level === 'warn') this.opts.log.warn(String(msg.msg));
        else if (msg.level === 'info') this.opts.log.info(String(msg.msg));
        else this.opts.log.debug(String(msg.msg));
        break;
    }
  }
}

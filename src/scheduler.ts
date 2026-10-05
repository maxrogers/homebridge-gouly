/**
 * Coalesces rapid HomeKit changes into paced batches for the controller.
 *
 * A fast slider drag or quick flipping in the Home app produces dozens of writes.
 * Sending each one (plus a commit) queues far more work than the controller can
 * take, so the lights lag seconds behind and some changes get lost. Instead:
 *
 *   - keep only the latest wanted value per channel: power, brightness, and the
 *     "look" (a solid colour or a pattern; the newer one wins),
 *   - flush 150 ms after the last change, but at least every 500 ms during a
 *     continuous drag so the lights keep following,
 *   - send the final values with a single commit,
 *   - never start a batch before the controller has had time for the previous one,
 *   - a colour, pattern or brightness change while off turns the lights on (the
 *     latest action wins: change-then-off stays off, off-then-change turns on).
 *
 * HomeKit's own state is updated immediately by the caller; only the traffic to
 * the lights is paced.
 */
import { Driver } from './protocol/frame';

export type Rgbw = [number, number, number, number];
export type Look = { kind: 'colour'; rgbw: Rgbw } | { kind: 'pattern'; body: Buffer };

export interface SchedulerOptions {
  debounceMs?: number; // quiet time after the last change before sending
  maxWaitMs?: number; // longest a change may wait while changes keep arriving
  frameMs?: number; // controller time per frame (bridge gap plus margin)
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Pending {
  power?: boolean;
  brightness?: number;
  look?: Look;
}

export class CommandScheduler {
  private pending: Pending = {};
  private firstPendingAt = 0;
  private busyUntil = 0;
  private timer?: unknown;
  /** Last power state sent or reported; undefined until known. */
  private power?: boolean;
  private readonly o: Required<SchedulerOptions>;

  constructor(
    private readonly driver: () => Driver,
    private readonly send: (frames: Buffer[]) => void,
    opts: SchedulerOptions = {},
  ) {
    this.o = {
      debounceMs: opts.debounceMs ?? 150,
      maxWaitMs: opts.maxWaitMs ?? 500,
      frameMs: opts.frameMs ?? 220,
      now: opts.now ?? Date.now,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? (t => clearTimeout(t as NodeJS.Timeout)),
    };
  }

  setPower(on: boolean): void {
    this.pending.power = on;
    this.schedule();
  }

  setBrightness(value: number): void {
    this.pending.brightness = value;
    this.impliesOn();
    this.schedule();
  }

  setLook(look: Look): void {
    this.pending.look = look;
    this.impliesOn();
    this.schedule();
  }

  /** Changing what the lights show means the user wants to see it. */
  private impliesOn(): void {
    if (this.pending.power === false || (this.pending.power === undefined && this.power === false)) {
      this.pending.power = true;
    }
  }

  /** Power state reported by the controller (echoes, state reports). */
  notePower(on: boolean): void {
    this.power = on;
  }

  /** Send anything pending right away (e.g. on shutdown). */
  flushNow(): void {
    this.clear();
    this.flush();
  }

  dispose(): void {
    this.clear();
    this.pending = {};
  }

  // ------------------------------------------------------------------ internals

  private clear(): void {
    if (this.timer !== undefined) this.o.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    const now = this.o.now();
    if (this.timer === undefined) this.firstPendingAt = now;
    this.clear();
    const due = Math.max(
      Math.min(now + this.o.debounceMs, this.firstPendingAt + this.o.maxWaitMs),
      this.busyUntil,
    );
    this.timer = this.o.setTimer(() => {
      this.timer = undefined;
      this.flush();
    }, Math.max(0, due - now));
  }

  private flush(): void {
    const d = this.driver();
    const p = this.pending;
    const frames: Buffer[] = [];

    if (p.power === false) {
      // Off was the latest action: send just that. A colour/brightness change made
      // just before it stays pending and applies at the next power-on.
      frames.push(...d.power(false));
      this.power = false;
      delete p.power;
    } else {
      const lightsOn = p.power === true || this.power !== false;
      if (p.power === true) {
        frames.push(...d.power(true));
        this.power = true;
        delete p.power;
      }
      if (lightsOn) {
        const body: Buffer[] = [];
        if (p.look?.kind === 'pattern' && d.pattern) body.push(...d.pattern(p.look.body));
        else if (p.look?.kind === 'colour') body.push(...d.colour(...p.look.rgbw));
        if (p.brightness !== undefined) body.push(...d.brightness(p.brightness));
        if (body.length) {
          frames.push(...body, ...(d.commit?.() ?? []));
          delete p.look;
          delete p.brightness;
        }
      }
    }

    if (frames.length) {
      this.send(frames);
      this.busyUntil = this.o.now() + frames.length * this.o.frameMs;
    }
    // Held changes stay pending (lights off); they don't need a timer until
    // the next change arrives.
  }
}

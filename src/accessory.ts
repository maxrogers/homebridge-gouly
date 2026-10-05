import type { API, Logger, PlatformAccessory, Service } from 'homebridge';
import { hsToRgbw, MIRED_MAX, MIRED_MIN, miredToRgbw, Rgbw, rgbwToHomeKit } from './colour';
import { GoulyConnection } from './connection';
import { confirmController, guidedSearch } from './discovery';
import { ClassicDriver, validatePatternBody } from './protocol/classic';
import { describePattern } from './patterns/describe';
import { Driver, fromHex, StateUpdate, toHex } from './protocol/frame';
import { ProDriver } from './protocol/pro';
import { PatternStore } from './patterns/store';
import { ControlChannel, PreviewRequest } from './patterns/control';
import { CommandScheduler } from './scheduler';
import { ControllerDiagnostics } from './diagnostics';
import type { PatternAccessory } from './platform';
import { DeviceConfig, PatternConfig } from './settings';

const DETECT_TIMEOUT_MS = 5_000;
/** How long the plugin remembers its own frames, so their echoes are not recorded. */
const OWN_ECHO_MS = 5_000;
/** Back-off for repeated network searches while a controller is missing. */
const REDISCOVER_MIN_MS = 5 * 60_000;
const REDISCOVER_MAX_MS = 60 * 60_000;

/**
 * "Detailed logging" (Advanced setting): debug lines for this controller, such as
 * every frame sent and received, go to the normal log without turning on
 * Homebridge's debug mode for everything.
 */
function detailedLogger(base: Logger): Logger {
  const fn = ((message: string, ...params: unknown[]) => base.info(message, ...params)) as unknown as Logger;
  return Object.assign(fn, {
    prefix: base.prefix,
    info: base.info.bind(base),
    success: base.success.bind(base),
    warn: base.warn.bind(base),
    error: base.error.bind(base),
    log: base.log.bind(base),
    debug: (message: string, ...params: unknown[]) => base.info(`[detail] ${message}`, ...params),
  });
}

function pluginVersion(): string {
  try {
    return require('../package.json').version;
  } catch {
    return 'unknown';
  }
}

/** Link to the controller report form, from package.json (used in guidance messages). */
function reportUrl(): string {
  try {
    const pkg = require('../package.json');
    const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url;
    return bugs ? `${bugs}/new?template=controller_report.yml` : '';
  } catch {
    return '';
  }
}
const POWER_SUBTYPE = 'power';

/** header+command pairs understood or deliberately ignored for the classic controller. */
const KNOWN_CLASSIC = new Set([
  'aaf1', 'aaf2', 'aaf3', 'aaf6', 'aae5', 'aafc', 'bbfc', 'aaee', 'bbee', 'aaef',
  'aaf7', 'aaf8', 'aafa', 'aae1', 'bbe1', 'aafd', 'aae6', 'aaf5', 'aab6',
]);
const COLOUR_DEBOUNCE_MS = 60;

interface LightState {
  on: boolean;
  brightness: number; // 0-255 controller scale
  colour: Rgbw;       // last solid colour (restored when a pattern switch is turned off)
  activePattern?: string;
}

export class GoulyAccessory {
  private readonly light: Service;
  private power?: Service;
  private readonly patternSwitches = new Map<string, { config: PatternConfig; service: Service }>();
  private readonly conn: GoulyConnection;
  private readonly commands: CommandScheduler;
  private readonly diag: ControllerDiagnostics;
  /** Frames this plugin sent recently: their echoes are never mistaken for the Gouly app's. */
  private readonly recentlySent = new Map<string, number>();
  private ownEcho = false;
  private rediscoverDelay = REDISCOVER_MIN_MS;
  private readonly store: PatternStore;
  private readonly control: ControlChannel;
  private beforePreview?: { colour: Rgbw; activePattern?: string; on: boolean };
  private driver: Driver;
  private detecting: boolean;
  private adaptive?: InstanceType<API['hap']['AdaptiveLightingController']>;
  private state: LightState = { on: false, brightness: 255, colour: [0, 0, 0, 255] };
  private pendingHs: { hue?: number; saturation?: number } = {};
  private hsTimer?: NodeJS.Timeout;
  private pollTimer?: NodeJS.Timeout;

  private readonly log: Logger;

  constructor(
    private readonly api: API,
    baseLog: Logger,
    private readonly accessory: PlatformAccessory,
    private readonly cfg: DeviceConfig,
    private readonly patternAccessories: PatternAccessory[] = [],
  ) {
    this.log = cfg.verboseLogging ? detailedLogger(baseLog) : baseLog;
    this.log.info(`${cfg.name}: homebridge-gouly ${pluginVersion()}, Node ${process.version}, `
      + `${process.platform} ${process.arch}, protocol ${cfg.protocolVersion ?? '3.4'}, `
      + `controller ${cfg.controllerType ?? 'auto'}${cfg.verboseLogging ? ', detailed logging on' : ''}`);
    this.diag = new ControllerDiagnostics(ControllerDiagnostics.fileFor(api.user.storagePath(), cfg.deviceId), cfg.name, cfg.deviceId);
    const { Service: S, Characteristic: C } = api.hap;
    const type = cfg.controllerType ?? 'auto';
    this.driver = type === 'pro' ? new ProDriver() : new ClassicDriver(false);
    this.detecting = type === 'auto';
    if (!this.detecting) this.diag.setType(type);
    if (type === 'pro') {
      this.log.info('Gouly Pro support is experimental: on/off, brightness and colour. Pattern recording is not '
        + 'supported yet. A controller report with sniff.py output helps add it: ' + reportUrl());
    }

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Gouly')
      .setCharacteristic(C.Model, type === 'pro' ? 'Gouly Pro controller' : 'Gouly controller')
      .setCharacteristic(C.SerialNumber, cfg.deviceId);

    // Lightbulb
    this.light = accessory.getService(S.Lightbulb) ?? accessory.addService(S.Lightbulb, cfg.name);
    this.light.getCharacteristic(C.On).onSet(v => {
      this.setOn(v as boolean);
      this.power?.updateCharacteristic(C.On, v as boolean);
    });
    this.light.getCharacteristic(C.Brightness).onSet(v => this.setBrightness(v as number));
    this.light.getCharacteristic(C.Hue).onSet(v => this.setHs({ hue: v as number }));
    this.light.getCharacteristic(C.Saturation).onSet(v => this.setHs({ saturation: v as number }));
    this.light.getCharacteristic(C.ColorTemperature)
      .setProps({ minValue: MIRED_MIN, maxValue: MIRED_MAX })
      .onSet(v => this.setMired(v as number));

    if (cfg.adaptiveLighting === true) {
      this.adaptive = new api.hap.AdaptiveLightingController(this.light);
      accessory.configureController(this.adaptive);
    }

    this.setupPowerSwitch();
    this.removeLegacyPatternSwitches();
    for (const pa of patternAccessories) this.syncPatternSwitches(pa.accessory, pa.patterns);

    this.store = new PatternStore(PatternStore.fileFor(api.user.storagePath(), cfg.deviceId));
    this.control = new ControlChannel(ControlChannel.dirFor(api.user.storagePath()), cfg.deviceId, r => this.preview(r),
      (active, until) => this.onRecordingChange(active, until), () => this.refreshFromController());
    this.control.start();

    this.conn = new GoulyConnection({
      id: cfg.deviceId, key: cfg.localKey, host: cfg.host || undefined, version: cfg.protocolVersion ?? '3.4', pythonPath: cfg.pythonPath, log: this.log,
    });
    this.commands = new CommandScheduler(() => this.driver, frames => this.send(frames));
    this.conn.on('frame', f => this.handleFrame(f));
    this.conn.on('switch', on => this.apply({ on }));
    this.conn.on('connected', ({ host, protocol }) => { this.diag.connected(host, protocol); this.onConnected(); });
    this.conn.on('disconnected', reason => this.diag.disconnected(reason));
    this.conn.on('unreachable', () => void this.rediscover());
    if (cfg.host) this.conn.start();
    else void this.rediscover();

    api.on('shutdown', () => {
      clearInterval(this.pollTimer);
      this.commands.flushNow();
      void this.diag.flush();
      this.control.stop();
      this.conn.stop();
    });
  }

  private discovering = false;

  /** Find the controller on the LAN (no host configured, or it stopped answering). */
  /**
   * Find the controller when its address is unknown or it stops answering (for
   * example after a DHCP change). The last known address is tried first; a full
   * search runs at most once per outage, then backs off from 5 minutes to 1 hour.
   * Each step is written to the diagnostics for the debug report.
   */
  private async rediscover(): Promise<void> {
    if (this.discovering) return;
    this.discovering = true;
    try {
      this.log.info(this.cfg.host ? `${this.cfg.name} not answering at ${this.conn.currentHost}; searching the network`
        : `Searching the network for ${this.cfg.name}`);
      const hint = this.conn.currentHost;
      const confirmed = hint && await confirmController(hint, this.cfg.deviceId, this.cfg.localKey,
        this.cfg.protocolVersion ?? '3.4', 8000, this.cfg.pythonPath);
      const host = confirmed ? hint : (await guidedSearch({
        id: this.cfg.deviceId, key: this.cfg.localKey, version: this.cfg.protocolVersion ?? '3.4', hint,
        pythonPath: this.cfg.pythonPath,
        onLine: line => { this.log.debug(line); this.diag.event(`search: ${line}`); },
      })).host;
      if (host) {
        this.rediscoverDelay = REDISCOVER_MIN_MS;
        if (host !== this.conn.currentHost) {
          this.log.info(`Found ${this.cfg.name} at ${host}. Tip: give it a DHCP reservation and set it in the config.`);
        }
        this.conn.setHost(host);
      } else {
        this.log.warn(`Could not find ${this.cfg.name}. Check that it is powered and that the Device ID and Local Key are current.`);
        if (!this.conn.currentHost) {
          setTimeout(() => void this.rediscover(), this.rediscoverDelay);
          this.rediscoverDelay = Math.min(this.rediscoverDelay * 2, REDISCOVER_MAX_MS);
        }
      }
    } finally {
      this.discovering = false;
    }
  }

  // ---------------------------------------------------------------- HomeKit -> controller

  private setOn(on: boolean): void {
    this.state.on = on;
    this.commands.setPower(on);
    this.refreshPatternSwitches();
  }

  /** A brightness or colour change while off turns the lights on; reflect that in HomeKit now. */
  private showOn(): void {
    if (this.state.on) return;
    this.state.on = true;
    const C = this.api.hap.Characteristic;
    this.light.updateCharacteristic(C.On, true);
    this.power?.updateCharacteristic(C.On, true);
    this.refreshPatternSwitches();
  }

  private setBrightness(percent: number): void {
    if (percent <= 0) {
      this.setOn(false);
      return;
    }
    this.state.brightness = Math.max(1, Math.round(percent * 2.55));
    this.showOn();
    this.commands.setBrightness(this.state.brightness);
  }

  /** Hue and Saturation arrive as two separate writes; combine them. */
  private setHs(part: { hue?: number; saturation?: number }): void {
    Object.assign(this.pendingHs, part);
    clearTimeout(this.hsTimer);
    this.hsTimer = setTimeout(() => {
      const C = this.api.hap.Characteristic;
      const hue = this.pendingHs.hue ?? (this.light.getCharacteristic(C.Hue).value as number);
      const sat = this.pendingHs.saturation ?? (this.light.getCharacteristic(C.Saturation).value as number);
      this.pendingHs = {};
      this.sendColour(hsToRgbw(hue, sat));
    }, COLOUR_DEBOUNCE_MS);
  }

  private setMired(mired: number): void {
    this.sendColour(miredToRgbw(mired));
  }

  private sendColour(rgbw: Rgbw): void {
    this.state.colour = rgbw;
    this.setActivePattern(undefined);
    this.showOn();
    this.commands.setLook({ kind: 'colour', rgbw });
  }

  private setPattern(config: PatternConfig, on: boolean): void {
    if (on) {
      try {
        this.activatePattern(config);
      } catch (err) {
        this.log.warn(`Pattern "${config.name}" is not valid and was not sent: ${(err as Error).message}`);
        setTimeout(() => this.setActivePattern(this.state.activePattern), 100);
      }
    } else if (this.state.activePattern === toHex(fromHex(config.frame))) {
      this.deactivatePattern();
    }
  }

  private activatePattern(config: PatternConfig): void {
    if (!this.driver.pattern) {
      this.log.warn('Patterns are not supported for this controller type yet');
      setTimeout(() => this.setActivePattern(this.state.activePattern), 100);
      return;
    }
    // Adaptive Lighting would keep overwriting the pattern with colour temperatures.
    if (this.adaptive?.isAdaptiveLightingActive()) this.adaptive.disableAdaptiveLighting();
    const body = fromHex(config.frame);
    this.checkPattern(body); // throws for a malformed pattern, before anything is queued
    this.setActivePattern(toHex(body));
    if (!this.state.on) this.commands.setPower(true);
    this.commands.setLook({ kind: 'pattern', body });
    this.apply({ on: true });
  }

  private deactivatePattern(): void {
    if (this.state.activePattern === undefined) return;
    this.setActivePattern(undefined);
    switch (this.cfg.patternOffAction ?? 'restore') {
      case 'restore': this.commands.setLook({ kind: 'colour', rgbw: this.state.colour }); break;
      case 'off': this.setOn(false); this.apply({ on: false }); break;
      case 'none': break;
    }
  }

  /** "Show on house" from the settings UI: play a pattern, then restore what was showing. */
  private preview(req: PreviewRequest): void {
    try {
      this.previewUnsafe(req);
    } catch (err) {
      this.log.warn(`Could not play that pattern on the house: ${(err as Error).message}`);
    }
  }

  private previewUnsafe(req: PreviewRequest): void {
    if (req.frame) {
      if (!this.driver.pattern) return;
      const body = fromHex(req.frame);
      this.checkPattern(body);
      this.beforePreview ??= { colour: this.state.colour, activePattern: this.state.activePattern, on: this.state.on };
      if (!this.state.on) this.commands.setPower(true);
      this.commands.setLook({ kind: 'pattern', body });
      return;
    }
    const before = this.beforePreview;
    this.beforePreview = undefined;
    if (!before) return;
    const favourite = (this.cfg.patterns ?? []).find(p => before.activePattern && toHex(fromHex(p.frame)) === before.activePattern);
    if (favourite && this.driver.pattern) this.commands.setLook({ kind: 'pattern', body: fromHex(favourite.frame) });
    else this.commands.setLook({ kind: 'colour', rgbw: before.colour });
    if (!before.on) this.commands.setPower(false);
  }

  // ---------------------------------------------------------------- controller -> HomeKit

  /** Everything sent to the controller goes through here (diagnostics, own-echo tracking). */
  private send(frames: Buffer[]): void {
    const now = Date.now();
    for (const f of frames) {
      this.diag.sent(f);
      this.recentlySent.set(f.toString('hex'), now);
    }
    for (const [hex, at] of this.recentlySent) {
      if (now - at > OWN_ECHO_MS) this.recentlySent.delete(hex);
    }
    this.conn.send(frames);
  }

  /** Re-read the controller's state report (settings page "Refresh from controller"). */
  private refreshFromController(): void {
    if (!this.conn.isConnected) {
      this.diag.event('refresh requested, but not connected');
      return;
    }
    this.diag.event('refresh requested');
    this.send(this.detecting || this.driver.kind === 'pro'
      ? [...new ClassicDriver(false).query(), ...new ProDriver().query()] : this.driver.query());
    setTimeout(() => {
      this.log.info(`${this.cfg.name}: ${this.diag.summary()}`);
      void this.diag.flush();
    }, 2500);
  }

  private onConnected(): void {
    if (this.detecting) {
      // Ask both families; whichever answers with a 0xBB report identifies the controller.
      this.send([...new ClassicDriver(false).query(), ...new ProDriver().query()]);
      setTimeout(() => {
        if (this.detecting) {
          this.detecting = false;
          this.diag.setType('unknown (assumed classic)');
          this.log.warn('Controller type not detected; assuming the single-output GOULY controller. '
            + 'If the lights do not respond, please send a controller report so it can be supported: ' + reportUrl());
        }
      }, DETECT_TIMEOUT_MS);
    } else {
      this.send(this.driver.query());
    }
    clearInterval(this.pollTimer);
    const every = Math.max(15, this.cfg.pollSeconds ?? 60) * 1000;
    this.pollTimer = setInterval(() => this.conn.isConnected && this.send(this.driver.query()), every);
  }

  private handleFrame(frame: Buffer): void {
    this.diag.received(frame);
    this.ownEcho = this.recentlySent.has(frame.toString('hex'));
    if (this.detecting && frame[0] === 0xbb) {
      if (frame[1] === 0xfc) this.driver = new ClassicDriver(false);
      else if (frame[1] === 0xb6) this.driver = new ProDriver();
      else return;
      this.detecting = false;
      this.diag.setType(this.driver.kind);
      this.log.info(`Detected a ${this.driver.kind} controller`);
      if (this.driver.kind === 'pro') {
        this.log.info('Gouly Pro support is experimental: on/off, brightness and colour. Pattern recording is not '
          + 'supported yet. A controller report with sniff.py output helps add it: ' + reportUrl());
      }
    }
    let update: StateUpdate;
    try {
      update = this.driver.parse(frame);
    } catch (err) {
      this.log.debug(`Ignoring frame ${frame.toString('hex')}: ${(err as Error).message}`);
      return;
    }
    this.noteUnknown(frame);
    this.apply(update);
  }

  /** Commands seen for the first time that we have not decoded (e.g. E3/E7): logged once each. */
  private readonly unknownSeen = new Set<string>();
  private noteUnknown(frame: Buffer): void {
    const known = this.driver.kind === 'classic' ? KNOWN_CLASSIC : undefined;
    if (!known) return;
    const key = frame.subarray(0, 2).toString('hex');
    if (known.has(key) || this.unknownSeen.has(key)) return;
    this.unknownSeen.add(key);
    this.diag.unrecognized(frame);
    this.log.info(`Unrecognized command ${key} from the controller or Gouly app: ${frame.toString('hex')} `
      + '(harmless; please note what you just did in the app)');
  }

  private infoLogged = '';

  private apply(u: StateUpdate): void {
    const C = this.api.hap.Characteristic;
    if (u.info) {
      const key = JSON.stringify(u.info);
      if (key !== this.infoLogged) {
        this.infoLogged = key;
        this.log.info(`${this.cfg.name}: ${this.diag.summary()}`);
      }
    }
    if (u.on !== undefined) {
      this.state.on = u.on;
      this.commands.notePower(u.on);
      this.light.updateCharacteristic(C.On, u.on);
      this.power?.updateCharacteristic(C.On, u.on);
      this.refreshPatternSwitches();
    }
    if (u.brightness !== undefined && u.brightness > 0) {
      this.state.brightness = u.brightness;
      this.light.updateCharacteristic(C.Brightness, Math.max(1, Math.round(u.brightness / 2.55)));
    }
    if (u.rgbw) {
      this.state.colour = u.rgbw;
      this.setActivePattern(undefined);
      const hk = rgbwToHomeKit(u.rgbw);
      if (hk.mode === 'white') {
        this.light.updateCharacteristic(C.ColorTemperature, hk.mired);
      } else {
        this.light.updateCharacteristic(C.Hue, hk.hue);
        this.light.updateCharacteristic(C.Saturation, hk.saturation);
      }
    }
    if (u.pattern) {
      this.setActivePattern(toHex(u.pattern));
      this.recordPattern(u.pattern);
    }
  }

  private checkPattern(body: Buffer): void {
    if (this.driver.kind === 'classic') validatePatternBody(body);
  }

  private onRecordingChange(active: boolean, until?: Date): void {
    if (!active) {
      this.log.info('Recording stopped');
    } else if (this.driver.kind === 'pro') {
      this.log.warn('Pattern recording is not supported on the Gouly Pro yet, so nothing will be recorded. '
        + 'A controller report with sniff.py output helps add it: ' + reportUrl());
    } else {
      this.log.info(`Recording patterns until ${until!.toLocaleTimeString()}: apply patterns in the Gouly app now`);
    }
  }

  /** Only well-formed F6 pattern frames are ever recorded; nothing else the app sends is stored. */
  private recordPattern(body: Buffer): void {
    let summary: string;
    try {
      validatePatternBody(body);
      summary = describePattern(body).summary;
    } catch (err) {
      this.log.debug(`Ignoring malformed pattern frame ${toHex(body)}: ${(err as Error).message}`);
      return;
    }
    if (this.ownEcho) {
      this.log.debug(`Pattern sent by this plugin, not recorded: ${summary}`);
      return;
    }
    if (!this.control.isRecording) {
      this.log.debug(`Pattern applied (not recording): ${summary}`);
      return;
    }
    void this.store.add(body).then(isNew => {
      this.log.info(isNew ? `Recorded new pattern: ${summary}` : `Already recorded: ${summary}`);
    }).catch(err => this.log.warn(`Could not save recorded pattern: ${(err as Error).message}`));
  }

  // ---------------------------------------------------------------- pattern switches

  private setActivePattern(frameHex: string | undefined): void {
    this.state.activePattern = frameHex;
    this.refreshPatternSwitches();
  }

  /**
   * A pattern switch is on when its pattern is the active one and the lights are on.
   * Power off shows every pattern switch off; power on again resumes the pattern
   * on the controller, so its switch comes back on too.
   */
  private refreshPatternSwitches(): void {
    const C = this.api.hap.Characteristic;
    const active = this.state.on ? this.state.activePattern : undefined;
    for (const { config, service } of this.patternSwitches.values()) {
      service.updateCharacteristic(C.On, active !== undefined && toHex(fromHex(config.frame)) === active);
    }
  }

  /**
   * Plain on/off switch next to the light, so everyday use is one tap (the light
   * tile opens the dimmer). Turning it on restores the last brightness and colour;
   * the slider stays a real dimmer. Show it as its own tile via the Home app's
   * "Show as Separate Tiles".
   */
  private setupPowerSwitch(): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const existing = this.accessory.getServiceById(S.Switch, POWER_SUBTYPE);
    if (this.cfg.powerSwitch === false) {
      if (existing) this.accessory.removeService(existing);
      return;
    }
    const name = `${this.cfg.name} Power`;
    const service = existing ?? this.accessory.addService(S.Switch, name, POWER_SUBTYPE);
    service.setCharacteristic(C.Name, name);
    if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
    if (!existing) service.setCharacteristic(C.ConfiguredName, name);
    service.getCharacteristic(C.On).onSet(v => {
      const on = v as boolean;
      this.setOn(on);
      this.light.updateCharacteristic(C.On, on);
    });
    this.power = service;
  }

  /**
   * Pattern switches used to live on the light's accessory. They now have their own
   * accessory ("<name> Patterns"), so the light holds only the slider and power switch.
   */
  private removeLegacyPatternSwitches(): void {
    const S = this.api.hap.Service;
    for (const service of [...this.accessory.services]) {
      if (service.UUID === S.Switch.UUID && service.subtype && service.subtype !== POWER_SUBTYPE) {
        this.accessory.removeService(service);
      }
    }
  }

  private syncPatternSwitches(acc: PlatformAccessory, patterns: PatternConfig[]): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    acc.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Gouly')
      .setCharacteristic(C.Model, 'Patterns')
      .setCharacteristic(C.SerialNumber, `${this.cfg.deviceId}-patterns`);
    const wanted = new Set<string>();
    for (const p of patterns) {
      if (!p?.frame || !p.name) continue;
      const subtype = p.id ?? `pattern-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      wanted.add(subtype);
      const service = acc.getServiceById(S.Switch, subtype) ?? acc.addService(S.Switch, p.name, subtype);
      service.setCharacteristic(C.Name, p.name);
      if (!service.testCharacteristic(C.ConfiguredName)) service.addOptionalCharacteristic(C.ConfiguredName);
      service.setCharacteristic(C.ConfiguredName, p.name);
      service.getCharacteristic(C.On).removeOnSet().onSet(v => this.setPattern(p, v as boolean));
      service.updateCharacteristic(C.On, false);
      this.patternSwitches.set(subtype, { config: p, service });
    }
    for (const service of [...acc.services]) {
      if (service.UUID === S.Switch.UUID && service.subtype && !wanted.has(service.subtype)) {
        acc.removeService(service);
      }
    }
  }
}

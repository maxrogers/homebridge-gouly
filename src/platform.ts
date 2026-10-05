import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';
import { GoulyAccessory } from './accessory';
import { DEFAULT_GROUP, DeviceConfig, GoulyPlatformConfig, PatternConfig, PLATFORM_NAME, PLUGIN_NAME } from './settings';

export interface PatternAccessory {
  accessory: PlatformAccessory;
  patterns: PatternConfig[];
}

export class GoulyPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();

  constructor(private readonly log: Logger, config: PlatformConfig, private readonly api: API) {
    const cfg = config as GoulyPlatformConfig;
    api.on('didFinishLaunching', () => this.setup(cfg.devices ?? []));
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private setup(devices: DeviceConfig[]): void {
    const active = new Set<string>();
    for (const device of devices) {
      const missing = (['name', 'deviceId', 'localKey'] as const).filter(k => !device[k]);
      if (missing.length) {
        this.log.error(`Skipping a controller: missing ${missing.join(', ')}`);
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`gouly:${device.deviceId}`);
      active.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(device.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${device.name}`);
      }
      // Pattern switches live in their own accessory (one per group when grouping is on),
      // so the light keeps just the slider and power switch.
      const patternAccessories = this.patternAccessories(device, active);

      new GoulyAccessory(this.api, this.log, accessory, device, patternAccessories);
    }
    const stale = [...this.cached.values()].filter(a => !active.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  /** One accessory per non-empty pattern group; the default group keeps the original UUID. */
  private patternAccessories(device: DeviceConfig, active: Set<string>): PatternAccessory[] {
    const valid = (device.patterns ?? []).filter(p => p?.frame && p.name);
    const grouping = device.groupsEnabled === true;
    // A group's name is its tile name. The default group follows the controller's
    // name ("House Lights Patterns") until the user renames it.
    const groups = new Map<string, string>([[DEFAULT_GROUP, `${device.name} Patterns`]]);
    if (grouping) {
      for (const g of device.groups ?? []) {
        if (g?.id && g.name) groups.set(g.id, g.name);
      }
    } else {
      const named = (device.groups ?? []).find(g => g?.id === DEFAULT_GROUP && g.name);
      if (named) groups.set(DEFAULT_GROUP, named.name);
    }
    const byGroup = new Map<string, PatternConfig[]>();
    for (const p of valid) {
      const gid = grouping && p.group && groups.has(p.group) ? p.group : DEFAULT_GROUP;
      byGroup.set(gid, [...(byGroup.get(gid) ?? []), p]);
    }
    const out: PatternAccessory[] = [];
    for (const [gid, patterns] of byGroup) {
      const uuid = this.api.hap.uuid.generate(
        gid === DEFAULT_GROUP ? `gouly-patterns:${device.deviceId}` : `gouly-patterns:${device.deviceId}:${gid}`);
      active.add(uuid);
      const name = groups.get(gid) as string;
      let acc = this.cached.get(uuid);
      if (!acc) {
        acc = new this.api.platformAccessory(name, uuid, this.api.hap.Categories.SWITCH);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.log.info(`Added ${name}`);
      } else if (acc.displayName !== name) {
        acc.displayName = name;
        acc.getService(this.api.hap.Service.AccessoryInformation)?.setCharacteristic(this.api.hap.Characteristic.Name, name);
        this.api.updatePlatformAccessories([acc]);
      }
      out.push({ accessory: acc, patterns });
    }
    return out;
  }
}

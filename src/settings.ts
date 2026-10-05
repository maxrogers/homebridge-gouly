export const PLATFORM_NAME = 'Gouly';
export const PLUGIN_NAME = 'homebridge-gouly';

export interface PatternConfig {
  id?: string;       // stable id so renaming keeps HomeKit automations
  name: string;
  frame: string;     // pattern body hex, starting with f6
  /** Where it came from: recorded from the Gouly app, an edited recording, or built from scratch. */
  source?: 'recorded' | 'edited' | 'custom';
  /** For edited patterns: the recorded frame it was based on. */
  sourceFrame?: string;
  /** Group id (only used when the controller's groupsEnabled is on). */
  group?: string;
}

export const DEFAULT_GROUP = 'default';

export interface PatternGroup {
  id: string; // stable: renaming a group keeps its HomeKit accessory
  name: string;
}

export interface DeviceConfig {
  name: string;
  deviceId: string;
  localKey: string;
  host?: string;
  protocolVersion?: '3.3' | '3.4' | '3.5';
  controllerType?: 'auto' | 'classic' | 'pro';
  adaptiveLighting?: boolean;
  patternOffAction?: 'restore' | 'off' | 'none';
  pollSeconds?: number;
  /** Separate on/off switch next to the light (default on). */
  powerSwitch?: boolean;
  /** Advanced: each pattern group becomes its own accessory in the Home app. */
  groupsEnabled?: boolean;
  /** Pattern groups; the entry with id "default" (if present) names the default group. */
  groups?: PatternGroup[];
  /** Python 3 interpreter for the transport bridge (default: python3 on the PATH). */
  pythonPath?: string;
  /** Write every command and reply to the normal log for this controller. */
  verboseLogging?: boolean;
  patterns?: PatternConfig[];
}

export interface GoulyPlatformConfig {
  platform: string;
  name?: string;
  devices?: DeviceConfig[];
}

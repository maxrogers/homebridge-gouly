// The platform: cached accessories pick up names changed in the settings.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { HomebridgeAPI } = require('homebridge/lib/api');
const { GoulyPlatform } = require('../dist/platform');

test('renaming a controller or group renames its cached accessories', { timeout: 30000 }, async () => {
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gouly-'));
  const api = new HomebridgeAPI();
  api.user.storagePath = () => storage;
  const log = Object.assign(() => {}, { info() {}, warn() {}, debug() {}, error() {} });
  const uuid = api.hap.uuid.generate;
  const light = new api.platformAccessory('Old Name', uuid('gouly:bf01'));
  const group = new api.platformAccessory('Old Name Patterns', uuid('gouly-patterns:bf01'));
  const updated = [];
  api.on('updatePlatformAccessories', accs => updated.push(...accs));
  const platform = new GoulyPlatform(log, { platform: 'Gouly', name: 'Gouly', devices: [{
    name: 'Front Lights', deviceId: 'bf01', localKey: 'k', host: '10.0.0.5', controllerType: 'classic',
    patterns: [{ id: 'x', name: 'Christmas', frame: 'f6 03 07 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 ff ff ff ff' }],
  }] }, api);
  platform.configureAccessory(light);
  platform.configureAccessory(group);
  try {
    api.emit('didFinishLaunching');
    await new Promise(r => setTimeout(r, 800)); // let the bridge start before shutting down
    for (const [acc, name] of [[light, 'Front Lights'], [group, 'Front Lights Patterns']]) {
      assert.equal(acc.displayName, name);
      assert.equal(acc._associatedHAPAccessory.displayName, name, 'the HAP accessory is renamed too');
      assert.equal(acc.getService(api.hap.Service.AccessoryInformation).getCharacteristic(api.hap.Characteristic.Name).value, name);
      assert.ok(updated.includes(acc), 'saved to the accessory cache');
    }
  } finally {
    api.emit('shutdown');
  }
});

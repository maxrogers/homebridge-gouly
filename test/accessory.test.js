// Drives the real accessory through HomeKit characteristics, with the mock controller.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { HomebridgeAPI } = require('homebridge/lib/api');
const { GoulyAccessory } = require('../dist/accessory');

const X = 'f6 03 07 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 ff ff ff ff';
const H = 'f6 01 07 00 00 ff 04 00 00 00 00 ff 66 00 00 00 00 00 00 66 00 66 00 f8 f8 ff 00';
const wait = ms => new Promise(r => setTimeout(r, ms));

test('pattern switches show off while the lights are off, and resume with power', async () => {
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gouly-'));
  const api = new HomebridgeAPI();
  api.user.storagePath = () => storage;
  const { Service: S, Characteristic: C } = api.hap;
  const log = Object.assign(() => {}, { info() {}, warn() {}, debug() {}, error() {} });
  const light = new api.platformAccessory('House Lights', api.hap.uuid.generate('l'));
  const group = new api.platformAccessory('House Lights Patterns', api.hap.uuid.generate('g'));
  const cfg = { name: 'House Lights', deviceId: 'bf01', localKey: 'k', host: '10.0.0.5', controllerType: 'classic',
    patterns: [{ id: 'x', name: 'Christmas', frame: X }, { id: 'h', name: 'Halloween', frame: H }] };
  new GoulyAccessory(api, log, light, cfg, [{ accessory: group, patterns: cfg.patterns }]);
  try {
    await wait(800); // bridge connects to the mock controller
    const sw = id => group.getServiceById(S.Switch, id).getCharacteristic(C.On);
    const power = light.getServiceById(S.Switch, 'power').getCharacteristic(C.On);
    const state = () => [power.value, sw('x').value, sw('h').value];

    await sw('x').setValue(true); await wait(50);
    assert.deepEqual(state(), [true, true, false], 'Christmas on');
    await power.setValue(false); await wait(50);
    assert.deepEqual(state(), [false, false, false], 'power off: pattern switch shows off');
    await power.setValue(true); await wait(50);
    assert.deepEqual(state(), [true, true, false], 'power on: pattern resumes and shows on again');
    await sw('h').setValue(true); await wait(50);
    assert.deepEqual(state(), [true, false, true], 'switching patterns turns the other off');
  } finally {
    api.emit('shutdown');
    await wait(300);
  }
});

test('two controllers with groups stay independent', async () => {
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  const logFile = path.join(os.tmpdir(), `mock-two-${process.pid}.log`);
  process.env.MOCK_TUYA_LOG = logFile;
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gouly-'));
  const api = new HomebridgeAPI();
  api.user.storagePath = () => storage;
  const { Service: S, Characteristic: C } = api.hap;
  const log = Object.assign(() => {}, { info() {}, warn() {}, debug() {}, error() {}, success() {}, log() {} });
  const make = (name, id, host, pats) => {
    const light = new api.platformAccessory(name, api.hap.uuid.generate(name));
    const g = new api.platformAccessory(`${name} Holidays`, api.hap.uuid.generate(name + 'g'));
    const cfg = { name, deviceId: id, localKey: 'k', host, controllerType: 'classic', groupsEnabled: true,
      groups: [{ id: 'g-h', name: 'Holidays' }], patterns: pats };
    new GoulyAccessory(api, log, light, cfg, [{ accessory: g, patterns: pats }]);
    return g;
  };
  const a = make('House', 'bf01', '10.0.0.5', [{ id: 'x', name: 'Christmas', frame: X, group: 'g-h' }, { id: 'h', name: 'Halloween', frame: H, group: 'g-h' }]);
  const b = make('Garage', 'bf02', '10.0.0.6', [{ id: 'x2', name: 'Christmas', frame: X, group: 'g-h' }, { id: 'h2', name: 'Halloween', frame: H, group: 'g-h' }]);
  try {
    await wait(900);
    const on = (acc, id) => acc.getServiceById(S.Switch, id).getCharacteristic(C.On);
    await on(a, 'x').setValue(true); await wait(50);
    await on(b, 'h2').setValue(true); await wait(600);
    assert.deepEqual([on(a, 'x').value, on(a, 'h').value, on(b, 'x2').value, on(b, 'h2').value], [true, false, false, true],
      'each controller keeps its own active pattern');
    const sets = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.op === 'set');
    const patternHost = hex => sets.filter(e => Buffer.from(e.value, 'base64').toString('hex').startsWith(hex)).map(e => e.host);
    assert.deepEqual([...new Set(patternHost('aaf603'))], ['10.0.0.5'], 'Christmas went to the house controller only');
    assert.deepEqual([...new Set(patternHost('aaf601'))], ['10.0.0.6'], 'Halloween went to the garage controller only');
  } finally {
    api.emit('shutdown');
    delete process.env.MOCK_TUYA_LOG;
    await wait(300);
  }
});

test('recording ignores the plugin\'s own echoes; diagnostics capture the state report; refresh re-queries', async () => {
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'gouly-'));
  const gdir = path.join(storage, 'gouly');
  fs.mkdirSync(gdir);
  const logFile = path.join(os.tmpdir(), `mock-rec-${process.pid}.log`);
  const inject = path.join(os.tmpdir(), `mock-inject-${process.pid}.txt`);
  process.env.MOCK_TUYA_LOG = logFile;
  process.env.MOCK_TUYA_INJECT = inject;
  const api = new HomebridgeAPI();
  api.user.storagePath = () => storage;
  const lines = [];
  const log = Object.assign(() => {}, { info: m => lines.push(m), warn: m => lines.push(m), debug() {}, error() {}, success() {}, log() {} });
  const light = new api.platformAccessory('House Lights', api.hap.uuid.generate('rec'));
  const cfg = { name: 'House Lights', deviceId: 'bfrec', localKey: 'k', host: '10.0.0.5', controllerType: 'classic', patterns: [] };
  new GoulyAccessory(api, log, light, cfg, []);
  const crcFrame = body => {
    let crc = 0;
    const bytes = Buffer.from('aa' + body, 'hex');
    for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0x8c : crc >> 1; }
    return Buffer.concat([bytes, Buffer.from([crc])]).toString('hex');
  };
  try {
    await wait(800);
    fs.writeFileSync(path.join(gdir, 'recording-bfrec.json'), JSON.stringify({ until: new Date(Date.now() + 60000).toISOString() }));
    await wait(1700);
    // 1. the plugin plays a pattern on the house: its echo must not be recorded
    fs.writeFileSync(path.join(gdir, 'preview-bfrec.json'), JSON.stringify({ frame: X, at: 'p1' }));
    await wait(2200);
    const capturedFile = path.join(gdir, 'captured-bfrec.json');
    const capturedNow = () => (fs.existsSync(capturedFile) ? JSON.parse(fs.readFileSync(capturedFile, 'utf8')) : []);
    assert.equal(capturedNow().length, 0, 'own echo not recorded');
    // 2. the Gouly app applies a pattern (and the controller sends its state report)
    fs.writeFileSync(inject, [crcFrame(H.replace(/ /g, '')), 'bbfc01ff050000a2010301000107001300' + '91'].join('\n'));
    await wait(1500);
    assert.equal(capturedNow().length, 1, 'app pattern recorded');
    // 3. diagnostics file
    await wait(1200);
    const info = JSON.parse(fs.readFileSync(path.join(gdir, 'info-bfrec.json'), 'utf8'));
    assert.equal(info.type, 'classic');
    assert.equal(info.pixels, 162);
    assert.equal(info.icType, 'UCS2904 (RGBW)');
    assert.equal(info.rgbOrder, 'RGB');
    assert.ok(info.frames.some(f => f.includes('-> aaf6')) && info.frames.some(f => f.includes('<- bbfc')), 'frames logged both ways');
    assert.ok(lines.some(m => /House Lights: GOULY single output, 162 pixels, IC UCS2904 \(RGBW\), order RGB, protocol 3\.4/.test(m)), 'summary logged');
    // 4. refresh from the settings page re-queries the controller
    const before = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.includes('"set"')).length;
    fs.writeFileSync(path.join(gdir, 'refresh-bfrec.json'), JSON.stringify({ at: 'r1' }));
    await wait(2000);
    const after = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.op === 'set');
    assert.ok(after.length > before && after.slice(before).some(e => Buffer.from(e.value, 'base64').toString('hex').startsWith('aafc')), 'state query sent');
  } finally {
    api.emit('shutdown');
    delete process.env.MOCK_TUYA_LOG; delete process.env.MOCK_TUYA_INJECT;
    await wait(300);
  }
});

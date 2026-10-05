// End to end: the real GoulyConnection driving the real python/gouly_bridge.py,
// with a mock tinytuya standing in for the controller.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GoulyConnection } = require('../dist/connection');
const { ClassicDriver } = require('../dist/protocol/classic');

const quiet = { debug() {}, info() {}, warn() {} };
const once = (em, ev, ms = 8000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
  em.once(ev, v => { clearTimeout(t); resolve(v); });
});

function setup() {
  const logFile = path.join(os.tmpdir(), `mocktuya-${process.pid}-${Date.now()}.log`);
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  process.env.MOCK_TUYA_LOG = logFile;
  const read = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  return { read };
}

test('connects, sends frames on DP 101 in order, and reports the echoes', async () => {
  const { read } = setup();
  const conn = new GoulyConnection({ id: 'bf0123', key: '0123456789abcdef', host: '10.0.0.5', version: '3.4', log: quiet });
  const switched = once(conn, 'switch');
  conn.start();
  await once(conn, 'connected');
  assert.equal(conn.isConnected, true);
  assert.equal(await switched, true);

  const d = new ClassicDriver(true);
  const sent = [...d.power(true), ...d.brightness(0x40)];
  const echoes = [];
  conn.on('frame', f => echoes.push(f.toString('hex')));
  conn.send(sent);
  const deadline = Date.now() + 5000;
  while (echoes.length < sent.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(echoes, sent.map(f => f.toString('hex')), 'every frame echoed, in order');

  const log = read();
  const status = log.find(e => e.op === 'status');
  assert.equal(status.host, '10.0.0.5'); assert.equal(status.version, 3.4); assert.equal(status.key, '0123456789abcdef');
  const sets = log.filter(e => e.op === 'set');
  assert.ok(sets.every(e => e.index === 101));
  assert.deepEqual(sets.map(e => Buffer.from(e.value, 'base64').toString('hex')), sent.map(f => f.toString('hex')));

  conn.stop();
});

test('a key with shell-special characters reaches the device intact', async () => {
  const { read } = setup();
  const key = "-]~Zw0[a'b\"c$d!";
  const conn = new GoulyConnection({ id: 'bf0123', key, host: '10.0.0.5', version: '3.4', log: quiet });
  conn.start();
  await once(conn, 'connected');
  assert.equal(read().find(e => e.op === 'status').key, key);
  conn.stop();
});

test('bad address: no connection; switching host connects', async () => {
  setup();
  const conn = new GoulyConnection({ id: 'bf0123', key: 'k', host: '10.0.0.250', version: '3.4', log: quiet });
  conn.start();
  await new Promise(r => setTimeout(r, 800));
  assert.equal(conn.isConnected, false);
  conn.setHost('10.0.0.6');
  await once(conn, 'connected', 10000);
  assert.equal(conn.currentHost, '10.0.0.6');
  conn.stop();
});

test('sends queued while disconnected go out once connected', async () => {
  const { read } = setup();
  const conn = new GoulyConnection({ id: 'bf0123', key: 'k', host: '10.0.0.250', version: '3.4', log: quiet });
  conn.start();
  await new Promise(r => setTimeout(r, 400));
  conn.send(new ClassicDriver(false).power(false));
  conn.setHost('10.0.0.7');
  await once(conn, 'connected', 10000);
  const deadline = Date.now() + 4000;
  while (!read().some(e => e.op === 'set') && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.ok(read().some(e => e.op === 'set'), 'queued power-off was sent after connecting');
  conn.stop();
});

test('bridge dying mid-write does not throw; it restarts', async () => {
  setup();
  const conn = new GoulyConnection({ id: 'bf0123', key: 'k', host: '10.0.0.5', version: '3.4', log: quiet });
  conn.start();
  await once(conn, 'connected');
  conn['proc'].kill('SIGKILL');
  for (let i = 0; i < 20; i++) conn.send(new ClassicDriver(false).power(true)); // writes race the exit
  await once(conn, 'disconnected', 3000).catch(() => {});
  await once(conn, 'connected', 10000); // restarted after RESTART_DELAY_MS
  conn.stop();
});

test('a controller on a different protocol version is found automatically', async () => {
  const { read } = setup();
  process.env.MOCK_TUYA_VERSION = '3.3';
  const logs = [];
  const log = { debug() {}, info: m => logs.push(m), warn: m => logs.push(m) };
  const conn = new GoulyConnection({ id: 'bf0123', key: 'k', host: '10.0.0.5', version: '3.4', log });
  try {
    conn.start();
    await once(conn, 'connected');
    const tried = read().filter(e => e.op === 'status').map(e => e.version);
    assert.deepEqual(tried.slice(0, 2), [3.4, 3.5], 'configured version first, then the others');
    assert.ok(logs.some(m => /protocol 3\.3/.test(m) && /Set Tuya protocol to 3\.3/.test(m)), 'tells the user which version to set');
    assert.ok(logs.some(m => /Connected to 10\.0\.0\.5 \(protocol 3\.3\)/.test(m)));
  } finally {
    delete process.env.MOCK_TUYA_VERSION;
    conn.stop();
  }
});

test('a network error does not cycle through protocol versions', async () => {
  const { read } = setup();
  const conn = new GoulyConnection({ id: 'bf0123', key: 'k', host: '10.0.0.250', version: '3.4', log: quiet });
  conn.start();
  await new Promise(r => setTimeout(r, 800));
  conn.stop();
  assert.deepEqual(read().filter(e => e.op === 'status').map(e => e.version), [3.4]);
});

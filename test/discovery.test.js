const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const {
  isPortOpen, scanForTuyaHosts, confirmController, lanInterfaces, macVendor, describe, guidedSearch,
} = require('../dist/discovery');
const { explainNotFound } = require('../dist/accessory');

const KEY = '0123456789abcdef';
const WRONG = 'fedcba9876543210';
const realEnv = () => { delete process.env.GOULY_BRIDGE_EXTRA_PATH; };

// Only 127.0.0.1 is used: macOS has no other loopback addresses.
async function fakeDevice(mode) {
  const env = { ...process.env };
  delete env.GOULY_BRIDGE_EXTRA_PATH;
  const proc = spawn('python3', [path.join(__dirname, 'fixtures', 'fake_tuya_device.py'), mode, KEY], { env });
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fake device did not start')), 10000);
    proc.on('exit', code => { clearTimeout(t); reject(new Error(`fake device exited (${code})`)); });
    readline.createInterface({ input: proc.stdout }).once('line', l => { clearTimeout(t); resolve(Number(l)); });
  });
  return { port, stop: () => proc.kill() };
}

test('port scan finds listeners and skips closed ports', async () => {
  const server = net.createServer(s => s.destroy()).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const port = server.address().port;
  try {
    assert.equal(await isPortOpen('127.0.0.1', port), true);
    assert.equal(await isPortOpen('127.0.0.1', port + 1, 300), false);
    assert.deepEqual(await scanForTuyaHosts(['127.0.0.1'], 4, port), ['127.0.0.1']);
  } finally {
    server.close();
  }
});

test('only real LAN interfaces are searched', () => {
  const a = (address, internal = false) => [{ family: 'IPv4', address, internal }];
  const found = lanInterfaces({
    eth0: a('192.168.50.20'), docker0: a('172.17.0.1'), 'br-1a2b3c': a('172.19.0.1'), tailscale0: a('100.101.102.5'),
    utun3: a('10.8.0.2'), lo: a('127.0.0.1', true), en0: a('192.168.1.5'), wlan0: a('100.80.0.9'),
  });
  assert.deepEqual(found.map(i => i.network), ['192.168.50.0/24', '192.168.1.0/24']);
});

test('Tuya MAC prefixes are recognised', () => {
  assert.equal(macVendor('C4:82:E1:00:11:22'), 'Tuya');
  assert.equal(macVendor('fc:67:1f:aa:bb:cc'), 'Tuya');
  assert.equal(macVendor('3c:22:fb:00:00:01'), undefined);
  assert.equal(macVendor(undefined), undefined);
});

test('each device gets a plain status and note', () => {
  const k = { id: 'bf01', key: KEY };
  assert.equal(describe({ ip: 'a', key: 'ok' }, k).status, 'confirmed');
  const wrong = describe({ ip: 'a', key: 'wrong', tuya: 'likely' }, k);
  assert.equal(wrong.status, 'wrong-key');
  assert.match(wrong.note, /did not accept this Local Key.*get the keys again/);
  const nokey = describe({ ip: 'a', vendor: 'Tuya' }, {});
  assert.equal(nokey.status, 'probable');
  assert.match(nokey.note, /Add the Device ID and Local Key/);
  assert.equal(describe({ ip: 'a', tuya: 'no' }, {}).status, 'possible');
  assert.equal(describe({ ip: 'a', announcedId: 'bf99' }, k).status, 'other');
  assert.equal(describe({ ip: 'a', announcedId: 'bf01', key: 'wrong' }, k).status, 'wrong-key');
  // a phone with a private (random) MAC that happens to close the connection is not Tuya-like
  assert.equal(describe({ ip: 'a', mac: '2a:11:22:33:44:55', tuya: 'likely' }, {}).status, 'possible');
  assert.equal(describe({ ip: 'a', mac: 'c4:82:e1:00:11:22', tuya: 'likely' }, {}).status, 'probable');
  // the controller announced itself but its port did not answer, with a key entered
  const busy = describe({ ip: 'a', announcedId: 'bf01' }, k);
  assert.match(busy.note, /not accepting connections right now/);
  assert.doesNotMatch(busy.note, /Add the Local Key/);
  for (const c of [wrong, nokey]) assert.ok(!/\u2014/.test(c.note), 'no em dashes');
});

test('Find lists a Tuya device without keys, with a wrong key, and confirms the right key', { timeout: 120000 }, async () => {
  realEnv();
  const dev = await fakeDevice('v34');
  const opts = { hosts: ['127.0.0.1'], port: dev.port, scanTimeoutMs: 500, probeTimeoutSec: 2 };
  try {
    let lines = [];
    let r = await guidedSearch({ ...opts, onLine: l => lines.push(l) });
    assert.equal(r.host, undefined);
    assert.deepEqual(r.candidates.map(c => [c.ip, c.status]), [['127.0.0.1', 'probable']]);
    assert.ok(lines.some(l => /Add the Device ID and Local Key, then search again/.test(l)), lines.join('\n'));

    lines = [];
    r = await guidedSearch({ ...opts, key: WRONG, onLine: l => lines.push(l) });
    assert.equal(r.host, undefined);
    assert.equal(r.candidates[0].status, 'wrong-key');
    assert.ok(lines.some(l => /did not accept this Local Key.*get the keys again/.test(l)), lines.join('\n'));
    assert.ok(!lines.join('\n').includes(WRONG), 'the key is never logged');
    assert.match(explainNotFound(r.candidates), /127\.0\.0\.1 did not accept the Local Key/);

    lines = [];
    r = await guidedSearch({ ...opts, key: KEY, onLine: l => lines.push(l) });
    assert.equal(r.host, '127.0.0.1');
    assert.equal(r.candidates[0].status, 'confirmed');
    assert.ok(lines.some(l => /Found your controller at 127\.0\.0\.1/.test(l)));

    // The plugin's search stops once the saved address is confirmed. 192.0.2.1 is a
    // documentation address: sweeping it would take the full 4 s timeout.
    const t = Date.now();
    r = await guidedSearch({ ...opts, hosts: ['127.0.0.1', '192.0.2.1'], scanTimeoutMs: 4000, key: KEY,
      hint: '127.0.0.1', stopWhenConfirmed: true, onLine() {} });
    assert.equal(r.host, '127.0.0.1');
    assert.ok(Date.now() - t < 3500, 'did not sweep the rest');
  } finally {
    dev.stop();
  }
});

test('a device that does not behave like Tuya is listed as possible', { timeout: 60000 }, async () => {
  realEnv();
  const dev = await fakeDevice('other');
  try {
    const r = await guidedSearch({ hosts: ['127.0.0.1'], port: dev.port, scanTimeoutMs: 500, probeTimeoutSec: 2, onLine() {} });
    assert.deepEqual(r.candidates.map(c => c.status), ['possible']);
  } finally {
    dev.stop();
  }
});

test('Find says when the plugin is already connected, without probing it', { timeout: 60000 }, async () => {
  realEnv();
  const lines = [];
  const r = await guidedSearch({ hosts: [], connectedHost: '10.9.9.9', id: 'bf01', key: KEY, onLine: l => lines.push(l) });
  assert.equal(r.host, '10.9.9.9');
  assert.equal(r.candidates[0].status, 'connected');
  assert.ok(lines.some(l => /connected to it right now/.test(l)));
});

test('without Python, Find still lists what the port scan found', { timeout: 60000 }, async () => {
  const server = net.createServer(s => s.destroy()).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  try {
    const lines = [];
    const r = await guidedSearch({ hosts: ['127.0.0.1'], port: server.address().port, scanTimeoutMs: 500,
      pythonPath: '/nonexistent/python3', onLine: l => lines.push(l) });
    assert.deepEqual(r.candidates.map(c => c.ip), ['127.0.0.1']);
    assert.ok(lines.some(l => /Could not run the Python helper/.test(l)), lines.join('\n'));
  } finally {
    server.close();
  }
});

test('key check: a device that does not answer is not confirmed', { timeout: 60000 }, async () => {
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  // the mock refuses 10.0.0.250 (network error) and 10.0.0.66 (key), and accepts others
  assert.equal(await confirmController('10.0.0.250', 'bf01', 'k', '3.4', 3000), false);
  const t = Date.now();
  assert.equal(await confirmController('10.0.0.66', 'bf01', 'k', '3.4', 8000), false);
  assert.ok(Date.now() - t < 4000, 'a refused key ends the check at once');
  assert.equal(await confirmController('10.0.0.5', 'bf01', 'k', '3.4', 5000), true);
});

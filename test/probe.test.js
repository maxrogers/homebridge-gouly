// Find's device probe (python/gouly_probe.py) and the bridge's connection timing,
// run with the real bundled tinytuya against fake Tuya devices on localhost
// (test/fixtures/fake_tuya_device.py).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const KEY = '0123456789abcdef';
const WRONG = 'fedcba9876543210';
const PY = path.join(__dirname, '..', 'python');
const env = { ...process.env };
delete env.GOULY_BRIDGE_EXTRA_PATH; // the real tinytuya, not the mock

async function fakeDevice(mode, delay = 0) {
  const proc = spawn('python3', [path.join(__dirname, 'fixtures', 'fake_tuya_device.py'), mode, KEY, String(delay)], { env });
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fake device did not start')), 10000);
    proc.on('exit', code => { clearTimeout(t); reject(new Error(`fake device exited (${code})`)); });
    readline.createInterface({ input: proc.stdout }).once('line', l => { clearTimeout(t); resolve(Number(l)); });
  });
  return { port, stop: () => proc.kill() };
}

function runPython(script, envVar, config, stdin = '') {
  return new Promise(resolve => {
    const proc = spawn('python3', ['-u', path.join(PY, script)], { env: { ...env, [envVar]: JSON.stringify(config) } });
    const guard = setTimeout(() => proc.kill(), 60000); // never hang the suite
    proc.on('exit', () => clearTimeout(guard));
    const events = [];
    readline.createInterface({ input: proc.stdout }).on('line', l => events.push(JSON.parse(l)));
    proc.on('exit', () => resolve(events));
    proc.stdin.end(stdin);
  });
}

async function probe(mode, key, delay = 0) {
  const dev = await fakeDevice(mode, delay);
  try {
    const events = await runPython('gouly_probe.py', 'GOULY_PROBE_CONFIG', { key, id: 'bf01', port: dev.port, timeout: 3 }, '127.0.0.1\n');
    assert.equal(events.at(-1).event, 'done');
    return events.find(e => e.event === 'probe');
  } finally {
    dev.stop();
  }
}

test('probe: a protocol 3.4 device is recognised without a key', { timeout: 90000 }, async () => {
  const r = await probe('v34');
  assert.equal(r.port, 'open'); assert.equal(r.tuya, 'likely'); assert.equal(r.key, 'none');
});

test('probe: the right key is confirmed, even on a slow controller', { timeout: 90000 }, async () => {
  const r = await probe('v34', KEY, 1.5);
  assert.equal(r.key, 'ok'); assert.equal(r.protocol, '3.4'); assert.equal(r.tuya, 'yes');
});

test('probe: a wrong key is reported, whether the device closes or answers', { timeout: 90000 }, async () => {
  for (const mode of ['v34', 'v34bad']) {
    const r = await probe(mode, WRONG);
    assert.equal(r.key, 'wrong', mode); assert.equal(r.port, 'open', mode); assert.equal(r.tuya, 'likely', mode);
  }
});

test('probe: other answers are told apart', { timeout: 90000 }, async () => {
  assert.equal((await probe('v33')).tuya, 'yes');
  assert.equal((await probe('other')).tuya, 'no');
  const silent = await probe('silent');
  assert.equal(silent.port, 'open'); assert.equal(silent.tuya, 'no');
});

test('probe: the key never appears in the output', { timeout: 90000 }, async () => {
  const dev = await fakeDevice('v34');
  try {
    const events = await runPython('gouly_probe.py', 'GOULY_PROBE_CONFIG', { key: WRONG, id: 'bf01', port: dev.port, timeout: 2 }, '127.0.0.1\n');
    assert.ok(!JSON.stringify(events).includes(WRONG));
  } finally {
    dev.stop();
  }
});

test('bridge: a slow handshake connects instead of failing as a key error', { timeout: 90000 }, async () => {
  const dev = await fakeDevice('v34', 1.5);
  try {
    const proc = spawn('python3', ['-u', path.join(PY, 'gouly_bridge.py')], {
      env: { ...env, GOULY_BRIDGE_CONFIG: JSON.stringify({ id: 'bf01', key: KEY, host: '127.0.0.1', port: dev.port, version: '3.4' }) },
    });
    const event = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no connected or rejected event')), 15000);
      readline.createInterface({ input: proc.stdout }).on('line', l => {
        const m = JSON.parse(l);
        if (m.event === 'connected' || m.event === 'rejected') { clearTimeout(t); resolve(m.event); }
      });
    });
    proc.kill();
    assert.equal(event, 'connected');
  } finally {
    dev.stop();
  }
});

test('bridge: a wrong key at a live address is "rejected"', { timeout: 90000 }, async () => {
  const dev = await fakeDevice('v34');
  try {
    const proc = spawn('python3', ['-u', path.join(PY, 'gouly_bridge.py')], {
      env: { ...env, GOULY_BRIDGE_CONFIG: JSON.stringify({ id: 'bf01', key: WRONG, host: '127.0.0.1', port: dev.port, version: '3.4' }) },
    });
    const event = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no event')), 20000);
      readline.createInterface({ input: proc.stdout }).on('line', l => {
        const m = JSON.parse(l);
        if (['connected', 'rejected', 'unreachable'].includes(m.event)) { clearTimeout(t); resolve(m.event); }
      });
    });
    proc.kill();
    assert.equal(event, 'rejected');
  } finally {
    dev.stop();
  }
});

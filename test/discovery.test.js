const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const path = require('path');
const { isPortOpen, scanForTuyaHosts, confirmController } = require('../dist/discovery');

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

test('key check: a device that does not answer is not confirmed', async () => {
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  // the mock refuses 10.0.0.250 (like a wrong key or a non-Gouly device) and accepts others
  assert.equal(await confirmController('10.0.0.250', 'bf01', 'k', '3.4', 3000), false);
  assert.equal(await confirmController('10.0.0.5', 'bf01', 'k', '3.4', 5000), true);
});

test('guided search explains each step and identifies the controller', async () => {
  const { guidedSearch } = require('../dist/discovery');
  process.env.GOULY_BRIDGE_EXTRA_PATH = path.join(__dirname, 'fixtures', 'mock_tinytuya');
  const inject = path.join(require('os').tmpdir(), `inject-gs-${process.pid}.txt`);
  process.env.MOCK_TUYA_INJECT = inject;
  try {
    // without a key: candidates only
    let lines = [];
    let r = await guidedSearch({ onLine: l => lines.push(l), scan: async () => ['10.0.0.250', '10.0.0.5'] });
    assert.equal(r.host, undefined);
    assert.equal(r.candidates.length, 2);
    assert.ok(lines.some(l => /Enter the Device ID and Local Key/.test(l)));
    // with a key: 10.0.0.250 refuses (mock), 10.0.0.5 accepts and answers the classic state query
    lines = [];
    require('fs').writeFileSync(inject, 'bbfc01ff050000a2010301000107001300' + '91');
    r = await guidedSearch({ id: 'bf01', key: 'k', onLine: l => lines.push(l), scan: async () => ['10.0.0.250', '10.0.0.5'] });
    assert.equal(r.host, '10.0.0.5');
    assert.ok(lines.some(l => /10\.0\.0\.250 did not accept/.test(l)), 'explains the refusal');
    assert.ok(lines.some(l => /Confirmed: 10\.0\.0\.5 .* protocol 3\.4\. It is a GOULY single-output controller/.test(l)), lines.join('\n'));
  } finally {
    delete process.env.MOCK_TUYA_INJECT;
  }
});

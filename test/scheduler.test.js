// The scheduler coalesces rapid HomeKit changes. A simulated clock makes timing exact.
const test = require('node:test');
const assert = require('node:assert');
const { CommandScheduler } = require('../dist/scheduler');
const { ClassicDriver } = require('../dist/protocol/classic');
const { fromHex } = require('../dist/protocol/frame');

function harness(opts = {}) {
  let now = 0; const timers = []; const batches = [];
  const driver = new ClassicDriver(false);
  const s = new CommandScheduler(() => driver, f => batches.push(f.map(b => b.toString('hex').slice(0, 6))), {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    ...opts,
  });
  const advance = ms => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift(); now = t.at; t.fn();
    }
    now = end;
  };
  return { s, batches, advance };
}

test('a fast slider drag sends only the latest brightness, with one commit', () => {
  const { s, batches, advance } = harness();
  s.notePower(true);
  for (let v = 10; v <= 250; v += 10) { s.setBrightness(v); advance(20); } // 25 writes in 500 ms
  advance(1000);
  const frames = batches.flat();
  const bright = frames.filter(f => f.startsWith('aaf3'));
  assert.ok(bright.length <= 3, `expected a few coalesced brightness frames, got ${bright.length}`);
  assert.equal(batches.at(-1).join(','), 'aaf3fa,aae500', 'last batch is the final value (250 = fa) plus one commit');
});

test('quick power flipping resolves to the final state only', () => {
  const { s, batches, advance } = harness();
  s.setPower(true); advance(30); s.setPower(false); advance(30); s.setPower(true); advance(30); s.setPower(false);
  advance(1000);
  assert.deepEqual(batches, [['aaf100']], 'one power-off frame');
});

test('colour then pattern within the window: only the newer look is sent', () => {
  const { s, batches, advance } = harness();
  s.notePower(true);
  s.setLook({ kind: 'colour', rgbw: [255, 0, 0, 0] }); advance(50);
  s.setLook({ kind: 'pattern', body: fromHex('f6 03 07 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 ff ff ff ff') });
  advance(1000);
  assert.deepEqual(batches, [['aaf603', 'aae500']]);
});

test('a colour change while off turns the lights on and applies it', () => {
  const { s, batches, advance } = harness();
  s.notePower(false);
  s.setLook({ kind: 'colour', rgbw: [0, 0, 255, 0] });
  advance(1000);
  assert.deepEqual(batches, [['aaf101', 'aaf200', 'aae500']], 'power on, colour, commit');
});

test('brightness up while off turns the lights on', () => {
  const { s, batches, advance } = harness();
  s.notePower(false);
  s.setBrightness(128);
  advance(1000);
  assert.deepEqual(batches, [['aaf101', 'aaf380', 'aae500']]);
});

test('latest action wins: change then off stays off; off then change turns on', () => {
  const a = harness();
  a.s.notePower(true);
  a.s.setLook({ kind: 'colour', rgbw: [255, 0, 0, 0] }); a.advance(40); a.s.setPower(false);
  a.advance(1000);
  assert.deepEqual(a.batches, [['aaf100']], 'change then off: off');
  const b = harness();
  b.s.notePower(true);
  b.s.setPower(false); b.advance(40); b.s.setLook({ kind: 'colour', rgbw: [255, 0, 0, 0] });
  b.advance(1000);
  assert.deepEqual(b.batches, [['aaf101', 'aaf2ff', 'aae500']], 'off then change: on with the colour');
});

test('batches never overlap: the next waits for the controller to finish the last', () => {
  const { s, batches, advance } = harness();
  s.notePower(true);
  s.setLook({ kind: 'pattern', body: fromHex('f6 03 07 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 ff ff ff ff') });
  s.setBrightness(100);
  advance(151); // first batch: pattern + brightness + commit = 3 frames -> busy ~660 ms
  assert.equal(batches.length, 1);
  s.setBrightness(200); advance(300);
  assert.equal(batches.length, 1, 'second batch waits while the controller is busy');
  advance(600);
  assert.equal(batches.length, 2);
});

test('a continuous drag still updates at least every 500 ms', () => {
  const { s, batches, advance } = harness();
  s.notePower(true);
  for (let i = 0; i < 60; i++) { s.setBrightness(i + 1); advance(25); } // 1.5 s of constant input
  assert.ok(batches.length >= 2, `lights follow the drag (got ${batches.length} batches in 1.5 s)`);
});

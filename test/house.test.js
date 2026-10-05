const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../homebridge-ui/public/house.js'), 'utf8');
const sandbox = { module: { exports: {} }, globalThis: {} };
vm.runInNewContext(src, sandbox);
const H = sandbox.module.exports;

test('LED order: bottom left -> bottom right, then top left -> top right', () => {
  const P = H.POSITIONS;
  assert.equal(P.length, 56);
  const lower = P.slice(0, H.LOWER_DOTS);
  const upper = P.slice(H.LOWER_DOTS);
  assert.ok(lower[0][0] < lower[lower.length - 1][0], 'lower runs left to right');
  assert.ok(upper[0][0] < upper[upper.length - 1][0], 'upper runs left to right');
  assert.ok(upper[0][1] < lower[0][1] && upper[upper.length - 1][1] < 70, 'upper row sits higher');
  assert.ok(lower[0][0] < 40 && upper[upper.length - 1][0] > 350, 'starts far left, ends far right');
});

test('directions: Right starts at index 0, Left at the end', () => {
  assert.equal(H.positionOf(0, 100, 0), 0);
  assert.equal(H.positionOf(99, 100, 1), 0);
  assert.ok(H.positionOf(50, 100, 2) < H.positionOf(0, 100, 2), 'center to sides starts in the middle');
  assert.ok(H.positionOf(0, 100, 3) < H.positionOf(50, 100, 3), 'sides to center starts at the ends');
});

const christmas = 'f6 03 07 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 ff ff ff ff';
const scrollRgb = 'f6 05 05 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 00 00 ff 00';

test('every effect renders valid colours over time', () => {
  const ids = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,25,26,27];
  for (const id of ids) {
    for (const dir of [0,1,2,3,4]) {
      const p = { ...H.parseFrame(scrollRgb), effect: id, direction: dir };
      for (const t of [0, 0.7, 3.3]) {
        const f = H.frameAt(p, t);
        assert.equal(f.length, 56);
        for (const c of f) for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255.01, `fx ${id} dir ${dir}`);
      }
    }
  }
});

test('static shows the colour sequence from LED 0; scroll moves with direction', () => {
  const s = H.frameAt({ ...H.parseFrame(scrollRgb), effect: 1 }, 0);
  assert.deepEqual(s.slice(0, 3).map(c => c.map(Math.round)), [[255,0,0],[0,255,0],[0,0,255]]);
  const right0 = H.frameAt(H.parseFrame(scrollRgb), 0)[10];
  const right1 = H.frameAt(H.parseFrame(scrollRgb), 0.12)[10]; // speed 5 = 9 dots/s -> ~1 dot
  assert.notDeepEqual(right0, right1);
  const p = H.parseFrame(christmas);
  assert.equal(p.effect, 3); assert.equal(p.speed, 7); assert.equal(p.colours.length, 3);
});

test('sync fade duty cycle: 2 on, 3 off lights 2 of every 5 LEDs', () => {
  const p = H.parseFrame('f6 15 05 01 23 ff 01 00 00 00 00 ff 00 00 00');
  const f = H.frameAt(p, 0.3);
  const lit = f.slice(0, 10).map(c => c[0] > 1);
  assert.deepEqual(lit, [true, true, false, false, false, true, true, false, false, false]);
});

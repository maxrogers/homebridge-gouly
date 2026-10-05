// Checks every builder against frames captured from the real controller and the Gouly app.
const test = require('node:test');
const assert = require('node:assert');
const { ClassicDriver } = require('../dist/protocol/classic');
const { ProDriver } = require('../dist/protocol/pro');
const { fromHex } = require('../dist/protocol/frame');
const { describePattern } = require('../dist/patterns/describe');
const { miredToRgbw, rgbwToHomeKit, hsToRgbw } = require('../dist/colour');

const hex = b => b.toString('hex');
const d = new ClassicDriver(false);

test('classic basic commands match captures', () => {
  assert.equal(hex(d.power(true)[0]), 'aaf1010000000000000000'.slice(0, 20) + '2e');
  assert.equal(hex(d.power(false)[0]), 'aaf10000000000000000' + '6d');
  assert.equal(hex(d.brightness(0x40)[0]), 'aaf34000000000000000' + '75');
  assert.equal(hex(d.colour(0, 0, 255, 0)[0]), 'aaf20000ff0000000000' + 'ce');
  assert.equal(hex(d.colour(0, 0, 0, 255)[0]), 'aaf2000000ff00000000' + '51');
  assert.equal(hex(d.query()[0]), 'aafc0000000000000000' + '36');
  assert.equal(hex(new ClassicDriver(true).colour(1, 2, 3, 4)[1]), 'aae50000000000000000' + '75');
});

const christmas = 'f6 03 07 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 ff ff ff ff';
const halloween = 'f6 01 07 00 00 ff 04 00 00 00 00 ff 66 00 00 00 00 00 00 66 00 66 00 f8 f8 ff 00';
const download = 'f6 04 02 00 00 ff 08 00 00 00 00 ff 00 00 00 ff 00 00 00 ff ff ff 00 ff ff ff 00 00 ff 00 00 00 ff 00 00 ff ff 00 00 ff ff 00 00';

test('pattern replay is byte identical to the app', () => {
  const c = d.pattern(fromHex(christmas))[0];
  assert.equal(c.length, 25); assert.equal(c[24], 0x80);
  const h = d.pattern(fromHex(halloween))[0];
  assert.equal(h.length, 29); assert.equal(h[28], 0x10);
  const f = d.pattern(fromHex(download))[0];
  assert.equal(f.length, 45); assert.equal(f[44], 0x6d);
});

test('pattern validation rejects bad lengths', () => {
  assert.throws(() => d.pattern(fromHex(christmas + ' 00')));
});

test('parses echoes and the state report', () => {
  assert.deepEqual(d.parse(fromHex('bb fc 01 40 07 00 01 2c 01 03 01 00 01 07 00 13 00 9c')), { on: true, brightness: 0x40, speed: 7, info: { pixels: 300, icType: 3, rgbOrder: 0 } });
  assert.deepEqual(d.parse(fromHex('aa f2 00 00 ff 00 00 00 00 00 ce')).rgbw, [0, 0, 255, 0]);
  assert.equal(hex(d.parse(d.pattern(fromHex(christmas))[0]).pattern), fromHex(christmas).toString('hex'));
  assert.throws(() => d.parse(fromHex('aa f2 00 00 ff 00 00 00 00 00 cf')));
});

test('describes patterns', () => {
  const x = describePattern(fromHex(download));
  assert.equal(x.effectName, 'Follow'); assert.equal(x.speed, 2); assert.equal(x.directionName, 'Right');
  assert.deepEqual(x.colourNames, ['red', 'cool white', 'green', 'yellow']);
  const h = describePattern(fromHex(halloween));
  assert.deepEqual(h.colourNames, ['orange', 'off', 'purple', 'cool white']);
  console.log('  ', x.summary, '|', x.suggestedName);
  console.log('  ', h.summary, '|', describePattern(fromHex(christmas)).summary);
});

test('colour temperature maps onto CW / PW / WW', () => {
  assert.deepEqual(miredToRgbw(140), [255, 255, 255, 0]);   // CW
  assert.deepEqual(miredToRgbw(255), [255, 255, 255, 255]); // PW
  assert.deepEqual(miredToRgbw(370), [0, 0, 0, 255]);       // WW from ~2700K
  assert.deepEqual(miredToRgbw(500), [0, 0, 0, 255]);
  for (const m of [140, 200, 255, 300, 370]) {
    const back = rgbwToHomeKit(miredToRgbw(m));
    assert.equal(back.mode, 'white'); assert.ok(Math.abs(back.mired - m) <= 2, `${m} -> ${back.mired}`);
  }
  assert.deepEqual(hsToRgbw(0, 100), [255, 0, 0, 0]);
  assert.deepEqual(hsToRgbw(240, 100), [0, 0, 255, 0]);
  const c = rgbwToHomeKit([0, 255, 0, 0]); assert.equal(c.mode, 'colour'); assert.equal(c.hue, 120);
});

test('pro frames match ha-gouly', () => {
  const p = new ProDriver();
  assert.equal(hex(p.power(true)[0]), 'aaf1010000000000000000'.slice(0, 20) + '2e');
  assert.equal(hex(p.query()[0]), 'aab6000000000000' + '9b');
  const s = p.colour(255, 0, 0, 0);
  assert.equal(s.length, 5); assert.equal(s[2].length, 113);
});

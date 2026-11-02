import assert from 'node:assert';
import { readFrame, writeFrame, crc16, extractPayload, decodeBlock, FULL_READ } from './daly-modbus.js';

// --- 1. Frame bytes must match the published examples in the Daly Modbus spec ---
const req = readFrame(0x0000, 0x003e);
console.log('read 0x0000 x62 :', Buffer.from(req).toString('hex').toUpperCase());
assert.equal(Buffer.from(req).toString('hex'), 'd203000000' + '3e' + crc16(req.slice(0, 6)).toString(16).padStart(4, '0').match(/../g).reverse().join(''));

const example = writeFrame(0x000c, 0x0001); // spec example: D2 06 00 0C 00 01 9B AA
console.log('spec example    :', Buffer.from(example).toString('hex').toUpperCase(), '(spec says D206000C0001 9BAA)');
assert.equal(Buffer.from(example).toString('hex').toUpperCase(), 'D206000C00019BAA');

// --- 2. Build a synthetic 16S LiFePO4 pack: 51.9 V, -42 A charging, 78.4 %, 22 C ---
const b = new Uint8Array(124);
const put = (off, v) => { b[off] = (v >> 8) & 0xff; b[off + 1] = v & 0xff; };
const cells = [3398, 3401, 3999, 3397, 3402, 3400, 3399, 3396, 3400, 3403, 3395, 3401, 3398, 3400, 3399, 3402];
cells.forEach((mv, i) => put(i * 2, mv));
put(64, 22 + 40);  put(66, 21 + 40);                      // 0x20.. temps, offset 40
put(80, 519);                                            // 0x28 total V, 0.1 V
put(82, 30000 - 420);                                    // 0x29 current, 30000 offset, 0.1 A
put(84, 784);                                            // 0x2A SOC, 0.1 %
put(86, 3403);  put(88, 3395);                           // 0x2B/2C max/min cell mV
put(90, 22 + 40); put(92, 21 + 40);                      // 0x2D/2E
put(94, 1);                                              // 0x2F charging
put(96, 4705);                                           // 0x30 remaining 0.1 Ah
put(98, 16);                                             // 0x31 cell count
put(100, 2);                                             // 0x32 temp sensor count
put(102, 213);                                           // 0x33 cycles
put(104, 1);                                             // 0x34 balancing
put(106, 1); put(108, 0);                                // 0x35/36 charge MOS on, discharge off
put(110, 3399); put(112, 8);                             // 0x37 avg mV, 0x38 delta mV
put(114, 2180);                                          // 0x39 power W
put(116, 0b100);                                         // 0x3A fault1 bit2 = L1 cell undervoltage
put(118, 0);

// --- 3. Wrap it exactly as the BMS would, in two BLE notification chunks ---
const frame = new Uint8Array([0xD2, 0x03, 124, ...b]);
const c = crc16(frame);
const wire = new Uint8Array([...frame, c & 0xff, c >> 8]);

const buffer = [];
const samples = [];
for (const chunk of [wire.slice(0, 20), wire.slice(20)]) {   // split mid-frame on purpose
  for (const byte of chunk) buffer.push(byte);
  let payload;
  while ((payload = extractPayload(buffer))) samples.push(decodeBlock(payload));
}
assert.equal(samples.length, 1, 'should emit exactly one sample after reassembly');

const s = samples[0];
console.log('\ndecoded:', JSON.stringify(s, null, 1));

assert.equal(s.nCells, 16);
assert.equal(s.cells[2], 3.999);
assert.equal(s.voltage, 51.9);
assert.equal(s.current, -42);
assert.equal(s.soc, 78.4);
assert.equal(s.state, 'charging');
assert.equal(s.remainingAh, 470.5);
assert.equal(s.cycles, 213);
assert.equal(s.balancing, true);
assert.equal(s.chargeMos, true);
assert.equal(s.dischargeMos, false);
assert.equal(s.temps[0], 22);
assert.equal(s.cellSpread, 0.604);
assert.deepEqual(s.faultList, ['fault1.bit2']);

// --- 4. Corrupt a byte: the parser must reject, not emit garbage ---
buffer.length = 0;
const bad = wire.slice();
bad[10] ^= 0xff;
for (const byte of bad) buffer.push(byte);
assert.equal(extractPayload(buffer), null, 'corrupt CRC must be dropped');

console.log('\nALL CHECKS PASSED');

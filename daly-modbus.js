// Daly Smart BMS — Modbus-over-BLE (the "SMART BMS" / com.inuker.bluetooth.daily app protocol)
// Slave addr 0xD2, function 0x03 read-holding-registers. CRC-16/IBM (poly 0xA001, init 0xFFFF),
// appended little-endian. Verified against syssi/esphome-daly-bms docs/dalyModbusProtocol.xlsx
// and fl4p/batmon-ha bmslib/models/daly2.py.

export const DALY_ADDR = 0xD2;

export const UUID_SETS = [
  ['0000fff1-0000-1000-8000-00805f9b34fb', '0000fff2-0000-1000-8000-00805f9b34fb'], // old fff0 service
  ['0000ff01-0000-1000-8000-00805f9b34fb', '0000ff02-0000-1000-8000-00805f9b34fb'], // newer DL/JHB fw
];

export function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xA001 : crc >> 1;
  }
  return crc & 0xFFFF;
}

export function readFrame(startReg, count) {
  const body = new Uint8Array([
    DALY_ADDR, 0x03, startReg >> 8, startReg & 0xff, count >> 8, count & 0xff,
  ]);
  const c = crc16(body);
  return new Uint8Array([...body, c & 0xff, c >> 8]);
}

export function writeFrame(reg, value) {
  const body = new Uint8Array([DALY_ADDR, 0x06, reg >> 8, reg & 0xff, value >> 8, value & 0xff]);
  const c = crc16(body);
  return new Uint8Array([...body, c & 0xff, c >> 8]);
}

// One request gets everything: 62 registers starting at 0x0000 -> 124 data bytes.
export const FULL_READ = () => readFrame(0x0000, 0x003e);

/** Strip a 0xD2 0x03 <len> ... <crc> response down to the data payload. Returns null if incomplete. */
export function extractPayload(buf) {
  let i = buf.indexOf(0xD2);
  if (i < 0) { buf.length = 0; return null; }
  if (i > 0) buf.splice(0, i);
  if (buf.length < 3) return null;
  const len = buf[2];
  const total = 3 + len + 2;
  if (buf.length < total) return null;
  const frame = buf.slice(0, total);
  buf.splice(0, total);
  const got = frame[total - 2] | (frame[total - 1] << 8);
  if (crc16(frame.slice(0, total - 2)) !== got) return null; // drop corrupt frame
  return frame.slice(3, total - 2);
}

const u16 = (b, o) => (b[o] << 8) | b[o + 1];

export const FAULT_BITS = ['level 1', 'level 2'];

/** Decode the 124-byte block. Byte offset == 2 * register address. */
export function decodeBlock(b) {
  if (!b || b.length < 124) throw new Error(`short block: ${b ? b.length : 0} bytes`);
  const nCells = Math.min(u16(b, 98), 32);
  const nTemps = Math.min(u16(b, 100), 8);

  const cells = [];
  for (let i = 0; i < nCells; i++) cells.push(u16(b, i * 2) / 1000); // mV -> V

  const temps = [];
  for (let i = 0; i < nTemps; i++) temps.push(u16(b, 64 + i * 2) - 40); // offset 40

  const faults = [u16(b, 116), u16(b, 118), u16(b, 120), u16(b, 122)];
  const faultList = [];
  faults.forEach((mask, block) => {
    for (let bit = 0; bit < 16; bit++) if (mask & (1 << bit)) faultList.push(`fault${block + 1}.bit${bit}`);
  });

  return {
    voltage: u16(b, 80) / 10,                       // 0x28, 0.1 V
    current: (u16(b, 82) - 30000) / 10,             // 0x29, 0.1 A, 30000 offset; + = discharge
    soc: u16(b, 84) / 10,                           // 0x2A, 0.1 %
    maxCell: u16(b, 86) / 1000,                     // 0x2B, mV
    minCell: u16(b, 88) / 1000,                     // 0x2C
    maxTemp: u16(b, 90) - 40,                       // 0x2D
    minTemp: u16(b, 92) - 40,                       // 0x2E
    state: ['stationary', 'charging', 'discharging'][u16(b, 94)] ?? 'unknown', // 0x2F
    remainingAh: u16(b, 96) / 10,                   // 0x30, 0.1 Ah
    nCells, nTemps,
    cycles: u16(b, 102),                            // 0x33
    balancing: u16(b, 104) === 1,                   // 0x34
    chargeMos: u16(b, 106) === 1,                   // 0x35
    dischargeMos: u16(b, 108) === 1,                // 0x36
    avgCell: u16(b, 110) / 1000,                    // 0x37
    delta: u16(b, 112) / 1000,                      // 0x38
    power: u16(b, 114),                             // 0x39, W
    faults, faultList,
    cells, temps,
    cellSpread: +(Math.max(...cells) - Math.min(...cells)).toFixed(3),
  };
}

/** Minimal Web Bluetooth client. Chrome/Edge on Android or desktop only. */
export async function connect(onSample, { intervalMs = 1000, log = () => {} } = {}) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: 'DL-' }, { namePrefix: 'Daly' }],
    optionalServices: [...UUID_SETS.flat(), '0000fff0-0000-1000-8000-00805f9b34fb'],
  });
  log(`device: ${device.name}`);
  const server = await device.gatt.connect();

  let rx, tx, buf = [];
  for (const [r, t] of UUID_SETS) {
    try {
      const svc = await server.getPrimaryService(r.slice(4));
      rx = await svc.getCharacteristic(r);
      tx = await svc.getCharacteristic(t);
      break;
    } catch (e) { log(`uuid ${r} nope: ${e.message}`); }
  }
  if (!rx) throw new Error('no notify characteristic — is the official app still connected?');

  await rx.startNotifications();
  let last = null;
  rx.addEventListener('characteristicvaluechanged', (ev) => {
    const v = ev.target.value;
    for (let i = 0; i < v.byteLength; i++) buf.push(v.getUint8(i));
    let payload;
    while ((payload = extractPayload(buf))) {
      try { last = decodeBlock(payload); } catch (e) { log(e.message); }
    }
    if (last) { onSample(last); last = null; }
  });

  const timer = setInterval(async () => {
    try { await tx.writeValueWithoutResponse(FULL_READ()); }
    catch (e) { log(`write failed: ${e.message}`); }
  }, intervalMs);
  await tx.writeValueWithoutResponse(FULL_READ());

  device.addEventListener('gattserverdisconnected', () => clearInterval(timer));
  return { device, stop: () => { clearInterval(timer); device.gatt.disconnect(); } };
}

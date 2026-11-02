import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
window.addEventListener('error', (e) => console.log('PAGE ERROR:', e.message));
await new Promise(r => window.addEventListener('load', r, { once: true }));

const D = window.__daly;
const $ = (id) => window.document.getElementById(id);
const txt = (id) => $(id).textContent.trim();
const val = (id) => $(id).value;
const type = (id, v) => { const el = $(id); el.value = String(v); el.dispatchEvent(new window.Event('input')); };
const click = (id) => $(id).dispatchEvent(new window.Event('click'));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const fails = [];
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
};
assert.ok(D, 'script did not run');

/* ------------------------------------------------------------------
   Fake BMS: applies writes to a parameter block, but NEVER echoes
   the 0x06 frame — exactly the firmware the user has.
   ------------------------------------------------------------------ */
const mem = D.demoParams();          // 82 bytes, 0x80..0xA8
const written = [];
const frame = (addr, fn, payload) => {
  const body = [addr, fn, payload.length, ...payload];
  const crc = D.crc16(body);
  return [...body, crc & 0xff, crc >> 8];
};

D.ble.tx = {
  properties: { writeWithoutResponse: true },
  writeValueWithoutResponse(bytes) {
    const a = Array.from(bytes);
    if (a[0] !== 0xD2) return Promise.resolve();
    const fn = a[1];
    if (fn === 0x06) {
      const reg = (a[2] << 8) | a[3], v = (a[4] << 8) | a[5];
      written.push([reg, v]);
      if (reg >= 0x80 && reg <= 0xa8) {
        const o = (reg - 0x80) * 2;
        mem[o] = v >> 8; mem[o + 1] = v & 0xff;
      }
      return Promise.resolve();          // <-- silence, no echo
    }
    if (fn === 0x03) {
      const start = (a[2] << 8) | a[3], count = (a[4] << 8) | a[5];
      let payload;
      if (start === 0x0000 && count === 0x3e) {
        payload = new Array(124).fill(0);
      } else if (start === 0x0080) {
        payload = Array.from(mem.slice(0, count * 2));
      } else if (start === 0x00c9) {
        payload = [..."123456"].map(c => c.charCodeAt(0));
      } else if (start === 0x00a9) {
        const str = "T100.901132.13  E903-032DG-SMB 20240229" + " ".repeat(20);
        payload = [...str].slice(0, count * 2).map(c => c.charCodeAt(0));
      } else {
        payload = new Array(count * 2).fill(0);
      }
      setTimeout(() => D.feed(frame(0xD2, 0x03, payload)), 4);
      return Promise.resolve();
    }
    return Promise.resolve();
  },
};

console.log('\n[1] unlock against a real-ish BMS');
D.state.mode = "live";
D.setView("settings");
$("pwInput").value = "123456";
click("unlockBtn");
await wait(300);
check('unlocked and parameters loaded from the fake device', () => {
  assert.equal(D.S.unlocked, true);
  assert.equal(val("i-8c"), "3600");
  assert.equal(val("i-94"), "20");
  assert.equal(txt("infoSw").startsWith("T100"), true);
});

console.log('\n[2] apply to a BMS that never echoes writes');
type("i-8c", 3550);
assert.equal($("dirtyCount").textContent, "1");
click("applyBtn");
await wait(2600);
check('the write is reported as a success, not a failure', () => {
  const log = txt("applyLog");
  console.log("       log: " + log.replace(/\n/g, " | "));
  assert.match(log, /✓ Cell over-voltage protection → 3550 mV/);
  assert.doesNotMatch(log, /✗/);
  assert.doesNotMatch(log, /unchanged/);
});
check('the value actually reached the device', () => {
  const hit = written.find(([r]) => r === 0x8c);
  assert.ok(hit, "register 0x8c was never written");
  assert.equal(hit[1], 3550);
  assert.equal((mem[0x18] << 8) | mem[0x19], 3550);
});
check('baseline re-read from the device', () => {
  assert.equal(D.S.orig[0x8c], 3550);
  assert.equal(val("i-8c"), "3550");
  assert.equal($("dirtyCount").textContent, "0");
});

console.log('\n[3] a write the device rejects is still caught');
// make the device ignore writes to 0x8e from now on
const origWrite = D.ble.tx.writeValueWithoutResponse;
D.ble.tx.writeValueWithoutResponse = function (bytes) {
  const a = Array.from(bytes);
  if (a[1] === 0x06 && ((a[2] << 8) | a[3]) === 0x8e) return Promise.resolve();
  return origWrite.call(this, bytes);
};
type("i-8e", 2800);
click("applyBtn");
await wait(3000);
check('reports "reads back unchanged" instead of a false pass', () => {
  const log = txt("applyLog");
  console.log("       log: " + log.replace(/\n/g, " | "));
  assert.match(log, /✗ Cell under-voltage protection → 2800 mV — reads back unchanged/);
});

console.log('\n[4] MOSFET confirmation without an echo');
D.setView("dash");
D.state.sample = { chargeMos: true, dischargeMos: true, cells: [], nCells: 0, nTemps: 0, faults: [0,0,0,0] };
D.render();                           // paint the switch as ON before clicking it off
assert.equal($("swChg").getAttribute("aria-checked"), "true");
click("swChg");                       // demo mode is off here, so this is a live write
await wait(900);
check('switch write sent and read back', () => {
  const w = written.filter(([r]) => r === 0xa5);
  assert.ok(w.length >= 1, "0xA5 was never written");
  assert.equal(w[w.length - 1][1], 0);
});

console.log('\n[5] demo mode keeps a toggled FET off');
click("demoBtn");                     // start demo
D.demoStep();
const before = D.state.sample.chargeMos;
click("swChg");
D.demoStep();
check('toggled state is not overwritten by the simulator', () => {
  assert.equal(before, true);
  assert.equal(D.state.sample.chargeMos, false);
});

console.log(fails.length ? `\n${fails.length} FAILURE(S)\n` + fails.join('\n') : '\nALL TRANSPORT CHECKS PASSED');
process.exit(fails.length ? 1 : 0);

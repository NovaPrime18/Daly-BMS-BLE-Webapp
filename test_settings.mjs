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
const fails = [];
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { fails.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); }
};
const type = (id, v) => { const el = $(id); el.value = String(v); el.dispatchEvent(new window.Event('input')); };
const click = (id) => $(id).dispatchEvent(new window.Event('click'));
const tick = (ms = 60) => new Promise(r => setTimeout(r, ms));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

assert.ok(D, 'script did not run — syntax error?');

console.log('\n[1] view switching + lock state');
check('settings hidden at start', () => {
  assert.ok($('settingsView').classList.contains('hidden'));
});
check('unlock disabled with no connection', () => {
  D.setView('settings');
  assert.equal($('unlockBtn').disabled, true);
  assert.equal(txt('authText'), 'locked');
});

console.log('\n[2] password gate');
click('demoBtn'); D.demoStep();
check('demo enables the gate', () => { assert.equal($('unlockBtn').disabled, false); });
type('pwInput', '000000'); click('unlockBtn');
await tick();
check('wrong code rejected', () => {
  assert.equal(D.S.unlocked, false);
  assert.match(txt('authErr'), /Wrong code/);
});
type('pwInput', '123456'); click('unlockBtn');
await wait(150);
check('correct code unlocks, 39 fields built', () => {
  assert.equal(D.S.unlocked, true);
  assert.equal(window.document.querySelectorAll('.field').length, 39);
  assert.equal(D.FIELDS.length, 39);
});

console.log('\n[3] parity with the official app screenshots');
// every value below is what the Daly app displays on the Protection / Temp / Cell screens
const APP = [
  ['i-8c', '3600', 'single cell volt-high protection 3.60 V'],
  ['i-8e', '2870', 'single cell volt-low protection 2.87 V'],
  ['i-90', '57.6', 'sum volt high protect 57.60 V'],
  ['i-92', '46', 'sum volt low protect 46.00 V'],
  ['i-a0', '200', 'differential pressure alarm 0.20 V'],
  ['i-94', '20', 'chg overcurrent protect 20.0 A'],
  ['i-96', '40', 'dischg overcurrent protect 40.0 A'],
  ['i-98', '40', 'chg high temp protect 40 C'],
  ['i-9a', '0', 'chg low temp protect 0 C'],
  ['i-9c', '40', 'disChg high temp protect 40 C'],
  ['i-9e', '-5', 'disChg low temp protect -5 C'],
  ['i-a2', '15', 'diff Temp protect 15 C'],
  ['i-a8', '47', 'Fan On Temperature 47 C'],
  ['i-a3', '3400', 'Balanced open start volt 3.40 V'],
  ['i-a4', '20', 'balanced open diff volt 0.02 V'],
  ['i-81', '3200', 'cell reference volt 3.20 V'],
  ['i-80', '23.2', 'rated capacity 23.2 AH'],
  ['i-a7', '99.8', 'SOC set 99.8 %'],
];
for (const [id, want, label] of APP) {
  check('app parity: ' + label, () => assert.equal(val(id), want));
}
check('board config matches the app', () => {
  assert.equal(txt('i-82'), '1');   // collect boards num
  assert.equal(txt('i-83'), '16');  // board 1 cell num
  assert.equal(txt('i-86'), '1');   // board 1 temp num
});

console.log('\n[4] the undocumented paired values are read-only');
check('they render as text, not inputs', () => {
  for (const reg of [0x8b, 0x8d, 0x9f, 0x8f, 0x91, 0x93, 0x95, 0x97, 0x99, 0x9b, 0x9d, 0xa1]) {
    const el = $('i-' + reg.toString(16));
    assert.ok(el, 'missing read-only field ' + reg.toString(16));
    assert.equal(el.tagName, 'SPAN', reg.toString(16) + ' should be a span');
    assert.equal(el.closest('.field').querySelector('input'), null);
  }
});
check('hidden values show the stored numbers', () => {
  assert.equal(txt('i-8b'), '3650');
  assert.equal(txt('i-93'), '48');   // stored below 30000, shown as magnitude
  assert.equal(txt('i-91'), '37.6');
});
check('read-only fields never count as changes', () => {
  assert.equal($('dirtyCount').textContent, '0');
  assert.equal($('applyBtn').disabled, true);
});

console.log('\n[5] editing + validation on the protection values');
check('editing marks dirty', () => {
  type('i-8c', 3570);
  assert.equal($('dirtyCount').textContent, '1');
  assert.equal($('applyBtn').disabled, false);
  assert.ok($('f-8c').classList.contains('dirty'));
});
check('range check blocks nonsense', () => {
  type('i-8c', 99);
  assert.ok($('f-8c').classList.contains('err'));
  assert.match(txt('m-8c'), /Must be 2000–4500/);
  assert.equal($('applyBtn').disabled, true);
  type('i-8c', 3600 - 30);
});
check('cell OV protection vs UV protection cross-check', () => {
  type('i-8c', 3000);
  type('i-8e', 3200);
  assert.ok($('f-8e').classList.contains('err'));
  assert.match(txt('m-8e'), /below the cell over-voltage protection/);
  assert.equal($('applyBtn').disabled, true);
  type('i-8e', 2870);
  type('i-8c', 3600);
  assert.ok(!$('f-8c').classList.contains('err'));
  assert.ok(!$('f-8e').classList.contains('err'));
  assert.equal($('applyBtn').disabled, true);   // nothing left changed
});
check('round-trip every field', () => {
  for (const f of D.FIELDS) {
    if (f.ro) continue;
    const v = f.dec ? 12.3 : 12;
    const raw = D.toRaw(f, v);
    assert.ok(raw >= 0 && raw <= 65535, f.l + ' raw ' + raw);
    assert.equal(D.fromRaw(f, raw).toFixed(f.dec ? 1 : 0), v.toFixed(f.dec ? 1 : 0));
  }
});
check('charge current writes stay below the 30000 offset', () => {
  const chg = D.FIELDS.find(f => f.reg === 0x94);
  const dsg = D.FIELDS.find(f => f.reg === 0x96);
  assert.equal(D.toRaw(chg, 20), 29800);
  assert.equal(D.toRaw(chg, 48), 29520);
  assert.equal(D.toRaw(dsg, 40), 30400);
  assert.equal(D.fromRaw(chg, 29800), 20);
  assert.equal(D.fromRaw(chg, 29520), 48);
});

console.log('\n[6] apply');
type('i-8c', 3570);
assert.equal($('dirtyCount').textContent, '1');
await tick();
click('applyBtn');
await wait(500);
check('apply log shows only editable fields, no errors', () => {
  const log = txt('applyLog');
  assert.match(log, /✓ Cell over-voltage protection → 3570 mV/);
  assert.doesNotMatch(log, /✗/);
  assert.doesNotMatch(log, /not stored/);
});
check('baseline updated to the applied value', () => {
  assert.equal(val('i-8c'), '3570');
  assert.equal(D.S.orig[0x8c], 3570);
  assert.equal($('dirtyCount').textContent, '0');
});
check('revert works', () => {
  type('i-8c', 3500);
  assert.equal($('dirtyCount').textContent, '1');
  click('revertBtn');
  assert.equal(val('i-8c'), '3570');
  assert.equal($('dirtyCount').textContent, '0');
});
check('stopping demo locks again', () => {
  click('backBtn'); click('demoBtn');
  assert.equal(D.S.unlocked, false);
  assert.equal(txt('authText'), 'locked');
});

console.log(fails.length ? `\n${fails.length} FAILURE(S)\n` + fails.join('\n') : '\nALL SETTINGS CHECKS PASSED');
process.exit(fails.length ? 1 : 0);

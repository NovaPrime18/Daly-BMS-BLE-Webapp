import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import assert from 'node:assert';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
await new Promise(r => window.addEventListener('load', r, { once: true }));

const D = window.__daly;
const $ = (id) => window.document.getElementById(id);

// jsdom has no canvas backend; install a recording 2D context so the chart
// drawing code actually runs (and we can assert it drew something).
const draw = { fillRect: 0, stroke: 0, fill: 0, gradients: 0 };
function fakeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k === 'createLinearGradient') return () => { draw.gradients++; return { addColorStop() {} }; };
      if (k === 'canvas') return { width: 600, height: 132 };
      if (typeof k === 'string' && k in draw) return () => { draw[k]++; };
      if (k === 'then') return undefined;
      return typeof k === 'string' ? () => {} : undefined;
    },
    set() { return true; },
  });
}
window.HTMLCanvasElement.prototype.getContext = fakeCtx;
const txt = (id) => $(id).textContent.trim();
const fails = [];
const check = (name, fn) => { try { fn(); console.log('  ok   ' + name); } catch (e) { fails.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' :: ' + e.message); } };

console.log('\n[1] script executed and exposed API');
check('window.__daly present', () => assert.ok(D && D.decodeBlock));

console.log('\n[2] protocol inside the page');
check('read frame matches documented D2 03 00 00 00 3E D7 B9', () => {
  const got = Array.from(D.readFrame(0x0000, 0x3e)).map(b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(got.toUpperCase(), 'D2030000003ED7B9');
});
check('write frame matches spec example D2 06 00 0C 00 01 9B AA', () => {
  const got = Array.from(D.writeFrame(0x000c, 1)).map(b => b.toString(16).padStart(2, '0')).join('');
  assert.equal(got.toUpperCase(), 'D206000C00019BAA');
});
check('0xA5 / 0xA6 switch frames are well formed', () => {
  const a = Array.from(D.writeFrame(0x00a5, 1)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  assert.equal(a.slice(0, 12), 'D20600A5000' + '1');
  assert.equal(a.length, 16);
});

// synthetic 16S block, wrapped, split across two notifications
const b = new Uint8Array(124);
const put = (o, v) => { b[o] = (v >> 8) & 255; b[o + 1] = v & 255; };
[3398,3401,3999,3397,3402,3400,3399,3396,3400,3403,3395,3401,3398,3400,3399,3402].forEach((mv, i) => put(i * 2, mv));
put(64, 62); put(66, 61); put(80, 519); put(82, 30000 - 420); put(84, 784);
put(86, 3403); put(88, 3395); put(90, 62); put(92, 61); put(94, 1); put(96, 4705);
put(98, 16); put(100, 2); put(102, 213); put(104, 1); put(106, 1); put(108, 0);
put(110, 3399); put(112, 8); put(114, 2180); put(116, 0b100);

check('frame reassembly across split notification', () => {
  const body = [0xD2, 0x03, 124, ...b];
  const c = D.crc16(body);
  const wire = [...body, c & 0xff, c >> 8];
  const buf = [];
  let out = null;
  for (const chunk of [wire.slice(0, 20), wire.slice(20)]) {
    buf.push(...chunk);
    let f; while ((f = D.extractFrame(buf))) out = f;
  }
  assert.ok(out, 'no frame extracted');
  assert.equal(out.fn, 0x03);
  assert.equal(out.payload.length, 124);
});
check('decodeBlock field scaling', () => {
  const s = D.decodeBlock(b);
  assert.equal(s.voltage, 51.9);
  assert.equal(s.current, -42);
  assert.equal(s.soc, 78.4);
  assert.equal(s.nCells, 16);
  assert.equal(s.cells[2], 3.999);
  assert.equal(s.temps[0], 22);
  assert.equal(s.cycles, 213);
  assert.equal(s.chargeMos, true);
  assert.equal(s.dischargeMos, false);
  assert.equal(s.balancing, true);
  assert.equal(s.remainingAh, 470.5);
});
check('corrupt CRC rejected', () => {
  const body = [0xD2, 0x03, 124, ...b];
  const c = D.crc16(body);
  const wire = [...body, c & 0xff, c >> 8];
  wire[10] ^= 0xff;
  const buf = wire.slice();
  assert.equal(D.extractFrame(buf), null);
});
check('fault bit names resolve from Daly table', () => {
  const s = D.decodeBlock(b);
  const list = D.faultList(s.faults);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Cell under-voltage L1');
  assert.equal(list[0].hard, false);
  // words are faults[0..3] == regs 0x3A..0x3D
  assert.equal(D.faultList([0x1000, 0, 0, 0])[0].name, 'Discharge temp high L1');   // word1 bit12
  assert.equal(D.faultList([0x4000, 0, 0, 0])[0].name, 'Discharge temp low L1');    // word1 bit14
  assert.equal(D.faultList([0x8000, 0, 0, 0])[0].hard, true);                       // L2 => hard
  assert.equal(D.faultList([0, 0, 0x0010, 0])[0].name, 'Charge MOS stuck closed');  // word3 bit4
  const hard = D.faultList([0, 0, 0x0020, 0]);
  assert.equal(hard[0].name, 'Discharge MOS stuck closed');                        // word3 bit5
  assert.equal(hard[0].hard, true);
  assert.equal(D.faultList([0, 0x0200, 0, 0])[0].name, 'Cell imbalance L2');        // word2 bit9
  // reserved bits must still surface rather than vanish silently
  assert.equal(D.faultList([0, 0x1000, 0, 0])[0].name, 'Fault word 2 bit 12');
});

console.log('\n[3] demo mode drives the DOM');
check('nothing rendered before data', () => {
  assert.equal(txt('vVolt'), '––');
  assert.equal(txt('socVal'), '––');
  assert.equal($('cellChart').querySelectorAll('.bar').length, 0);
});
$('demoBtn').dispatchEvent(new window.Event('click'));
D.demoStep();
check('demo pill + button label', () => {
  assert.ok($('connPill').className.includes('demo'));
  assert.equal(txt('demoBtn'), 'Stop demo');
});
check('SOC gauge + stat tiles populated', () => {
  const soc = parseFloat(txt('socVal'));
  assert.ok(soc > 0 && soc < 100, 'soc=' + soc);
  assert.ok(parseFloat(txt('vVolt')) > 40 && parseFloat(txt('vVolt')) < 60, 'V=' + txt('vVolt'));
  assert.ok(parseFloat(txt('vCur')) > 0);
  assert.ok(/charging|discharging/.test(txt('statePill')));
  assert.ok(parseFloat($('socArc').getAttribute('stroke-dashoffset')) < 515);
  assert.ok(parseFloat($('socArc').getAttribute('stroke-dashoffset')) > 0);
});
check('16 cell bars with heights and titles', () => {
  const bars = $('cellChart').querySelectorAll('.bar');
  assert.equal(bars.length, 16);
  const hs = Array.from(bars).map(b => parseFloat(b.style.height));
  hs.forEach(h => assert.ok(h >= 4 && h <= 100, 'height=' + h));
  assert.ok(new Set(hs).size > 3, 'all bars identical — scale collapsed');
  assert.match(bars[0].title, /cell 1: \d+ mV/);
  assert.match(bars[0].querySelector('.tip').textContent, /\+?\d+ mV/);
});
check('spread / avg / footer numbers', () => {
  assert.ok(parseFloat(txt('cellAvg')) > 3 && parseFloat(txt('cellAvg')) < 3.5);
  assert.ok(parseFloat(txt('cellSpreadMv')) > 5);
  assert.match(txt('cellTag'), /16 cells/);
  assert.match(txt('cellFootL'), /min \d+ mV/);
});
check('bipolar current bar has width and direction class', () => {
  const f = $('curFill');
  assert.ok(parseFloat(f.style.width) > 0, 'width=' + f.style.width);
  assert.ok(/chg|dsg/.test(f.className));
});
check('MOSFET panel shows ON/ON in demo', () => {
  assert.equal($('swChg').getAttribute('aria-checked'), 'true');
  assert.equal($('swDsg').getAttribute('aria-checked'), 'true');
  assert.equal(txt('mosChgState'), 'ON');
  assert.ok($('mosChg').className.includes('on'));
  assert.equal($('swChg').disabled, false);
  assert.match(txt('mosNote'), /simulated/);
});
check('badges reflect MOS state', () => {
  assert.ok($('bChg').className.includes('yes'));
  assert.ok($('bDsg').className.includes('yes'));
});
check('faults panel reports all clear', () => {
  assert.match(txt('faultTag'), /all clear/);
  assert.match($('faults').textContent, /No active protection flags/);
});
check('history accumulates for charts', () => {
  D.demoStep(); D.demoStep();
  assert.ok(D.state.hist.length >= 3);
  assert.ok(D.state.cellHist.length >= 3);
  assert.equal(D.state.cellHist[0].length, 16);
});

check('canvas charts actually drew', () => {
  assert.ok(draw.fillRect >= 16, 'heatmap drew ' + draw.fillRect + ' rects');
  assert.ok(draw.stroke >= 2, 'current chart stroked ' + draw.stroke + ' paths');
  assert.ok(draw.gradients >= 1, 'no gradient created');
});

console.log('\n[4] MOSFET toggle in demo');
check('clicking charge switch turns it off and re-renders', () => {
  $('swChg').dispatchEvent(new window.Event('click'));
  assert.equal($('swChg').getAttribute('aria-checked'), 'false');
  assert.equal(txt('mosChgState'), 'OFF');
  assert.ok(!$('mosChg').className.includes('on'));
  assert.ok($('bChg').className.includes('no'));
  assert.match(txt('toast'), /Demo: Charge MOSFET off/);
});
check('clicking again turns it back on', () => {
  $('swChg').dispatchEvent(new window.Event('click'));
  assert.equal($('swChg').getAttribute('aria-checked'), 'true');
  assert.equal(txt('mosChgState'), 'ON');
});
check('demo stop resets everything', () => {
  $('demoBtn').dispatchEvent(new window.Event('click'));
  assert.equal(txt('vVolt'), '––');
  assert.equal($('cellChart').querySelectorAll('.bar').length, 0);
  assert.equal($('swChg').disabled, true);
  assert.equal(txt('connText'), 'disconnected');
});

console.log(fails.length ? `\n${fails.length} FAILURE(S)\n` + fails.join('\n') : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);

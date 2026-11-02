# Daly "SMART BMS" — BLE protocol & open-source landscape

Research date: 2026-11-02. Target app: `com.inuker.bluetooth.daily` ("SMART BMS" / "Daly Smart BMS").
Everything below was checked against live sources; the protocol is not a black box any more.

## TL;DR

- **Yes, it's fully cracked, and officially-ish so.** Daly's own Modbus register map is in the wild,
  and three independent projects decode it. You do not need to reverse anything.
- **Your app speaks Modbus RTU over BLE**, not the old `0xA5` frame protocol. This matters — most
  blog posts and half the GitHub projects implement the *other* one.
- **Skip the APK entirely.** Web Bluetooth on Android Chrome does the job, so "an HTML render" is
  literally the right architecture. Two projects already are exactly that; one is MIT and one file.

## Two incompatible protocols, same brand

| | Classic `0xA5` | Modbus (`0xD2`) ← **yours** |
|---|---|---|
| Frame | `A5 08 <cmd> 08 <data…> <sum8>` | `D2 03 <reg hi/lo> <count hi/lo> <crc16 le>` |
| Commands | `0x90` SOC, `0x91` cell range, `0x92` temps, `0x93` MOS, `0x94` status, `0x95` cells, `0x96` balancing, `0x97` faults | read-holding `0x03`, write-single `0x06`, write-multi `0x10` |
| Checksum | 8-bit sum of all bytes | CRC-16/IBM, poly `0xA001`, init `0xFFFF` |
| Seen on | older "DalyBMS" app / BMS Monitor, J/T/A/U/W-series | Smart BMS app, DL-… dongles |

How the Modbus one was identified: `roccotsi2/esp32-smart-bms-simulation` wiresharked the
official app talking to an ESP32 fake peripheral, and the app sends
`D2 03 00 00 00 3E D7 B9` on connect. That is the app in your hand.

## GATT

- Old firmware: service `0000fff0`, **notify `fff1`**, **write `fff2`**.
- Newer DL/JHB firmware: `fff1` returns `org.bluez.Error.NotPermitted`; use service `0000ff00`,
  **notify `ff01`**, **write `ff02`**.
- Try both; don't hardcode. Write without response.
- One request returns everything: read 62 registers from `0x0000` → 124-byte payload.

## Register map (byte offset = 2 × register address)

| Reg | Off | Meaning | Scale |
|---|---|---|---|
| `0x00–0x1F` | 0–63 | cell voltages, up to 16S | mV |
| `0x20–0x27` | 64–79 | cell temperatures, up to 8 | −40 °C |
| `0x28` | 80 | pack voltage | 0.1 V |
| `0x29` | 82 | current **+ = discharge** | 0.1 A, 30000 offset |
| `0x2A` | 84 | SOC | 0.1 % |
| `0x2B/2C` | 86/88 | max / min cell | mV |
| `0x2D/2E` | 90/92 | max / min temp | −40 °C |
| `0x2F` | 94 | 0 idle, 1 charging, 2 discharging | — |
| `0x30` | 96 | remaining capacity | 0.1 Ah |
| `0x31` | 98 | cell count | — |
| `0x32` | 100 | temp sensor count | — |
| `0x33` | 102 | cycles | — |
| `0x34` | 104 | balancing active | 0/1 |
| `0x35/36` | 106/108 | charge MOS / discharge MOS | 0/1 |
| `0x37/38` | 110/112 | avg cell / voltage delta | mV |
| `0x39` | 114 | power | W |
| `0x3A–0x3D` | 116–123 | fault status 1–4, 16 bits each | bitmask |
| `0x47–0x56` | — | extra cell voltages for >16S packs | mV |
| `0x80–0xE5` | — | **settings**: rated capacity, alarm thresholds, balancing thresholds, battery type, password, production date | — |
| `0xA5/0xA6` | — | charge / discharge MOS **switch** (write `06`, 1/0) | 0/1 |

Full bit-level fault definitions and the settings block: `dalyModbusProtocol.xlsx` in this folder,
mirrored from `syssi/esphome-daly-bms/docs/`.

Two footguns the community already burned themselves on:
- The spec documents SOC as `0.001` in one place; it is `0.1 %`. Divide by 10.
- Writing `0x000C`/`0x000D` looks like it enables discharge but does **not** actuate the MOSFET on
  real firmware. Use `0xA5`/`0xA6`. The parameter password the app asks for (`123456`) is
  **never sent to the BMS** — the app only reads reg `0xC9` to validate it locally. No unlock
  sequence needed, which is why the app's "password" is security theatre.

## Open-source projects worth your time

### Web / phone (what you actually asked for)

| Repo | Protocol | Stack | Notes |
|---|---|---|---|
| **`dropand/daly-bms-monitor`** | `A5` | plain HTML+CSS+JS, **one 39 KB app.js**, no build step, MIT | **Best starting point.** Full dashboard: SOC ring, verdict, time-to-full, ideal-vs-actual charge curve, per-cell bars, cell heat-map over time, balancing, 30-odd health checks, 48 h history, CSV export, EN/RU, `?demo` mode with simulated data. Read-only by design. **Protocol layer only swaps one function.** |
| **`0x53A/daly-bms-rs`** | `D2` Modbus | Rust + Yew + Trunk → wasm | Already speaks your protocol, `crc16_ibm_with_init`, reads the 0x3E block. Author calls it "vibe-coded in an afternoon". Thin UI (voltages only) but the working Modbus client is there. Also has a GH Pages deploy. |
| `Warchant/daly-web-dashboard-bluetooth` | `A5` | Next.js + Tailwind PWA, single `src/bt/util.ts` (~200 lines) | Neat, small, live demo on Cloudflare Pages. Only 7 tiles (V, I, SOC, temp, remaining time/capacity, cycles) — no cells. Good reference for the Web Bluetooth plumbing, wrong protocol. |
| `encap/better-bms-app` | JK (not Daly) | React PWA | **Read its README, not its code.** It's the canonical write-up of why this works: the original Qt app crashed mid-ride, Web Bluetooth was the escape hatch, and it documents the Android/Chrome packet-queue bug (ping < 10 ms ⇒ reconnect). Good architecture model if you go multi-BMS. |

### Libraries / protocol references (for cross-checking a decode)

- **`patman15/BMS_BLE-HA`** → `custom_components/bms_ble/plugins/daly_bms.py` **+ unit tests**. Most
  actively maintained BLE BMS decoder; has a mock-BMS test harness. Best-documented fault bitfield.
- **`fl4p/batmon-ha`** → `bmslib/models/daly2.py`. Contains the Modbus variant, and the comments
  are effectively an errata sheet (both UUID sets, the 0xA5/0xA6 discovery from an HCI snoop of the
  official app, and the note that J/T/A/U/W series ignore Modbus entirely).
- **`syssi/esphome-daly-bms`** — C++ BLE component, ships the register spreadsheet.
- **`dreadnought/python-daly-bms`** — MIT, archived, 110★. Classic protocol, both variants
  ("BMS monitor" and Sinowealth). Still the clearest readable implementation.
- **`roccotsi2/esp32-smart-bms-simulation`** — ESP32 that **impersonates** your BMS over BLE.
  Genuinely the single most useful dev tool here: build the UI against it with no battery connected.
- `ScanLabs/BMSAssistant` — commercial (paid dongle/app), but their "BMS data extractor" PDF is a
  useful second opinion on the register semantics.

## Practical gotchas

1. **Single client.** The official app holds the GATT connection. Force-stop it before connecting.
2. **BLE dongle sleeps** after ~1 h with no load/charging. A serial command wakes it; from BLE alone
   you may just need to press the button.
3. **Chrome does not keep the GATT link alive in the background.** Screen off / tab switched =
   dropped. For logging, keep it foreground or move to a native app / ESP32 bridge.
4. **Web Bluetooth needs HTTPS** (`localhost` is exempt). GitHub Pages / Cloudflare Pages are fine.
   Firefox and iOS Safari don't implement it — Android Chrome or desktop Chrome/Edge only.
5. Device name filter `DL-` is what the DL dongles advertise; add a name-prefix picker fallback.
6. **First thing to test on real hardware:** write `D2 03 00 00 00 3E D7 B9` and see if 124 bytes
   come back. If yes → Modbus, use `daly-modbus.js`. If silence but the BMS is definitely
   connected → it's an `A5` unit, use `dropand`'s or `Warchant`'s decoder instead.

## The app: `index.html`

Single self-contained file (49 KB, no CDN, no build step, no dependencies). Open it with:

```sh
cd ~/workspace/daly_bms_research && python3 -m http.server 8000
# then http://localhost:8000/            real BMS
#      http://localhost:8000/?demo      simulated pack
```

### Installing it as an app (and why not an APK)

The page ships a `manifest.webmanifest`, `sw.js` and two icons, so Chrome will offer **Install app**
when it's served over https (or localhost). Installed, it gets a launcher icon, runs standalone with
no browser chrome, and the service worker caches the shell so it opens offline afterwards.

**A real APK is not the easy path.** Android WebView does not implement Web Bluetooth
(Chromium issue 40703318 is still an open feature request), so Capacitor/Cordova/site-wrapper
approaches produce an app where `navigator.bluetooth` is `undefined` — the UI loads and can never
talk to the BMS. Making that work means swapping the transport for a native BLE plugin and
rebuilding: new code, plus an Android SDK + Gradle toolchain.

The one sane APK route is a **Trusted Web Activity**: a thin APK that runs the page in Chrome's
engine, so Web Bluetooth behaves exactly as it does in the browser. Two ways to get one:

- Install the PWA from Chrome on the phone — Chrome itself generates a WebAPK APK, no toolchain.
- Feed the hosted URL to PWABuilder (Bubblewrap) for a signed `.apk`/`.aab`, e.g. for Play.
  It needs a `/.well-known/assetlinks.json` on the origin or the app shows a URL bar.

Either way it needs a **stable https origin** — the quick tunnel URL changes on every restart, and a
new origin means a new install. Host the folder on GitHub Pages / Cloudflare Pages / any static host.

### Running it on a phone

**Option A — just open the file (no server).** Copy `index.html` to the phone and open it in
Chrome (e.g. `chrome://downloads` → tap the file). Android hands Chrome a `content://` URI.
Web Bluetooth does work from `file://` / `content://` — confirmed by Chrome's Web Bluetooth
DevRel, François Beaufort. Things to watch: the file picker must actually route to Chrome (a file
manager may open a previewer instead), and `?demo` won't be available since there's no query
string. Everything else works, including switching the FETs.

**Option B — https tunnel.** Needed if Option A misbehaves, and it makes the page installable:

```sh
cd ~/workspace/daly_bms_research
python3 -m http.server 8123 &
npx --yes cloudflared tunnel --url http://localhost:8123
# prints https://<random-words>.trycloudflare.com — open that on the phone
```

No account needed. The URL changes on every restart and dies with the process. Exposure is
low-risk: a visitor's browser would connect to *their own* nearby BLE device, not yours.

**Option C — localhost on the phone.** Termux + `python -m http.server`, then
`http://localhost:8000`. `localhost` is a secure context, so the API is live.

**Do not** use plain `http://192.168.x.x:8000` — verified: that origin reports
`isSecureContext: false` and `navigator.bluetooth` is `undefined`. Chrome only treats `localhost`
and https as trustworthy.

What it does:

- Polls the BMS at 1 Hz with one `0x3E`-register read per tick.
- SOC donut, pack V, bipolar current bar, power, temps, remaining Ah, cycles, sensor count.
- **Cell bar chart** with an auto-zoomed axis (a 21 mV spread fills the chart — the tag says so),
  per-cell tooltips in mV and deviation from the pack average, green/amber/red by deviation,
  dashed average line, min/max footer.
- **Cell-balance heat-map** over the last 120 samples.
- **Current history** area chart, split into charge/discharge colours around a zero line.
- **MOSFET switches** for charge (0xA5) and discharge (0xA6): confirm dialog, write, wait for the
  0x06 echo, toast the result. Simulated locally in demo mode.
- **Protection panel** naming every active fault bit from the register map, hard faults vs
  L1 warnings, sorted.
- Raw-frame log for debugging, plus a `?demo` mode so you can work on the UI with no battery.
- **Parameters page** (Settings button): 31 writable registers — cell OV/UV and imbalance trips,
  pack OV/UV, charge/discharge over-current, all eight temperature trips plus spread and MOS alarm,
  balancing threshold and hysteresis, rated capacity, chemistry, sleep timer, SOC write.
  Range-checked per field, with cross-checks that refuse an OV below its UV (and vice versa).
  Apply writes each register, waits for the echo, then **reads the block back** and reports anything
  that didn't stick. Device card shows firmware, hardware and production date (read from 0xA9).
  `was …` appears only once you change a field. Demo mode is a full sandbox — writes persist
  locally so you can rehearse the whole flow.

### Two limits per protection — and the app only shows one

Every protection is stored twice. Verified against the official app's own parameter screens on a
16S pack: **12 of 12** values the app displays match the *second* register of each pair.

| App says | Register | Hidden twin |
|---|---|---|
| single cell volt-high protection 3.60 V | `0x8C` = 3600 | `0x8B` = 3650 |
| single cell volt-low protection 2.87 V | `0x8E` = 2870 | `0x8D` = 2300 |
| sum volt high protect 57.60 V | `0x90` = 576 | `0x8F` = 576 |
| sum volt low protect 46.00 V | `0x92` = 460 | `0x91` = 376 |
| differential pressure alarm 0.20 V | `0xA0` = 200 | `0x9F` = 500 |
| chg overcurrent protect 20.0 A | `0x94` = 29800 | `0x93` = 29520 (48 A) |
| dischg overcurrent protect 40.0 A | `0x96` = 30400 | `0x95` = 30480 (48 A) |
| chg high temp 40 °C | `0x98` = 80 | `0x97` = 60 °C |
| chg low temp 0 °C | `0x9A` = 40 | `0x99` = −35 °C |
| dischg high temp 40 °C | `0x9C` = 80 | `0x9B` = 65 °C |
| dischg low temp −5 °C | `0x9E` = 35 | `0x9D` = −35 °C |
| diff temp 15 °C | `0xA2` = 15 | `0xA1` = 10 °C |

The twin is always *further from nominal* than the user setting (11 of 12 pairs), and both current
twins are exactly 48 A — the shape of a **factory / hardware ceiling**, not a user threshold.
Daly's control-strategy doc says level 2 alarms and cuts the MOS while level 1 only alarms, which
fits: the app writes level 2, and level 1 holds the inert safety rail.

**So the app is authoritative.** Earlier in this file I had these two swapped, inferring from the
top-of-charge voltage instead of reading the app. That was wrong — trust the app's own numbers.
The temperature-spread pair is the one anomaly (twin sits below the protection); it doesn't matter
because Daly states spread and SOC alarms never cut the MOS.

The page shows the app's values as editable and puts the twins in a read-only "Undocumented limits"
group, since their semantics aren't documented well enough to write safely.

### Relabelling notes from the app

- `0xA8` is **Fan On Temperature**, not a MOS protection alarm (the app shows 47 °C, matching `87 − 40`).
- `0x81` is **cell reference voltage** (3.20 V), used for SOC estimation.
- `0x82`–`0x88` are the collection-board layout: board count, cells per board ×3, temp sensors per board ×3.

### Current limits are stored signed

Live current and the current-limit registers share the same `30000` offset, and Daly's current is
**negative while charging**. A charge limit of 48 A is therefore stored as `30000 − 480 = 29520`,
and a discharge limit of 48 A as `30480`. Reading them naively with `(raw − 30000) / 10` produces
−48 A and −20 A. The page shows magnitudes and writes back with the correct sign per direction.

### Writing parameters: the echo is a lie, the read-back is the truth

The first version waited for the BMS to echo each `0x06` write and called a missing echo a failure.
**Many Daly firmwares never echo writes** — the value lands fine and the UI still cries failure.

The page now treats a silent write as normal:

1. Send the register write, wait only ~400 ms for an optional echo.
2. Let it settle, then read the whole parameter block back.
3. Retry the read once after 450 ms (some firmwares lag a moment before committing).
4. Report per field: `✓ written` (confirmed by read-back), `✗ reads back unchanged`, or
   `? sent, couldn't re-read to confirm` if the verification read itself failed.

A switch that never acknowledges still succeeds, and a write the device genuinely ignores is still
caught — both are covered by `test_transport.mjs`, which runs the page against a mock BMS that
applies writes to a memory block but stays silent on `0x06`.

### The password, honestly

Daly's parameter code defaults to `123456`. Snooping the official app (batmon-ha issue #356) showed
it **never sends the code** — it only reads register `0xC9` and compares locally. This page does the
same: it reads `0xC9`, compares what you typed, and refuses to write until it matches. If the
register reads back blank on your firmware, it assumes `123456` and says so.

So it is a guard rail against fat-fingering a protection threshold, not a security control. Anyone
with another BMS tool can still write these registers. Don't treat it as an access-control boundary.

Not exposed: the WiFi/IP block (`0xCE+`), the serial number (`0xB9~0xC8`), acquisition-board
configuration (`0x82~0x88`) and `0x81` cell reference voltage, whose semantics aren't documented
well enough to write safely.

## Files here

- `daly-modbus.js` — CRC, frame builders, frame reassembly across BLE notifications, full 124-byte
  decoder, and a ~40-line Web Bluetooth `connect()`. Drop into a page as an ES module.
- `test_decode.mjs` — asserts the generated bytes match the spec's worked example
  (`D2 06 00 0C 00 01 9B AA`), decodes a synthetic 16S pack, checks reassembly across split
  notifications, and confirms corrupt CRC frames are rejected. `node test_decode.mjs` → all pass.
- `dalyModbusProtocol.xlsx` — Daly's register map, including fault bits and the settings block.

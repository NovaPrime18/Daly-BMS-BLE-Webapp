<p align="center">
  <img src="icon-512.png" width="88" alt="">
</p>

<h1 align="center">Daly Smart BMS — BLE web app</h1>

<p align="center">
  Live telemetry and parameter settings for a Daly <em>Smart BMS</em>, straight from your browser.<br>
  No app store, no account, no cloud, no build step.
</p>

<p align="center">
  <a href="https://novaprime18.github.io/Daly-BMS-BLE-Webapp/"><b>Open the app →</b></a>
</p>

---

## What it is

A single-page web app that talks to a Daly BMS over Bluetooth LE using the Web Bluetooth API. It
replaces the vendor app with something that shows more, updates faster, and doesn't crash when you
switch away from it.

It speaks the **Modbus RTU** dialect used by the "Smart BMS" app (`com.inuker.bluetooth.daily`) —
slave address `0xD2`, function `0x03` reads and `0x06` writes.

Works in Chrome or Edge on Android and on desktop. It does **not** work in Firefox, Safari or on
iOS, because none of them implement Web Bluetooth.

## Features

**Live view** — polls once per second for everything the BMS will give in one request.

- SOC ring with charge / discharge / idle state
- pack voltage, power, current (bipolar bar), temperature, remaining Ah, cycle count
- **cell bar chart** with an auto-zoomed axis, deviation-based colouring, per-cell mV + delta
  tooltips, average line and min/max footer
- **balance heat-map** over the last 120 samples
- **current history** chart, split into charge and discharge around a zero line
- **MOSFET switches** for charge and discharge — one tap, no dialog, confirmed by reading the
  state back
- **protection panel** that names every active fault bit (all four fault words), hard trips above
  advisory ones
- raw frame log for when a decode looks wrong

**Settings page** — read and write the parameters the official app exposes, plus a bit more.

- cell over/under-voltage, cell imbalance, pack over/under-voltage
- charge and discharge over-current
- all eight temperature trips, temperature spread, fan-on temperature
- balancing start voltage and hysteresis, rated capacity, chemistry, cell reference voltage,
  sleep timer, SOC write
- device info: firmware, hardware, production date, pack configuration
- range checks per field, and cross-checks that refuse an OV below its UV (or the reverse)
- every write is **verified by reading the block back**, then reported per field

**Demo mode** — append `?demo` to the URL for a simulated 16S LiFePO4 pack. No battery required, and
nothing is transmitted. Handy for poking at the UI or checking a change before touching hardware.

**Installable** — manifest + service worker, so Chrome offers *Install app*. Launcher icon,
standalone window, opens offline.

## Quick start

Use the hosted copy: **https://novaprime18.github.io/Daly-BMS-BLE-Webapp/**

Or run it yourself — it's just static files:

```sh
git clone https://github.com/novaprime18/Daly-BMS-BLE-Webapp.git
cd Daly-BMS-BLE-Webapp
python3 -m http.server 8000
# open http://localhost:8000/
```

To install on a phone, open the page in Chrome over **https** and choose *Install app* (or
*Add to Home screen*). A `file://` copy still works for a quick look, but the manifest and offline
cache need a real origin.

## Why a web app and not an APK

Android WebView doesn't implement Web Bluetooth, so every "wrap your site in an app" tool produces
something that loads and then can't see the BMS. The browser is the only place the API exists
without writing a native Bluetooth layer.

If you want an installable icon, use the PWA install — Chrome generates a real WebAPK for it. For a
Play Store package, point PWABuilder at the hosted URL and add their `assetlinks.json`.

## Using it

1. Force-stop the official Daly app — the BMS accepts **one** Bluetooth client at a time.
2. Open the page and press **Connect**, then pick your `DL-…` device. If none appear, press the
   button on the Bluetooth dongle; it sleeps after about an hour idle.
3. Read the live view. For parameters, press **Settings** and unlock.

### Unlocking the settings

Daly protects parameters with a six-digit code. The factory default is **123456**.

This page reads the code stored at register `0xC9`, compares what you typed, and refuses to write
until it matches — the same check the official app performs. Note what that means: the code is
compared **client-side** and is never sent to the BMS, exactly like the vendor app. It's a guard
rail against fat-fingering a protection threshold, not an access-control boundary. Anyone with
another BMS tool can still write these registers.

## How it works

| | |
|---|---|
| Transport | Modbus RTU over GATT, slave `0xD2` |
| Read | `0x03`, 62 registers from `0x0000` → 124-byte payload, once per second |
| Write | `0x06` single register |
| CRC | CRC-16/IBM, poly `0xA001`, init `0xFFFF`, appended little-endian |
| GATT | `fff0` service with `fff1` notify / `fff2` write, or newer `ff00` / `ff01` / `ff02` |
| Parameters | `0x80`–`0xA8`, 41 registers |
| Device info | `0xA9`, 32 registers (firmware / hardware / production date as ASCII) |
| Password | `0xC9`, 3 registers, ASCII |

Field scaling (byte offset = 2 × register address): cells are mV at `0x00`–`0x1F`, temperatures at
`0x20`–`0x27` with a −40 °C offset, pack voltage `0x28` at 0.1 V, current `0x29` at 0.1 A with a
30000 offset (negative while charging), SOC `0x2A` at 0.1 %, fault words at `0x3A`–`0x3D`.

**Writes are not acknowledged by every firmware.** Many Daly units apply a write without echoing the
frame, so a missing echo is not treated as failure here — the page re-reads the register and reports
what the BMS actually stored, retrying the read once if a value looks stale.

**Two limits per protection.** Every protection is stored twice. The official app only shows one of
them, and that's the one this page edits. The other is exposed read-only: it always sits further
from nominal (both current twins read 48 A on the pack this was tested against), which looks like a
factory ceiling rather than something you're meant to tune.

## Safety

Read this before you change a threshold.

- These are the numbers that decide when your battery stops charging or stops feeding your load.
  Set an over-voltage below the pack's resting voltage, or an over-current below your actual load,
  and it will cut out at the worst possible moment.
- **There is no undo.** Values go straight to the BMS. Note them down first.
- Every write is verified by re-reading, and any value that didn't stick is reported rather than
  silently accepted — but that only tells you the BMS stored it, not that your number was sensible.
- Tested against one 16S LiFePO4 pack. Other models and firmwares may lay things out differently.

## Known limitations

- One Bluetooth client at a time. Close the vendor app.
- Chrome drops the GATT connection when the screen sleeps or the tab is backgrounded, so this is a
  live gauge, not a logger. Keep the page in the foreground.
- The BMS Bluetooth dongle sleeps after roughly an hour with no load or charge.
- The Web Bluetooth device picker only appears over `https` or `localhost`.
- `file://` and Android `content://` work for the Bluetooth part, but not for installing.

## Files

```
index.html              the whole app — HTML, CSS, JS, protocol, no dependencies
manifest.webmanifest    PWA metadata
sw.js                   offline shell cache
icon-192.png             icons
icon-512.png
```

`index.html` is entirely self-contained. The other files only add installability and offline
support; deleting them leaves a working page.

## Vibe-code disclosure

**This app was vibe-coded with an LLM** — specifically **DeepSeek V4.1-flash (build 1017)**, running
through the Hermes agent, over a series of iterative prompts. It was not hand-written and it has not
been through a formal code review. Treat it as hobby-grade software.

What that does and doesn't mean here:

- **Grounded, not hallucinated.** The protocol wasn't guessed. The register map comes from Daly's
  own Modbus documentation as mirrored in `syssi/esphome-daly-bms`, cross-checked against
  `fl4p/batmon-ha`, `patman15/aiobmsble` and a hardware simulation of the BMS. The parameter
  semantics were then checked value-by-value against the official app's own screens on a real pack —
  12 of 12 protection values matched.
- **Tested where it can be.** 65 automated checks run against the page: frame construction against
  the spec's own worked examples, decoding, CRC rejection, frame reassembly across split BLE
  notifications, the settings gate, validation, and the full write-and-verify cycle against a mock
  BMS that stays silent on writes.
- **Not proven on your hardware.** The code was written by a model and exercised by one human on one
  battery. Writes were confirmed on a single 16S pack. If you have a different Daly model, verify the
  values against the vendor app before trusting them.
- **No warranty.** See safety above. You are writing to the device that protects your cells.

If you're going to build on this, read the protocol section, check the register you care about
against your own BMS, and don't point it at anything expensive.

## Credits

Protocol knowledge and prior art that made this possible:

- [syssi/esphome-daly-bms](https://github.com/syssi/esphome-daly-bms) — the Modbus register map
- [fl4p/batmon-ha](https://github.com/fl4p/batmon-ha) — the `daly2` implementation and its errata
- [patman15/aiobmsble](https://github.com/patman15/aiobmsble) — fault semantics and device info
- [roccotsi2/esp32-smart-bms-simulation](https://github.com/roccotsi2/esp32-smart-bms-simulation) —
  the BLE simulation of the vendor app
- [dreadnought/python-daly-bms](https://github.com/dreadnought/python-daly-bms) — the classic protocol
- [dropand/daly-bms-monitor](https://github.com/dropand/daly-bms-monitor) and
  [Warchant/daly-web-dashboard-bluetooth](https://github.com/Warchant/daly-web-dashboard-bluetooth) —
  UI inspiration, and proof a browser could do this at all

Not affiliated with or endorsed by Daly Electronics. Daly and Smart BMS are their trademarks.

## License

No license has been chosen yet. If you want others to reuse it, add one — MIT is the obvious fit for
something like this.

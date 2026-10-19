# KaiLARP-core

The emulation part. Boots a KaiOS / Boot2Gecko web app on hardware that is not a
JioPhone, by reinstating the `moz*` API surface the app expects, with an honest
capability gate in front of it.

- Pretends to be a **Jio F491H** (JioPhone 2) running **KaiOS 2.5.3.2 / Gecko
  48.0a2**, with the real dump-derived User-Agent and a 240x320 viewport.
- Answers `mozSettings`, `mozMobileConnections`, `mozTelephony`,
  `mozMobileMessage`, `mozAlarms`, `getDeviceStorage`, `mozBluetooth`,
  `mozWifiManager`, `mozCameras`, `mozL10n`, `mozApps`, `geolocation` and
  friends, plus the two things real packages need before any of that:
  `navigator.hasFeature()` and the `getDataStores()` device datastore
  (`jio_service_store`), seeded from the profile.
- `window.close()` is a real event here, not a no-op: a KaiOS app quitting
  itself is reported as `closed: true` instead of looking like a hang.
- Refuses to fabricate a secure element, a DRM licence or hardware
  attestation, and refuses to boot an app that needs one. See
  [`../KaiLARP-research/docs/spoofing-model.md`](../KaiLARP-research/docs/spoofing-model.md).

## Try it

```sh
npm install
npx playwright install chromium

node bin/kailarp-doctor.js                 # what this host can and cannot do
node bin/kailarp-run.js fixtures/apps/demo # boot the bundled probe, record it
node bin/kailarp-verify.js                 # run everything and write out/evidence
```

`kailarp-verify` boots the demo app, boots the quirks probe (the platform
behaviours a real package depends on), gates the real descriptors taken from
the dump, boots one of them, proves the refusal path, and transcodes the
screencasts. It writes `out/verification.json` and `out/verification.md`.

To boot a package you already have on disk, point `kailarp-run` at a directory
holding `update.webapp` and `application.zip`:

```sh
node bin/kailarp-run.js /path/to/jiopay.jio.com --out out/jiopay
```

`kailarp-run` also takes a dump URL directly, the same URL you would paste into
the phone:

```sh
node bin/kailarp-run.js \
  https://dumps.tadiphone.dev/dumps/jio/f491h/-/tree/MAD-user-6.0-MRA58K-Jio-F491H-F001-04-13-310823-release-keys/system/b2g/webapps/youtube.com
```

It resolves that to the GitLab raw paths, fetches `update.webapp` and
`application.zip`, and boots the package. (On a network that lets multi-MiB
files through; see the note in `KaiLARP-research/docs/f491h-dump.md`.)

## Layout

```
src/device.js        JioPhone F491H profile, User-Agent, SIM/network fixture
src/manifest.js      lenient descriptor parsing + permission -> capability map
src/capabilities.js  native / spoof / deny model and the gate
src/source.js        local dir, direct URL, or GitLab tree/raw URL resolution
src/zip.js           minimal zip reader (no dependencies)
src/shim.js          the injected B2G compatibility layer
src/runtime.js       boot orchestration, screencast, probes, transcodes
bin/                 doctor / run / verify
fixtures/            demo, quirks and refused apps, plus the real dump snapshot
```

## Serving model

Apps are served by intercepting the engine's requests and fulfilling them from
the unpacked package, rather than by binding a port. That is both what a
device-side WebView does with local files and the only thing that works on
hosts that block `listen()`.

## Evidence

`out/` after a verify run:

```
verification.json / verification.md   the report
demo/report.json                      the raw boot report
demo/*.png                            a frame of the app
demo/screen/*.webm                    what the engine recorded
demo/screen/*-2x.mp4                  transcodes
real-youtube-run/...                  a real dump descriptor booted on its own
```

Each recording is probed with `ffmpeg` (`signalstats`) so "it ran" means
"frames exist and are not blank", not "a file was created".

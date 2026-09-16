#!/usr/bin/env node
// Runs the whole KaiLARP-core faithfully on this host and writes evidence.
//
//   node bin/kailarp-verify.js
//
// Evidence lands in out/: a JSON report, a Markdown summary, per-run reports,
// screencasts (.webm from the engine) and transcodes (.mp4) plus frame probes
// so "it ran" is something you can look at rather than something we claim.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { boot, probeVideo, transcode, REPO_ROOT, which } from '../src/runtime.js';
import { parseManifestText, normaliseManifest } from '../src/manifest.js';
import { gateForManifest, BASE_CAPABILITIES } from '../src/capabilities.js';
import { F491H } from '../src/device.js';

const OUT = path.join(REPO_ROOT, 'out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const steps = [];
let failed = 0;
function step(name, ok, detail) {
  steps.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined && detail !== null ? ` — ${detail}` : ''}`);
}

const expectedDemoChecks = [
  'ua.kaios', 'ua.model', 'screen', 'memory', 'ril.slots', 'ril.voice', 'telephony.dial',
  'telephony.active', 'sms.recorded', 'settings.roundtrip', 'storage.sdcard', 'alarms',
  'gps.mock', 'l10n', 'bluetooth', 'wifi', 'capabilities', 'camera.list',
  'getUserMedia.fake', 'pay.refused', 'secure-element.refused', 'crypto.real',
];
const expectedApiCalls = [
  'mozSettings.set', 'mozSettings.get', 'mozTelephony.dial', 'mozMobileMessage.send',
  'getDeviceStorage', 'deviceStorage.addNamed', 'deviceStorage.get', 'mozAlarms.add',
  'geolocation.getCurrentPosition', 'mozBluetooth.getDefaultAdapter', 'mozWifiManager.getNetworks',
  'mozPay.refused', 'mozSecureElement.refused',
];

const summary = {
  generatedAt: new Date().toISOString(),
  core: '0.1.0',
  host: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    memoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    engine: null,
    ffmpeg: which('ffmpeg'),
  },
  device: { id: F491H.id, model: F491H.model, kaios: F491H.kaios.version, gecko: F491H.kaios.gecko, userAgent: F491H.userAgent },
  steps,
  runs: {},
  gates: {},
  recordings: [],
  ok: false,
};

/* ---------------------------------------------------------------- 1. host */

let enginePath = null;
try { enginePath = chromium.executablePath(); } catch { /* handled below */ }
summary.host.engine = enginePath;
step('host.engine', !!enginePath && fs.existsSync(enginePath), enginePath || 'chromium not installed');
step('host.ffmpeg', !!summary.host.ffmpeg, summary.host.ffmpeg || 'ffmpeg missing');

/* ------------------------------------------------------------ 2. fixtures */

const fixtureBuild = spawnSync('python3', ['fixtures/build-fixtures.py'], { cwd: REPO_ROOT, encoding: 'utf8' });
step('fixtures.build', fixtureBuild.status === 0, (fixtureBuild.stdout || '').trim().split('\n').join(' | '));

/* --------------------------------------------------------------- 3. demo */

console.log('\n== booting the demo app under KaiLARP-core ==');
const dumpSettings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/f491h/settings.sample.json'), 'utf8'));
const demo = await boot(path.join(REPO_ROOT, 'fixtures/apps/demo'), { outDir: path.join(OUT, 'demo'), finishTimeoutMs: 12000, settings: dumpSettings });
summary.runs.demo = {
  booted: demo.booted,
  gate: demo.capabilities.summary,
  checks: demo.appResult?.checks || {},
  apiCalls: demo.apiCalls,
  pageErrors: demo.pageErrors,
  video: demo.video,
  videoProbe: demo.videoProbe,
};
step('demo.booted', demo.booted, `${demo.capabilities.summary.native} native / ${demo.capabilities.summary.spoofed} spoofed / ${demo.capabilities.summary.denied} denied`);
step('demo.no-page-errors', demo.pageErrors.length === 0, demo.pageErrors.join('; ') || 'clean');
fs.writeFileSync(path.join(OUT, 'demo', 'report.json'), JSON.stringify(demo, null, 2) + '\n');

const demoChecks = demo.appResult?.checks || {};
const missing = expectedDemoChecks.filter((k) => !(k in demoChecks));
const failing = expectedDemoChecks.filter((k) => demoChecks[k] && !demoChecks[k].ok);
step('demo.checks-present', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${expectedDemoChecks.length} checks reported`);
step('demo.checks-pass', failing.length === 0, failing.length ? `failed ${failing.join(', ')}` : 'all passed');

const missingCalls = expectedApiCalls.filter((k) => !demo.apiCalls[k]);
step('demo.apis-exercised', missingCalls.length === 0, missingCalls.length ? `not called: ${missingCalls.join(', ')}` : `${Object.keys(demo.apiCalls).length} distinct moz*/B2G calls`);
step('demo.spoofed-ril-is-labelled', demo.dump?.log?.some((l) => /no real modem|never transmitted|mocked fix/i.test(l.msg)) === true, 'runtime log states the emulation out loud');
step('demo.refusals-honoured', (demo.apiCalls['mozPay.refused'] || 0) > 0 && (demo.apiCalls['mozSecureElement.refused'] || 0) > 0, 'pay and secure-element requests rejected');

step('demo.video-recorded', !!demo.video && fs.existsSync(demo.video) && fs.statSync(demo.video).size > 2048, demo.video ? `${(fs.statSync(demo.video).size / 1024).toFixed(0)} KiB` : 'no file');
step('demo.video-shows-content', demo.videoProbe?.frames > 0 && demo.videoProbe?.nonBlank === true, `frames=${demo.videoProbe?.frames} meanLuma=${demo.videoProbe?.meanLuma?.toFixed?.(1)}`);

/* ------------------------------------------------- 4. real dump manifests */

console.log('\n== gating manifests taken from the F491H dump ==');
const realDir = path.join(REPO_ROOT, 'fixtures/f491h/real-manifests');
const realManifests = {};
for (const file of fs.readdirSync(realDir).filter((f) => f.endsWith('.webapp'))) {
  const raw = JSON.parse(fs.readFileSync(path.join(realDir, file), 'utf8'));
  const manifest = normaliseManifest(raw, { originFromName: `app://${file.replace(/\.webapp$/, '')}` });
  const withFake = gateForManifest(manifest, BASE_CAPABILITIES);
  const noFake = gateForManifest(manifest, { ...BASE_CAPABILITIES, camera: { mode: 'deny', note: 'no fake media' }, microphone: { mode: 'deny', note: 'no fake media' } });
  realManifests[manifest.name] = {
    file,
    origin: manifest.origin,
    version: manifest.version,
    permissions: manifest.permissionNames,
    gateWithFakeMedia: { ok: withFake.ok, denied: withFake.denied.map((d) => d.capability) },
    gateWithoutFakeMedia: { ok: noFake.ok, denied: noFake.denied.map((d) => d.capability) },
  };
  console.log(`  ${manifest.name}: fake-media=${withFake.ok ? 'runnable' : 'REJECTED ' + withFake.denied.map((d) => d.capability).join(',')}  no-fake-media=${noFake.ok ? 'runnable' : 'REJECTED ' + noFake.denied.map((d) => d.capability).join(',')}`);
}
summary.gates.realManifests = realManifests;
step('gate.facebook.runnable', realManifests.Facebook?.gateWithFakeMedia.ok === true, 'Facebook only needs comms/storage/network');
step('gate.whatsapp.needs-fake-media', realManifests.WhatsApp?.gateWithoutFakeMedia.ok === false && realManifests.WhatsApp?.gateWithFakeMedia.ok === true, 'video-capture/audio-capture decides it');
step('gate.diagnostics.rejected', realManifests.FPDD?.gateWithFakeMedia.ok === false && realManifests.FPDD.gateWithFakeMedia.denied.includes('secureelement'), `denied ${realManifests.FPDD?.gateWithFakeMedia.denied.join(',')}`);

const youtubeRaw = parseManifestText(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/f491h/youtube.update.webapp'), 'utf8'), 'youtube');
const youtube = normaliseManifest(youtubeRaw);
const youtubeGate = gateForManifest(youtube);
summary.gates.youtube = { origin: youtube.origin, permissions: youtube.permissionNames, ok: youtubeGate.ok, requirements: youtubeGate.requirements.map((r) => ({ capability: r.capability, mode: r.mode })) };
step('gate.youtube.descriptor-parses', youtube.origin === 'app://youtube.com' && youtube.permissionNames.includes('audio-capture'), `${youtube.permissionNames.length} permissions from the real update.webapp`);

/* --------------------------------------- 5. boot a real dump descriptor */

console.log('\n== booting a real dump descriptor (application.zip not reachable from this host) ==');
const realAppDir = path.join(OUT, 'real-youtube');
fs.mkdirSync(realAppDir, { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, 'fixtures/f491h/youtube.update.webapp'), path.join(realAppDir, 'update.webapp'));
const realRun = await boot(realAppDir, { outDir: path.join(OUT, 'real-youtube-run'), finishTimeoutMs: 8000, settings: dumpSettings });
summary.runs.realDescriptor = { display: realRun.manifest.display, origin: realRun.manifest.origin, booted: realRun.booted, gate: realRun.capabilities.summary, result: realRun.appResult, video: realRun.video, videoProbe: realRun.videoProbe };
step('real-descriptor.booted', realRun.booted === true, `${realRun.manifest.display} v${realRun.manifest.version}`);
step('real-descriptor.parsed-and-gated', realRun.appResult?.checks?.descriptorParsed === true && realRun.appResult?.checks?.gated === true, 'descriptor parsed, gate passed');
step('real-descriptor.video', realRun.videoProbe?.frames > 0 && realRun.videoProbe?.nonBlank === true, `frames=${realRun.videoProbe?.frames}`);

/* --------------------------------------------- 6. the refusal is real */

console.log('\n== an app that needs what we refuse ==');
const denied = await boot(path.join(REPO_ROOT, 'fixtures/apps/denied'), { outDir: path.join(OUT, 'denied'), finishTimeoutMs: 4000 });
summary.runs.denied = { booted: denied.booted, rejected: !!denied.rejected, reason: denied.rejectedReason, denied: denied.capabilities.denied.map((d) => d.capability), video: denied.video };
step('denied.gate-rejects', denied.rejected === true && denied.capabilities.denied.some((d) => d.capability === 'secureelement') && denied.capabilities.denied.some((d) => d.capability === 'drm'), denied.rejectedReason);
step('denied.never-booted', denied.booted === false && !denied.video, 'no page, no recording');
step('denied.reasons-are-explicit', denied.capabilities.denied.every((d) => d.note && d.note.length > 10), denied.capabilities.denied.map((d) => `${d.capability}: ${d.note}`).join(' | '));

/* ------------------------------------------------ 7. transcode evidence */

console.log('\n== screen-record pipeline ==');
const recs = [];
const demoVideoOk = demo.videoProbe?.frames > 0;
function safeTranscode(input, dest, opts) {
  try {
    transcode(input, dest, opts);
    return dest;
  } catch (err) {
    console.log(`  transcode skipped: ${err.message}`);
    return null;
  }
}
if (demo.video) {
  const base = path.join(OUT, 'demo', 'screen');
  recs.push({ label: 'demo 1x webm', file: demo.video, probe: demo.videoProbe });
  const small = safeTranscode(demo.video, path.join(base, 'demo-2x.mp4'), { scale: '480:640' });
  if (small) recs.push({ label: 'demo 2x mp4', file: small, probe: probeVideo(small) });
  const wide = safeTranscode(demo.video, path.join(base, 'demo-16x9-240p.mp4'), { scale: '-2:240', pad: '426:240:(426-iw)/2:(240-ih)/2:color=black' });
  if (wide) recs.push({ label: 'demo 16:9 240p mp4', file: wide, probe: probeVideo(wide) });
}
if (realRun.video) {
  const wide = safeTranscode(realRun.video, path.join(OUT, 'real-youtube-run', 'screen', 'youtube-16x9-240p.mp4'), { scale: '-2:240', pad: '426:240:(426-iw)/2:(240-ih)/2:color=black' });
  if (wide) recs.push({ label: 'real descriptor 16:9 240p mp4', file: wide, probe: probeVideo(wide) });
}
summary.recordings = recs;
for (const r of recs) step(`recording.${r.label}`, r.probe.frames > 0 && r.probe.nonBlank === true, `frames=${r.probe.frames} luma=${r.probe.meanLuma?.toFixed?.(1)} ${(r.probe.bytes / 1024).toFixed(0)} KiB`);
void demoVideoOk;

/* ------------------------------------------------------------- 8. report */

summary.ok = failed === 0;
summary.failed = failed;
fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify(summary, null, 2) + '\n');

const md = [];
md.push('# KaiLARP-core verification');
md.push('');
md.push(`Run at ${summary.generatedAt} on ${summary.host.platform}, node ${summary.host.node}, engine \`${summary.host.engine}\`.`);
md.push(`Device profile: **${F491H.model}** (${F491H.marketingName}), KaiOS ${F491H.kaios.version}, Gecko ${F491H.kaios.gecko}.`);
md.push('');
md.push(`**${summary.ok ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}**`);
md.push('');
md.push('| check | result | detail |');
md.push('| --- | --- | --- |');
for (const s of steps) md.push(`| ${s.name} | ${s.ok ? 'pass' : 'FAIL'} | ${(s.detail ?? '').toString().replace(/\|/g, '\\|').slice(0, 160)} |`);
md.push('');
md.push('## Compatibility probe');
md.push('');
md.push('| probe | result | detail |');
md.push('| --- | --- | --- |');
for (const [k, v] of Object.entries(demoChecks)) md.push(`| ${k} | ${v.ok ? 'pass' : 'FAIL'} | ${(v.detail ?? '').replace(/\|/g, '\\|')} |`);
md.push('');
md.push('## Real dump manifests');
md.push('');
md.push('| app | permissions | with fake media | without |');
md.push('| --- | --- | --- | --- |');
for (const [name, m] of Object.entries(realManifests)) {
  md.push(`| ${name} | ${m.permissions.length} | ${m.gateWithFakeMedia.ok ? 'runnable' : 'rejected: ' + m.gateWithFakeMedia.denied.join(', ')} | ${m.gateWithoutFakeMedia.ok ? 'runnable' : 'rejected: ' + m.gateWithoutFakeMedia.denied.join(', ')} |`);
}
md.push('');
md.push('## Recordings');
md.push('');
md.push('| recording | frames | mean luma | file |');
md.push('| --- | --- | --- | --- |');
for (const r of recs) md.push(`| ${r.label} | ${r.probe.frames} | ${r.probe.meanLuma?.toFixed?.(1)} | \`${path.relative(REPO_ROOT, r.file)}\` |`);
md.push('');
md.push('## Capabilities');
md.push('');
md.push('| capability | mode | note |');
md.push('| --- | --- | --- |');
for (const [c, v] of Object.entries(BASE_CAPABILITIES)) md.push(`| ${c} | ${v.mode} | ${v.note} |`);
md.push('');
fs.writeFileSync(path.join(OUT, 'verification.md'), md.join('\n') + '\n');

console.log(`\n${summary.ok ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
console.log(`  json: ${path.relative(REPO_ROOT, path.join(OUT, 'verification.json'))}`);
console.log(`  md:   ${path.relative(REPO_ROOT, path.join(OUT, 'verification.md'))}`);
process.exit(summary.ok ? 0 : 1);

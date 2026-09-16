#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { BASE_CAPABILITIES, gateForManifest } from '../src/capabilities.js';
import { parseManifestText, normaliseManifest } from '../src/manifest.js';
import { F491H } from '../src/device.js';
import { which } from '../src/runtime.js';

const args = process.argv.slice(2);
const manifestArg = args.includes('--manifest') ? args[args.indexOf('--manifest') + 1] : null;
const jsonOut = args.includes('--json');

const host = {
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpus: os.cpus().length,
  memoryGiB: +(os.totalmem() / 1024 ** 3).toFixed(1),
  ffmpeg: which('ffmpeg') || null,
  chromium: null,
  network: true,
};

let engineOk = false;
try {
  const exe = chromium.executablePath();
  host.chromium = exe;
  engineOk = !!exe && fs.existsSync(exe);
} catch (e) {
  host.chromium = `unavailable: ${e.message}`;
}

const capabilityTable = Object.entries(BASE_CAPABILITIES).map(([capability, v]) => ({ capability, ...v }));

const result = {
  device: { id: F491H.id, model: F491H.model, kaios: F491H.kaios.version, gecko: F491H.kaios.gecko, ua: F491H.userAgent },
  host,
  engineOk,
  capabilities: capabilityTable,
  gate: null,
};

if (manifestArg) {
  const raw = JSON.parse(fs.readFileSync(manifestArg, 'utf8'));
  const manifest = normaliseManifest(raw);
  result.gate = gateForManifest(manifest);
}

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`kailarp-doctor  core 0.1.0`);
  console.log(`  device      ${F491H.model} (${F491H.marketingName}) KaiOS ${F491H.kaios.version} / Gecko ${F491H.kaios.gecko}`);
  console.log(`  host        ${host.platform}  node ${host.node}  ${host.cpus} cpus  ${host.memoryGiB} GiB`);
  console.log(`  engine      ${engineOk ? host.chromium : `MISSING (${host.chromium})`}`);
  console.log(`  ffmpeg      ${host.ffmpeg || 'MISSING (needed for the screen-record pipeline)'}`);
  console.log(`  capabilities`);
  for (const c of capabilityTable) console.log(`    ${c.mode.padEnd(11)} ${c.capability.padEnd(14)} ${c.note}`);
  if (result.gate) {
    console.log(`  gate for ${manifestArg}`);
    for (const r of result.gate.requirements) console.log(`    ${r.mode.padEnd(11)} ${r.capability.padEnd(14)} ${r.note}`);
    console.log(`  verdict: ${result.gate.ok ? 'runnable' : 'REJECTED'}`);
  }
}

if (!engineOk || !host.ffmpeg) {
  process.exitCode = 2;
} else if (result.gate && !result.gate.ok) {
  process.exitCode = 3;
}

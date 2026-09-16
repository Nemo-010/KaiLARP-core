#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { boot, REPO_ROOT } from '../src/runtime.js';

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log(`usage: kailarp-run <source> [options]

  source        a local app directory, a .webapp manifest, or a URL:
                https://dumps.tadiphone.dev/dumps/jio/f491h/-/tree/<ref>/system/b2g/webapps/<app>

options
  --out <dir>       where reports and recordings land (default out/)
  --no-record       skip the screencast
  --no-fake-media   refuse camera/microphone instead of using fake devices
  --json            print the raw report
  -h, --help`);
  process.exit(argv.length ? 0 : 1);
}

const source = argv.find((a) => !a.startsWith('--'));
const flag = (name) => argv.includes(name);
const value = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);

const outDir = path.resolve(value('--out', path.join(REPO_ROOT, 'out', `run-${Date.now()}`)));

const report = await boot(source, {
  outDir,
  record: !flag('--no-record'),
  fakeMedia: !flag('--no-fake-media'),
  log: (m) => console.error(`  ${m}`),
});

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

if (flag('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.manifest.display} (${report.manifest.origin || 'local'})`);
  console.log(`  booted:   ${report.booted}`);
  console.log(`  gate:     ok=${report.capabilities.ok} native=${report.capabilities.summary.native} spoofed=${report.capabilities.summary.spoofed} denied=${report.capabilities.summary.denied}`);
  if (report.rejectedReason) console.log(`  rejected: ${report.rejectedReason}`);
  const checks = report.appResult && report.appResult.checks ? report.appResult.checks : {};
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v.ok ? 'ok  ' : 'FAIL'} ${k}${v.detail ? ' · ' + v.detail : ''}`);
  if (report.pageErrors.length) for (const e of report.pageErrors) console.log(`  pageError: ${e}`);
  if (report.video) console.log(`  video:    ${report.video} (${report.videoProbe?.frames ?? '?'} frames, meanLuma ${report.videoProbe?.meanLuma?.toFixed?.(1) ?? '?'})`);
  console.log(`  report:   ${path.join(outDir, 'report.json')}`);
}

const failedChecks = Object.values(report.appResult?.checks || {}).filter((c) => !c.ok);
process.exitCode = !report.booted || failedChecks.length || report.pageErrors.length ? 1 : 0;

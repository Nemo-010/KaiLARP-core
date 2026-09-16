import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { parseZip } from './zip.js';
import { parseManifestText, normaliseManifest } from './manifest.js';
import { loadApp } from './source.js';
import { gateForManifest, assertGate, CapabilityRejected, BASE_CAPABILITIES } from './capabilities.js';
import { deviceBootConfig, F491H } from './device.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webapp': 'application/x-web-app-manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

function mimeFor(name) {
  const dot = name.lastIndexOf('.');
  return MIME[name.slice(dot).toLowerCase()] || 'application/octet-stream';
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHIM_PATH = path.join(HERE, 'shim.js');
export const REPO_ROOT = path.resolve(HERE, '..');

function unpack(zip) {
  const files = new Map();
  for (const name of zip.names) {
    if (name.endsWith('/')) continue;
    files.set(name.replace(/^\/+/, ''), zip.read(name));
  }
  return files;
}

export async function loadDescriptor(input, { log = () => {} } = {}) {
  const app = await loadApp(input, { log });
  const manifest = parseManifestText(app.manifestBytes.toString('utf8'), 'update.webapp');
  const normalised = normaliseManifest(manifest);
  let files = new Map();
  if (app.zipBytes) {
    const zip = parseZip(app.zipBytes);
    files = unpack(zip);
    const inner = files.get('manifest.webapp');
    if (inner) normalised.raw.packageManifest = parseManifestText(inner.toString('utf8'), 'manifest.webapp');
  } else {
    const placeholder = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(normalised.display)}</title>
<style>html,body{margin:0;height:100%;background:#0e1420;color:#dce8f5;font:12px/1.4 system-ui}
header{padding:8px;border-bottom:1px solid #1d2b3f}h1{margin:0;font-size:15px;color:#7fd1ff}p{margin:3px 0 0;color:#7f9ab8}
main{padding:8px}li{margin:2px 0}.ok{color:#6ee7a8}.no{color:#ff8a8a}</style></head>
<body><header><h1>${escapeHtml(normalised.display)}</h1><p>${escapeHtml(normalised.origin || '')} · v${escapeHtml(normalised.version || '?')}</p></header>
<main><p>application.zip was not reachable from this host, so the descriptor booted alone.</p><ul id="l"></ul></main>
<script>
var b=window.__KAILARP_BOOT__||{};var ul=document.getElementById('l');var c=b.capabilities||{requirements:[]};
(c.requirements||[]).forEach(function(r){var li=document.createElement('li');li.textContent=r.capability+' → '+r.mode;li.className=r.mode==='deny'?'no':'ok';ul.appendChild(li);});
window.__KAILARP__&&window.__KAILARP__.finish({manifestOnly:true,checks:{descriptorParsed:true,gated:c.ok===true}});
</script></body></html>`;
    files.set('index.html', Buffer.from(placeholder, 'utf8'));
  }
  files.set('update.webapp', app.manifestBytes);
  files.set('manifest.webapp', app.manifestBytes);
  return { app, manifest: normalised, files, rawManifest: manifest };
}

export async function boot(input, options = {}) {
  const {
    outDir = path.join(REPO_ROOT, 'out'),
    record = true,
    capabilities = BASE_CAPABILITIES,
    fakeMedia = true,
    settings = {},
    finishTimeoutMs = 15000,
    log = console.log,
    headless = true,
  } = options;

  const effectiveCaps = fakeMedia
    ? capabilities
    : {
        ...capabilities,
        camera: { mode: 'deny', note: 'fake media disabled (--no-fake-media)' },
        microphone: { mode: 'deny', note: 'fake media disabled (--no-fake-media)' },
      };

  fs.mkdirSync(outDir, { recursive: true });
  const { manifest, files, app, rawManifest } = await loadDescriptor(input, { log });

  log(`app: ${manifest.display} v${manifest.version || '?'} origin=${manifest.origin || '(local)'}`);
  const gate = gateForManifest(manifest, effectiveCaps);
  const report = {
    ok: false,
    startedAt: new Date().toISOString(),
    source: app.source.input ?? app.source.input,
    device: { id: F491H.id, model: F491H.model, kaios: F491H.kaios.version, gecko: F491H.kaios.gecko },
    manifest: {
      name: manifest.name,
      display: manifest.display,
      version: manifest.version,
      origin: manifest.origin,
      launchPath: manifest.launchPath,
      permissions: manifest.permissionNames,
      hasPackageManifest: !!rawManifest.packageManifest,
    },
    capabilities: gate,
    console: [],
    pageErrors: [],
    apiCalls: {},
    appResult: null,
    screenshots: [],
    video: null,
    videoProbe: null,
    booted: false,
  };

  if (!gate.ok) {
    report.rejected = true;
    report.rejectedReason = new CapabilityRejected(gate).message;
    log(`REJECTED: ${report.rejectedReason}`);
    for (const d of gate.denied) log(`  denied: ${d.capability} - ${d.note}`);
    return report;
  }
  for (const s of gate.spoofed) log(`  spoofing: ${s.capability} - ${s.note}`);
  for (const n of gate.native.slice(0, 3)) log(`  native: ${n.capability}`);

  const origin = 'http://localhost';

  const browser = await chromium.launch({
    headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=1',
      '--autoplay-policy=no-user-gesture-required',
      ...(fakeMedia ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    ],
  });

  const videoDir = path.join(outDir, 'screen');
  fs.mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: F491H.screen.width, height: F491H.screen.height },
    screen: { width: F491H.screen.width, height: F491H.screen.height },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    userAgent: F491H.userAgent,
    locale: F491H.locale,
    timezoneId: F491H.timezone,
    recordVideo: record ? { dir: videoDir, size: { width: F491H.screen.width, height: F491H.screen.height } } : undefined,
  });

  context.setDefaultTimeout(finishTimeoutMs);

  // Apps are served by intercepting requests rather than by binding a port:
  // this host blocks listen() outright, and route fulfilment is what a
  // device-side WebView file loader does anyway.
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const key = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const body = files.get(key) ?? files.get(`${key}/index.html`);
    if (!body) {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: `kailarp: ${key} not found` });
      return;
    }
    await route.fulfill({ status: 200, contentType: mimeFor(key), body });
  });

  const page = await context.newPage();
  page.on('console', (m) => report.console.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => report.pageErrors.push(String(e.message || e)));
  page.on('requestfailed', (r) => report.console.push({ type: 'requestfailed', text: `${r.url()} ${r.failure()?.errorText}` }));

  const bootCfg = {
    device: deviceBootConfig(F491H),
    manifest: rawManifest,
    capabilities: gate,
    settings,
  };
  await page.addInitScript({ content: `window.__KAILARP_BOOT__ = ${JSON.stringify(bootCfg)};` });
  await page.addInitScript({ path: SHIM_PATH });

  const launchUrl = `${origin}/${manifest.launchPath.replace(/^\/+/, '')}`;
  log(`launching ${launchUrl} at ${F491H.screen.width}x${F491H.screen.height} as ${F491H.userAgent.slice(0, 46)}...`);

  let appResult = null;
  try {
    await page.goto(launchUrl, { waitUntil: 'load', timeout: 20000 });
    report.booted = true;
    await page.waitForFunction('window.__KAILARP__ && window.__KAILARP__.ready === true', null, { timeout: 10000 }).catch(() => {});
    try {
      appResult = await page.evaluate(
        (ms) => Promise.race([
          window.__KAILARP__.whenFinished(),
          new Promise((r) => setTimeout(() => r({ timeout: true }), ms)),
        ]),
        finishTimeoutMs,
      );
    } catch (e) {
      report.pageErrors.push(`finish wait: ${e.message}`);
    }
    // Let the last painted frame land in the recording and let late async
    // probes merge into the app result.
    await page.waitForTimeout(1500).catch(() => {});
    const shot = path.join(outDir, `${path.basename(outDir)}-${slug(manifest.name)}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    report.screenshots.push(shot);
    report.dump = await page.evaluate('window.__KAILARP__ ? window.__KAILARP__.dump() : null').catch(() => null);
    if (report.dump && report.dump.result) appResult = report.dump.result;
  } catch (e) {
    report.pageErrors.push(String(e.message || e));
    log(`boot error: ${e.message}`);
  }

  report.appResult = appResult;
  report.apiCalls = report.dump?.calls || {};
  const video = page.video();
  await context.close();
  await browser.close();

  if (video) {
    try {
      const p = await video.path();
      const dest = path.join(videoDir, `${slug(manifest.name)}.webm`);
      if (p && fs.existsSync(p)) {
        fs.copyFileSync(p, dest);
        report.video = dest;
        report.videoProbe = probeVideo(dest);
      }
    } catch (e) {
      report.pageErrors.push(`video: ${e.message}`);
    }
  }

  report.ok = report.booted && !report.pageErrors.length;
  report.finishedAt = new Date().toISOString();
  return report;
}

export function probeVideo(file) {
  const probe = { file, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 };
  const ff = which('ffmpeg');
  if (!ff) { probe.note = 'ffmpeg not on PATH'; return probe; }
  const r = spawnSync(ff, ['-v', 'error', '-i', file, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const frameLuma = [...(r.stdout || '').matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
  probe.frames = frameLuma.length;
  probe.meanLuma = frameLuma.length ? frameLuma.reduce((a, b) => a + b, 0) / frameLuma.length : null;
  probe.minLuma = frameLuma.length ? Math.min(...frameLuma) : null;
  probe.maxLuma = frameLuma.length ? Math.max(...frameLuma) : null;
  probe.nonBlank = frameLuma.some((v) => v > 4);
  return probe;
}

export function transcode(file, dest, { scale = null, pad = null } = {}) {
  const ff = which('ffmpeg');
  if (!ff) throw new Error('ffmpeg not on PATH');
  const args = ['-y', '-v', 'error', '-i', file];
  const filters = [];
  if (scale) filters.push(`scale=${scale}`);
  if (pad) filters.push(`pad=${pad}`);
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest);
  const r = spawnSync(ff, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return dest;
}

export function which(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, bin);
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export { assertGate, CapabilityRejected };

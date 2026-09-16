import fs from 'node:fs';
import path from 'node:path';

// Resolves whatever the user pasted into (manifest, application.zip) bytes.
//
// Supported forms:
//   /local/dir                     directory holding update.webapp + application.zip
//   /local/file.webapp|.json       a manifest next to an application.zip
//   https://host/<grp>/<proj>/-/tree/<ref>/<path>
//   https://host/<grp>/<proj>/-/raw/<ref>/<path>/update.webapp
//   https://.../update.webapp      direct manifest + sibling application.zip
//   https://.../application.zip    direct archive + sibling update.webapp
//
// GitLab tree URLs are the shape published by dumps.tadiphone.dev.

export function parseSource(input) {
  if (fs.existsSync(input)) return { kind: 'fs', dir: path.resolve(input) };
  if (!/^https?:\/\//i.test(input)) throw new Error(`cannot resolve source: ${input}`);

  const url = new URL(input);
  const treeMatch = url.pathname.match(/^(.*?)\/-\/tree\/([^/]+)\/(.*)$/);
  if (treeMatch) {
    const [, projectPath, ref, subPath] = treeMatch;
    return {
      kind: 'gitlab',
      host: url.origin,
      projectPath: projectPath.replace(/^\//, ''),
      ref,
      subPath: subPath.replace(/\/$/, ''),
      rawBase: `${url.origin}${projectPath}/-/raw/${ref}/${subPath.replace(/\/$/, '')}`,
      projectApi: `${url.origin}/api/v4/projects/${encodeURIComponent(projectPath.replace(/^\//, ''))}`,
    };
  }
  const rawMatch = url.pathname.match(/^(.*?)\/-\/raw\/([^/]+)\/(.*)$/);
  if (rawMatch) {
    const [, projectPath, ref, subPath] = rawMatch;
    const withoutFile = subPath.replace(/\/(update\.webapp|manifest\.webapp|application\.zip)$/, '');
    return {
      kind: 'gitlab',
      host: url.origin,
      projectPath: projectPath.replace(/^\//, ''),
      ref,
      subPath: withoutFile.replace(/\/$/, ''),
      rawBase: `${url.origin}${projectPath}/-/raw/${ref}/${withoutFile}`,
      projectApi: `${url.origin}/api/v4/projects/${encodeURIComponent(projectPath.replace(/^\//, ''))}`,
    };
  }
  const base = url.href.replace(/\/(update\.webapp|manifest\.webapp|application\.zip)$/, '');
  return { kind: 'http', base };
}

export class Fetcher {
  constructor({ retries = 4, timeoutMs = 120000, log = () => {} } = {}) {
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.log = log;
  }

  async bytes(url) {
    let lastErr;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error('empty response');
        return buf;
      } catch (err) {
        lastErr = err;
        this.log(`  fetch attempt ${attempt}/${this.retries} failed: ${url} (${err.message})`);
        await new Promise((r) => setTimeout(r, 400 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`could not fetch ${url}: ${lastErr?.message}`);
  }
}

export async function loadApp(input, { fetcher = new Fetcher(), log = () => {} } = {}) {
  const src = parseSource(input);
  log(`source: ${src.kind}`);

  if (src.kind === 'fs') {
    const manifestPath = firstExisting(src.dir, ['update.webapp', 'manifest.webapp']);
    const zipPath = firstExisting(src.dir, ['application.zip']);
    if (!manifestPath && !zipPath) throw new Error(`${src.dir}: no update.webapp or application.zip`);
    return {
      source: { kind: 'fs', input },
      manifestPath,
      zipPath,
      manifestBytes: manifestPath ? fs.readFileSync(manifestPath) : null,
      zipBytes: zipPath ? fs.readFileSync(zipPath) : null,
    };
  }

  const base = src.kind === 'gitlab' ? src.rawBase : src.base;
  log(`manifest: ${base}/update.webapp`);
  let manifestBytes = null;
  for (const name of ['update.webapp', 'manifest.webapp']) {
    try {
      manifestBytes = await fetcher.bytes(`${base}/${name}`);
      break;
    } catch {
      /* try the next name */
    }
  }
  if (!manifestBytes) throw new Error(`no update.webapp or manifest.webapp under ${base}`);

  log(`archive: ${base}/application.zip`);
  let zipBytes = null;
  try {
    zipBytes = await fetcher.bytes(`${base}/application.zip`);
  } catch (err) {
    log(`  application.zip unavailable (${err.message}); manifest-only boot`);
  }

  return { source: { ...src, input }, manifestPath: null, zipPath: null, manifestBytes, zipBytes };
}

function firstExisting(dir, names) {
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

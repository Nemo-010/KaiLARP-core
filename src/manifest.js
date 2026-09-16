// Kernel of a KaiOS/B2G app descriptor.
//
// Two shapes exist in the wild:
//   update.webapp    - hosted/app-store manifest, includes `origin`, `package_path`
//   manifest.webapp  - the packaged manifest found inside application.zip
// Both are JSON. Real dumps occasionally carry comments and trailing commas,
// so the parse is lenient on purpose.

export function parseManifestText(text, sourceName = 'manifest') {
  const stripped = stripJsonNoise(text);
  try {
    return JSON.parse(stripped);
  } catch (err) {
    throw new Error(`${sourceName}: not valid JSON (${err.message})`);
  }
}

function stripJsonNoise(text) {
  let out = '';
  let inString = false;
  let quote = '';
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += n; i++; continue; }
      if (c === quote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") { inString = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

// Normalise the parts of a descriptor the runtime actually consumes.
export function normaliseManifest(manifest, { originFromName = null } = {}) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const permissions = m.permissions && typeof m.permissions === 'object' ? m.permissions : {};
  return {
    raw: m,
    name: m.name || m.display || 'unnamed',
    display: m.display || m.name || 'unnamed',
    version: m.version || null,
    description: m.description || '',
    developer: m.developer || null,
    launchPath: m.launch_path || 'index.html',
    origin: m.origin || originFromName,
    packagePath: m.package_path || '/application.zip',
    type: m.type || 'web',
    role: m.role || null,
    orientation: m.orientation || ['portrait'],
    fullscreen: !!m.fullscreen,
    permissions,
    permissionNames: Object.keys(permissions),
    locales: m.locales || null,
    defaultLocale: m.default_locale || 'en-US',
    icons: m.icons || null,
    activities: m.activities || null,
  };
}

const PERMISSION_CAPABILITY_MAP = {
  telephony: ['telephony', 'sim'],
  mobilenetwork: ['telephony'],
  'video-capture': ['camera'],
  'sound-trigger': ['microphone'],
  fmradio: ['sensors'],
  push: ['network'],
  systemXHR: ['network'],
  serviceworker: ['compute'],
  browser: ['compute'],
  'sandboxed-cookies': ['compute'],
  volumemanager: ['compute'],
  'moz-attention': ['compute'],
  permissions: ['compute'],
  'spatialnavigation-app-manage': ['compute'],
  'feature-detection': ['compute'],
  donglemanager: ['compute'],
  'external-api': ['compute'],
  'audio-channel-normal': ['compute'],
  'audio-channel-content': ['compute'],
  'audio-channel-telephony': ['compute'],
  'audio-channel-notification': ['compute'],
  'audio-channel-alarm': ['compute'],
  'mobileconnection': ['telephony'],
  mobileconnection: ['telephony'],
  sms: ['sms', 'sim'],
  'sms:read': ['sms'],
  'sms:write': ['sms'],
  cellbroadcast: ['cellbroadcast', 'sim'],
  mobileid: ['sim'],
  networkstats: ['telephony'],
  voicemail: ['telephony'],
  geolocation: ['gps'],
  gps: ['gps'],
  camera: ['camera'],
  'audio-capture': ['microphone'],
  microphone: ['microphone'],
  bluetooth: ['bluetooth'],
  'wifi-manage': ['wifi'],
  nfc: ['secureelement'],
  'secure-element': ['secureelement'],
  drm: ['drm'],
  eme: ['drm'],
  'media-keys': ['drm'],
  crypto: ['crypto'],
  'web-crypto': ['crypto'],
  attestation: ['attestation'],
  'hardware-attestation': ['attestation'],
  storage: ['storage'],
  'device-storage:apps': ['storage'],
  'device-storage:pictures': ['storage'],
  'device-storage:videos': ['storage'],
  'device-storage:music': ['storage'],
  'device-storage:sdcard': ['storage'],
  'device-storage:crashes': ['storage'],
  contacts: ['storage'],
  alarms: ['compute'],
  power: ['compute'],
  settings: ['compute'],
  'embed-apps': ['compute'],
  'webapps-manage': ['compute'],
  'desktop-notification': ['compute'],
  'tcp-socket': ['network'],
  'udp-socket': ['network'],
  sockets: ['network'],
  asmjs: ['compute'],
  'themeable': ['compute'],
};

// A capability the runtime has no specific model for is reported as
// `unmodelled` rather than denied: it does not correspond to a security
// guarantee we would otherwise be fabricating.

export { PERMISSION_CAPABILITY_MAP };

export function permissionsToCapabilities(permissionNames) {
  const wanted = new Set();
  for (const name of permissionNames) {
    const mapped = PERMISSION_CAPABILITY_MAP[name];
    if (mapped) mapped.forEach((c) => wanted.add(c));
    else wanted.add(`unknown:${name}`);
  }
  return [...wanted];
}

// Host capability gate.
//
// Every capability an app can ask for is classified before the app is allowed
// to boot:
//
//   native - the host really provides it (Chromium/Node/OS)
//   spoof  - the runtime emulates it faithfully enough for the app surface,
//            and the emulation is disclosed in the report
//   deny   - the runtime will not fake it, for one of two reasons:
//              * the host cannot provide it (no camera device in headless CI)
//              * faking it would be fabricating a security guarantee
//                (secure element, DRM licences, hardware attestation)
//
// Apps that require a `deny` capability are rejected before any app code runs.

import { permissionsToCapabilities } from './manifest.js';

export const BASE_CAPABILITIES = {
  compute: { mode: 'native', note: 'CPU/JS engine' },
  network: { mode: 'native', note: 'Chromium network stack' },
  crypto: { mode: 'native', note: 'real WebCrypto (SubtleCrypto), not faked' },
  storage: { mode: 'spoof', note: 'in-memory device storage + OPFS, volatile' },
  telephony: { mode: 'spoof', note: 'RIL object model emulated; no real call is placed' },
  sim: { mode: 'spoof', note: 'SIM identity from the F491H dump; no real ICC' },
  sms: { mode: 'spoof', note: 'messages are recorded locally, never transmitted' },
  cellbroadcast: { mode: 'spoof', note: 'synthetic channel list' },
  gps: { mode: 'spoof', note: 'mocked fix, flagged as mocked to the app' },
  battery: { mode: 'spoof', note: 'static profile values' },
  sensors: { mode: 'spoof', note: 'static profile values' },
  bluetooth: { mode: 'spoof', note: 'empty adapter, no radio' },
  wifi: { mode: 'spoof', note: 'synthetic scan list' },
  camera: { mode: 'spoof', note: 'synthetic test-pattern capture device via the engine fake-media switch' },
  microphone: { mode: 'spoof', note: 'synthetic audio capture via the engine fake-media switch' },
  secureelement: { mode: 'deny', note: 'NFC/eSE cannot be spoofed without fabricating a security guarantee' },
  drm: { mode: 'deny', note: 'EME/CDM licences are not spoofed' },
  attestation: { mode: 'deny', note: 'hardware attestation is never fabricated' },
};

export class CapabilityRejected extends Error {
  constructor(report) {
    const missing = report.requirements.filter((r) => r.mode === 'deny').map((r) => r.capability);
    super(`host cannot satisfy required capabilities: ${missing.join(', ')}`);
    this.name = 'CapabilityRejected';
    this.report = report;
  }
}

export function classify(requiredCapabilities, capabilities = BASE_CAPABILITIES) {
  const requirements = requiredCapabilities.map((capability) => {
    const entry = capabilities[capability];
    if (entry) return { capability, ...entry };
    return {
      capability,
      mode: 'unmodelled',
      note: 'no specific model; reported but not treated as a security guarantee',
    };
  });
  const denied = requirements.filter((r) => r.mode === 'deny');
  const spoofed = requirements.filter((r) => r.mode === 'spoof');
  const native = requirements.filter((r) => r.mode === 'native');
  const unmodelled = requirements.filter((r) => r.mode === 'unmodelled');
  return {
    ok: denied.length === 0,
    requirements,
    denied,
    spoofed,
    native,
    unmodelled,
    summary: {
      total: requirements.length,
      native: native.length,
      spoofed: spoofed.length,
      denied: denied.length,
      unmodelled: unmodelled.length,
    },
    capabilities,
  };
}

export function gateForManifest(manifest, capabilities = BASE_CAPABILITIES) {
  const required = permissionsToCapabilities(manifest.permissionNames ?? []);
  const classifyRun = classify(required, capabilities);
  return {
    app: { name: manifest.name, display: manifest.display, origin: manifest.origin ?? null },
    permissions: manifest.permissionNames ?? [],
    ...classifyRun,
  };
}

export function assertGate(report) {
  if (!report.ok) throw new CapabilityRejected(report);
  return report;
}

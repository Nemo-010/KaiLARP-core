// JioPhone F491H device profile.
//
// Values are lifted from the public system dump:
//   dumps.tadiphone.dev/dumps/jio/f491h
//   ref MAD-user-6.0-MRA58K-Jio-F491H-F001-04-13-310823-release-keys
//
// Verified from system/b2g/application.ini and platform.ini:
//   Vendor=KaiOS  Name=B2G  Version=2.5.3.2  BuildID=20230831153742
//   Gecko MinVersion/MaxVersion 48.0a2

export const F491H = {
  id: 'jio-f491h',
  vendor: 'LYF',
  model: 'F491H',
  marketingName: 'JioPhone 2',
  device: 'f491h',
  product: 'f491h',
  brand: 'Jio',
  manufacturer: 'LYF',
  android: {
    release: '6.0',
    sdk: 23,
    buildId: 'MRA58K',
  },
  kaios: {
    version: '2.5.3.2',
    name: 'B2G',
    buildId: '20230831153742',
    buildTag: 'F491H-F001-04-13-310823',
    gecko: '48.0a2',
  },
  screen: {
    width: 240,
    height: 320,
    devicePixelRatio: 1,
    colorDepth: 24,
    orientation: 'portrait-primary',
  },
  // KaiOS serves a Firefox-48 flavoured UA with a LYF build token.
  userAgent:
    'Mozilla/5.0 (Mobile; LYF/F491H/LYF-F491H-000-04-13-310823; Android; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5',
  // Reference values the RIL / settings layer reports.
  sim: {
    iccId: '89014103211118510720',
    mcc: '405',
    mnc: '857',
    operator: 'Jio 4G',
    spn: 'Jio',
    msisdn: '+919999999999',
    serviceProvider: 'Reliance Jio',
    slotCount: 2,
    activeSlot: 0,
  },
  network: {
    radioState: 'enabled',
    voice: { state: 'registered', roaming: false, network: { shortName: 'Jio 4G', longName: 'Reliance Jio', mcc: '405', mnc: '857' } },
    data: { state: 'registered', network: { shortName: 'Jio 4G', longName: 'Reliance Jio', mcc: '405', mnc: '857' } },
    type: 'lte',
    signal: { signalStrength: 24, relSignalStrength: 76 },
  },
  battery: { level: 0.82, charging: false, dischargingTime: 32000, chargingTime: Infinity },
  // A deterministic mock fix somewhere plausible in Navi Mumbai (where the
  // Jio operator variants point). Clearly labelled as mocked at runtime.
  geolocation: { latitude: 19.033, longitude: 73.0297, accuracy: 25, altitude: null, mocked: true },
  locale: 'en-IN',
  timezone: 'Asia/Kolkata',
};

export function deviceBootConfig(device = F491H) {
  return {
    profile: device.id,
    vendor: device.vendor,
    model: device.model,
    android: device.android,
    kaios: device.kaios,
    screen: device.screen,
    userAgent: device.userAgent,
    sim: device.sim,
    network: device.network,
    battery: device.battery,
    geolocation: device.geolocation,
    locale: device.locale,
    timezone: device.timezone,
    bootedAt: new Date().toISOString(),
  };
}

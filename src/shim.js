/*
 * KaiLARP-core injected compatibility layer (runs inside the web engine).
 *
 * This is the part that "pretends to be a JioPhone". Everything it fabricates
 * is listed in the capability report; anything it refuses to fabricate is a
 * `deny` capability and the app never gets booted.
 */
(function () {
  'use strict';

  const BOOT = window.__KAILARP_BOOT__ || {};
  const DEVICE = BOOT.device || {};
  const CAPS = BOOT.capabilities || {};

  const state = {
    calls: Object.create(null),
    log: [],
    errors: [],
    finished: false,
    result: null,
    promise: null,
  };

  function bump(name) {
    state.calls[name] = (state.calls[name] || 0) + 1;
  }
  function note(msg, level) {
    state.log.push({ t: Date.now(), level: level || 'info', msg: String(msg) });
    if (level === 'error') state.errors.push(String(msg));
  }
  function ro(obj, prop, value) {
    try {
      Object.defineProperty(obj, prop, { value, writable: false, configurable: true, enumerable: true });
    } catch (e) { note(`could not define ${prop}: ${e.message}`, 'error'); }
  }
  function lazy(obj, prop, factory) {
    let cached;
    let done = false;
    try {
      Object.defineProperty(obj, prop, {
        configurable: true,
        enumerable: true,
        get() { if (!done) { cached = factory(); done = true; } return cached; },
      });
    } catch (e) { note(`could not define ${prop}: ${e.message}`, 'error'); }
  }
  function target(that) {
    if (this === undefined || this === null) { void that; }
    return arguments.length ? Object(this) : that;
  }
  void target;

  const nowIso = () => new Date().toISOString();

  /* ---------------------------------------------------------------- profiles */

  const sim = DEVICE.sim || {};
  const network = DEVICE.network || {};
  const screenProfile = DEVICE.screen || { width: 240, height: 320 };

  try {
    Object.defineProperty(screen, 'width', { value: screenProfile.width, configurable: true });
    Object.defineProperty(screen, 'height', { value: screenProfile.height, configurable: true });
    Object.defineProperty(screen, 'availWidth', { value: screenProfile.width, configurable: true });
    Object.defineProperty(screen, 'availHeight', { value: screenProfile.height, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { value: screenProfile.colorDepth || 24, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { value: screenProfile.colorDepth || 24, configurable: true });
    Object.defineProperty(window.screen, 'mozOrientation', { value: 'portrait-primary', configurable: true });
    Object.defineProperty(window.screen, 'orientation', { value: Object.freeze({ type: 'portrait-primary', angle: 0 }), configurable: true });
  } catch (e) { note(`screen spoof failed: ${e.message}`, 'error'); }

  try {
    if (DEVICE.userAgent) {
      Object.defineProperty(navigator, 'userAgent', { value: DEVICE.userAgent, configurable: true });
      Object.defineProperty(navigator, 'appVersion', { value: String(DEVICE.userAgent).replace(/^Mozilla\//, ''), configurable: true });
    }
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
    Object.defineProperty(navigator, 'deviceMemory', { value: 0.5, configurable: true });
    Object.defineProperty(navigator, 'language', { value: DEVICE.locale || 'en-IN', configurable: true });
    Object.defineProperty(navigator, 'languages', { value: ['en-IN', 'en-US', 'en'], configurable: true });
    Object.defineProperty(navigator, 'platform', { value: 'Linux armv7l', configurable: true });
  } catch (e) { note(`navigator spoof failed: ${e.message}`, 'error'); }

  /* ---------------------------------------------------------------- settings */

  const settingsStore = new Map();  for (const [k, v] of Object.entries(BOOT.settings || {})) settingsStore.set(k, v);
  const settingsObservers = new Set();

  const mozSettings = {
    get(name) {
      bump('mozSettings.get');
      return Promise.resolve(settingsStore.has(name) ? settingsStore.get(name) : null);
    },
    set(name, value) {
      bump('mozSettings.set');
      const old = settingsStore.has(name) ? settingsStore.get(name) : null;
      settingsStore.set(name, value);
      const setting = { name, value, previous: old };
      for (const obs of settingsObservers) { try { obs(setting); } catch (e) { note(`settings observer: ${e.message}`, 'error'); } }
      return Promise.resolve();
    },
    createLock() {
      bump('mozSettings.createLock');
      return {
        get: (name) => mozSettings.get(name),
        set: (name, value) => mozSettings.set(name, value),
      };
    },
    addObserver(name, cb) {
      bump('mozSettings.addObserver');
      const wrapped = typeof name === 'function' ? name : (s) => { if (s.name === name) cb(s); };
      settingsObservers.add(wrapped);
    },
    removeObserver(name, cb) {
      bump('mozSettings.removeObserver');
      if (typeof name === 'function') settingsObservers.delete(name);
      else for (const o of settingsObservers) if (o.__cb === cb) settingsObservers.delete(o);
    },
  };

  ro(navigator, 'mozSettings', mozSettings);

  /* ------------------------------------------------------------------- RIL */

  function makeConnection(slot) {
    const active = slot === (sim.activeSlot || 0);
    const conn = {
      __kailarp: true,
      serviceId: slot,
      radioState: active ? network.radioState || 'enabled' : 'enabled',
      iccId: active ? sim.iccId || null : null,
      voice: active ? { state: network.voice?.state || 'registered', roaming: !!network.voice?.roaming, network: network.voice?.network || null, cell: null } : { state: 'notSearching', network: null, cell: null },
      data: active ? { state: network.data?.state || 'registered', network: network.data?.network || null } : { state: 'notSearching', network: null },
      getCardState: () => Promise.resolve(active ? 'ready' : 'absent'),
      getNetworks: () => Promise.resolve(active ? [{ shortName: network.voice?.network?.shortName || 'Jio 4G', longName: network.voice?.network?.longName || 'Reliance Jio', mcc: sim.mcc, mnc: sim.mnc, state: 'connected' }] : []),
      selectNetworkAutomatically: () => { bump('mozMobileConnection.selectNetworkAutomatically'); return Promise.resolve(true); },
      getSupportedNetworkTypes: () => Promise.resolve(['lte', 'gsm']),
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      onvoicechange: null, ondatachange: null, oncardstatechange: null,
    };
    return conn;
  }
  const connections = Array.from({ length: sim.slotCount || 2 }, (_, i) => makeConnection(i));
  ro(navigator, 'mozMobileConnections', connections);
  ro(navigator, 'mozMobileConnection', connections[sim.activeSlot || 0]);
  ro(navigator, 'mozIccManager', {
    __kailarp: true,
    iccIds: [sim.iccId].filter(Boolean),
    getCardState(id) { bump('mozIccManager.getCardState'); return Promise.resolve('ready'); },
    matchMvno() { return Promise.resolve(null); },
    addEventListener() {}, removeEventListener() {},
  });

  /* ------------------------------------------------------------- telephony */

  const calls = [];
  const callListeners = new Set();
  function emitCalls() { callListeners.forEach((l) => { try { l(); } catch { /* ignore */ } }); }
  function dial(number, serviceId) {
    bump('mozTelephony.dial');
    const call = {
      __kailarp: true,
      number,
      serviceId: serviceId || sim.activeSlot || 0,
      state: 'dialing',
      direction: 'outgoing',
      startedAt: nowIso(),
      hangUp() { bump('mozTelephony.call.hangUp'); this.state = 'disconnected'; emitCalls(); return Promise.resolve(); },
      resume() { return Promise.resolve(); },
      hold() { return Promise.resolve(); },
      addEventListener() {}, removeEventListener() {},
    };
    calls.push(call);
    emitCalls();
    setTimeout(() => { call.state = 'active'; emitCalls(); note(`spoofed call to ${number} is active (no real modem)`); }, 250);
    return Promise.resolve(call);
  }
  ro(navigator, 'mozTelephony', {
    __kailarp: true,
    get calls() { return calls; },
    dial,
    call: (n) => dial(n),
    get isDialing() { return calls.some((c) => c.state === 'dialing'); },
    addEventListener(_t, cb) { callListeners.add(cb); },
    removeEventListener(_t, cb) { callListeners.delete(cb); },
    oncallschanged: null,
  });

  /* ------------------------------------------------------------ messaging */

  const outbox = [];
  ro(navigator, 'mozMobileMessage', {
    __kailarp: true,
    getSegmentInfoForText(text) { bump('mozMobileMessage.getSegmentInfoForText'); return Promise.resolve({ segments: Math.max(1, Math.ceil(String(text || '').length / 160)), charsPerSegment: 160, charsAvailableInLastSegment: 160 - (String(text || '').length % 160) }); },
    send(number, text) {
      bump('mozMobileMessage.send');
      const msg = { id: outbox.length + 1, delivery: 'sent', sender: number, receiver: sim.msisdn, body: text, timestamp: new Date(), type: 'sms' };
      outbox.push(msg);
      note(`spoofed SMS to ${number} recorded locally (never transmitted)`);
      return Promise.resolve(msg);
    },
    getMessages() { bump('mozMobileMessage.getMessages'); return { result: [], onsuccess: null, onerror: null }; },
    addEventListener() {}, removeEventListener() {},
  });
  ro(navigator, 'mozCellBroadcast', {
    __kailarp: true,
    getChannelConfiguration() { bump('mozCellBroadcast.getChannelConfiguration'); return Promise.resolve({ channelIds: [], searchList: [], maximumMessagePerId: 100 }); },
    setChannelConfiguration(cfg) { bump('mozCellBroadcast.setChannelConfiguration'); return Promise.resolve(cfg); },
    addEventListener() {}, removeEventListener() {},
  });
  ro(navigator, 'mozVoicemail', { __kailarp: true, getStatus() { return null; }, addEventListener() {}, removeEventListener() {} });
  ro(navigator, 'mozNetworkStats', { __kailarp: true, getSamples() { return { result: [], onsuccess: null }; }, addEventListener() {}, removeEventListener() {} });

  /* ---------------------------------------------------------------- l10n */

  ro(navigator, 'mozL10n', {
    __kailarp: true,
    language: { code: DEVICE.locale || 'en-IN', direction: 'ltr' },
    ready: Promise.resolve(),
    get: (id) => id,
    formatValue: (id) => id,
    format: (id) => id,
    localize: (el) => el,
    translate: () => {},
    readyForLocales: () => Promise.resolve(),
    DateTimeFormat: Intl.DateTimeFormat,
    NumberFormat: Intl.NumberFormat,
    addEventListener() {}, removeEventListener() {},
  });

  /* ------------------------------------------------------------- storage */

  const deviceStores = new Map();
  function deviceStorage(name) {
    if (!deviceStores.has(name)) {
      const files = new Map();
      deviceStores.set(name, {
        __kailarp: true,
        storageName: name,
        available() { bump('deviceStorage.available'); return 'available'; },
        freeSpace() { bump('deviceStorage.freeSpace'); return 512 * 1024 * 1024; },
        usedSpace() { return 0; },
        addNamed(blob, filename) {
          bump('deviceStorage.addNamed');
          const f = { name: filename, size: blob?.size || 0, type: blob?.type || '', lastModified: new Date(), blob };
          files.set(filename, f);
          return { set onsuccess(fn) { fn && fn(); return this; }, set onerror(fn) { return this; }, result: f };
        },
        get(filename) {
          bump('deviceStorage.get');
          try { return Promise.resolve(files.get(filename) || null); } catch { return Promise.reject(new Error('not found')); }
        },
        getEditable: () => Promise.reject(new Error('kailarp: editable storage is not emulated')),
        delete(filename) { bump('deviceStorage.delete'); const ok = files.delete(filename); return { set onsuccess(fn) { fn && fn(); return this; }, set onerror(fn) { return this; }, result: ok }; },
        enumerate() { bump('deviceStorage.enumerate'); const fn = () => {}; return { set onsuccess(x) { x && x(); return this; }, set onerror(x) { return this; }, result: fn }; },
        addEventListener() {}, removeEventListener() {},
        __files: files,
      });
    }
    return deviceStores.get(name);
  }
  ro(navigator, 'getDeviceStorage', (name) => { bump('getDeviceStorage'); return deviceStorage(name); });
  ro(navigator, 'getDeviceStorages', (name) => { bump('getDeviceStorages'); return [deviceStorage(name)]; });

  /* -------------------------------------------------------------- alarms */

  const alarms = [];
  ro(navigator, 'mozAlarms', {
    __kailarp: true,
    add(date, respectTimezone, data) {
      bump('mozAlarms.add');
      const alarm = { id: alarms.length + 1, date, respectTimezone, data: data || null };
      alarms.push(alarm);
      return Promise.resolve(alarm);
    },
    getAll() { bump('mozAlarms.getAll'); return Promise.resolve([...alarms]); },
    remove(id) { bump('mozAlarms.remove'); const i = alarms.findIndex((a) => a.id === id); if (i >= 0) alarms.splice(i, 1); return Promise.resolve(); },
    addEventListener() {}, removeEventListener() {},
  });

  /* --------------------------------------------------------------- apps */

  const selfUrl = location.origin + '/manifest.webapp';
  ro(navigator, 'mozApps', {
    __kailarp: true,
    getSelf() {
      bump('mozApps.getSelf');
      return Promise.resolve({
        __kailarp: true,
        manifest: BOOT.manifest || {},
        manifestURL: selfUrl,
        origin: location.origin,
        installState: 'installed',
        launch: (path) => { location.href = path || '/'; },
        checkForUpdate: () => Promise.resolve(null),
        addEventListener() {}, removeEventListener() {},
      });
    },
    getInstalled() { bump('mozApps.getInstalled'); return Promise.resolve([]); },
    addEventListener() {}, removeEventListener() {},
  });

  /* -------------------------------------------------------- permissions */

  const denied = new Set((CAPS.denied || []).map((d) => d.capability));
  ro(navigator, 'mozPermissionSettings', {
    __kailarp: true,
    get(permission) { bump('mozPermissionSettings.get'); return Promise.resolve(denied.size && denied.has(permission) ? 'deny' : 'allow'); },
    set() { return Promise.resolve(); },
    addEventListener() {}, removeEventListener() {},
  });

  /* ---------------------------------------------------------- hardware */

  ro(navigator, 'mozBluetooth', {
    __kailarp: true,
    getDefaultAdapter() {
      bump('mozBluetooth.getDefaultAdapter');
      return Promise.resolve({
        __kailarp: true,
        state: 'enabled',
        name: BOOT.device?.model || 'F491H',
        address: '00:1A:7D:DA:71:13',
        discoverable: false,
        discovering: false,
        startDiscovery() { bump('mozBluetooth.startDiscovery'); this.discovering = true; return Promise.resolve(); },
        stopDiscovery() { this.discovering = false; return Promise.resolve(); },
        getPairedDevices() { return []; },
        setDiscoverable() { return Promise.resolve(); },
        addEventListener() {}, removeEventListener() {},
      });
    },
    addEventListener() {}, removeEventListener() {},
  });

  ro(navigator, 'mozWifiManager', {
    __kailarp: true,
    connection: { status: 'connected', network: { ssid: 'JioFi', bssid: '02:00:00:00:00:01', security: ['WPA-PSK'], signalStrength: 72, relSignalStrength: 80 }, ipAddress: '192.168.1.42' },
    enabled: true,
    getNetworks() { bump('mozWifiManager.getNetworks'); return Promise.resolve({ result: [{ ssid: 'JioFi', bssid: '02:00:00:00:00:01', security: ['WPA-PSK'], signalStrength: 72, relSignalStrength: 80 }], set onsuccess(fn) { fn && fn(this.result); return this; } }); },
    addEventListener() {}, removeEventListener() {},
  });

  ro(navigator, 'mozFMRadio', {
    __kailarp: true,
    enabled: false,
    frequency: 98.3,
    frequencyRange: { lower: 87.5, upper: 108 },
    antennaAvailable: false,
    set enabled(v) { this._enabled = v; },
    get enabled() { return this._enabled; },
    enable() { bump('mozFMRadio.enable'); return Promise.reject(new Error('kailarp: FM radio hardware not present on host')); },
    disable() { return Promise.resolve(); },
    seekUp() { return Promise.resolve(98.3); },
    seekDown() { return Promise.resolve(98.3); },
    setFrequency() { return Promise.resolve(98.3); },
    addEventListener() {}, removeEventListener() {},
    _enabled: false,
  });

  ro(navigator, 'mozCameras', {
    __kailarp: true,
    getList() { bump('mozCameras.getList'); return Promise.resolve([]); },
    getCamera() { bump('mozCameras.getCamera'); return Promise.reject(new Error('kailarp: no camera device on host (capability "camera" is deny)')); },
    release() {},
    addEventListener() {}, removeEventListener() {},
  });

  ro(navigator, 'mozInputMethod', {
    __kailarp: true,
    inputcontext: null,
    setSelected() {},
    setValue() {},
    replaceSurroundingText() {},
    deleteSurroundingText() {},
    sendKey() {},
    sendKeyCode() {},
    addEventListener() {}, removeEventListener() {},
  });

  ro(navigator, 'mozContacts', {
    __kailarp: true,
    getAll() { bump('mozContacts.getAll'); const result = []; return { result, set onsuccess(fn) { fn && fn(result); return this; } }; },
    save(c) { bump('mozContacts.save'); return Promise.resolve(c); },
    remove(c) { return Promise.resolve(c); },
    addEventListener() {}, removeEventListener() {},
  });

  /* --------------------------------------------------- refused on purpose */

  function makeRefusal(name, why) {
    const reject = () => {
      bump(`${name}.refused`);
      note(`${name}: refused - ${why}`, 'error');
      return Promise.reject(new Error(`kailarp: ${why}`));
    };
    return { __kailarp: true, __refused: why, open: reject, request: reject, getToken: reject, getAttestation: reject, sign: reject, connect: reject, send: reject };
  }

  const REFUSED = {
    mozPay: { shape: 'fn', why: 'payments expose real money; kailarp will not fake a payment flow' },
    mozId: { shape: 'obj', why: 'Mozilla Persona identity is not emulated' },
    mozTCPSocket: { shape: 'obj', why: 'raw TCP sockets are not exposed to spoofed apps' },
    mozUDPSocket: { shape: 'obj', why: 'raw UDP sockets are not exposed to spoofed apps' },
    mozMobileId: { shape: 'obj', why: 'mobile identity tokens cannot be fabricated' },
    mozSecureElement: { shape: 'obj', why: 'secure element cannot be spoofed' },
    mozKeyAttestation: { shape: 'obj', why: 'hardware attestation cannot be fabricated' },
  };
  for (const [name, spec] of Object.entries(REFUSED)) {
    const api = makeRefusal(name, spec.why);
    if (spec.shape === 'fn') {
      const fn = function () { return api.getToken(); };
      Object.assign(fn, api);
      ro(navigator, name, fn);
    } else {
      ro(navigator, name, api);
    }
  }
  if (!navigator.requestMediaKeySystemAccess) {
    ro(navigator, 'requestMediaKeySystemAccess', () => {
      note('EME/CDM: refused - DRM licences are not spoofed', 'error');
      return Promise.reject(new Error('kailarp: DRM/EME is a deny capability'));
    });
  }

  /* ------------------------------------------------------- battery/gps */

  function batteryManager() {
    const b = DEVICE.battery || { level: 0.82, charging: false };
    return {
      level: b.level, charging: !!b.charging,
      chargingTime: b.chargingTime ?? Infinity,
      dischargingTime: b.dischargingTime ?? Infinity,
      onlevelchange: null, onchargingchange: null,
      addEventListener() {}, removeEventListener() {},
    };
  }
  ro(navigator, 'mozBattery', batteryManager());
  ro(navigator, 'getBattery', () => { bump('getBattery'); return Promise.resolve(batteryManager()); });
  lazy(navigator, 'battery', batteryManager);

  const geo = DEVICE.geolocation || { latitude: 0, longitude: 0, accuracy: 9999, mocked: true };
  ro(navigator, 'geolocation', {
    __kailarp: true,
    getCurrentPosition(success, error) {
      bump('geolocation.getCurrentPosition');
      const pos = { coords: { latitude: geo.latitude, longitude: geo.longitude, accuracy: geo.accuracy, altitude: geo.altitude, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now(), __kailarpMocked: true };
      note('geolocation: returning a mocked fix flagged with __kailarpMocked');
      setTimeout(() => { try { success && success(pos); } catch (e) { error && error(e); } }, 0);
    },
    watchPosition(success) { bump('geolocation.watchPosition'); this.getCurrentPosition(success); return 1; },
    clearWatch() {},
  });

  ro(navigator, 'mozConnection', { type: 'cellular', bandwidth: Infinity, metered: true, addEventListener() {}, removeEventListener() {} });
  lazy(navigator, 'connection', () => navigator.mozConnection);

  /* ------------------------------------------------------ messaging hooks */

  const handlers = new Map();
  ro(navigator, 'mozSetMessageHandler', (name, cb) => { bump('mozSetMessageHandler'); handlers.set(name, cb); });
  ro(navigator, 'mozHasPendingMessage', () => false);
  ro(navigator, 'mozIsHandlingMessage', () => false);
  ro(window, 'mozIndexedDB', window.indexedDB);

  /* --------------------------------------------------------- app surface */

  const finishResolvers = [];
  window.__KAILARP__ = {
    version: '0.1.0',
    device: DEVICE,
    capabilities: CAPS,
    get calls() { return { ...state.calls }; },
    get log() { return [...state.log]; },
    get errors() { return [...state.errors]; },
    dump() {
      return {
        device: DEVICE,
        capabilities: CAPS,
        calls: { ...state.calls },
        log: [...state.log],
        errors: [...state.errors],
        settings: Object.fromEntries(settingsStore),
        callsPlaced: calls.map((c) => ({ number: c.number, state: c.state })),
        smsRecorded: outbox.map((m) => ({ receiver: m.receiver, body: m.body })),
        completed: state.finished,
        result: state.result,
      };
    },
    // App code calls this when its own checks are done. It may be called more
    // than once while async probes settle; results are merged.
    finish(result) {
      state.finished = true;
      if (result && typeof result === 'object') {
        const prior = state.result && typeof state.result === 'object' ? state.result : {};
        state.result = { ...prior, ...result };
        if (result.checks) state.result.checks = { ...(prior.checks || {}), ...result.checks };
      } else if (result !== undefined) {
        state.result = result;
      }
      note('app called __KAILARP__.finish');
      finishResolvers.splice(0).forEach((r) => r(state.result));
      try { window.dispatchEvent(new CustomEvent('kailarp-finished', { detail: state.result })); } catch { /* ignore */ }
    },
    whenFinished() {
      if (state.finished) return Promise.resolve(state.result);
      return new Promise((resolve) => { finishResolvers.push(resolve); });
    },
    ready: false,
  };
  state.promise = Promise.resolve();
  queueMicrotask(() => {
    window.__KAILARP__.ready = true;
    note('kailarp compat layer installed');
  });
})();

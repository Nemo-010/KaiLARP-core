/* KaiOS-style compatibility probe. Uses only documented B2G/KaiOS APIs. */
(function () {
  'use strict';

  var checks = {};
  var rows = document.getElementById('rows');
  var status = document.getElementById('status');

  function row(name, ok, detail) {
    checks[name] = { ok: !!ok, detail: detail === undefined ? null : String(detail) };
    var div = document.createElement('div');
    div.className = 'row ' + (ok ? 'pass' : 'fail');
    div.innerHTML = '<span class="k"></span><span class="v"></span>';
    div.querySelector('.k').textContent = name;
    div.querySelector('.v').textContent = (ok ? 'ok' : 'FAIL') + (detail ? ' · ' + detail : '');
    rows.appendChild(div);
  }

  function fail(name, err) {
    row(name, false, String((err && err.message) || err));
  }

  function run() {
    row('ua.kaios', /KAIOS\//.test(navigator.userAgent), navigator.userAgent.split(';')[1]);
    row('ua.model', /F491H/.test(navigator.userAgent), 'F491H');
    row('screen', screen.width === 240 && screen.height === 320, screen.width + 'x' + screen.height);
    row('memory', navigator.deviceMemory <= 1, navigator.deviceMemory + 'GB');

    var conns = navigator.mozMobileConnections || [];
    row('ril.slots', conns.length === 2, conns.length + ' slots');
    row('ril.voice', !!(conns[0] && conns[0].voice && conns[0].voice.state === 'registered'),
      conns[0] && conns[0].voice ? conns[0].voice.state : 'none');

    var tel = navigator.mozTelephony;
    if (!tel) { fail('telephony.dial', 'mozTelephony missing'); }
    else {
      tel.dial('+911234567890').then(function (call) {
        row('telephony.dial', call && call.state === 'dialing', call && call.state);
        return new Promise(function (res) { setTimeout(function () { res(call.state); }, 400); });
      }).then(function (st) {
        row('telephony.active', st === 'active', st);
      }).catch(function (e) { fail('telephony.dial', e); });
    }

    var mm = navigator.mozMobileMessage;
    if (mm && mm.send) {
      mm.send('+919000000000', 'kailarp loopback').then(function (m) {
        row('sms.recorded', m && m.delivery === 'sent', 'id ' + (m && m.id));
      }).catch(function (e) { fail('sms.recorded', e); });
    } else fail('sms.recorded', 'mozMobileMessage missing');

    var s = navigator.mozSettings;
    if (s) {
      Promise.resolve(s.createLock().set('kailarp.demo', 'ran'))
        .then(function () { return s.createLock().get('kailarp.demo'); })
        .then(function (v) { row('settings.roundtrip', v === 'ran', v); })
        .catch(function (e) { fail('settings.roundtrip', e); });
    } else fail('settings.roundtrip', 'mozSettings missing');

    var store = navigator.getDeviceStorage && navigator.getDeviceStorage('sdcard');
    if (store) {
      store.addNamed({ size: 4, type: 'text/plain' }, 'kailarp.txt');
      store.get('kailarp.txt').then(function (f) {
        row('storage.sdcard', !!f && store.available() === 'available', 'free ' + store.freeSpace());
      }).catch(function (e) { fail('storage.sdcard', e); });
    } else fail('storage.sdcard', 'getDeviceStorage missing');

    if (navigator.mozAlarms) {
      navigator.mozAlarms.add(new Date(Date.now() + 60000), 'ignoreTimezone', { k: 'demo' })
        .then(function (a) { row('alarms', !!a && a.id > 0, 'id ' + a.id); })
        .catch(function (e) { fail('alarms', e); });
    } else fail('alarms', 'mozAlarms missing');

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        row('gps.mock', pos.__kailarpMocked === true && pos.coords.accuracy > 0,
          pos.coords.latitude.toFixed(3) + ',' + pos.coords.longitude.toFixed(3) + ' ±' + pos.coords.accuracy + 'm');
      }, function (e) { fail('gps.mock', e); });
    } else fail('gps.mock', 'geolocation missing');

    if (navigator.mozL10n) {
      row('l10n', navigator.mozL10n.language.code === 'en-IN', navigator.mozL10n.language.code);
    } else fail('l10n', 'mozL10n missing');

    if (navigator.mozBluetooth) {
      navigator.mozBluetooth.getDefaultAdapter().then(function (a) {
        row('bluetooth', a && a.address === '00:1A:7D:DA:71:13', a && a.address);
      }).catch(function (e) { fail('bluetooth', e); });
    } else fail('bluetooth', 'mozBluetooth missing');

    if (navigator.mozWifiManager) {
      navigator.mozWifiManager.getNetworks();
      row('wifi', navigator.mozWifiManager.enabled === true, 'ssid ' + navigator.mozWifiManager.connection.network.ssid);
    } else fail('wifi', 'mozWifiManager missing');

    var caps = (window.__KAILARP__ && window.__KAILARP__.capabilities) || null;
    row('capabilities', !!caps && caps.ok === true,
      caps ? caps.summary.native + ' native / ' + caps.summary.spoofed + ' spoofed' : 'none');

    if (navigator.mozCameras) {
      navigator.mozCameras.getList().then(function (list) {
        row('camera.list', list.length === 0, 'B2G mozCameras surface empty; capture goes through getUserMedia');
      }).catch(function (e) { fail('camera.list', e); });
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(function (stream) {
        row('getUserMedia.fake', stream.getTracks().length >= 2, stream.getTracks().length + ' synthetic tracks');
        stream.getTracks().forEach(function (t) { t.stop(); });
      }).catch(function (e) { fail('getUserMedia.fake', e); });
    } else fail('getUserMedia.fake', 'mediaDevices missing');

    if (navigator.mozPay) {
      navigator.mozPay().then(function () { row('pay.refused', false, 'should not resolve'); },
        function () { row('pay.refused', true, 'refused by policy'); });
    }

    if (navigator.mozSecureElement) {
      navigator.mozSecureElement.getToken('kailarp').then(function () { row('secure-element.refused', false, 'should not resolve'); },
        function () { row('secure-element.refused', true, 'refused, never fabricated'); });
    } else fail('secure-element.refused', 'shim did not expose the refusal surface');

    if (crypto && crypto.subtle && crypto.subtle.digest) {
      var data = new TextEncoder().encode('kailarp');
      Promise.all([crypto.subtle.digest('SHA-256', data), crypto.subtle.digest('SHA-256', data)]).then(function (pair) {
        var a = Array.prototype.map.call(new Uint8Array(pair[0]), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        var b = Array.prototype.map.call(new Uint8Array(pair[1]), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
        row('crypto.real', a === b && a === 'e16184e9dad91e095fec617cc82cd7eb7e4d0b8493066701860d1a7bdd20cfad', 'real WebCrypto, deterministic ' + a.slice(0, 12) + '…');
      }).catch(function (e) { fail('crypto.real', e); });
    } else fail('crypto.real', 'SubtleCrypto missing');
  }

  var finished = false;
  function finishWhenReady() {
    if (finished) return;
    finished = true;
    status.textContent = 'probe complete';
    window.__KAILARP__.finish({ checks: checks, kind: 'demo' });
  }

  document.getElementById('sk-right').addEventListener('click', function () { location.reload(); });
  document.getElementById('sk-left').addEventListener('click', function () { window.close(); });

  status.textContent = 'probing';
  setTimeout(run, 60);
  setTimeout(finishWhenReady, 1600);
  setTimeout(finishWhenReady, 5000);
})();

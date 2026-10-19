/* Regression probe for platform behaviours a real KaiOS package depends on.
 *
 * Every check here exists because a real package from the F491H dump broke on
 * it: JioPay 2.4.1.0 calls navigator.hasFeature(), reads IMEI/ICCID out of the
 * `jio_service_store` datastore, and ships its own copy of mozilla's l10n.js
 * which *overwrites* navigator.mozL10n on load. A plain browser provides none
 * of that, and a shim that provides them read-only makes the app throw.
 */
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
    /* 1. feature detection. JioPay calls this before anything else and dies
     *    with "window.navigator.hasFeature is not a function" without it. */
    if (typeof navigator.hasFeature === 'function') {
      navigator.hasFeature('device.capability.qwerty').then(function (qwerty) {
        row('hasFeature.qwerty', qwerty === false, 'candybar, not a QWERTY build');
        return navigator.hasFeature('device.capability.touch');
      }).then(function (touch) {
        row('hasFeature.touch', touch === true, 'touch panel');
      }).catch(function (e) { fail('hasFeature.qwerty', e); });
    } else fail('hasFeature.qwerty', 'navigator.hasFeature missing');

    /* 2. device datastore. JioPay reads rows 5..10 of `jio_service_store`
     *    (IMEI, device info, ICCID, ADID, IMSI, MSISDN) and dereferences
     *    row 6 as `.osv` — so the row has to exist, not just the store. */
    if (typeof navigator.getDataStores === 'function') {
      navigator.getDataStores('jio_service_store').then(function (stores) {
        row('datastore.opened', Array.isArray(stores) && stores.length === 1 && !!stores[0],
          stores && stores.length ? 'store present' : 'no store');
        return stores[0].get(6);
      }).then(function (deviceInfo) {
        row('datastore.device-info', !!deviceInfo && deviceInfo.osv === '6.0', deviceInfo && deviceInfo.osv);
        return navigator.getDataStores('jio_service_store');
      }).then(function (stores) {
        return stores[0].get(7);
      }).then(function (iccId) {
        row('datastore.iccid', typeof iccId === 'string' && iccId.length > 10, iccId);
        return navigator.getDataStores('jio_service_store');
      }).then(function (stores) {
        return stores[0].get(5);
      }).then(function (imei) {
        /* The profile does not hold an IMEI. A missing row is the honest
         * answer; inventing one would be fabricating a hardware identity. */
        row('datastore.imei-absent', imei === undefined, 'row 5 not invented');
      }).catch(function (e) { fail('datastore.opened', e); });
    } else fail('datastore.opened', 'navigator.getDataStores missing');

    /* 3. mozL10n is replaceable. mozilla's l10n.js assigns the whole object
     *    (`navigator.mozL10n = {...}`); a non-writable property throws
     *    "Cannot assign to read only property 'mozL10n'". */
    try {
      var prior = navigator.mozL10n;
      var replacement = { __replaced: true };
      navigator.mozL10n = replacement;
      row('mozL10n.replaceable', navigator.mozL10n === replacement, 'mozilla l10n.js overwrites it on load');
      navigator.mozL10n = prior;
    } catch (e) { fail('mozL10n.replaceable', e); }

    /* 4. The platform language is the dump's, not the app's translation set:
     *    system/build.prop says ro.product.locale=en-US and
     *    defaults/settings.json says language.current=en-US. */
    var s = navigator.mozSettings;
    if (s) {
      s.createLock().get('language.current').then(function (lang) {
        row('settings.language', lang === 'en-US' && navigator.language === 'en-US', 'settings ' + lang + ' / navigator ' + navigator.language);
      }).catch(function (e) { fail('settings.language', e); });
      s.createLock().get('deviceinfo.product_model').then(function (model) {
        row('settings.product-model', model === 'F491H', model);
      }).catch(function (e) { fail('settings.product-model', e); });
      /* settings.json ships the deviceinfo.* keys empty; Gaia fills them from
       * build.prop at boot. A shim that answers "" for all of them is not
       * reporting the device it claims to be. */
      s.createLock().get('deviceinfo.os').then(function (os) {
        row('settings.deviceinfo-os', os === '6.0', os);
      }).catch(function (e) { fail('settings.deviceinfo-os', e); });
    } else fail('settings.language', 'mozSettings missing');
  }

  document.getElementById('sk-right').addEventListener('click', function () { location.reload(); });

  status.textContent = 'probing';
  setTimeout(run, 60);
  setTimeout(function () {
    status.textContent = 'probe complete';
    window.__KAILARP__.finish({ checks: checks, kind: 'quirks' });
    /* Quit the way a KaiOS app does. In a browser tab window.close() is a
     * silent no-op, which looks exactly like a hung app; the run report has to
     * say `closed: true` for this to be a result rather than a timeout. */
    setTimeout(function () { window.close(); }, 200);
  }, 1600);
})();

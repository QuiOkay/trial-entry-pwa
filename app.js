/* global Outbox */
(function () {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };
  const NUMERIC = /^feed_/;
  let swReg = null;

  function msg(el, text, kind) { el.textContent = text; el.className = 'msg ' + (kind || ''); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---- settings
  async function loadSettings() {
    $('endpoint').value = (await Outbox.getSetting('endpoint')) || '';
    $('code').value = (await Outbox.getSetting('code')) || '';
    $('device').value = (await Outbox.getSetting('device')) || '';
    if (!$('endpoint').value || !$('code').value) $('setBox').open = true;
  }
  $('saveSet').onclick = async function () {
    const ep = $('endpoint').value.trim();
    if (ep && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(ep)) return msg($('setMsg'), 'Endpoint must be https://', 'bad');
    await Outbox.setSetting('endpoint', ep);
    await Outbox.setSetting('code', $('code').value.trim());
    await Outbox.setSetting('device', $('device').value.trim() || ('dev-' + Math.random().toString(36).slice(2, 7)));
    $('device').value = await Outbox.getSetting('device');
    msg($('setMsg'), 'Saved on this device.', 'ok');
    kick('settings');
  };
  // Code-checked ping. Tells "unreachable/blocked" apart from "wrong code".
  $('test').onclick = async function () {
    const ep = $('endpoint').value.trim();
    msg($('setMsg'), 'Testing…');
    const t0 = Date.now();
    try {
      const r = await fetch(ep, { method: 'POST', redirect: 'follow', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ v: 1, action: 'ping', code: $('code').value.trim(), device: $('device').value.trim() || 'test' }) });
      const text = await r.text();
      let d; try { d = JSON.parse(text); } catch (e) { return msg($('setMsg'), 'Reached a server but got non-JSON (HTTP ' + r.status + '). Likely a Google sign-in page: deployment is not "Anyone".', 'bad'); }
      const ms = Date.now() - t0;
      if (d.ok) msg($('setMsg'), 'OK · ' + d.email + ' (' + d.role + ') · ' + ms + ' ms round trip, server ' + d.server_ms + ' ms', 'ok');
      else msg($('setMsg'), 'Server says: ' + d.error + ' · ' + ms + ' ms', 'bad');
    } catch (e) {
      msg($('setMsg'), 'Cannot reach endpoint (' + e.message + '). Offline, wrong URL, or blocked by CORS / sign-in.', 'bad');
    }
  };

  // ---- entry
  $('field').onchange = function () {
    $('value').inputMode = NUMERIC.test($('field').value) ? 'decimal' : 'text';
  };
  $('save').onclick = async function () {
    const field = $('field').value;
    const sow = $('sow').value.trim().toUpperCase();
    const day = Number($('day').value);
    let raw = $('value').value.trim();
    if (!sow) return msg($('saveMsg'), 'Sow ID is required.', 'bad');
    if (!Number.isInteger(day)) return msg($('saveMsg'), 'Day must be a whole number.', 'bad');
    let value = raw;
    if (NUMERIC.test(field) && raw !== '') {
      raw = raw.replace(',', '.'); // Vietnamese keyboards often type a comma
      if (!/^-?\d+(\.\d+)?$/.test(raw)) return msg($('saveMsg'), 'Not a number: ' + $('value').value, 'bad');
      value = Number(raw);
    }
    const rec = {
      uuid: crypto.randomUUID(), tab: 'D_Sow_Daily', key: { sow_id: sow, day: day }, field: field, value: value,
      client_ts: new Date().toISOString(),
    };
    await Outbox.enqueue(rec);
    msg($('saveMsg'), 'Saved on device: ' + sow + ' D' + day + ' ' + field + ' = ' + (value === '' ? '(blank)' : value), 'ok');
    $('value').value = '';
    $('value').focus();
    await render();
    kick('save');
  };

  // ---- sync triggers
  async function kick(why) {
    if (swReg && 'sync' in swReg) {
      try { await swReg.sync.register('outbox-sync'); } catch (e) { /* permission or unsupported */ }
    }
    if (navigator.onLine) await syncAndShow(why);
  }
  async function syncAndShow(why) {
    if (!(await Outbox.count('outbox'))) { await render(); return; }
    msg($('syncMsg'), 'Syncing…');
    const r = await Outbox.sync(why);
    showSync(r);
    await render();
  }
  function showSync(r) {
    if (!r) return;
    const t = new Date(r.at).toLocaleTimeString();
    const rtt = r.rtt_ms && r.rtt_ms.length ? ' · rtt ' + r.rtt_ms.join('/') + ' ms' : '';
    const srv = r.server_ms && r.server_ms.length ? ' · server ' + r.server_ms.join('/') + ' ms' : '';
    const counts = ' · sent ' + (r.written || 0) + ', dup ' + (r.duplicate || 0) + ', rejected ' + (r.rejected || 0);
    const map = {
      ok: [((r.rejected && !r.written && !r.duplicate) ? 'Queue empty, nothing written' : 'Queue empty') + counts + rtt + srv, (r.rejected ? 'warn' : 'ok')],
      partial: ['Partly sent, ' + r.remaining + ' left' + counts + rtt, 'warn'],
      network_error: ['No connection, will retry (' + r.detail + ')', 'warn'],
      busy: ['Server busy, will retry', 'warn'],
      auth_error: ['Access problem: ' + r.error + '. Check the code in Settings.', 'bad'],
      bad_response: ['Unexpected response (HTTP ' + r.http + '). Deployment may not be "Anyone".', 'bad'],
      server_error: ['Server error: ' + (r.error || '') + ' ' + (r.detail || ''), 'bad'],
      not_configured: ['Set endpoint and access code in Settings.', 'warn'],
    }[r.state] || [r.state, ''];
    msg($('syncMsg'), t + ' (' + r.why + ') · ' + map[0], map[1]);
  }
  window.addEventListener('online', function () { setNet(); kick('online-event'); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick('visible'); });
  setInterval(function () { if (navigator.onLine) syncAndShow('timer'); }, 30000);
  $('syncNow').onclick = function () { syncAndShow('manual'); };
  $('clearRej').onclick = async function () { await Outbox.clear('rejected'); render(); };

  // ---- render
  function setNet() {
    $('net').textContent = navigator.onLine ? 'online' : 'offline';
    $('net').className = 'pill' + (navigator.onLine ? '' : ' off');
  }
  async function render() {
    const q = await Outbox.list('outbox', 200);
    const rj = await Outbox.list('rejected', 200);
    $('queue').textContent = 'queue ' + q.length;
    $('qn').textContent = q.length;
    $('rn').textContent = rj.length;
    const row = function (r, extra) {
      return '<tr><td>' + esc(r.key.sow_id) + ' D' + esc(r.key.day) + '</td><td>' + esc(r.field) + '</td><td>' +
        esc(r.value === '' ? '(blank)' : r.value) + '</td><td>' + esc(extra) + '</td></tr>';
    };
    $('qt').innerHTML = q.map(function (r) { return row(r, new Date(r.client_ts).toLocaleTimeString()); }).join('');
    $('rt').innerHTML = rj.map(function (r) { return row(r, r.reason); }).join('');
  }

  async function caps() {
    const lines = [];
    lines.push('Service worker: ' + ('serviceWorker' in navigator ? 'yes' : 'NO'));
    lines.push('Background Sync: ' + (swReg && 'sync' in swReg ? 'yes' : 'no (fallback: online event, app open, 30 s timer, Sync now)'));
    if (navigator.storage && navigator.storage.persist) {
      const p = await navigator.storage.persist();
      lines.push('Persistent storage: ' + (p ? 'granted' : 'not granted (browser may evict the queue under storage pressure)'));
    }
    lines.push('Standalone (installed): ' + (matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'));
    $('caps').textContent = lines.join('\n');
  }

  navigator.serviceWorker && navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'synced') { showSync(e.data.result); render(); }
  });

  (async function init() {
    setNet();
    if ('serviceWorker' in navigator) {
      try { swReg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; swReg = await navigator.serviceWorker.getRegistration(); } catch (e) { console.warn('SW failed', e); }
    }
    await loadSettings();
    showSync(await Outbox.getSetting('last_sync'));
    await render();
    await caps();
    kick('open');
  })();
})();

// Outbox queue in IndexedDB + sync to the Apps Script endpoint.
// Loaded by the page (<script>) and by the service worker (importScripts), so no modules.
/* global self */
(function (root) {
  'use strict';
  const DB_NAME = 'spikeA';
  const DB_VERSION = 1;
  const BATCH = 50;          // must be <= SPIKE.MAX_RECORDS in Code.gs
  const MAX_ROUNDS = 20;     // per sync call
  const AUTH_ERRORS = ['bad_code', 'revoked', 'role_cannot_write', 'too_many_attempts', 'no_access', 'unknown_trial'];

  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = function () {
        const d = r.result;
        d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true }); // FIFO order
        d.createObjectStore('rejected', { keyPath: 'uuid' });
        d.createObjectStore('settings');
      };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
    return dbp;
  }

  function run(store, mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        const t = d.transaction(store, mode);
        let out;
        Promise.resolve(fn(t.objectStore(store), function (v) { out = v; }));
        t.oncomplete = function () { resolve(out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('transaction aborted')); };
      });
    });
  }
  function req(r, set) { r.onsuccess = function () { set(r.result); }; }

  const Outbox = {
    getSetting: function (k) { return run('settings', 'readonly', function (s, set) { req(s.get(k), set); }); },
    setSetting: function (k, v) { return run('settings', 'readwrite', function (s) { s.put(v, k); }); },
    enqueue: function (rec) { return run('outbox', 'readwrite', function (s, set) { req(s.add(rec), set); }); },
    list: function (store, limit) {
      return run(store, 'readonly', function (s, set) { req(s.getAll(null, limit || undefined), set); });
    },
    count: function (store) { return run(store, 'readonly', function (s, set) { req(s.count(), set); }); },
    clear: function (store) { return run(store, 'readwrite', function (s) { s.clear(); }); },

    // Apply server results: written/duplicate -> drop; rejected -> move to 'rejected' (never silently lost).
    settle: function (batch, results) {
      const byUuid = {};
      results.forEach(function (r) { byUuid[r.uuid] = r; });
      return db().then(function (d) {
        return new Promise(function (resolve, reject) {
          const t = d.transaction(['outbox', 'rejected'], 'readwrite');
          const ob = t.objectStore('outbox'), rj = t.objectStore('rejected');
          const tally = { written: 0, duplicate: 0, rejected: 0, unanswered: 0 };
          batch.forEach(function (rec) {
            const r = byUuid[rec.uuid];
            if (!r) { tally.unanswered++; return; }
            tally[r.status] = (tally[r.status] || 0) + 1;
            if (r.status === 'rejected') rj.put(Object.assign({}, rec, { reason: r.reason, rejected_at: new Date().toISOString() }));
            ob.delete(rec.seq);
          });
          t.oncomplete = function () { resolve(tally); };
          t.onerror = function () { reject(t.error); };
        });
      });
    },
  };

  let syncing = null;
  // One sync at a time per context, and across page + service worker via the Web Locks API
  // (seen in the field: on reconnect both fired and one batch went twice). The server's uuid
  // check still makes a double send safe where Web Locks is missing.
  Outbox.sync = function (why) {
    if (syncing) return syncing;
    const nav = root.navigator;
    const run = function () { return doSync(why); };
    const p = nav && nav.locks ? nav.locks.request('outbox-sync', run) : run();
    syncing = p.finally(function () { syncing = null; });
    return syncing;
  };

  async function doSync(why) {
    const endpoint = await Outbox.getSetting('endpoint');
    const code = await Outbox.getSetting('code');
    const trial = await Outbox.getSetting('trial');
    const device = (await Outbox.getSetting('device')) || 'unnamed';
    if (!endpoint || !code || !trial) return note({ state: 'not_configured', why: why });

    const total = { written: 0, duplicate: 0, rejected: 0, unanswered: 0, requests: 0, rtt_ms: [], server_ms: [] };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const batch = await Outbox.list('outbox', BATCH);
      if (!batch.length) break;
      const body = JSON.stringify({
        v: 2, action: 'write', code: code, device: device, trial: trial,
        records: batch.map(function (r) { const c = Object.assign({}, r); delete c.seq; return c; }),
      });
      const t0 = Date.now();
      let res, text;
      try {
        // text/plain + no custom headers = "simple" CORS request, no preflight (Apps Script cannot answer OPTIONS).
        res = await fetch(endpoint, { method: 'POST', body: body, redirect: 'follow', cache: 'no-store',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
        text = await res.text();
      } catch (e) {
        // Offline, DNS, or CORS failure. The browser does not tell these apart.
        return note(Object.assign(total, { state: 'network_error', detail: String(e && e.message || e), why: why }));
      }
      total.requests++;
      total.rtt_ms.push(Date.now() - t0);
      let data;
      try { data = JSON.parse(text); } catch (e) {
        return note(Object.assign(total, { state: 'bad_response', http: res.status, detail: text.slice(0, 200), why: why }));
      }
      if (typeof data.server_ms === 'number') total.server_ms.push(data.server_ms);
      if (!data.ok) {
        const state = AUTH_ERRORS.indexOf(data.error) >= 0 ? 'auth_error' : (data.retry ? 'busy' : 'server_error');
        return note(Object.assign(total, { state: state, error: data.error, detail: data.detail, why: why }));
      }
      const t = await Outbox.settle(batch, data.results || []);
      ['written', 'duplicate', 'rejected', 'unanswered'].forEach(function (k) { total[k] += t[k] || 0; });
      if (t.unanswered) break; // server did not answer some records; retry later rather than loop
    }
    total.remaining = await Outbox.count('outbox');
    return note(Object.assign(total, { state: total.remaining ? 'partial' : 'ok', why: why }));
  }

  async function note(result) {
    result.at = new Date().toISOString();
    try { await Outbox.setSetting('last_sync', result); } catch (e) { /* ignore */ }
    return result;
  }

  // One request to the endpoint (ping / roster). Returns the parsed JSON, or {ok:false, error:'network'|'bad_response'}.
  Outbox.call = async function (action) {
    const endpoint = await Outbox.getSetting('endpoint'), code = await Outbox.getSetting('code'), trial = await Outbox.getSetting('trial');
    const device = (await Outbox.getSetting('device')) || 'unnamed';
    if (!endpoint || !code || !trial) return { ok: false, error: 'not_configured' };
    let res, text;
    try {
      res = await fetch(endpoint, { method: 'POST', redirect: 'follow', cache: 'no-store', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ v: 2, action: action, code: code, device: device, trial: trial }) });
      text = await res.text();
    } catch (e) { return { ok: false, error: 'network', detail: String(e && e.message || e) }; }
    try { return JSON.parse(text); } catch (e) { return { ok: false, error: 'bad_response', http: res.status }; }
  };

  root.Outbox = Outbox;
})(typeof self !== 'undefined' ? self : this);

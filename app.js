/* global Outbox */
/*
 * Trial entry app (v2). Screens: sow feed round, litter, farrowing, piglets, body condition, sync/settings.
 * Works offline from a cached roster (action 'roster'); every entry is queued in IndexedDB and sent in
 * batches of <= 50 (endpoint contract v2, sheet_gen/apps_script/Endpoint.gs). Values still in the queue are
 * shown on top of the roster (yellow), so a person sees what they entered even before it reaches the Sheet.
 */
(function () {
  'use strict';
  const $ = function (id) { return document.getElementById(id); };
  const esc = function (s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  let swReg = null, roster = null, pending = { set: {}, appends: [] }, screen = 'feed';

  const SCREENS = [['feed', 'Feed', 'Ăn nái'], ['litter', 'Litter', 'Ổ heo con'], ['farrow', 'Farrowing', 'Đẻ'],
    ['piglet', 'Piglets', 'Heo con'], ['body', 'Body', 'Cân nái'], ['sync', 'Sync', 'Đồng bộ']];

  // ---------------------------------------------------------------- helpers
  function msg(el, text, kind) { if (el) { el.textContent = text; el.className = 'msg ' + (kind || ''); } }
  // save results outlive the re-render of the screen
  let flashT = null;
  function flash(text, kind) { msg($('flash'), text, kind); clearTimeout(flashT); flashT = setTimeout(function () { msg($('flash'), ''); }, 8000); }
  function todayLocal() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function dayIndex(farrowISO, dateISO) { return Math.round((Date.parse(dateISO + 'T00:00:00Z') - Date.parse(farrowISO + 'T00:00:00Z')) / 864e5); }
  function num(raw, integer) {   // '' -> '' (not recorded); Vietnamese keyboards type a comma
    const s = String(raw).trim().replace(',', '.');
    if (s === '') return '';
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const v = Number(s);
    return integer && Math.floor(v) !== v ? null : v;
  }
  function uuid() { return crypto.randomUUID ? crypto.randomUUID() : 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  function showKey(key) { return [key.sow_id, key.day !== undefined ? 'D' + key.day : '', key.timepoint, key.tag_id].filter(function (x) { return x !== undefined && x !== ''; }).join(' '); }
  function keyStr(key) { return Object.keys(key).sort().map(function (k) { return key[k]; }).join('|'); }
  async function put(rec) {
    rec.uuid = uuid(); rec.client_ts = new Date().toISOString();
    await Outbox.enqueue(rec);
    applyLocal(rec);
    await Outbox.setSetting('roster', roster);
  }
  /**
   * Mirror an entry into the device's roster copy right away, so the screen keeps showing it after it is sent
   * (otherwise the old snapshot value would reappear and invite a second entry). The next roster refresh from
   * the server replaces this copy; a rejected entry is listed under Sync.
   */
  function applyLocal(r) {
    if (!roster) return;
    const slot = function (map, k) { return (map[k] = map[k] || {}); };
    if ((r.op || 'set') === 'set') {
      const k = r.key;
      if (r.tab === 'D_Sow_Daily') slot(roster.daily, k.sow_id + '|' + k.day)[r.field] = r.value;
      else if (r.tab === 'D_Litter_Daily') slot(roster.litter, k.sow_id + '|' + k.day)[r.field] = r.value;
      else if (r.tab === 'D_Farrowing') slot(roster.farrowing, k.sow_id)[r.field] = r.value;
      else if (r.tab === 'D_Sow_Body_Condition') slot(roster.body, k.sow_id + '|' + k.timepoint)[r.field] = r.value;
      else if (r.tab === 'D_Piglet') roster.piglets.forEach(function (p) { if (p.tag_id === k.tag_id) p[r.field] = r.value; });
      else if (r.tab === 'Sow_Master') roster.sows.forEach(function (s) { if (s.sow_id === k.sow_id) s[r.field] = r.value; });
    } else if (r.op === 'append' && r.tab === 'D_Piglet') {
      roster.piglets.push(Object.assign({ status: 'alive', nursing_sow_id: r.values.birth_sow_id, local: true }, r.values));
    } else if (r.op === 'append' && r.tab === 'Fostering') {
      roster.piglets.forEach(function (p) { if (p.tag_id === r.values.tag_id) p.nursing_sow_id = r.values.to_sow; });
    } else if (r.op === 'register') {
      roster.sows.push({ sow_id: r.values.sow_id, treatment: r.values.treatment, parity: r.values.parity, local: true });
      roster.free[r.values.treatment] = Math.max(0, (roster.free[r.values.treatment] || 0) - 1);
    }
  }
  function slotLabel(s) { return s.replace(/^(\d\d)(\d\d)$/, '$1:$2'); }
  function sowsBy(fn) { return (roster ? roster.sows : []).filter(fn).sort(function (a, b) { return a.sow_id < b.sow_id ? -1 : 1; }); }
  function trtOf(code) { return (roster.trial.treatments.filter(function (t) { return t.code === code; })[0]) || { times: [] }; }

  /** current value: queued (pending) value wins over the roster snapshot */
  function cur(tab, key, field, fromRoster) {
    const p = pending.set[tab + '|' + keyStr(key) + '|' + field];
    if (p !== undefined) return { v: p, pend: true };
    return { v: fromRoster === undefined || fromRoster === null ? '' : fromRoster, pend: false };
  }
  async function loadPending() {
    const q = await Outbox.list('outbox', 5000);
    pending = { set: {}, appends: [] };
    q.forEach(function (r) {
      if ((r.op || 'set') === 'set') pending.set[r.tab + '|' + keyStr(r.key) + '|' + r.field] = r.value;
      else pending.appends.push(r);
    });
  }

  // ---------------------------------------------------------------- roster
  async function loadRoster() { roster = (await Outbox.getSetting('roster')) || null; showRosterInfo(); }
  function showRosterInfo() {
    $('title').textContent = roster ? roster.trial.code : 'Trial Entry';
    $('rosterInfo').textContent = roster ? 'Data as of ' + new Date(roster.fetched_at).toLocaleString() + ' · ' + roster.email + ' (' + roster.role + ') · Dữ liệu lúc tải về' : 'No trial data yet: open Sync, fill Settings, tap Refresh. / Chưa có dữ liệu: vào Đồng bộ.';
  }
  async function refreshRoster(el) {
    msg(el, 'Loading trial data… / Đang tải…');
    const r = await Outbox.call('roster');
    if (!r.ok) { msg(el, 'Could not load: ' + r.error + (r.detail ? ' (' + r.detail + ')' : ''), 'bad'); return false; }
    r.fetched_at = new Date().toISOString();
    await Outbox.setSetting('roster', r);
    roster = r; showRosterInfo();
    msg(el, 'Trial data loaded: ' + r.sows.length + ' sows. / Đã tải.', 'ok');
    return true;
  }

  // ---------------------------------------------------------------- screens
  function needRoster(h) {
    if (roster) return false;
    h.push('<section><h2>No trial data on this device<small>Chưa có dữ liệu thí nghiệm trên máy</small></h2><p>Open <b>Sync</b>, fill the settings, then tap <b>Refresh trial data</b>.</p></section>');
    return true;
  }
  function dateSlotBar(h, withSlot) {
    const slots = [];
    if (withSlot) roster.trial.treatments.forEach(function (t) { t.times.forEach(function (x) { if (slots.indexOf(x) < 0) slots.push(x); }); });
    slots.sort();
    const d = state.date || roster.today || todayLocal();
    h.push('<section><div class="row"><div><label>Date<small>Ngày</small></label><input id="fDate" type="date" value="' + esc(d) + '"></div>');
    if (withSlot) h.push('<div><label>Meal<small>Bữa</small></label><select id="fSlot">' + slots.map(function (s) { return '<option' + (s === state.slot ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>');
    h.push('</div></section>');
  }
  const state = { date: '', slot: '', sow: '', tp: '' };

  function screenFeed(h) {
    if (needRoster(h)) return;
    dateSlotBar(h, true);
    const date = state.date || roster.today || todayLocal();
    const slot = state.slot || (roster.trial.treatments[0] || { times: [''] }).times[0];
    const key = slot.replace(':', '');
    const list = sowsBy(function (s) {
      if (!s.farrowing_date || s.status === 'removed') return false;
      const d = dayIndex(s.farrowing_date, date);
      return d >= roster.trial.days[0] && d <= roster.trial.days[1] && trtOf(s.treatment).times.indexOf(slot) >= 0;
    });
    h.push('<section><h2>Sow feed ' + esc(slot) + ' · ' + esc(date) + '<small>Lượng ăn của nái (kg) · trống = chưa ghi, 0 = ăn 0</small></h2>');
    if (!list.length) h.push('<p class="sub">No sow has this meal on this date. / Không có nái nào có bữa này trong ngày.</p>');
    else {
      h.push('<table><tr><th>Sow<small>Nái</small></th><th>Day<small>Ngày</small></th><th>kg</th></tr>');
      list.forEach(function (s) {
        const d = dayIndex(s.farrowing_date, date), k = { sow_id: s.sow_id, day: d };
        const c = cur('D_Sow_Daily', k, 'feed_' + key, (roster.daily[s.sow_id + '|' + d] || {})['feed_' + key]);
        h.push('<tr><td>' + esc(s.sow_id) + ' <span class="sub">' + esc(s.treatment) + '</span></td><td>D' + d + '</td><td class="n"><input inputmode="decimal" data-sow="' + esc(s.sow_id) + '" data-day="' + d + '" data-old="' + esc(c.v) + '" value="' + esc(c.v) + '"' + (c.pend ? ' class="pend"' : '') + '></td></tr>');
      });
      h.push('</table><button id="saveFeed">Save round / Lưu</button><div id="feedMsg" class="msg"></div>');
    }
    h.push('</section>');
    after.push(function () {
      bindDateSlot();
      if (!$('saveFeed')) return;
      $('saveFeed').onclick = async function () {
        const inputs = document.querySelectorAll('#screen td input[data-sow]'); let n = 0, bad = [];
        for (const el of inputs) {
          if (el.value.trim() === String(el.dataset.old)) continue;
          const v = num(el.value);
          if (v === null) { bad.push(el.dataset.sow); continue; }
          await put({ op: 'set', tab: 'D_Sow_Daily', key: { sow_id: el.dataset.sow, day: Number(el.dataset.day) }, field: 'feed_' + key, value: v }); n++;
        }
        if (bad.length) return flash('Not a number for ' + bad.join(', ') + ' (nothing else lost: ' + n + ' saved). / Không phải số.', 'bad');
        flash(n + ' value(s) saved on this device. / Đã lưu trên máy.', 'ok');
        await afterSave();
      };
    });
  }

  function screenLitter(h) {
    if (needRoster(h)) return;
    dateSlotBar(h, false);
    const date = state.date || roster.today || todayLocal();
    const list = sowsBy(function (s) { if (!s.farrowing_date || s.status === 'removed') return false; const d = dayIndex(s.farrowing_date, date); return d >= roster.trial.days[0] && d <= roster.trial.days[1]; });
    const health = roster.lists.sow_health || [];
    h.push('<section><h2>Litter · ' + esc(date) + '<small>Heo con ăn (kg cho / thừa), đã kiểm tra ổ, sức khoẻ nái</small></h2>');
    if (!list.length) { h.push('<p class="sub">No litter on this date.</p></section>'); after.push(bindDateSlot); return; }
    h.push('<table><tr><th>Sow</th><th>Offered<small>Cho</small></th><th>Left<small>Thừa</small></th><th>✓<small>KT</small></th></tr>');
    list.forEach(function (s) {
      const d = dayIndex(s.farrowing_date, date), k = { sow_id: s.sow_id, day: d }, L = roster.litter[s.sow_id + '|' + d] || {};
      const o = cur('D_Litter_Daily', k, 'piglet_feed_offered_kg', L.piglet_feed_offered_kg), l = cur('D_Litter_Daily', k, 'piglet_feed_leftover_kg', L.piglet_feed_leftover_kg);
      const c = cur('D_Litter_Daily', k, 'piglet_health_checked', L.piglet_health_checked);
      const sh = cur('D_Sow_Daily', k, 'sow_health', (roster.daily[s.sow_id + '|' + d] || {}).sow_health);
      h.push('<tr><td>' + esc(s.sow_id) + ' D' + d + (L.piglets_nursed !== undefined ? '<div class="sub">' + L.piglets_nursed + ' piglets</div>' : '') + '</td>' +
        '<td class="n"><input inputmode="decimal" data-f="piglet_feed_offered_kg" data-sow="' + esc(s.sow_id) + '" data-day="' + d + '" data-old="' + esc(o.v) + '" value="' + esc(o.v) + '"' + (o.pend ? ' class="pend"' : '') + '></td>' +
        '<td class="n"><input inputmode="decimal" data-f="piglet_feed_leftover_kg" data-sow="' + esc(s.sow_id) + '" data-day="' + d + '" data-old="' + esc(l.v) + '" value="' + esc(l.v) + '"' + (l.pend ? ' class="pend"' : '') + '></td>' +
        '<td class="c"><input type="checkbox" data-f="piglet_health_checked" data-sow="' + esc(s.sow_id) + '" data-day="' + d + '" data-old="' + (c.v === true) + '"' + (c.v === true ? ' checked' : '') + '></td></tr>' +
        '<tr><td colspan="4">' + (health.length ? '<select data-f="sow_health" data-sow="' + esc(s.sow_id) + '" data-day="' + d + '" data-old="' + esc(sh.v) + '"><option value="">Sow health: — / Sức khoẻ nái</option>' + health.map(function (x) { return '<option' + (x === sh.v ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select>'
          : '<input placeholder="Sow health note / Sức khoẻ nái (categories pending)" data-f="sow_health" data-sow="' + esc(s.sow_id) + '" data-day="' + d + '" data-old="' + esc(sh.v) + '" value="' + esc(sh.v) + '">') + '</td></tr>');
    });
    h.push('</table><button id="saveLitter">Save / Lưu</button><div id="litMsg" class="msg"></div></section>');
    after.push(function () {
      bindDateSlot();
      $('saveLitter').onclick = async function () {
        let n = 0; const bad = [];
        for (const el of document.querySelectorAll('#screen [data-f]')) {
          const f = el.dataset.f, k = { sow_id: el.dataset.sow, day: Number(el.dataset.day) };
          let v;
          if (el.type === 'checkbox') { if (String(el.checked) === el.dataset.old) continue; v = el.checked; }
          else { if (el.value.trim() === String(el.dataset.old)) continue; v = f === 'sow_health' ? el.value.trim() : num(el.value); }
          if (v === null) { bad.push(el.dataset.sow); continue; }
          await put({ op: 'set', tab: f === 'sow_health' ? 'D_Sow_Daily' : 'D_Litter_Daily', key: k, field: f, value: v }); n++;
        }
        flash(bad.length ? 'Not a number for ' + bad.join(', ') + '; ' + n + ' saved.' : n + ' value(s) saved on this device. / Đã lưu.', bad.length ? 'bad' : 'ok');
        await afterSave();
      };
    });
  }

  const FARROW_FIELDS = [['total_born', 'Total born', 'Tổng sinh'], ['born_alive', 'Born alive', 'Sinh sống'], ['stillborn', 'Stillborn', 'Chết khi sinh'],
    ['mummified', 'Mummified', 'Thai khô'], ['deformed', 'Deformed', 'Dị tật'], ['runt_lt_800g', 'Runt <800 g', 'Còi'], ['born_dead_died', 'Died', 'Chết'],
    ['below_1kg', '<1 kg', '<1 kg'], ['start_suckling', 'Start suckling', 'Bắt đầu bú'], ['weaning_count_manual', 'Weaned (manual)', 'Cai sữa (nhập tay)']];
  function screenFarrow(h) {
    if (needRoster(h)) return;
    const trts = roster.trial.treatments;
    h.push('<section><h2>Add a sow to the trial<small>Đưa nái vào thí nghiệm</small></h2><div class="row3"><div><label>Treatment<small>Nghiệm thức</small></label><select id="rTrt">' +
      trts.map(function (t) { return '<option value="' + esc(t.code) + '">' + esc(t.code) + ' (' + (roster.free[t.code] || 0) + ' free)</option>'; }).join('') + '</select></div>' +
      '<div><label>Sow ID<small>Mã nái</small></label><input id="rId" autocapitalize="characters"></div><div><label>Parity<small>Lứa</small></label><input id="rPar" inputmode="numeric"></div></div>' +
      '<button id="rSave">Add sow / Thêm nái</button><div id="rMsg" class="msg"></div></section>');
    const noDate = sowsBy(function (s) { return !s.farrowing_date; });
    h.push('<section><h2>Farrowing date<small>Ngày đẻ (sinh dòng nhập liệu cho nái)</small></h2><div class="row"><div><label>Sow</label><select id="fdSow">' +
      noDate.map(function (s) { return '<option>' + esc(s.sow_id) + '</option>'; }).join('') + '</select></div><div><label>Date<small>Ngày</small></label><input id="fdDate" type="date" value="' + esc(roster.today) + '"></div></div>' +
      '<button id="fdSave"' + (noDate.length ? '' : ' disabled') + '>Save farrowing date / Lưu</button><div id="fdMsg" class="msg"></div></section>');
    const born = sowsBy(function (s) { return !!s.farrowing_date; });
    const sow = state.sow && born.some(function (s) { return s.sow_id === state.sow; }) ? state.sow : (born[0] || {}).sow_id;
    if (sow) {
      const F = roster.farrowing[sow] || {};
      h.push('<section><h2>Litter record<small>Số liệu ổ đẻ</small></h2><label>Sow</label><select id="lrSow">' + born.map(function (s) { return '<option' + (s.sow_id === sow ? ' selected' : '') + '>' + esc(s.sow_id) + '</option>'; }).join('') + '</select><div class="row">');
      FARROW_FIELDS.forEach(function (f) { const c = cur('D_Farrowing', { sow_id: sow }, f[0], F[f[0]]); h.push('<div><label>' + f[1] + '<small>' + f[2] + '</small></label><input inputmode="numeric" data-ff="' + f[0] + '" data-old="' + esc(c.v) + '" value="' + esc(c.v) + '"' + (c.pend ? ' class="pend"' : '') + '></div>'); });
      const wd = cur('D_Farrowing', { sow_id: sow }, 'weaning_date', F.weaning_date);
      h.push('<div><label>Weaning date<small>Ngày cai (trống = D' + roster.trial.end_day + ')</small></label><input type="date" data-ff="weaning_date" data-old="' + esc(wd.v) + '" value="' + esc(wd.v) + '"></div></div>' +
        (F.weaning_count !== undefined ? '<p class="sub">Weaned counted from piglets: ' + F.weaning_count + ' / Số cai đếm từ heo con</p>' : '') +
        '<button id="lrSave">Save litter / Lưu</button><div id="lrMsg" class="msg"></div></section>');
    }
    after.push(function () {
      $('rSave').onclick = async function () {
        const id = $('rId').value.trim().toUpperCase(), par = num($('rPar').value, true);
        if (!/^[A-Z0-9][A-Z0-9_-]{0,19}$/.test(id)) return flash('Sow ID: letters/digits only. / Mã nái không hợp lệ.', 'bad');
        if (par === null) return flash('Parity must be a whole number. / Lứa phải là số nguyên.', 'bad');
        if (roster.sows.some(function (s) { return s.sow_id === id; })) return flash(id + ' is already in the trial. / Nái đã có.', 'bad');
        await put({ op: 'register', tab: 'Sow_Master', values: { sow_id: id, treatment: $('rTrt').value, parity: par } });
        flash(id + ' saved; it is added on the Sheet at the next sync. / Đã lưu.', 'ok'); await afterSave();
      };
      if ($('fdSave')) $('fdSave').onclick = async function () {
        const sowId = $('fdSow').value, d = $('fdDate').value;
        if (!sowId || !/^\d{4}-\d\d-\d\d$/.test(d)) return flash('Pick a sow and a date.', 'bad');
        if (d > todayLocal()) return flash('Farrowing date is in the future. / Ngày đẻ ở tương lai.', 'bad');
        await put({ op: 'set', tab: 'Sow_Master', key: { sow_id: sowId }, field: 'farrowing_date', value: d });
        flash(sowId + ' farrowed ' + d + ': daily rows are created at the next sync. / Đã lưu.', 'ok'); await afterSave();
      };
      if ($('lrSow')) $('lrSow').onchange = function () { state.sow = this.value; render(); };
      if ($('lrSave')) $('lrSave').onclick = async function () {
        let n = 0; const bad = [];
        for (const el of document.querySelectorAll('#screen [data-ff]')) {
          if (el.value.trim() === String(el.dataset.old)) continue;
          const f = el.dataset.ff, v = f === 'weaning_date' ? el.value : num(el.value, true);
          if (v === null) { bad.push(f); continue; }
          await put({ op: 'set', tab: 'D_Farrowing', key: { sow_id: $('lrSow').value }, field: f, value: v }); n++;
        }
        flash(bad.length ? 'Whole numbers only: ' + bad.join(', ') : n + ' value(s) saved. / Đã lưu.', bad.length ? 'bad' : 'ok'); await afterSave();
      };
    });
  }

  function screenPiglet(h) {
    if (needRoster(h)) return;
    const born = sowsBy(function (s) { return !!s.farrowing_date; });
    const sow = state.sow && born.some(function (s) { return s.sow_id === state.sow; }) ? state.sow : (born[0] || {}).sow_id;
    if (!sow) { h.push('<section><p>No sow has farrowed yet. / Chưa có nái đẻ.</p></section>'); return; }
    const queuedTags = pending.appends.filter(function (r) { return r.tab === 'D_Piglet'; }).map(function (r) { return r.values.tag_id; });
    const all = roster.piglets.map(function (p) { return queuedTags.indexOf(p.tag_id) >= 0 ? Object.assign({ pend: true }, p) : p; });
    const mine = all.filter(function (p) { return (p.nursing_sow_id || p.birth_sow_id) === sow; });
    h.push('<section><label>Sow (nursing)<small>Nái nuôi</small></label><select id="pSow">' + born.map(function (s) { return '<option' + (s.sow_id === sow ? ' selected' : '') + '>' + esc(s.sow_id) + '</option>'; }).join('') + '</select></section>');
    h.push('<section><h2>New piglets (at birth)<small>Heo con mới sinh: số tai + BW sơ sinh</small></h2><div class="tagrow"><div><label>Tag<small>Số tai</small></label><input id="pTag" autocapitalize="characters"></div>' +
      '<div><label>BW birth kg</label><input id="pBw" inputmode="decimal"></div><button id="pAdd">Add</button></div><div id="pMsg" class="msg"></div></section>');
    h.push('<section><h2>Piglets with ' + esc(sow) + ' (' + mine.filter(function (p) { return p.status === 'alive'; }).length + ' alive)<small>Heo con đang nuôi · BW cai sữa</small></h2><table><tr><th>Tag</th><th>Birth<small>Sơ sinh</small></th><th>Weaning kg<small>BW cai</small></th></tr>');
    mine.forEach(function (p) {
      const c = cur('D_Piglet', { tag_id: p.tag_id }, 'bw_weaning_kg', p.bw_weaning_kg), st = cur('D_Piglet', { tag_id: p.tag_id }, 'status', p.status);
      h.push('<tr><td>' + esc(p.tag_id) + (p.pend ? ' <span class="sub">(queued)</span>' : '') + (st.v !== 'alive' ? ' <span class="sub">' + esc(st.v) + '</span>' : '') + '</td><td>' + esc(p.bw_birth_kg) + '</td><td class="n">' +
        (p.pend || st.v !== 'alive' ? '' : '<input inputmode="decimal" data-wt="' + esc(p.tag_id) + '" data-old="' + esc(c.v) + '" value="' + esc(c.v) + '"' + (c.pend ? ' class="pend"' : '') + '>') + '</td></tr>');
    });
    h.push('</table><button id="pWSave">Save weaning BW / Lưu BW cai</button><div id="pwMsg" class="msg"></div></section>');
    // queued piglets included: the outbox is sent in order, so the new tag reaches the Sheet before its fostering / status row
    const alive = mine.filter(function (p) { return cur('D_Piglet', { tag_id: p.tag_id }, 'status', p.status).v === 'alive'; });
    const tagOpts = alive.map(function (p) { return '<option>' + esc(p.tag_id) + '</option>'; }).join('');
    h.push('<section><h2>Dead / removed<small>Chết / loại</small></h2><div class="row"><div><label>Tag</label><select id="sTag">' + tagOpts + '</select></div><div><label>Status</label><select id="sSt"><option value="dead">dead / chết</option><option value="removed">removed / loại</option></select></div></div>' +
      '<div class="row"><div><label>Date<small>Ngày</small></label><input id="sDate" type="date" value="' + esc(roster.today) + '"></div><div><label>Reason<small>Lý do</small></label><input id="sWhy"></div></div><button id="sSave">Save / Lưu</button><div id="sMsg" class="msg"></div></section>');
    h.push('<section><h2>Fostering<small>Ghép ổ: chuyển heo con sang nái khác</small></h2><div class="row"><div><label>Tag</label><select id="xTag">' + tagOpts + '</select></div><div><label>To sow<small>Sang nái</small></label><select id="xTo">' +
      born.filter(function (s) { return s.sow_id !== sow; }).map(function (s) { return '<option>' + esc(s.sow_id) + '</option>'; }).join('') + '</select></div></div><label>Date</label><input id="xDate" type="date" value="' + esc(roster.today) + '"><button id="xSave">Save fostering / Lưu</button><div id="xMsg" class="msg"></div></section>');
    h.push('<section><h2>Piglet health<small>Heo con bất thường</small></h2><div class="row"><div><label>Tag</label><select id="hTag">' + tagOpts + '</select></div><div><label>Date</label><input id="hDate" type="date" value="' + esc(roster.today) + '"></div></div>' +
      '<label>Condition<small>Tình trạng</small></label><input id="hCond"><button id="hSave">Save / Lưu</button><div id="hMsg" class="msg"></div></section>');
    after.push(function () {
      $('pSow').onchange = function () { state.sow = this.value; render(); };
      $('pAdd').onclick = async function () {
        const tag = $('pTag').value.trim().toUpperCase(), bw = num($('pBw').value);
        if (!tag) return flash('Tag is required. / Cần số tai.', 'bad');
        if (bw === null) return flash('BW is not a number.', 'bad');
        if (all.some(function (p) { return p.tag_id === tag; })) return flash(tag + ' already exists. / Số tai đã có.', 'bad');
        const v = { tag_id: tag, birth_sow_id: sow }; if (bw !== '') v.bw_birth_kg = bw;
        await put({ op: 'append', tab: 'D_Piglet', values: v });
        await afterSave(); flash(tag + ' saved. / Đã lưu.', 'ok'); $('pTag').focus();
      };
      $('pWSave').onclick = async function () {
        let n = 0; const bad = [];
        for (const el of document.querySelectorAll('#screen [data-wt]')) {
          if (el.value.trim() === String(el.dataset.old)) continue;
          const v = num(el.value); if (v === null) { bad.push(el.dataset.wt); continue; }
          await put({ op: 'set', tab: 'D_Piglet', key: { tag_id: el.dataset.wt }, field: 'bw_weaning_kg', value: v }); n++;
        }
        flash(bad.length ? 'Not a number: ' + bad.join(', ') : n + ' saved. / Đã lưu.', bad.length ? 'bad' : 'ok'); await afterSave();
      };
      $('sSave').onclick = async function () {
        const tag = $('sTag').value; if (!tag) return flash('Pick a piglet. / Chọn heo con.', 'bad');
        await put({ op: 'set', tab: 'D_Piglet', key: { tag_id: tag }, field: 'status', value: $('sSt').value });
        await put({ op: 'set', tab: 'D_Piglet', key: { tag_id: tag }, field: 'status_date', value: $('sDate').value });
        if ($('sWhy').value.trim()) await put({ op: 'set', tab: 'D_Piglet', key: { tag_id: tag }, field: 'status_reason', value: $('sWhy').value.trim() });
        flash(tag + ' ' + $('sSt').value + '. / Đã lưu.', 'ok'); await afterSave();
      };
      $('xSave').onclick = async function () {
        const tag = $('xTag').value, to = $('xTo').value; if (!tag || !to) return flash('Pick a piglet and a sow. / Chọn heo con và nái.', 'bad');
        await put({ op: 'append', tab: 'Fostering', values: { date: $('xDate').value, tag_id: tag, from_sow: sow, to_sow: to } });
        flash(tag + ' → ' + to + '. / Đã lưu.', 'ok'); await afterSave();
      };
      $('hSave').onclick = async function () {
        if (!$('hTag').value || !$('hCond').value.trim()) return flash('Tag and condition are required.', 'bad');
        await put({ op: 'append', tab: 'Piglet_Health_Log', values: { date: $('hDate').value, tag_id: $('hTag').value, sow_id: sow, condition: $('hCond').value.trim() } });
        flash('Saved. / Đã lưu.', 'ok'); await afterSave();
      };
    });
  }

  const BODY_FIELDS = [['sow_bw_kg', 'BW kg', 'Cân nặng'], ['sow_bft_site_1', 'BFT site 1 mm', 'Mỡ lưng 1'], ['sow_bft_site_2', 'BFT site 2 mm', 'Mỡ lưng 2'],
    ['sow_bcs_caliper', 'BCS caliper', 'BCS thước'], ['sow_bcs_eye', 'BCS eye', 'BCS mắt']];
  function screenBody(h) {
    if (needRoster(h)) return;
    const born = sowsBy(function (s) { return !!s.farrowing_date; });
    if (!born.length) { h.push('<section><p>No sow has farrowed yet.</p></section>'); return; }
    const sow = state.sow && born.some(function (s) { return s.sow_id === state.sow; }) ? state.sow : born[0].sow_id;
    const tps = roster.trial.body_timepoints, tp = tps.indexOf(state.tp) >= 0 ? state.tp : tps[0];
    const B = roster.body[sow + '|' + tp] || {}, bwHere = roster.trial.bw_timepoints.indexOf(tp) >= 0, k = { sow_id: sow, timepoint: tp };
    const dt = cur('D_Sow_Body_Condition', k, 'date', B.date);
    h.push('<section><div class="row"><div><label>Sow</label><select id="bSow">' + born.map(function (s) { return '<option' + (s.sow_id === sow ? ' selected' : '') + '>' + esc(s.sow_id) + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Timepoint<small>Mốc</small></label><select id="bTp">' + tps.map(function (t) { return '<option' + (t === tp ? ' selected' : '') + '>' + esc(t) + '</option>'; }).join('') + '</select></div></div>' +
      '<label>Date measured<small>Ngày đo</small></label><input type="date" data-bf="date" data-old="' + esc(dt.v) + '" value="' + esc(dt.v) + '"><div class="row">');
    BODY_FIELDS.forEach(function (f) {
      if (f[0] === 'sow_bw_kg' && !bwHere) return;
      const c = cur('D_Sow_Body_Condition', k, f[0], B[f[0]]);
      h.push('<div><label>' + f[1] + '<small>' + f[2] + '</small></label><input inputmode="decimal" data-bf="' + f[0] + '" data-old="' + esc(c.v) + '" value="' + esc(c.v) + '"' + (c.pend ? ' class="pend"' : '') + '></div>');
    });
    h.push('</div>' + (bwHere ? '' : '<p class="sub">No BW at ' + esc(tp) + ' (BW only at ' + roster.trial.bw_timepoints.join(', ') + ').</p>') + '<button id="bSave">Save / Lưu</button><div id="bMsg" class="msg"></div></section>');
    after.push(function () {
      $('bSow').onchange = function () { state.sow = this.value; render(); };
      $('bTp').onchange = function () { state.tp = this.value; render(); };
      $('bSave').onclick = async function () {
        let n = 0; const bad = [];
        for (const el of document.querySelectorAll('#screen [data-bf]')) {
          if (el.value.trim() === String(el.dataset.old)) continue;
          const f = el.dataset.bf, v = f === 'date' ? el.value : num(el.value);
          if (v === null) { bad.push(f); continue; }
          await put({ op: 'set', tab: 'D_Sow_Body_Condition', key: k, field: f, value: v }); n++;
        }
        flash(bad.length ? 'Not a number: ' + bad.join(', ') : n + ' saved. / Đã lưu.', bad.length ? 'bad' : 'ok'); await afterSave();
      };
    });
  }

  async function screenSync(h) {
    const q = await Outbox.list('outbox', 300), rj = await Outbox.list('rejected', 300);
    const row = function (r, extra) {
      const what = (r.op || 'set') === 'set' ? r.tab + ' ' + showKey(r.key) + ' ' + r.field + ' = ' + (r.value === '' ? '(blank)' : r.value) : r.op + ' ' + r.tab + ' ' + JSON.stringify(r.values);
      return '<tr><td>' + esc(what) + '</td><td>' + esc(extra) + '</td></tr>';
    };
    h.push('<section><h2>Sync<small>Đồng bộ</small></h2><button id="syncNow">Send now / Gửi ngay</button><button id="refresh" class="secondary">Refresh trial data / Tải lại dữ liệu</button><div id="syncMsg" class="msg"></div><div id="caps" class="kv"></div></section>');
    h.push('<section><details' + (q.length ? ' open' : '') + '><summary>Waiting to send (' + q.length + ') / Chờ gửi</summary><table>' + q.map(function (r) { return row(r, new Date(r.client_ts).toLocaleTimeString()); }).join('') + '</table></details></section>');
    h.push('<section><details' + (rj.length ? ' open' : '') + '><summary>Rejected by server (' + rj.length + ') / Bị từ chối</summary><table>' + rj.map(function (r) { return row(r, r.reason); }).join('') +
      '</table><p class="sub">Rejected entries are not in the Sheet. Fix and enter again, or tell R&D. / Các mục này chưa vào Sheet.</p><button id="clearRej" class="secondary">Clear list / Xoá danh sách</button></details></section>');
    h.push('<section><details id="setBox"><summary>Settings / Cài đặt</summary>' +
      '<label>Endpoint URL (Apps Script /exec)</label><input id="endpoint" autocomplete="off" spellcheck="false">' +
      '<label>Trial code<small>Mã thí nghiệm</small></label><input id="trial" autocomplete="off" autocapitalize="characters">' +
      '<label>Access code<small>Mã truy cập</small></label><input id="code" autocomplete="off" spellcheck="false">' +
      '<label>Device name<small>Tên máy</small></label><input id="device" autocomplete="off">' +
      '<button id="saveSet">Save settings / Lưu</button><button id="test" class="secondary">Test connection / Kiểm tra</button><div id="setMsg" class="msg"></div></details></section>');
    after.push(async function () {
      for (const k of ['endpoint', 'trial', 'code', 'device']) $(k).value = (await Outbox.getSetting(k)) || '';
      if (!$('endpoint').value || !$('code').value || !$('trial').value) $('setBox').open = true;
      showSync(await Outbox.getSetting('last_sync'));
      $('syncNow').onclick = function () { syncAndShow('manual'); };
      $('refresh').onclick = async function () { await syncAndShow('before-refresh'); if (await refreshRoster($('syncMsg'))) render(); };
      $('clearRej').onclick = async function () { await Outbox.clear('rejected'); render(); };
      $('saveSet').onclick = async function () {
        const ep = $('endpoint').value.trim();
        if (ep && !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(ep)) return msg($('setMsg'), 'Endpoint must be https://', 'bad');
        await Outbox.setSetting('endpoint', ep);
        await Outbox.setSetting('trial', $('trial').value.trim().toUpperCase());
        await Outbox.setSetting('code', $('code').value.trim());
        await Outbox.setSetting('device', $('device').value.trim() || ('dev-' + Math.random().toString(36).slice(2, 7)));
        $('device').value = await Outbox.getSetting('device'); $('trial').value = await Outbox.getSetting('trial');
        msg($('setMsg'), 'Saved on this device. Tap Refresh trial data. / Đã lưu.', 'ok');
      };
      $('test').onclick = async function () {
        msg($('setMsg'), 'Testing…'); const t0 = Date.now(), r = await Outbox.call('ping');
        msg($('setMsg'), r.ok ? 'OK · ' + r.email + ' (' + r.role + ') · ' + r.trial + ' · ' + (Date.now() - t0) + ' ms' : 'Problem: ' + r.error + (r.error === 'bad_response' ? ' (deployment not "Anyone"?)' : ''), r.ok ? 'ok' : 'bad');
      };
      caps();
    });
  }

  // ---------------------------------------------------------------- shell
  let after = [];
  function bindDateSlot() {
    if ($('fDate')) $('fDate').onchange = function () { state.date = this.value; render(); };
    if ($('fSlot')) $('fSlot').onchange = function () { state.slot = this.value; render(); };
  }
  async function render() {
    await loadPending();
    $('nav').innerHTML = SCREENS.map(function (s) { return '<button data-s="' + s[0] + '"' + (s[0] === screen ? ' class="on"' : '') + '>' + s[1] + '<small>' + s[2] + '</small></button>'; }).join('');
    document.querySelectorAll('#nav button').forEach(function (b) { b.onclick = function () { screen = b.dataset.s; render(); }; });
    const h = []; after = [];
    if (screen === 'feed') screenFeed(h); else if (screen === 'litter') screenLitter(h); else if (screen === 'farrow') screenFarrow(h);
    else if (screen === 'piglet') screenPiglet(h); else if (screen === 'body') screenBody(h); else await screenSync(h);
    $('screen').innerHTML = h.join('');
    for (const f of after) await f();
    $('queue').textContent = 'queue ' + (await Outbox.count('outbox'));
  }
  async function afterSave() { await render(); kick('save'); }

  async function kick(why) {
    if (swReg && 'sync' in swReg) { try { await swReg.sync.register('outbox-sync'); } catch (e) { /* unsupported */ } }
    if (navigator.onLine) await syncAndShow(why);
  }
  async function syncAndShow(why) {
    if (!(await Outbox.count('outbox'))) { $('queue').textContent = 'queue 0'; return; }
    const r = await Outbox.sync(why);
    showSync(r);
    // refresh "(queued)" marks after a send, unless the person is typing
    const a = document.activeElement;
    if (r && r.written && screen !== 'sync' && !(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName))) await render();
    $('queue').textContent = 'queue ' + (await Outbox.count('outbox'));
    if (screen === 'sync') render();
  }
  function showSync(r) {
    const el = $('syncMsg'); if (!r || !el) return;
    const counts = ' · sent ' + (r.written || 0) + ', dup ' + (r.duplicate || 0) + ', rejected ' + (r.rejected || 0);
    const map = { ok: ['Queue empty' + counts, r.rejected ? 'warn' : 'ok'], partial: ['Partly sent, ' + r.remaining + ' left' + counts, 'warn'],
      network_error: ['No connection, will retry / Mất sóng, sẽ gửi lại', 'warn'], busy: ['Server busy, will retry', 'warn'],
      auth_error: ['Access problem: ' + r.error + '. Check Settings.', 'bad'], bad_response: ['Unexpected response (HTTP ' + r.http + ')', 'bad'],
      server_error: ['Server error: ' + (r.error || '') + ' ' + (r.detail || ''), 'bad'], not_configured: ['Fill Settings (endpoint, trial, code).', 'warn'] }[r.state] || [r.state, ''];
    msg(el, new Date(r.at).toLocaleTimeString() + ' (' + r.why + ') · ' + map[0], map[1]);
  }
  async function caps() {
    const lines = ['App ' + APP_VERSION, 'Background Sync: ' + (swReg && 'sync' in swReg ? 'yes' : 'no (sends when the app is open)')];
    if (navigator.storage && navigator.storage.persist) lines.push('Persistent storage: ' + ((await navigator.storage.persist()) ? 'granted' : 'NOT granted: install the app to the home screen'));
    lines.push('Installed: ' + (matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'));
    if ($('caps')) $('caps').textContent = lines.join('\n');
  }
  const APP_VERSION = 'entry-2.0';

  function setNet() { $('net').textContent = navigator.onLine ? 'online' : 'offline'; $('net').className = 'pill' + (navigator.onLine ? '' : ' off'); }
  window.addEventListener('online', function () { setNet(); kick('online-event'); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') kick('visible'); });
  setInterval(function () { if (navigator.onLine) syncAndShow('timer'); }, 30000);
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.type === 'synced') { showSync(e.data.result); render(); } });

  // "new version" banner: a new service worker waits until the user taps Update (no more double reload)
  function watchUpdate(reg) {
    const show = function () { if (reg.waiting) $('update').classList.remove('hide'); };
    show();
    reg.addEventListener('updatefound', function () { const w = reg.installing; if (w) w.addEventListener('statechange', function () { if (w.state === 'installed' && navigator.serviceWorker.controller) show(); }); });
    $('doUpdate').onclick = function () { if (reg.waiting) reg.waiting.postMessage({ type: 'skip-waiting' }); };
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () { if (!reloaded) { reloaded = true; location.reload(); } });
  }

  (async function init() {
    setNet();
    if ('serviceWorker' in navigator) {
      try { await navigator.serviceWorker.register('sw.js'); swReg = await navigator.serviceWorker.getRegistration(); if (swReg) { watchUpdate(swReg); swReg.update(); } } catch (e) { console.warn('SW failed', e); }
    }
    await loadRoster();
    if (!roster) screen = 'sync';
    await render();
    kick('open');
    if (navigator.onLine && roster && Date.now() - Date.parse(roster.fetched_at) > 30 * 60000 && !(await Outbox.count('outbox'))) { if (await refreshRoster(null)) render(); }
  })();
})();

/**
 * Settings page for homebridge-gouly, running inside the Homebridge UI.
 *
 * Two tabs: Patterns (record from the Gouly app, edit, preview, organize into
 * groups) and Settings (controller details, network search, diagnostics).
 * Edits go to Homebridge's pending config; Homebridge's Save button writes them.
 * Talks to homebridge-ui/server.js through homebridge.request().
 */
(async () => {
  const H = window.GoulyHouse;
  const EFFECTS = { 1: 'Static', 2: 'Breathing', 3: 'Gradual', 4: 'Follow', 5: 'Scroll', 6: 'Stream', 7: 'Encircle',
    8: 'Star', 9: 'Layer', 10: 'Phantom', 11: 'Pixel Chase', 12: 'Undulation', 13: 'Multi Pulse', 14: 'Expanse',
    15: 'Spectrum', 16: 'Spotlight', 17: 'Flicker', 18: 'Glitch', 19: 'Burst', 20: 'Drift', 21: 'Sync Fade',
    25: 'Roll', 26: 'Extend', 27: 'Flame' };
  const DIRECTIONS = ['Right', 'Left', 'Center to Sides', 'Sides to Center', 'Elastic Loop'];
  const SYNC_FADE = 21;
  // Motion options the Gouly app offers per effect (see PROTOCOL.md).
  const DIR_SETS = { all: [0, 1, 2, 3, 4], lr: [0, 1], right: [0] };
  const EFFECT_DIRS = { 1: 'right', 2: 'right', 3: 'right', 4: 'all', 5: 'all', 6: 'all', 7: 'all', 8: 'right', 9: 'right',
    10: 'all', 11: 'all', 12: 'right', 13: 'right', 14: 'lr', 15: 'right', 16: 'right', 17: 'right', 18: 'right',
    19: 'all', 20: 'right', 21: 'duty', 25: 'right', 26: 'lr', 27: 'all' };
  const dirSet = fx => EFFECT_DIRS[fx] || 'all';
  // Sync Fade duty cycles: high nibble LEDs on (1-3), low nibble LEDs off (1-5).
  const DUTY = [];
  for (let on = 1; on <= 3; on++) for (let off = 1; off <= 5; off++) DUTY.push([(on << 4) | off, `${on} on, ${off} off`]);
  const $ = id => document.getElementById(id);
  /**
   * In-page confirm/prompt. Homebridge shows this page in a sandboxed frame where the
   * browser's confirm() and prompt() are blocked (they silently return cancel).
   * The dialog opens next to the element that triggered it, since the frame is as
   * tall as the page and a centred dialog could be off-screen.
   */
  function dialog({ title, body = '', ok = 'OK', cancel = 'Cancel', danger = false, input = null, extra = null, link = null }, anchor) {
    return new Promise(resolve => {
      const box = $('dlg'), dlg = box.querySelector('.g-dialog'), field = $('dlgInput');
      $('dlgTitle').textContent = title;
      $('dlgBody').innerHTML = String(body).split('\n').filter(Boolean).map(t => `<p>${esc(t)}</p>`).join('');
      $('dlgOk').textContent = ok;
      $('dlgCancel').textContent = cancel;
      $('dlgExtra').hidden = !extra;
      $('dlgOk').hidden = !!link;
      $('dlgLink').hidden = !link;
      if (link) { $('dlgLink').href = link.href; $('dlgLink').textContent = link.label; $('dlgLink').onclick = () => done(true); }
      $('dlgExtra').textContent = extra?.label || '';
      $('dlgExtra').className = `btn btn-sm me-auto ${extra?.value === 'delete' ? 'btn-outline-danger' : 'btn-outline-secondary'}`;
      $('dlgOk').className = `btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`;
      field.hidden = input === null;
      field.value = input?.value || ''; field.placeholder = input?.placeholder || '';
      box.style.height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) + 'px';
      const y = anchor ? anchor.getBoundingClientRect().top + window.scrollY : window.scrollY + 40;
      dlg.style.top = Math.max(10, y - 40) + 'px';
      box.hidden = false;
      dlg.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      (input !== null ? field : link ? $('dlgLink') : $('dlgOk')).focus();
      const done = value => {
        box.hidden = true;
        $('dlgOk').onclick = $('dlgCancel').onclick = $('dlgExtra').onclick = $('dlgLink').onclick = null;
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const confirmValue = () => (input !== null ? (field.value.trim() || null) : true);
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); done(input !== null ? null : false); }
        if (e.key === 'Enter') { e.preventDefault(); done(confirmValue()); }
      };
      document.addEventListener('keydown', onKey, true);
      $('dlgOk').onclick = () => done(confirmValue());
      $('dlgCancel').onclick = () => done(input !== null ? null : false);
      $('dlgExtra').onclick = () => done({ extra: extra.value });
    });
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hex2 = n => n.toString(16).padStart(2, '0');
  const newId = () => 'p-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // ------------------------------------------------------------ config state
  let config, platform, deviceIndex = 0;
  const adopt = cfg => {
    const previous = platform ? platform.devices : [];
    config = cfg && cfg.length ? cfg : [{ platform: 'Gouly', devices: [] }];
    platform = config[0];
    platform.devices = platform.devices || [];
    // The Settings form doesn't show the patterns list; if an edit there comes back
    // without it, keep the patterns we already had for that controller.
    let restored = false;
    platform.devices.forEach(d => {
      const before = previous.find(p => p.deviceId && p.deviceId === d.deviceId);
      if (!Array.isArray(d.patterns)) {
        d.patterns = before?.patterns || [];
        if (d.patterns.length) restored = true;
      }
      if (!Array.isArray(d.groups) && before?.groups?.length) {
        d.groups = before.groups;
        restored = true;
      }
    });
    if (deviceIndex >= platform.devices.length) deviceIndex = 0;
    return restored;
  };
  adopt(await homebridge.getPluginConfig());
  const device = () => platform.devices[deviceIndex];
  // Edits go to Homebridge's pending config; its Save button writes them.
  function setDirty(dirty) {
    $('saveBar').style.display = dirty ? '' : 'none';
  }
  const markDirty = () => { homebridge.updatePluginConfig(config); setDirty(true); };

  // ------------------------------------------------------------ pattern model
  const decode = hex => H.parseFrame(hex);
  const encode = p => {
    const b = [0xf6, p.effect, p.speed, p.b4 ?? 0, p.direction, p.b6 ?? 0xff, p.colours.length, ...p.background];
    p.colours.forEach(c => b.push(...c));
    return b.map(hex2).join(' ');
  };

  function colourName([r, g, b, w]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === 0) return w ? 'warm white' : 'off';
    if ((max - min) / max < 0.15) return w ? 'pure white' : (max < 90 ? 'gray' : 'cool white');
    const d = max - min;
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const name = [[15, 'red'], [45, 'orange'], [70, 'yellow'], [160, 'green'], [200, 'cyan'], [255, 'blue'], [320, 'purple'], [345, 'pink'], [361, 'red']]
      .find(([l]) => h < l)[1];
    return (max < 80 ? 'dark ' : '') + name;
  }
  function describe(hex) {
    const p = decode(hex);
    const names = [...new Set(p.colours.map(colourName))];
    const colours = names.length > 4 ? names.slice(0, 4).join('/') + ` +${names.length - 4}` : names.join('/');
    const parts = [EFFECTS[p.effect] || `Effect ${p.effect}`, colours];
    if (p.effect === SYNC_FADE) parts.push(`${p.direction >> 4} on ${p.direction & 15} off`, `speed ${p.speed}`);
    else if (p.effect !== 1) {
      if (dirSet(p.effect) !== 'right') parts.push((DIRECTIONS[p.direction] || '').toLowerCase());
      parts.push(`speed ${p.speed}`);
    }
    const bg = colourName(p.background);
    if (bg !== 'off') parts.push(`${bg} background`);
    return parts.filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------ previews
  const mounted = new Map();
  function mountHouse(el, hex) {
    const m = H.mount(el, hex);
    mounted.set(el, m);
    return m;
  }
  function unmountAll(container) {
    container.querySelectorAll('.g-house').forEach(el => { mounted.get(el)?.stop(); mounted.delete(el); });
  }

  // ------------------------------------------------------------ show on house
  // One pattern at a time can be shown on the real lights; stopping restores what was showing.
  let playing = null;
  function syncShowToggles() {
    document.querySelectorAll('.g-card').forEach(c => {
      const on = c.dataset.frame === playing;
      c.classList.toggle('g-playing', on);
      const t = c.querySelector('.g-show input');
      if (t) t.checked = on;
    });
  }
  async function play(frame) {
    if (!device()) return;
    playing = frame;
    syncShowToggles();
    await homebridge.request('/preview', { deviceId: device().deviceId, frame });
  }
  async function stopPlaying() {
    if (!device() || playing === null) return;
    playing = null;
    syncShowToggles();
    await homebridge.request('/preview', { deviceId: device().deviceId, frame: null });
    homebridge.toast.info('Lights restored to what they were showing.', 'Gouly');
  }

  // ------------------------------------------------------------ cards
  function card(frame, { name, badge, tag, actions }) {
    const el = document.createElement('div');
    el.className = 'g-card' + (frame === playing ? ' g-playing' : '');
    el.dataset.frame = frame;
    el.innerHTML = `${badge ? `<span class="g-badge">${badge}</span>` : ''}${tag ? `<span class="g-badge g-tag">${tag}</span>` : ''}
      <div class="g-house" title="${esc(describe(frame))}"></div>
      <input type="text" class="form-control form-control-sm" value="${esc(name)}">
      <label class="g-show form-check form-switch">
        <input class="form-check-input" type="checkbox" ${frame === playing ? 'checked' : ''}>
        <span>Show on house <span class="g-muted">(plays it on your lights)</span></span>
      </label>
      <div class="g-actions"></div>`;
    mountHouse(el.querySelector('.g-house'), frame);
    el.querySelector('.g-show input').addEventListener('change', e => (e.target.checked ? play(frame) : stopPlaying()));
    const box = el.querySelector('.g-actions');
    for (const [label, cls, fn] of actions) {
      const b = document.createElement('button');
      b.className = `btn btn-sm ${cls}`;
      b.textContent = label;
      b.addEventListener('click', () => fn(el.querySelector('input').value.trim()));
      box.appendChild(b);
    }
    return el;
  }

  // ------------------------------------------------------------ groups
  const DEFAULT_GROUP = 'default';
  const RECORDED = 'recorded';
  const NEW = 'new';          // the New pattern editor on its own
  let lastView = 'default';
  const grouping = () => device()?.groupsEnabled === true;
  // A group's name is its tile name in the Home app. The default group follows the
  // controller's name until renamed.
  function groupsOf(d) {
    const named = (d.groups || []).find(g => g.id === DEFAULT_GROUP);
    return [{ id: DEFAULT_GROUP, name: named?.name || `${d.name || 'Lights'} Patterns` },
      ...(d.groups || []).filter(g => g.id !== DEFAULT_GROUP)];
  }
  const groupOf = (d, p) => (grouping() && p.group && groupsOf(d).some(g => g.id === p.group) ? p.group : DEFAULT_GROUP);
  const tileName = (d, g) => g.name;

  /**
   * Ask for a group name; names must be unique within a controller (different
   * controllers may reuse one: HomeKit tells their tiles apart by ID).
   */
  async function askGroupName(d, { title, ok, current = null }, anchor) {
    let value = current ?? '';
    for (;;) {
      const r = await dialog({ title, ok, input: { value, placeholder: 'For example Holidays' },
        body: current !== null ? 'This is the tile name in the Home app. A tile already in the Home app keeps its name there; rename it in the Home app too.' : '',
        extra: current !== null && editGroup.target !== DEFAULT_GROUP ? { label: 'Delete group', value: 'delete' } : null }, anchor);
      if (!r || typeof r !== 'string') return r;
      const taken = groupsOf(d).some(g => g.name.trim().toLowerCase() === r.trim().toLowerCase()
        && !(current !== null && g.id === editGroup.target));
      if (!taken) return r.trim();
      await dialog({ title: 'Name already used', ok: 'OK', cancel: 'Cancel',
        body: `This controller already has a group called "${r.trim()}". Choose a different name.` }, anchor);
      value = r;
    }
  }

  function renameGroup(d, id, name) {
    d.groups = d.groups || [];
    const g = d.groups.find(x => x.id === id);
    if (g) g.name = name; else d.groups.unshift({ id, name });
    markDirty();
  }

  // ------------------------------------------------------------ views (tabs)
  let view = DEFAULT_GROUP;
  const pendingCaptured = () => {
    const d = device();
    if (!d) return [];
    const inHomeKit = new Set(d.patterns.map(p => p.frame));
    d.patterns.filter(p => p.source === 'edited' && p.sourceFrame).forEach(p => inHomeKit.add(p.sourceFrame));
    // Patterns already in HomeKit are hidden (not deleted): remove one from HomeKit and it shows here again.
    return captured.filter(c => !inHomeKit.has(c.frame));
  };
  function setView(v) {
    if (v !== NEW) lastView = v;
    view = v;
    renderViews(); renderFavourites(); renderCaptured(true);
  }
  function renderViews() {
    const d = device();
    const box = $('views');
    if (!d) { box.innerHTML = ''; return; }
    const groups = grouping() ? groupsOf(d) : [{ id: DEFAULT_GROUP, name: 'In HomeKit' }];
    if (view !== RECORDED && view !== NEW && !groups.some(g => g.id === view)) view = DEFAULT_GROUP;
    const count = id => d.patterns.filter(p => grouping() ? groupOf(d, p) === id : true).length;
    const recording = $('banner').style.display !== 'none';
    const tip = id => (grouping() ? (view === id ? 'Tap to rename or delete this group' : 'Its own tile in the Home app') : '');
    box.innerHTML = groups.map(g => `<button class="btn btn-sm ${view === g.id ? 'btn-primary' : 'btn-outline-secondary'}" role="tab" data-view="${esc(g.id)}" title="${tip(g.id)}">${esc(g.name)}${grouping() && view === g.id ? ' ✎' : ''}<span class="g-count">${count(g.id)}</span></button>`).join('')
      + `<button class="btn btn-sm ${view === RECORDED ? 'btn-primary' : 'btn-outline-secondary'}" role="tab" data-view="${RECORDED}">${recording ? '<span class="g-rec-dot"></span>' : ''}Recorded<span class="g-count">${pendingCaptured().length}</span></button>`;
    box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      if (view === NEW) { closeEditor(); setView(b.dataset.view); return; }
      if (grouping() && b.dataset.view === view && view !== RECORDED) editGroup(view, b);
      else setView(b.dataset.view);
    }));
    $('viewHomekit').style.display = view === RECORDED || view === NEW ? 'none' : '';
    $('viewRecorded').style.display = view === RECORDED ? '' : 'none';
    $('newGroup').style.display = grouping() ? '' : 'none';
  }

  // ------------------------------------------------------------ HomeKit patterns
  function patternCard(d, p) {
    const el = card(p.frame, {
      name: p.name,
      tag: p.source === 'edited' ? 'Edited' : p.source === 'custom' ? 'Custom' : '',
      actions: [
        ['Edit', 'btn-secondary', () => openEditor({ frame: p.frame, name: p.name, onSave: (frame, name) => {
          if (frame !== p.frame && (p.source ?? 'recorded') === 'recorded') { p.source = 'edited'; p.sourceFrame = p.sourceFrame || p.frame; }
          p.frame = frame; p.name = name;
        } })],
        ['Remove', 'btn-outline-danger', () => { d.patterns.splice(d.patterns.indexOf(p), 1); markDirty(); renderViews(); renderFavourites(); renderCaptured(true); }],
      ],
    });
    el.querySelector('input').addEventListener('change', e => { p.name = e.target.value.trim() || p.name; markDirty(); });
    if (grouping() && groupsOf(d).length > 1) {
      const current = groupOf(d, p);
      const sel = document.createElement('select');
      sel.className = 'form-select form-select-sm g-move';
      sel.innerHTML = groupsOf(d).map(g => `<option value="${esc(g.id)}" ${g.id === current ? 'selected' : ''}>Group: ${esc(g.name)}</option>`).join('');
      sel.addEventListener('change', async () => {
        const target = groupsOf(d).find(g => g.id === sel.value);
        const ok = await dialog({ title: `Move "${p.name}" to "${target.name}"?`, ok: 'Move',
          body: `In the Home app its switch moves to the "${tileName(d, target)}" tile as a new switch. `
            + 'Any scenes or automations that use it will need to be updated after you save and restart.' }, sel);
        if (!ok) { sel.value = current; return; }
        p.group = target.id === DEFAULT_GROUP ? undefined : target.id;
        markDirty(); renderViews(); renderFavourites();
      });
      el.querySelector('.g-actions').before(sel);
    }
    return el;
  }

  async function editGroup(id, anchor) {
    const d = device();
    const g = groupsOf(d).find(x => x.id === id);
    if (!g) return;
    const members = d.patterns.filter(p => groupOf(d, p) === g.id);
    editGroup.target = g.id;
    const r = await askGroupName(d, { title: 'Rename group', ok: 'Rename', current: g.name }, anchor);
    if (!r) return;
    if (typeof r === 'string') { renameGroup(d, g.id, r); renderViews(); renderFavourites(); renderCaptured(true); return; }
    const target = groupsOf(d)[0];
    const ok = await dialog({ title: `Delete the group "${g.name}"?`, ok: 'Delete group', danger: true, body: (members.length
        ? `Its ${members.length} pattern${members.length > 1 ? 's move' : ' moves'} to "${target.name}". In the Home app `
          + 'their switches are recreated there, so scenes or automations using them will need to be updated.'
        : 'It has no patterns.') }, anchor);
    if (!ok) return;
    members.forEach(p => { p.group = undefined; });
    d.groups = (d.groups || []).filter(x => x.id !== g.id);
    view = DEFAULT_GROUP;
    markDirty(); renderViews(); renderFavourites(); renderCaptured(true);
  }

  function renderFavourites() {
    const box = $('favourites');
    unmountAll(box);
    box.innerHTML = '';
    const d = device();
    if (!d) { box.innerHTML = '<div class="g-empty">Add a controller on the Settings tab first.</div>'; return; }
    $('homekitHelp').textContent = grouping()
      ? 'Each group is its own tile in the Home app.'
      : `Each pattern is a switch in the "${groupsOf(d)[0].name}" tile in the Home app.`;
    const members = grouping() ? d.patterns.filter(p => groupOf(d, p) === view) : d.patterns;
    if (!members.length) {
      box.innerHTML = d.patterns.length
        ? '<div class="g-empty">This group is empty. Use the Group menu on a pattern to move it here, or add one from Recorded. Empty groups don\'t appear in the Home app; a group with one pattern shows as a single switch.</div>'
        : '<div class="g-empty">Nothing yet. Press Record, or + New pattern.</div>';
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'g-grid';
    members.forEach(p => grid.appendChild(patternCard(d, p)));
    box.appendChild(grid);
  }

  // ------------------------------------------------------------ recorded patterns
  let captured = [], sessionStart = 0, capturedSig = '';
  // Names and groups typed on recorded cards survive the live refresh while recording.
  const drafts = new Map();
  async function loadCaptured() {
    captured = device() ? await homebridge.request('/captured', { deviceId: device().deviceId }) : [];
  }
  function renderCaptured(force = false) {
    const d = device();
    const pending = pendingCaptured();
    const sig = JSON.stringify([pending.map(c => c.frame), grouping(), d ? groupsOf(d) : null, sessionStart]);
    renderViews();
    if (!force && sig === capturedSig) return;   // nothing changed: keep what the user is typing
    capturedSig = sig;
    const grid = $('captured');
    unmountAll(grid);
    grid.innerHTML = '';
    if (!d) return;
    if (!pending.length) {
      grid.innerHTML = captured.length
        ? '<div class="g-empty">Everything recorded is already in HomeKit.</div>'
        : '<div class="g-empty">Nothing recorded yet. Press Record, then apply patterns in the Gouly app.</div>';
      return;
    }
    const groups = grouping() ? groupsOf(d) : [];
    const lastGroup = groups.some(g => g.id === renderCaptured.lastGroup) ? renderCaptured.lastGroup : DEFAULT_GROUP;
    for (const c of pending) {
      const draft = drafts.get(c.frame) || {};
      const isNew = sessionStart && Date.parse(c.firstSeen) >= sessionStart;
      const target = () => (drafts.get(c.frame)?.group ?? lastGroup);
      const addPattern = (name, frame = c.frame) => {
        const changed = frame !== c.frame;
        const g = target();
        d.patterns.push({ id: newId(), name: name || c.suggestedName, frame, source: changed ? 'edited' : 'recorded',
          ...(changed ? { sourceFrame: c.frame } : {}), ...(grouping() && g !== DEFAULT_GROUP ? { group: g } : {}) });
        renderCaptured.lastGroup = g;
        drafts.delete(c.frame);
        markDirty(); renderFavourites(); renderCaptured(true);
      };
      const el = card(c.frame, {
        name: draft.name ?? c.suggestedName,
        badge: isNew ? 'New' : '',
        actions: [
          ['Add to HomeKit', 'btn-primary', name => addPattern(name)],
          ['Edit', 'btn-secondary', name => openEditor({ frame: c.frame, name: name || c.suggestedName, saveLabel: 'Add to HomeKit',
            pickGroup: target(),
            onSave: (frame, n, g) => { if (g) drafts.set(c.frame, { ...(drafts.get(c.frame) || {}), group: g }); addPattern(n, frame); } })],
          ['Delete', 'btn-outline-danger', async () => {
            captured = await homebridge.request('/delete-captured', { deviceId: d.deviceId, frame: c.frame });
            drafts.delete(c.frame);
            renderCaptured(true);
          }],
        ],
      });
      el.querySelector('input').addEventListener('input', e => {
        drafts.set(c.frame, { ...(drafts.get(c.frame) || {}), name: e.target.value });
      });
      if (groups.length > 1) {
        const sel = document.createElement('select');
        sel.className = 'form-select form-select-sm g-move';
        const chosen = draft.group ?? lastGroup;
        sel.innerHTML = groups.map(g => `<option value="${esc(g.id)}" ${g.id === chosen ? 'selected' : ''}>Add to: ${esc(g.name)}</option>`).join('');
        sel.addEventListener('change', () => drafts.set(c.frame, { ...(drafts.get(c.frame) || {}), group: sel.value }));
        el.querySelector('.g-actions').before(sel);
      }
      grid.appendChild(el);
    }
  }

  // ------------------------------------------------------------ editor / builder
  let editorHouse = null;
  // pickGroup: offer a group picker (new patterns and recordings, when there is more than one group)
  function openEditor({ frame, name, onSave, saveLabel = 'Save', pickGroup = null }) {
    let chosenGroup = pickGroup;
    const p = decode(frame);
    const ed = $('editor');
    editorHouse?.stop();
    ed.style.display = '';
    ed.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    const rgbHex = c => '#' + c.slice(0, 3).map(hex2).join('');
    const fromHex = (h, w) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), w];

    const render = () => {
      editorHouse?.stop();
      ed.innerHTML = `
        <div class="g-house"></div>
        <div class="g-field"><label>Name</label><input id="eName" type="text" class="form-control form-control-sm" style="max-width:320px" value="${esc(name)}"></div>
        <div class="g-field"><label>Effect</label><select id="eEffect" class="form-select form-select-sm" style="width:auto">
          ${Object.entries(EFFECTS).map(([id, n]) => `<option value="${id}" ${+id === p.effect ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="g-field"><label>Speed</label><input id="eSpeed" type="range" min="1" max="10" value="${p.speed}"><span>${p.speed}</span></div>
        ${p.effect === SYNC_FADE
          ? `<div class="g-field"><label>Duty cycle</label><select id="eDir" class="form-select form-select-sm" style="width:auto">
              ${DUTY.map(([v, n]) => `<option value="${v}" ${v === p.direction ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`
          : dirSet(p.effect) === 'right' ? ''
          : `<div class="g-field"><label>Direction</label><select id="eDir" class="form-select form-select-sm" style="width:auto">
              ${DIR_SETS[dirSet(p.effect)].map(i => `<option value="${i}" ${i === p.direction ? 'selected' : ''}>${DIRECTIONS[i]}</option>`).join('')}</select></div>`}
        <div class="g-field"><label>Colors</label><div id="eColours"></div>
          <button class="btn btn-sm btn-outline-secondary" id="eAdd" ${p.colours.length >= 15 ? 'disabled' : ''}>+</button>
          <span class="g-muted">${p.colours.length}/15 · slider under each = warm white</span></div>
        <div class="g-field"><label>Background</label>
          <span class="g-swatch"><input type="color" id="eBg" value="${rgbHex(p.background)}"><input type="range" id="eBgW" min="0" max="255" value="${p.background[3]}"></span></div>
        <div class="g-muted mb-2" id="eDesc"></div>
        <div class="g-actions">
          ${pickGroup !== null && grouping() && groupsOf(device()).length > 1 ? `<label class="g-inline mb-0">Add to
            <select id="eGroup" class="form-select form-select-sm" style="width:auto" aria-label="Group">${groupsOf(device()).map(g =>
              `<option value="${esc(g.id)}" ${g.id === chosenGroup ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>` : ''}
          <button class="btn btn-primary btn-sm" id="eSave">${saveLabel}</button>
          <button class="btn btn-secondary btn-sm" id="eTry">Try on house</button>
          <button class="btn btn-outline-secondary btn-sm" id="eCancel">Cancel</button>
        </div>`;
      const colours = ed.querySelector('#eColours');
      p.colours.forEach((c, i) => {
        const s = document.createElement('span');
        s.className = 'g-swatch';
        s.innerHTML = `<input type="color" value="${rgbHex(c)}"><input type="range" min="0" max="255" value="${c[3]}">
          ${p.colours.length > 1 ? '<button class="btn btn-sm btn-link p-0">✕</button>' : ''}`;
        const [pick, w] = s.querySelectorAll('input');
        const update = () => { p.colours[i] = fromHex(pick.value, +w.value); refresh(); };
        pick.addEventListener('input', update); w.addEventListener('input', update);
        s.querySelector('button')?.addEventListener('click', () => { p.colours.splice(i, 1); render(); });
        colours.appendChild(s);
      });
      editorHouse = mountHouse(ed.querySelector('.g-house'), encode(p));
      const refresh = () => { const f = encode(p); editorHouse.update(f); ed.querySelector('#eDesc').textContent = describe(f); };
      refresh();
      ed.querySelector('#eEffect').addEventListener('change', e => {
        p.effect = +e.target.value;
        // Sync Fade uses fixed extra bytes in every capture (b4 = 01, dir = 0x11).
        if (p.effect === SYNC_FADE) { p.b4 = 1; p.direction = 0x11; }
        else { p.b4 = 0; if (!(DIR_SETS[dirSet(p.effect)] || [0]).includes(p.direction)) p.direction = 0; }
        render();
      });
      ed.querySelector('#eSpeed').addEventListener('input', e => { p.speed = +e.target.value; e.target.nextElementSibling.textContent = p.speed; refresh(); });
      ed.querySelector('#eDir')?.addEventListener('change', e => { p.direction = +e.target.value; refresh(); });
      ed.querySelector('#eAdd').addEventListener('click', () => { p.colours.push([255, 255, 255, 0]); render(); });
      const bg = () => { p.background = fromHex(ed.querySelector('#eBg').value, +ed.querySelector('#eBgW').value); refresh(); };
      ed.querySelector('#eBg').addEventListener('input', bg);
      ed.querySelector('#eBgW').addEventListener('input', bg);
      ed.querySelector('#eTry').addEventListener('click', async () => {
        await play(encode(p));
      });
      ed.querySelector('#eCancel').addEventListener('click', closeEditor);
      ed.querySelector('#eGroup')?.addEventListener('change', e => { chosenGroup = e.target.value; });
      ed.querySelector('#eSave').addEventListener('click', () => {
        onSave(encode(p), ed.querySelector('#eName').value.trim() || describe(encode(p)), chosenGroup);
        markDirty(); closeEditor(); renderViews(); renderFavourites();
      });
    };
    render();
  }
  function closeEditor() {
    editorHouse?.stop(); editorHouse = null;
    $('editor').style.display = 'none'; $('editor').innerHTML = '';
    if (view === NEW) { view = lastView; renderViews(); renderFavourites(); }
  }
  $('newGroup').addEventListener('click', async e => {
    const d = device();
    const name = await askGroupName(d, { title: 'New group', ok: 'Create' }, e.currentTarget);
    if (!d || !name) return;
    d.groups = d.groups || [];
    const id = 'g-' + Date.now().toString(36);
    d.groups.push({ id, name });
    markDirty();
    setView(id);
  });

  $('newPattern').addEventListener('click', () => {
    if (!device()) return homebridge.toast.error('Add a controller on the Settings tab first.', 'Gouly');
    closeEditor();
    const startGroup = view !== RECORDED && view !== NEW ? view : DEFAULT_GROUP;
    view = NEW;
    renderViews();
    openEditor({
      frame: 'f6 05 05 00 00 ff 03 00 00 00 00 ff 00 00 00 00 ff 00 00 00 00 ff 00', name: '',
      onSave: (frame, name, group) => {
        device().patterns.push({ id: newId(), name, frame, source: 'custom',
          ...(grouping() && group && group !== DEFAULT_GROUP ? { group } : {}) });
        lastView = grouping() ? (group || DEFAULT_GROUP) : DEFAULT_GROUP;   // land on where it went
      },
      saveLabel: 'Add to HomeKit',
      pickGroup: startGroup,
    });
  });

  // ------------------------------------------------------------ recording
  let countdownTimer = null, pollTimer = null;
  function showRecording(until) {
    clearInterval(pollTimer);
    if (until && until > Date.now()) {
      pollTimer = setInterval(async () => { await loadCaptured(); renderCaptured(); }, 3000);
    }
    const on = until && until > Date.now();
    $('banner').style.display = on ? '' : 'none';
    $('record').disabled = !!on;
    renderViews();
    clearInterval(countdownTimer);
    if (!on) return;
    const tick = () => {
      const s = Math.max(0, Math.round((until - Date.now()) / 1000));
      $('countdown').textContent = `stops in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      if (s === 0) showRecording(0);
    };
    tick(); countdownTimer = setInterval(tick, 1000);
  }
  $('record').addEventListener('click', async () => {
    if (!device()) return homebridge.toast.error('Add a controller on the Settings tab first.', 'Gouly');
    const r = await homebridge.request('/record/start', { deviceId: device().deviceId, minutes: 15 });
    sessionStart = Date.parse(r.startedAt);
    showRecording(Date.parse(r.until));
    closeEditor();
    setView(RECORDED);
  });
  $('stop').addEventListener('click', async () => {
    await homebridge.request('/record/stop', { deviceId: device().deviceId });
    showRecording(0);
  });
  homebridge.addEventListener('captured', e => {
    if (e.data.deviceId !== device()?.deviceId) return;
    captured = e.data.list; renderCaptured();
  });
  homebridge.addEventListener('recording-ended', () => showRecording(0));
  $('clear').addEventListener('click', async e => {
    if (!device()) return;
    const ok = await dialog({ title: 'Clear the recorded list?', ok: 'Clear', danger: true,
      body: 'Patterns already in HomeKit are kept.' }, e.currentTarget);
    if (!ok) return;
    captured = await homebridge.request('/clear', { deviceId: device().deviceId });
    renderCaptured();
  });

  // ------------------------------------------------------------ controllers
  const complete = d => !!(d.deviceId && d.localKey);
  function deviceLabel(d) {
    const n = (d.patterns || []).length;
    return [d.name || 'Unnamed', d.host || 'no IP', `${n} pattern${n === 1 ? '' : 's'}`].join(' · ')
      + (complete(d) ? '' : ' (incomplete)');
  }
  function renderDeviceSelects() {
    $('device').innerHTML = platform.devices.map((d, i) => `<option value="${i}">${esc(deviceLabel(d))}</option>`).join('');
    $('device').value = deviceIndex;
    const many = platform.devices.length > 1;
    $('pickWrap').style.display = platform.devices.length ? '' : 'none';
    $('device').style.display = many ? '' : 'none';
    $('deviceName').style.display = many ? 'none' : '';
    $('deviceName').textContent = device() ? device().name || 'Unnamed' : '';
  }
  async function refreshAll() {
    renderDeviceSelects();
    renderViews();
    renderFavourites();
    await loadCaptured(); renderCaptured(true);
    const rec = device() ? await homebridge.request('/record/status', { deviceId: device().deviceId }) : null;
    if (rec) sessionStart = Date.parse(rec.startedAt || 0);
    showRecording(rec ? Date.parse(rec.until) : 0);
    if ($('settings').style.display !== 'none') renderSettings();
  }
  $('device').addEventListener('change', e => { deviceIndex = +e.target.value; closeEditor(); refreshAll(); });

  async function deleteController(anchor) {
    const d = device();
    if (!d) return;
    const n = (d.patterns || []).length;
    const g = (d.groups || []).filter(x => x.id !== 'default').length;
    const id = d.deviceId ? `…${String(d.deviceId).slice(-4)}` : 'not set';
    const ok = await dialog({
      title: `Delete "${d.name || 'Unnamed'}"?`, ok: 'Delete', danger: true,
      body: `IP address: ${d.host || 'not set'}\nDevice ID: ${id}\n`
        + `Patterns: ${n}${g ? `, groups: ${g}` : ''}\n`
        + 'This removes the controller and everything above from the plugin, and saves right away.',
    }, anchor);
    if (!ok) return;
    platform.devices.splice(deviceIndex, 1);
    deviceIndex = 0;
    try {
      await homebridge.updatePluginConfig(config);
      await homebridge.savePluginConfig();
      setDirty(false);
    } catch (err) {
      homebridge.toast.error(`Could not save: ${err.message || err}`, 'Gouly');
      setDirty(true);
      return;
    }
    renderDeviceSelects(); renderViews(); renderFavourites(); renderCaptured(true);
    if ($('settings').style.display !== 'none' || !platform.devices.length) await showTab('settings');
    const close = await dialog({
      title: 'Deleted and saved', ok: 'Close settings', cancel: 'Stay here',
      body: 'Restart Homebridge (or this plugin\'s child bridge) to remove its tiles from the Home app. '
        + 'Plugin settings pages cannot restart Homebridge themselves; its restart button is on the Homebridge screen behind this window.',
    }, $('pickWrap'));
    if (close) homebridge.closeSettings();
  }
  $('pickDelete').addEventListener('click', e => deleteController(e.currentTarget));

  function addController() {
    platform.devices.push({ name: platform.devices.length ? `Lights ${platform.devices.length + 1}` : 'House Lights',
      deviceId: '', localKey: '', protocolVersion: '3.4', powerSwitch: true, patterns: [] });
    deviceIndex = platform.devices.length - 1;
    markDirty(); showTab('settings');
  }

  // ------------------------------------------------------------ settings form
  const field = (label, input, hint = '') =>
    `<div class="g-row"><label class="g-lbl">${label}</label>${input}${hint ? `<div class="g-hint">${hint}</div>` : ''}</div>`;
  const check = (key, label, hint = '') =>
    `<div class="g-row form-check form-switch"><input class="form-check-input" type="checkbox" data-k="${key}" id="f-${key}">
       <label class="form-check-label" for="f-${key}">${label}</label>${hint ? `<div class="g-hint">${hint}</div>` : ''}</div>`;
  const options = (key, opts) => `<select class="form-select form-select-sm" data-k="${key}">${
    opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;

  function renderSettings() {
    const box = $('settingsForm');
    const d = device();
    if (!d) {
      box.innerHTML = `<div class="g-empty">No controller yet.</div>
        <button class="btn btn-primary" id="addFirst">Add a controller</button>`;
      $('addFirst').addEventListener('click', addController);
      return;
    }
    box.innerHTML = `
      ${field('Name', `<input type="text" class="form-control" data-k="name">`, 'Shown in the Home app.')}
      ${field('Device ID', `<input type="text" class="form-control" data-k="deviceId" autocomplete="off" spellcheck="false">`)}
      <div class="g-req" id="req-deviceId" style="margin:-.7rem 0 .9rem">Required</div>
      ${field('Local Key', `<div class="g-inline"><input type="password" class="form-control" data-k="localKey" autocomplete="off" spellcheck="false">
          <button class="btn btn-outline-secondary btn-sm" id="showKey" type="button">Show</button></div>`)}
      <div class="g-req" id="req-localKey" style="margin:-.7rem 0 .9rem">Required</div>
      <div class="g-hint" style="margin:-.5rem 0 1rem">Get these with the <a href="https://github.com/mikemaat/ha-gouly#1-get-your-device-id-and-local-key" target="_blank" rel="noopener">gouly-keys instructions</a>
        from the ha-gouly project. It needs a Windows PC, Linux PC or Intel Mac; it does not currently work on Apple Silicon Macs.
        Resetting or re-pairing the controller in the Gouly app changes its key.</div>
      ${field('IP address', `<div class="g-inline"><input type="text" class="form-control" data-k="host" placeholder="Leave empty to find it automatically">
          <button class="btn btn-secondary btn-sm" id="find" type="button">Find</button></div><div class="g-hint" id="findResult"></div>
          <div class="g-log" id="findLog" style="display:none"></div>`,
        'Tip: give the controller a DHCP reservation in your router so the address never changes.')}
      ${check('powerSwitch', 'Add an on/off switch', 'A one-tap power switch next to the light. In the Home app, use "Show as Separate Tiles" to give it its own tile.')}
      ${field('When a pattern switch is turned off', options('patternOffAction', [['restore', 'Go back to the last solid color'], ['off', 'Turn the lights off'], ['none', 'Leave the pattern running']]))}
      <details id="advanced">
        <summary>Advanced</summary>
        <div style="margin-top:.9rem">
          ${field('Tuya protocol', options('protocolVersion', [['3.4', '3.4'], ['3.3', '3.3'], ['3.5', '3.5']]))}
          ${field('Controller type', options('controllerType', [['auto', 'Detect automatically'], ['classic', 'Gouly (single output)'], ['pro', 'Gouly Pro (4 outputs, experimental)']]))}
          ${check('adaptiveLighting', 'Offer Adaptive Lighting', 'Shifts white from warm at night to cool by day. Turn it on per light in the Home app.')}
          ${check('groupsEnabled', 'Organize patterns into groups', 'Each group gets a tab on the Patterns page and its own tile in the Home app. Turning this off puts every pattern back in one tile; your groups are remembered if you turn it on again.')}
          ${check('verboseLogging', 'Detailed logging', 'Writes every command and reply to the Homebridge log for this controller. Turn on when reporting a problem or a new controller model.')}
          ${field('State check interval (seconds)', `<input type="number" class="form-control" data-k="pollSeconds" min="15" step="5">`)}
          ${field('Python 3 path', `<input type="text" class="form-control" data-k="pythonPath" placeholder="python3">`, 'Only needed if Python 3 is not on the PATH.')}
          <div class="g-row">
            <label class="g-lbl">Controller info</label>
            <div class="g-hint" style="margin-bottom:.35rem">What the controller last reported to the running plugin. Updated each time it connects.</div>
            <dl class="g-info" id="ctlInfo"><dd>Loading...</dd></dl>
            <button class="btn btn-outline-secondary btn-sm" id="refreshInfo" type="button">Refresh from controller</button>
          </div>
          <div class="g-danger">
            <button class="btn btn-outline-secondary btn-sm" id="addCtl" type="button">+ Add another controller</button>
          </div>
        </div>
      </details>
      <div class="g-support" id="support">
        <label class="g-lbl">Debug report</label>
        <div class="g-hint">One text file with your settings, what the controller reported, recent commands, the last network search and the plugin's log lines, for a bug report. It never contains your Local Key.</div>
        <div class="g-inline" style="margin-top:.5rem; flex-wrap: wrap">
          <button class="btn btn-secondary btn-sm" id="makeReport" type="button">Download debug report</button>
          <label class="form-check mb-0"><input class="form-check-input" type="checkbox" id="maskNet"> <span class="form-check-label">Hide IP and MAC addresses</span></label>
        </div>
        <div id="reportBox" style="display:none">
          <textarea readonly id="reportText" aria-label="Debug report"></textarea>
          <div class="g-inline"><button class="btn btn-outline-secondary btn-sm" id="copyReport" type="button">Copy</button>
            <span class="g-hint" id="reportHint"></span></div>
        </div>
      </div>`;

    const defaults = { powerSwitch: true, patternOffAction: 'restore', protocolVersion: '3.4', controllerType: 'auto',
      adaptiveLighting: false, groupsEnabled: false, pollSeconds: 60 };
    const req = () => ['deviceId', 'localKey'].forEach(k => { $('req-' + k).style.display = d[k] ? 'none' : ''; });
    box.querySelectorAll('[data-k]').forEach(el => {
      const k = el.dataset.k;
      const v = d[k] ?? defaults[k];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
      el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
        let val = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
        if (val === '' || (el.type === 'number' && !el.value)) delete d[k]; else d[k] = val;
        markDirty(); req(); renderDeviceSelects();
        if (k === 'groupsEnabled') renderFavourites();
      });
    });
    req();
    // Advanced stays open if the user opened it, across re-renders
    const adv = $('advanced');
    adv.open = !!renderSettings.advancedOpen;
    adv.addEventListener('toggle', () => { renderSettings.advancedOpen = adv.open; });

    $('showKey').addEventListener('click', () => {
      const k = box.querySelector('[data-k="localKey"]');
      k.type = k.type === 'password' ? 'text' : 'password';
      $('showKey').textContent = k.type === 'password' ? 'Show' : 'Hide';
    });
    $('find').addEventListener('click', async () => {
      const logBox = $('findLog');
      logBox.style.display = ''; logBox.textContent = '';
      $('find').disabled = true;
      $('findResult').textContent = complete(d) ? 'Searching the network, up to a minute...'
        : 'Listing Tuya devices on the network. Enter the Device ID and Local Key to confirm which is this controller.';
      findLogTarget = logBox;
      try {
        const r = await homebridge.request('/find', complete(d) ? d : { ...d, localKey: '' });
        if (r.host) {
          d.host = r.host;
          box.querySelector('[data-k="host"]').value = r.host;
          markDirty(); renderDeviceSelects();
          $('findResult').textContent = `Found at ${r.host}.`;
        } else {
          $('findResult').textContent = complete(d) ? 'Not confirmed. See the search log below.' : '';
        }
      } catch (err) {
        $('findResult').textContent = err.message || 'Search failed.';
      } finally {
        $('find').disabled = false;
        findLogTarget = null;
      }
    });
    loadInfo(d);
    $('refreshInfo').addEventListener('click', async () => {
      $('refreshInfo').disabled = true;
      await homebridge.request('/refresh', { deviceId: d.deviceId });
      $('ctlInfo').innerHTML = '<dd>Asking the controller...</dd>';
      setTimeout(async () => { await loadInfo(d); $('refreshInfo').disabled = false; }, 4500);
    });
    $('makeReport').addEventListener('click', async () => {
      $('makeReport').disabled = true;
      try {
        const r = await homebridge.request('/report', { platform, maskNetwork: $('maskNet').checked });
        $('reportBox').style.display = '';
        $('reportText').value = r.text;
        $('reportHint').textContent = downloadText(r.filename, r.text)
          ? `Saved as ${r.filename}. If no file appeared, use Copy and paste it into the issue.`
          : 'Your browser blocked the download here; use Copy and paste it into the issue.';
      } catch (err) {
        homebridge.toast.error(err.message || 'Could not build the report', 'Gouly');
      } finally {
        $('makeReport').disabled = false;
      }
    });
    $('copyReport').addEventListener('click', async () => {
      const t = $('reportText');
      t.select();
      let ok = false;
      try { await navigator.clipboard.writeText(t.value); ok = true; } catch { ok = document.execCommand?.('copy') ?? false; }
      $('reportHint').textContent = ok ? 'Copied.' : 'Select the text above and copy it (Ctrl/Cmd+C).';
    });
    $('addCtl').addEventListener('click', addController);
  }

  let findLogTarget = null;
  homebridge.addEventListener('find-progress', e => {
    if (!findLogTarget) return;
    findLogTarget.textContent += (findLogTarget.textContent ? '\n' : '') + e.data.line;
    findLogTarget.scrollTop = findLogTarget.scrollHeight;
  });

  async function loadInfo(d) {
    const box = $('ctlInfo');
    if (!box) return;
    const i = d.deviceId ? await homebridge.request('/info', { deviceId: d.deviceId }).catch(() => null) : null;
    if (!i) { box.innerHTML = '<dd>No data yet. Save, restart Homebridge, and check again once the plugin has connected.</dd>'; return; }
    const type = { classic: 'GOULY single output', pro: 'Gouly Pro' }[i.type] || i.type;
    const rows = [['Type', type], ['Firmware', i.firmware || 'shown after the Gouly app connects'], ['Pixels', i.pixels],
      ['LED IC', i.icType], ['Color order', i.rgbOrder], ['Protocol', i.protocol], ['IP address', i.host],
      ['Connected since', i.connectedSince ? new Date(i.connectedSince).toLocaleString() : 'not connected'],
      ['Connections', `${i.connects} (${i.disconnects} dropped)`], ['Last problem', i.lastError || 'none'],
      ['Unrecognized', i.unrecognized?.length ? `${i.unrecognized.length} command(s)` : 'none'],
      ['Updated', new Date(i.updated).toLocaleString()]];
    box.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v ?? '-')}</dd>`).join('');
  }

  /** Try to save a text file; returns false if the frame blocks downloads. */
  function downloadText(filename, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ tabs
  async function showTab(which) {
    const onSettings = which === 'settings';
    if (onSettings) closeEditor();
    $('patterns').style.display = onSettings ? 'none' : '';
    $('settings').style.display = onSettings ? '' : 'none';
    $('tabPatterns').className = onSettings ? 'btn btn-secondary' : 'btn btn-primary';
    $('tabSettings').className = onSettings ? 'btn btn-primary' : 'btn btn-secondary';
    renderDeviceSelects();
    if (onSettings) renderSettings(); else await refreshAll();
  }
  $('tabPatterns').addEventListener('click', () => showTab('patterns'));
  $('tabSettings').addEventListener('click', () => showTab('settings'));
  homebridge.addEventListener('configChanged', e => {
    if (adopt(e.data)) homebridge.updatePluginConfig(config);
    renderDeviceSelects();
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && $('patterns').style.display !== 'none') {
      await loadCaptured(); renderCaptured();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (playing && device()) homebridge.request('/preview', { deviceId: device().deviceId, frame: null });
  });

  // ------------------------------------------------------------ footer
  const ICONS = {
    coffee: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3.5c-.6.8.6 1.7 0 2.5M11.5 3.5c-.6.8.6 1.7 0 2.5M15 3.5c-.6.8.6 1.7 0 2.5"/></svg>',
    bug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M9 7a3 3 0 0 1 6 0M12 11v9M3 13h4M17 13h4M4 7l3 2M20 7l-3 2M4 19l3-2M20 19l-3-2"/></svg>',
    idea: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z"/></svg>',
    github: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z"/></svg>',
  };
  async function renderFooter() {
    let a;
    try { a = await homebridge.request('/about'); } catch { return; }
    if (!a || !a.version) return;
    const link = (href, icon, text) => href
      ? `<a href="${esc(href)}" target="_blank" rel="noopener">${ICONS[icon]}<span>${text}</span></a>` : '';
    const q = new URLSearchParams({ template: 'bug_report.yml', 'plugin-version': a.version, 'node-version': a.node });
    $('footer').innerHTML = [
      link(a.funding, 'coffee', 'Buy me a coffee'),
      a.issues ? `<a href="#" id="reportBug">${ICONS.bug}<span>Report a bug</span></a>` : '',
      link(a.issues && `${a.issues}/new?template=feature_request.yml`, 'idea', 'Suggest an idea'),
      link(a.repo, 'github', `v${esc(a.version)}`),
    ].filter(Boolean).join('');
    $('reportBug')?.addEventListener('click', async e => {
      e.preventDefault();
      const r = await dialog({
        title: 'Report a bug',
        body: 'To get the quickest fix:\n'
          + '1. Settings, Advanced: turn on Detailed logging, click Save, restart Homebridge, then make the problem happen again.\n'
          + '2. Settings tab: Download debug report. It never contains your Local Key.\n'
          + '3. Open the bug report and attach the file (drag it into the form). Gouly Pro owners: say so in the report.',
        cancel: 'Close',
        extra: { label: 'Go to debug report', value: 'report' },
        link: { href: `${a.issues}/new?${q}`, label: 'Open bug report' },
      }, $('footer'));
      if (r?.extra === 'report') {
        await showTab('settings');
        $('support')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  renderFooter();
  await refreshAll();
  if (!platform.devices.length || !complete(device())) await showTab('settings');
})();

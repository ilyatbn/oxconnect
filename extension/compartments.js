// oxconnect — custom compartment picker (experimental, adv setting `customCompartmentPicker`)
//
// Replaces the body of the OCI console's compartment filter menu with a flat, searchable
// list that supports PINNING favourites to the top and giving them ALIASES.
//
// How the native picker works (established by inspecting the live console):
//   • trigger  : div.oj-oci-compartment-filter-control  (its .oj-oci-filter-chip is the
//                clickable chip; aria-label = "Edit or change Compartment filter with <name> value")
//   • menu     : div.oj-oci-filter-menu--form-container, rendered into a floating layer under
//                #__root_layer_host. It is GENERIC — the same shell hosts other filter menus —
//                so we only hijack it when it contains
//                .oj-oci-compartment-filter-control--compartment-select-container.
//   • list     : ul.oj-oci-treeview-list with li.oj-oci-treeview-item, id/data-test-id carrying
//                the compartment OCID. It is a LAZY TREE: only expanded branches exist in the
//                DOM, so an arbitrary compartment usually has no row to click.
//   • the menu lives in the same-origin `sandbox-maui-preact-container` iframe, which is why
//                this script runs with all_frames.
//
// Selecting therefore does NOT try to expand the tree by hand. It drives the native UI:
// type the compartment name into their (now off-screen) search box → their tree re-renders
// with the match and its ancestors expanded → dispatch a real click on the matching row.
// Their own handler applies the selection, so everything downstream (URL, page reload,
// activeCompartmentId persistence) behaves exactly as if the user had clicked it.
//
// Compartment data comes from the console's own cache: IndexedDB `duplo`, object store
// `compartments/<tenantName>/<userOcid>`, keyed by region → a flat array of
// { id, compartmentId (parent), name, description, lifecycleState }. If that is missing we
// fall back to harvesting whatever rows the native tree has rendered.

(() => {
  const MENU = '.oj-oci-filter-menu--form-container';
  const COMPARTMENT_MARKER = '.oj-oci-compartment-filter-control--compartment-select-container';
  const ROOT_ID = 'oxconnect-compartment-picker';

  const state = { adv: null, tenant: null, comps: null, prefs: { pinned: [], aliases: {}, settings: {} } };

  // ---- storage -------------------------------------------------------------

  // Pins/aliases are per tenancy — compartment OCIDs are tenancy-scoped, and the whole
  // point of the extension is that you hop between tenancies.
  async function loadPrefs(tenant) {
    const { compartmentPrefs } = await chrome.storage.local.get('compartmentPrefs');
    const t = (compartmentPrefs || {})[tenant] || {};
    // `settings` is per-compartment extras (currently just { region }), keyed by OCID.
    return { pinned: Array.isArray(t.pinned) ? t.pinned : [], aliases: t.aliases || {}, settings: t.settings || {} };
  }
  async function savePrefs(tenant, prefs) {
    const { compartmentPrefs } = await chrome.storage.local.get('compartmentPrefs');
    const all = compartmentPrefs || {};
    all[tenant] = prefs;
    await chrome.storage.local.set({ compartmentPrefs: all });
  }

  // ---- compartment data ----------------------------------------------------

  const idbOpen = (name) => new Promise((res, rej) => {
    const q = indexedDB.open(name);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });

  // `duplo` holds one set of stores PER TENANCY — and because oxconnect deliberately keeps
  // that database across a tenant switch (see clearConsoleIdbExceptPrefs in background.js),
  // several tenancies' caches coexist. Picking the first one shows the wrong compartments,
  // so the active tenancy has to be identified:
  //   1. the tenancy whose stored `activeCompartmentId` resolves to the compartment the
  //      filter chip is currently showing — exact, and true however the user signed in;
  //   2. failing that, the tenancy with the newest `lastUserActivity`.
  async function loadFromCache(activeName) {
    let db;
    try { db = await idbOpen('duplo'); } catch { return null; }
    try {
      const get = (store, key) => new Promise((r) => {
        const q = db.transaction(store, 'readonly').objectStore(store).get(key);
        q.onsuccess = () => r(q.result); q.onerror = () => r(undefined);
      });
      const getAll = (store) => new Promise((r) => {
        const q = db.transaction(store, 'readonly').objectStore(store).getAll();
        q.onsuccess = () => r(q.result); q.onerror = () => r([]);
      });
      const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

      const tenants = [...db.objectStoreNames]
        .filter((s) => s.startsWith('compartments/'))
        .map((s) => ({ store: s, tenant: s.split('/')[1], prefs: s.slice('compartments/'.length) }));
      if (!tenants.length) return null;

      // flat, de-duplicated compartment list for one tenancy (the store holds one entry per region)
      const compsOf = async (t) => {
        const byId = new Map();
        for (const raw of await getAll(t.store)) {
          for (const c of (parse(raw)?.data || [])) {
            if (!c?.id || !c?.name) continue;
            if (c.lifecycleState && c.lifecycleState !== 'ACTIVE') continue;
            byId.set(c.id, { id: c.id, parent: c.compartmentId, name: c.name, description: c.description || '' });
          }
        }
        return [...byId.values()];
      };

      const subs = new Map();
      for (const t of tenants) {
        if (db.objectStoreNames.contains(t.prefs)) subs.set(t.prefs, await get(t.prefs, 'subscribed-regions'));
      }

      let best = null;
      for (const t of tenants) {
        const comps = await compsOf(t);
        if (!comps.length) continue;
        const hasPrefs = db.objectStoreNames.contains(t.prefs);
        const activeId = hasPrefs ? await get(t.prefs, 'activeCompartmentId') : null;
        const activity = Number(hasPrefs ? (await get(t.prefs, 'lastUserActivity')) || 0 : 0);
        // The tenancy's own subscribed-region list — the right menu to offer, since a
        // tenancy can only be used in the regions it is subscribed to.
        // shape: { data:[{ id:"IAD", displayName:"us-ashburn-1", friendlyName:"US East (Ashburn)" }] }
        const regions = (() => {
          try {
            const raw = hasPrefs ? subs.get(t.prefs) : null;
            return (parse(raw)?.data || []).map((r) => ({ id: r.id, name: r.displayName, label: r.friendlyName }))
              .filter((r) => r.name);
          } catch { return []; }
        })();
        // (1) exact: this tenancy's remembered compartment is the one on the chip
        if (activeName && activeId && comps.some((c) => c.id === activeId && c.name === activeName))
          return { tenant: t.tenant, comps, regions, matchedBy: 'activeCompartment' };
        // (2) fallback candidate
        if (!best || activity > best.activity) best = { tenant: t.tenant, comps, regions, activity, matchedBy: 'lastActivity' };
      }
      return best;
    } finally { db.close(); }
  }

  // Fallback: whatever the native tree currently has in the DOM. Incomplete (lazy tree),
  // but better than an empty picker if the cache has not been written yet.
  function loadFromDom(menu) {
    const comps = [];
    for (const row of menu.querySelectorAll('[data-test-id^="oj-oci-treeview-item-content-"]')) {
      const id = row.getAttribute('data-test-id').replace('oj-oci-treeview-item-content-', '');
      const name = (row.innerText || '').trim().split('\n')[0];
      if (id && name) comps.push({ id, parent: null, name, description: '' });
    }
    return comps;
  }

  // Build "parent / grandparent" for the secondary line, from the parent links.
  // The tenancy ROOT compartment is its own parent (id === compartmentId), which would spin
  // forever, and naming it on every row is pure noise since it is the same for all of them —
  // so walking stops at the root and the root itself is left out.
  function pathOf(c, byId) {
    const parts = [];
    const seen = new Set([c.id]);
    let n = byId.get(c.parent);
    while (n && !seen.has(n.id) && n.id !== n.parent) {
      seen.add(n.id);
      parts.unshift(n.name);
      n = byId.get(n.parent);
    }
    return parts.join(' / ');
  }

  // ---- selection (drive the native picker) ---------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, ms) {
    const t = Date.now();
    for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(60); }
  }

  async function selectCompartment(menu, comp) {
    const input = menu.querySelector('input');
    if (!input) return false;
    // preact-controlled input: assign through the native setter so its own onInput fires.
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(input, comp.name);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const sel = `[data-test-id="oj-oci-treeview-item-content-${CSS.escape(comp.id)}"]`;
    const row = await until(() => menu.querySelector(sel), state.adv.compartmentSelectTimeoutMs);
    if (!row) return false;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      row.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return true;
  }

  // ---- region ---------------------------------------------------------------
  //
  // Where the console keeps the active region (traced by diffing all storage across a region
  // switch — see scripts/region-trace.js). NO cookie is involved, which is why deleting the
  // `?region=` query param just gets it re-added:
  //   sessionStorage.region          "us-ashburn-1"   (region NAME, per tab)
  //   sessionStorage.activeRegionId  "IAD"            (region KEY, per tab)
  //   duplo <tenantName>/<userOcid> → activeRegionId  "IAD"  (durable, survives reloads)
  // plus lazily-built per-region caches (`capability/<tenancyOcid>::<region>`, …).
  //
  // Writing those by hand would leave the SPA's in-memory state stale, so — exactly as with
  // compartment selection — we drive the console's own region menu instead. That menu lives
  // in the TOP frame, not the sandbox iframe this script's picker code runs in; both are
  // cloud.oracle.com, so the top document is reachable.
  function topDoc() {
    try { if (window.top && window.top.document) return window.top.document; } catch { /* cross-origin */ }
    return document;
  }
  function currentRegionName() {
    try { const r = sessionStorage.getItem('region'); if (r) return r; } catch {}
    try { return new URL(window.top.location.href).searchParams.get('region') || ''; } catch { return ''; }
  }

  // The extension's Discovery region doubles as the console default (the user's choice).
  async function defaultRegion() {
    const { settings } = await chrome.storage.local.get('settings');
    return (settings && settings.discoveryRegion) || 'us-ashburn-1';
  }

  async function applyRegion(regionName, regions) {
    if (!regionName || currentRegionName() === regionName) return true;
    const doc = topDoc();
    const btn = doc.getElementById('region-menu-button');
    if (!btn) return false;
    // The friendly label ("Germany Central (Frankfurt)") is what the menu renders; fall back to
    // the raw region name in case the tenancy's subscribed-region list did not have a label.
    const label = (regions.find((r) => r.name === regionName) || {}).label || regionName;
    const items = () => [...doc.querySelectorAll('.region-selector a.dropmenu__option-item')];
    const find = () => items().find((e) => (e.innerText || '').includes(label))
                    || items().find((e) => (e.innerText || '').includes(regionName));
    // The menu's anchors stay in the DOM while it is closed, so only open it when they are
    // not actually laid out (`offsetParent === null`) — clicking the button blindly would
    // toggle an already-open menu shut.
    let hit = find();
    if (!hit || hit.offsetParent === null) {
      btn.click();
      hit = await until(() => { const h = find(); return h && h.offsetParent !== null ? h : null; }, 4000);
    }
    if (!hit) { if (find()) btn.click(); return false; }   // not subscribed — leave the menu as we found it
    hit.click();
    return true;
  }

  // ---- UI ------------------------------------------------------------------

  const svg = (body) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${body}</svg>`;
  // Pinned rows get a SOLID pin (and the accent colour); unpinned get a hollow outline, so the
  // two states differ in shape as well as colour rather than only in shade.
  const ICON_PIN_OFF = svg('<path fill="none" stroke="currentColor" stroke-width="1.3" d="M9.5 2.2 13.8 6.5l-1 1-.6-.6-2.9 2.9.6 1.8-.7.7-4.4-4.4.7-.7 1.8.6 2.9-2.9-.6-.6zM5.5 10.5 2.6 13.4"/>');
  const ICON_PIN_ON = svg('<path d="M9.5 1.5 14.5 6.5l-1.4 1.4-.7-.7-2.8 2.8.7 2.1-1.1 1.1L6 10.9l-3.5 3.5-.9-.9L5.1 10 1.8 6.8l1.1-1.1 2.1.7L7.8 3.6l-.7-.7z"/>');
  const ICON_ALIAS = svg('<path d="M3 1.5h6.2L13 5.3V14.5H3zm5.8 1.2v3h3zM4.8 8h6.4v1.1H4.8zm0 2.4h6.4v1.1H4.8zm0-4.8h2.6v1.1H4.8z"/>');
  const ICON_GEAR = svg('<path d="M8 5.4A2.6 2.6 0 1 0 8 10.6 2.6 2.6 0 0 0 8 5.4m0 1.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6"/><path d="m6.9 1 -.2 1.5a5.4 5.4 0 0 0-1.2.7L4.1 2.6 2.6 4.1l.6 1.4a5.4 5.4 0 0 0-.7 1.2L1 6.9v2.2l1.5.2q.27.65.7 1.2l-.6 1.4 1.5 1.5 1.4-.6q.55.43 1.2.7L6.9 15h2.2l.2-1.5q.65-.27 1.2-.7l1.4.6 1.5-1.5-.6-1.4q.43-.55.7-1.2L15 9.1V6.9l-1.5-.2a5.4 5.4 0 0 0-.7-1.2l.6-1.4-1.5-1.5-1.4.6a5.4 5.4 0 0 0-1.2-.7L9.1 1z" fill="none" stroke="currentColor" stroke-width="1.1"/>');

  const CSS_TEXT = `
    :host { all: initial; display:block; height:100%; }
    .wrap { height:100%; padding:10px; background:#fff; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .wrap { display:flex; flex-direction:column; gap:8px; color:#1d1d1d; }
    .list { flex:1; }
    .search { width:100%; padding:7px 10px; font-size:13px; border:1px solid #9a9a9a; border-radius:4px; outline:none; }
    .search:focus { border-color:#0572ce; box-shadow:0 0 0 1px #0572ce; }
    .list { overflow-y:auto; border:1px solid #e0e0e0; border-radius:4px; }
    .hdr { padding:5px 10px; font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase;
           color:#5b5b5b; background:#f4f4f4; position:sticky; top:0; z-index:1; }
    .row { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; border-bottom:1px solid #f2f2f2; }
    .row:hover, .row.cursor { background:#eaf3fb; }
    .row.active { background:#e2eefa; }
    .row .txt { flex:1; min-width:0; }
    .row .name { font-size:13px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row .sub  { font-size:11px; color:#6b6b6b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .row .name b { color:#0572ce; font-weight:600; }
    .ico { flex:none; display:flex; align-items:center; justify-content:center; width:22px; height:22px;
           border:none; background:none; border-radius:4px; cursor:pointer; color:#b4b4b4; padding:0; }
    .ico:hover { background:#dbe9f6; color:#0572ce; }
    .ico.on { color:#c74634; }
    .ico.on:hover { background:#f7e2df; color:#c74634; }
    .row.pinned { cursor:grab; }
    .row.pinned.dragging { opacity:.4; }
    .row.dropbefore { box-shadow: inset 0 2px 0 0 #0572ce; }
    .row.dropafter  { box-shadow: inset 0 -2px 0 0 #0572ce; }
    .grip { flex:none; width:9px; color:#c9c9c9; font-size:11px; line-height:1; letter-spacing:-1px; user-select:none; }
    .badge { flex:none; font-size:10px; padding:1px 5px; border-radius:9px; background:#e2eefa; color:#0a5aa0; white-space:nowrap; }
    .modal { position:absolute; inset:0; background:rgba(255,255,255,.97); display:flex; flex-direction:column;
             gap:12px; padding:14px; z-index:20; }
    .modal h3 { margin:0; font-size:13px; font-weight:700; }
    .modal h3 span { display:block; font-weight:400; font-size:11px; color:#6b6b6b; margin-top:2px; }
    .field { display:flex; flex-direction:column; gap:4px; }
    .field label { font-size:11px; font-weight:600; color:#4a4a4a; }
    .field input, .field select { padding:6px 8px; font-size:13px; border:1px solid #9a9a9a; border-radius:4px; }
    .field .hint { font-size:10px; color:#7a7a7a; }
    .btns { margin-top:auto; display:flex; gap:8px; justify-content:flex-end; }
    .btn { padding:6px 14px; font-size:12px; border-radius:4px; border:1px solid #9a9a9a; background:#fff; cursor:pointer; }
    .btn.primary { background:#0572ce; border-color:#0572ce; color:#fff; }
    .aliasEdit { flex:1; font-size:12px; padding:4px 6px; border:1px solid #0572ce; border-radius:3px; outline:none; }
    .empty { padding:14px 10px; font-size:12px; color:#6b6b6b; text-align:center; }
    .foot { font-size:10px; color:#8a8a8a; display:flex; justify-content:space-between; }
    @media (prefers-color-scheme: dark) {
      .wrap { color:#e8e8e8; background:#1f1f1f; }
      .search { background:#2b2b2b; border-color:#555; color:#e8e8e8; }
      .list { border-color:#444; }
      .hdr { background:#333; color:#bbb; }
      .row { border-bottom-color:#3a3a3a; }
      .row:hover, .row.cursor { background:#3a4654; }
      .row.active { background:#334a63; }
      .row .sub { color:#a0a0a0; }
      .ico:hover { background:#44566b; }
      .ico.on:hover { background:#5a3f3a; }
      .grip { color:#5a5a5a; }
      .badge { background:#334a63; color:#cfe3f7; }
      .modal { background:rgba(31,31,31,.98); }
      .modal h3 span, .field .hint { color:#a0a0a0; }
      .field label { color:#c9c9c9; }
      .field input, .field select { background:#2b2b2b; border-color:#555; color:#e8e8e8; }
      .btn { background:#2b2b2b; border-color:#555; color:#e8e8e8; }
      .btn.primary { background:#0572ce; border-color:#0572ce; color:#fff; }
    }`;

  // Subsequence ("fuzzy") match — "apdev1" matches "ap01.dev.us-ashburn-1". Returns the
  // matched character positions so they can be bolded, or null when it does not match.
  function fuzzy(hay, needle) {
    if (!needle) return [];
    const h = hay.toLowerCase(), n = needle.toLowerCase().replace(/\s+/g, '');
    const hits = [];
    let i = 0;
    for (const ch of n) {
      const at = h.indexOf(ch, i);
      if (at < 0) return null;
      hits.push(at); i = at + 1;
    }
    return hits;
  }
  const mark = (text, hits) => {
    if (!hits || !hits.length) return escapeHtml(text);
    let out = '', prev = 0;
    for (const i of hits) { out += escapeHtml(text.slice(prev, i)) + '<b>' + escapeHtml(text[i]) + '</b>'; prev = i + 1; }
    return out + escapeHtml(text.slice(prev));
  };
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function buildPanel(menu, ctx) {
    const host = document.createElement('div');
    host.id = ROOT_ID;
    host.style.cssText = 'position:absolute;inset:0;z-index:10;';
    const sr = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    sr.append(style);

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `<input class="search" type="text" placeholder="Search compartments…" spellcheck="false">
      <div class="list"></div>
      <div class="foot"><span class="count"></span><span>oxconnect</span></div>`;
    sr.append(wrap);

    const search = wrap.querySelector('.search');
    const list = wrap.querySelector('.list');
    list.style.maxHeight = state.adv.compartmentPickerMaxHeight + 'px';

    let cursor = 0, rendered = [];

    function render() {
      const q = search.value.trim();
      const pinnedSet = new Set(state.prefs.pinned);
      const scored = [];
      for (const c of ctx.comps) {
        const alias = state.prefs.aliases[c.id] || '';
        // match against the alias first (it is the label the user chose), then the name
        const hitsAlias = alias ? fuzzy(alias, q) : null;
        const hitsName = fuzzy(c.name, q);
        if (q && !hitsAlias && !hitsName) continue;
        scored.push({ c, alias, hitsAlias, hitsName, pinned: pinnedSet.has(c.id) });
      }
      // pinned first (in the user's pin order), then the rest alphabetically
      const order = new Map(state.prefs.pinned.map((id, i) => [id, i]));
      scored.sort((a, b) => (b.pinned - a.pinned)
        || (a.pinned ? order.get(a.c.id) - order.get(b.c.id) : a.c.name.localeCompare(b.c.name)));

      list.innerHTML = '';
      rendered = scored;
      if (!scored.length) { list.innerHTML = '<div class="empty">No compartments match.</div>'; return; }

      let lastPinned = null;
      scored.forEach((it, idx) => {
        if (it.pinned !== lastPinned) {
          const h = document.createElement('div');
          h.className = 'hdr';
          h.textContent = it.pinned ? 'Pinned' : (lastPinned === null ? 'Compartments' : 'All compartments');
          list.append(h);
          lastPinned = it.pinned;
        }
        const sub = it.alias ? it.c.name : ctx.pathOf(it.c);
        const region = (state.prefs.settings[it.c.id] || {}).region || '';
        const row = document.createElement('div');
        row.className = 'row' + (it.pinned ? ' pinned' : '') + (idx === cursor ? ' cursor' : '')
                      + (it.c.id === ctx.activeId ? ' active' : '');
        row.dataset.id = it.c.id;
        // Only pinned rows are draggable — the unpinned section is alphabetical, so there is
        // no order there to rearrange.
        if (it.pinned) row.draggable = true;
        row.innerHTML = `
          ${it.pinned ? '<span class="grip" aria-hidden="true">⠿</span>' : ''}
          <button class="ico pin${it.pinned ? ' on' : ''}" title="${it.pinned ? 'Unpin' : 'Pin to top'}">${it.pinned ? ICON_PIN_ON : ICON_PIN_OFF}</button>
          <div class="txt">
            <div class="name">${it.alias ? mark(it.alias, it.hitsAlias) : mark(it.c.name, it.hitsName)}</div>
            ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
          </div>
          ${region ? `<span class="badge" title="Switches to this region">${escapeHtml(region)}</span>` : ''}
          ${it.pinned ? `<button class="ico alias" title="Rename (alias)">${ICON_ALIAS}</button>
                         <button class="ico gear" title="Compartment settings">${ICON_GEAR}</button>` : ''}`;

        row.addEventListener('click', (e) => {
          if (e.target.closest('.pin')) { e.stopPropagation(); togglePin(it.c.id); return; }
          if (e.target.closest('.alias')) { e.stopPropagation(); editAlias(row, it); return; }
          if (e.target.closest('.gear')) { e.stopPropagation(); openSettings(it); return; }
          choose(it.c);
        });
        if (it.pinned) attachDrag(row);
        list.append(row);
      });
      wrap.querySelector('.count').textContent = `${scored.length} of ${ctx.comps.length}`;
    }

    // ---- drag-to-reorder (pinned rows only) -------------------------------
    // HTML5 DnD inside the shadow root. The drop target is decided by which half of the
    // hovered row the pointer is in, so a pin can be dropped either side of any other.
    let dragId = null;
    function clearDropMarks() {
      for (const r of list.querySelectorAll('.dropbefore, .dropafter')) r.classList.remove('dropbefore', 'dropafter');
    }
    function attachDrag(row) {
      row.addEventListener('dragstart', (e) => {
        dragId = row.dataset.id;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Firefox/Chrome both need *something* set or the drag never starts.
        e.dataTransfer.setData('text/plain', dragId);
      });
      row.addEventListener('dragend', () => { row.classList.remove('dragging'); clearDropMarks(); dragId = null; });
      row.addEventListener('dragover', (e) => {
        if (!dragId || dragId === row.dataset.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        clearDropMarks();
        row.classList.add(after ? 'dropafter' : 'dropbefore');
      });
      row.addEventListener('drop', async (e) => {
        if (!dragId || dragId === row.dataset.id) return;
        e.preventDefault(); e.stopPropagation();
        const after = row.classList.contains('dropafter');
        clearDropMarks();
        const pins = state.prefs.pinned;
        const from = pins.indexOf(dragId);
        if (from < 0) return;
        pins.splice(from, 1);
        let to = pins.indexOf(row.dataset.id);
        if (to < 0) return;
        pins.splice(after ? to + 1 : to, 0, dragId);
        dragId = null;
        await savePrefs(ctx.tenant, state.prefs);
        render();
      });
    }

    // ---- per-compartment settings modal -----------------------------------
    function openSettings(it) {
      const cur = state.prefs.settings[it.c.id] || {};
      const modal = document.createElement('div');
      modal.className = 'modal';
      const opts = ['<option value="">(use the default region)</option>']
        .concat(ctx.regions.map((r) =>
          `<option value="${escapeHtml(r.name)}"${r.name === cur.region ? ' selected' : ''}>${escapeHtml(r.label || r.name)}</option>`))
        .join('');
      modal.innerHTML = `
        <h3>Compartment settings<span>${escapeHtml(it.alias ? `${it.alias} — ${it.c.name}` : it.c.name)}</span></h3>
        <div class="field">
          <label for="ox-alias">Alias</label>
          <input id="ox-alias" type="text" value="${escapeHtml(it.alias || '')}" placeholder="${escapeHtml(it.c.name)}" spellcheck="false">
          <span class="hint">Shown instead of the compartment name, and searchable.</span>
        </div>
        <div class="field">
          <label for="ox-region">Region</label>
          <select id="ox-region">${opts}</select>
          <span class="hint">Selecting this compartment also switches the console to this region.
            Compartments without one switch back to the default.</span>
        </div>
        <div class="btns">
          <button class="btn cancel" type="button">Cancel</button>
          <button class="btn primary save" type="button">Save</button>
        </div>`;
      sr.querySelector('.wrap').append(modal);
      const close = () => { modal.remove(); search.focus(); };
      modal.querySelector('.cancel').addEventListener('click', close);
      modal.querySelector('.save').addEventListener('click', async () => {
        const alias = modal.querySelector('#ox-alias').value.trim();
        const region = modal.querySelector('#ox-region').value;
        if (alias && alias !== it.c.name) state.prefs.aliases[it.c.id] = alias; else delete state.prefs.aliases[it.c.id];
        if (region) state.prefs.settings[it.c.id] = { ...cur, region }; else delete state.prefs.settings[it.c.id];
        await savePrefs(ctx.tenant, state.prefs);
        close(); render();
      });
      modal.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') modal.querySelector('.save').click();
      });
      modal.querySelector('#ox-alias').focus();
    }

    async function togglePin(id) {
      const i = state.prefs.pinned.indexOf(id);
      if (i >= 0) { state.prefs.pinned.splice(i, 1); delete state.prefs.aliases[id]; delete state.prefs.settings[id]; }
      else state.prefs.pinned.unshift(id);
      await savePrefs(ctx.tenant, state.prefs);
      render();
    }

    function editAlias(row, it) {
      const txt = row.querySelector('.txt');
      const input = document.createElement('input');
      input.className = 'aliasEdit';
      input.value = it.alias || it.c.name;
      input.placeholder = 'Alias (empty = clear)';
      txt.replaceWith(input);
      input.focus(); input.select();
      const commit = async (save) => {
        if (save) {
          const v = input.value.trim();
          if (v && v !== it.c.name) state.prefs.aliases[it.c.id] = v; else delete state.prefs.aliases[it.c.id];
          await savePrefs(ctx.tenant, state.prefs);
        }
        render(); search.focus();
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit(true);
        else if (e.key === 'Escape') commit(false);
      });
      input.addEventListener('blur', () => commit(true));
    }

    async function choose(c) {
      search.disabled = true;
      list.innerHTML = '<div class="empty">Switching compartment…</div>';
      const ok = await selectCompartment(menu, c);
      if (!ok) {
        // Give the user the native picker back rather than stranding them.
        list.innerHTML = '<div class="empty">Could not apply that compartment — restoring the standard picker.</div>';
        restoreNative(menu);
        return;
      }
      // Region follows the compartment — but only for a tenancy where the user has actually
      // pinned a region to at least one compartment. Otherwise selecting a compartment would
      // start yanking the region around for people who never asked for the feature.
      const pinnedRegion = (state.prefs.settings[c.id] || {}).region || '';
      const anyRegionPinned = Object.values(state.prefs.settings).some((v) => v && v.region);
      if (!pinnedRegion && !anyRegionPinned) return;
      const target = pinnedRegion || await defaultRegion();
      if (!target) return;
      list.innerHTML = `<div class="empty">Switching region to ${escapeHtml(target)}…</div>`;
      await applyRegion(target, ctx.regions);
    }

    search.addEventListener('input', () => { cursor = 0; render(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        cursor = Math.max(0, Math.min(rendered.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)));
        render();
        list.querySelector('.row.cursor')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (rendered[cursor]) choose(rendered[cursor].c);
      }
    });

    render();
    setTimeout(() => search.focus(), 0);
    return host;
  }

  // ---- hijack / restore ----------------------------------------------------

  // The native picker is COVERED, not moved and not hidden.
  //
  // Both obvious alternatives break selection: `display:none` stops it laying out, and
  // moving it into an off-screen container makes its tree render zero rows (measured — the
  // list is viewport-driven, so nothing off-screen ever materialises, and then there is no
  // row to click). Leaving it in flow and painting our panel over it keeps every row
  // rendering exactly as if the user were looking at it.
  function coverNative(menu) {
    menu.dataset.oxconnectPos = menu.style.position || '';
    if (getComputedStyle(menu).position === 'static') menu.style.position = 'relative';
    menu.style.minWidth = state.adv.compartmentPickerWidth + 'px';
    menu.style.minHeight = (state.adv.compartmentPickerMaxHeight + 90) + 'px';
  }
  function restoreNative(menu) {
    menu.querySelector('#' + ROOT_ID)?.remove();
    menu.style.position = menu.dataset.oxconnectPos || '';
    menu.style.minWidth = '';
    menu.style.minHeight = '';
    delete menu.dataset.oxconnectPos;
  }

  function activeCompartmentName() {
    const chip = document.querySelector('.oj-oci-compartment-filter-control .oj-oci-filter-chip');
    const m = /filter with (.+) value/.exec(chip?.getAttribute('aria-label') || '');
    return m ? m[1] : null;
  }

  async function hijack(menu) {
    if (menu.querySelector('#' + ROOT_ID)) return;             // already ours
    if (!menu.querySelector(COMPARTMENT_MARKER)) return;       // some other filter menu — leave it alone

    const activeName = activeCompartmentName();
    const cached = await loadFromCache(activeName);
    const comps = cached?.comps?.length ? cached.comps : loadFromDom(menu);
    if (!comps.length) return;                                 // nothing to show — keep the native picker
    state.tenant = cached?.tenant || 'default';
    state.prefs = await loadPrefs(state.tenant);

    const byId = new Map(comps.map((c) => [c.id, c]));
    const ctx = {
      comps, tenant: state.tenant,
      regions: cached?.regions?.length ? cached.regions : [],
      pathOf: (c) => pathOf(c, byId),
      activeId: comps.find((c) => c.name === activeName)?.id || null,
    };

    coverNative(menu);
    menu.append(buildPanel(menu, ctx));
  }

  // ---- boot ----------------------------------------------------------------

  (async () => {
    const { advSettings } = await chrome.storage.local.get('advSettings');
    state.adv = advMerge(advSettings);
    if (!state.adv.customCompartmentPicker) return;

    // The menu is created and destroyed on every open/close, in a floating layer that is
    // itself added late — so observe the whole document and re-hijack each time it appears
    // (preact also re-renders the container, which can drop our node).
    const scan = () => {
      for (const menu of document.querySelectorAll(MENU)) hijack(menu);
    };
    new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
    scan();
  })();
})();

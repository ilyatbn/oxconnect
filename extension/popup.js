// oxconnect popup: manage accounts (add / refresh / remove), switch, and settings.
// Accounts + settings live in chrome.storage.local. Starts empty.

const $ = (sel) => document.querySelector(sel);
const status = (msg) => { $('#status').textContent = msg || ''; };
const setStatus = (msg) => { $('#settingsStatus').textContent = msg || ''; };
const addStatus = (msg) => { $('#addStatus').textContent = msg || ''; };
const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

// ---- views ------------------------------------------------------------------
const VIEWS = ['#mainView', '#settingsView', '#addView', '#searchView', '#aliasView', '#advView'];
function showView(sel) {
  for (const v of VIEWS) $(v).hidden = v !== sel;
  if (sel === '#addView') $('#newTenant').focus();
  if (sel === '#searchView') $('#svcQuery').focus();
  if (sel === '#aliasView') $('#aliasKey').focus();
}

// ---- OCI commercial (OC1) regions, grouped ---------------------------------
const DEFAULT_REGION = 'us-ashburn-1';
const OCI_REGIONS = [
  ['Americas', [
    ['us-ashburn-1', 'US East (Ashburn)'], ['us-phoenix-1', 'US West (Phoenix)'],
    ['us-sanjose-1', 'US West (San Jose)'], ['us-chicago-1', 'US Midwest (Chicago)'],
    ['ca-toronto-1', 'Canada Southeast (Toronto)'], ['ca-montreal-1', 'Canada Southeast (Montreal)'],
    ['sa-saopaulo-1', 'Brazil East (Sao Paulo)'], ['sa-vinhedo-1', 'Brazil Southeast (Vinhedo)'],
    ['sa-santiago-1', 'Chile Central (Santiago)'], ['sa-valparaiso-1', 'Chile West (Valparaiso)'],
    ['sa-bogota-1', 'Colombia Central (Bogota)'],
    ['mx-queretaro-1', 'Mexico Central (Queretaro)'], ['mx-monterrey-1', 'Mexico Northeast (Monterrey)'],
  ]],
  ['Europe', [
    ['uk-london-1', 'UK South (London)'], ['uk-cardiff-1', 'UK West (Newport)'],
    ['eu-frankfurt-1', 'Germany Central (Frankfurt)'], ['eu-amsterdam-1', 'Netherlands NW (Amsterdam)'],
    ['eu-zurich-1', 'Switzerland North (Zurich)'], ['eu-madrid-1', 'Spain Central (Madrid)'],
    ['eu-paris-1', 'France Central (Paris)'], ['eu-marseille-1', 'France South (Marseille)'],
    ['eu-milan-1', 'Italy NW (Milan)'], ['eu-stockholm-1', 'Sweden Central (Stockholm)'],
    ['eu-jovanovac-1', 'Serbia Central (Jovanovac)'],
  ]],
  ['Middle East & Africa', [
    ['me-jeddah-1', 'Saudi Arabia West (Jeddah)'], ['me-dubai-1', 'UAE East (Dubai)'],
    ['me-abudhabi-1', 'UAE Central (Abu Dhabi)'], ['il-jerusalem-1', 'Israel Central (Jerusalem)'],
    ['af-johannesburg-1', 'South Africa Central (Johannesburg)'],
  ]],
  ['Asia Pacific', [
    ['ap-tokyo-1', 'Japan East (Tokyo)'], ['ap-osaka-1', 'Japan Central (Osaka)'],
    ['ap-seoul-1', 'South Korea Central (Seoul)'], ['ap-chuncheon-1', 'South Korea North (Chuncheon)'],
    ['ap-mumbai-1', 'India West (Mumbai)'], ['ap-hyderabad-1', 'India South (Hyderabad)'],
    ['ap-singapore-1', 'Singapore (Singapore)'], ['ap-singapore-2', 'Singapore West (Singapore)'],
    ['ap-sydney-1', 'Australia East (Sydney)'], ['ap-melbourne-1', 'Australia Southeast (Melbourne)'],
  ]],
];

function populateRegions(selected) {
  const sel = $('#optRegion');
  sel.innerHTML = '';
  for (const [group, regions] of OCI_REGIONS) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const [value, label] of regions) {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = `${label} — ${value}`;
      if (value === selected) opt.selected = true;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
}

// ---- settings -------------------------------------------------------------
async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return {
    autoClickSso: settings.autoClickSso !== false,
    openInNewTab: !!settings.openInNewTab,
    keepAlive: !!settings.keepAlive,
    discoveryRegion: settings.discoveryRegion || DEFAULT_REGION,
    sessionMaxAgeMin: settings.sessionMaxAgeMin === undefined ? 360 : settings.sessionMaxAgeMin,
    serviceSearch: !!settings.serviceSearch,
  };
}
async function saveSetting(key, val) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings[key] = val;
  await chrome.storage.local.set({ settings });
}

// ---- account list ---------------------------------------------------------
function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function inFuture(ts) {
  if (!ts) return '';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function render() {
  const { tenants = [], activeTarget, keepAliveState = {}, settings = {}, serviceCatalog = null } =
    await chrome.storage.local.get(['tenants', 'activeTarget', 'keepAliveState', 'settings', 'serviceCatalog']);
  const kaFailed = keepAliveState.status === 'failed';
  const searchReady = !!settings.serviceSearch && !!(serviceCatalog && serviceCatalog.items && serviceCatalog.items.length);
  searchAvailable = searchReady; // enables type-to-search from the accounts view
  const list = $('#list');
  list.innerHTML = '';

  if (!tenants.length) {
    list.innerHTML = '<div class="empty">No accounts yet. Add one below — enter the OCI account (tenancy) name and the extension will look up its identity domains.</div>';
    return;
  }

  for (const t of tenants) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('div');
    title.className = 'title';
    title.innerHTML = `${escapeHtml(t.label || t.tenantName)}` +
      (t.label && t.label !== t.tenantName ? `<small>${escapeHtml(t.tenantName)}</small>` : '');
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'iconbtn'; refreshBtn.textContent = '↻'; refreshBtn.title = 'Refresh identity domains';
    refreshBtn.addEventListener('click', () => doRefresh(t));
    const removeBtn = document.createElement('button');
    removeBtn.className = 'iconbtn'; removeBtn.textContent = '✕'; removeBtn.title = 'Remove account';
    removeBtn.addEventListener('click', () => doRemove(t));
    head.append(title, refreshBtn, removeBtn);
    card.appendChild(head);

    for (const d of t.domains || []) {
      const isActive = activeTarget === `${t.tenantName}|${d.domainName || ''}`;
      const warn = isActive && kaFailed;
      const btn = document.createElement('button');
      btn.className = 'switch' + (warn ? ' warn' : isActive ? ' active' : '');
      const badgeCls = warn ? ' warn' : isActive ? ' live' : '';
      const badgeSuffix = warn ? ' • keep-alive failed' : isActive ? ' • live' : '';
      const left = document.createElement('span');
      left.innerHTML = `${escapeHtml(t.tenantName)}<span class="badge${badgeCls}">${escapeHtml(d.domainName)}${badgeSuffix}</span>`;
      const right = document.createElement('span');
      right.className = 'meta';
      right.style.cssText = 'display:flex;align-items:center;gap:6px';
      if (isActive && searchReady) {
        const find = document.createElement('span');
        find.className = 'findbtn';
        find.textContent = '🔍';
        find.title = 'Find a service in this tenant';
        find.setAttribute('role', 'button');
        find.addEventListener('click', (e) => { e.stopPropagation(); openSearchView(''); });
        right.appendChild(find);
      }
      const reg = document.createElement('span');
      reg.textContent = d.domainHomeRegion || '';
      right.appendChild(reg);
      btn.append(left, right);
      btn.title = warn ? 'Keep-alive failed — session may be stale; click to re-switch' : isActive ? 'Active — opens the console directly' : (d.domainUrl || '');
      btn.addEventListener('click', () => doSwitch(t, d));
      card.appendChild(btn);
    }

    const stamp = document.createElement('div');
    stamp.className = 'stamp';
    stamp.textContent = `${(t.domains || []).length} domain(s) · refreshed ${ago(t.lastRefreshed)}`;
    card.appendChild(stamp);

    list.appendChild(card);
  }
}

// ---- actions --------------------------------------------------------------
async function doSwitch(tenant, domain) {
  const { openInNewTab } = await loadSettings();
  status(openInNewTab ? 'Opening…' : 'Switching…');
  const target = { tenantName: tenant.tenantName, label: tenant.label, ...domain };
  const r = await send({ type: 'switch', target, openInNewTab });
  if (r?.ok) {
    status(r.result.bypassed ? 'Already active — opening console…'
      : r.result.expired ? `Session aged out — re-authenticating (${r.result.cookiesRemoved} cookies cleared)…`
      : `Switched (${r.result.cookiesRemoved} cookies cleared). Completing SSO…`);
    window.close();
  } else status('Error: ' + (r?.error || 'unknown'));
}

async function doAdd() {
  const tenantName = $('#newTenant').value.trim();
  const label = $('#newLabel').value.trim();
  if (!tenantName) { addStatus('Enter an account name.'); return; }
  addStatus('Looking up identity domains for ' + tenantName + '…');
  const r = await send({ type: 'addTenant', tenantName, label });
  if (r?.ok) {
    $('#newTenant').value = ''; $('#newLabel').value = ''; addStatus('');
    showView('#mainView');
    status(`Added ${tenantName} (${r.tenant.domains.length} domain(s)).`);
    render();
  } else addStatus('Could not add ' + tenantName + ': ' + (r?.error || 'unknown'));
}

async function doRefresh(tenant) {
  status('Refreshing ' + tenant.tenantName + '…');
  const r = await send({ type: 'refreshTenant', tenantName: tenant.tenantName });
  if (r?.ok) { status(`Refreshed ${tenant.tenantName} (${r.tenant.domains.length} domain(s)).`); render(); }
  else status('Refresh failed: ' + (r?.error || 'unknown'));
}

async function doRemove(tenant) {
  const r = await send({ type: 'removeTenant', tenantName: tenant.tenantName });
  if (r?.ok) { status(`Removed ${tenant.tenantName}.`); render(); }
  else status('Remove failed: ' + (r?.error || 'unknown'));
}

// ---- keep-alive readout (settings) ----------------------------------------
async function renderKeepAlive() {
  const { keepAliveState: s = {} } = await chrome.storage.local.get('keepAliveState');
  const enabled = $('#optKeepAlive').checked;
  $('#kaCheck').hidden = !enabled;
  const out = $('#kaStatus');
  const cookies = $('#kaCookies');
  cookies.textContent = '';

  if (!enabled) { out.textContent = 'Off.'; return; }
  if (!s.lastRun) { out.textContent = 'On · waiting for first check…'; return; }

  if (s.status === 'ok') {
    out.innerHTML = `<span class="ok">✓ ok</span> · ${ago(s.lastRun)} · ${(s.changed || []).length} cookie(s) refreshed`;
    if ((s.changed || []).length) {
      const names = [...new Set(s.changed.map((c) => c.name))];
      cookies.textContent = 'refreshed: ' + names.slice(0, 12).join(', ') + (names.length > 12 ? ` +${names.length - 12} more` : '');
    }
  } else if (s.status === 'failed') {
    out.innerHTML = `<span class="fail">✗ failed</span> · ${ago(s.lastRun)} · ${escapeHtml(s.error || '')}` +
      (s.nextFetchRetry ? ` · retry in ${inFuture(s.nextFetchRetry)} (attempt ${s.failCount})` : '');
  } else {
    out.textContent = `${ago(s.lastRun)} · ${s.note || 'idle'}`;
  }
}

// ---- service search -------------------------------------------------------
// Built-in aliases (always available). Each maps a shortcut -> a search phrase that
// the fuzzy index resolves to a catalog entry. Users add more in the alias menu.
const DEFAULT_ALIASES = {
  id: 'Identity Domains',
  iam: 'Identity Domains',
  lambda: 'Functions Applications',
  fn: 'Functions Applications',
  vm: 'Instances Compute',
  instance: 'Instances Compute',
  vcn: 'Virtual Cloud Networks Networking',
  bucket: 'Buckets Object Storage',
  oke: 'Kubernetes Clusters',
  k8s: 'Kubernetes Clusters',
  alb: 'Load Balancers',
  vpc: 'Virtual Cloud Networks Networking',
  ec2: 'Instances Compute',
  s3: 'Object Storage Buckets',
  redis: 'OCI Cache Clusters',
  rds: 'PostgreSQL DB Systems',
};

let fuse = null;          // Fuse index over the catalog
let searchAvailable = false; // service search enabled AND a catalog is present (set in render)
let catalogItems = [];    // [{name, group, path}]
let catalogRegion = '';   // region to template into links at click time
let catalogBuiltAt = 0;

// Advanced (tunable) config — defaults from adv_settings.js, overridden by storage.
let advCfg = (typeof ADV_DEFAULTS !== 'undefined') ? { ...ADV_DEFAULTS } : {};
async function refreshAdvCfg() {
  const { advSettings = {} } = await chrome.storage.local.get('advSettings');
  advCfg = advMerge(advSettings);
  return advCfg;
}

// Token search (per fusejs.io/token-search): each token must match (fuzzily) in name
// OR group. So "identity domains" matches name="Domains" + group="Identity".
// Fuzzy weights/threshold come from adv_settings.js.
function buildFuse(items) {
  return new Fuse(items, {
    keys: [{ name: 'name', weight: advCfg.fuseNameWeight }, { name: 'group', weight: advCfg.fuseGroupWeight }],
    threshold: advCfg.fuseThreshold,
    ignoreLocation: true,
    includeScore: true,
    minMatchCharLength: advCfg.fuseMinMatchCharLength,
    useExtendedSearch: true,
  });
}
function tokenSearch(q) {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !fuse) return [];
  const query = { $and: tokens.map((t) => ({ $or: [{ name: t }, { group: t }] })) };
  return fuse.search(query).map((r) => r.item);
}

async function getAliasMap() {
  const { searchAliases = [] } = await chrome.storage.local.get('searchAliases');
  const map = { ...DEFAULT_ALIASES };
  for (const a of searchAliases) if (a && a.alias) map[a.alias.toLowerCase()] = a.phrase;
  return map;
}

// Show the search view. `seed`: undefined = keep current query; a string = set it
// (e.g. '' from the 🔍 icon, or the first char for type-to-search). The view is shown
// and the input focused SYNCHRONOUSLY (before any await) so keystrokes aren't lost
// while the catalog loads.
async function openSearchView(seed) {
  const q = $('#svcQuery');
  if (seed !== undefined) q.value = seed;
  $('#svcResults').innerHTML = '';
  $('#svcStatus').textContent = '';
  showView('#searchView');
  q.focus();
  const r = await send({ type: 'getCatalog' });
  if (!r?.ok || !r.catalog || !(r.catalog.items || []).length) {
    $('#svcFootInfo').textContent = '';
    $('#svcStatus').textContent = 'No catalog yet — open Settings and rebuild.';
    return;
  }
  catalogItems = r.catalog.items;
  catalogRegion = r.region || r.catalog.region || '';
  catalogBuiltAt = r.catalog.builtAt || 0;
  await refreshAdvCfg();
  fuse = buildFuse(catalogItems);
  $('#svcFootInfo').textContent = `${catalogItems.length} services · built ${ago(catalogBuiltAt)}`;
  await runServiceSearch(q.value); // reflect whatever the user has typed by now
}

async function runServiceSearch(q) {
  const results = $('#svcResults');
  results.innerHTML = '';
  q = (q || '').trim();
  if (!q) { results.innerHTML = '<div class="svchint">Type to search by service or group name. Try an alias like “id”.</div>'; return; }

  const aliasMap = await getAliasMap();
  const aliasPhrase = aliasMap[q.toLowerCase()];
  const pinned = [];
  const seen = new Set();
  const key = (it) => it.name + '|' + it.group + '|' + it.path;

  if (aliasPhrase) {
    for (const it of tokenSearch(aliasPhrase).slice(0, advCfg.aliasPinLimit)) { if (!seen.has(key(it))) { seen.add(key(it)); pinned.push(it); } }
  }
  const rest = tokenSearch(q).filter((it) => !seen.has(key(it)));

  if (!pinned.length && !rest.length) { results.innerHTML = '<div class="svchint">No matches.</div>'; return; }
  for (const it of pinned) results.appendChild(svcRow(it, true));
  for (const it of rest.slice(0, advCfg.searchResultLimit)) results.appendChild(svcRow(it, false));
}

function svcRow(it, isAlias) {
  const row = document.createElement('div');
  row.className = 'svcrow' + (isAlias ? ' alias' : '');
  const left = document.createElement('span');
  left.innerHTML = `<span class="nm">${escapeHtml(it.name)}</span>` + (isAlias ? '<span class="pin">alias</span>' : '');
  const grp = document.createElement('span');
  grp.className = 'grp';
  grp.textContent = it.group || '';
  row.append(left, grp);
  row.title = it.path;
  row.addEventListener('click', () => openService(it));
  return row;
}

async function openService(it) {
  const region = catalogRegion || DEFAULT_REGION;
  const sep = it.path.includes('?') ? '&' : '?';
  const url = `https://cloud.oracle.com${it.path}${sep}region=${encodeURIComponent(region)}`;
  const { openInNewTab } = await loadSettings();
  await send({ type: 'openService', url, openInNewTab });
  window.close();
}

// ---- alias management view ----
async function renderAliasView() {
  const { searchAliases = [] } = await chrome.storage.local.get('searchAliases');
  const list = $('#aliasList');
  list.innerHTML = '';
  if (!searchAliases.length) list.innerHTML = '<div class="svchint">No custom aliases yet.</div>';
  searchAliases.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'aliasrow';
    const k = document.createElement('input'); k.value = a.alias; k.disabled = true;
    const arrow = document.createElement('span'); arrow.className = 'arrow'; arrow.textContent = '→';
    const p = document.createElement('input'); p.value = a.phrase; p.disabled = true;
    const del = document.createElement('button'); del.className = 'iconbtn'; del.textContent = '✕'; del.title = 'Remove';
    del.addEventListener('click', async () => {
      const cur = (await chrome.storage.local.get('searchAliases')).searchAliases || [];
      cur.splice(i, 1);
      await chrome.storage.local.set({ searchAliases: cur });
      renderAliasView();
    });
    row.append(k, arrow, p, del);
    list.appendChild(row);
  });
  const defs = $('#aliasDefaults');
  defs.innerHTML = '';
  for (const [alias, phrase] of Object.entries(DEFAULT_ALIASES)) {
    const d = document.createElement('div');
    d.className = 'aliasdefault';
    d.innerHTML = `<span>${escapeHtml(alias)}</span><span>${escapeHtml(phrase)}</span>`;
    defs.appendChild(d);
  }
}
async function addAlias() {
  const alias = $('#aliasKey').value.trim();
  const phrase = $('#aliasPhrase').value.trim();
  if (!alias || !phrase) { $('#aliasStatus').textContent = 'Enter both an alias and a target.'; return; }
  const cur = (await chrome.storage.local.get('searchAliases')).searchAliases || [];
  const idx = cur.findIndex((a) => a.alias.toLowerCase() === alias.toLowerCase());
  if (idx >= 0) cur[idx] = { alias, phrase }; else cur.push({ alias, phrase });
  await chrome.storage.local.set({ searchAliases: cur });
  $('#aliasKey').value = ''; $('#aliasPhrase').value = ''; $('#aliasStatus').textContent = '';
  renderAliasView();
}

// ---- service-search enable (settings) + consent modal ----
function showConsent(show) { $('#searchConsent').hidden = !show; }
function setBusy(on, msg) {
  const b = $('#busyBanner');
  if (msg) b.textContent = msg;
  b.hidden = !on;
}
async function rebuildCatalog(statusEl) {
  setBusy(true, '⏳ Building service catalog — a tab will open briefly. Please wait…');
  statusEl.textContent = 'Building catalog… a cloud.oracle.com tab will open briefly.';
  try {
    const r = await send({ type: 'buildCatalog' });
    if (r?.ok) statusEl.textContent = `Catalog built: ${r.count} services.`;
    else statusEl.textContent = 'Build failed: ' + (r?.error || 'unknown');
    return r;
  } finally {
    setBusy(false);
  }
}
async function renderSvcSetting() {
  const enabled = $('#optServiceSearch').checked;
  const el = $('#svcSettingStatus');
  el.innerHTML = '';
  if (!enabled) return;
  const { serviceCatalog } = await chrome.storage.local.get('serviceCatalog');
  const span = document.createElement('span');
  span.textContent = serviceCatalog && serviceCatalog.items?.length
    ? `${serviceCatalog.items.length} services · built ${ago(serviceCatalog.builtAt)} · `
    : 'No catalog yet · ';
  const rb = document.createElement('button'); rb.className = 'linklike'; rb.textContent = 'Rebuild now';
  rb.addEventListener('click', async () => { await rebuildCatalog(el); renderSvcSetting(); render(); });
  el.append(span, rb);
}

// ---- advanced settings editor (driven by adv_settings.js) ----
async function saveAdv(key, value) {
  const { advSettings = {} } = await chrome.storage.local.get('advSettings');
  if (value === undefined) delete advSettings[key]; else advSettings[key] = value;
  await chrome.storage.local.set({ advSettings });
  await refreshAdvCfg();
  $('#advStatus').textContent = 'Saved.';
  await send({ type: 'syncKeepAlive' }); // re-arm the alarm in case period/backoff changed
}
async function resetAdv() {
  await chrome.storage.local.set({ advSettings: {} });
  await refreshAdvCfg();
  $('#advStatus').textContent = 'Reset to defaults.';
  await send({ type: 'syncKeepAlive' });
  renderAdvView();
}
function renderAdvView() {
  chrome.storage.local.get('advSettings').then(({ advSettings = {} }) => {
    const list = $('#advList');
    list.innerHTML = '';
    $('#advStatus').textContent = '';
    let curGroup = '';
    for (const s of ADV_SETTINGS) {
      if (s.group !== curGroup) {
        curGroup = s.group;
        const g = document.createElement('div'); g.className = 'advgroup'; g.textContent = s.group;
        list.appendChild(g);
      }
      const row = document.createElement('div'); row.className = 'advrow';
      const lbl = document.createElement('div'); lbl.className = 'lbl';
      lbl.innerHTML = `${escapeHtml(s.label)}<div class="desc">${escapeHtml(s.desc || '')}</div>`;
      row.appendChild(lbl);
      const overridden = advSettings[s.key] !== undefined && advSettings[s.key] !== null && advSettings[s.key] !== '';
      if (s.type === 'bool') {
        const sw = document.createElement('label'); sw.className = 'sw'; // label so clicking toggles
        const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!advGet(advSettings, s.key);
        const tr = document.createElement('span'); tr.className = 'track';
        sw.append(inp, tr);
        inp.addEventListener('change', () => saveAdv(s.key, inp.checked));
        row.appendChild(sw);
      } else {
        const inp = document.createElement('input'); inp.type = 'number';
        if (s.min !== undefined) inp.min = s.min;
        if (s.max !== undefined) inp.max = s.max;
        if (s.step !== undefined) inp.step = s.step;
        inp.value = advGet(advSettings, s.key);
        inp.placeholder = String(ADV_DEFAULTS[s.key]);
        if (overridden) inp.classList.add('changed');
        inp.addEventListener('change', () => {
          const raw = inp.value.trim();
          if (raw === '') { saveAdv(s.key, undefined); inp.classList.remove('changed'); inp.value = ADV_DEFAULTS[s.key]; }
          else { const n = Number(raw); if (!Number.isNaN(n)) { saveAdv(s.key, n); inp.classList.add('changed'); } }
        });
        row.appendChild(inp);
      }
      list.appendChild(row);
    }
  });
}

// ---- wiring ---------------------------------------------------------------
$('#add').addEventListener('click', doAdd);
$('#newLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
$('#newTenant').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

// view switching
$('#gear').addEventListener('click', () => { showView('#settingsView'); renderKeepAlive(); renderSvcSetting(); });
$('#back').addEventListener('click', () => showView('#mainView'));
$('#plus').addEventListener('click', () => showView('#addView'));
$('#addBack').addEventListener('click', () => { addStatus(''); showView('#mainView'); });
$('#searchBack').addEventListener('click', () => showView('#mainView'));
$('#aliasOpen').addEventListener('click', () => { showView('#aliasView'); renderAliasView(); });
$('#aliasBack').addEventListener('click', () => showView('#searchView'));
$('#advOpen').addEventListener('click', () => { showView('#advView'); renderAdvView(); });
$('#advBack').addEventListener('click', () => showView('#settingsView'));
$('#advReset').addEventListener('click', resetAdv);

// type-to-search: typing on the accounts view jumps into search, seeding the query
document.addEventListener('keydown', (e) => {
  if (!$('#mainView') || $('#mainView').hidden) return; // only from the accounts view
  if (!searchAvailable) return;                          // search not enabled / no catalog
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length !== 1) return;                        // a single printable char
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea') return;
  e.preventDefault();
  openSearchView(e.key); // shows view + seeds the char synchronously, then loads catalog
});

// search view interactions
$('#svcQuery').addEventListener('input', (e) => runServiceSearch(e.target.value));
$('#svcRebuild').addEventListener('click', async () => { await rebuildCatalog($('#svcStatus')); openSearchView(); });
$('#aliasAdd').addEventListener('click', addAlias);
$('#aliasPhrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') addAlias(); });
$('#aliasKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#aliasPhrase').focus(); });

// service-search enable toggle → consent modal before flipping on
$('#optServiceSearch').addEventListener('change', async (e) => {
  if (e.target.checked) { e.target.checked = false; showConsent(true); } // wait for "I understand"
  else { await saveSetting('serviceSearch', false); renderSvcSetting(); render(); }
});
$('#consentCancel').addEventListener('click', () => showConsent(false));
$('#consentOk').addEventListener('click', async () => {
  showConsent(false);
  $('#optServiceSearch').checked = true;
  await saveSetting('serviceSearch', true);
  renderSvcSetting();
  const { serviceCatalog } = await chrome.storage.local.get('serviceCatalog');
  if (!serviceCatalog) await rebuildCatalog($('#svcSettingStatus'));
  render();
});

// settings toggles
$('#optNewTab').addEventListener('change', (e) => saveSetting('openInNewTab', e.target.checked));
$('#optAutoSso').addEventListener('change', (e) => saveSetting('autoClickSso', e.target.checked));
$('#optRegion').addEventListener('change', (e) => saveSetting('discoveryRegion', e.target.value));
$('#optMaxAge').addEventListener('change', (e) => saveSetting('sessionMaxAgeMin', parseInt(e.target.value, 10)));
$('#optKeepAlive').addEventListener('change', async (e) => {
  await saveSetting('keepAlive', e.target.checked);
  await send({ type: 'syncKeepAlive' }); // start/stop the 1-min alarm (+ immediate check on enable)
  renderKeepAlive();
  render(); // reflect any new keep-alive state on the active button
});
$('#kaCheck').addEventListener('click', async () => {
  $('#kaStatus').textContent = 'Checking…';
  await send({ type: 'runKeepAlive' });
  renderKeepAlive();
  render();
});

$('#clear').addEventListener('click', async () => {
  setStatus('Clearing OCI session…');
  const r = await send({ type: 'clearOnly' });
  setStatus(r?.ok ? `Cleared (${r.result.cookiesRemoved} cookies). Active tenant reset.` : 'Error: ' + (r?.error || 'unknown'));
  render();
});

(async function init() {
  const s = await loadSettings();
  $('#optNewTab').checked = s.openInNewTab;
  $('#optAutoSso').checked = s.autoClickSso;
  $('#optKeepAlive').checked = s.keepAlive;
  $('#optMaxAge').value = String(s.sessionMaxAgeMin);
  $('#optServiceSearch').checked = s.serviceSearch;
  populateRegions(s.discoveryRegion);
  await refreshAdvCfg();
  renderKeepAlive();
  render();
})();

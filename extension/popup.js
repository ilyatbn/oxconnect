// oxconnect popup: manage accounts (add / refresh / remove), switch, and settings.
// Accounts + settings live in chrome.storage.local. Starts empty.

const $ = (sel) => document.querySelector(sel);
const status = (msg) => { $('#status').textContent = msg || ''; };
const setStatus = (msg) => { $('#settingsStatus').textContent = msg || ''; };
const addStatus = (msg) => { $('#addStatus').textContent = msg || ''; };
const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));

// ---- views ------------------------------------------------------------------
const VIEWS = ['#mainView', '#settingsView', '#addView'];
function showView(sel) {
  for (const v of VIEWS) $(v).hidden = v !== sel;
  if (sel === '#addView') $('#newTenant').focus();
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
  const { tenants = [], activeTarget, keepAliveState = {} } = await chrome.storage.local.get(['tenants', 'activeTarget', 'keepAliveState']);
  const kaFailed = keepAliveState.status === 'failed';
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
      right.textContent = d.domainHomeRegion || '';
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

// ---- wiring ---------------------------------------------------------------
$('#add').addEventListener('click', doAdd);
$('#newLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
$('#newTenant').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });

// view switching
$('#gear').addEventListener('click', () => { showView('#settingsView'); renderKeepAlive(); });
$('#back').addEventListener('click', () => showView('#mainView'));
$('#plus').addEventListener('click', () => showView('#addView'));
$('#addBack').addEventListener('click', () => { addStatus(''); showView('#mainView'); });

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
  populateRegions(s.discoveryRegion);
  renderKeepAlive();
  render();
})();

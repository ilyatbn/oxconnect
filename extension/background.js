// oxconnect background service worker.
//
// Core responsibilities:
//   - seed known tenants on install
//   - switch(target): clear the Oracle session (cookies + SPA storage, but NOT
//     the corporate IdP) then open the tenant's IDCS deep-link, which skips both
//     the bounce-back and the domain picker.
//   - addTenant(name): call /v2/domains to auto-discover a tenancy's identity
//     domains.
//
// See ../CLAUDE.md for the full mechanism.

// Tunable timeouts/toggles (and their defaults) live in adv_settings.js — the single
// source of truth shared with the popup. self.ADV_DEFAULTS / advMerge come from there.
importScripts('adv_settings.js');

const DEFAULT_DISCOVERY_REGION = 'us-ashburn-1'; // resolves any tenant's home region itself
const DEFAULT_SESSION_MAX_AGE_MIN = 360; // 6h: re-login when reusing a session older than this (0 = never)

// Merged advanced settings (stored overrides over adv_settings.js defaults).
async function advAll() {
  const { advSettings = {} } = await chrome.storage.local.get('advSettings');
  return advMerge(advSettings);
}

async function discoveryRegion() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings.discoveryRegion || DEFAULT_DISCOVERY_REGION;
}

// How long a switched-in session may be reused (via the last-active bypass) before
// clicking the same account forces a full re-login instead. 0 = never expire.
async function sessionMaxAgeMin() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const v = settings.sessionMaxAgeMin;
  return v === undefined || v === null ? DEFAULT_SESSION_MAX_AGE_MIN : v;
}

// Starts empty — the user adds accounts by name; metadata is fetched from the
// /v2/domains API. No seeded tenants.
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: { autoClickSso: true } });
  await ensureThemeWatcher();
  await resolveAndApplyIcon();
});

// ---- light/dark toolbar icon ---------------------------------------------
const LIGHT_ICONS = { 16: 'icons/oxconnect16.png', 32: 'icons/oxconnect32.png', 48: 'icons/oxconnect48.png', 128: 'icons/oxconnect128.png' };
const DARK_ICONS = { 16: 'icons/oxconnect16_darkmode.png', 32: 'icons/oxconnect32_darkmode.png', 48: 'icons/oxconnect48_darkmode.png', 128: 'icons/oxconnect128_darkmode.png' };

function applyThemeIcon(dark) {
  try { chrome.action.setIcon({ path: dark ? DARK_ICONS : LIGHT_ICONS }); } catch {}
}

// Last scheme reported by the offscreen detector; used when the override is 'auto'.
let lastDetectedDark = false;

// Pick the icon: 'light'/'dark' force a variant, 'auto' (default) follows the OS.
async function resolveAndApplyIcon() {
  let dark = lastDetectedDark;
  try {
    const { advSettings = {} } = await chrome.storage.local.get('advSettings');
    const mode = advSettings.iconTheme;
    if (mode === 'light') dark = false;
    else if (mode === 'dark') dark = true;
  } catch {}
  applyThemeIcon(dark);
}

// Re-pick the icon when the user changes the override in Advanced settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.advSettings) resolveAndApplyIcon();
});

// The service worker can't read matchMedia; an offscreen document does and reports
// the color scheme (now + on change) via a 'colorScheme' message.
async function ensureThemeWatcher() {
  try {
    if (await chrome.offscreen.hasDocument?.()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: [chrome.offscreen.Reason.MATCH_MEDIA],
      justification: 'Detect prefers-color-scheme to pick a light/dark toolbar icon',
    });
  } catch { /* already exists or unsupported — icon stays the manifest default */ }
}

// ---- helpers -------------------------------------------------------------

// Origins whose SPA storage must be wiped so cloud.oracle.com stops pinning the
// old tenant. Includes the target tenant's IDCS origin.
function storageOriginsFor(target) {
  const origins = new Set([
    'https://cloud.oracle.com',
    'https://www.oracle.com',
    'https://login.oci.oraclecloud.com',
  ]);
  if (target?.domainHomeRegion) origins.add(`https://login.${target.domainHomeRegion}.oraclecloud.com`);
  if (target?.domainUrl) { try { origins.add(new URL(target.domainUrl).origin); } catch {} }
  return [...origins];
}

// Delete every Oracle cookie (domain matches /oracle/i). The corporate IdP lives
// on a different domain, so its session survives → SAML re-completes silently.
async function clearOracleCookies() {
  const cookies = await chrome.cookies.getAll({});
  let n = 0;
  for (const c of cookies) {
    if (!/oracle/i.test(c.domain)) continue;
    const host = c.domain.replace(/^\./, '');
    const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
    try { await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }); n++; } catch {}
  }
  return n;
}

async function clearOracleSession(target) {
  const cookiesRemoved = await clearOracleCookies();
  const origins = storageOriginsFor(target);
  await new Promise((resolve) =>
    chrome.browsingData.remove(
      { origins },
      { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
      resolve
    )
  );
  return { cookiesRemoved, origins };
}

// Build the console URL that skips the identity-domain picker WHILE letting the
// server mint a valid `state`. Going straight to the IDCS /oauth2/v1/authorize
// endpoint with a self-generated state instead yields "Invalid Parameter" at the
// regional callback, because that `state` was never registered server-side.
// `?tenant=<name>&domain=<domainName>` is the form that works (verified). The
// param is `domain`, NOT `domain_name`.
function buildConsoleUrl(target) {
  const u = new URL('https://cloud.oracle.com/');
  u.searchParams.set('tenant', target.tenantName);
  if (target.domainName) u.searchParams.set('domain', target.domainName);
  return u.toString();
}

async function openUrl(url, openInNewTab) {
  if (openInNewTab) { await chrome.tabs.create({ url }); return; }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active) await chrome.tabs.update(active.id, { url });
  else await chrome.tabs.create({ url });
}

const targetKey = (target) => `${target.tenantName}|${target.domainName || ''}`;

// target = { tenantName, label, ...domain fields }
async function switchTo(target, openInNewTab) {
  const key = targetKey(target);
  const { activeTarget, activeSince } = await chrome.storage.local.get(['activeTarget', 'activeSince']);
  // The session ages out maxAgeMin after the last full sign-in (activeSince is set
  // on a real switch, preserved across bypasses — so we measure from initial login,
  // not from the last click). Once expired, re-clicking the active account re-logs in.
  const maxAgeMin = await sessionMaxAgeMin();
  const expired = maxAgeMin > 0 && activeSince && Date.now() - activeSince > maxAgeMin * 60 * 1000;
  // If this tenant/domain is already the active one AND the session hasn't aged out,
  // it's still live — skip the clear + re-auth and just open the console.
  if (activeTarget === key && !expired) {
    const url = 'https://cloud.oracle.com/';
    await openUrl(url, openInNewTab);
    return { url, bypassed: true, cookiesRemoved: 0 };
  }
  const cleared = await clearOracleSession(target);
  const url = buildConsoleUrl(target);
  await openUrl(url, openInNewTab);
  await chrome.storage.local.set({ activeTarget: key, activeSince: Date.now() });
  return { url, bypassed: false, expired: !!expired, ...cleared };
}

// Discover identity domains for a tenancy name via the public /v2/domains API.
async function discoverDomains(tenantName) {
  const region = await discoveryRegion();
  const api = `https://login.${region}.oraclecloud.com/v2/domains?tenant=${encodeURIComponent(tenantName)}`;
  const res = await fetch(api, { credentials: 'omit' });
  if (!res.ok) throw new Error(`/v2/domains returned ${res.status} (region ${region})`);
  const list = await res.json();
  // An empty list usually means the tenancy has no presence in this region — not
  // that it doesn't exist. Suggest trying a different Discovery region.
  if (!Array.isArray(list) || !list.length) {
    throw new Error(`no domains found in ${region} — check the account name, or pick a different Discovery region in Settings`);
  }
  return list.map((d) => ({
    domainName: d.domainName,
    domainType: d.domainType,
    domainHomeRegion: d.domainHomeRegion,
    domainRegion: d.domainRegion,
    domainUrl: d.domainUrl,
    domainOcid: d.domainOcid,
  }));
}

// Add or refresh a tenant: fetch its identity-domain metadata and upsert it into
// storage (keyed by tenantName). Used for both "Add" and per-account "Refresh".
// `label` is optional; on refresh, omit it to keep the existing one.
async function upsertTenant(tenantName, label) {
  tenantName = (tenantName || '').trim();
  if (!tenantName) throw new Error('account name required');
  const domains = await discoverDomains(tenantName);
  const { tenants = [] } = await chrome.storage.local.get('tenants');
  const idx = tenants.findIndex((t) => t.tenantName === tenantName);
  const existing = idx >= 0 ? tenants[idx] : null;
  const entry = {
    tenantName,
    label: (label && label.trim()) || existing?.label || tenantName,
    domains,
    lastRefreshed: Date.now(),
  };
  if (idx >= 0) tenants[idx] = entry; else tenants.push(entry);
  await chrome.storage.local.set({ tenants });
  return entry;
}

async function removeTenant(tenantName) {
  const { tenants = [], activeTarget } = await chrome.storage.local.get(['tenants', 'activeTarget']);
  await chrome.storage.local.set({ tenants: tenants.filter((t) => t.tenantName !== tenantName) });
  if (activeTarget && activeTarget.startsWith(tenantName + '|')) await chrome.storage.local.remove(['activeTarget', 'activeSince']);
  return true;
}

// Clear the OCI session AND forget the active target, so the next switch does a
// full clear + re-auth rather than bypassing.
async function clearSession() {
  const result = await clearOracleSession(null);
  await chrome.storage.local.remove(['activeTarget', 'activeSince']);
  return result;
}

// Resolve the active tenant/domain into { tenantName, domainName, region, key },
// using the domain's home region (falling back to the discovery region).
async function resolveActiveProfile() {
  const { activeTarget, tenants = [] } = await chrome.storage.local.get(['activeTarget', 'tenants']);
  if (!activeTarget) return null;
  const [tenantName, domainName = ''] = activeTarget.split('|');
  const t = tenants.find((x) => x.tenantName === tenantName);
  const d = t?.domains?.find((x) => (x.domainName || '') === domainName);
  const region = d?.domainHomeRegion || (await discoveryRegion());
  return { tenantName, domainName, region, key: activeTarget };
}

chrome.runtime.onStartup.addListener(() => { ensureThemeWatcher(); resolveAndApplyIcon(); });

// ===========================================================================
// Service catalog (for the optional in-popup service search).
//
// The complete, labeled+grouped list of OCI console destinations only exists in
// the AUTHENTICATED console: https://cloud.oracle.com/search/services renders it
// client-side (no API) inside a same-origin iframe (name=sandbox-maui-preact-
// container), paginated 50/page. There is no static JSON with display names, so
// we build the catalog by opening that page in a tab and scraping the rendered
// rows across all pages. Requires an active, signed-in tenant.
// ===========================================================================

// Quick "are we signed in?" check: a 2xx from my-profile that stayed on cloud.oracle.com.
async function consoleSessionLive(region) {
  try {
    const res = await fetch(`https://cloud.oracle.com/identity/domains/my-profile?region=${encodeURIComponent(region)}`,
      { credentials: 'include', redirect: 'follow', cache: 'no-store' });
    return res.ok && /^https:\/\/cloud\.oracle\.com\//.test(res.url);
  } catch { return false; }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const check = () => chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return resolve(false);
      if (tab.status === 'complete') return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(check, 500);
    });
    check();
  });
}

// Injected into the build tab's top frame: a red "please wait" bar so the user knows
// the briefly-opened cloud.oracle.com tab is ours and will close itself.
function showBuildBanner() {
  try {
    const id = 'oxconnect-build-banner';
    if (document.getElementById(id)) return;
    const bar = document.createElement('div');
    bar.id = id;
    bar.textContent = '⏳ oxconnect is building the service catalog — please wait. This tab will close automatically.';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#c74634;color:#fff;' +
      'font:600 13px/1.4 -apple-system,system-ui,sans-serif;text-align:center;padding:9px 12px;box-shadow:0 2px 8px #0005;';
    (document.documentElement || document.body).appendChild(bar);
  } catch {}
}

// Injected into every frame of the services page. Only the services iframe has the
// table; other frames bail out with null. Waits for render, then pages through the
// whole list clicking the "Next" button, returning [{name, group, path}].
// Self-contained (runs in the page; no outer-scope refs). All timeouts/toggles come in
// via `opts` (sourced from adv_settings.js) so there are no magic numbers here.
async function scrapeServicesPaged(opts) {
  opts = opts || {};
  const tick = opts.tickMs || 250;
  const readyIters = Math.ceil((opts.readyTimeoutMs || 8000) / tick);
  const advanceIters = Math.ceil((opts.pageAdvanceTimeoutMs || 3500) / tick);
  const maxPages = opts.maxPages || 40;
  const maximizeItemsPerPage = opts.maximizeItemsPerPage !== false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const isServiceLink = (a) => {
    const h = a.href || '';
    return /^https:\/\/cloud\.oracle\.com\//.test(h) && !/cloud\.oracle\.com\/search\//.test(h) && norm(a.innerText);
  };
  // Wait for THIS frame to become the rendered services table.
  let ready = false;
  for (let i = 0; i < readyIters; i++) {
    const hasPager = !!document.querySelector('button[aria-label="Next"]') || /total items/i.test(document.body.innerText);
    if (hasPager && [...document.querySelectorAll('a[href]')].some(isServiceLink)) { ready = true; break; }
    await sleep(tick);
  }
  if (!ready) return null; // not the services frame

  const pageInd = () => { const m = document.body.innerText.match(/Page\s+(\d+)\s+of\s+(\d+)/i); return m ? m[0] : ''; };

  // Best-effort: bump "Items per page" to its largest option so there are fewer pages.
  // The widget is a custom combobox that ignores el.click() — it needs a full pointer
  // event sequence to open. Falls back to the default page size on any failure.
  const fireClick = (el) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const E = t.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new E(t, { bubbles: true, cancelable: true, view: window }));
    }
  };
  if (maximizeItemsPerPage) try {
    const ipp = document.querySelector('input[aria-label="Items per page"]');
    if (ipp) {
      const before = pageInd();
      ipp.focus(); fireClick(ipp);
      await sleep(tick);
      const opts2 = [...document.querySelectorAll('[role="option"]')];
      let best = null, bestN = 0;
      for (const o of opts2) { const n = parseInt(((o.innerText || '').match(/\d+/) || [0])[0], 10); if (n > bestN) { bestN = n; best = o; } }
      if (best) { fireClick(best); for (let w = 0; w < advanceIters && pageInd() === before; w++) await sleep(tick); }
    }
  } catch { /* fall back to default page size */ }
  const scrape = () => [...document.querySelectorAll('a[href]')].filter(isServiceLink).map((a) => {
    const name = norm(a.innerText);
    let row = a, group = '';
    for (let i = 0; i < 7 && row; i++) {
      row = row.parentElement; if (!row) break;
      const t = norm(row.innerText);
      if (t && t !== name && t.startsWith(name) && t.length > name.length) { group = norm(t.slice(name.length)); break; }
    }
    const u = new URL(a.href);
    return { name, group, path: u.pathname + u.search };
  });

  const all = []; const seen = new Set();
  for (let p = 0; p < maxPages; p++) {
    for (const r of scrape()) { const k = r.name + '|' + r.group + '|' + r.path; if (!seen.has(k)) { seen.add(k); all.push(r); } }
    const before = pageInd();
    const next = [...document.querySelectorAll('button[aria-label="Next"]')].find((b) => !b.disabled);
    if (!next) break;
    next.click();
    let advanced = false;
    for (let w = 0; w < advanceIters; w++) { await sleep(tick); if (pageInd() !== before) { advanced = true; break; } }
    if (!advanced) break; // no progress — stop rather than loop forever
  }
  return all;
}

// Open the services page in a tab, scrape every page, store the catalog. Tab focus,
// timeouts and scraper tunables all come from adv_settings.js. The tab is closed when
// done, restoring the user's previous tab.
async function buildServiceCatalog() {
  const prof = await resolveActiveProfile();
  if (!prof) throw new Error('Switch to a tenant first, then build the catalog.');
  const region = prof.region;
  if (!(await consoleSessionLive(region))) throw new Error('Not signed in — switch to a tenant, then build the catalog.');

  const adv = await advAll();
  const scrapeOpts = {
    tickMs: adv.scrapeTickMs,
    readyTimeoutMs: adv.scrapeReadyTimeoutMs,
    pageAdvanceTimeoutMs: adv.scrapePageAdvanceTimeoutMs,
    maxPages: adv.scrapeMaxPages,
    maximizeItemsPerPage: adv.maximizeItemsPerPage,
  };
  const [prevActive] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = await chrome.tabs.create({ url: `https://cloud.oracle.com/search/services?region=${encodeURIComponent(region)}`, active: !!adv.catalogTabActive });
  try {
    await waitForTabComplete(tab.id, adv.catalogTabLoadTimeoutMs);
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: showBuildBanner }); } catch {}
    let items = null;
    for (let attempt = 0; attempt < adv.catalogInjectAttempts && !(items && items.length); attempt++) {
      let results = [];
      try {
        results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: scrapeServicesPaged, args: [scrapeOpts] });
      } catch (e) { /* frames may still be loading — retry */ }
      for (const r of results) if (r && Array.isArray(r.result) && r.result.length) { items = r.result; break; }
      if (!items) await new Promise((r) => setTimeout(r, adv.catalogInjectRetryMs));
    }
    if (!items || !items.length) {
      throw new Error('Could not read the services list (0 rows). The page layout may have changed.');
    }
    const seen = new Set(); const dedup = [];
    for (const it of items) {
      if (!it.name || !it.path) continue;
      const k = it.name + '|' + it.group + '|' + it.path;
      if (!seen.has(k)) { seen.add(k); dedup.push({ name: it.name, group: it.group || '', path: it.path }); }
    }
    const catalog = { builtAt: Date.now(), region, items: dedup };
    await chrome.storage.local.set({ serviceCatalog: catalog });
    return { count: dedup.length, builtAt: catalog.builtAt, region };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
    if (prevActive?.id) { try { await chrome.tabs.update(prevActive.id, { active: true }); } catch {} }
  }
}

// ---- message router ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'switch') sendResponse({ ok: true, result: await switchTo(msg.target, msg.openInNewTab) });
      else if (msg.type === 'addTenant' || msg.type === 'refreshTenant') sendResponse({ ok: true, tenant: await upsertTenant(msg.tenantName, msg.label) });
      else if (msg.type === 'removeTenant') sendResponse({ ok: true, removed: await removeTenant(msg.tenantName) });
      else if (msg.type === 'discover') sendResponse({ ok: true, domains: await discoverDomains(msg.tenantName) });
      else if (msg.type === 'clearOnly') sendResponse({ ok: true, result: await clearSession() });
      else if (msg.type === 'colorScheme') { lastDetectedDark = !!msg.dark; resolveAndApplyIcon(); sendResponse({ ok: true }); }
      else if (msg.type === 'buildCatalog') sendResponse({ ok: true, ...(await buildServiceCatalog()) });
      else if (msg.type === 'getCatalog') {
        const { serviceCatalog = null } = await chrome.storage.local.get('serviceCatalog');
        const prof = await resolveActiveProfile();
        sendResponse({ ok: true, catalog: serviceCatalog, region: prof?.region || (await discoveryRegion()) });
      }
      else if (msg.type === 'openService') { await openUrl(msg.url, msg.openInNewTab); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, error: 'unknown message type' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

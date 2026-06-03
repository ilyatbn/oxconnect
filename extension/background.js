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

const DEFAULT_DISCOVERY_REGION = 'us-ashburn-1'; // resolves any tenant's home region itself

async function discoveryRegion() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings.discoveryRegion || DEFAULT_DISCOVERY_REGION;
}

// Starts empty — the user adds accounts by name; metadata is fetched from the
// /v2/domains API. No seeded tenants.
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: { autoClickSso: true } });
  await syncKeepAliveAlarm();
});

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
  const { activeTarget } = await chrome.storage.local.get('activeTarget');
  // If this tenant/domain is already the active one, the session is still live —
  // skip the clear + re-auth and just open the console.
  if (activeTarget === key) {
    const url = 'https://cloud.oracle.com/';
    await openUrl(url, openInNewTab);
    return { url, bypassed: true, cookiesRemoved: 0 };
  }
  const cleared = await clearOracleSession(target);
  const url = buildConsoleUrl(target);
  await openUrl(url, openInNewTab);
  await chrome.storage.local.set({ activeTarget: key });
  await resetKeepAlive(); // fresh session — clear any prior stale/backoff state
  return { url, bypassed: false, ...cleared };
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
  if (activeTarget && activeTarget.startsWith(tenantName + '|')) await chrome.storage.local.remove('activeTarget');
  return true;
}

// Clear the OCI session AND forget the active target, so the next switch does a
// full clear + re-auth rather than bypassing.
async function clearSession() {
  const result = await clearOracleSession(null);
  await chrome.storage.local.remove('activeTarget');
  await resetKeepAlive();
  return result;
}

// ===========================================================================
// Keep-Alive: on a 1-min alarm, ping the console's my-profile endpoint for the
// active tenant to keep its session cookies fresh. On failure, back off
// exponentially (gated by `keepAliveState.nextFetchRetry`) and mark the active
// profile as stale (popup turns it yellow).
// ===========================================================================
const KEEPALIVE_ALARM = 'oxconnect-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;
const BACKOFF_BASE_MS = 60 * 1000;       // 1 min
const BACKOFF_MAX_MS = 30 * 60 * 1000;   // cap at 30 min

async function setKeepAliveState(patch) {
  const { keepAliveState = {} } = await chrome.storage.local.get('keepAliveState');
  await chrome.storage.local.set({ keepAliveState: { ...keepAliveState, ...patch } });
}
async function resetKeepAlive() {
  await chrome.storage.local.set({ keepAliveState: { status: 'idle', failCount: 0, nextFetchRetry: null, lastRun: null } });
}

async function syncKeepAliveAlarm() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (settings.keepAlive) await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  else await chrome.alarms.clear(KEEPALIVE_ALARM);
  return !!settings.keepAlive;
}

// Snapshot Oracle cookies as {domain/path|name -> {value, exp}} for diffing.
async function snapshotOracleCookies() {
  const cookies = await chrome.cookies.getAll({});
  const map = {};
  for (const c of cookies) {
    if (!/oracle/i.test(c.domain)) continue;
    map[`${c.domain}${c.path}|${c.name}`] = { value: c.value, exp: c.expirationDate || 0, domain: c.domain, name: c.name };
  }
  return map;
}
function diffCookies(before, after) {
  const changed = [];
  for (const k of Object.keys(after)) {
    const a = after[k], b = before[k];
    if (!b) changed.push({ name: a.name, domain: a.domain, kind: 'added' });
    else if (b.value !== a.value) changed.push({ name: a.name, domain: a.domain, kind: 'value' });
    else if (b.exp !== a.exp) changed.push({ name: a.name, domain: a.domain, kind: 'expiry' });
  }
  for (const k of Object.keys(before)) if (!after[k]) changed.push({ name: before[k].name, domain: before[k].domain, kind: 'removed' });
  return changed;
}

async function resolveActiveProfile() {
  const { activeTarget, tenants = [] } = await chrome.storage.local.get(['activeTarget', 'tenants']);
  if (!activeTarget) return null;
  const [tenantName, domainName = ''] = activeTarget.split('|');
  const t = tenants.find((x) => x.tenantName === tenantName);
  const d = t?.domains?.find((x) => (x.domainName || '') === domainName);
  const region = d?.domainHomeRegion || (await discoveryRegion());
  return { tenantName, domainName, region, key: activeTarget };
}

async function runKeepAlive() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  if (!settings.keepAlive) { await chrome.alarms.clear(KEEPALIVE_ALARM); return; }

  const { keepAliveState = {} } = await chrome.storage.local.get('keepAliveState');
  if (keepAliveState.nextFetchRetry && Date.now() < keepAliveState.nextFetchRetry) return; // backing off

  const prof = await resolveActiveProfile();
  if (!prof) { await setKeepAliveState({ status: 'idle', lastRun: Date.now(), note: 'no active tenant' }); return; }

  const url = `https://cloud.oracle.com/identity/domains/my-profile?region=${encodeURIComponent(prof.region)}`;
  const before = await snapshotOracleCookies();
  let ok = false, httpStatus = 0, error = null, finalUrl = '';
  try {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
    httpStatus = res.status;
    finalUrl = res.url;
    // Success = 2xx and we stayed on cloud.oracle.com (not bounced to a login/SSO host).
    ok = res.ok && /^https:\/\/cloud\.oracle\.com\//.test(res.url);
  } catch (e) { error = e.message; }
  const changed = diffCookies(before, await snapshotOracleCookies());

  if (ok) {
    await setKeepAliveState({
      status: 'ok', ok: true, lastRun: Date.now(), httpStatus, region: prof.region,
      profile: prof.key, changed, failCount: 0, nextFetchRetry: null, error: null,
    });
  } else {
    const failCount = (keepAliveState.failCount || 0) + 1;
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (failCount - 1), BACKOFF_MAX_MS);
    await setKeepAliveState({
      status: 'failed', ok: false, lastRun: Date.now(), httpStatus, region: prof.region,
      profile: prof.key, changed, failCount, nextFetchRetry: Date.now() + backoff,
      error: error || `bad response (http ${httpStatus}${finalUrl && !/cloud\.oracle\.com/.test(finalUrl) ? ', redirected to ' + new URL(finalUrl).host : ''})`,
    });
  }
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === KEEPALIVE_ALARM) runKeepAlive(); });
chrome.runtime.onStartup.addListener(() => { syncKeepAliveAlarm(); });

// ---- message router ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'switch') sendResponse({ ok: true, result: await switchTo(msg.target, msg.openInNewTab) });
      else if (msg.type === 'addTenant' || msg.type === 'refreshTenant') sendResponse({ ok: true, tenant: await upsertTenant(msg.tenantName, msg.label) });
      else if (msg.type === 'removeTenant') sendResponse({ ok: true, removed: await removeTenant(msg.tenantName) });
      else if (msg.type === 'discover') sendResponse({ ok: true, domains: await discoverDomains(msg.tenantName) });
      else if (msg.type === 'clearOnly') sendResponse({ ok: true, result: await clearSession() });
      else if (msg.type === 'syncKeepAlive') { const on = await syncKeepAliveAlarm(); if (on) await runKeepAlive(); sendResponse({ ok: true, enabled: on }); }
      else if (msg.type === 'runKeepAlive') { await runKeepAlive(); const { keepAliveState } = await chrome.storage.local.get('keepAliveState'); sendResponse({ ok: true, state: keepAliveState }); }
      else sendResponse({ ok: false, error: 'unknown message type' });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

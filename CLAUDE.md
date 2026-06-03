# oxconnect

A Chrome extension (Manifest V3) to manage and **one-click switch** between multiple
Oracle Cloud (OCI) tenancies / identity domains. Login is corporate SSO (SAML), so
this is **not** a password autofiller — it's a deterministic tenant launcher that
defeats OCI's single-origin session stickiness.

---

## ⛔ RULE: never put personal/account data in this file (or any committed file)

`CLAUDE.md` is committed and shared. **Never** add account-identifying or secret
data here. Specifically forbidden:

- tenancy / account names (e.g. `acme-oracle-cloud`)
- identity-domain names, IDCS hostnames (`idcs-<hex>...`), domain/tenancy **OCIDs**
- usernames, emails, employer/IdP vendor names
- regions, OCIDs, or any value tied to a *specific* account
- tokens, cookies, `id_token` / `security_token` / `state` values, HAR contents

Use **generic placeholders** instead: `<tenantName>`, `<domainName>`, `idcs-<hex>`,
`<region>`, `ocid1.domain.oc1..<…>`. Real account values live only in the user's
browser (`chrome.storage.local`) and in the **gitignored** `scripts/` folder. If you
catch personal data in a committed file, remove it. This rule is permanent.

---

## TL;DR of how OCI multi-tenant login works

- The whole flow is **client-side JS** (curl sees a 200 with zero redirects).
- `cloud.oracle.com` is **one origin shared by every tenancy**, and it caches the
  active session in **cookies + localStorage/indexedDB**. So opening
  `cloud.oracle.com/?tenant=<other>` bounces you back to whatever tenant you're
  already in. This is the core bug we work around.
- **Each tenancy is its own IDCS identity domain** (`idcs-<hex>.identity.oraclecloud.com`).
  A tenancy can have **multiple** identity domains — when it has >1, OCI shows a
  domain-picker (`/v2/ui/domains`); with exactly 1 it auto-forwards.
- Auth is **SAML-federated** (`amr:[SAML]`, hits IDCS `/fed/v1/sp/sso`). No Oracle
  password is entered; the corporate IdP (a different domain) holds the real session.

Full redirect chain:
```
cloud.oracle.com/?tenant=<tenantName>
  → login.oci.oraclecloud.com/v1/oauth2/authorize         (SPA mints ephemeral RSA keypair + nonce + state)
  → login.<region>.oraclecloud.com/v1/oauth2/authorize    (signed `referer` JWT)
  → login.<region>.oraclecloud.com/v2/ui/domains          (identity-domain PICKER, only if >1 domain)
  → idcs-<hex>.identity.oraclecloud.com/oauth2/v1/authorize
  → idcs-<hex>.identity.oraclecloud.com/ui/v1/signin       (SAML → corporate IdP)
  → login.<region>.oraclecloud.com/v2/storeLoginInfo
  → cloud.oracle.com/#id_token=…&security_token=…          (SPA reads tokens from fragment)
```

---

## The two key endpoints

### 1. Discover a tenancy's identity domains (no auth needed)
```
GET https://login.<anyRegion>.oraclecloud.com/v2/domains?tenant=<tenantName>
```
Returns JSON; one entry per identity domain:
```json
[ { "domainName":"<domainName>", "domainType":"DEFAULT",
    "domainOcid":"ocid1.domain.oc1..<…>",
    "domainHomeRegion":"<region>", "domainRegion":"<region>",
    "domainUrl":"https://idcs-<hex>.identity.oraclecloud.com:443",
    "domainReplicaUrl":null } ]
```
⚠️ The region is **not** fully interchangeable: a region returns a tenancy's domains
only if the tenancy has **presence** there (home region *or* a replica — see
`domainReplicaUrl`). Querying a region with no presence returns `[]` (HTTP 200, empty),
not an error. The extension defaults to `us-ashburn-1` and exposes a **Discovery
region** setting to switch when a tenancy lives elsewhere.

### 2. URL that skips the domain picker AND lets login COMPLETE
```
https://cloud.oracle.com/?tenant=<tenantName>&domain=<domainName>
```
The param is **`domain`** (the identity-domain *name*) — NOT `domain_name` (ignored →
picker still shows). Verified: this lands directly on the tenant's `/ui/v1/signin`
with the picker skipped, and the IDCS `state` is a **server-generated token** so the
SAML round-trip completes normally.

⚠️ **Do NOT** instead jump straight to the IDCS authorize endpoint
(`https://<domainUrl>/oauth2/v1/authorize?...&state=<self-generated>`). That reaches
the signin page, but after the corporate-SSO click the regional callback
(`login.<region>/v2/oauth2/callback`) rejects the self-generated `state` it never
issued → **"Invalid Parameter"**. The `state` must be minted by the server, which
only happens when you start the flow at `cloud.oracle.com`. (single-domain tenants
can omit `&domain=` — they auto-forward.)

---

## The switch recipe (what the extension does)

1. **Clear Oracle session only** (preserve the corporate IdP so SSO stays silent):
   - delete every cookie whose domain matches `/oracle/i` (covers `*.oracle.com`
     and `*.oraclecloud.com`); the corporate IdP lives on a different domain, so it
     survives and SSO re-completes silently.
   - `chrome.browsingData.remove({origins:[…oracle origins…]}, {localStorage, indexedDB, cacheStorage, serviceWorkers})`.
     **Clearing cookies alone is NOT enough** — the SPA's localStorage/indexedDB
     pins the old tenant. You must clear both.
2. Navigate the tab to `https://cloud.oracle.com/?tenant=<tenantName>&domain=<domainName>`
   (server mints a valid `state`; the picker is skipped).
3. SSO completes — **silent** if the corporate IdP session is alive, otherwise the
   IDCS signin page where one SSO click finishes it. Floor is one click, not zero.

**Constraint:** one active tenant per browser profile (single shared origin).
Switching logs out the previous tenant. True parallel sessions require separate
Chrome profiles, which an extension cannot spawn.

---

## Extension features & flows

The extension **starts empty**; everything lives in `chrome.storage.local`.

### Accounts (add / refresh / remove)
- **Add** (`+` button → add view): user enters an account (tenancy) name + optional
  label → `upsertTenant()` calls the `/v2/domains` API (using the configured Discovery
  region) → stores `{ tenantName, label, domains[], lastRefreshed }`. No login needed.
- **↻ Refresh** (per card): re-runs discovery (keeps the existing label) for when a
  tenancy's identity domains change.
- **✕ Remove** (per card): deletes the account (and forgets it if it was active).
- Each account card renders **one switch button per identity domain**.

### Switching + last-active bypass
- Clicking a domain calls `switchTo(target)`:
  - If the target **equals the last-switched** one (`activeTarget`), the session is
    still live → **bypass** the clear/re-auth and just open `https://cloud.oracle.com/`.
  - Otherwise: clear the Oracle session (recipe above) → open the
    `?tenant&domain` console URL → store `activeTarget` → reset keep-alive state.
- Honors the **Open in new tab** setting.
- The active domain button shows green **`• live`**; it turns yellow
  **`• keep-alive failed`** when keep-alive last failed (see below).

### Settings (gear icon → in-popup view, back button to return)
- **Discovery region** — dropdown of OCI commercial regions; default `us-ashburn-1`
  (`settings.discoveryRegion`). Controls which `login.<region>` endpoint discovery hits.
- **Open switches in a new tab** — toggle (`settings.openInNewTab`).
- **Keep-Alive** — toggle (`settings.keepAlive`); see below.
- **Clear OCI session** — clears Oracle cookies + SPA storage, forgets `activeTarget`,
  resets keep-alive. Leaves the corporate IdP session intact.

### Keep-Alive
- When on, a `chrome.alarms` alarm fires every **1 min** (MV3 minimum).
- Each tick (`runKeepAlive`): skip if within a backoff window
  (`keepAliveState.nextFetchRetry`); resolve the **active** tenant + its home region;
  snapshot Oracle cookies → `fetch('https://cloud.oracle.com/identity/domains/my-profile?region=<region>', {credentials:'include'})`
  → snapshot again and **diff** the cookies.
  - **Success** (2xx and stayed on `cloud.oracle.com`): record `ok`, list the refreshed
    cookies, reset fail count / backoff.
  - **Failure** (network error, non-2xx, or redirected to a login host): exponential
    backoff `1→2→4→8→16→30 min` (capped) via `nextFetchRetry`; mark the active profile
    **yellow**.
- State (`keepAliveState`) resets on a fresh switch and on Clear OCI session.
- Settings shows a live readout (status, age, # cookies refreshed + names, next retry)
  and a **Check now** button.

### content.js
- Runs on `idcs-*.identity.oraclecloud.com/ui/v1/signin`. If `settings.autoClickSso`
  (default true) and exactly one obvious federated SSO button is present (and no visible
  password field), it auto-clicks it for true one-click. Selector heuristic
  (`SSO_TEXT`) may need tuning per IdP — it logs candidates to the console (`oxconnect`).

### `chrome.storage.local` keys
| key | shape |
|-----|-------|
| `settings` | `{ autoClickSso, openInNewTab, keepAlive, discoveryRegion }` |
| `tenants` | `[{ tenantName, label, domains:[{domainName,domainType,domainHomeRegion,domainRegion,domainUrl,domainOcid}], lastRefreshed }]` |
| `activeTarget` | `"<tenantName>|<domainName>"` — last successfully switched profile |
| `keepAliveState` | `{ status, ok, lastRun, httpStatus, region, profile, changed[], failCount, nextFetchRetry, error }` |

---

## Extension layout

```
extension/
├─ manifest.json   permissions: cookies, browsingData, storage, tabs, scripting, alarms
│                  host_permissions: cloud.oracle.com, *.oraclecloud.com, *.oracle.com
├─ background.js   service worker: switchTo() (+ last-active bypass), upsertTenant()/
│                  removeTenant() via /v2/domains, clearSession(), keep-alive (alarms)
├─ popup.html/js   3 views (accounts / add / settings); account cards, switch buttons,
│                  ↻ refresh, ✕ remove, keep-alive readout
├─ content.js      optional auto-click of the SAML/SSO button on the IDCS signin page
└─ icons/          oxconnect{16,32,48,128}.png
```
Load via `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.

---

## How to reproduce / extend the investigation

Playwright scripts live in **`scripts/`** (gitignored — they and their logs/profile
hold captured tokens/session **and real account values**). They drive **real Chrome**
(channel `chrome`) and log everything. `npm install` already pulled `playwright@1.60.0`
(resolved from the repo-root `node_modules`, so the scripts run from `scripts/` unchanged).

| Script | Purpose | Output |
|--------|---------|--------|
| `scripts/capture.js`     | Full login capture (HAR + live network log) from `cloud.oracle.com/?tenant=…` | `scripts/capture.log` ⚠️ live tokens |
| `scripts/switch-test.js` | Cold (logged-out) tenant-switch strategies | `scripts/trace.log` |
| `scripts/switch2.js`     | Authenticated switch test (log in, then switch) | `scripts/trace2.log` |
| `scripts/bypass.js`      | Dumps `/v2/domains` JSON; showed direct IDCS-authorize reaches signin (but see below) | `scripts/bypass.log` |
| `scripts/bypass2.js`     | Found the picker-skip that PRESERVES server `state`: `?tenant=X&domain=<name>` (direct IDCS-authorize breaks login with "Invalid Parameter") | `scripts/bypass2.log` |

To learn a tenancy's identity domains: call
`GET https://login.<anyRegion>.oraclecloud.com/v2/domains?tenant=<tenantName>` (curl
works; unauthenticated), or just use the extension's "Add account". Do **not** paste the
results back into this file (see the RULE above).

⚠️ `scripts/capture.log` and `scripts/.chrome-profile/` contain **live tokens / an
authenticated session** — treat as secrets (the whole `scripts/` folder is gitignored).
`scripts/trace*.log` / `scripts/bypass*.log` contain only URLs + IDCS domain IDs.

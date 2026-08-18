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
   - …but **spare the `duplo` IndexedDB on `cloud.oracle.com`** — see *Preserving console
     preferences* below. Auth lives in the other databases.
1b. **Park every OTHER open Oracle tab on `about:blank` first** (`quiesceOracleTabs`).
   This is mandatory when >1 `cloud.oracle.com` tab is open: otherwise each background
   tab notices the session was cleared and **re-writes its old tenant's `_user_data`
   back into the shared localStorage AND starts its own competing SAML login** — leaving
   two tenants' state + parallel auth round-trips fighting, which surfaces as
   **"Authentication error"**. Blanking a tab tears down its SPA immediately, ending the
   race. (Single-tab switching never hit this; it only bites with multiple tabs.)
2. Navigate the tab to `https://cloud.oracle.com/?tenant=<tenantName>&domain=<domainName>`
   (server mints a valid `state`; the picker is skipped).
3. SSO completes — **silent** if the corporate IdP session is alive, otherwise the
   IDCS signin page where one SSO click finishes it. Floor is one click, not zero.
4. **Restore the parked tabs** to their original URLs (now the new tenant) once the new
   login has landed — gated on the target tab reaching `cloud.oracle.com` **without** the
   `tenant=` deep-link param (the initial deep-link page fires `complete` too, and a probe
   there silently re-auths to "live", so it must be skipped) *and* a live `my-profile`
   probe (`maybeRestoreParkedTabs`, via `tabs.onUpdated`). Then waits `restoreDelayMs`
   (adv setting, default 3000) so the console finishes hydrating — reloading the parked
   tabs into that concurrent load breaks it. State lives in `pendingRestore` (storage), so
   it survives a service-worker restart.

### Preserving console preferences across a switch

Wiping `cloud.oracle.com` storage wholesale also destroyed the console's **per-tenancy
preferences**, so every switch re-showed the one-time *"Browser not supported"* popup
(on non-Chrome browsers) and reset the **selected compartment**.

Those preferences are **not cookies and not localStorage** — they live in the
**`duplo` IndexedDB** on `cloud.oracle.com`, in object stores namespaced per tenancy+user:

| store | holds |
|-------|-------|
| `<tenantName>/<userOcid>` | `activeCompartmentId`, `unsupported-browser-popup-not-show-agin` (+ `-date`), `pinned`, `recentSearchKey`, `selectedLocale`, `activeRegionId`, `subscribed-regions` |
| `personalization/<tenantName>/<userOcid>` | ~470 per-service UI prefs (table columns, saved filters, …) |
| `capability/<tenancyOcid>`, `compartments/…`, `notifications/…` | per-tenancy caches |

Because **every store is namespaced by tenancy**, keeping `duplo` across a switch cannot
leak one tenant's state into another. The auth-bearing databases are separate and still
deleted: **`opc-key-store-v2`** (the ephemeral RSA keypair the SPA mints for the oauth2
flow), `maui`, `telemetry-client`, `test`, `console_feature_test_db`. Verified end-to-end:
cookies + localStorage + those databases cleared, `duplo` kept → full SAML re-login
completes normally with compartment + popup consent intact.

**Mechanism (`clearConsoleIdbExceptPrefs` in background.js).** `chrome.browsingData` has no
per-database granularity (indexedDB is all-or-nothing per origin), so the console's
IndexedDB is pruned by hand from a page on that origin:

- host page = **`https://cloud.oracle.com/robots.txt`** — a 24-byte 404: same origin, full
  IndexedDB access, and it does **not** boot the console SPA. (Any real path serves the SPA,
  which would re-pin the old tenant's storage while we're clearing it.) Opened as a
  background tab, `chrome.scripting.executeScript`s the delete loop, closed immediately.
- `deleteDatabase` resolves on `onblocked` too, so a lingering connection can't hang a switch.
- `clearOracleSession` then splits the `browsingData.remove` in two: `cloud.oracle.com`
  **without** `indexedDB`, every other origin **with** it.
- Any failure → `null` → falls back to the old blanket wipe (a correct clear beats kept prefs).
- Adv settings: **`preserveConsolePrefs`** (default on) and **`prefsTabTimeoutMs`** (8000).

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
  - If the target **equals the last-switched** one (`activeTarget`) **and** the session
    hasn't aged out, it's still live → **bypass** the clear/re-auth and just open
    `https://cloud.oracle.com/`.
  - Otherwise (different target, or the active one but **aged out**): clear the Oracle
    session (recipe above) → open the `?tenant&domain` console URL → store
    `activeTarget` + `activeSince = Date.now()`.
- **Session aging (`settings.sessionMaxAgeMin`, default 360 = 6h; 0 = never):**
  `activeSince` records the time of the last *full* sign-in and is **preserved across
  bypasses**, so age is measured from the initial login, not the last click. Clicking
  the active account once `Date.now() - activeSince > sessionMaxAgeMin` re-runs the full
  clear/re-auth instead of bypassing — defeating a silently-expired Oracle session.
  Configurable via the **Re-login after** dropdown in Settings.
- Honors the **Open in new tab** setting.
- The active domain button shows green **`• live`**.

### Settings (gear icon → in-popup view, back button to return)
- **Discovery region** — dropdown of OCI commercial regions; default `us-ashburn-1`
  (`settings.discoveryRegion`). Controls which `login.<region>` endpoint discovery hits.
- **Open switches in a new tab** — toggle (`settings.openInNewTab`).
- **Clear OCI session** — clears Oracle cookies + SPA storage, forgets `activeTarget`.
  Leaves the corporate IdP session intact.

### content.js
- Runs on `idcs-*.identity.oraclecloud.com/ui/v1/signin`. If `settings.autoClickSso`
  (default true) and exactly one obvious federated SSO button is present (and no visible
  password field), it auto-clicks it for true one-click. Selector heuristic
  (`SSO_TEXT`) may need tuning per IdP — it logs candidates to the console (`oxconnect`).

### Service search (optional; `settings.serviceSearch`, default off)
Search-and-jump to any OCI console page, with **fuzzy matching that beats Oracle's own
search** (e.g. "identity domains" finds the **Domains** feature of the **Identity** group,
which OCI's search misses).

- **Why it's built by scraping a tab:** the complete labeled+grouped list of console
  destinations exists **only in the authenticated console**. `https://cloud.oracle.com/search/services?region=<region>`
  renders it client-side (no API; built from the nav tree) inside a **same-origin iframe**
  (`name=sandbox-maui-preact-container`), paginated 50/page (~670 total). The unauth
  `routeRegistry.json` has paths + intent ids but **no display names**; per-plugin i18n
  bundles are too fragile to reconstruct. So there is no static JSON to fetch — we scrape.
- **Enable flow (consent-gated):** the Settings toggle shows an **"I understand" modal**
  explaining a `cloud.oracle.com` tab will briefly open; only on confirm does it flip on
  and run the one-time build. All search UI (🔍 icon, search view, alias menu) is hidden
  while off.
- **Build (`buildServiceCatalog` in background.js):** resolve the active tenant's region →
  login pre-flight (a `my-profile` probe via `consoleSessionLive`) → open the services page in an
  **active tab** (the inner SPA renders reliably when focused) → `chrome.scripting.executeScript`
  the self-contained `scrapeServicesPaged` into **all frames** (only the iframe has the
  table; others return null) → it waits for render, then pages through clicking the
  `[aria-label="Next"]` button, extracting per row `{name, group, path}` (name = link text,
  group = row's other cell, path = link's URL path, region-stripped) → dedupe → store
  `serviceCatalog` → close the tab and restore the previous one. Verified: yields ~660
  entries including `{name:"Domains", group:"Identity", path:"/identity/domains"}`.
- **Search (popup.js):** Fuse.js (vendored, `vendor/fuse.js`) with the **token-search**
  recipe — query `{ $and: tokens.map(t => ({ $or:[{name:t},{group:t}] })) }`,
  `useExtendedSearch + ignoreLocation`, so every token must fuzzy-match name OR group.
  Clicking a result opens `https://cloud.oracle.com<path>?region=<activeRegion>` honoring
  the open-in-new-tab setting.
- **Aliases:** built-in static map in code (`DEFAULT_ALIASES`: `id`→Identity Domains,
  `lambda`→Functions Applications, …) merged with user aliases (`searchAliases`), editable
  in a dedicated **alias menu**. An alias maps a shortcut → a search phrase; typing the
  alias pins its top match above the normal fuzzy results (aliases are not indexed, so they
  stay deterministic).
- The 🔍 icon shows on the **active (live) domain row** only. **Type-to-search:** typing
  any printable character on the accounts view jumps straight into the search view,
  seeding the query.
- During a build, a red "please wait" bar is **injected into the opened tab**
  (`showBuildBanner`), since the popup closes when that tab takes focus.

### Custom compartment picker (experimental; `settings`→adv `customCompartmentPicker`, default off)

Replaces the console's compartment filter menu with a flat, fuzzy-searchable list where
favourites can be **pinned to the top** and given **aliases**. Off by default.

**How the native picker is built** (from inspecting the live console):

| piece | selector |
|-------|----------|
| trigger chip | `.oj-oci-compartment-filter-control .oj-oci-filter-chip` — `role=button`, **toggles** the menu; `aria-label` = `Edit or change Compartment filter with <name> value` (the only reliable read of the current compartment) |
| menu shell | `.oj-oci-filter-menu--form-container`, rendered into a floating layer under `#__root_layer_host` — **generic**, the same shell hosts other filter menus |
| compartment marker | `.oj-oci-compartment-filter-control--compartment-select-container` — present only for the compartment filter, so it is the discriminator for hijacking |
| list | `ul.oj-oci-treeview-list` › `li.oj-oci-treeview-item`, with the OCID in `id` / `data-test-id="oj-oci-treeview-item-content-<ocid>"` |

The menu lives in the same-origin **`sandbox-maui-preact-container` iframe**, so `compartments.js`
is registered with `all_frames: true`.

**Selection drives the native picker rather than reimplementing it.** The tree is *lazy* —
only expanded branches exist in the DOM, so an arbitrary compartment usually has no row to
click. Instead: write the compartment name into their search input (through the native
`HTMLInputElement.value` setter + an `input` event, since it is preact-controlled) → their
tree re-renders with the match and its ancestors expanded → dispatch a real
`pointerdown/mousedown/pointerup/mouseup/click` on the matching row. Their own handler
applies it, so the URL, reload and `activeCompartmentId` persistence all behave normally.

⚠️ **The native picker must be covered, not moved or hidden.** `display:none` stops it laying
out, and relocating it into an off-screen container makes its tree render **zero rows**
(measured — the list is viewport-driven, so nothing off-screen materialises and there is no
row left to click). `coverNative()` therefore leaves it in flow and paints the oxconnect
panel over it as an `position:absolute; inset:0` overlay in a **shadow root** (so console CSS
can't bleed in either direction).

**Data source: the console's own cache** — IndexedDB `duplo`, store
`compartments/<tenantName>/<userOcid>`, one entry per region → a flat array of
`{ id, compartmentId (parent), name, description, lifecycleState }`. Falls back to scraping
whatever rows the native tree has rendered if the cache is missing.

⚠️ **`duplo` holds one set of stores PER TENANCY**, and oxconnect deliberately keeps that
database across a switch (see *Preserving console preferences*) — so after the first switch
several tenancies' caches coexist and taking the first store shows **the wrong tenancy's
compartments**. `loadFromCache()` resolves the active tenancy by (1) the tenancy whose stored
`activeCompartmentId` resolves to the compartment currently on the chip, else (2) the newest
`lastUserActivity`.

**Pins.** Pinned rows are draggable (HTML5 DnD inside the shadow root; the drop side is
decided by which half of the hovered row the pointer is in) and reorder `prefs.pinned`
directly. They render a **solid** pin in the accent colour plus a drag grip, against a
**hollow outline** pin for unpinned rows — the states differ in shape, not just shade.

**Per-compartment settings** (gear icon, pinned rows only) open a modal over the panel with
the alias and a **region** dropdown, sourced from the tenancy's own `subscribed-regions`
(in `duplo`), since a tenancy can only be used in regions it is subscribed to.

### Region: where the console keeps it, and how a compartment can carry one

Traced by diffing **all** browser state across a region switch (`scripts/region-trace.js`).
**No cookie is involved** — which is why deleting the `?region=` query param just gets it
re-added. The switch changes exactly:

| where | before → after |
|-------|----------------|
| `sessionStorage.region` | `<regionA>` → `<regionB>` (region **name**, per tab) |
| `sessionStorage.activeRegionId` | `IAD` → `FRA` (region **key**) |
| `duplo` `<tenantName>/<userOcid>` → `activeRegionId` | `IAD` → `FRA` (**durable** — this is the one that survives reloads) |
| `duplo` `capability/<tenancyOcid>::<region>`, `compartments/…::<region>` | new per-region caches appear lazily |

Writing those by hand would leave the SPA's in-memory state stale, so — same philosophy as
compartment selection — `applyRegion()` drives the console's **own** region menu:
`#region-menu-button` and `.region-selector a.dropmenu__option-item`, matched on the region's
friendly label. Two gotchas: that menu is in the **top frame**, not the sandbox iframe the
picker runs in (both are `cloud.oracle.com`, so `window.top.document` is reachable); and its
anchors **stay in the DOM while the menu is closed**, so "is it open?" must be
`offsetParent !== null` — clicking the button blindly would toggle an open menu shut.

Selecting a compartment applies the compartment first, then the region (a region switch is a
full navigation, and `activeCompartmentId` persists through it). A compartment with no pinned
region falls back to the extension's **Discovery region** setting — but *only* in a tenancy
where at least one compartment has a region pinned, so the feature never moves the region for
someone who has not opted into it.

**UI.** Fuzzy match is a plain **subsequence** test over the alias *and* the name (`aprod1`
→ `<a>pp01.<pro>d.us-ashburn-<1>`), with matched characters bolded. Pinned rows sort first in pin
order, the rest alphabetically; the secondary line is the parent path (the tenancy root is
its own parent — walking must stop there, and it is omitted as noise) or, for aliased rows,
the real compartment name. `↑`/`↓`/`Enter` work from the search box. Pins/aliases/settings are stored
per tenancy in `compartmentPrefs`; unpinning also clears that compartment's alias and settings. If selection ever fails,
the panel removes itself and hands back the standard picker.

Adv settings: `customCompartmentPicker`, `compartmentPickerWidth`, `compartmentPickerMaxHeight`,
`compartmentSelectTimeoutMs`.

### `chrome.storage.local` keys
| key | shape |
|-----|-------|
| `settings` | `{ autoClickSso, openInNewTab, discoveryRegion, sessionMaxAgeMin, serviceSearch }` |
| `tenants` | `[{ tenantName, label, domains:[{domainName,domainType,domainHomeRegion,domainRegion,domainUrl,domainOcid}], lastRefreshed }]` |
| `activeTarget` | `"<tenantName>|<domainName>"` — last successfully switched profile |
| `activeSince` | epoch ms of the last full sign-in (drives session aging; preserved across bypasses) |
| `pendingRestore` | `{ targetTabId, region, parked:[{tabId,url}], createdAt }` — tabs parked on `about:blank` during a switch, restored once the new login lands |
| `serviceCatalog` | `{ builtAt, region, items:[{ name, group, path }] }` — scraped service catalog for search |
| `searchAliases` | `[{ alias, phrase }]` — user search aliases (merged over built-in `DEFAULT_ALIASES`) |
| `compartmentPrefs` | `{ <tenantName>: { pinned:[<compartmentOcid>], aliases:{ <compartmentOcid>: "<alias>" }, settings:{ <compartmentOcid>: { region } } } }` — custom compartment picker (pin order is the array order) |
| `advSettings` | `{ <key>: value }` — overrides for `adv_settings.js` tunables (missing key → its default) |

---

## Extension layout

```
extension/
├─ manifest.json   permissions: cookies, browsingData, storage, tabs, scripting, offscreen
│                  host_permissions: cloud.oracle.com, *.oraclecloud.com, *.oracle.com
├─ background.js   service worker: switchTo() (+ last-active bypass), upsertTenant()/
│                  removeTenant() via /v2/domains, clearSession(),
│                  buildServiceCatalog() (tab-scrape), light/dark toolbar icon swap
├─ popup.html/js   6 views (accounts / add / settings / search / aliases / advanced);
│                  account cards, switch buttons, ↻ refresh, ✕ remove, search
├─ adv_settings.js single source of truth for tunable timeouts/toggles (+ defaults);
│                  shared by the SW (importScripts) and popup (<script>); see below
├─ content.js      optional auto-click of the SAML/SSO button on the IDCS signin page
├─ compartments.js custom compartment picker (pin / alias / fuzzy search) — content script on
│                  cloud.oracle.com, all_frames (the menu lives in the sandbox iframe)
├─ offscreen.html/js  reads prefers-color-scheme (matchMedia, unavailable in the SW) and
│                  reports it so the toolbar icon swaps light/dark
├─ vendor/fuse.js  vendored Fuse.js (UMD, global Fuse) for service-search fuzzy matching
└─ icons/          oxconnect{16,32,48,128}.png + oxconnect{…}_darkmode.png (inverted)
```

**Advanced settings (`adv_settings.js`).** All tunable timeouts/toggles —
the parked-tab restore delay, catalog-build tab focus/timeouts/inject retries, the scraper's poll
tick / render+page-advance waits / max-pages / maximize-items-per-page, and the search
fuzzy threshold/weights/limits — are declared once in `adv_settings.js` as
`ADV_SETTINGS` (key, label, type, default, group, desc), with `ADV_DEFAULTS`/`advMerge`
helpers assigned onto `self`. The service worker `importScripts('adv_settings.js')` and
the popup loads it via `<script>`. Stored overrides live in `advSettings`; the
**Advanced settings** menu renders one control per entry (empty a field → restore its
default; **reset** clears all). The injected scraper takes these as `opts` via
`executeScript` args, so it stays free of magic numbers.

The toolbar icon follows the OS/browser color scheme: an offscreen document detects
`prefers-color-scheme` at load (and on change) → background `chrome.action.setIcon()`
picks the normal icons (light) or the `_darkmode` inverted icons (dark).
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
| `scripts/open-console.js` | Opens Chrome with CDP (:9222) deep-linked to a tenant and idles, so you can log in for the captures below | — |
| `scripts/prefs.js` | `snap <label>` / `diff <a> <b>` — snapshots cookies + localStorage + sessionStorage over CDP and diffs two snapshots; used to prove the compartment / browser-popup prefs are in **neither** | `scripts/prefs-<label>.json` |
| `scripts/prefs-test.js` | Simulates `clearOracleSession()` but spares `duplo`, then re-logs-in and asserts the prefs survived | stdout |
| `scripts/open-brave-ext.js` | Launches Brave with the unpacked extension loaded + CDP :9222 | — |
| `scripts/ext-switch-test.js` | Drives the **real** extension `switchTo()` over CDP and reports whether the prefs survived | stdout |
| `scripts/comp-lib.js` | Shared CDP helpers for the compartment picker (attach + toggle-aware `reopen()`) | — |
| `scripts/comp-poc.js` | Proved selection can be driven headlessly through the native picker (search → click) | stdout |
| `scripts/region-trace.js` | `snap <label>` / `diff <a> <b>` — snapshots cookies + localStorage + sessionStorage + `duplo` and diffs; used to prove the active region is in storage, never a cookie | `scripts/region-<label>.json` |
| `scripts/comp-v2.js` | Tests pin icons, drag-reorder, the settings modal and region-follows-compartment | stdout |
| `scripts/comp-func.js` | End-to-end test: render → fuzzy search → pin → alias → search-by-alias → select | stdout |
| `scripts/relaunch-brave.js` | Kill + relaunch Brave with the unpacked extension and wait for the SW (manifest / content-script edits need a real extension reload, and the MV3 worker idles out so `reload-ext.js` often can't attach) | — |
| `scripts/capture-services.js` | Service-search Step-0: connects to the open browser over CDP, finds the services-page data source. Established: the list is built client-side (no API) and rendered in the `sandbox-maui-preact-container` iframe, paginated; scrape it. | `scripts/capture-services.{log,html}` |

To learn a tenancy's identity domains: call
`GET https://login.<anyRegion>.oraclecloud.com/v2/domains?tenant=<tenantName>` (curl
works; unauthenticated), or just use the extension's "Add account". Do **not** paste the
results back into this file (see the RULE above).

⚠️ `scripts/capture.log` and `scripts/.chrome-profile/` contain **live tokens / an
authenticated session** — treat as secrets (the whole `scripts/` folder is gitignored).
`scripts/trace*.log` / `scripts/bypass*.log` contain only URLs + IDCS domain IDs.

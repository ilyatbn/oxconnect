# oxconnect extension

One-click switch between OCI tenancies / identity domains. See `../CLAUDE.md` for
how the underlying OCI login flow works and how to reproduce the investigation.

## Load it
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. **Load unpacked** → select this `extension/` folder
4. Pin the extension; click its icon to open the popup.

## Use it
The extension **starts empty**.
- **Add account**: enter the OCI account (tenancy) name (e.g. `my-oracle-cloud`)
  and an optional label → it calls `/v2/domains` to look up that tenancy's identity
  domains/OCIDs/URLs/regions and stores them (no login needed). Each card then shows
  one **switch button per identity domain**.
- **Switch**: click a domain button → it clears the current OCI session and opens
  `cloud.oracle.com/?tenant=<name>&domain=<domainName>` (skips the bounce-back and the
  domain picker, with a valid server `state` so login completes). Complete SSO if prompted.
- **↻ Refresh** (per account): re-run the lookup if domains were added/removed.
- **✕ Remove** (per account): delete the account.
- **open in new tab**: switch without replacing the current tab.
- **Clear OCI session**: sign out of OCI in this browser (cookies + SPA storage),
  leaving your corporate IdP session intact.

## Notes / tuning
- One active tenant per browser profile (OCI uses a single shared origin) — switching
  signs out the previous tenant. This is expected.
- `content.js` tries to auto-click the SAML/SSO button on the signin page for true
  one-click. The selector/text heuristic (`SSO_TEXT`) may need tuning to your IdP's
  actual button — open DevTools console on the signin page and filter for `oxconnect`
  to see the candidates it detects. Toggle off by setting
  `chrome.storage.local` → `settings.autoClickSso = false`.
- No seed data: the account list lives entirely in `chrome.storage.local` (key
  `tenants`), populated by you via "Add account".

## Files
| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (permissions, content-script match) |
| `background.js` | switch / addTenant / clear logic + seed |
| `popup.html` / `popup.js` | UI |
| `content.js` | optional SSO auto-click on the IDCS signin page |

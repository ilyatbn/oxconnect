# oxconnect

A Chrome extension to **one-click switch** between multiple Oracle Cloud (OCI)
tenancies / identity domains. OCI keeps one session per browser for the shared
`cloud.oracle.com` origin, so it normally bounces you back to whichever tenant you're
already in. oxconnect clears just the Oracle session and deep-links straight to the
tenant you picked — login (corporate SSO) then completes in one click, or silently if
your SSO session is still alive.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. **Load unpacked** → select the `extension/` folder
4. Pin the extension and click its icon to open the popup.

## Using it

The extension starts empty.

- **Add an account:** click the **`+`** button, enter your OCI account (tenancy) name
  and an optional label, then **Add account**. It looks up that tenancy's identity
  domains automatically — no login needed.
- **Switch:** each account shows one button per identity domain. Click one to switch to
  it. The button you're currently on is marked **• live** (green).
- **↻ / ✕** on a card: refresh an account's domain list, or remove the account.

## Settings (⚙ top-right)

- **Discovery region** — which region to look up new accounts from. Default
  `us-ashburn-1` works for most; change it if an account lives elsewhere.
- **Open switches in a new tab** — otherwise the current tab is reused.
- **Keep-Alive** — every minute, pings the active tenant to keep its session fresh. If
  it fails, the active profile turns **yellow** and it retries with backoff. Shows the
  last result and a **Check now** button.
- **Clear OCI session** — signs you out of OCI in this browser (your corporate SSO
  stays intact).

## Notes

- One active tenant at a time per browser profile — switching signs out the previous
  one. (That's an OCI limitation: all tenancies share one origin.)
- See `extension/README.md` for a bit more, and `CLAUDE.md` for how it works under the
  hood.

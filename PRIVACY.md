# Privacy Policy

_Last updated: 2026-06-21_

**oxconnect** is a Chrome extension that helps you manage and switch between
multiple Oracle Cloud (OCI) tenancies and identity domains. This document
explains what data the extension handles and how.

## All data stays on your device

oxconnect does **not** have any backend, server, or analytics. It does not
collect, transmit, sell, or share your data with us or any third party. There is
no account to create and nothing to sign in to.

Everything the extension stores lives **locally in your browser**, in
`chrome.storage.local` on the device you're using. This includes:

- the tenancy/account names and labels you add;
- the identity-domain metadata discovered for those accounts;
- your settings and preferences;
- the optional scraped service catalog used for in-console search.

This data never leaves your browser except in the ways inherent to the
extension's purpose — for example, looking up a tenancy's identity domains
queries Oracle's own public endpoint, and switching tenants navigates your
browser to Oracle Cloud. Those are direct interactions between your browser and
Oracle, with no intermediary controlled by us.

## Network activity

The extension only talks to **Oracle** services on your behalf:

- **Tenancy discovery** — an unauthenticated request to
  `login.<region>.oraclecloud.com/v2/domains?tenant=<name>` to list a tenancy's
  identity domains when you add or refresh an account.
- **Tenant switching** — navigating your browser tab to `cloud.oracle.com` so
  you can sign in via your organization's normal corporate SSO flow.

oxconnect never sees or handles your password — authentication happens directly
between your browser, Oracle, and your organization's identity provider.

## Permissions

The extension requests the browser permissions it needs to do its job
(managing cookies and site storage for Oracle origins, opening/navigating tabs,
and local storage). These are used solely to perform tenant switching and to
store your settings locally — never to observe unrelated browsing.

## Security and responsibility

We strive to keep oxconnect as safe as we reasonably can, and because all of
your data stays on your own device, there is no central store for an attacker to
target. However, **no software can be guaranteed to be completely secure.** The
extension is provided "as is," without warranty of any kind. We cannot accept
responsibility or liability for any data loss, unauthorized access, or breach
that may result from use of the extension, from vulnerabilities in your browser
or operating system, or from any other cause outside our control. You use
oxconnect at your own risk.

## Open source

oxconnect is open source. You are welcome to review exactly what it does at any
time, audit the code, and verify these claims for yourself:

<https://github.com/ilyatbn/oxconnect>

## Changes to this policy

If this policy changes, the updated version will be committed to the repository
and the "Last updated" date above will be revised.

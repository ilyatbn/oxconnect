// oxconnect content script — runs on idcs-*.identity.oraclecloud.com/ui/v1/signin
//
// For SAML/SSO-only identity domains the signin page typically shows a single
// federated "Sign in with <IdP>" button. If autoClickSso is enabled and exactly
// one obvious federated button is found, click it to reach genuine one-click
// switching. Conservative by design — it will NOT click if there's ambiguity
// (e.g. a visible username/password form), to avoid misfires.
//
// NOTE: the exact button selector/text varies per IdP. This logs its candidates
// to the console (filter by "oxconnect") so you can tune SSO_TEXT / selectors to
// your tenant's actual signin page.

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings && settings.autoClickSso === false) return;

  const SSO_TEXT = /sign in with|single sign|use your (single )?sign|company|corporate|federat|\bsso\b|\bsaml\b|continue with|sign in using/i;
  const SELECTOR = 'a, button, [role="button"], .idp, .idp-btn, .social-link, [data-idp], [data-automation-id*="idp" i]';

  function hasVisiblePasswordField() {
    return [...document.querySelectorAll('input[type="password"]')].some((i) => i.offsetParent !== null);
  }

  function findSsoButton() {
    const cands = [...document.querySelectorAll(SELECTOR)].filter((el) => {
      if (el.offsetParent === null) return false; // not visible
      const text = (el.innerText || el.textContent || el.value || '').trim();
      return SSO_TEXT.test(text);
    });
    return cands;
  }

  let clicked = false;
  let ticks = 0;
  const timer = setInterval(() => {
    if (clicked || ++ticks > 20) { clearInterval(timer); return; } // give up after ~10s
    const cands = findSsoButton();
    if (cands.length) console.debug('oxconnect: SSO button candidates:', cands.map((e) => (e.innerText || e.textContent || '').trim()));
    // Only auto-click when unambiguous: exactly one match and no password form to fill.
    if (cands.length === 1 && !hasVisiblePasswordField()) {
      clicked = true;
      clearInterval(timer);
      console.debug('oxconnect: auto-clicking SSO button:', (cands[0].innerText || cands[0].textContent || '').trim());
      cands[0].click();
    }
  }, 500);
})();

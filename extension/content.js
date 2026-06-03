// oxconnect content script — runs on idcs-*.identity.oraclecloud.com/ui/v1/signin
//
// The IDCS sign-in page renders a federated-IdP ("company SSO") button list as
// Oracle JET <oj-button> elements inside #idcs-signin-idp-signin-form, e.g.:
//   <oj-button id="idcs-signin-idp-signin-form-idp-button-<NAME>" title="<NAME>"
//              on-oj-action="[[companySubmit]]"> <button class="oj-button-button">…
//
// If autoClickSso is enabled and there is exactly ONE such IdP button, click it to
// finish login in one click. If there are several (multiple IdPs), we don't guess —
// we log the candidates so a preference can be added later. The list renders async
// (knockout), so we poll briefly.

(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings || settings.autoClickSso === false) return;

  const FORM = '#idcs-signin-idp-signin-form';
  const IDP_BUTTON = 'oj-button[id^="idcs-signin-idp-signin-form-idp-button-"]';

  const visible = (el) => el && el.offsetParent !== null;
  const nameOf = (el) => el.getAttribute('title') || el.id.replace('idcs-signin-idp-signin-form-idp-button-', '');

  function idpButtons() {
    const scope = document.querySelector(FORM) || document;
    return [...scope.querySelectorAll(IDP_BUTTON)].filter(visible);
  }

  function clickIdp(ojButton) {
    // The native <button> inside the oj-button triggers its on-oj-action handler.
    const inner = ojButton.querySelector('button.oj-button-button') || ojButton;
    inner.click();
  }

  let done = false;
  let ticks = 0;
  const timer = setInterval(() => {
    if (done || ++ticks > 30) { clearInterval(timer); return; } // give up after ~15s
    const btns = idpButtons();
    if (!btns.length) return; // not rendered yet
    if (btns.length > 1) {
      console.debug('oxconnect: multiple SSO/IdP buttons — not auto-clicking:', btns.map(nameOf));
      done = true; clearInterval(timer); return;
    }
    done = true; clearInterval(timer);
    console.debug('oxconnect: auto-clicking SSO/IdP button:', nameOf(btns[0]));
    clickIdp(btns[0]);
  }, 500);
})();

// Offscreen document: the service worker can't read matchMedia, so this hidden
// document detects the OS/browser color scheme and reports it to the background,
// then keeps reporting whenever the scheme changes. Background swaps the toolbar
// icon accordingly.

const mq = matchMedia('(prefers-color-scheme: dark)');

function report() {
  chrome.runtime.sendMessage({ type: 'colorScheme', dark: mq.matches }).catch(() => {});
}

report();                          // initial (on load)
mq.addEventListener('change', report); // live OS theme changes

// Advanced settings — the single source of truth for tunable timeouts / toggles.
//
// Loaded by BOTH the service worker (via importScripts in background.js) and the popup
// (via a <script> tag in popup.html), so everything is defined in exactly one place.
//
// User overrides live in chrome.storage.local under `advSettings` (a flat {key:value}).
// Anything missing falls back to the `default` declared here. The Advanced settings
// menu in the popup renders one control per entry below.
//
// Assigned onto `self` so it works in both the worker global scope and window.

self.ADV_SETTINGS = [
  // ---- Appearance ----
  { key: 'iconTheme', group: 'Appearance', label: 'Toolbar icon', type: 'select', default: 'auto',
    options: [
      { value: 'auto', label: 'Auto (match OS)' },
      { value: 'light', label: 'Force light (dark icon)' },
      { value: 'dark', label: 'Force dark (white icon)' },
    ],
    desc: 'Auto follows the OS dark/light setting; override here if detection picks the wrong icon.' },

  // ---- Session clearing ----
  { key: 'preserveConsolePrefs', group: 'Session clearing', label: 'Preserve console preferences', type: 'bool', default: true,
    desc: 'Keep the console\'s per-tenancy preferences (selected compartment, "browser not supported" dismissal, pinned items, locale) across a switch. They live in the `duplo` IndexedDB, namespaced per tenancy, so sparing it is safe; the auth-bearing databases are still wiped. Turn off to wipe all site storage (the old behaviour) if a switch misbehaves.' },
  { key: 'prefsTabTimeoutMs', group: 'Session clearing', label: 'Prefs tab timeout (ms)', type: 'number', min: 1000, step: 500, default: 8000,
    desc: 'How long to wait for the throwaway same-origin tab used to do the selective IndexedDB wipe. On timeout the switch falls back to wiping all site storage.' },

  // ---- Tab restore ----
  { key: 'restoreDelayMs', group: 'Tab restore', label: 'Restore delay (ms)', type: 'number', min: 0, step: 500, default: 3000,
    desc: 'After the new tenant signs in, wait this long before reloading the tabs that were parked during the switch — lets the console settle so the concurrent load does not break it.' },

  // ---- Compartment picker (experimental) ----
  { key: 'customCompartmentPicker', group: 'Compartment picker', label: 'Custom compartment picker (experimental)', type: 'bool', default: false,
    desc: 'Replace the console\'s compartment filter menu with a flat, searchable list where you can pin favourites to the top and give them aliases. Pins/aliases are stored per tenancy. Selection still goes through the console\'s own picker, so nothing downstream changes.' },
  { key: 'compartmentPickerWidth', group: 'Compartment picker', label: 'Picker width (px)', type: 'number', min: 260, step: 20, default: 420,
    desc: 'Minimum width of the replaced menu.' },
  { key: 'compartmentPickerMaxHeight', group: 'Compartment picker', label: 'Picker list height (px)', type: 'number', min: 120, step: 20, default: 420,
    desc: 'Maximum height of the compartment list before it scrolls.' },
  { key: 'compartmentSelectTimeoutMs', group: 'Compartment picker', label: 'Select timeout (ms)', type: 'number', min: 1000, step: 500, default: 8000,
    desc: 'How long to wait for the console\'s own tree to surface the chosen compartment after searching for it. On timeout the standard picker is restored.' },

  // ---- Service catalog build ----
  { key: 'catalogTabActive', group: 'Service catalog', label: 'Open build tab focused', type: 'bool', default: true,
    desc: 'Open the catalog-build tab active (the SPA renders reliably when focused) vs in the background.' },
  { key: 'catalogTabLoadTimeoutMs', group: 'Service catalog', label: 'Tab load timeout (ms)', type: 'number', min: 3500, step: 1000, default: 60000,
    desc: 'How long to wait for the services tab to finish its initial load.' },
  { key: 'catalogInjectAttempts', group: 'Service catalog', label: 'Inject attempts', type: 'number', min: 1, step: 1, default: 4,
    desc: 'Times to (re)inject the scraper while the iframe renders.' },
  { key: 'catalogInjectRetryMs', group: 'Service catalog', label: 'Inject retry gap (ms)', type: 'number', min: 100, step: 100, default: 800,
    desc: 'Delay between inject attempts.' },
  { key: 'maximizeItemsPerPage', group: 'Service catalog', label: 'Maximize items per page', type: 'bool', default: true,
    desc: 'Set the table to its largest page size first, to reduce the number of pages scraped.' },
  { key: 'scrapeTickMs', group: 'Service catalog', label: 'Scrape poll tick (ms)', type: 'number', min: 50, step: 50, default: 250,
    desc: 'Polling interval while waiting for render and pagination.' },
  { key: 'scrapeReadyTimeoutMs', group: 'Service catalog', label: 'Render wait (ms)', type: 'number', min: 1000, step: 500, default: 8000,
    desc: 'Max wait for the services table to appear in a frame.' },
  { key: 'scrapePageAdvanceTimeoutMs', group: 'Service catalog', label: 'Page advance wait (ms)', type: 'number', min: 500, step: 250, default: 3500,
    desc: 'Max wait for the table to move to the next page after clicking Next.' },
  { key: 'scrapeMaxPages', group: 'Service catalog', label: 'Max pages', type: 'number', min: 1, step: 1, default: 40,
    desc: 'Safety cap on pagination clicks.' },

  // ---- Search ----
  { key: 'fuseThreshold', group: 'Search', label: 'Fuzzy threshold', type: 'number', min: 0, max: 1, step: 0.05, default: 0.4,
    desc: 'Lower = stricter matching (0 exact … 1 anything).' },
  { key: 'fuseMinMatchCharLength', group: 'Search', label: 'Min match length', type: 'number', min: 1, step: 1, default: 2,
    desc: 'Minimum characters a token must match.' },
  { key: 'fuseNameWeight', group: 'Search', label: 'Name weight', type: 'number', min: 0, max: 1, step: 0.1, default: 0.7,
    desc: 'Relative weight of the feature name when ranking.' },
  { key: 'fuseGroupWeight', group: 'Search', label: 'Group weight', type: 'number', min: 0, max: 1, step: 0.1, default: 0.3,
    desc: 'Relative weight of the service group when ranking.' },
  { key: 'searchResultLimit', group: 'Search', label: 'Max results', type: 'number', min: 1, step: 1, default: 40,
    desc: 'Maximum fuzzy results shown below any pinned alias hits.' },
  { key: 'aliasPinLimit', group: 'Search', label: 'Alias pins', type: 'number', min: 1, step: 1, default: 3,
    desc: 'How many alias matches to pin at the top.' },
];

self.ADV_DEFAULTS = Object.fromEntries(self.ADV_SETTINGS.map((s) => [s.key, s.default]));

// Read one value from an overrides object, falling back to the declared default.
self.advGet = function (overrides, key) {
  const v = overrides ? overrides[key] : undefined;
  return v === undefined || v === null || v === '' ? self.ADV_DEFAULTS[key] : v;
};

// Merge stored overrides over defaults into a complete {key:value} map.
self.advMerge = function (overrides) {
  const m = {};
  for (const k of Object.keys(self.ADV_DEFAULTS)) m[k] = self.advGet(overrides, k);
  return m;
};

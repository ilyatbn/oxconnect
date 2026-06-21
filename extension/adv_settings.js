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

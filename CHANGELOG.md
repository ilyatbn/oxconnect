0.1.4
-----
- removed keep-alive feature.
0.1.3
-----
- CTRL+Shift+Q opens the popup menu now.
- Added keyboard support to go up/down and click enter while still being able to type in search box.
- when nothing is found, adds a menu option to OCI Resource Explorer search.
- removed Keep-Alive (the per-minute session ping); dropped the `alarms` permission.
- fixed "Authentication error" when switching with multiple Oracle Cloud tabs open: other
  tabs are parked on about:blank during the switch (so they can't race the re-login), then
  restored to their original pages once the new tenant has signed in.

0.1.2
-----
- added forced re-login for clicking an active account after N hours.
- implemented search functionality with aliases
0.1.1
-----
- light icons for darkmode browsers
0.1.0
-----
- initial release

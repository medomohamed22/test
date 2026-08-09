# DealWay UI + cache update fix

Version: 2026.08.09.1936

## What changed
- Removed the global click interception for local links. Native browser navigation is used instead, which is more reliable inside Pi Browser.
- Added a UI unlock fail-safe: any stale global loader is forcibly hidden on DOMContentLoaded, pageshow, focus, visibility return, JS errors, and unhandled promise rejections.
- The global loader now has a 12-second emergency timeout so it can never block the site permanently.
- Service worker uses network-first for HTML/JS/CSS instead of cache-first.
- Added version.json and automatic version checks. When a new deployed version is detected, DealWay clears its old Cache Storage, updates the service worker, and reloads once.
- Vercel now sends no-cache headers for sw.js, version.json, HTML, JS and CSS.

## For every future release
Change the same version string in both common.js and sw.js and version.json. A timestamp such as YYYY.MM.DD.HHmm is enough.

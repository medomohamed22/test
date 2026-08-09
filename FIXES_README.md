# DealWay fixes – Pi permissions, clicks, and Node 24 warning

## Fixed page clicks
The global loading layer was styled with `display:grid` even while the HTML `hidden` attribute was present. That made an invisible full-screen element capture taps/clicks. The loader now uses `pointer-events:none` when hidden, `display:none !important` for `[hidden]`, and only becomes interactive while visibly shown.

The common back-button initializer was also narrowed to page header back buttons so it does not overwrite unrelated modal/dialog controls.

## Pi permissions
Every explicit Pi sign-in now calls `Pi.authenticate` with:

```js
['username', 'wallet_address', 'payments', 'in_app_notifications']
```

This re-checks the complete requested permission set on every sign-in attempt. Pi Browser itself decides whether to display the consent sheet again when permissions are already granted; a third-party app cannot force Pi Browser to show that native consent UI every time.

## Node 24 DEP0169
`web-push@3.6.7` uses Node's deprecated `url.parse()`. A safe postinstall patch converts the two web-push URL parsing sites to the WHATWG `new URL()` API. This runs automatically after dependency installation.

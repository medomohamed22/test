import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve('node_modules/web-push/src/web-push-lib.js');
if (!fs.existsSync(file)) {
  console.log('[postinstall] web-push not installed; skipping URL patch');
  process.exit(0);
}

let source = fs.readFileSync(file, 'utf8');
const original = source;

source = source.replace("const url = require('url');\n", '');
source = source.replace(/url\.parse\(subscription\.endpoint\)/g, 'new URL(subscription.endpoint)');
source = source.replace(/url\.parse\(requestDetails\.endpoint\)/g, 'new URL(requestDetails.endpoint)');
source = source.replace('httpsOptions.port = urlParts.port;\n      httpsOptions.path = urlParts.path;', "httpsOptions.port = urlParts.port || undefined;\n      httpsOptions.path = urlParts.pathname + urlParts.search;");

if (source !== original) {
  fs.writeFileSync(file, source);
  console.log('[postinstall] patched web-push to use the WHATWG URL API');
} else if (source.includes('new URL(subscription.endpoint)') && source.includes('new URL(requestDetails.endpoint)')) {
  console.log('[postinstall] web-push URL patch already present');
} else {
  console.warn('[postinstall] web-push layout changed; URL patch was not applied');
}

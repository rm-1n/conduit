// Diagnostic: upload ANY UF2 file via the same upload.js flow the browser uses,
// and report the outcome. Used to separate "is the upload protocol OK?" from
// "is the browser-built UF2 OK?".
//
// Usage:  node web/tests/_upload_probe.mjs <path-to.uf2> [ip] [token]

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.window = globalThis;
const { installAsGlobalFetch } = await import('./_curl_fetch.mjs');
installAsGlobalFetch();

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const f of ['upload.js']) {
  (0, eval)(await readFile(join(webRoot, f), 'utf8'));
}
const { updateFirmware, commitFirmware, getStatus } = globalThis.Conduit;

const [uf2Path, ip = '192.168.178.200', token = 'changeme'] = process.argv.slice(2);
if (!uf2Path) { console.error('usage: _upload_probe.mjs <uf2> [ip] [token]'); process.exit(2); }

const data = new Uint8Array(await readFile(uf2Path));
console.log(`→ uploading ${uf2Path} (${data.byteLength} B) to ${ip}`);

const pre = await getStatus(ip);
console.log(`  pre: v${pre.version} partition=${pre.partition} tbyb=${pre.tbyb_pending}`);
if (pre.tbyb_pending) {
  const c = await commitFirmware(ip, token);
  console.log(`  pre-commit: ${JSON.stringify(c)}`);
}

const result = await updateFirmware({
  ip, token, data,
  onStage: (s, d) => {
    if (typeof d === 'object') console.log(`  [${s}] partition=${d.partition} v${d.version} tbyb=${d.tbyb_pending} uptime=${d.uptime}`);
    else console.log(`  [${s}]${d ? ' ' + d : ''}`);
  },
  onProgress: (() => { let p = -1; return ({ pct }) => { const r = Math.round(pct/10)*10; if (r !== p) { p = r; process.stdout.write(`    ${r}%\r`); } }; })(),
});
console.log(`\n  outcome=${result.outcome}`);
console.log(`  pre  = ${JSON.stringify(result.pre)}`);
if (result.post) console.log(`  post = ${JSON.stringify(result.post)}`);
if (result.error) console.log(`  error: ${result.error.message || result.error}`);

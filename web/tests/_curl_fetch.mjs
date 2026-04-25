// _curl_fetch.mjs — A minimal `fetch`-compatible shim that shells out to `curl`.
//
// Why: on macOS (and inside Claude Code's sandbox), Node's built-in fetch can
// hit EHOSTUNREACH against LAN-local hosts that `curl` reaches fine (likely
// macOS 15's Local Network privacy gate). curl is in the system allowlist.
// This module wraps curl so we can re-use the browser's web/upload.js end-to-
// end in Node tests without reimplementing the OTA protocol.
//
// Covers the subset of fetch that upload.js actually uses:
//   - GET / POST
//   - headers: plain object
//   - body: Blob / Uint8Array / undefined
//   - signal: AbortSignal with .aborted + 'abort' event
// Returns a Response-like with { ok, status, headers.get, json(), text() }.
// Throws TypeError('fetch failed') for connection errors so
// isRebootCloseError() in upload.js classifies the last-chunk disconnect
// correctly (the device hangs up mid-response when it reboots).

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const STATUS_SENTINEL = '\n__CURL_FETCH_STATUS__:';

export async function curlFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const signal = opts.signal;

  // Materialize body to a Buffer (or null for GET / no body).
  let bodyBuf = null;
  if (opts.body != null) {
    if (opts.body instanceof Blob) {
      bodyBuf = Buffer.from(await opts.body.arrayBuffer());
    } else if (opts.body instanceof ArrayBuffer) {
      bodyBuf = Buffer.from(opts.body);
    } else if (ArrayBuffer.isView(opts.body)) {
      bodyBuf = Buffer.from(opts.body.buffer, opts.body.byteOffset, opts.body.byteLength);
    } else if (typeof opts.body === 'string') {
      bodyBuf = Buffer.from(opts.body, 'utf8');
    } else {
      throw new TypeError(`curlFetch: unsupported body type ${opts.body.constructor?.name}`);
    }
  }

  // Build curl argv.
  const args = [
    '-sS',                  // silent, but show errors on stderr
    '-X', method,
    '-D', '-',              // dump response headers to stdout (before body)
    '-o', '-',              // body to stdout (concatenated after headers via -D -)
    '--max-time', '30',     // hard timeout per request
    '-w', `${STATUS_SENTINEL}%{http_code}\n`,
  ];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  if (bodyBuf) {
    args.push('--data-binary', '@-');
  }
  args.push(url);

  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));

    const onAbort = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    if (signal) {
      if (signal.aborted) { onAbort(); }
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);

      const raw = Buffer.concat(out);
      const rawStr = raw.toString('utf8');
      // Find the sentinel — everything before is headers+body, after is HTTP status code.
      const sidx = rawStr.lastIndexOf(STATUS_SENTINEL);
      let status = 0;
      let bodyBytes = raw;
      if (sidx >= 0) {
        status = parseInt(rawStr.slice(sidx + STATUS_SENTINEL.length).trim(), 10) || 0;
        bodyBytes = raw.subarray(0, Buffer.byteLength(rawStr.slice(0, sidx), 'utf8'));
      }

      // Strip the HTTP/1.1 header block(s) printed by -D -. For each response
      // separator ("\r\n\r\n" or "\n\n"), keep only the content after the last one.
      // HTTP/1.1 headers end in CRLF CRLF.
      let split = bodyBytes.indexOf(Buffer.from('\r\n\r\n'));
      let sepLen = 4;
      if (split === -1) { split = bodyBytes.indexOf(Buffer.from('\n\n')); sepLen = 2; }
      const headerBlock = split === -1 ? '' : bodyBytes.subarray(0, split).toString('utf8');
      const bodyOnly    = split === -1 ? bodyBytes : bodyBytes.subarray(split + sepLen);

      // Connection error (curl exited nonzero with no HTTP status parsed) →
      // throw so upload.js's isRebootCloseError() recognizes it.
      if (code !== 0 && status === 0) {
        const e = new TypeError('fetch failed');
        e.cause = new Error(Buffer.concat(err).toString('utf8').trim() || `curl exit ${code}`);
        reject(e);
        return;
      }

      const hdrMap = new Map();
      for (const line of headerBlock.split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) hdrMap.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
      }

      const response = {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: {
          get: (name) => hdrMap.get(String(name).toLowerCase()) || null,
          has: (name) => hdrMap.has(String(name).toLowerCase()),
        },
        async text() { return bodyOnly.toString('utf8'); },
        async json() {
          const t = bodyOnly.toString('utf8');
          try { return JSON.parse(t); }
          catch (e) { throw new SyntaxError(`curlFetch: JSON parse failed: ${e.message} (body: ${t.slice(0, 120)})`); }
        },
        async arrayBuffer() { return bodyOnly.buffer.slice(bodyOnly.byteOffset, bodyOnly.byteOffset + bodyOnly.byteLength); },
        body: Readable.from(bodyOnly),
      };
      resolve(response);
    });

    if (bodyBuf) {
      child.stdin.on('error', () => {}); // ignore EPIPE on early process exit
      child.stdin.end(bodyBuf);
    } else {
      child.stdin.end();
    }
  });
}

// Install as the default global fetch so code that calls the bare fetch()
// (like web/upload.js) picks this up transparently.
export function installAsGlobalFetch() {
  globalThis.fetch = curlFetch;
}

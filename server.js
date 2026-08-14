// RAW decode is shelled out to the native `dcraw_emu` binary (part of LibRaw).
// libraw-wasm was tried first but its Emscripten build only knows how to load
// its .wasm binary via browser fetch()/XMLHttpRequest, neither of which work
// inside a plain Node worker thread -- decode calls hung forever instead of
// erroring. dcraw_emu has no such dependency and decodes a 26MP RAW in ~3s
// even on a t3.small. It must be built from source and on PATH -- see
// SESSION_HANDOFF.md for the build steps (not an npm package).
import express from 'express';
import morgan from 'morgan';
import Busboy from 'busboy';
import sharp from 'sharp';
import archiver from 'archiver';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Requests arrive via the cloudflared tunnel (a local reverse proxy), so
// req.ip would otherwise show 127.0.0.1 for every visitor -- trust the
// X-Forwarded-For it sets so logging below reflects the real client IP.
app.set('trust proxy', true);
app.use(morgan('combined'));

const FORMATS = new Set(['jpeg', 'webp', 'png']);
const EXT_FOR_FORMAT = { jpeg: 'jpg', webp: 'webp', png: 'png' };

// Strips any directory components and non-safe characters from a
// user-supplied filename. Without this, a crafted originalname (e.g.
// containing "../") could escape the intended temp/zip-entry path --
// both multer's diskStorage filename and the zip entry name below are
// built from this value.
function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, '_') || 'file';
}

// Public-facing deployments must set this; refuse to run wide open.
// Format: "user1:pass1,user2:pass2,..."
const AUTH_CREDENTIALS = process.env.APP_CREDENTIALS;
if (!AUTH_CREDENTIALS) {
  console.error('APP_CREDENTIALS env var must be set (format: user:pass,user2:pass2) -- refusing to start without auth.');
  process.exit(1);
}
const AUTH_USERS = new Map(
  AUTH_CREDENTIALS.split(',').map((pair) => {
    const sep = pair.indexOf(':');
    return [pair.slice(0, sep), pair.slice(sep + 1)];
  })
);

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    const expectedPass = AUTH_USERS.get(user);
    if (expectedPass !== undefined && timingSafeStringEqual(pass, expectedPass)) {
      console.log(`[auth] success user=${user} ip=${req.ip}`);
      next();
      return;
    }
    console.log(`[auth] failure user=${user || '(empty)'} ip=${req.ip}`);
  } else {
    console.log(`[auth] no credentials offered ip=${req.ip}`);
  }
  res.set('WWW-Authenticate', 'Basic realm="SaintsOfShortCreek"');
  res.status(401).send('Authentication required');
});

const MAX_FILES = 100;
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// Decode is CPU-bound (a dcraw_emu child process); capping concurrency at
// the instance's core count lets files decode while later files are still
// uploading, without oversubscribing the CPU once several are in flight.
const DECODE_CONCURRENCY = os.cpus().length;
let activeDecodes = 0;
const decodeQueue = [];
function withDecodeSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeDecodes++;
      fn().then(resolve, reject).finally(() => {
        activeDecodes--;
        const next = decodeQueue.shift();
        if (next) next();
      });
    };
    if (activeDecodes < DECODE_CONCURRENCY) run();
    else decodeQueue.push(run);
  });
}

// All static assets are being iterated on frequently during design review --
// never let browsers cache any of them, so redeploys show up without a manual
// hard refresh. TODO: revisit once the design pass is finished.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));

// Streams the upload instead of buffering the whole request first (as the
// old multer-based version did). The browser client and the load-test
// driver both send format/quality/resize fields BEFORE the file parts, so
// by the time the first file arrives those values are already final --
// each file's decode+encode can start the moment IT finishes uploading,
// overlapping with the upload of whatever comes after it, rather than
// waiting for the entire batch to arrive before processing anything.
// (A client that sent files before fields would just get default
// format/quality for those files, not a crash -- same graceful-default
// behavior the old req.body parsing already had.)
app.post('/convert', (req, res) => {
  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE } });
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }

  let format = 'jpeg';
  let quality = 85;
  let resizeWidth = null;
  let resizeHeight = null;

  const errors = [];
  const usedNames = new Set();
  const pending = [];
  const tempFiles = [];
  const openWriteStreams = new Set();
  let fileCount = 0;
  let aborted = false;
  let archive = null;

  // Diagnostic timing only (see SESSION_HANDOFF.md "flatten the per-photo
  // format time" investigation) -- decodeMs/encodeMs are the real per-file
  // cost; sumDecodeMs/sumEncodeMs vs wallMs on 'finish' isolates everything
  // else (upload overlap, zip compression, request overhead) as one bucket.
  const requestStart = performance.now();
  let totalDecodeMs = 0;
  let totalEncodeMs = 0;
  res.on('finish', () => {
    const wallMs = performance.now() - requestStart;
    console.log(
      `[timing] batch files=${fileCount} wallMs=${wallMs.toFixed(0)} ` +
      `sumDecodeMs=${totalDecodeMs.toFixed(0)} sumEncodeMs=${totalEncodeMs.toFixed(0)} ` +
      `otherMs=${(wallMs - totalDecodeMs - totalEncodeMs).toFixed(0)}`
    );
  });

  // If the client disconnects mid-upload (observed in practice: a dropped
  // home connection killing the request partway through a batch), whichever
  // file was still being written never fires its writeStream 'finish' event,
  // so the per-file cleanup below never runs and the temp file leaks forever.
  // Since /tmp here is tmpfs (shares RAM with the app itself), that leak
  // silently eats the instance's memory across repeated aborted requests --
  // this is a real, observed failure mode, not a hypothetical one. Destroy
  // any still-open write streams and unlink every temp file this request
  // created, regardless of how far each one got.
  function cleanupOnAbort() {
    aborted = true;
    for (const ws of openWriteStreams) ws.destroy();
    for (const p of tempFiles) fs.unlink(p).catch(() => {});
  }
  req.on('aborted', cleanupOnAbort);
  bb.on('error', (err) => {
    console.error('Upload parse error:', err.message);
    cleanupOnAbort();
    if (!res.headersSent) res.status(400).json({ error: err.message });
  });

  function ensureArchiveStarted() {
    if (archive) return;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="converted.zip"');
    archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      aborted = true;
      res.destroy(err);
    });
    archive.pipe(res);
  }

  async function processFile(tempPath, baseName) {
    const fileStart = performance.now();
    try {
      const tiffBuffer = await withDecodeSlot(() => decodeRawToTiff(tempPath));
      const decodeEnd = performance.now();

      let pipeline = sharp(tiffBuffer);
      if (resizeWidth || resizeHeight) {
        pipeline = pipeline.resize(resizeWidth || null, resizeHeight || null, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }
      if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
      else if (format === 'webp') pipeline = pipeline.webp({ quality });
      else pipeline = pipeline.png();
      const outputBuffer = await pipeline.toBuffer();
      const encodeEnd = performance.now();

      const decodeMs = decodeEnd - fileStart;
      const encodeMs = encodeEnd - decodeEnd;
      totalDecodeMs += decodeMs;
      totalEncodeMs += encodeMs;
      console.log(
        `[timing] file=${baseName} decodeMs=${decodeMs.toFixed(0)} encodeMs=${encodeMs.toFixed(0)} ` +
        `tiffBytes=${tiffBuffer.length} outBytes=${outputBuffer.length}`
      );

      if (aborted) return;
      ensureArchiveStarted();
      let entryName = `${baseName}.${EXT_FOR_FORMAT[format]}`;
      let dupeCount = 1;
      while (usedNames.has(entryName)) {
        entryName = `${baseName}-${++dupeCount}.${EXT_FOR_FORMAT[format]}`;
      }
      usedNames.add(entryName);
      archive.append(outputBuffer, { name: entryName });
    } catch (err) {
      console.error(`Failed to convert ${baseName}:`, err.message);
      errors.push(`${baseName}: ${err.message}`);
    } finally {
      fs.unlink(tempPath).catch(() => {});
    }
  }

  bb.on('field', (name, value) => {
    if (name === 'format' && FORMATS.has(value)) format = value;
    else if (name === 'quality') quality = Math.min(100, Math.max(1, parseInt(value, 10) || 85));
    else if (name === 'resizeWidth') resizeWidth = parseInt(value, 10) || null;
    else if (name === 'resizeHeight') resizeHeight = parseInt(value, 10) || null;
  });

  bb.on('file', (name, stream, info) => {
    if (name !== 'files') {
      stream.resume();
      return;
    }
    fileCount++;
    const originalname = info.filename || 'file';
    const baseName = path.parse(sanitizeFilename(originalname)).name;
    const tempPath = path.join(
      os.tmpdir(),
      `rawconv-${Date.now()}-${Math.random().toString(36).slice(2)}-${sanitizeFilename(originalname)}`
    );

    tempFiles.push(tempPath);

    let truncated = false;
    stream.on('limit', () => { truncated = true; });

    const writeStream = fsSync.createWriteStream(tempPath);
    openWriteStreams.add(writeStream);
    stream.pipe(writeStream);

    pending.push(new Promise((resolve) => {
      // 'close' is the catch-all: it fires after 'finish', after 'error', and
      // after an explicit destroy() with no error -- listening for it too
      // (on top of 'finish'/'error') guarantees this promise always settles,
      // even when cleanupOnAbort() destroys the stream directly. A promise
      // only ever resolves once, so 'finish' then 'close' both firing is safe.
      writeStream.on('finish', () => { openWriteStreams.delete(writeStream); resolve(); });
      writeStream.on('error', (err) => {
        openWriteStreams.delete(writeStream);
        errors.push(`${originalname}: ${err.message}`);
        fs.unlink(tempPath).catch(() => {});
        resolve();
      });
      writeStream.on('close', () => { openWriteStreams.delete(writeStream); resolve(); });
    }).then(async () => {
      if (aborted) return; // cleanupOnAbort() already unlinked tempPath -- nothing to decode
      if (truncated) {
        errors.push(`${originalname}: exceeds ${MAX_FILE_SIZE} byte limit`);
        fs.unlink(tempPath).catch(() => {});
        return;
      }
      await processFile(tempPath, baseName);
    }));
  });

  bb.on('close', async () => {
    await Promise.all(pending);
    if (aborted) return; // response already handled (or impossible to send) via cleanupOnAbort's caller

    if (!fileCount) {
      res.status(400).json({ error: 'No files uploaded' });
      return;
    }

    ensureArchiveStarted();
    if (errors.length) {
      archive.append(errors.join('\n') + '\n', { name: '_errors.txt' });
    }
    await archive.finalize();
  });

  req.pipe(bb);
});

function decodeRawToTiff(inputPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'dcraw_emu',
      ['-T', '-w', '-q', '3', '-o', '1', '-Z', '-', inputPath],
      { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') {
            reject(new Error('dcraw_emu not found on PATH -- is LibRaw installed?'));
          } else {
            reject(new Error(stderr?.toString().trim() || err.message));
          }
          return;
        }
        resolve(stdout);
      }
    );
  });
}

const server = app.listen(PORT, () => {
  console.log(`RAW photo converter listening on port ${PORT}`);
});
// Node's default requestTimeout (300s, covers the whole time to receive the
// request body) killed real batches with an HTTP 408 well before any actual
// resource ceiling was reached -- confirmed via load testing (N=25 failed at
// ~302s with plenty of free CPU/RAM). Disabled entirely rather than just
// raised, since a large batch's legitimate upload time scales with N and
// there's no single safe fixed number to pick instead. Low risk here: this
// is a single-user, Basic-Auth-protected test app, not a public endpoint.
server.requestTimeout = 0;

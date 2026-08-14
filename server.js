// RAW decode is shelled out to the native `dcraw_emu` binary (part of LibRaw).
// libraw-wasm was tried first but its Emscripten build only knows how to load
// its .wasm binary via browser fetch()/XMLHttpRequest, neither of which work
// inside a plain Node worker thread -- decode calls hung forever instead of
// erroring. dcraw_emu has no such dependency and decodes a 26MP RAW in ~3s
// even on a t3.small. It must be built from source and on PATH -- see
// SESSION_HANDOFF.md for the build steps (not an npm package).
import express from 'express';
import morgan from 'morgan';
import multer from 'multer';
import sharp from 'sharp';
import archiver from 'archiver';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, `rawconv-${Date.now()}-${Math.random().toString(36).slice(2)}-${sanitizeFilename(file.originalname)}`);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 30 }
});

// jungle-theme.js gets iterated on frequently during design review -- never let
// browsers cache it, so redeploys show up without a manual hard refresh.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('jungle-theme.js')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

app.post('/convert', upload.array('files', 30), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    res.status(400).json({ error: 'No files uploaded' });
    return;
  }

  const format = FORMATS.has(req.body.format) ? req.body.format : 'jpeg';
  const quality = Math.min(100, Math.max(1, parseInt(req.body.quality, 10) || 85));
  const resizeWidth = parseInt(req.body.resizeWidth, 10) || null;
  const resizeHeight = parseInt(req.body.resizeHeight, 10) || null;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="converted.zip"');

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Archive error:', err);
    res.destroy(err);
  });
  archive.pipe(res);

  const errors = [];
  const usedNames = new Set();

  for (const file of files) {
    const baseName = path.parse(sanitizeFilename(file.originalname)).name;
    try {
      const outputBuffer = await convertRaw(file.path, { format, quality, resizeWidth, resizeHeight });

      let entryName = `${baseName}.${EXT_FOR_FORMAT[format]}`;
      let dupeCount = 1;
      while (usedNames.has(entryName)) {
        entryName = `${baseName}-${++dupeCount}.${EXT_FOR_FORMAT[format]}`;
      }
      usedNames.add(entryName);

      archive.append(outputBuffer, { name: entryName });
    } catch (err) {
      console.error(`Failed to convert ${file.originalname}:`, err.message);
      errors.push(`${file.originalname}: ${err.message}`);
    } finally {
      fs.unlink(file.path).catch(() => {});
    }
  }

  if (errors.length) {
    archive.append(errors.join('\n') + '\n', { name: '_errors.txt' });
  }

  await archive.finalize();
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

async function convertRaw(inputPath, { format, quality, resizeWidth, resizeHeight }) {
  const tiffBuffer = await decodeRawToTiff(inputPath);

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

  return await pipeline.toBuffer();
}

app.listen(PORT, () => {
  console.log(`RAW photo converter listening on port ${PORT}`);
});

// RAW decode is shelled out to the native `dcraw_emu` binary (part of LibRaw).
// libraw-wasm was tried first but its Emscripten build only knows how to load
// its .wasm binary via browser fetch()/XMLHttpRequest, neither of which work
// inside a plain Node worker thread -- decode calls hung forever instead of
// erroring. dcraw_emu has no such dependency and decodes a 26MP RAW in ~3s
// even on a t3.small. It must be built from source and on PATH -- see
// SESSION_HANDOFF.md for the build steps (not an npm package).
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import archiver from 'archiver';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const FORMATS = new Set(['jpeg', 'webp', 'png']);
const EXT_FOR_FORMAT = { jpeg: 'jpg', webp: 'webp', png: 'png' };

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => {
      cb(null, `rawconv-${Date.now()}-${Math.random().toString(36).slice(2)}-${file.originalname}`);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 30 }
});

app.use(express.static(path.join(__dirname, 'public')));

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
    const baseName = path.parse(file.originalname).name;
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

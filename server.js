// libraw-wasm's worker.js uses browser Worker globals (self.onmessage/postMessage).
// Plain Node has no global Worker, so polyfill it before libraw-wasm ever runs.
import Worker from 'web-worker';
globalThis.Worker = Worker;

import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import archiver from 'archiver';
import LibRaw from 'libraw-wasm';
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
      const buffer = await fs.readFile(file.path);
      const outputBuffer = await convertRaw(buffer, { format, quality, resizeWidth, resizeHeight });

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

async function convertRaw(buffer, { format, quality, resizeWidth, resizeHeight }) {
  const raw = new LibRaw();
  try {
    await raw.open(new Uint8Array(buffer), { outputBps: 8, outputColor: 1 });
    const img = await raw.imageData();
    if (!img || !img.data || !img.data.length) {
      throw new Error('Decoder returned no image data');
    }

    let pipeline = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
      raw: { width: img.width, height: img.height, channels: img.colors }
    });

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
  } finally {
    raw.dispose();
  }
}

app.listen(PORT, () => {
  console.log(`RAW photo converter listening on port ${PORT}`);
});

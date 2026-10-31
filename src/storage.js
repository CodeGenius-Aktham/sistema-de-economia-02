'use strict';

/**
 * Almacenamiento de los materiales:
 *  - "local": carpeta DATA_DIR/uploads (tu computadora, un VPS, Docker…).
 *  - "blob":  Vercel Blob privado. Se activa solo cuando existe BLOB_READ_WRITE_TOKEN.
 *    Los archivos se suben directo desde el navegador y se entregan a través del
 *    servidor, que comprueba la sesión antes de enviarlos.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { env, UPLOAD_DIR, IS_VERCEL } = require('./db');

const BLOB_TOKEN = env('BLOB_READ_WRITE_TOKEN');
const MODE = BLOB_TOKEN ? 'blob' : IS_VERCEL ? 'missing' : 'local';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || (MODE === 'blob' ? 100 : 50);

let blobSdk = null;
const blob = () => (blobSdk ||= require('@vercel/blob'));

const INLINE_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
};

function contentDisposition(type, filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const isBlobFile = (m) => m && m.kind === 'file' && typeof m.url === 'string' && /^https:\/\//.test(m.url);

/** Envía el archivo de un material al navegador (ver en línea o descargar). */
async function sendFile(req, res, m) {
  const name = m.original_name || m.file_name || 'archivo';
  const ext = path.extname(name).toLowerCase();
  const inlineType = INLINE_TYPES[ext];
  const inline = req.query.download !== '1' && inlineType;
  const headers = {
    'Content-Type': inline ? inlineType : 'application/octet-stream',
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'X-Content-Type-Options': 'nosniff',
  };

  if (isBlobFile(m)) {
    if (!BLOB_TOKEN) return res.status(503).json({ error: 'El almacenamiento de archivos no está configurado' });
    const result = await blob().get(m.url, {
      access: 'private',
      token: BLOB_TOKEN,
      ifNoneMatch: req.headers['if-none-match'] || undefined,
    });
    if (!result) return res.status(404).json({ error: 'El archivo ya no está disponible' });
    if (result.statusCode === 304) {
      res.set({ ETag: result.blob.etag, 'Cache-Control': 'private, no-cache' });
      return res.status(304).end();
    }
    res.set({ ...headers, ETag: result.blob.etag, 'Cache-Control': 'private, no-cache' });
    if (result.blob.size) res.set('Content-Length', String(result.blob.size));
    await new Promise((resolve, reject) => {
      Readable.fromWeb(result.stream).on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
    });
    return;
  }

  const filePath = path.join(UPLOAD_DIR, path.basename(m.file_name || ''));
  if (!m.file_name || !fs.existsSync(filePath)) return res.status(404).json({ error: 'El archivo ya no está disponible' });
  res.set({ ...headers, 'Cache-Control': 'private, max-age=3600' });
  res.sendFile(filePath);
}

/** Borra los archivos (locales o en Blob) de los materiales indicados. */
async function removeFiles(rows) {
  const blobs = [];
  for (const r of rows) {
    if (!r || r.kind === 'link') continue;
    if (isBlobFile(r)) blobs.push(r.url);
    else if (r.file_name) fs.rm(path.join(UPLOAD_DIR, path.basename(r.file_name)), { force: true }, () => {});
  }
  if (blobs.length && BLOB_TOKEN) {
    try {
      await blob().del(blobs, { token: BLOB_TOKEN });
    } catch (err) {
      console.error('No se pudieron borrar algunos archivos de Blob:', err.message);
    }
  }
}

/** Guarda un archivo generado en el servidor (datos de ejemplo). */
async function saveBuffer(name, buffer, contentType) {
  if (MODE === 'blob') {
    const r = await blob().put(`materiales/demo/${name}`, buffer, {
      access: 'private',
      token: BLOB_TOKEN,
      contentType,
      addRandomSuffix: true,
    });
    return { file_name: r.pathname, url: r.url, size: buffer.length };
  }
  const stored = crypto.randomUUID() + path.extname(name).toLowerCase();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
  return { file_name: stored, url: null, size: buffer.length };
}

/** Atiende la petición del navegador que pide permiso para subir a Blob. */
async function handleClientUpload(req) {
  const { handleUpload } = require('@vercel/blob/client');
  return handleUpload({
    token: BLOB_TOKEN,
    request: req,
    body: req.body,
    onBeforeGenerateToken: async (pathname) => {
      if (typeof pathname !== 'string' || !/^materiales\/\d+\/[^/]+$/.test(pathname)) {
        throw Object.assign(new Error('Ruta de archivo no permitida'), { status: 400 });
      }
      return {
        addRandomSuffix: true,
        maximumSizeInBytes: MAX_UPLOAD_MB * 1024 * 1024,
      };
    },
  });
}

/** Valida los datos de un archivo ya subido a Blob desde el navegador. */
function validBlobUpload(f) {
  if (!f || typeof f !== 'object') return false;
  let u;
  try {
    u = new URL(String(f.url));
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname.endsWith('.blob.vercel-storage.com') &&
    u.pathname.startsWith('/materiales/') &&
    typeof f.pathname === 'string' &&
    f.pathname.startsWith('materiales/')
  );
}

module.exports = {
  MODE,
  MAX_UPLOAD_MB,
  sendFile,
  removeFiles,
  saveBuffer,
  handleClientUpload,
  validBlobUpload,
  isBlobFile,
};

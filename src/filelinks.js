'use strict';

/**
 * Enlaces firmados y temporales para "Ver" y "Descargar".
 * En el teléfono, los archivos a menudo se abren en otro navegador, en el visor de
 * PDF o en el gestor de descargas, que no llevan la sesión del portal. Con la firma
 * el archivo se entrega igual, y el enlace caduca a las pocas horas.
 */

const crypto = require('node:crypto');
const { get, run } = require('./db');

const TTL_SECONDS = 12 * 3600;
let secret = null;

async function getSecret() {
  if (secret) return secret;
  let row = await get("SELECT value FROM settings WHERE key = 'file_secret'");
  if (!row) {
    await run("INSERT OR IGNORE INTO settings (key, value) VALUES ('file_secret', ?)", crypto.randomBytes(32).toString('hex'));
    row = await get("SELECT value FROM settings WHERE key = 'file_secret'");
  }
  secret = row.value;
  return secret;
}

const signature = (key, materialId, exp) =>
  crypto.createHmac('sha256', key).update(`${materialId}.${exp}`).digest('base64url').slice(0, 32);

/** Agrega file_url (con firma) a cada material de tipo archivo. */
async function addFileUrls(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.some((r) => r && r.kind === 'file')) return rows;
  const key = await getSecret();
  // Se redondea a la hora para que el enlace no cambie en cada recarga.
  const exp = Math.ceil(Date.now() / 3600000) * 3600 + TTL_SECONDS;
  for (const r of list) {
    if (r && r.kind === 'file') r.file_url = `/api/materials/${r.id}/file?exp=${exp}&sig=${signature(key, r.id, exp)}`;
  }
  return rows;
}

/** ¿La firma del enlace es válida y no ha caducado? */
async function verify(materialId, exp, sig) {
  const e = Number(exp);
  if (!materialId || !Number.isInteger(e) || typeof sig !== 'string' || sig.length !== 32) return false;
  if (e * 1000 < Date.now() || e * 1000 > Date.now() + (TTL_SECONDS + 7200) * 1000) return false;
  const expected = Buffer.from(signature(await getSecret(), materialId, e));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { addFileUrls, verify };

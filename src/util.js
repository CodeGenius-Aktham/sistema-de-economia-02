'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (msg) => new HttpError(400, msg);
const notFound = (msg = 'No encontrado') => new HttpError(404, msg);

/** Texto recortado; devuelve null si queda vacío. */
function str(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

function requiredStr(value, label, max = 200) {
  const s = str(value, max);
  if (!s) throw bad(`El campo "${label}" es obligatorio`);
  return s;
}

function int(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function id(value) {
  const n = int(value);
  return n && n > 0 ? n : null;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isTime(s) {
  return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function optDate(value, label) {
  const s = str(value, 10);
  if (!s) return null;
  if (!isDate(s)) throw bad(`La fecha "${label}" no es válida`);
  return s;
}

function optTime(value, label) {
  const s = str(value, 5);
  if (!s) return null;
  if (!isTime(s)) throw bad(`La hora "${label}" no es válida`);
  return s;
}

function isColor(s) {
  return typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
}

/**
 * Normaliza una cédula: quita puntos, guiones y espacios, pasa a mayúsculas
 * y elimina el prefijo de nacionalidad (V- / E-) para que "V-12.345.678"
 * y "12345678" se consideren la misma cédula.
 */
function normalizeCedula(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/^[VE](?=\d)/, '')
    .slice(0, 20);
}

function isValidCedula(c) {
  return /^[0-9A-Z]{4,20}$/.test(c) && /\d/.test(c);
}

function normalizeEmail(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().toLowerCase().slice(0, 160);
}

function isEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Teléfono: dígitos con +, espacios, guiones, puntos o paréntesis (6 a 15 dígitos). */
function normalizePhone(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim().replace(/\s+/g, ' ').slice(0, 30);
}

function isPhone(s) {
  const digits = s.replace(/\D/g, '');
  return /^\+?[\d\s().-]+$/.test(s) && digits.length >= 6 && digits.length <= 15;
}

function isHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Fecha local del servidor en formato YYYY-MM-DD (o la que envía el cliente). */
function today(req) {
  const q = req && req.query && req.query.today;
  if (typeof q === 'string' && isDate(q)) return q;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

module.exports = {
  HttpError,
  bad,
  notFound,
  str,
  requiredStr,
  int,
  id,
  isDate,
  isTime,
  optDate,
  optTime,
  isColor,
  normalizeCedula,
  isValidCedula,
  normalizeEmail,
  isEmail,
  normalizePhone,
  isPhone,
  isHttpUrl,
  today,
};

'use strict';

// En Vercel sin Turso ni Blob configurados: el portal avisa qué falta en vez de fallar.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.VERCEL = '1';
for (const k of Object.keys(process.env)) if (/TURSO|LIBSQL|BLOB|DATA_DIR|DATABASE_URL/.test(k)) delete process.env[k];
const app = require('../server.js');

let server;
let base;
before(() => new Promise((r) => (server = app.listen(0, '127.0.0.1', () => ((base = `http://127.0.0.1:${server.address().port}`), r())))));
after(() => server.close());

test('estado del sistema sin configurar en Vercel', async () => {
  const h = await (await fetch(base + '/api/health')).json();
  assert.equal(h.ok, false);
  assert.equal(h.en_vercel, true);
  assert.equal(h.base_de_datos, 'falta configurar');
  assert.equal(h.archivos, 'falta conectar Vercel Blob');
});

test('las páginas muestran el aviso de configuración', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 503);
  assert.match(await res.text(), /Falta un paso de configuración/);
});

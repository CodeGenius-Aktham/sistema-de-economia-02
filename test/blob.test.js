'use strict';

// Modo Vercel Blob: el navegador sube los archivos directo a Blob y el servidor
// solo firma el permiso y registra el material. (No se contacta a Vercel en la prueba.)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-blob-'));
process.env.ADMIN_PASSWORD = 'clave-segura-123';
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_TeStStOrEiD123_' + 'x'.repeat(30);
const app = require('../server.js');

let server;
let base;
before(
  () =>
    new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        base = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    })
);
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const headers = cookie ? { cookie } : {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* vacío */
    }
    return { status: res.status, data };
  };
}

const admin = client();
const ids = {};

test('estado del sistema: Blob conectado', async () => {
  const h = await client()('GET', '/api/health');
  assert.equal(h.data.archivos, 'vercel blob conectado');
  assert.equal(h.data.archivos_ok, true);
});

test('configuración en modo blob', async () => {
  assert.equal((await admin('POST', '/api/auth/login/admin', { username: 'admin', password: 'clave-segura-123' })).status, 200);
  const s = await admin('GET', '/api/admin/settings');
  assert.equal(s.data.storage, 'blob');
  assert.equal(s.data.max_upload_mb, 100);
  assert.equal(s.data.system.archivos_ok, true);
  ids.sem = (await admin('POST', '/api/admin/semesters', { name: 'Semestre I' })).data.id;
  ids.sub = (await admin('POST', '/api/admin/subjects', { semester_id: ids.sem, name: 'Microeconomía' })).data.id;
});

test('solo el admin obtiene permiso de subida y solo dentro de materiales/', async () => {
  const anon = client();
  const payload = { type: 'blob.generate-client-token', payload: { pathname: `materiales/${ids.sub}/guia.pdf`, clientPayload: null, multipart: false } };
  assert.equal((await anon('POST', '/api/admin/blob-upload', payload)).status, 401);

  const ok = await admin('POST', '/api/admin/blob-upload', payload);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.type, 'blob.generate-client-token');
  assert.match(ok.data.clientToken, /^vercel_blob_client_TeStStOrEiD123_/);

  const bad = await admin('POST', '/api/admin/blob-upload', { ...payload, payload: { ...payload.payload, pathname: '../otra/cosa.pdf' } });
  assert.equal(bad.status, 400);
  const weird = await admin('POST', '/api/admin/blob-upload', { type: 'blob.upload-completed', payload: {} });
  assert.equal(weird.status, 400);
});

test('registrar archivos ya subidos a Blob', async () => {
  const good = {
    url: `https://testtestoreid123.private.blob.vercel-storage.com/materiales/${ids.sub}/guia-AbC123.pdf`,
    pathname: `materiales/${ids.sub}/guia-AbC123.pdf`,
    name: 'Guía de ejercicios.pdf',
    size: 2048,
    contentType: 'application/pdf',
  };
  const r = await admin('POST', '/api/admin/materials', { subject_id: ids.sub, kind: 'file', files: [good] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data[0].title, 'Guía de ejercicios');
  assert.equal(r.data[0].original_name, 'Guía de ejercicios.pdf');
  assert.equal(r.data[0].url, null, 'la URL privada no se expone');

  const evil = await admin('POST', '/api/admin/materials', { subject_id: ids.sub, kind: 'file', files: [{ ...good, url: 'https://evil.example.com/materiales/x.pdf' }] });
  assert.equal(evil.status, 400);

  const none = await admin('POST', '/api/admin/materials', { subject_id: ids.sub, kind: 'file' });
  assert.equal(none.status, 400);

  const detail = await admin('GET', `/api/subjects/${ids.sub}`);
  assert.equal(detail.data.materials.length, 1);
  assert.equal(detail.data.materials[0].url, null);
});

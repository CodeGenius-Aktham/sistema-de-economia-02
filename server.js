'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const { get, run } = require('./src/db');
const auth = require('./src/auth');
const { HttpError } = require('./src/util');
const authRoutes = require('./src/routes/auth');
const portalRoutes = require('./src/routes/portal');
const adminRoutes = require('./src/routes/admin');
const pkg = require('./package.json');

/* ---------- administrador inicial ---------- */

if (!get('SELECT id FROM admins LIMIT 1')) {
  const username = process.env.ADMIN_USER || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  run(
    'INSERT INTO admins (username, name, password_hash, must_change) VALUES (?, ?, ?, ?)',
    username,
    'Administrador',
    auth.hashPassword(password),
    process.env.ADMIN_PASSWORD ? 0 : 1
  );
  console.log(`\n  Administrador creado → usuario: "${username}"` + (process.env.ADMIN_PASSWORD ? '' : `, contraseña: "${password}" (cámbiala al entrar)`) + '\n');
}
auth.cleanupSessions();

/* ---------- app ---------- */

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const v = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(auth.loadSession);

/* ---------- API ---------- */

app.use('/api/auth', authRoutes.router);
app.use('/api/admin', adminRoutes.router);
app.use('/api', portalRoutes.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

/* ---------- páginas ---------- */

const VIEWS = path.join(__dirname, 'views');
const ASSET_VERSION = `${pkg.version}-${Date.now().toString(36)}`;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self'",
  "frame-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const pages = {};
for (const name of ['login', 'app', 'admin']) {
  pages[name] = fs.readFileSync(path.join(VIEWS, `${name}.html`), 'utf8').replaceAll('__V__', ASSET_VERSION);
}

function sendPage(res, name) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(pages[name]);
}

app.get('/', (req, res) => {
  if (req.auth) return res.redirect(req.auth.role === 'admin' ? '/admin' : '/app');
  sendPage(res, 'login');
});

app.get('/app', (req, res) => {
  if (!req.auth) return res.redirect('/');
  sendPage(res, 'app');
});

app.get('/admin', (req, res) => {
  if (!req.auth || req.auth.role !== 'admin') return res.redirect('/');
  sendPage(res, 'admin');
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: '7d',
  })
);

app.use((req, res) => {
  if (req.method === 'GET' && req.accepts('html')) return res.redirect('/');
  res.status(404).send('No encontrado');
});

/* ---------- errores ---------- */

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Error inesperado';
  if (err instanceof multer.MulterError) {
    status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `El archivo supera el tamaño máximo de ${adminRoutes.MAX_UPLOAD_MB} MB`
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Puedes subir máximo 20 archivos a la vez'
          : 'No se pudo procesar el archivo';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Solicitud inválida';
  } else if (!(err instanceof HttpError) && status >= 500) {
    console.error(err);
    message = 'Ocurrió un error en el servidor';
  }
  if (res.headersSent) return;
  res.status(status).json({ error: message });
});

/* ---------- inicio ---------- */

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`  Portal académico listo en http://localhost:${PORT}`);
  });
}

module.exports = app;

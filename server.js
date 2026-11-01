'use strict';

// Variables de entorno desde .env (solo si existe; en Vercel se configuran en el panel).
try {
  process.loadEnvFile();
} catch {
  /* sin archivo .env */
}

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');

const db = require('./src/db');
const storage = require('./src/storage');
const auth = require('./src/auth');
const { HttpError } = require('./src/util');
const { systemStatus } = require('./src/status');
const authRoutes = require('./src/routes/auth');
const portalRoutes = require('./src/routes/portal');
const adminRoutes = require('./src/routes/admin');
const pkg = require('./package.json');

const app = express();
app.disable('x-powered-by');

if (process.env.TRUST_PROXY || db.IS_VERCEL) {
  const v = process.env.TRUST_PROXY || 'true';
  app.set('trust proxy', /^\d+$/.test(v) ? Number(v) : v === 'true' ? true : v);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Archivos estáticos (en Vercel los sirve su CDN desde public/ y esto se ignora).
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '7d' }));

/* ---------- páginas ---------- */

const ASSET_VERSION = `${pkg.version}-${Date.now().toString(36)}`;
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self'",
  "frame-src 'self'",
  `connect-src 'self'${storage.MODE === 'blob' ? ' https://vercel.com https://*.blob.vercel-storage.com' : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const page = (file) => fs.readFileSync(file, 'utf8').replaceAll('__V__', ASSET_VERSION);
const pages = {
  login: page(path.join(__dirname, 'views', 'login.html')),
  app: page(path.join(__dirname, 'views', 'app.html')),
  admin: page(path.join(__dirname, 'views', 'admin.html')),
};

function sendPage(res, name) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.send(pages[name]);
}

function setupErrorPage(message) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configuración pendiente</title><link rel="stylesheet" href="/css/styles.css?v=${ASSET_VERSION}"></head>
<body><div class="login-panel" style="min-height:100vh"><div class="login-card"><h2>Falta un paso de configuración</h2>
<div class="alert warn"><span>${message.replace(/[<>&]/g, '')}</span></div>
<p class="muted small">Revisa la guía de despliegue en el README del proyecto.</p></div></div></body></html>`;
}

/* ---------- estado del sistema (público, sin secretos) ---------- */

app.get('/api/health', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await systemStatus());
});

/* ---------- base de datos lista antes de atender ---------- */

app.use(async (req, res, next) => {
  try {
    await db.ready();
    next();
  } catch (err) {
    const message = err.status === 503 ? err.message : 'No se pudo conectar con la base de datos. Revisa TURSO_DATABASE_URL y TURSO_AUTH_TOKEN.';
    if (err.status !== 503) console.error(err);
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: message });
    res.status(503).type('html').send(setupErrorPage(message));
  }
});

app.use(express.json({ limit: '2mb' }));
app.use(auth.loadSession);

/* ---------- API ---------- */

app.use('/api/auth', authRoutes.router);
app.use('/api/admin', adminRoutes.router);
app.use('/api', portalRoutes.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

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
        ? `El archivo supera el tamaño máximo de ${storage.MAX_UPLOAD_MB} MB`
        : err.code === 'LIMIT_FILE_COUNT'
          ? 'Puedes subir máximo 20 archivos a la vez'
          : 'No se pudo procesar el archivo';
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Solicitud inválida';
  } else if (!(err instanceof HttpError) && status >= 500 && status !== 503) {
    console.error(err);
    message = 'Ocurrió un error en el servidor';
  }
  if (res.headersSent) return res.end();
  res.status(status).json({ error: message });
});

/* ---------- inicio (local) ---------- */

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, () => {
    console.log(`Portal académico listo en http://localhost:${PORT}`);
    console.log(`Base de datos: ${db.IS_REMOTE ? 'Turso (nube)' : 'archivo local en ' + db.DATA_DIR} · Archivos: ${storage.MODE === 'blob' ? 'Vercel Blob' : 'disco local'}`);
  });
}

module.exports = app;

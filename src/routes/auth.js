'use strict';

const express = require('express');
const { get, run, getSettings } = require('../db');
const auth = require('../auth');
const { HttpError, bad, str, normalizeCedula, isValidCedula, normalizeEmail, isEmail } = require('../util');

const router = express.Router();

function publicSettings() {
  const s = getSettings();
  return {
    site_name: s.site_name,
    site_tagline: s.site_tagline,
    university: s.university,
    period: s.period,
    welcome_message: s.welcome_message,
    allow_self_register: s.allow_self_register === '1',
  };
}

router.get('/settings', (req, res) => {
  res.json(publicSettings());
});

router.get('/me', (req, res) => {
  res.json({ auth: req.auth, settings: publicSettings() });
});

router.post('/login/student', (req, res) => {
  const cedula = normalizeCedula(req.body.cedula);
  const email = normalizeEmail(req.body.email);
  if (!isValidCedula(cedula)) throw bad('Escribe una cédula válida');
  if (!isEmail(email)) throw bad('Escribe un correo válido');

  auth.checkRateLimit(req, cedula);
  const generic = 'La cédula y el correo no coinciden con ningún estudiante registrado.';

  let student = get('SELECT * FROM students WHERE cedula = ?', cedula);
  if (student) {
    if (normalizeEmail(student.email) !== email) {
      auth.registerFailure(req, cedula);
      throw new HttpError(401, generic);
    }
    if (!student.active) throw new HttpError(403, 'Tu acceso está desactivado. Habla con el administrador.');
  } else {
    const settings = getSettings();
    if (settings.allow_self_register !== '1') {
      auth.registerFailure(req, cedula);
      throw new HttpError(401, generic + ' Pide al administrador que te agregue.');
    }
    const emailTaken = get('SELECT id FROM students WHERE email = ?', email);
    if (emailTaken) {
      auth.registerFailure(req, cedula);
      throw new HttpError(401, generic);
    }
    const info = run('INSERT INTO students (cedula, email, name) VALUES (?, ?, ?)', cedula, email, str(req.body.name, 120));
    student = get('SELECT * FROM students WHERE id = ?', info.lastInsertRowid);
  }

  auth.clearFailures(req, cedula);
  run("UPDATE students SET last_login = datetime('now') WHERE id = ?", student.id);
  auth.createSession(req, res, 'student', student.id);
  res.json({ ok: true, redirect: '/app' });
});

router.post('/login/admin', (req, res) => {
  const username = str(req.body.username, 80);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!username || !password) throw bad('Escribe tu usuario y contraseña');

  auth.checkRateLimit(req, 'admin:' + username);
  const admin = get('SELECT * FROM admins WHERE username = ?', username);
  if (!admin || !auth.verifyPassword(password, admin.password_hash)) {
    auth.registerFailure(req, 'admin:' + username);
    throw new HttpError(401, 'Usuario o contraseña incorrectos');
  }
  auth.clearFailures(req, 'admin:' + username);
  auth.createSession(req, res, 'admin', admin.id);
  res.json({ ok: true, redirect: '/admin' });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

module.exports = { router, publicSettings };

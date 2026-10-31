'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { all, get, run, tx, UPLOAD_DIR, getSettings, setSetting, unlinkFiles } = require('../db');
const auth = require('../auth');
const {
  HttpError,
  bad,
  notFound,
  str,
  requiredStr,
  int,
  id,
  optDate,
  optTime,
  isColor,
  normalizeCedula,
  isValidCedula,
  normalizeEmail,
  isEmail,
  isHttpUrl,
  today,
} = require('../util');
const { subjectDetail, listEvents, listMaterials, MATERIAL_SELECT } = require('./portal');

const router = express.Router();
router.use(auth.requireAdmin);

const EVENT_TYPES = ['examen', 'parcial', 'quiz', 'entrega', 'exposicion', 'otro'];
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 50;

/* ---------- subida de archivos ---------- */

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename(req, file, cb) {
      const ext = path
        .extname(file.originalname || '')
        .toLowerCase()
        .replace(/[^a-z0-9.]/g, '')
        .slice(0, 12);
      cb(null, crypto.randomUUID() + ext);
    },
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 },
});

/** Busboy entrega los nombres en latin1; los pasamos a UTF-8 para conservar tildes y ñ. */
function originalName(file) {
  const raw = file.originalname || 'archivo';
  const fixed = Buffer.from(raw, 'latin1').toString('utf8');
  return (fixed.includes('�') ? raw : fixed).slice(0, 200);
}

function removeUploaded(req) {
  const files = req.files || (req.file ? [req.file] : []);
  for (const f of files) fs.rm(f.path, { force: true }, () => {});
}

/** Ejecuta el handler y, si falla, borra los archivos recién subidos. */
const withUploadCleanup = (handler) => (req, res, next) => {
  try {
    handler(req, res, next);
  } catch (err) {
    removeUploaded(req);
    next(err);
  }
};

/* ---------- resumen ---------- */

router.get('/stats', (req, res) => {
  const t = today(req);
  const count = (sql, ...p) => get(sql, ...p).n;
  res.json({
    semesters: count('SELECT COUNT(*) AS n FROM semesters'),
    subjects: count('SELECT COUNT(*) AS n FROM subjects'),
    classes: count('SELECT COUNT(*) AS n FROM classes'),
    materials: count('SELECT COUNT(*) AS n FROM materials'),
    students: count('SELECT COUNT(*) AS n FROM students'),
    active_students: count('SELECT COUNT(*) AS n FROM students WHERE active = 1'),
    upcoming: count('SELECT COUNT(*) AS n FROM events WHERE date >= ?', t),
    storage_bytes: count("SELECT COALESCE(SUM(size), 0) AS n FROM materials WHERE kind = 'file'"),
    upcoming_events: listEvents({ from: t }).slice(0, 6),
    recent_materials: listMaterials({ limit: 6 }),
    must_change_password: !!req.auth.user.must_change,
  });
});

/* ---------- semestres ---------- */

function semesterInput(body) {
  return {
    name: requiredStr(body.name, 'Nombre', 80),
    number: int(body.number),
    period: str(body.period, 40),
    description: str(body.description, 1000),
    position: int(body.position) ?? 0,
  };
}

router.post('/semesters', (req, res) => {
  const s = semesterInput(req.body);
  const info = run(
    'INSERT INTO semesters (name, number, period, description, position) VALUES (?, ?, ?, ?, ?)',
    s.name,
    s.number,
    s.period,
    s.description,
    s.position
  );
  res.status(201).json(get('SELECT * FROM semesters WHERE id = ?', info.lastInsertRowid));
});

router.put('/semesters/:id', (req, res) => {
  const semId = id(req.params.id);
  if (!get('SELECT id FROM semesters WHERE id = ?', semId)) throw notFound('El semestre no existe');
  const s = semesterInput(req.body);
  run(
    'UPDATE semesters SET name = ?, number = ?, period = ?, description = ?, position = ? WHERE id = ?',
    s.name,
    s.number,
    s.period,
    s.description,
    s.position,
    semId
  );
  res.json(get('SELECT * FROM semesters WHERE id = ?', semId));
});

router.delete('/semesters/:id', (req, res) => {
  const semId = id(req.params.id);
  const files = all(
    'SELECT m.file_name FROM materials m JOIN subjects s ON s.id = m.subject_id WHERE s.semester_id = ?',
    semId
  );
  const info = run('DELETE FROM semesters WHERE id = ?', semId);
  if (!info.changes) throw notFound('El semestre no existe');
  unlinkFiles(files);
  res.json({ ok: true });
});

/* ---------- materias ---------- */

function subjectInput(body) {
  const semesterId = id(body.semester_id);
  if (!semesterId || !get('SELECT id FROM semesters WHERE id = ?', semesterId)) throw bad('Selecciona un semestre válido');
  const email = normalizeEmail(body.professor_email);
  if (email && !isEmail(email)) throw bad('El correo del profesor no es válido');
  return {
    semester_id: semesterId,
    name: requiredStr(body.name, 'Nombre de la materia', 120),
    code: str(body.code, 30),
    professor: str(body.professor, 120),
    professor_email: email || null,
    schedule: str(body.schedule, 200),
    classroom: str(body.classroom, 120),
    credits: int(body.credits),
    description: str(body.description, 10000),
    color: isColor(body.color) ? body.color.toLowerCase() : '#6366f1',
    position: int(body.position) ?? 0,
  };
}

const SUBJECT_FIELDS = [
  'semester_id',
  'name',
  'code',
  'professor',
  'professor_email',
  'schedule',
  'classroom',
  'credits',
  'description',
  'color',
  'position',
];

router.post('/subjects', (req, res) => {
  const s = subjectInput(req.body);
  const info = run(
    `INSERT INTO subjects (${SUBJECT_FIELDS.join(', ')}) VALUES (${SUBJECT_FIELDS.map(() => '?').join(', ')})`,
    ...SUBJECT_FIELDS.map((f) => s[f])
  );
  res.status(201).json(subjectDetail(info.lastInsertRowid));
});

router.put('/subjects/:id', (req, res) => {
  const subjectId = id(req.params.id);
  if (!get('SELECT id FROM subjects WHERE id = ?', subjectId)) throw notFound('La materia no existe');
  const s = subjectInput(req.body);
  run(
    `UPDATE subjects SET ${SUBJECT_FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...SUBJECT_FIELDS.map((f) => s[f]),
    subjectId
  );
  res.json(subjectDetail(subjectId));
});

router.delete('/subjects/:id', (req, res) => {
  const subjectId = id(req.params.id);
  const files = all('SELECT file_name FROM materials WHERE subject_id = ?', subjectId);
  const info = run('DELETE FROM subjects WHERE id = ?', subjectId);
  if (!info.changes) throw notFound('La materia no existe');
  unlinkFiles(files);
  res.json({ ok: true });
});

/* ---------- clases ---------- */

function classInput(body) {
  const subjectId = id(body.subject_id);
  if (!subjectId || !get('SELECT id FROM subjects WHERE id = ?', subjectId)) throw bad('Selecciona una materia válida');
  return {
    subject_id: subjectId,
    title: requiredStr(body.title, 'Título de la clase', 200),
    date: optDate(body.date, 'Fecha'),
    content: str(body.content, 20000),
  };
}

router.post('/classes', (req, res) => {
  const c = classInput(req.body);
  const info = run(
    'INSERT INTO classes (subject_id, title, date, content) VALUES (?, ?, ?, ?)',
    c.subject_id,
    c.title,
    c.date,
    c.content
  );
  res.status(201).json(get('SELECT * FROM classes WHERE id = ?', info.lastInsertRowid));
});

router.put('/classes/:id', (req, res) => {
  const classId = id(req.params.id);
  if (!get('SELECT id FROM classes WHERE id = ?', classId)) throw notFound('La clase no existe');
  const c = classInput(req.body);
  run(
    'UPDATE classes SET subject_id = ?, title = ?, date = ?, content = ? WHERE id = ?',
    c.subject_id,
    c.title,
    c.date,
    c.content,
    classId
  );
  res.json(get('SELECT * FROM classes WHERE id = ?', classId));
});

router.delete('/classes/:id', (req, res) => {
  const info = run('DELETE FROM classes WHERE id = ?', id(req.params.id));
  if (!info.changes) throw notFound('La clase no existe');
  res.json({ ok: true });
});

/* ---------- materiales ---------- */

function materialTarget(body) {
  const subjectId = id(body.subject_id);
  if (!subjectId || !get('SELECT id FROM subjects WHERE id = ?', subjectId)) throw bad('Selecciona una materia válida');
  let classId = id(body.class_id);
  if (classId && !get('SELECT id FROM classes WHERE id = ? AND subject_id = ?', classId, subjectId)) classId = null;
  return { subjectId, classId };
}

const stripExt = (name) => name.replace(/\.[^.]+$/, '');

router.post(
  '/materials',
  upload.array('files', 20),
  withUploadCleanup((req, res) => {
    const { subjectId, classId } = materialTarget(req.body);
    const description = str(req.body.description, 5000);
    const title = str(req.body.title, 200);
    const kind = req.body.kind === 'link' ? 'link' : 'file';

    if (kind === 'link') {
      const url = str(req.body.url, 2000);
      if (!url || !isHttpUrl(url)) throw bad('Escribe un enlace válido (debe empezar por http:// o https://)');
      const info = run(
        "INSERT INTO materials (subject_id, class_id, title, description, kind, url) VALUES (?, ?, ?, ?, 'link', ?)",
        subjectId,
        classId,
        title || url,
        description,
        url
      );
      return res.status(201).json([get(`${MATERIAL_SELECT} WHERE m.id = ?`, info.lastInsertRowid)]);
    }

    const files = req.files || [];
    if (!files.length) throw bad('Selecciona al menos un archivo');
    const ids = tx(() =>
      files.map((f) => {
        const name = originalName(f);
        let t = stripExt(name);
        if (title) t = files.length === 1 ? title : `${title} · ${stripExt(name)}`;
        return run(
          `INSERT INTO materials (subject_id, class_id, title, description, kind, file_name, original_name, mime, size)
           VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?)`,
          subjectId,
          classId,
          t.slice(0, 200),
          description,
          f.filename,
          name,
          str(f.mimetype, 120),
          f.size
        ).lastInsertRowid;
      })
    );
    res.status(201).json(ids.map((mid) => get(`${MATERIAL_SELECT} WHERE m.id = ?`, mid)));
  })
);

router.put(
  '/materials/:id',
  upload.single('file'),
  withUploadCleanup((req, res) => {
    const materialId = id(req.params.id);
    const current = get('SELECT * FROM materials WHERE id = ?', materialId);
    if (!current) throw notFound('El material no existe');
    const { subjectId, classId } = materialTarget(req.body);
    const title = requiredStr(req.body.title, 'Título', 200);
    const description = str(req.body.description, 5000);

    if (current.kind === 'link') {
      const url = str(req.body.url, 2000);
      if (!url || !isHttpUrl(url)) throw bad('Escribe un enlace válido (debe empezar por http:// o https://)');
      run(
        'UPDATE materials SET subject_id = ?, class_id = ?, title = ?, description = ?, url = ? WHERE id = ?',
        subjectId,
        classId,
        title,
        description,
        url,
        materialId
      );
    } else if (req.file) {
      run(
        `UPDATE materials SET subject_id = ?, class_id = ?, title = ?, description = ?,
                file_name = ?, original_name = ?, mime = ?, size = ? WHERE id = ?`,
        subjectId,
        classId,
        title,
        description,
        req.file.filename,
        originalName(req.file),
        str(req.file.mimetype, 120),
        req.file.size,
        materialId
      );
      unlinkFiles([current]);
    } else {
      run(
        'UPDATE materials SET subject_id = ?, class_id = ?, title = ?, description = ? WHERE id = ?',
        subjectId,
        classId,
        title,
        description,
        materialId
      );
    }
    res.json(get(`${MATERIAL_SELECT} WHERE m.id = ?`, materialId));
  })
);

router.delete('/materials/:id', (req, res) => {
  const m = get('SELECT * FROM materials WHERE id = ?', id(req.params.id));
  if (!m) throw notFound('El material no existe');
  run('DELETE FROM materials WHERE id = ?', m.id);
  unlinkFiles([m]);
  res.json({ ok: true });
});

/* ---------- calendario / evaluaciones ---------- */

function eventInput(body) {
  let subjectId = id(body.subject_id);
  if (subjectId && !get('SELECT id FROM subjects WHERE id = ?', subjectId)) throw bad('La materia seleccionada no existe');
  const date = optDate(body.date, 'Fecha');
  if (!date) throw bad('La fecha es obligatoria');
  const start = optTime(body.start_time, 'Inicio');
  const end = optTime(body.end_time, 'Fin');
  if (start && end && end < start) throw bad('La hora de fin no puede ser antes de la hora de inicio');
  return {
    subject_id: subjectId || null,
    title: requiredStr(body.title, 'Título', 200),
    type: EVENT_TYPES.includes(body.type) ? body.type : 'examen',
    date,
    start_time: start,
    end_time: end,
    location: str(body.location, 200),
    description: str(body.description, 5000),
  };
}

const EVENT_FIELDS = ['subject_id', 'title', 'type', 'date', 'start_time', 'end_time', 'location', 'description'];

router.post('/events', (req, res) => {
  const e = eventInput(req.body);
  const info = run(
    `INSERT INTO events (${EVENT_FIELDS.join(', ')}) VALUES (${EVENT_FIELDS.map(() => '?').join(', ')})`,
    ...EVENT_FIELDS.map((f) => e[f])
  );
  res.status(201).json(get('SELECT * FROM events WHERE id = ?', info.lastInsertRowid));
});

router.put('/events/:id', (req, res) => {
  const eventId = id(req.params.id);
  if (!get('SELECT id FROM events WHERE id = ?', eventId)) throw notFound('La evaluación no existe');
  const e = eventInput(req.body);
  run(
    `UPDATE events SET ${EVENT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
    ...EVENT_FIELDS.map((f) => e[f]),
    eventId
  );
  res.json(get('SELECT * FROM events WHERE id = ?', eventId));
});

router.delete('/events/:id', (req, res) => {
  const info = run('DELETE FROM events WHERE id = ?', id(req.params.id));
  if (!info.changes) throw notFound('La evaluación no existe');
  res.json({ ok: true });
});

/* ---------- estudiantes ---------- */

const STUDENT_SELECT = `
  SELECT st.*, sem.name AS semester_name
    FROM students st LEFT JOIN semesters sem ON sem.id = st.semester_id`;

function studentInput(body) {
  const cedula = normalizeCedula(body.cedula);
  const email = normalizeEmail(body.email);
  if (!isValidCedula(cedula)) throw bad('La cédula no es válida');
  if (!isEmail(email)) throw bad('El correo no es válido');
  let semesterId = id(body.semester_id);
  if (semesterId && !get('SELECT id FROM semesters WHERE id = ?', semesterId)) semesterId = null;
  return {
    cedula,
    email,
    name: str(body.name, 120),
    semester_id: semesterId,
    active: body.active === undefined ? 1 : body.active === true || body.active === 1 || body.active === '1' ? 1 : 0,
  };
}

router.get('/students', (req, res) => {
  const q = str(req.query.q, 80);
  if (q) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    return res.json(
      all(
        `${STUDENT_SELECT} WHERE st.name LIKE ? OR st.email LIKE ? OR st.cedula LIKE ? ORDER BY st.name COLLATE NOCASE, st.id`,
        like,
        like,
        like
      )
    );
  }
  res.json(all(`${STUDENT_SELECT} ORDER BY st.name IS NULL, st.name COLLATE NOCASE, st.id`));
});

router.post('/students', (req, res) => {
  const s = studentInput(req.body);
  if (get('SELECT id FROM students WHERE cedula = ?', s.cedula)) throw new HttpError(409, 'Ya existe un estudiante con esa cédula');
  const info = run(
    'INSERT INTO students (cedula, email, name, semester_id, active) VALUES (?, ?, ?, ?, ?)',
    s.cedula,
    s.email,
    s.name,
    s.semester_id,
    s.active
  );
  res.status(201).json(get(`${STUDENT_SELECT} WHERE st.id = ?`, info.lastInsertRowid));
});

router.put('/students/:id', (req, res) => {
  const studentId = id(req.params.id);
  if (!get('SELECT id FROM students WHERE id = ?', studentId)) throw notFound('El estudiante no existe');
  const s = studentInput(req.body);
  const dup = get('SELECT id FROM students WHERE cedula = ? AND id <> ?', s.cedula, studentId);
  if (dup) throw new HttpError(409, 'Ya existe otro estudiante con esa cédula');
  run(
    'UPDATE students SET cedula = ?, email = ?, name = ?, semester_id = ?, active = ? WHERE id = ?',
    s.cedula,
    s.email,
    s.name,
    s.semester_id,
    s.active,
    studentId
  );
  if (!s.active) run("DELETE FROM sessions WHERE role = 'student' AND user_id = ?", studentId);
  res.json(get(`${STUDENT_SELECT} WHERE st.id = ?`, studentId));
});

router.delete('/students/:id', (req, res) => {
  const studentId = id(req.params.id);
  const info = run('DELETE FROM students WHERE id = ?', studentId);
  if (!info.changes) throw notFound('El estudiante no existe');
  run("DELETE FROM sessions WHERE role = 'student' AND user_id = ?", studentId);
  res.json({ ok: true });
});

/**
 * Importación masiva: una línea por estudiante. Los campos se separan con coma,
 * punto y coma o tabulación, en cualquier orden: se detecta la cédula (números)
 * y el correo (contiene @); lo demás se toma como nombre.
 */
router.post('/students/import', (req, res) => {
  const text = typeof req.body.text === 'string' ? req.body.text : '';
  if (!text.trim()) throw bad('Pega la lista de estudiantes');
  let semesterId = id(req.body.semester_id);
  if (semesterId && !get('SELECT id FROM semesters WHERE id = ?', semesterId)) semesterId = null;

  const result = { created: 0, updated: 0, errors: [] };
  const lines = text.split(/\r?\n/).slice(0, 3000);

  tx(() => {
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const parts = line
        .split(/[,;\t|]/)
        .map((p) => p.trim())
        .filter(Boolean);
      let cedula = '';
      let email = '';
      const nameParts = [];
      for (const p of parts) {
        if (!email && p.includes('@')) email = normalizeEmail(p);
        else if (!cedula && /\d{4,}/.test(p.replace(/[.\-\s]/g, '')) && isValidCedula(normalizeCedula(p))) cedula = normalizeCedula(p);
        else nameParts.push(p);
      }
      if (!cedula || !email || !isEmail(email)) {
        // Probablemente sea un encabezado (cedula, correo, nombre); lo ignoramos sin error.
        if (i === 0 && !cedula && !email.includes('.')) return;
        result.errors.push({ line: i + 1, text: line.slice(0, 120), reason: !cedula ? 'Falta una cédula válida' : 'Falta un correo válido' });
        return;
      }
      const name = nameParts.join(' ').slice(0, 120) || null;
      const existing = get('SELECT id FROM students WHERE cedula = ?', cedula);
      if (existing) {
        run(
          'UPDATE students SET email = ?, name = COALESCE(?, name), semester_id = COALESCE(?, semester_id) WHERE id = ?',
          email,
          name,
          semesterId,
          existing.id
        );
        result.updated++;
      } else {
        run('INSERT INTO students (cedula, email, name, semester_id) VALUES (?, ?, ?, ?)', cedula, email, name, semesterId);
        result.created++;
      }
    });
  });
  res.json(result);
});

/* ---------- ajustes ---------- */

router.get('/settings', (req, res) => {
  res.json({ ...getSettings(), admin: { username: req.auth.user.username, name: req.auth.user.name } });
});

router.put('/settings', (req, res) => {
  const b = req.body;
  const s = {
    site_name: requiredStr(b.site_name, 'Nombre del portal', 80),
    site_tagline: str(b.site_tagline, 120) || '',
    university: str(b.university, 160) || '',
    period: str(b.period, 40) || '',
    welcome_message: str(b.welcome_message, 500) || '',
    allow_self_register: b.allow_self_register === true || b.allow_self_register === '1' ? '1' : '0',
  };
  tx(() => {
    for (const [k, v] of Object.entries(s)) setSetting(k, v);
  });
  res.json(getSettings());
});

router.put('/account', (req, res) => {
  const admin = get('SELECT * FROM admins WHERE id = ?', req.auth.user.id);
  const current = typeof req.body.current_password === 'string' ? req.body.current_password : '';
  if (!auth.verifyPassword(current, admin.password_hash)) throw bad('La contraseña actual no es correcta');

  const username = requiredStr(req.body.username, 'Usuario', 60);
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(username)) throw bad('El usuario solo puede tener letras, números, punto, guion y guion bajo (mínimo 3)');
  const dup = get('SELECT id FROM admins WHERE username = ? AND id <> ?', username, admin.id);
  if (dup) throw bad('Ese usuario ya existe');

  const next = typeof req.body.new_password === 'string' ? req.body.new_password : '';
  if (next && next.length < 8) throw bad('La nueva contraseña debe tener al menos 8 caracteres');
  if (admin.must_change && !next) throw bad('Debes elegir una nueva contraseña');

  run(
    'UPDATE admins SET username = ?, name = ?, password_hash = ?, must_change = ? WHERE id = ?',
    username,
    str(req.body.name, 120),
    next ? auth.hashPassword(next) : admin.password_hash,
    next ? 0 : admin.must_change,
    admin.id
  );
  res.json({ ok: true });
});

module.exports = { router, EVENT_TYPES, MAX_UPLOAD_MB };

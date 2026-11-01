'use strict';

const express = require('express');
const { all, get, run } = require('../db');
const storage = require('../storage');
const fileLinks = require('../filelinks');
const { requireAuth } = require('../auth');
const { notFound, bad, id, str, isDate, today } = require('../util');

const router = express.Router();

/*
 * Archivos: se aceptan con sesión o con un enlace firmado (file_url). En el teléfono
 * el archivo suele abrirse en otro navegador o en el gestor de descargas, sin la sesión.
 */
router.get('/materials/:id/file', async (req, res) => {
  const materialId = id(req.params.id);
  const signed = await fileLinks.verify(materialId, req.query.exp, req.query.sig);
  if (!signed && !req.auth) {
    return storage.fileError(
      req,
      res,
      401,
      'Para abrir este archivo inicia sesión en el portal y vuelve a tocar "Ver" o "Descargar". Si el enlace es de hace muchas horas, ábrelo de nuevo desde la materia.'
    );
  }
  const m = await get('SELECT * FROM materials WHERE id = ?', materialId);
  if (!m || m.kind !== 'file') return storage.fileError(req, res, 404, 'El archivo no existe o fue eliminado.');
  await storage.sendFile(req, res, m);
});

router.use(requireAuth);

/* ---------- consultas compartidas (también las usa el panel admin) ---------- */

const EVENT_SELECT = `
  SELECT e.*, s.name AS subject_name, s.color AS subject_color, s.code AS subject_code,
         s.semester_id AS semester_id, sem.name AS semester_name
    FROM events e
    LEFT JOIN subjects s   ON s.id = e.subject_id
    LEFT JOIN semesters sem ON sem.id = s.semester_id`;

// La URL interna de los archivos no se expone: se descargan por /api/materials/:id/file.
const MATERIAL_SELECT = `
  SELECT m.id, m.subject_id, m.class_id, m.title, m.description, m.kind,
         CASE WHEN m.kind = 'link' THEN m.url END AS url,
         m.original_name, m.mime, m.size, m.created_at,
         s.name AS subject_name, s.color AS subject_color, s.semester_id AS semester_id,
         c.title AS class_title
    FROM materials m
    JOIN subjects s ON s.id = m.subject_id
    LEFT JOIN classes c ON c.id = m.class_id`;

function listSemesters() {
  return all(`
    SELECT sem.*, (SELECT COUNT(*) FROM subjects s WHERE s.semester_id = sem.id) AS subject_count
      FROM semesters sem
     ORDER BY sem.position, sem.number, sem.id`);
}

function listSubjects(semesterId, t) {
  return all(
    `SELECT s.*, sem.name AS semester_name,
            (SELECT COUNT(*) FROM materials m WHERE m.subject_id = s.id) AS material_count,
            (SELECT COUNT(*) FROM classes c WHERE c.subject_id = s.id) AS class_count,
            (SELECT e.date FROM events e WHERE e.subject_id = s.id AND e.type <> 'clase' AND e.date >= ?1 ORDER BY e.date, e.start_time LIMIT 1) AS next_event_date,
            (SELECT e.title FROM events e WHERE e.subject_id = s.id AND e.type <> 'clase' AND e.date >= ?1 ORDER BY e.date, e.start_time LIMIT 1) AS next_event_title,
            (SELECT e.type FROM events e WHERE e.subject_id = s.id AND e.type <> 'clase' AND e.date >= ?1 ORDER BY e.date, e.start_time LIMIT 1) AS next_event_type
       FROM subjects s
       JOIN semesters sem ON sem.id = s.semester_id
      WHERE (?2 IS NULL OR s.semester_id = ?2)
      ORDER BY sem.position, sem.number, sem.id, s.position, s.name COLLATE NOCASE`,
    t,
    semesterId
  );
}

async function subjectDetail(subjectId) {
  const [subject, classes, materials, events] = await Promise.all([
    get(
      `SELECT s.*, sem.name AS semester_name, sem.period AS semester_period
         FROM subjects s JOIN semesters sem ON sem.id = s.semester_id
        WHERE s.id = ?`,
      subjectId
    ),
    all(
      `SELECT c.*, (SELECT COUNT(*) FROM materials m WHERE m.class_id = c.id) AS material_count
         FROM classes c WHERE c.subject_id = ?
        ORDER BY c.date IS NULL, c.date, c.id`,
      subjectId
    ),
    all(`${MATERIAL_SELECT} WHERE m.subject_id = ? ORDER BY m.created_at DESC, m.id DESC`, subjectId).then(fileLinks.addFileUrls),
    all(`${EVENT_SELECT} WHERE e.subject_id = ? AND e.type <> 'clase' ORDER BY e.date, e.start_time`, subjectId),
  ]);
  if (!subject) return null;
  return Object.assign(subject, { classes, materials, events });
}

/** evaluationsOnly: sin las sesiones de clase (para "Próximas evaluaciones" y contadores). */
function listEvents({ from, to, semesterId, subjectId, limit, evaluationsOnly }) {
  const where = [];
  const params = [];
  if (evaluationsOnly) where.push("e.type <> 'clase'");
  if (from) {
    where.push('e.date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('e.date <= ?');
    params.push(to);
  }
  if (subjectId) {
    where.push('e.subject_id = ?');
    params.push(subjectId);
  } else if (semesterId) {
    where.push('(s.semester_id = ? OR e.subject_id IS NULL)');
    params.push(semesterId);
  }
  const lim = limit ? `LIMIT ${Math.min(Math.max(Number(limit) || 1, 1), 1000)}` : '';
  return all(`${EVENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date, e.start_time IS NULL, e.start_time, e.id ${lim}`, ...params);
}

async function listMaterials({ subjectId, semesterId, q, limit }) {
  const where = [];
  const params = [];
  if (subjectId) {
    where.push('m.subject_id = ?');
    params.push(subjectId);
  } else if (semesterId) {
    where.push('s.semester_id = ?');
    params.push(semesterId);
  }
  if (q) {
    where.push('(m.title LIKE ? OR m.description LIKE ? OR m.original_name LIKE ? OR s.name LIKE ?)');
    const like = `%${q.replace(/[%_]/g, '')}%`;
    params.push(like, like, like, like);
  }
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  return fileLinks.addFileUrls(
    await all(`${MATERIAL_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT ${lim}`, ...params)
  );
}

/** Semestre por defecto: el que pide el cliente, o el del estudiante. */
function semesterFor(req) {
  if (req.query.semester_id === 'all') return null;
  const q = id(req.query.semester_id);
  if (q) return q;
  if (req.auth.role === 'student') return req.auth.user.semester_id || null;
  return null;
}

/* ---------- rutas ---------- */

router.get('/semesters', async (req, res) => {
  res.json(await listSemesters());
});

router.get('/subjects', async (req, res) => {
  res.json(await listSubjects(id(req.query.semester_id), today(req)));
});

router.get('/subjects/:id', async (req, res) => {
  const subject = await subjectDetail(id(req.params.id));
  if (!subject) throw notFound('La materia no existe');
  res.json(subject);
});

router.get('/events', async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  res.json(await listEvents({ from, to, semesterId: id(req.query.semester_id), subjectId: id(req.query.subject_id) }));
});

router.get('/materials', async (req, res) => {
  res.json(
    await listMaterials({
      subjectId: id(req.query.subject_id),
      semesterId: id(req.query.semester_id),
      q: str(req.query.q, 80),
      limit: req.query.limit,
    })
  );
});

router.get('/dashboard', async (req, res) => {
  const t = today(req);
  const semesterId = semesterFor(req);
  const in30 = new Date(t + 'T00:00:00Z');
  in30.setUTCDate(in30.getUTCDate() + 30);
  const to30 = in30.toISOString().slice(0, 10);
  const semFilter = semesterId ? 'WHERE s.semester_id = ?' : '';
  const semParams = semesterId ? [semesterId] : [];

  const [upcoming, recentMaterials, subjects, semester, materialCount, upcoming30] = await Promise.all([
    listEvents({ from: t, semesterId, limit: 8, evaluationsOnly: true }),
    listMaterials({ semesterId, limit: 6 }),
    listSubjects(semesterId, t),
    semesterId ? get('SELECT * FROM semesters WHERE id = ?', semesterId) : null,
    get(`SELECT COUNT(*) AS n FROM materials m JOIN subjects s ON s.id = m.subject_id ${semFilter}`, ...semParams),
    get(
      `SELECT COUNT(*) AS n FROM events e LEFT JOIN subjects s ON s.id = e.subject_id
        WHERE e.type <> 'clase' AND e.date >= ? AND e.date <= ? ${semesterId ? 'AND (s.semester_id = ? OR e.subject_id IS NULL)' : ''}`,
      t,
      to30,
      ...semParams
    ),
  ]);

  res.json({
    today: t,
    semester_id: semesterId,
    semester: semester || null,
    upcoming,
    recentMaterials,
    subjects,
    counts: { subjects: subjects.length, materials: materialCount.n, upcoming30: upcoming30.n },
  });
});

/* ---------- perfil del estudiante ---------- */

router.put('/me', async (req, res) => {
  if (req.auth.role !== 'student') throw bad('Solo los estudiantes tienen perfil editable aquí');
  const name = str(req.body.name, 120);
  let semesterId = id(req.body.semester_id);
  if (semesterId && !(await get('SELECT id FROM semesters WHERE id = ?', semesterId))) semesterId = null;
  await run('UPDATE students SET name = ?, semester_id = ? WHERE id = ?', name, semesterId, req.auth.user.id);
  res.json({ ok: true });
});

module.exports = { router, listSemesters, listSubjects, subjectDetail, listEvents, listMaterials, EVENT_SELECT, MATERIAL_SELECT };

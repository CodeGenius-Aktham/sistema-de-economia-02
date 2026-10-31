'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { all, get, run, UPLOAD_DIR } = require('../db');
const { requireAuth } = require('../auth');
const { notFound, bad, id, str, isDate, today } = require('../util');

const router = express.Router();
router.use(requireAuth);

/* ---------- consultas compartidas (también las usa el panel admin) ---------- */

const EVENT_SELECT = `
  SELECT e.*, s.name AS subject_name, s.color AS subject_color, s.code AS subject_code,
         s.semester_id AS semester_id, sem.name AS semester_name
    FROM events e
    LEFT JOIN subjects s   ON s.id = e.subject_id
    LEFT JOIN semesters sem ON sem.id = s.semester_id`;

const MATERIAL_SELECT = `
  SELECT m.id, m.subject_id, m.class_id, m.title, m.description, m.kind, m.url,
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
            (SELECT e.date FROM events e WHERE e.subject_id = s.id AND e.date >= ?1 ORDER BY e.date, e.start_time LIMIT 1) AS next_event_date,
            (SELECT e.title FROM events e WHERE e.subject_id = s.id AND e.date >= ?1 ORDER BY e.date, e.start_time LIMIT 1) AS next_event_title,
            (SELECT e.type FROM events e WHERE e.subject_id = s.id AND e.date >= ?1 ORDER BY e.date, e.start_time LIMIT 1) AS next_event_type
       FROM subjects s
       JOIN semesters sem ON sem.id = s.semester_id
      WHERE (?2 IS NULL OR s.semester_id = ?2)
      ORDER BY sem.position, sem.number, sem.id, s.position, s.name COLLATE NOCASE`,
    t,
    semesterId
  );
}

function subjectDetail(subjectId) {
  const subject = get(
    `SELECT s.*, sem.name AS semester_name, sem.period AS semester_period
       FROM subjects s JOIN semesters sem ON sem.id = s.semester_id
      WHERE s.id = ?`,
    subjectId
  );
  if (!subject) return null;
  subject.classes = all(
    `SELECT c.*, (SELECT COUNT(*) FROM materials m WHERE m.class_id = c.id) AS material_count
       FROM classes c WHERE c.subject_id = ?
      ORDER BY c.date IS NULL, c.date, c.id`,
    subjectId
  );
  subject.materials = all(`${MATERIAL_SELECT} WHERE m.subject_id = ? ORDER BY m.created_at DESC, m.id DESC`, subjectId);
  subject.events = all(`${EVENT_SELECT} WHERE e.subject_id = ? ORDER BY e.date, e.start_time`, subjectId);
  return subject;
}

function listEvents({ from, to, semesterId, subjectId }) {
  const where = [];
  const params = [];
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
  const sql = `${EVENT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.date, e.start_time IS NULL, e.start_time, e.id`;
  return all(sql, ...params);
}

function listMaterials({ subjectId, semesterId, q, limit }) {
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
  return all(
    `${MATERIAL_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC, m.id DESC LIMIT ${lim}`,
    ...params
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

router.get('/semesters', (req, res) => {
  res.json(listSemesters());
});

router.get('/subjects', (req, res) => {
  res.json(listSubjects(id(req.query.semester_id), today(req)));
});

router.get('/subjects/:id', (req, res) => {
  const subject = subjectDetail(id(req.params.id));
  if (!subject) throw notFound('La materia no existe');
  res.json(subject);
});

router.get('/events', (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  res.json(listEvents({ from, to, semesterId: id(req.query.semester_id), subjectId: id(req.query.subject_id) }));
});

router.get('/materials', (req, res) => {
  res.json(
    listMaterials({
      subjectId: id(req.query.subject_id),
      semesterId: id(req.query.semester_id),
      q: str(req.query.q, 80),
      limit: req.query.limit,
    })
  );
});

router.get('/dashboard', (req, res) => {
  const t = today(req);
  const semesterId = semesterFor(req);
  const in30 = new Date(t + 'T00:00:00Z');
  in30.setUTCDate(in30.getUTCDate() + 30);
  const to30 = in30.toISOString().slice(0, 10);

  const upcoming = listEvents({ from: t, semesterId }).slice(0, 8);
  const recentMaterials = listMaterials({ semesterId, limit: 6 });
  const subjects = listSubjects(semesterId, t);
  const semFilter = semesterId ? 'WHERE s.semester_id = ?' : '';
  const semParams = semesterId ? [semesterId] : [];

  res.json({
    today: t,
    semester_id: semesterId,
    semester: semesterId ? get('SELECT * FROM semesters WHERE id = ?', semesterId) : null,
    upcoming,
    recentMaterials,
    subjects,
    counts: {
      subjects: subjects.length,
      materials: get(`SELECT COUNT(*) AS n FROM materials m JOIN subjects s ON s.id = m.subject_id ${semFilter}`, ...semParams).n,
      upcoming30: listEvents({ from: t, to: to30, semesterId }).length,
    },
  });
});

/* ---------- archivos ---------- */

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

router.get('/materials/:id/file', (req, res) => {
  const m = get('SELECT * FROM materials WHERE id = ?', id(req.params.id));
  if (!m || m.kind !== 'file' || !m.file_name) throw notFound('El archivo no existe');
  const filePath = path.join(UPLOAD_DIR, path.basename(m.file_name));
  if (!fs.existsSync(filePath)) throw notFound('El archivo ya no está disponible');

  const name = m.original_name || m.file_name;
  const ext = path.extname(name).toLowerCase();
  const inlineType = INLINE_TYPES[ext];
  const wantsInline = req.query.download !== '1' && inlineType;

  res.setHeader('Content-Type', wantsInline ? inlineType : 'application/octet-stream');
  res.setHeader('Content-Disposition', contentDisposition(wantsInline ? 'inline' : 'attachment', name));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath);
});

/* ---------- perfil del estudiante ---------- */

router.put('/me', (req, res) => {
  if (req.auth.role !== 'student') throw bad('Solo los estudiantes tienen perfil editable aquí');
  const name = str(req.body.name, 120);
  let semesterId = id(req.body.semester_id);
  if (semesterId && !get('SELECT id FROM semesters WHERE id = ?', semesterId)) semesterId = null;
  run('UPDATE students SET name = ?, semester_id = ? WHERE id = ?', name, semesterId, req.auth.user.id);
  res.json({ ok: true });
});

module.exports = { router, listSemesters, listSubjects, subjectDetail, listEvents, listMaterials, EVENT_SELECT, MATERIAL_SELECT };

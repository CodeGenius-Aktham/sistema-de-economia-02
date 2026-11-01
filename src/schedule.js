'use strict';

/**
 * Horario semanal de clases → sesiones en el calendario.
 * Cada línea: "Día HH:MM-HH:MM CÓDIGO Nombre", por ejemplo:
 *   Lunes 07:20-10:20 CB1103 Introducción a la Matemática
 * También acepta "Nombre (CÓDIGO)", abreviaturas (Lun, Mié) y "7:20 a 10:20".
 */

const DAYS = { do: 0, lu: 1, ma: 2, mi: 3, ju: 4, vi: 5, sa: 6 };
const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const CODE = '[A-Za-z]{1,6}-?\\d{2,6}[A-Za-z0-9]*';

const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${m}`;

function parseSchedule(text) {
  const items = [];
  const errors = [];
  String(text || '')
    .split(/\r?\n/)
    .slice(0, 100)
    .forEach((raw, i) => {
      const line = raw.trim().replace(/\s+/g, ' ');
      if (!line) return;
      const fail = (reason) => errors.push({ line: i + 1, text: line.slice(0, 120), reason });
      const m = /^([A-Za-zÁÉÍÓÚáéíóúÑñ]+)\.?,? (\d{1,2})[:.h](\d{2}) ?(?:-|–|—|a|al|hasta) ?(\d{1,2})[:.h](\d{2})(?: (.*))?$/i.exec(line);
      if (!m) return fail('Usa el formato: Día HH:MM-HH:MM CÓDIGO Nombre');
      const weekday = DAYS[fold(m[1]).slice(0, 2)];
      if (weekday === undefined) return fail(`No reconozco el día "${m[1]}"`);
      const start = hhmm(m[2], m[3]);
      const end = hhmm(m[4], m[5]);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return fail('Hora no válida');
      if (end <= start) return fail('La hora de fin debe ser después de la de inicio');

      let rest = (m[6] || '').trim();
      let code = null;
      let name = rest;
      let cm = new RegExp(`^(${CODE})\\b[\\s:·–-]*(.*)$`).exec(rest);
      if (cm) {
        code = cm[1].toUpperCase();
        name = cm[2].trim();
      } else if ((cm = new RegExp(`^(.*?)\\s*\\((${CODE})\\)$`).exec(rest))) {
        name = cm[1].trim();
        code = cm[2].toUpperCase();
      }
      if (!name && !code) return fail('Falta el nombre o el código de la materia');
      const title = (name && code ? `${name} (${code})` : name || code).slice(0, 200);
      items.push({ weekday, day: DAY_NAMES[weekday], start, end, code, name: name || null, title });
    });
  return { items, errors };
}

/** Fechas (YYYY-MM-DD) entre from y to que caen en el día de la semana indicado. */
function datesFor(weekday, from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const last = new Date(to + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7));
  for (; d <= last; d.setUTCDate(d.getUTCDate() + 7)) out.push(d.toISOString().slice(0, 10));
  return out;
}

module.exports = { parseSchedule, datesFor, fold };

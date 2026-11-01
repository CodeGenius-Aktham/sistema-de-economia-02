'use strict';

/**
 * Carga datos de ejemplo para ver el portal funcionando.
 *   npm run demo            → solo si no hay materias todavía
 *   npm run demo -- --force → borra el contenido actual y lo vuelve a crear
 *
 * Estudiante de prueba: cédula 12345678 · correo estudiante@demo.com
 */

try {
  process.loadEnvFile();
} catch {
  /* sin .env */
}

const { all, get, run, batch, ready, setSettingSql } = require('../src/db');
const storage = require('../src/storage');

const force = process.argv.includes('--force');

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** PDF mínimo válido de una página con un título. */
function makePdf(title, lines) {
  const text = [title, '', ...lines].map((l, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${740 - i * 22} Td (${l.replace(/[()\\]/g, '')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}


const DATA = [
  {
    name: 'Semestre I',
    number: 1,
    subjects: [
      ['Introducción a la Economía', 'ECO-101', '#6366f1', 'Prof. Luis Martínez', 'Lun y Mié · 7:00 a 8:30 a. m.', 'Aula 3'],
      ['Matemática I', 'MAT-101', '#0ea5e9', 'Prof. Carmen Díaz', 'Mar y Jue · 9:00 a 10:30 a. m.', 'Aula 7'],
      ['Contabilidad General', 'CON-101', '#10b981', 'Prof. Jorge Salas', 'Vie · 8:00 a 11:00 a. m.', 'Lab. 1'],
    ],
  },
  {
    name: 'Semestre II',
    number: 2,
    subjects: [
      ['Microeconomía I', 'ECO-201', '#ec4899', 'Prof. Ana Rodríguez', 'Lun y Mié · 9:00 a 10:30 a. m.', 'Aula 12'],
      ['Estadística I', 'EST-201', '#f97316', 'Prof. Pedro Herrera', 'Mar y Jue · 7:00 a 8:30 a. m.', 'Lab. 2'],
      ['Historia Económica', 'HIS-201', '#a16207', 'Prof. Rosa Medina', 'Vie · 9:00 a 11:00 a. m.', 'Aula 5'],
    ],
  },
  {
    name: 'Semestre III',
    number: 3,
    subjects: [
      ['Macroeconomía I', 'ECO-301', '#8b5cf6', 'Prof. Daniel Castillo', 'Lun y Mié · 7:00 a 8:30 a. m.', 'Aula 14'],
      ['Microeconomía II', 'ECO-302', '#d946ef', 'Prof. Ana Rodríguez', 'Mar y Jue · 9:00 a 10:30 a. m.', 'Aula 12'],
      ['Estadística II', 'EST-301', '#f59e0b', 'Prof. Pedro Herrera', 'Mié · 2:00 a 5:00 p. m.', 'Lab. 2'],
      ['Matemática Financiera', 'MAT-301', '#14b8a6', 'Prof. Gabriela Torres', 'Vie · 7:00 a 10:00 a. m.', 'Aula 9'],
    ],
  },
];

async function main() {
  await ready();
  if ((await get('SELECT COUNT(*) AS n FROM subjects')).n > 0 && !force) {
    console.log('Ya hay materias cargadas. Usa "npm run demo -- --force" para reemplazarlas por los datos de ejemplo.');
    return;
  }
  if (force) {
    await storage.removeFiles(await all("SELECT * FROM materials WHERE kind = 'file'"));
    await batch([['DELETE FROM events'], ['DELETE FROM materials'], ['DELETE FROM classes'], ['DELETE FROM subjects'], ['UPDATE students SET semester_id = NULL'], ['DELETE FROM semesters']]);
  }

  await batch([
    setSettingSql('site_name', 'Economía 02'),
    setSettingSql('site_tagline', 'Portal académico'),
    setSettingSql('university', 'Escuela de Economía'),
    setSettingSql('period', '2026-II'),
  ]);

  const subjectIds = {};
  for (const [i, sem] of DATA.entries()) {
    const semId = (await run('INSERT INTO semesters (name, number, period, position) VALUES (?, ?, ?, ?)', sem.name, sem.number, '2026-II', i + 1)).lastInsertRowid;
    for (const [j, [name, code, color, professor, schedule, classroom]] of sem.subjects.entries()) {
      subjectIds[code] = (await run(
        `INSERT INTO subjects (semester_id, name, code, color, professor, professor_phone, schedule, classroom, credits, position, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        semId,
        name,
        code,
        color,
        professor,
        `+58 414 555 ${String(1000 + i * 10 + j).slice(-4)}`,
        schedule,
        classroom,
        j === 0 ? 5 : 4,
        j + 1,
        `Objetivo: que el estudiante domine los fundamentos de ${name.toLowerCase()} y sepa aplicarlos a problemas reales.\n\nEvaluación:\n• Primer parcial — 25%\n• Segundo parcial — 25%\n• Quices — 15%\n• Trabajo final — 20%\n• Examen final — 15%\n\nBibliografía principal disponible en la biblioteca y en la pestaña Materiales.`
      )).lastInsertRowid;
    }
  }

  const classes = {
    'ECO-301': [
      ['Introducción a la macroeconomía', -21, 'Diferencia entre micro y macro. Principales agregados: PIB, inflación y desempleo.\nLectura: Capítulo 1 de Blanchard.'],
      ['Medición del PIB', -14, 'Enfoques del gasto, del ingreso y de la producción. PIB nominal vs. real. Deflactor del PIB.\nEjercicios 1 al 10 de la guía.'],
      ['Inflación y el IPC', -7, 'Cálculo del IPC, sesgos de medición y tasas de inflación.\nVideo recomendado en Materiales.'],
      ['El mercado de bienes: modelo IS', -2, 'Demanda agregada, multiplicador keynesiano y la curva IS.\nTarea: resolver los problemas 3, 5 y 8 para la próxima clase.'],
    ],
    'ECO-302': [
      ['Teoría del consumidor (repaso)', -16, 'Preferencias, curvas de indiferencia y restricción presupuestaria.'],
      ['Equilibrio general de intercambio', -9, 'Caja de Edgeworth, curva de contrato y eficiencia de Pareto.'],
      ['Teoría de juegos I', -2, 'Juegos simultáneos, estrategias dominantes y equilibrio de Nash.\nMaterial complementario: https://www.econlib.org/library/Enc/GameTheory.html'],
    ],
    'EST-301': [
      ['Distribuciones muestrales', -12, 'Teorema del límite central y error estándar.'],
      ['Intervalos de confianza', -5, 'Intervalos para la media y para proporciones. Uso de la t de Student.'],
    ],
    'MAT-301': [
      ['Interés simple y compuesto', -10, 'Capitalización, valor presente y valor futuro.'],
      ['Anualidades', -3, 'Anualidades vencidas y anticipadas. Tablas de amortización en Excel.'],
    ],
  };
  const classIds = {};
  for (const [code, list] of Object.entries(classes)) {
    for (const [title, offset, content] of list) {
      classIds[`${code}:${title}`] = (await run('INSERT INTO classes (subject_id, title, date, content) VALUES (?, ?, ?, ?)', subjectIds[code], title, day(offset), content)).lastInsertRowid;
    }
  }

  const files = [
    ['ECO-301', 'Medición del PIB', 'Guía de ejercicios - PIB.pdf', 'Ejercicios resueltos y propuestos sobre medición del PIB.', makePdf('Guia de ejercicios: Medicion del PIB', ['1. Calcule el PIB por el enfoque del gasto.', '2. Explique la diferencia entre PIB nominal y real.', '3. Calcule el deflactor del PIB para 2024 y 2025.'])],
    ['ECO-301', 'Inflación y el IPC', 'Presentación - Inflación e IPC.pdf', 'Diapositivas de la clase.', makePdf('Inflacion y el IPC', ['Canasta basica, ponderaciones e indice de precios.', 'Sesgos: sustitucion, calidad y nuevos bienes.'])],
    ['ECO-301', null, 'Programa de la materia.pdf', 'Contenido programático completo y plan de evaluación.', makePdf('Programa - Macroeconomia I', ['Unidad 1: Agregados macroeconomicos', 'Unidad 2: Mercado de bienes y modelo IS', 'Unidad 3: Mercado de dinero y modelo LM', 'Unidad 4: Modelo IS-LM'])],
    ['ECO-302', 'Teoría de juegos I', 'Teoría de juegos - ejercicios.pdf', 'Matrices de pagos para practicar equilibrio de Nash.', makePdf('Teoria de juegos - ejercicios', ['Dilema del prisionero', 'Batalla de los sexos', 'Juego de la gallina'])],
    ['EST-301', 'Intervalos de confianza', 'Datos para el taller.csv', 'Base de datos para el taller práctico.', Buffer.from('estudiante,horas_estudio,nota\n1,4,14\n2,6,16\n3,2,10\n4,8,18\n5,5,15\n')],
    ['MAT-301', 'Anualidades', 'Tabla de amortización.csv', 'Plantilla para construir la tabla de amortización.', Buffer.from('periodo,cuota,interes,amortizacion,saldo\n0,,,,10000\n')],
  ];
  for (const [code, cls, name, desc, buf] of files) {
    const mime = name.endsWith('.pdf') ? 'application/pdf' : 'text/csv';
    const f = await storage.saveBuffer(name, buf, mime);
    await run(
      `INSERT INTO materials (subject_id, class_id, title, description, kind, url, file_name, original_name, mime, size)
       VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, ?)`,
      subjectIds[code],
      cls ? classIds[`${code}:${cls}`] : null,
      name.replace(/\.[^.]+$/, ''),
      desc,
      f.url,
      f.file_name,
      name,
      mime,
      f.size
    );
  }

  const links = [
    ['ECO-301', 'Inflación y el IPC', 'Video: ¿Qué es la inflación?', 'https://www.youtube.com/results?search_query=que+es+la+inflacion'],
    ['ECO-301', null, 'Datos del PIB — Banco Mundial', 'https://datos.bancomundial.org/indicador/NY.GDP.MKTP.CD'],
    ['ECO-302', null, 'Carpeta compartida de la materia', 'https://drive.google.com/'],
    ['MAT-301', null, 'Simulador de préstamos', 'https://www.calculator.net/loan-calculator.html'],
  ];
  await batch(
    links.map(([code, cls, title, url]) => [
      "INSERT INTO materials (subject_id, class_id, title, kind, url) VALUES (?, ?, ?, 'link', ?)",
      subjectIds[code],
      cls ? classIds[`${code}:${cls}`] : null,
      title,
      url,
    ])
  );

  const events = [
    ['ECO-302', 'Quiz: Teoría de juegos', 'quiz', 2, '09:00', '09:30', 'Aula 12', 'Equilibrio de Nash en juegos simultáneos.'],
    ['ECO-301', 'Primer parcial', 'parcial', 5, '07:00', '09:00', 'Aula 14', 'Entran las unidades 1 y 2: agregados macroeconómicos y mercado de bienes.\nTraer calculadora. Vale 25%.'],
    ['EST-301', 'Entrega: taller de intervalos', 'entrega', 8, '23:59', null, 'Aula virtual', 'Subir el taller resuelto en PDF.'],
    ['MAT-301', 'Examen: anualidades', 'examen', 12, '07:00', '10:00', 'Aula 9', 'Interés compuesto y anualidades. Se permite formulario.'],
    ['ECO-302', 'Exposición grupal', 'exposicion', 16, '09:00', '10:30', 'Aula 12', 'Grupos de 4 personas. 15 minutos por grupo.'],
    ['ECO-301', 'Segundo parcial', 'parcial', 26, '07:00', '09:00', 'Aula 14', 'Unidades 3 y 4: modelo IS-LM.'],
    ['EST-301', 'Examen parcial', 'examen', 19, '14:00', '16:00', 'Lab. 2', null],
    ['ECO-201', 'Examen final', 'examen', 22, '09:00', '11:00', 'Aula 12', null],
    [null, 'Semana de receso', 'otro', 30, null, null, null, 'No hay clases.'],
    ['MAT-301', 'Quiz de interés compuesto', 'quiz', -4, '07:00', '07:30', 'Aula 9', null],
  ];
  await batch(
    events.map(([code, title, type, offset, start, end, location, desc]) => [
      'INSERT INTO events (subject_id, title, type, date, start_time, end_time, location, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      code ? subjectIds[code] : null,
      title,
      type,
      day(offset),
      start,
      end,
      location,
      desc,
    ])
  );

  const sem3 = (await get("SELECT id FROM semesters WHERE name = 'Semestre III'")).id;
  await batch([
    [
      `INSERT INTO students (cedula, email, name, semester_id) VALUES ('12345678', 'estudiante@demo.com', 'María Pérez', ?)
       ON CONFLICT(cedula) DO UPDATE SET email = excluded.email, name = excluded.name, semester_id = excluded.semester_id, active = 1`,
      sem3,
    ],
    ...[
      ['23456789', 'jose.gomez@demo.com', 'José Gómez'],
      ['34567890', 'ana.ruiz@demo.com', 'Ana Ruiz'],
      ['45678901', 'carlos.lopez@demo.com', 'Carlos López'],
    ].map(([c, e, n]) => ['INSERT OR IGNORE INTO students (cedula, email, name, semester_id) VALUES (?, ?, ?, ?)', c, e, n, sem3]),
  ]);

  console.log('Datos de ejemplo cargados.');
  console.log('  Estudiante de prueba → cédula: 12345678 · correo: estudiante@demo.com');
}

main().catch((err) => {
  console.error('No se pudieron cargar los datos de ejemplo:', err.message);
  process.exit(1);
});

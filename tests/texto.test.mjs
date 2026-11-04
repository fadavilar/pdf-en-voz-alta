// Ejecutar con: node --test tests/texto.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { construirDocumento, segmentar, idiomaDeTexto } from '../js/extraccion.js';
import { paraVoz } from '../js/pronunciacion.js';
import { planificar, nombreMp3, duracionLegible } from '../js/exportar.js';
import { plataforma } from '../js/instalar.js';

const caja = (str, x, top, w = str.length * 5, h = 10) => ({ str, x, base: top + h * 0.86, top, w, h });

const trozos = (texto) => segmentar(texto).map(([a, b]) => texto.slice(a, b));

test('no parte la oración en abreviaturas', () => {
  const r = trozos('El Dr. Pérez y otros (Fig. 2) lo midieron. García et al. lo repitieron. Fin del texto.');
  assert.deepEqual(r, ['El Dr. Pérez y otros (Fig. 2) lo midieron.', 'García et al. lo repitieron.', 'Fin del texto.']);
});

test('corta oraciones muy largas en una pausa natural', () => {
  const larga = `${'palabra '.repeat(30).trim()}, ${'otra '.repeat(40).trim()}.`;
  const r = trozos(larga);
  assert.ok(r.length >= 2);
  assert.ok(r.every((s) => s.length <= 260));
});

test('lee en orden dos columnas con título a todo el ancho', () => {
  const items = [caja('Título del artículo que cruza las dos columnas', 60, 60, 480, 18)];
  ['Primera línea de la izquierda', 'sigue la columna izquierda', 'termina la izquierda aquí.'].forEach((s, i) => {
    items.push(caja(s, 60, 120 + i * 12, 220));
  });
  ['Primera línea de la derecha', 'sigue la columna derecha', 'termina la derecha aquí.'].forEach((s, i) => {
    items.push(caja(s, 320, 120 + i * 12, 220));
  });
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  const texto = oraciones.map((o) => o.texto).join(' | ');
  assert.equal(
    texto,
    'Título del artículo que cruza las dos columnas | Primera línea de la izquierda sigue la columna izquierda termina la izquierda aquí. | Primera línea de la derecha sigue la columna derecha termina la derecha aquí.',
  );
});

test('una línea ancha en palabras sueltas no se confunde con dos columnas', () => {
  const items = [];
  'Este resumen cruza toda la página sin parar'.split(' ').reduce((x, palabra) => {
    items.push(caja(palabra, x, 60, palabra.length * 8, 10));
    return x + palabra.length * 8 + 4;
  }, 60);
  ['Texto a la izquierda uno', 'texto a la izquierda dos', 'texto a la izquierda fin.'].forEach((s, i) => items.push(caja(s, 60, 100 + i * 12, 150)));
  ['Texto a la derecha uno', 'texto a la derecha dos', 'texto a la derecha fin.'].forEach((s, i) => items.push(caja(s, 300, 100 + i * 12, 150)));
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones[0].texto, 'Este resumen cruza toda la página sin parar');
  assert.match(oraciones[1].texto, /^Texto a la izquierda uno .* fin\.$/);
  assert.match(oraciones[2].texto, /^Texto a la derecha uno/);
});

test('une palabras partidas con guion y conserva el resaltado por línea', () => {
  const items = [caja('La evaluación econó-', 60, 100, 200), caja('mica compara costos.', 60, 112, 200)];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones[0].texto, 'La evaluación económica compara costos.');
  assert.equal(oraciones[0].rects.length, 2);
});

test('no separa una palabra con guion opcional a mitad de línea', () => {
  const items = [caja('El inter­', 60, 100, 60), caja('valo de confianza.', 128, 100, 120)];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones[0].texto, 'El intervalo de confianza.');
});

test('continúa una oración entre páginas y quita encabezado y número de página', () => {
  const pagina = (n, cuerpo) => ({
    W: 600,
    H: 800,
    items: [caja('Revista de Salud', 60, 20, 120), ...cuerpo, caja(String(n), 300, 770, 10)],
  });
  const { oraciones } = construirDocumento([
    pagina(1, [caja('Esta oración empieza en una página', 60, 100, 300)]),
    pagina(2, [caja('y termina en la siguiente.', 60, 100, 300)]),
    pagina(3, [caja('Otra idea distinta.', 60, 100, 300)]),
  ]);
  assert.deepEqual(oraciones.map((o) => o.texto), ['Esta oración empieza en una página y termina en la siguiente.', 'Otra idea distinta.']);
  assert.deepEqual([...new Set(oraciones[0].rects.map((r) => r.p))], [0, 1]);
});

test('marca como omitibles las referencias', () => {
  const items = [
    caja('El cuerpo del texto termina aquí.', 60, 100, 300),
    caja('Referencias', 60, 160, 100, 14),
    caja('1. Pérez J. Título del trabajo. Rev Salud. 2020.', 60, 200, 400),
  ];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones[0].referencia, false);
  assert.equal(oraciones.find((o) => o.texto === 'Referencias').referencia, false);
  assert.ok(oraciones.at(-1).referencia);
});

test('adapta símbolos, unidades y citas para la voz', () => {
  assert.equal(paraVoz('El efecto fue 25 % (IC 95 %: 10-40) [3,4].'), 'El efecto fue 25 por ciento (intervalo de confianza del 95 por ciento: 10 a 40).');
  assert.equal(paraVoz('Se observó p<0,05 y n=120 (Pérez y López, 2020).'), 'Se observó p menor que 0,05 y n igual a 120.');
  assert.equal(paraVoz('García et al. usaron 500 mg al día.'), 'García y colaboradores usaron 500 miligramos al día.');
  assert.equal(paraVoz('Costó 1.234.567 pesos, ver https://ejemplo.org/a.'), 'Costó 1234567 pesos, ver enlace');
  assert.equal(paraVoz('Según la norma [2].', { citas: true }), 'Según la norma [2].');
  assert.equal(paraVoz('MATERIALES Y MÉTODOS'), 'Materiales y métodos');
});

test('el plan del MP3 respeta páginas, omisiones y velocidad', () => {
  const oraciones = [
    { pagina: 0, texto: 'a'.repeat(140), referencia: false },
    { pagina: 1, texto: 'b'.repeat(140), referencia: false },
    { pagina: 1, texto: 'c'.repeat(140), referencia: true },
    { pagina: 2, texto: '', referencia: false },
  ];
  const base = { omitida: (o) => o.referencia, textoVoz: (o) => o.texto };
  const todo = planificar(oraciones, { ...base, desde: 1, hasta: 3, velocidad: 1 });
  assert.equal(todo.textos.length, 2);
  const parte = planificar(oraciones, { ...base, desde: 2, hasta: 2, velocidad: 1 });
  assert.deepEqual(parte.textos, ['b'.repeat(140)]);
  const rapido = planificar(oraciones, { ...base, desde: 1, hasta: 3, velocidad: 2 });
  assert.ok(Math.abs(rapido.segundos - todo.segundos / 2) < 0.001);
});

test('nombra el MP3 según el PDF y el rango', () => {
  assert.equal(nombreMp3('Artículo: final.PDF', { desde: 1, hasta: 9, total: 9 }), 'Artículo final.mp3');
  assert.equal(nombreMp3('libro.pdf', { desde: 3, hasta: 5, total: 9 }), 'libro (páginas 3-5).mp3');
  assert.equal(nombreMp3('libro.pdf', { desde: 1, hasta: 9, total: 9, parcial: true }), 'libro (parcial).mp3');
});

test('expresa la duración en minutos y horas', () => {
  assert.equal(duracionLegible(20), '20 s');
  assert.equal(duracionLegible(1500), '25 min');
  assert.equal(duracionLegible(4500), '1 h 15 min');
});

test('reconoce la plataforma para explicar cómo instalar', () => {
  assert.equal(plataforma('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'ios');
  assert.equal(plataforma('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5), 'ios');
  assert.equal(plataforma('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), 'otro');
  assert.equal(plataforma('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(plataforma('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'otro');
});

test('la bibliografía de un capítulo no apaga el resto del libro', () => {
  const items = [
    caja('Primer capítulo con su cuerpo de texto completo.', 60, 100, 300),
    caja('Referencias', 60, 160, 100, 14),
    caja('1. Pérez J. Título del trabajo. Rev Salud. 2020;12(3):1-10.', 60, 200, 400),
    caja('Capítulo dos', 60, 260, 120, 18),
    caja('El segundo capítulo también se tiene que leer.', 60, 300, 300),
  ];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  const buscar = (t) => oraciones.find((o) => o.texto.startsWith(t));
  assert.equal(buscar('El segundo').referencia, false);
  assert.equal(buscar('Capítulo dos').referencia, false);
  assert.equal(buscar('PDF') ?? false, false);
  assert.ok(oraciones.some((o) => o.referencia));
});

test('sin título grande, la bibliografía termina donde vuelve la prosa', () => {
  const prosa = (y) => caja('Este es un párrafo normal de un libro, sin citas ni años en ninguna parte.', 60, y, 400);
  const items = [
    caja('Referencias', 60, 100, 100, 14),
    caja('2. Brown L. Costos y consecuencias. J Health Policy. 2020;12:45-60.', 60, 140, 400),
    prosa(200),
    prosa(240),
    prosa(280),
  ];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones.at(-1).referencia, false);
  assert.ok(oraciones.some((o) => o.referencia));
});

test('el título «References» de un índice no marca lo que sigue', () => {
  const items = [
    caja('References', 60, 100, 100),
    caja('Health economics studies how resources are allocated in the health system.', 60, 150, 450),
    caja('Decision makers compare the costs and the effects of each program.', 60, 190, 450),
    caja('The analysis describes the perspective and the sources of uncertainty.', 60, 230, 450),
  ];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones.at(-1).referencia, false);
});

test('reconoce el idioma de cada bloque y hereda en los títulos cortos', () => {
  assert.equal(idiomaDeTexto('The patients of the trial were treated with the drug and the results were good.'), 'en');
  assert.equal(idiomaDeTexto('Los pacientes del ensayo recibieron el fármaco y los resultados fueron buenos.'), 'es');
  assert.equal(idiomaDeTexto('Chapter 2'), null);
  const items = [
    caja('Este resumen está escrito en español para los lectores de la revista.', 60, 100, 450),
    caja('Abstract', 60, 150, 80),
    caja('This abstract is written in English for the readers of the journal.', 60, 200, 450),
    caja('Introduction', 60, 250, 80),
  ];
  const { oraciones } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(oraciones[0].idioma, 'es');
  assert.equal(oraciones.find((o) => o.texto.startsWith('This')).idioma, 'en');
  assert.equal(oraciones.find((o) => o.texto === 'Introduction').idioma, 'en');
});

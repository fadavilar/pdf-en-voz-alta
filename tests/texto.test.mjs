// Ejecutar con: node --test tests/texto.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { construirDocumento, segmentar, idiomaDeTexto } from '../js/extraccion.js';
import { paraVoz } from '../js/pronunciacion.js';
import { planificar, nombreMp3, duracionLegible } from '../js/exportar.js';
import { plataforma } from '../js/instalar.js';
import { ordenarVoces, mejorVoz, silencioWav } from '../js/motores.js';

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

test('reconoce el inglés aun en oraciones cortas de un documento breve', () => {
  assert.equal(idiomaDeTexto('Health economics studies how scarce resources are allocated to improve health.'), 'en');
  assert.equal(idiomaDeTexto('La economía de la salud estudia los recursos escasos.'), 'es');
  assert.equal(idiomaDeTexto('Costos directos'), null);
  const items = [
    caja('Health economics studies how scarce resources are allocated to improve health.', 60, 100, 450),
    caja('Patients received the new treatment and the results of the trial were good.', 60, 140, 450),
    caja('Methods', 60, 180, 80),
  ];
  const { oraciones, idioma } = construirDocumento([{ W: 600, H: 800, items }]);
  assert.equal(idioma, 'en');
  assert.deepEqual(oraciones.map((o) => o.idioma), ['en', 'en', 'en']);
});

test('adapta símbolos y abreviaturas al inglés sin usar reglas en español', () => {
  assert.equal(paraVoz('The effect was 25% (95% CI 10-40) [3].', { idioma: 'en' }), 'The effect was 25 percent (95 percent confidence interval 10 to 40).');
  assert.equal(paraVoz('Smith et al. found p<0.05 and n=120.', { idioma: 'en' }), 'Smith and colleagues found p less than 0.05 and n equals 120.');
  assert.equal(paraVoz('They gave 500 mg daily, see https://example.org/a.', { idioma: 'en' }), 'They gave 500 milligrams daily, see link');
  assert.equal(paraVoz('MATERIALS AND METHODS', { idioma: 'en' }), 'Materials and methods');
  assert.equal(paraVoz('El efecto fue 25 %.'), 'El efecto fue 25 por ciento.');
});

test('elige voces del idioma pedido y prefiere las que leen sin conexión', () => {
  const voces = [
    { name: 'Helena', lang: 'es-ES', localService: true },
    { name: 'Natural', lang: 'en-US', localService: false },
    { name: 'Hazel', lang: 'en-GB', localService: true },
    { name: 'Zira', lang: 'en-US', localService: true },
    { name: 'Espanglish', lang: 'eng', localService: true },
  ];
  const inglesas = ordenarVoces(voces, 'en');
  assert.deepEqual(inglesas.map((v) => v.name), ['Natural', 'Zira', 'Hazel']);
  assert.equal(mejorVoz(inglesas).name, 'Zira');
  assert.equal(mejorVoz(ordenarVoces(voces, 'es')).name, 'Helena');
  assert.equal(mejorVoz([]), null);
});

test('el audio que mantiene la sesión es un WAV válido y en silencio', () => {
  const buffer = silencioWav();
  const v = new DataView(buffer);
  assert.equal(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)), 'RIFF');
  assert.equal(v.getUint32(40, true), buffer.byteLength - 44);
  assert.ok(new Uint8Array(buffer, 44).every((b) => b === 0));
});

const elementosDe = (items) => construirDocumento([{ W: 600, H: 800, items }]).oraciones.map((o) => [o.texto, o.elemento]);
const prosa = (y, texto = 'Este es un párrafo normal del artículo que describe los resultados del estudio.') => caja(texto, 60, y, 460);

test('salta una tabla y lee la prosa que la rodea', () => {
  const items = [prosa(100)];
  ['Grupo', 'Costo', 'Efecto'].forEach((t, c) => items.push(caja(t, 60 + c * 170, 140, 60)));
  [['Control', '120', '0,5'], ['Tratado', '240', '0,8'], ['Total', '360', '1,3']].forEach((fila, f) => {
    fila.forEach((t, c) => items.push(caja(t, 60 + c * 170, 156 + f * 16, 60)));
  });
  items.push(prosa(240, 'Este otro párrafo sigue después de la tabla y también se tiene que leer.'));
  const r = elementosDe(items);
  assert.equal(r.filter(([, e]) => e === null).length, 2);
  assert.ok(r.some(([t, e]) => e === 'tabla' && t.includes('Costo')));
  assert.equal(r.find(([t]) => t.startsWith('Este otro'))[1], null);
});

test('una tabla en una columna no afecta la prosa de la otra', () => {
  const items = [];
  for (let f = 0; f < 6; f++) {
    items.push(caja('Prosa de la columna izquierda que ocupa todo su ancho', 40, 100 + f * 14, 250));
    ['A', '10', '20'].forEach((t, c) => items.push(caja(t, 320 + c * 80, 100 + f * 14, 20)));
  }
  const r = elementosDe(items);
  assert.ok(r.some(([t, e]) => e === null && t.includes('Prosa de la columna')));
  assert.ok(r.some(([t, e]) => e === 'tabla' && t.includes('10')));
  assert.ok(!r.some(([t, e]) => e === 'tabla' && t.includes('Prosa')));
});

test('dos columnas de prosa no se confunden con una tabla', () => {
  const items = [];
  for (let f = 0; f < 8; f++) {
    items.push(caja('Texto normal de la izquierda con frases largas', 40, 100 + f * 14, 250));
    items.push(caja('Texto normal de la derecha con frases largas', 320, 100 + f * 14, 250));
  }
  assert.ok(elementosDe(items).every(([, e]) => e === null));
});

test('reconoce pies de tabla y figura, sin confundirlos con prosa que los menciona', () => {
  const r = elementosDe([
    prosa(60),
    caja('Tabla 1. Características de los pacientes', 60, 100, 300),
    caja('Figure 2: Flow diagram of the included studies', 60, 140, 300),
    caja('Fuente: elaboración propia con datos del ministerio', 60, 180, 300),
    caja('Figure 2 shows that the effect was larger in the treated group of patients.', 60, 220, 460),
    caja('La tabla 3 resume los resultados principales del análisis de sensibilidad.', 60, 260, 460),
  ]);
  const de = (inicio) => r.find(([t]) => t.startsWith(inicio))[1];
  assert.equal(de('Tabla 1'), 'leyenda');
  assert.equal(de('Figure 2:'), 'leyenda');
  assert.equal(de('Fuente'), 'nota');
  assert.equal(de('Figure 2 shows'), null);
  assert.equal(de('La tabla 3'), null);
});

test('reconoce fórmulas y deja las frases con alguna cifra', () => {
  const r = elementosDe([
    prosa(60),
    caja('ICER = (C1 - C0) / (E1 - E0)', 60, 100, 200),
    caja('x = ∑ βi yi + ε', 60, 140, 200),
    caja('(3)', 60, 180, 30),
    caja('El costo fue de 120 pesos y el efecto de 0,5 años de vida ganados.', 60, 220, 460),
    caja('Se observó p = 0,03 en el grupo tratado, lo que confirma el resultado esperado del estudio.', 60, 260, 500),
  ]);
  const de = (inicio) => r.find(([t]) => t.startsWith(inicio))[1];
  assert.equal(de('ICER'), 'formula');
  assert.equal(de('x ='), 'formula');
  assert.equal(de('(3)'), 'tabla');
  assert.equal(de('El costo'), null);
  assert.equal(de('Se observó'), null);
});

test('salta la letra pequeña al pie y los rótulos sueltos de un gráfico', () => {
  const items = [prosa(100)];
  for (let i = 0; i < 6; i++) items.push(caja(`Rótulo ${i}`, 60 + i * 20, 160 + i * 30, 60));
  items.push(caja('1 Investigador del instituto de salud pública de la universidad.', 60, 700, 400, 7));
  const r = elementosDe(items);
  assert.equal(r.find(([t]) => t.startsWith('Rótulo'))[1], 'figura');
  assert.equal(r.find(([t]) => t.startsWith('1 Investigador'))[1], 'nota');
  assert.equal(r[0][1], null);
});

test('una oración sigue de corrido aunque haya una leyenda en medio', () => {
  const r = elementosDe([
    caja('Esta oración empieza antes de la leyenda', 60, 100, 300),
    caja('Tabla 2. Costos por grupo', 60, 140, 300),
    caja('y termina después de ella.', 60, 180, 300),
  ]);
  assert.deepEqual(r.map(([t]) => t), ['Esta oración empieza antes de la leyenda y termina después de ella.', 'Tabla 2.', 'Costos por grupo']);
});

test('salta una ecuación pegada a su párrafo y un rótulo junto a una tabla', () => {
  const r = elementosDe([
    caja('El indicador se calcula con la fórmula habitual del análisis económico.', 60, 100, 460),
    caja('ICER = (C1 - C0) / (E1 - E0)', 60, 112, 200),
    prosa(180),
    caja('Costo', 60, 240, 40),
    caja('500', 60, 280, 20),
  ]);
  const de = (inicio) => r.find(([t]) => t.startsWith(inicio))[1];
  assert.equal(de('El indicador'), null);
  assert.equal(de('ICER'), 'formula');
  assert.equal(de('Costo'), 'figura');
  assert.equal(de('500'), 'tabla');
});

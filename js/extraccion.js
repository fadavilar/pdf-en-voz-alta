// Convierte las cajas de texto de un PDF en oraciones ordenadas y ubicadas en la página.
// No toca el DOM: recibe páginas { W, H, items } y devuelve el documento listo para leer.

const LIGADURAS = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const MAX_ORACION = 260;

const mediana = (valores) => {
  if (!valores.length) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.floor(orden.length / 2)];
};

function limpiar(str) {
  return str
    .replace(/[ﬀ-ﬆ]/g, (c) => LIGADURAS[c] ?? c)
    .replace(/[  -  ]/g, ' ')
    .replace(/­(?=.)/g, '')
    .replace(/[\u0000-\u001F​-‍﻿-]/g, '');
}

// Cajas en unidades de página a partir de getTextContent de PDF.js.
export function itemsDesdePdf(textContent, viewport, transformar) {
  const items = [];
  for (const it of textContent.items) {
    if (!it.str || !it.str.trim()) continue;
    const t = transformar(viewport.transform, it.transform);
    if (Math.abs(t[1]) > Math.abs(t[0]) * 0.05 || Math.abs(t[2]) > Math.abs(t[3]) * 0.05) continue; // texto girado en el margen
    const h = Math.hypot(t[2], t[3]);
    if (h < 1) continue;
    const str = limpiar(it.str);
    if (!str.trim()) continue;
    items.push({ str, x: t[4], base: t[5], top: t[5] - h * 0.86, w: it.width * viewport.scale, h });
  }
  return items;
}

function agruparEnLineas(cajas) {
  const orden = [...cajas].sort((a, b) => a.base - b.base || a.x - b.x);
  const lineas = [];
  for (const c of orden) {
    const centro = c.top + c.h / 2;
    const linea = lineas.slice(-2).reverse().find((l) => Math.abs(centro - l.centro) < Math.max(c.h, l.h) * 0.55);
    if (linea) {
      linea.cajas.push(c);
      linea.h = Math.max(linea.h, c.h);
    } else {
      lineas.push({ cajas: [c], centro, h: c.h });
    }
  }
  for (const l of lineas) {
    l.cajas.sort((a, b) => a.x - b.x);
    l.top = Math.min(...l.cajas.map((c) => c.top));
    l.bottom = Math.max(...l.cajas.map((c) => c.top + c.h));
    l.texto = l.cajas.map((c) => c.str).join(' ').replace(/\s+/g, ' ').trim();
  }
  return lineas;
}

const esNumeroDePagina = (t) => /^(p[aá]g(ina)?\.?\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(\s*(de|of|\/)\s*\d{1,4})?$/i.test(t);

// Quita encabezados, pies y numeración: lo que se repite en los márgenes de varias páginas.
export function quitarMargenes(paginas) {
  const minimo = Math.max(2, Math.ceil(paginas.length * 0.3));
  const conteo = new Map();
  const candidatas = paginas.map((p) => {
    const lineas = agruparEnLineas(p.items);
    // Zona amplia: en páginas con marcas de corte el encabezado queda lejos del borde del papel.
    const zona = [
      ...lineas.filter((l) => l.top < p.H * 0.22).slice(0, 2),
      ...lineas.filter((l) => l.bottom > p.H * 0.78).slice(-2),
    ];
    return zona.map((l) => {
      const clave = l.texto.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
      conteo.set(clave, (conteo.get(clave) ?? 0) + 1);
      return { l, clave };
    });
  });
  return paginas.map((p, i) => {
    const fuera = new Set();
    for (const { l, clave } of candidatas[i]) {
      if (esNumeroDePagina(l.texto) || (paginas.length > 1 && conteo.get(clave) >= minimo)) {
        l.cajas.forEach((c) => fuera.add(c));
      }
    }
    return { ...p, items: p.items.filter((c) => !fuera.has(c)) };
  });
}

// Busca el canal vacío entre columnas: una franja que casi ninguna fila cruza y con texto a ambos lados.
function buscarMedianil(cajas, ctx) {
  if (cajas.length < 6) return null;
  const x0 = Math.min(...cajas.map((c) => c.x));
  const x1 = Math.max(...cajas.map((c) => c.x + c.w));
  const ancho = x1 - x0;
  if (ancho < ctx.W * 0.3) return null;
  const filas = agruparEnLineas(cajas);
  const celdas = new Int32Array(Math.ceil(ancho) + 2);
  for (const fila of filas) {
    let hasta = -1;
    for (const c of fila.cajas) {
      const a = Math.max(hasta + 1, Math.floor(c.x - x0));
      const b = Math.ceil(c.x + c.w - x0);
      for (let i = a; i <= b && i < celdas.length; i++) celdas[i]++;
      hasta = Math.max(hasta, b);
    }
  }
  const minimo = Math.max(ctx.alto, ctx.W * 0.012);
  const limite = Math.max(2, filas.length * 0.25);
  const desde = Math.floor(ancho * 0.2);
  const hasta = Math.ceil(ancho * 0.8);
  let mejor = null;
  let inicio = null;
  for (let i = desde; i <= hasta; i++) {
    if (celdas[i] <= limite && i < hasta) {
      inicio ??= i;
    } else if (inicio !== null) {
      if (i - inicio >= minimo && (!mejor || i - inicio > mejor.ancho)) mejor = { ancho: i - inicio, x: x0 + (inicio + i) / 2, mitad: (i - inicio) / 2 };
      inicio = null;
    }
  }
  if (!mejor) return null;
  // Debe haber texto a los dos lados y a la misma altura; si no, son bloques sueltos y no columnas.
  const izq = agruparEnLineas(cajas.filter((c) => c.x + c.w <= mejor.x + mejor.mitad));
  const der = agruparEnLineas(cajas.filter((c) => c.x >= mejor.x - mejor.mitad));
  if (izq.length < 3 || der.length < 3) return null;
  const compartido = Math.min(izq.at(-1).bottom, der.at(-1).bottom) - Math.max(izq[0].top, der[0].top);
  return compartido > ctx.alto * 2 ? mejor : null;
}

function bandas(cajas, ctx) {
  const orden = [...cajas].sort((a, b) => a.top - b.top);
  const huecos = [];
  let fin = orden[0].top + orden[0].h;
  for (const c of orden.slice(1)) {
    if (c.top > fin) huecos.push(c.top - fin);
    fin = Math.max(fin, c.top + c.h);
  }
  // El interlineado propio del texto (sencillo o doble) no debe confundirse con un cambio de párrafo.
  const interlineado = mediana(huecos.filter((h) => h <= ctx.alto * 1.6));
  const umbral = Math.min(Math.max(ctx.alto * 0.6, interlineado * 1.5), ctx.alto * 1.7);
  const salida = [[orden[0]]];
  fin = orden[0].top + orden[0].h;
  let previa = orden[0];
  for (const c of orden.slice(1)) {
    // En OCR la altura de cada línea oscila: un cambio pequeño no indica un título.
    const cambiaTamano = c.top >= fin && Math.abs(c.h - previa.h) / Math.max(c.h, previa.h) > (c.ocr ? 0.3 : 0.07);
    if (c.top - fin >= umbral || cambiaTamano) salida.push([]);
    salida.at(-1).push(c);
    fin = Math.max(fin, c.top + c.h);
    previa = c;
  }
  return salida;
}

// Orden de lectura: lo que cruza el canal (título, resumen, tabla ancha) va en su sitio de arriba abajo,
// y entre esos tramos se lee la columna izquierda completa y luego la derecha. Admite más de dos columnas.
function ordenLectura(cajas, ctx) {
  if (!cajas.length) return [];
  const canal = buscarMedianil(cajas, ctx);
  if (!canal) return bandas(cajas, ctx);
  // Una fila también cruza si solo la corta un espacio entre palabras (OCR o PDF con palabras sueltas).
  const cruzan = new Set();
  for (const fila of agruparEnLineas(cajas)) {
    const izq = fila.cajas.filter((c) => c.x + c.w / 2 < canal.x);
    const der = fila.cajas.filter((c) => c.x + c.w / 2 >= canal.x);
    const hueco = izq.length && der.length ? der[0].x - Math.max(...izq.map((c) => c.x + c.w)) : Infinity;
    if (hueco < fila.h * 0.9) fila.cajas.forEach((c) => cruzan.add(c));
    for (const c of fila.cajas) if (c.x < canal.x - canal.mitad && c.x + c.w > canal.x + canal.mitad) cruzan.add(c);
  }
  const cruza = (c) => cruzan.has(c);
  const anchas = cajas.filter(cruza).sort((a, b) => a.top - b.top);
  const tramos = [];
  for (const c of anchas) {
    const ultimo = tramos.at(-1);
    if (ultimo && c.top < ultimo.bottom + ctx.alto * 1.2) {
      ultimo.cajas.push(c);
      ultimo.bottom = Math.max(ultimo.bottom, c.top + c.h);
    } else {
      tramos.push({ cajas: [c], top: c.top, bottom: c.top + c.h });
    }
  }
  const estrechas = cajas.filter((c) => !cruza(c));
  const seccion = Array.from({ length: tramos.length + 1 }, () => []);
  for (const c of estrechas) {
    const centro = c.top + c.h / 2;
    let k = tramos.findIndex((t) => centro < (t.top + t.bottom) / 2);
    if (k === -1) k = tramos.length;
    seccion[k].push(c);
  }
  const salida = [];
  seccion.forEach((grupo, k) => {
    const izq = grupo.filter((c) => c.x + c.w / 2 < canal.x);
    const der = grupo.filter((c) => c.x + c.w / 2 >= canal.x);
    salida.push(...ordenLectura(izq, ctx), ...ordenLectura(der, ctx));
    if (tramos[k]) salida.push(...bandas(tramos[k].cajas, ctx));
  });
  return salida;
}

const TITULO_REFERENCIAS = /^(\d+\.?\s*)?(referencias(\s+bibliogr[aá]ficas)?|bibliograf[ií]a|references|bibliography|literatura citada)\s*:?$/i;

// Una entrada bibliográfica trae año junto a señales de cita; un párrafo normal, no.
function pareceReferencia(texto) {
  if (/\bdoi\b|doi\.org|https?:\/\//i.test(texto)) return true;
  if (!/\b(19|20)\d{2}[a-z]?\b/.test(texto)) return false;
  return texto.length < 300
    || /^\s*(\[?\d+[.\])]|\p{Lu}[\p{L}'-]+,?\s+\p{Lu})/u.test(texto)
    || /\bet al\b|\bpp?\.\s?\d|\d+\s*\(\d+\)\s*:|;\s*\d+/.test(texto);
}

function armarBloque(cajas, numPagina, alturaGlobal) {
  const lineas = agruparEnLineas(cajas);
  const bloque = { texto: '', tramos: [], pagina: numPagina, alto: mediana(cajas.map((c) => c.h)), rol: 'cuerpo', numLineas: lineas.length };
  for (const linea of lineas) {
    const altoLinea = mediana(linea.cajas.map((c) => c.h));
    const centroLinea = mediana(linea.cajas.map((c) => c.top + c.h / 2));
    let finPrevio = null;
    for (const c of linea.cajas) {
      const centro = c.top + c.h / 2;
      const esVolado = c.h < altoLinea * 0.8 && centro < centroLinea - altoLinea * 0.08;
      if (esVolado && /^[\d,\s\-–*†‡]+$/.test(c.str)) continue; // llamada de cita en superíndice
      if (bloque.texto.endsWith('­')) {
        // Guion opcional a mitad de línea: es la misma palabra aunque venga en dos trozos.
        bloque.texto = bloque.texto.slice(0, -1);
        const ultimo = bloque.tramos.at(-1);
        if (ultimo) ultimo.fin = Math.min(ultimo.fin, bloque.texto.length);
      } else if (bloque.texto && !/\s$/.test(bloque.texto) && finPrevio !== null) {
        const hueco = c.x - finPrevio;
        if ((c.ocr || hueco > altoLinea * 0.12) && !/^\s/.test(c.str)) bloque.texto += ' ';
      }
      const ini = bloque.texto.length;
      bloque.texto += c.str;
      bloque.tramos.push({ ini, fin: bloque.texto.length, x: c.x, w: c.w, top: c.top, h: c.h, p: numPagina });
      finPrevio = c.x + c.w;
    }
    bloque.texto = unirFinDeLinea(bloque.texto, bloque.tramos);
  }
  bloque.texto = bloque.texto.replace(/\s+$/, '');
  bloque.top = Math.min(...cajas.map((c) => c.top));
  bloque.x0 = Math.min(...cajas.map((c) => c.x));
  bloque.x1 = Math.max(...cajas.map((c) => c.x + c.w));

  const corto = bloque.texto.length <= 140 && !/[.!?:;,]$/.test(bloque.texto);
  const letras = bloque.texto.replace(/[^\p{L}]/gu, '');
  const mayus = letras.length > 3 && letras === letras.toUpperCase();
  const numerado = /^\d+(\.\d+)*\.?\s+\p{Lu}/u.test(bloque.texto);
  if (corto && (bloque.alto > alturaGlobal * (cajas[0].ocr ? 1.3 : 1.08) || mayus || numerado || TITULO_REFERENCIAS.test(bloque.texto))) bloque.rol = 'titulo';
  return bloque;
}

// Deja un espacio de separación con la línea siguiente; lo quita junto al guion cuando se parte una palabra.
function unirFinDeLinea(texto, tramos) {
  if (/[-‐­]$/.test(texto)) {
    const recortado = texto.slice(0, -1);
    const ultimo = tramos.at(-1);
    if (ultimo) ultimo.fin = Math.min(ultimo.fin, recortado.length);
    return `${recortado}\u0000`;
  }
  return `${texto} `;
}

// El marcador \u0000 indica «palabra partida»: se resuelve según cómo empiece lo que sigue.
function resolverPartidas(bloque) {
  const salida = [];
  const mapa = new Array(bloque.texto.length + 1);
  const t = bloque.texto;
  for (let i = 0; i < t.length; i++) {
    mapa[i] = salida.length;
    if (t[i] !== '\u0000') {
      salida.push(t[i]);
    } else if (!/\p{Ll}/u.test(t[i + 1] ?? '')) {
      salida.push('-'); // guion real: la línea siguiente no continúa en minúscula
      if (t[i + 1]) salida.push(' ');
    }
  }
  mapa[t.length] = salida.length;
  bloque.texto = salida.join('');
  bloque.tramos = bloque.tramos
    .map((tr) => ({ ...tr, ini: mapa[tr.ini], fin: mapa[Math.min(tr.fin, t.length)] }))
    .filter((tr) => tr.fin > tr.ini);
}

function fusionarContinuaciones(bloques) {
  const salida = [];
  let previo = null;
  for (const b of bloques) {
    // Una tabla entre dos columnas no corta la oración que sigue al otro lado.
    if (b.elemento) {
      salida.push(b);
      continue;
    }
    // Un título que ocupa dos líneas sigue siendo un solo título.
    const mismoTitulo = previo && previo.rol === 'titulo' && b.rol === 'titulo' && previo.pagina === b.pagina
      && Math.abs(previo.alto - b.alto) < previo.alto * 0.05 && !/^\d+(\.\d+)*\.?\s/.test(b.texto);
    const sigue = mismoTitulo || previo && previo.rol === 'cuerpo' && b.rol === 'cuerpo'
      && !/[.!?:;]["'»)\]]?\s*\u0000?$/.test(previo.texto)
      && /^\p{Ll}/u.test(b.texto);
    if (!sigue) {
      salida.push(b);
      previo = b;
      continue;
    }
    const partida = /\u0000$/.test(previo.texto);
    const base = partida ? previo.texto.slice(0, -1) : previo.texto;
    const separador = partida ? '' : ' ';
    const salto = base.length + separador.length;
    previo.texto = base + separador + b.texto;
    previo.tramos.push(...b.tramos.map((t) => ({ ...t, ini: t.ini + salto, fin: t.fin + salto })));
    previo.numLineas += b.numLineas;
  }
  return salida;
}

const ABREVIATURA = /(?:\b(?:Dr|Dra|Sr|Sra|Prof|Ing|Lic|Fig|Figs|Tab|Ref|Refs|Vol|N[úu]m|No|n[úu]m|pp?|vs|cf|ej|aprox|Art|art|Ed|ed|op|cit|Inc|Ltd|MSc|Ph\.D|Esp|Dept|Univ|Rev|Mg|et al)|(?:^|[\s(])\p{Lu})\.\s*$/u;

function partirLarga(texto, ini, fin) {
  const partes = [];
  let desde = ini;
  while (fin - desde > MAX_ORACION) {
    const ventana = texto.slice(desde, desde + MAX_ORACION);
    const mejor = Math.max(ventana.lastIndexOf('; '), ventana.lastIndexOf(': '), ventana.lastIndexOf(', '));
    const corte = mejor > MAX_ORACION * 0.4 ? mejor + 1 : ventana.lastIndexOf(' ');
    if (corte <= 0) break;
    partes.push([desde, desde + corte]);
    desde += corte + 1;
  }
  partes.push([desde, fin]);
  return partes;
}

// Rangos [ini, fin) de cada oración, con el segmentador del navegador y reparación de abreviaturas.
export function segmentar(texto) {
  const crudos = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    for (const s of new Intl.Segmenter('es', { granularity: 'sentence' }).segment(texto)) {
      crudos.push([s.index, s.index + s.segment.length]);
    }
  } else {
    const re = /[^.!?]+[.!?]*\s*/g;
    let m;
    while ((m = re.exec(texto))) crudos.push([m.index, m.index + m[0].length]);
  }
  const unidos = [];
  for (const r of crudos) {
    const previo = unidos.at(-1);
    if (previo) {
      const antes = texto.slice(previo[0], previo[1]);
      const inicio = texto.slice(r[0], r[1]).trimStart();
      if (ABREVIATURA.test(antes) || /^\s*\d+(\.\d+)*\.\s*$/.test(antes) || /^[\p{Ll}(]/u.test(inicio) || /^\d/.test(inicio) && /\b(Tabla|Figura|Fig|p|pp|No|Núm)\.\s*$/.test(antes)) {
        previo[1] = r[1];
        continue;
      }
    }
    unidos.push([...r]);
  }
  return unidos
    .flatMap(([ini, fin]) => {
      let a = ini;
      let b = fin;
      while (a < b && /\s/.test(texto[a])) a++;
      while (b > a && /\s/.test(texto[b - 1])) b--;
      return b > a ? partirLarga(texto, a, b) : [];
    })
    .filter(([a, b]) => /[\p{L}\p{N}]/u.test(texto.slice(a, b)));
}

// Rectángulos de resaltado en fracciones de página (0–1).
function rectangulos(bloque, ini, fin, paginas) {
  const rects = [];
  for (const tr of bloque.tramos) {
    if (tr.fin <= ini || tr.ini >= fin) continue;
    const largo = tr.fin - tr.ini;
    const a = Math.max(0, ini - tr.ini) / largo;
    const b = Math.min(largo, fin - tr.ini) / largo;
    const pag = paginas[tr.p];
    const x = (tr.x + tr.w * a) / pag.W;
    const w = (tr.w * (b - a)) / pag.W;
    const y = tr.top / pag.H;
    const h = (tr.h * 1.12) / pag.H;
    const ult = rects.at(-1);
    if (ult && ult.p === tr.p && Math.abs(ult.y - y) < ult.h * 0.4 && x - (ult.x + ult.w) < 0.04) {
      ult.w = x + w - ult.x;
      ult.h = Math.max(ult.h, h);
    } else {
      rects.push({ p: tr.p, x, y, w, h });
    }
  }
  return rects;
}

const PALABRAS_ES = new Set('el la los las de del y en que para por con una un se su sus al es como más o lo este esta estos estas son entre sobre también fue fueron ha han pero cuando si sin desde está están muy cada ya hay porque según ser tiene donde otros otras'.split(' '));
const PALABRAS_EN = new Set('the of and to in that for with is on as are this was by from at an be which were these have has how not but their they it its can may we our will would should than when after between each all who there been had also such into about more most other some only'.split(' '));

// Idioma de un fragmento, o null si es muy corto para saberlo (un título, por ejemplo).
export function idiomaDeTexto(texto, minimo = 2) {
  let es = (texto.match(/[áéíóúñ¿¡]/gi) ?? []).length;
  let en = 0;
  for (const palabra of texto.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (PALABRAS_ES.has(palabra)) es++;
    if (PALABRAS_EN.has(palabra)) en++;
  }
  if (es > 0 && en === 0 && /[áéíóúñ¿¡]/i.test(texto)) return 'es'; // el inglés casi nunca lleva estos signos
  if (es + en < minimo) return null;
  if (en > es * 1.3) return 'en';
  return es > en ? 'es' : null;
}

export function detectarIdioma(texto) {
  return idiomaDeTexto(texto, 5) ?? 'es';
}

const SOLO_CIFRAS = /^[\d\s.,;:%()[\]±<>=+\-–—/*†‡≤≥]+$/;

// Tablas: filas seguidas con varias celdas cortas en columnas alineadas.
// Lo ancho de la misma fila es prosa de otra columna de la página y no se toca.
function separarTablas(cajas, ctx) {
  if (cajas.length < 6) return { cuerpo: cajas, tablas: [] };
  const x0 = Math.min(...cajas.map((c) => c.x));
  const x1 = Math.max(...cajas.map((c) => c.x + c.w));
  const ancho = x1 - x0;
  const filas = agruparEnLineas(cajas).sort((a, b) => a.top - b.top).map((fila) => {
    const segmentos = [];
    for (const c of fila.cajas) {
      const ultimo = segmentos.at(-1);
      if (ultimo && c.x - ultimo.fin < ctx.alto) {
        ultimo.cajas.push(c);
        ultimo.fin = Math.max(ultimo.fin, c.x + c.w);
        ultimo.texto += ` ${c.str}`;
      } else {
        segmentos.push({ cajas: [c], ini: c.x, fin: c.x + c.w, texto: c.str });
      }
    }
    const cortos = segmentos.filter((s) => s.fin - s.ini < ancho * 0.28);
    const cifras = cortos.filter((s) => SOLO_CIFRAS.test(s.texto.trim())).length;
    return { ...fila, segmentos, cortos, tabular: cortos.length >= 3 || (cortos.length >= 2 && cifras >= 1) };
  });

  const alineada = (grupo) => {
    const conteo = new Map();
    for (const fila of grupo) {
      const vistos = new Set();
      for (const s of fila.cortos) {
        for (const punto of [s.ini, s.fin, (s.ini + s.fin) / 2]) vistos.add(Math.round(punto / (ctx.W * 0.012)));
      }
      for (const v of vistos) conteo.set(v, (conteo.get(v) ?? 0) + 1);
    }
    const fuertes = [...conteo].filter(([, n]) => n >= grupo.length * 0.6).map(([v]) => v).sort((a, b) => a - b);
    let columnas = 0;
    let ultima = -Infinity;
    for (const v of fuertes) {
      if ((v - ultima) * 0.012 > 0.05) columnas++;
      ultima = v;
    }
    return columnas >= 2;
  };

  const tramos = [];
  let actual = null;
  const cerrar = () => {
    if (!actual) return;
    while (actual.filas.length && !actual.filas.at(-1).tabular) actual.filas.pop();
    const tabulares = actual.filas.filter((f) => f.tabular);
    if (tabulares.length >= 3 && alineada(tabulares)) tramos.push(actual.filas);
    actual = null;
  };
  for (const fila of filas) {
    const cerca = actual && fila.top - actual.filas.at(-1).bottom <= ctx.alto * 2.5;
    if (fila.tabular) {
      if (!cerca) {
        cerrar();
        actual = { filas: [], holgura: 0 };
      }
      actual.filas.push(fila);
      actual.holgura = 0;
    } else if (cerca && actual.holgura < 1 && fila.cortos.length === fila.segmentos.length) {
      actual.filas.push(fila); // encabezado de grupo o celda sola dentro de la tabla
      actual.holgura++;
    } else {
      cerrar();
    }
  }
  cerrar();

  const enTabla = new Set();
  const tablas = tramos.map((grupo) => {
    const propias = grupo.flatMap((f) => f.segmentos.filter((s) => s.fin - s.ini < ancho * 0.42).flatMap((s) => s.cajas));
    propias.forEach((c) => enTabla.add(c));
    return propias;
  });
  return { cuerpo: cajas.filter((c) => !enTabla.has(c)), tablas };
}

const LEYENDA = /^(?:tabla|table|cuadro|figura|figure|figs?\.?|gr[aá]fico|gr[aá]fica|graph|ilustraci[oó]n|esquema|scheme|chart|box|recuadro|imagen|image|mapa|map)\s*(?:s?\d+[a-z]?|[ivxlc]+)\b\s*(.*)$/isu;
const NOTA = /^(?:fuentes?|sources?|notas?|notes?|abreviaturas?|abbreviations?|leyenda|legend|elaboraci[oó]n propia)\b\s*[:.]/iu;
const SIMBOLOS = /[=≈≠≡≤≥∑∏∫√∂∇±×÷→←↔∞∈∉⊂∪∩∝∼\u0391-\u03A9\u03B1-\u03C9]/gu;

// Un «Figure 2 shows that…» es prosa; un «Figure 2. Flujo de pacientes» es un pie de figura.
function esLeyenda(texto) {
  const m = texto.match(LEYENDA);
  if (!m || texto.length > 900) return false;
  const resto = m[1].trim();
  if (!resto || /^[.:|—–-]/.test(resto)) return true;
  return texto.length < 160 && !/^\p{Ll}/u.test(resto);
}

function esFormula(texto) {
  if (texto.length > 220) return false;
  const palabras = (texto.match(/\p{L}{3,}/gu) ?? []).length;
  const simbolos = (texto.match(SIMBOLOS) ?? []).length;
  if (simbolos && palabras <= 3) return true;
  if (simbolos >= 2 && palabras <= simbolos * 2) return true;
  return !palabras && /\p{L}/u.test(texto) && texto.length <= 40;
}

// Decide qué bloques de una página no tienen sentido en voz alta.
function clasificarBloques(bloques, pagina, alturaGlobal) {
  for (const b of bloques) {
    if (b.elemento) continue;
    const texto = b.texto.replace(/\u0000/g, '').trim();
    if (TITULO_REFERENCIAS.test(texto)) continue;
    if (esLeyenda(texto)) b.elemento = 'leyenda';
    else if (NOTA.test(texto) && texto.length < 900) b.elemento = 'nota';
    else if (/^[*†‡§]{1,3}\s*\S/.test(texto) && texto.length < 400) b.elemento = 'nota';
    else if (esFormula(texto)) b.elemento = 'formula';
    else if (SOLO_CIFRAS.test(texto) && texto.length <= 200) b.elemento = 'tabla';
    else if (b.alto < alturaGlobal * 0.88 && b.top > pagina.H * 0.6) b.elemento = 'nota';
  }
  // Los rótulos de un gráfico llegan como una tanda de fragmentos sueltos.
  let inicio = 0;
  const cerrarTanda = (fin) => {
    if (fin - inicio >= 5) for (let i = inicio; i < fin; i++) bloques[i].elemento = 'figura';
  };
  bloques.forEach((b, i) => {
    const suelto = !b.elemento && b.rol === 'cuerpo' && !/[.!?:;]\s*$/.test(b.texto) && b.texto.trim().split(/\s+/).length <= 4;
    if (!suelto) {
      cerrarTanda(i);
      inicio = i + 1;
    }
  });
  cerrarTanda(bloques.length);
  // Un rótulo solo junto a una tabla o figura (el nombre de un eje, por ejemplo) también sobra.
  bloques.forEach((b, i) => {
    if (b.elemento || b.rol !== 'cuerpo' || /[.!?:;]\s*$/.test(b.texto) || b.texto.trim().split(/\s+/).length > 3) return;
    const vecino = [bloques[i - 1], bloques[i + 1]].some((v) => ['tabla', 'figura', 'leyenda'].includes(v?.elemento));
    if (vecino) b.elemento = 'figura';
  });
  for (const b of bloques) if (b.elemento) b.rol = 'cuerpo';
}

// Devuelve { oraciones, bloques, idioma }.
export function construirDocumento(paginas) {
  const limpias = quitarMargenes(paginas);
  const alturaGlobal = mediana(limpias.flatMap((p) => p.items.map((c) => c.h))) || 10;
  let bloques = [];
  limpias.forEach((p, n) => {
    if (!p.items.length) return;
    const ctx = { W: p.W, H: p.H, alto: mediana(p.items.map((c) => c.h)) || alturaGlobal };
    const { cuerpo, tablas } = separarTablas(p.items, ctx);
    const dePagina = ordenLectura(cuerpo, ctx).map((grupo) => armarBloque(grupo, n, alturaGlobal)).filter((b) => b.texto.trim());
    for (const grupo of tablas) {
      const tabla = armarBloque(grupo, n, alturaGlobal);
      tabla.elemento = 'tabla';
      const lugar = dePagina.findIndex((b) => b.top >= tabla.top && b.x0 < tabla.x1 && b.x1 > tabla.x0);
      dePagina.splice(lugar === -1 ? dePagina.length : lugar, 0, tabla);
    }
    clasificarBloques(dePagina, p, alturaGlobal);
    bloques.push(...dePagina);
  });
  bloques = fusionarContinuaciones(bloques);
  bloques.forEach(resolverPartidas);

  const idiomaDocumento = detectarIdioma(bloques.slice(0, 400).map((b) => b.texto).join(' '));
  const oraciones = [];
  let enReferencias = false;
  let sinParecido = 0;
  let idiomaPrevio = idiomaDocumento;
  bloques.forEach((b, numBloque) => {
    const texto = b.texto.trim();
    const esTituloRefs = TITULO_REFERENCIAS.test(texto);
    // La bibliografía termina donde empieza otra cosa: un libro puede tener una por capítulo.
    if (esTituloRefs) {
      enReferencias = true;
      sinParecido = 0;
    } else if (enReferencias && !b.elemento) {
      if (pareceReferencia(texto)) sinParecido = 0;
      else if (b.rol === 'titulo' || texto.length > 400 || ++sinParecido >= 2) enReferencias = false;
    }
    const esReferencia = enReferencias && !esTituloRefs && (sinParecido === 0 || texto.length < 200);
    const idioma = idiomaDeTexto(texto) ?? idiomaPrevio;
    if (!b.elemento) idiomaPrevio = idioma;
    for (const [ini, fin] of segmentar(b.texto)) {
      const rects = rectangulos(b, ini, fin, limpias);
      const frase = b.texto.slice(ini, fin);
      // Una ecuación puede venir pegada al párrafo que la presenta.
      const propia = esFormula(frase) ? 'formula' : SOLO_CIFRAS.test(frase) ? 'tabla' : null;
      oraciones.push({
        i: oraciones.length,
        texto: frase,
        rects,
        pagina: rects[0]?.p ?? b.pagina,
        bloque: numBloque,
        rol: b.rol,
        referencia: esReferencia,
        elemento: esReferencia ? null : b.elemento ?? propia,
        idioma,
      });
    }
  });
  return { oraciones, idioma: idiomaDocumento };
}

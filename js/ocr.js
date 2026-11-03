// Reconocimiento de texto para PDF escaneados con Tesseract.js, que solo se carga si hace falta.

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/';
const NUCLEO = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0/';
const IDIOMA = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/spa@1.0.0/4.0.0_best_int/';
const ESCALA = 2;

function cargarGuion(url) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) {
      resolve();
      return;
    }
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar el reconocimiento de texto. Revisa la conexión a internet.'));
    document.head.append(s);
  });
}

// Recorre las páginas indicadas y devuelve, para cada una, cajas de palabras en unidades de página.
export async function reconocerPaginas(pdf, numeros, { alAvance, debeParar }) {
  await cargarGuion(`${TESSERACT}tesseract.min.js`);
  const worker = await window.Tesseract.createWorker('spa', 1, {
    workerPath: `${TESSERACT}worker.min.js`,
    corePath: NUCLEO,
    langPath: IDIOMA,
  });
  const resultado = new Map();
  try {
    for (const [posicion, numero] of numeros.entries()) {
      if (debeParar()) break;
      alAvance(posicion, numeros.length);
      const pagina = await pdf.getPage(numero + 1);
      const viewport = pagina.getViewport({ scale: ESCALA });
      const lienzo = document.createElement('canvas');
      lienzo.width = viewport.width;
      lienzo.height = viewport.height;
      await pagina.render({ canvas: lienzo, viewport }).promise;
      const { data } = await worker.recognize(lienzo, {}, { blocks: true, text: false });
      const items = [];
      for (const bloque of data.blocks ?? []) {
        for (const parrafo of bloque.paragraphs ?? []) {
          for (const linea of parrafo.lines ?? []) {
            for (const palabra of linea.words ?? []) {
              if (palabra.confidence < 35 || !palabra.text.trim()) continue;
              const { x0, x1 } = palabra.bbox;
              // Todas las palabras toman la altura de su línea para que queden en la misma fila.
              const top = linea.bbox.y0 / ESCALA;
              const h = (linea.bbox.y1 - linea.bbox.y0) / ESCALA;
              items.push({ str: palabra.text, x: x0 / ESCALA, top, base: top + h * 0.86, w: (x1 - x0) / ESCALA, h, ocr: true });
            }
          }
        }
      }
      resultado.set(numero, items);
      lienzo.width = 0;
      pagina.cleanup();
    }
  } finally {
    await worker.terminate();
  }
  return resultado;
}

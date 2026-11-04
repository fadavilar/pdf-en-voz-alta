// Worker de traducción inglés → español con Bergamot, el motor de Firefox Translations.
// Todo se ejecuta en el dispositivo: el texto no sale de este worker.

const BASE = new URL('../vendor/traduccion/', location.href).href;
const ALMACEN = 'pdf-voz-modelos-v1';
const ARCHIVOS = [
  { clave: 'wasm', nombre: 'bergamot-translator.wasm', peso: 5e6 },
  { clave: 'model', nombre: 'model.enes.intgemm.alphas.bin', peso: 31561787, alineacion: 256 },
  { clave: 'lex', nombre: 'lex.50.50.enes.s2t.bin', peso: 4.2e6, alineacion: 64 },
  { clave: 'vocab', nombre: 'vocab.enes.spm', peso: 8e5, alineacion: 64 },
];
const CONFIGURACION = {
  'beam-size': '1',
  normalize: '1.0',
  'word-penalty': '0',
  'max-length-break': '128',
  'mini-batch-words': '1024',
  workspace: '128',
  'max-length-factor': '2.0',
  'skip-cost': 'true',
  'cpu-threads': '0',
  quiet: 'true',
  'quiet-translation': 'true',
  'gemm-precision': 'int8shiftAlphaAll',
  alignment: 'soft',
};

let bergamot = null;
let servicio = null;
let modelo = null;

async function traer(nombre, alProgreso) {
  const url = `${BASE}${nombre}`;
  const almacen = await caches.open(ALMACEN);
  const guardado = await almacen.match(url);
  if (guardado) {
    const buffer = await guardado.arrayBuffer();
    alProgreso(buffer.byteLength);
    return buffer;
  }
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No se pudo descargar ${nombre} (error ${respuesta.status}).`);
  const lector = respuesta.body.getReader();
  const trozos = [];
  let recibido = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    trozos.push(value);
    recibido += value.length;
    alProgreso(recibido);
  }
  const blob = new Blob(trozos);
  await almacen.put(url, new Response(blob));
  return blob.arrayBuffer();
}

function iniciarWasm(wasmBinary) {
  return new Promise((resolve, reject) => {
    const modulo = loadBergamot({
      INITIAL_MEMORY: 41943040,
      print: () => {},
      onAbort: () => reject(new Error('El traductor no pudo iniciar en este navegador.')),
      onRuntimeInitialized: async () => {
        await Promise.resolve();
        resolve(modulo);
      },
      wasmBinary,
    });
  });
}

async function preparar() {
  if (servicio) return;
  importScripts(`${BASE}bergamot-translator.js`);
  const hecho = new Map();
  const total = ARCHIVOS.reduce((s, a) => s + a.peso, 0);
  const buffers = await Promise.all(ARCHIVOS.map(async (a) => [a.clave, await traer(a.nombre, (n) => {
    hecho.set(a.clave, n);
    postMessage({ tipo: 'progreso', hecho: [...hecho.values()].reduce((s, v) => s + v, 0), total });
  })]));
  const datos = Object.fromEntries(buffers);
  bergamot = await iniciarWasm(datos.wasm);
  const alinear = (clave) => {
    const { alineacion } = ARCHIVOS.find((a) => a.clave === clave);
    const memoria = new bergamot.AlignedMemory(datos[clave].byteLength, alineacion);
    memoria.getByteArrayView().set(new Uint8Array(datos[clave]));
    return memoria;
  };
  const vocabularios = new bergamot.AlignedMemoryList();
  vocabularios.push_back(alinear('vocab'));
  const texto = `\n${Object.entries(CONFIGURACION).map(([k, v]) => `            ${k}: ${v}\n`).join('')}            `;
  modelo = new bergamot.TranslationModel('en', 'es', texto, alinear('model'), alinear('lex'), vocabularios, null);
  servicio = new bergamot.BlockingService({ cacheSize: 0 });
}

function traducir(texto) {
  const mensajes = new bergamot.VectorString();
  const opciones = new bergamot.VectorResponseOptions();
  mensajes.push_back(texto);
  opciones.push_back({ qualityScores: false, alignment: false, html: false });
  const respuestas = servicio.translate(modelo, mensajes, opciones);
  const resultado = respuestas.get(0).getTranslatedText();
  mensajes.delete();
  opciones.delete();
  respuestas.delete();
  return resultado;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.tipo === 'preparar') {
      await preparar();
      postMessage({ tipo: 'lista', id: data.id });
    } else if (data.tipo === 'traducir') {
      const inicio = performance.now();
      postMessage({ tipo: 'traduccion', id: data.id, texto: traducir(data.texto), ms: performance.now() - inicio });
    }
  } catch (error) {
    postMessage({ tipo: 'error', id: data.id, mensaje: error.message ?? String(error) });
  }
};

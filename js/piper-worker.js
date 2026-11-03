// Worker de voz neuronal: fonemiza con espeak-ng (piper-wasm) e infiere con ONNX Runtime Web.
// Corre aparte para que la interfaz no se congele mientras se genera el audio.

const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const FONEMAS_BASE = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/';
const VOCES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const ALMACEN = 'pdf-voz-modelos-v1';
const SILENCIO_ENTRE_ORACIONES = 0.28;

let sesion = null;
let configuracion = null;
let vozActual = null;
let fonemasWasm = null;
let fonemasDatos = null;

// Descarga una sola vez: lo guardado en la Cache API no vuelve a la red.
async function traer(url, alProgreso) {
  const almacen = await caches.open(ALMACEN);
  const guardado = await almacen.match(url);
  if (guardado) {
    const buffer = await guardado.arrayBuffer();
    alProgreso?.(buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const respuesta = await fetch(url);
  if (!respuesta.ok) throw new Error(`No se pudo descargar ${url.split('/').pop()} (error ${respuesta.status}).`);
  const total = Number(respuesta.headers.get('content-length')) || 0;
  const lector = respuesta.body.getReader();
  const trozos = [];
  let recibido = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    trozos.push(value);
    recibido += value.length;
    alProgreso?.(recibido, total);
  }
  const blob = new Blob(trozos);
  await almacen.put(url, new Response(blob));
  return blob.arrayBuffer();
}

function avisarProgreso(tareas) {
  // Suma el avance de todas las descargas en curso para mostrar una sola barra.
  const estado = tareas.map((t) => ({ ...t, hecho: 0 }));
  return estado.map((t) => (recibido) => {
    t.hecho = recibido;
    const hecho = estado.reduce((s, x) => s + x.hecho, 0);
    const total = estado.reduce((s, x) => s + x.peso, 0);
    postMessage({ tipo: 'progreso', hecho, total });
  });
}

async function preparar(voz) {
  if (vozActual === voz.ruta && sesion) return;
  if (!self.ort) {
    importScripts(`${ORT_BASE}ort.wasm.min.js`);
    importScripts(`${FONEMAS_BASE}piper_phonemize.js`);
    ort.env.wasm.wasmPaths = ORT_BASE;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  }
  const [pMotor, pDatos, pFon, pModelo] = avisarProgreso([
    { peso: 14239897 },
    { peso: 18077249 },
    { peso: 635212 },
    { peso: voz.bytes },
  ]);
  const [wasmOrt, datos, wasmFon, modelo, config] = await Promise.all([
    traer(`${ORT_BASE}ort-wasm-simd-threaded.wasm`, pMotor),
    traer(`${FONEMAS_BASE}piper_phonemize.data`, pDatos),
    traer(`${FONEMAS_BASE}piper_phonemize.wasm`, pFon),
    traer(`${VOCES_BASE}${voz.ruta}`, pModelo),
    traer(`${VOCES_BASE}${voz.ruta}.json`),
  ]);
  ort.env.wasm.wasmBinary = new Uint8Array(wasmOrt);
  fonemasDatos = datos;
  fonemasWasm = wasmFon;
  configuracion = JSON.parse(new TextDecoder().decode(config));
  sesion = await ort.InferenceSession.create(new Uint8Array(modelo), { executionProviders: ['wasm'] });
  vozActual = voz.ruta;
}

function fonemizar(texto) {
  return new Promise((resolve, reject) => {
    let listo = false;
    createPiperPhonemize({
      wasmBinary: fonemasWasm,
      getPreloadedPackage: () => fonemasDatos.slice(0),
      print: (salida) => {
        listo = true;
        resolve(JSON.parse(salida).phoneme_ids);
      },
      printErr: (mensaje) => {
        if (!listo) reject(new Error(mensaje));
      },
      locateFile: (archivo) => `${FONEMAS_BASE}${archivo}`,
    }).then((modulo) => {
      modulo.callMain(['-l', configuracion.espeak.voice, '--input', JSON.stringify([{ text: texto }]), '--espeak_data', '/espeak-ng-data']);
    }, reject);
  });
}

function aWav(pcm, frecuencia, silencio) {
  const relleno = Math.round(frecuencia * silencio);
  const muestras = pcm.length + relleno;
  const buffer = new ArrayBuffer(44 + muestras * 2);
  const v = new DataView(buffer);
  const ascii = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + muestras * 2, true);
  ascii(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, frecuencia, true);
  v.setUint32(28, frecuencia * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  ascii(36, 'data');
  v.setUint32(40, muestras * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const m = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, m < 0 ? m * 32768 : m * 32767, true);
  }
  return buffer;
}

async function sintetizar(texto) {
  const inicio = performance.now();
  const ids = await fonemizar(texto);
  const msFonemas = performance.now() - inicio;
  const { noise_scale: ruido, length_scale: largo, noise_w: ruidoW } = configuracion.inference;
  const entradas = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)])),
    scales: new ort.Tensor('float32', Float32Array.from([ruido, largo, ruidoW])),
  };
  if (configuracion.num_speakers > 1) entradas.sid = new ort.Tensor('int64', BigInt64Array.from([0n]));
  const { output } = await sesion.run(entradas);
  const frecuencia = configuracion.audio.sample_rate;
  const wav = aWav(output.data, frecuencia, SILENCIO_ENTRE_ORACIONES);
  return { wav, segundos: output.data.length / frecuencia, ms: performance.now() - inicio, msFonemas };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.tipo === 'preparar') {
      await preparar(data.voz);
      postMessage({ tipo: 'lista', id: data.id, hilos: ort.env.wasm.numThreads });
    } else if (data.tipo === 'sintetizar') {
      const r = await sintetizar(data.texto);
      postMessage({ tipo: 'audio', id: data.id, ...r }, [r.wav]);
    }
  } catch (error) {
    postMessage({ tipo: 'error', id: data.id, mensaje: error.message ?? String(error) });
  }
};

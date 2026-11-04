// Dos motores con la misma interfaz: hablar, pausar, reanudar, detener y cambiar de velocidad.
// El motor del dispositivo usa la Web Speech API; el neuronal, voces Piper dentro del navegador.

export const VOCES_NEURONALES = [
  { id: 'es_MX-ald-medium', nombre: 'Ald (México)', ruta: 'es/es_MX/ald/medium/es_MX-ald-medium.onnx', bytes: 63201294, licencia: 'Unlicense' },
  { id: 'es_MX-claude-high', nombre: 'Claude (México, alta calidad)', ruta: 'es/es_MX/claude/high/es_MX-claude-high.onnx', bytes: 63122309, licencia: 'Apache-2.0' },
  { id: 'es_ES-davefx-medium', nombre: 'Davefx (España)', ruta: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx', bytes: 63201294, licencia: 'CC0' },
  { id: 'es_AR-daniela-high', nombre: 'Daniela (Argentina, alta calidad)', ruta: 'es/es_AR/daniela/high/es_AR-daniela-high.onnx', bytes: 114199011, licencia: 'CC BY-SA 4.0' },
  { id: 'es_MX-ald-x_low', nombre: 'Ald ligera (México, para el celular)', ruta: 'es/es_MX/ald/x_low/es_MX-ald-x_low.onnx', bytes: 20986952, licencia: 'Unlicense' },
];

const VOCES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.wasm';
const ALMACEN = 'pdf-voz-modelos-v1';
const PREFERENCIA_ACENTO = ['es-CO', 'es-419', 'es-MX', 'es-US', 'es-AR', 'es-ES'];

export function vocesDelDispositivo() {
  if (!('speechSynthesis' in window)) return [];
  const peso = (v) => {
    const i = PREFERENCIA_ACENTO.findIndex((a) => a.toLowerCase() === v.lang.replace('_', '-').toLowerCase());
    return i === -1 ? PREFERENCIA_ACENTO.length : i;
  };
  return speechSynthesis
    .getVoices()
    .filter((v) => /^es([-_]|$)/i.test(v.lang))
    .sort((a, b) => peso(a) - peso(b) || a.name.localeCompare(b.name));
}

export function alCambiarVoces(fn) {
  if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fn);
}

export class MotorDispositivo {
  constructor() {
    this.tipo = 'dispositivo';
    this.voz = null;
    this.velocidad = 1;
    this.turno = 0;
    this.pendiente = null;
  }

  usarVoz(voz) {
    this.voz = voz;
  }

  #decir() {
    const p = this.pendiente;
    const turno = ++this.turno;
    const u = new SpeechSynthesisUtterance(p.texto.slice(p.desde));
    if (this.voz) u.voice = this.voz;
    u.lang = this.voz?.lang ?? 'es-419';
    u.rate = this.velocidad;
    const base = p.desde;
    const guardia = setTimeout(() => {
      if (turno === this.turno && !p.empezo) {
        this.turno++;
        speechSynthesis.cancel();
        this.pendiente = null;
        p.reject(new Error('El navegador no empezó a hablar con esta voz. Prueba otra voz en Ajustes.'));
      }
    }, 8000);
    u.onstart = () => {
      p.empezo = true;
      clearTimeout(guardia);
    };
    u.onboundary = (e) => {
      if (turno === this.turno && e.name !== 'sentence') p.ultimo = base + e.charIndex;
    };
    u.onend = () => {
      clearTimeout(guardia);
      if (turno !== this.turno) return;
      this.pendiente = null;
      p.resolve('fin');
    };
    u.onerror = (e) => {
      clearTimeout(guardia);
      if (turno !== this.turno || e.error === 'canceled' || e.error === 'interrupted') return;
      this.pendiente = null;
      p.reject(new Error(`El navegador no pudo leer con esta voz (${e.error}). Prueba otra voz en Ajustes.`));
    };
    this.utterance = u; // evita que el recolector de basura la elimine a media frase en Chrome
    speechSynthesis.speak(u);
  }

  hablar(_i, texto) {
    this.detener();
    return new Promise((resolve, reject) => {
      this.pendiente = { texto, desde: 0, ultimo: 0, resolve, reject, empezo: false };
      this.#decir();
    });
  }

  // Pausar cancela y recuerda la última palabra: speechSynthesis.pause falla en Android.
  pausar() {
    if (!this.pendiente) return;
    this.turno++;
    speechSynthesis.cancel();
    this.pendiente.desde = this.pendiente.ultimo;
    this.pendiente.empezo = false;
  }

  reanudar() {
    if (this.pendiente) this.#decir();
  }

  detener() {
    this.turno++;
    speechSynthesis.cancel();
    if (this.pendiente) {
      this.pendiente.resolve('cancelado');
      this.pendiente = null;
    }
  }

  cambiarVelocidad(v, sonando) {
    this.velocidad = v;
    if (sonando && this.pendiente) {
      this.pausar();
      this.reanudar();
    }
  }

  precargar() {}
}

export class MotorNeuronal {
  constructor(audio, { alEsperar, alProgreso } = {}) {
    this.tipo = 'neuronal';
    this.audio = audio;
    this.velocidad = 1;
    this.alEsperar = alEsperar;
    this.alProgreso = alProgreso;
    this.worker = null;
    this.vozLista = null;
    this.contador = 0;
    this.solicitudes = new Map();
    this.cola = [];
    this.ocupado = false;
    this.cache = new Map();
    this.pendiente = null;
    this.ultimaMedida = null;
  }

  #mensaje({ data }) {
    if (data.tipo === 'progreso') {
      this.alProgreso?.(data.hecho, data.total);
      return;
    }
    const s = this.solicitudes.get(data.id);
    this.solicitudes.delete(data.id);
    if (data.tipo === 'error') s?.reject(new Error(data.mensaje));
    else s?.resolve(data);
    this.ocupado = false;
    this.#siguiente();
  }

  #enviar(mensaje) {
    const id = ++this.contador;
    return new Promise((resolve, reject) => {
      this.solicitudes.set(id, { resolve, reject });
      this.worker.postMessage({ ...mensaje, id });
    });
  }

  async preparar(voz) {
    if (this.vozLista === voz.id) return;
    if (!this.worker) {
      this.worker = new Worker('js/piper-worker.js?v=20261104a');
      this.worker.onmessage = (e) => this.#mensaje(e);
      this.worker.onerror = (e) => {
        const error = new Error(e.message || 'El motor de voz neuronal no pudo iniciar.');
        for (const s of this.solicitudes.values()) s.reject(error);
        this.solicitudes.clear();
        this.ocupado = false;
      };
    }
    this.vaciar();
    this.ocupado = true;
    await this.#enviar({ tipo: 'preparar', voz: { ruta: voz.ruta, bytes: voz.bytes } });
    this.vozLista = voz.id;
  }

  #siguiente() {
    if (this.ocupado || !this.cola.length || !this.vozLista) return;
    const tarea = this.cola.shift();
    this.ocupado = true;
    this.#enviar({ tipo: 'sintetizar', texto: tarea.texto }).then(
      (r) => {
        this.ultimaMedida = { ms: r.ms, segundos: r.segundos, msFonemas: r.msFonemas };
        tarea.resolve(URL.createObjectURL(new Blob([r.wav], { type: 'audio/wav' })));
      },
      tarea.reject,
    );
  }

  #obtener(i, texto, urgente) {
    const clave = `${this.vozLista}:${i}:${texto}`;
    let entrada = this.cache.get(clave);
    if (!entrada) {
      entrada = { i };
      entrada.promesa = new Promise((resolve, reject) => {
        const tarea = { texto, resolve, reject, clave };
        entrada.tarea = tarea;
        if (urgente) this.cola.unshift(tarea);
        else this.cola.push(tarea);
      }).then((url) => {
        entrada.url = url;
        entrada.tarea = null;
        return url;
      });
      entrada.promesa.catch(() => this.cache.delete(clave));
      this.cache.set(clave, entrada);
      this.#siguiente();
    } else if (urgente && entrada.tarea) {
      const pos = this.cola.indexOf(entrada.tarea);
      if (pos > 0) this.cola.unshift(...this.cola.splice(pos, 1));
    }
    return entrada.promesa;
  }

  // Mantiene listo el audio de las próximas oraciones y libera el que quedó lejos.
  precargar(lista, actual) {
    const claves = new Set(lista.map(({ i, texto }) => `${this.vozLista}:${i}:${texto}`));
    this.cola = this.cola.filter((t) => {
      if (claves.has(t.clave)) return true;
      this.cache.delete(t.clave);
      return false;
    });
    for (const [clave, e] of this.cache) {
      if (e.url && Math.abs(e.i - actual) > 8) {
        URL.revokeObjectURL(e.url);
        this.cache.delete(clave);
      }
    }
    for (const { i, texto } of lista) this.#obtener(i, texto, false);
  }

  // Libera la memoria del modelo; la voz vuelve a cargarse desde la caché al reproducir.
  liberar() {
    this.detener();
    this.vaciar();
    this.worker?.terminate();
    this.worker = null;
    this.vozLista = null;
    this.solicitudes.clear();
    this.ocupado = false;
  }

  vaciar() {
    this.cola = [];
    for (const e of this.cache.values()) if (e.url) URL.revokeObjectURL(e.url);
    this.cache.clear();
  }

  async hablar(i, texto) {
    this.detener();
    const turno = {};
    this.turnoActual = turno;
    let listo = false;
    const aviso = setTimeout(() => {
      if (!listo && this.turnoActual === turno) this.alEsperar?.(true);
    }, 150);
    let url;
    try {
      url = await this.#obtener(i, texto, true);
    } finally {
      listo = true;
      clearTimeout(aviso);
      this.alEsperar?.(false);
    }
    if (this.turnoActual !== turno) return 'cancelado';
    return new Promise((resolve, reject) => {
      this.pendiente = { resolve };
      const a = this.audio;
      a.onended = () => {
        this.pendiente = null;
        resolve('fin');
      };
      a.onerror = () => {
        this.pendiente = null;
        reject(new Error('No se pudo reproducir el audio generado.'));
      };
      a.src = url;
      a.playbackRate = this.velocidad;
      if (!this.enPausa) a.play().catch((e) => {
        if (e.name !== 'AbortError') {
          this.pendiente = null;
          reject(new Error('El navegador bloqueó el audio. Pulsa reproducir de nuevo.'));
        }
      });
    });
  }

  pausar() {
    this.enPausa = true;
    this.audio.pause();
  }

  reanudar() {
    this.enPausa = false;
    if (this.audio.src && this.pendiente) this.audio.play().catch(() => {});
  }

  detener() {
    this.enPausa = false;
    this.turnoActual = null;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    if (this.pendiente) {
      this.pendiente.resolve('cancelado');
      this.pendiente = null;
    }
  }

  cambiarVelocidad(v) {
    this.velocidad = v;
    this.audio.playbackRate = v;
  }
}

export async function vozGuardada(voz) {
  if (!('caches' in window)) return false;
  const almacen = await caches.open(ALMACEN);
  return Boolean(await almacen.match(`${VOCES_BASE}${voz.ruta}`));
}

export async function motorGuardado() {
  if (!('caches' in window)) return false;
  const almacen = await caches.open(ALMACEN);
  return Boolean(await almacen.match(ORT_WASM));
}

export async function borrarVoz(voz) {
  const almacen = await caches.open(ALMACEN);
  await almacen.delete(`${VOCES_BASE}${voz.ruta}`);
  await almacen.delete(`${VOCES_BASE}${voz.ruta}.json`);
}

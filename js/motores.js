// Dos motores con la misma interfaz: hablar, pausar, reanudar, detener y cambiar de velocidad.
// El motor del dispositivo usa la Web Speech API; el neuronal, voces Piper dentro del navegador.

import { SalidaFlujo, SalidaBloques, sonarRuido } from './salidas.js?v=20261124a';

export const VOCES_NEURONALES = [
  { id: 'es_MX-ald-medium', nombre: 'Ald (México)', ruta: 'es/es_MX/ald/medium/es_MX-ald-medium.onnx', bytes: 63201294, licencia: 'Unlicense' },
  { id: 'es_MX-claude-high', nombre: 'Claude (México, alta calidad)', ruta: 'es/es_MX/claude/high/es_MX-claude-high.onnx', bytes: 63122309, licencia: 'Apache-2.0' },
  { id: 'es_ES-davefx-medium', nombre: 'Davefx (España)', ruta: 'es/es_ES/davefx/medium/es_ES-davefx-medium.onnx', bytes: 63201294, licencia: 'CC0' },
  { id: 'es_AR-daniela-high', nombre: 'Daniela (Argentina, alta calidad)', ruta: 'es/es_AR/daniela/high/es_AR-daniela-high.onnx', bytes: 114199011, licencia: 'CC BY-SA 4.0' },
  { id: 'es_MX-ald-x_low', nombre: 'Ald ligera (México, para el celular)', ruta: 'es/es_MX/ald/x_low/es_MX-ald-x_low.onnx', bytes: 20986952, licencia: 'Unlicense' },
];

export const VOCES_INGLESAS = [
  { id: 'en_US-ljspeech-medium', nombre: 'LJ (Estados Unidos)', ruta: 'en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx', bytes: 63531379, licencia: 'Dominio público' },
  { id: 'en_GB-cori-medium', nombre: 'Cori (Reino Unido)', ruta: 'en/en_GB/cori/medium/en_GB-cori-medium.onnx', bytes: 63531379, licencia: 'Dominio público' },
  { id: 'en_GB-alba-medium', nombre: 'Alba (Reino Unido)', ruta: 'en/en_GB/alba/medium/en_GB-alba-medium.onnx', bytes: 63201294, licencia: 'CC BY 4.0' },
];

const VOCES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
const ORT_WASM = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort-wasm-simd-threaded.wasm';
const ALMACEN = 'pdf-voz-modelos-v1';
const PREFERENCIA_ACENTO = {
  es: ['es-CO', 'es-419', 'es-MX', 'es-US', 'es-AR', 'es-ES'],
  en: ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IE', 'en-IN'],
};

export function ordenarVoces(voces, idioma) {
  const acentos = PREFERENCIA_ACENTO[idioma];
  const peso = (v) => {
    const i = acentos.findIndex((a) => a.toLowerCase() === v.lang.replace('_', '-').toLowerCase());
    return i === -1 ? acentos.length : i;
  };
  return voces
    .filter((v) => new RegExp(`^${idioma}([-_]|$)`, 'i').test(v.lang))
    .sort((a, b) => peso(a) - peso(b) || a.name.localeCompare(b.name));
}

export function vocesDelDispositivo(idioma = 'es') {
  if (!('speechSynthesis' in window)) return [];
  return ordenarVoces(speechSynthesis.getVoices(), idioma);
}

// Una voz sin conexión primero: no envía el texto a ningún proveedor.
export function mejorVoz(voces) {
  return voces.find((v) => v.localService) ?? voces[0] ?? null;
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
      // Con la pantalla bloqueada el sistema retiene la voz: no es un error, sigue al volver.
      if (document.visibilityState === 'hidden') return;
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

// Cuánto audio se deja listo por delante: si el teléfono frena el cálculo en segundo plano, alcanza.
const ADELANTO_MAXIMO = 900;

export class MotorNeuronal {
  constructor(audio, { alEsperar, alProgreso, registrar } = {}) {
    this.tipo = 'neuronal';
    this.audio = audio;
    this.velocidad = 1;
    this.alEsperar = alEsperar;
    this.alProgreso = alProgreso;
    this.registrar = registrar ?? (() => {});
    this.worker = null;
    this.vozLista = null;
    this.disponibles = new Set();
    this.contador = 0;
    this.solicitudes = new Map();
    this.cola = [];
    this.tramos = new Map();
    this.produciendo = false;
    this.generacion = 0;
    this.pendiente = null;
    this.enPausa = false;
    this.reubicar = true;
    this.vaciado = false;
    this.ultima = false;
    this.salida = SalidaFlujo.compatible() ? new SalidaFlujo(audio) : new SalidaBloques(audio);
    for (const e of ['timeupdate', 'ended', 'seeked', 'waiting']) audio.addEventListener(e, () => this.#revisar());
    setInterval(() => this.#revisar(), 500);
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
  }

  #enviar(mensaje) {
    if (!this.worker) {
      this.worker = new Worker('js/piper-worker.js?v=20261124a');
      this.worker.onmessage = (e) => this.#mensaje(e);
      this.worker.onerror = (e) => {
        const error = new Error(e.message || 'El motor de voz neuronal no pudo iniciar.');
        for (const s of this.solicitudes.values()) s.reject(error);
        this.solicitudes.clear();
      };
    }
    const id = ++this.contador;
    return new Promise((resolve, reject) => {
      this.solicitudes.set(id, { resolve, reject });
      this.worker.postMessage({ ...mensaje, id });
    });
  }

  async preparar(voz) {
    const r = await this.#enviar({ tipo: 'preparar', voz: { ruta: voz.ruta, bytes: voz.bytes } });
    this.vozLista = voz.id;
    this.disponibles.add(voz.id);
    this.registrar('voz:lista', `${voz.id} hilos=${r.hilos} salida=${this.salida.tipo}`);
  }

  #sintetizar(voz, texto) {
    return this.#enviar({ tipo: 'sintetizar', texto, voz: { ruta: voz.ruta, bytes: voz.bytes } });
  }

  #clave(i, texto, voz) {
    return `${voz.id}:${i}:${texto}`;
  }

  #encolar(i, texto, voz) {
    const clave = this.#clave(i, texto, voz);
    let t = this.tramos.get(clave);
    if (t) return t;
    t = { i, texto, voz, hecho: false };
    t.promesa = new Promise((resolve) => {
      t.resolver = resolve;
    });
    this.tramos.set(clave, t);
    this.cola.push(t);
    this.#producir();
    return t;
  }

  // Genera y encadena en orden. No depende de temporizadores, que en segundo plano se frenan.
  async #producir() {
    if (this.produciendo) return;
    this.produciendo = true;
    while (this.cola.length) {
      if (this.salida.adelanto() > ADELANTO_MAXIMO) {
        await new Promise((r) => this.audio.addEventListener('timeupdate', r, { once: true }));
        continue;
      }
      const generacion = this.generacion;
      const t = this.cola.shift();
      try {
        const r = await this.#sintetizar(t.voz, t.texto);
        if (generacion !== this.generacion) {
          t.resolver();
          continue;
        }
        Object.assign(t, await this.salida.agregar(new Uint8Array(r.mp3)));
        t.hecho = generacion === this.generacion;
        if (t.i % 10 === 0) this.registrar('audio:listo', `adelanto=${this.salida.adelanto().toFixed(0)}s ritmo=${(r.ms / 1000 / r.segundos).toFixed(2)}`);
      } catch (e) {
        t.error = e;
        this.registrar('audio:fallo', e.message);
      }
      t.resolver();
    }
    this.produciendo = false;
    this.#cerrarSiEsElFinal();
  }

  #cerrarSiEsElFinal() {
    if (this.ultima && !this.cola.length && !this.produciendo && this.tramos.size) this.salida.terminar().catch(() => {});
  }

  // Audio que debe quedar listo después de la oración en curso, en orden de lectura.
  precargar(lista, { ultima = false } = {}) {
    this.ultima = ultima;
    for (const { i, texto, voz } of lista) this.#encolar(i, texto, voz);
    this.#cerrarSiEsElFinal();
  }

  adelanto() {
    return this.salida.adelanto();
  }

  // Debe llamarse desde un clic: deja la reproducción abierta aunque el audio aún no exista.
  mantenerVivo() {
    this.enPausa = false;
    this.salida.enPausa = false;
    if (this.vaciado) {
      this.vaciado = false;
      this.#reiniciar(); // que no suene lo anterior mientras se prepara lo nuevo
    }
    this.salida.abrir();
    this.#velocidad();
    if (!this.audio.ended) this.audio.play().catch(() => {}); // al terminar, reproducir volvería al comienzo
  }

  // Mantiene despierta la página sin leer nada (por ejemplo, mientras se genera el MP3).
  sostener() {
    this.salida.cerrar();
    sonarRuido(this.audio);
  }

  async #reiniciar() {
    this.generacion++;
    for (const t of this.cola) t.resolver();
    this.cola = [];
    this.tramos.clear();
    this.ultima = false;
    await this.salida.saltar();
  }

  #revisar() {
    const p = this.pendiente;
    if (!p || this.enPausa) return;
    // Cada oración cierra con una pausa: adelantarse un poco no corta nada. Y si se agotó el audio
    // listo, el navegador se detiene unas décimas antes del final y nunca llega al borde exacto.
    const falta = p.fin - this.salida.posicion();
    const agotado = this.audio.readyState < 3 && falta < 0.8;
    if (falta <= 0.15 || agotado || (this.audio.ended && !this.salida.bloque)) {
      this.pendiente = null;
      p.resolve('fin');
    }
  }

  // Se resuelve cuando la oración terminó de sonar. Si el código estuvo suspendido y el audio ya pasó
  // de largo, se resuelve enseguida y el resaltado se pone al día.
  async hablar(i, texto, voz) {
    this.#cancelarEspera();
    const turno = {};
    this.turnoActual = turno;
    this.enPausa = false;
    this.salida.enPausa = false;
    let t = this.tramos.get(this.#clave(i, texto, voz));
    if (this.vaciado || !t || (this.reubicar && !(t.hecho && this.salida.ir(t.ini)))) {
      this.vaciado = false;
      const reinicio = this.#reiniciar();
      t = this.#encolar(i, texto, voz);
      await reinicio;
    }
    this.reubicar = false;
    if (t.hecho && t.ini - this.salida.posicion() > 0.5) this.salida.ir(t.ini);
    await this.salida.abrir();
    if (this.turnoActual !== turno) return 'cancelado';
    this.#velocidad();
    this.#arrancar();
    const aviso = setTimeout(() => {
      if (!t.hecho && this.turnoActual === turno) this.alEsperar?.(true);
    }, 200);
    await t.promesa;
    clearTimeout(aviso);
    this.alEsperar?.(false);
    if (this.turnoActual !== turno) return 'cancelado';
    if (t.error) return 'fallo';
    if (!t.hecho) return this.hablar(i, texto, voz); // se descartó al cambiar un ajuste: se genera de nuevo
    this.#arrancar();
    return new Promise((resolve) => {
      this.pendiente = { fin: t.fin, resolve };
      this.#revisar();
    });
  }

  #arrancar() {
    if (!this.audio.paused || this.audio.ended || this.enPausa) return;
    this.audio.play().catch((e) => {
      if (e.name === 'NotAllowedError') this.registrar('audio:bloqueado', e.message);
    });
  }

  async probar(voz, texto) {
    const r = await this.#sintetizar(voz, texto);
    this.vozLista = voz.id;
    const url = URL.createObjectURL(new Blob([r.mp3], { type: 'audio/mpeg' }));
    const a = new Audio(url);
    await new Promise((resolve, reject) => {
      a.onended = resolve;
      a.onerror = () => reject(new Error('No se pudo reproducir la prueba.'));
      a.play().catch(reject);
    });
    URL.revokeObjectURL(url);
  }

  #velocidad() {
    this.audio.defaultPlaybackRate = this.velocidad;
    this.audio.playbackRate = this.velocidad;
  }

  cambiarVelocidad(v) {
    this.velocidad = v;
    this.#velocidad();
  }

  pausar({ externa = false } = {}) {
    this.enPausa = true;
    this.salida.enPausa = true;
    if (!externa) this.audio.pause();
  }

  reanudar() {
    this.enPausa = false;
    this.salida.enPausa = false;
    this.audio.play().catch(() => {});
  }

  #cancelarEspera() {
    this.turnoActual = null;
    if (this.pendiente) {
      this.pendiente.resolve('cancelado');
      this.pendiente = null;
    }
  }

  // Cambia de oración sin cortar el audio: en segundo plano, volver a arrancarlo puede estar prohibido.
  soltar() {
    this.#cancelarEspera();
    this.reubicar = true;
  }

  detener() {
    this.soltar();
    this.enPausa = false;
    this.audio.pause();
  }

  // Lo generado ya no sirve (cambió el idioma, las citas o la voz).
  vaciar() {
    this.generacion++;
    for (const t of this.cola) t.resolver();
    this.cola = [];
    this.vaciado = true;
  }

  // Libera la memoria del modelo; la voz vuelve a cargarse desde la caché al reproducir.
  liberar() {
    this.detener();
    this.vaciar();
    this.tramos.clear();
    this.salida.cerrar();
    this.worker?.terminate();
    this.worker = null;
    this.vozLista = null;
    this.disponibles.clear();
    for (const s of this.solicitudes.values()) s.reject(new Error('motor cerrado'));
    this.solicitudes.clear();
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

// Dos formas de reproducir las oraciones como un solo audio largo, con la misma interfaz.
// Encadenarlas evita lo que detenía la lectura en segundo plano: Chrome en Android solo trata como
// reproducción lo que dura 5 s o más, y en iPhone cambiar de archivo con la pantalla bloqueada falla.

const BYTES_POR_SEGUNDO = 8000; // MP3 a 64 kbit/s constantes
const MINIMO_BLOQUE = 6;
const DETRAS = 90;

export const duracionMp3 = (bytes) => bytes / BYTES_POR_SEGUNDO;

// Ruido de unos -63 dB, inaudible en la práctica: el silencio exacto no cuenta como sonido
// para el navegador y la página quedaría expuesta a suspenderse.
export function ruidoWav(segundos = 20) {
  const frecuencia = 8000;
  const muestras = frecuencia * segundos;
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
  let semilla = 1;
  for (let i = 0; i < muestras; i++) {
    semilla = (semilla * 16807) % 2147483647;
    v.setInt16(44 + i * 2, (semilla % 81) - 40, true);
  }
  return buffer;
}

let urlRuido = null;
export function sonarRuido(audio) {
  urlRuido ??= URL.createObjectURL(new Blob([ruidoWav()], { type: 'audio/wav' }));
  audio.loop = true;
  audio.src = urlRuido;
  audio.play().catch(() => {});
}

// Un único flujo que nunca cambia de archivo: si el teléfono suspende el código de la página,
// el audio ya encadenado sigue sonando solo.
export class SalidaFlujo {
  static compatible() {
    try {
      return Boolean((window.MediaSource ?? window.ManagedMediaSource)?.isTypeSupported('audio/mpeg'));
    } catch {
      return false;
    }
  }

  constructor(audio) {
    this.tipo = 'flujo';
    this.audio = audio;
    this.abierta = null;
    this.fin = 0;
    this.cadena = Promise.resolve();
  }

  abrir() {
    if (this.abierta) return this.abierta;
    const Fuente = window.MediaSource ?? window.ManagedMediaSource;
    const fuente = new Fuente();
    this.fuente = fuente;
    this.fin = 0;
    this.saltando = false;
    this.cadena = Promise.resolve();
    if (!window.MediaSource) this.audio.disableRemotePlayback = true;
    const url = URL.createObjectURL(fuente);
    this.abierta = new Promise((resolve) => {
      fuente.addEventListener('sourceopen', () => {
        URL.revokeObjectURL(url);
        this.buffer = fuente.addSourceBuffer('audio/mpeg');
        this.buffer.mode = 'sequence';
        resolve();
      }, { once: true });
    });
    this.audio.loop = false;
    this.audio.src = url;
    return this.abierta;
  }

  #serie(operacion) {
    const fuente = this.fuente;
    const r = this.cadena.then(() => this.abrir()).then(() => {
      if (fuente && fuente !== this.fuente) throw new Error('flujo reemplazado');
      return operacion();
    });
    this.cadena = r.catch(() => {});
    return r;
  }

  #operar(accion) {
    const { buffer } = this;
    return new Promise((resolve, reject) => {
      const listo = () => {
        buffer.removeEventListener('error', falla);
        resolve();
      };
      const falla = () => {
        buffer.removeEventListener('updateend', listo);
        reject(new Error('El navegador no aceptó el audio generado.'));
      };
      buffer.addEventListener('updateend', listo, { once: true });
      buffer.addEventListener('error', falla, { once: true });
      try {
        accion(buffer);
      } catch (e) {
        buffer.removeEventListener('updateend', listo);
        buffer.removeEventListener('error', falla);
        reject(e);
      }
    });
  }

  async #recortar(margen) {
    const hasta = this.audio.currentTime - margen;
    const b = this.buffer.buffered;
    if (!b.length || hasta - b.start(0) < 20) return;
    await this.#operar((buffer) => buffer.remove(0, hasta));
  }

  agregar(bytes) {
    return this.#serie(async () => {
      await this.#recortar(DETRAS);
      for (let intento = 0; ; intento++) {
        try {
          await this.#operar((buffer) => buffer.appendBuffer(bytes));
          break;
        } catch (e) {
          if (e.name !== 'QuotaExceededError' || intento > 200) throw e;
          await this.#recortar(5);
          await new Promise((r) => setTimeout(r, 3000)); // memoria llena: espera a que avance la lectura
        }
      }
      const b = this.buffer.buffered;
      const ini = this.saltando ? b.start(b.length - 1) : this.fin;
      this.fin = b.end(b.length - 1);
      if (this.saltando) {
        this.saltando = false;
        this.audio.currentTime = ini + 0.001;
      }
      return { ini, fin: this.fin };
    });
  }

  // Empieza otro tramo más adelante en la misma línea de tiempo, sin cambiar de archivo.
  saltar() {
    if (!this.abierta) return Promise.resolve();
    return this.#serie(async () => {
      if (!this.fin) return;
      const base = Math.ceil(Math.max(this.fin, this.audio.currentTime)) + 1;
      this.buffer.timestampOffset = base;
      if (this.fuente.duration !== Infinity) this.fuente.duration = Infinity;
      this.saltando = true;
      this.fin = base;
      this.audio.currentTime = base;
      await this.#operar((buffer) => buffer.remove(0, base));
    });
  }

  terminar() {
    return this.#serie(async () => {
      if (this.fuente.readyState === 'open' && !this.buffer.updating) this.fuente.endOfStream();
    });
  }

  posicion() {
    return this.audio.currentTime;
  }

  adelanto() {
    return this.saltando || !this.abierta ? 0 : Math.max(0, this.fin - this.audio.currentTime);
  }

  ir(t) {
    const b = this.audio.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.05 && t < b.end(i)) {
        this.audio.currentTime = Math.max(t, b.start(i)) + 0.001;
        return true;
      }
    }
    return false;
  }

  cerrar() {
    this.abierta = null;
    this.fuente = null;
    this.buffer = null;
    this.fin = 0;
    this.cadena = Promise.resolve();
  }
}

// Respaldo sin MediaSource: archivos largos que se cambian lo menos posible.
export class SalidaBloques {
  constructor(audio) {
    this.tipo = 'bloques';
    this.audio = audio;
    this.pendientes = [];
    this.bloque = null;
    this.fin = 0;
    this.ultima = 0;
    this.terminado = false;
    this.abierta = false;
    audio.addEventListener('ended', () => {
      if (!this.abierta || !this.bloque) return;
      this.#soltarBloque();
      this.#lanzar();
    });
  }

  abrir() {
    if (!this.abierta) {
      this.abierta = true;
      sonarRuido(this.audio);
    }
    return Promise.resolve();
  }

  #soltarBloque() {
    if (!this.bloque) return;
    URL.revokeObjectURL(this.bloque.url);
    this.ultima = this.bloque.fin;
    this.bloque = null;
  }

  #lanzar() {
    const largo = this.pendientes.reduce((s, p) => s + p.fin - p.ini, 0);
    if (!largo || (largo < MINIMO_BLOQUE && !this.terminado)) {
      if (!this.terminado && !this.audio.loop && !this.enPausa) sonarRuido(this.audio);
      return;
    }
    const lista = this.pendientes.splice(0);
    const url = URL.createObjectURL(new Blob(lista.map((p) => p.bytes), { type: 'audio/mpeg' }));
    this.bloque = { ini: lista[0].ini, fin: lista.at(-1).fin, url };
    this.audio.loop = false;
    this.audio.src = url;
    if (!this.enPausa) this.audio.play().catch(() => {});
  }

  async agregar(bytes) {
    await this.abrir();
    const tramo = { ini: this.fin, fin: this.fin + duracionMp3(bytes.byteLength) };
    this.fin = tramo.fin;
    this.pendientes.push({ bytes, ...tramo });
    if (!this.bloque) this.#lanzar();
    return tramo;
  }

  async saltar() {
    if (!this.abierta) return;
    this.pendientes = [];
    this.#soltarBloque();
    this.ultima = this.fin;
    this.terminado = false;
    if (!this.audio.loop) sonarRuido(this.audio);
  }

  async terminar() {
    this.terminado = true;
    if (!this.bloque) this.#lanzar();
  }

  posicion() {
    if (!this.bloque) return this.ultima;
    const largo = this.bloque.fin - this.bloque.ini;
    const real = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : largo;
    return this.bloque.ini + Math.min(1, this.audio.currentTime / real) * largo;
  }

  adelanto() {
    return Math.max(0, this.fin - this.posicion());
  }

  ir(t) {
    if (!this.bloque || t < this.bloque.ini - 0.05 || t >= this.bloque.fin) return false;
    this.audio.currentTime = Math.max(0, t - this.bloque.ini);
    return true;
  }

  cerrar() {
    this.pendientes = [];
    this.#soltarBloque();
    this.abierta = false;
    this.fin = 0;
    this.ultima = 0;
    this.terminado = false;
  }
}

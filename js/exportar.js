// Genera el documento completo como un MP3 en un worker propio, sin tocar la lectura en curso.

const WORKER = 'js/piper-worker.js?v=20261104a';
const BYTES_POR_SEGUNDO = 8000; // 64 kbit/s
const CARACTERES_POR_SEGUNDO = 14;
const SILENCIO = 0.28;

// Reúne lo que se va a oír en el rango de páginas y estima duración y peso del archivo.
export function planificar(oraciones, { desde, hasta, omitida, textoVoz, velocidad }) {
  const textos = [];
  let caracteres = 0;
  for (const o of oraciones) {
    if (o.pagina + 1 < desde || o.pagina + 1 > hasta || omitida(o)) continue;
    const texto = textoVoz(o);
    if (!texto) continue;
    textos.push(texto);
    caracteres += texto.length;
  }
  const segundos = (caracteres / CARACTERES_POR_SEGUNDO + textos.length * SILENCIO) / velocidad;
  return { textos, caracteres, segundos, bytes: segundos * BYTES_POR_SEGUNDO };
}

export function nombreMp3(nombrePdf, { desde, hasta, total, parcial = false }) {
  const base = nombrePdf.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'documento';
  const rango = desde > 1 || hasta < total ? ` (páginas ${desde}-${hasta})` : '';
  return `${base}${rango}${parcial ? ' (parcial)' : ''}.mp3`;
}

export function duracionLegible(segundos) {
  if (segundos < 60) return `${Math.max(1, Math.round(segundos))} s`;
  const minutos = Math.round(segundos / 60);
  if (minutos < 60) return `${minutos} min`;
  return `${Math.floor(minutos / 60)} h ${minutos % 60} min`;
}

export function pesoLegible(bytes) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  return `${(bytes / 1e6).toFixed(1).replace('.', ',')} MB`;
}

export class ExportacionMp3 {
  constructor({ voz, textos, velocidad }, { alDescargar, alGenerar, alAvance }) {
    this.partes = [];
    this.segundos = 0;
    this.fallos = 0;
    this.hechas = 0;
    this.terminada = false;
    this.longitudes = textos.map((t) => t.length);
    this.totalCaracteres = this.longitudes.reduce((s, n) => s + n, 0);
    this.caracteresHechos = 0;
    this.promesa = new Promise((resolve, reject) => {
      this.resolver = resolve;
      this.rechazar = reject;
    });
    this.worker = new Worker(WORKER);
    this.worker.onerror = (e) => this.#fallar(new Error(e.message || 'El motor de voz no pudo iniciar.'));
    this.worker.onmessage = ({ data }) => {
      if (data.tipo === 'progreso') {
        alDescargar?.(data.hecho, data.total);
      } else if (data.tipo === 'generando') {
        this.inicio = performance.now();
        alGenerar?.();
      } else if (data.tipo === 'trozo') {
        this.partes.push(...data.partes);
        this.segundos = data.segundos;
        this.hechas = data.i + 1;
        this.caracteresHechos += this.longitudes[data.i];
        alAvance?.({ hechas: this.hechas, total: textos.length, restante: this.#restante() });
      } else if (data.tipo === 'fin') {
        this.partes.push(...data.partes);
        this.segundos = data.segundos;
        this.fallos = data.fallos;
        this.#terminar(false);
      } else if (data.tipo === 'error') {
        this.#fallar(new Error(data.mensaje));
      }
    };
    this.worker.postMessage({ tipo: 'exportar', voz: { ruta: voz.ruta, bytes: voz.bytes }, textos, velocidad });
  }

  // Segundos que faltan, extrapolados del ritmo medido en esta misma exportación.
  #restante() {
    const transcurrido = (performance.now() - this.inicio) / 1000;
    return (transcurrido / Math.max(1, this.caracteresHechos)) * (this.totalCaracteres - this.caracteresHechos);
  }

  #terminar(parcial) {
    if (this.terminada) return;
    this.terminada = true;
    this.worker.terminate();
    this.resolver({
      blob: new Blob(this.partes, { type: 'audio/mpeg' }),
      segundos: this.segundos,
      fallos: this.fallos,
      hechas: this.hechas,
      total: this.longitudes.length,
      parcial,
    });
    this.partes = [];
  }

  #fallar(error) {
    if (this.terminada) return;
    this.terminada = true;
    this.worker.terminate();
    this.rechazar(error);
  }

  get hayAudio() {
    return this.partes.some((p) => p.byteLength > 0);
  }

  detenerYGuardar() {
    this.#terminar(true);
  }

  cancelar() {
    if (this.terminada) return;
    this.terminada = true;
    this.worker.terminate();
    this.partes = [];
    this.resolver(null);
  }
}

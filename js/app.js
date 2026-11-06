import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import { itemsDesdePdf, construirDocumento } from './extraccion.js?v=20261106c';
import { paraVoz } from './pronunciacion.js?v=20261106a';
import { Visor } from './visor.js';
import { Pulso } from './pulso.js';
import { reconocerPaginas } from './ocr.js';
import {
  VOCES_NEURONALES, VOCES_INGLESAS, MotorDispositivo, MotorNeuronal, vocesDelDispositivo, mejorVoz, alCambiarVoces, vozGuardada, motorGuardado, borrarVoz,
} from './motores.js?v=20261106b';
import { planificar, nombreMp3, duracionLegible, pesoLegible, ExportacionMp3 } from './exportar.js?v=20261106a';
import { Traductor } from './traduccion.js';
import { iniciarInstalacion, plataforma } from './instalar.js';

const BASE_PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = `${BASE_PDFJS}pdf.worker.min.mjs`;

const $ = (id) => document.getElementById(id);
const PESO_MOTOR_MB = 33;
const CARACTERES_POR_SEGUNDO = 15;
const FRASE_PRUEBA = 'Esta es la voz que leerá tu documento. Puedes cambiarla cuando quieras.';
const FRASE_PRUEBA_INGLES = 'This is the voice that will read the English parts of your document.';
const MIN_CARACTERES_PAGINA = 20;
const ORACIONES_POR_ADELANTADO = 8;
const NOMBRE_ELEMENTO = { tabla: 'una tabla', formula: 'una fórmula', leyenda: 'un pie de tabla o figura', nota: 'una nota', figura: 'un texto de figura' };
// En el celular, solo las voces neuronales siguen sonando con la pantalla bloqueada.
const ES_MOVIL = plataforma(navigator.userAgent, navigator.maxTouchPoints) !== 'otro';

const guardar = (clave, valor) => {
  try { localStorage.setItem(`pdfvoz:${clave}`, typeof valor === 'string' ? valor : JSON.stringify(valor)); } catch { /* sin almacenamiento */ }
};
const leer = (clave) => {
  try { return localStorage.getItem(`pdfvoz:${clave}`); } catch { return null; }
};

const estado = {
  pdf: null,
  nombre: '',
  claveDoc: '',
  paginas: [],
  oraciones: [],
  idx: 0,
  sonando: false,
  pausado: false,
  turno: 0,
  velocidad: Number(leer('velocidad')) || 1,
  omitirReferencias: leer('omitirReferencias') !== 'false',
  omitirCitas: leer('omitirCitas') !== 'false',
  omitirElementos: leer('omitirElementos') !== 'false',
  traducir: leer('traducir') !== 'false',
  esperandoTraduccion: false,
  vozElegida: leer('voz') ?? '',
  vozIngles: leer('vozIngles') ?? '',
};

const audio = $('audio');
if (navigator.audioSession) navigator.audioSession.type = 'playback';
const dispositivo = 'speechSynthesis' in window ? new MotorDispositivo() : null;
const neuronal = new MotorNeuronal(audio, {
  alEsperar: (esperando) => {
    $('reproducir').dataset.espera = esperando ? 'si' : 'no';
    if (esperando) $('estado').textContent = 'Generando el audio de esta oración…';
    else pintarEstado();
  },
  alProgreso: (hecho, total) => {
    for (const id of ['voz-progreso', 'voz-ingles-progreso']) {
      const p = $(id);
      if (p.dataset.activa !== 'si') continue;
      p.hidden = false;
      p.value = total ? hecho / total : 0;
    }
    const b = document.querySelector('#avisos progress');
    if (b) b.value = total ? hecho / total : 0;
    const texto = document.querySelector('#avisos [data-descarga]');
    if (texto) texto.textContent = `Descargando la voz: ${Math.round(hecho / 1e6)} de ${Math.round(total / 1e6)} MB. Solo ocurre una vez.`;
  },
});
let motor = dispositivo;

const visor = new Visor($('panel-pdf'), { alPulsar: (i) => irA(i) });
const pulso = new Pulso($('pulso'), {
  alElegir: (i) => irA(i),
  alMover: (i, x) => {
    const globo = $('pulso-globo');
    if (i === null) {
      globo.hidden = true;
      return;
    }
    const o = estado.oraciones[i];
    if (!o) return;
    globo.hidden = false;
    const muestra = textoMostrado(o);
    globo.textContent = `Página ${o.pagina + 1}: ${muestra.slice(0, 60)}${muestra.length > 60 ? '…' : ''}`;
    const marco = $('pulso').parentElement.clientWidth;
    const mitad = globo.offsetWidth / 2;
    globo.style.left = `${Math.max(mitad + 4, Math.min(marco - mitad - 4, x + 16))}px`;
  },
});

/* ---------- Avisos ---------- */

function aviso(texto, acciones = [], { conProgreso = false } = {}) {
  const nodo = document.createElement('div');
  nodo.className = 'aviso';
  const p = document.createElement('p');
  p.textContent = texto;
  if (conProgreso) p.dataset.descarga = '';
  nodo.append(p);
  if (conProgreso) {
    const barra = document.createElement('progress');
    barra.max = 1;
    barra.value = 0;
    nodo.append(barra);
  }
  for (const { texto: rotulo, alPulsar, principal } of acciones) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = principal ? 'boton-principal' : 'boton-suave';
    b.textContent = rotulo;
    b.addEventListener('click', () => alPulsar(nodo));
    nodo.append(b);
  }
  $('avisos').append(nodo);
  return nodo;
}

const limpiarAvisos = () => $('avisos').replaceChildren();

/* ---------- Abrir el PDF ---------- */

function pedirClave(incorrecta) {
  return new Promise((resolve) => {
    const dialogo = $('clave');
    $('clave-rotulo').textContent = incorrecta ? 'Esa contraseña no abre el archivo. Inténtalo de nuevo.' : 'Escribe la contraseña para abrirlo';
    $('clave-valor').value = '';
    dialogo.returnValue = '';
    dialogo.showModal();
    dialogo.addEventListener('close', () => {
      resolve(dialogo.returnValue === 'ok' ? $('clave-valor').value : null);
    }, { once: true });
  });
}

async function abrirDatos(datos, nombre, tamano) {
  detener();
  mostrarLector(nombre);
  limpiarAvisos();
  traduccion.turno++;
  liberarEsperasDeOtroDocumento();
  estado.idx = 0;
  $('estado').textContent = 'Abriendo el archivo…';
  $('panel-texto').replaceChildren();
  estado.oraciones = [];
  pulso.usar([], () => false);
  bloquearMandos(true);

  let pdf;
  try {
    const tarea = pdfjs.getDocument({
      data: datos,
      cMapUrl: `${BASE_PDFJS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${BASE_PDFJS}standard_fonts/`,
      wasmUrl: `${BASE_PDFJS}wasm/`,
      isEvalSupported: false,
    });
    tarea.onPassword = async (responder, razon) => {
      const clave = await pedirClave(razon === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
      if (clave === null) tarea.destroy();
      else responder(clave);
    };
    pdf = await tarea.promise;
  } catch (e) {
    volverAlInicio();
    if (e?.name === 'InvalidPDFException') errorInicio('Ese archivo no es un PDF válido o está dañado. Prueba con otro.');
    else if (e?.name !== 'PasswordException' && !/destroy/i.test(e?.message ?? '')) errorInicio(`No se pudo abrir el archivo: ${e?.message ?? e}`);
    return;
  }

  estado.pdf = pdf;
  estado.nombre = nombre;
  estado.claveDoc = `pos:${nombre}:${tamano}:${pdf.numPages}`;
  estado.paginas = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    $('estado').textContent = `Leyendo la página ${n} de ${pdf.numPages}…`;
    const pagina = await pdf.getPage(n);
    const viewport = pagina.getViewport({ scale: 1 });
    const contenido = await pagina.getTextContent();
    estado.paginas.push({ W: viewport.width, H: viewport.height, items: itemsDesdePdf(contenido, viewport, pdfjs.Util.transform) });
    pagina.cleanup();
    if (n % 20 === 0) await new Promise((r) => setTimeout(r));
  }
  await visor.abrir(pdf, estado.paginas);
  $('seccion-ocr').hidden = false;
  procesarTexto();

  const sinTexto = paginasSinTexto();
  if (sinTexto.length) {
    const todas = sinTexto.length === estado.paginas.length;
    aviso(
      todas ? 'Este PDF parece escaneado: sus páginas son imágenes y no tienen texto que leer.' : `${sinTexto.length} de ${estado.paginas.length} páginas no tienen texto y parecen escaneadas.`,
      [{ texto: 'Reconocer el texto', principal: true, alPulsar: (n) => { n.remove(); ejecutarOcr(sinTexto); } }],
    );
  }
}

function paginasSinTexto() {
  return estado.paginas.flatMap((p, n) => (p.items.reduce((s, c) => s + c.str.trim().length, 0) < MIN_CARACTERES_PAGINA ? [n] : []));
}

function procesarTexto() {
  const { oraciones } = construirDocumento(estado.paginas);
  estado.oraciones = oraciones;
  oraciones.forEach((o) => { o.voz = null; });
  visor.usarOraciones(oraciones);
  pintarTexto();
  pulso.usar(oraciones, omitida);

  const guardada = Number(leer(estado.claveDoc));
  const inicio = Number.isInteger(guardada) && guardada > 0 && guardada < oraciones.length ? guardada : 0;
  estado.idx = primeraLegible(inicio);
  bloquearMandos(!oraciones.length);
  marcar({ desplazar: true });
  if (inicio > 0) aviso(`Continúas en la página ${oraciones[estado.idx].pagina + 1}, donde quedaste.`, [
    { texto: 'Empezar desde el principio', alPulsar: (n) => { n.remove(); irA(primeraLegible(0)); } },
  ]);
  pintarIdioma();
  arrancarTraduccion();
}

function pintarTexto() {
  const panel = $('panel-texto');
  const fragmento = document.createDocumentFragment();
  let bloqueActual = -1;
  let pagina = -1;
  let contenedor = null;
  for (const o of estado.oraciones) {
    if (o.pagina !== pagina) {
      pagina = o.pagina;
      const marca = document.createElement('p');
      marca.className = 'salto-pagina';
      marca.textContent = `Página ${pagina + 1}`;
      fragmento.append(marca);
      bloqueActual = -1;
    }
    if (o.bloque !== bloqueActual) {
      bloqueActual = o.bloque;
      contenedor = document.createElement(o.rol === 'titulo' ? 'h3' : 'p');
      fragmento.append(contenedor);
    }
    const s = document.createElement('span');
    s.className = `oracion${omitida(o) ? ' omitida' : ''}`;
    s.dataset.i = o.i;
    s.textContent = textoMostrado(o);
    if (o.elemento) s.title = `Se salta porque es ${NOMBRE_ELEMENTO[o.elemento]}. Púlsala para oírla.`;
    contenedor.append(s, ' ');
    o.nodo = s;
  }
  panel.replaceChildren(fragmento);
  if (!estado.oraciones.length) {
    const vacio = document.createElement('p');
    vacio.textContent = 'Aún no hay texto para leer en este archivo.';
    panel.append(vacio);
  }
}

/* ---------- Lectura ---------- */

const omitida = (o) => (estado.omitirReferencias && o.referencia) || (estado.omitirElementos && Boolean(o.elemento));

function textoMostrado(o) {
  return estado.traducir && o.traduccion ? o.traduccion : o.texto;
}

// En qué idioma suena la oración: el de lo que se muestra, o el español si su traducción ya viene en camino.
function idiomaVoz(o) {
  if (o.idioma !== 'en') return 'es';
  if (!estado.traducir) return 'en';
  if (o.traduccion) return 'es';
  return faltaTraducir(o) ? 'es' : 'en';
}

function textoVoz(o) {
  o.voz ??= paraVoz(textoMostrado(o), { citas: !estado.omitirCitas, idioma: idiomaVoz(o) });
  return o.voz;
}

const vozPara = (idioma) => (idioma === 'en' ? estado.vozIngles : estado.vozElegida);

function primeraLegible(desde) {
  for (let i = desde; i < estado.oraciones.length; i++) {
    if (!omitida(estado.oraciones[i]) && textoVoz(estado.oraciones[i])) return i;
  }
  return Math.min(desde, Math.max(0, estado.oraciones.length - 1));
}

function siguienteLegible(desde) {
  for (let i = desde + 1; i < estado.oraciones.length; i++) {
    if (!omitida(estado.oraciones[i]) && textoVoz(estado.oraciones[i])) return i;
  }
  return -1;
}

function anteriorLegible(desde) {
  for (let i = desde - 1; i >= 0; i--) {
    if (!omitida(estado.oraciones[i]) && textoVoz(estado.oraciones[i])) return i;
  }
  return desde;
}

function marcar({ desplazar = true } = {}) {
  const o = estado.oraciones[estado.idx];
  document.querySelector('.oracion.actual')?.classList.remove('actual');
  if (o) {
    o.nodo?.classList.add('actual');
    visor.marcar(o, { desplazar });
    if (desplazar && o.nodo && $('panel-texto').clientHeight) {
      const caja = o.nodo.getBoundingClientRect();
      const panel = $('panel-texto').getBoundingClientRect();
      if (caja.top < panel.top + 40 || caja.bottom > panel.bottom - 80) {
        const suave = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        $('panel-texto').scrollBy({ top: caja.top - panel.top - panel.height * 0.3, behavior: suave ? 'smooth' : 'auto' });
      }
    }
    pulso.mover(estado.idx);
    guardar(estado.claveDoc, String(estado.idx));
  }
  pintarEstado();
}

function pintarEstado() {
  const total = estado.oraciones.length;
  if (!total) {
    $('estado').textContent = estado.pdf ? 'Sin texto para leer.' : '';
    return;
  }
  const o = estado.oraciones[estado.idx];
  let restante = 0;
  for (let i = estado.idx; i < total; i++) if (!omitida(estado.oraciones[i])) restante += estado.oraciones[i].texto.length;
  const minutos = Math.ceil(restante / CARACTERES_POR_SEGUNDO / estado.velocidad / 60);
  const tiempo = minutos >= 60 ? `${Math.floor(minutos / 60)} h ${minutos % 60} min` : `${minutos} min`;
  $('estado').textContent = `Página ${o.pagina + 1} de ${estado.paginas.length}. Oración ${estado.idx + 1} de ${total}. Quedan cerca de ${tiempo}.`;
}

function bloquearMandos(bloqueado) {
  for (const id of ['reproducir', 'anterior', 'siguiente', 'abrir-descarga']) $(id).disabled = bloqueado;
}

function pintarBotonReproducir() {
  const b = $('reproducir');
  b.dataset.estado = estado.sonando ? 'sonando' : 'detenido';
  b.setAttribute('aria-label', estado.sonando ? 'Pausar' : 'Reproducir');
  actualizarVigilia();
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = estado.sonando ? 'playing' : 'paused';
}

function precargar() {
  if (motor?.tipo !== 'neuronal') return;
  const lista = [];
  const vozActual = vozPara(idiomaVoz(estado.oraciones[estado.idx]));
  let i = estado.idx;
  while (lista.length < ORACIONES_POR_ADELANTADO) {
    i = siguienteLegible(i);
    if (i < 0 || faltaTraducir(estado.oraciones[i]) || vozPara(idiomaVoz(estado.oraciones[i])) !== vozActual) break;
    lista.push({ i, texto: textoVoz(estado.oraciones[i]) });
  }
  motor.precargar(lista, estado.idx);
}

async function bucle() {
  const turno = ++estado.turno;
  try {
    while (estado.sonando && turno === estado.turno) {
      const o = estado.oraciones[estado.idx];
      if (!o) break;
      marcar();
      if (faltaTraducir(o)) {
        estado.esperandoTraduccion = true;
        $('reproducir').dataset.espera = 'si';
        $('estado').textContent = 'Traduciendo esta oración…';
        if (esNeuronal(vozPara('es'))) neuronal.mantenerVivo();
        await esperarTraduccion(o);
        if (turno !== estado.turno) return;
        terminarEsperaTraduccion();
        pintarEstado();
      }
      estado.esperandoTraduccion = true; // pausar mientras carga una voz vuelve a empezar la oración
      const lista = await asegurarVoz(o);
      if (turno !== estado.turno) return;
      terminarEsperaTraduccion();
      actualizarVigilia();
      if (!lista) {
        neuronal.detener();
        estado.sonando = false;
        pintarBotonReproducir();
        return;
      }
      precargar();
      const voz = textoVoz(o) || o.texto;
      const resultado = await motor.hablar(estado.idx, voz);
      if (turno !== estado.turno || resultado === 'cancelado') return;
      const sig = siguienteLegible(estado.idx);
      if (sig < 0) {
        estado.sonando = false;
        pintarBotonReproducir();
        pintarEstado();
        $('estado').textContent = 'Lectura terminada.';
        return;
      }
      estado.idx = sig;
    }
  } catch (e) {
    if (turno !== estado.turno) return;
    estado.sonando = false;
    pintarBotonReproducir();
    aviso(e.message, [{ texto: 'Abrir ajustes', alPulsar: (n) => { n.remove(); abrirAjustes(); } }]);
  }
}

async function reproducir() {
  if (!estado.oraciones.length) return;
  if (estado.pausado) {
    estado.pausado = false;
    estado.sonando = true;
    pintarBotonReproducir();
    motor.reanudar();
    return;
  }
  // Este clic habilita el audio: en iOS lo que suene después, ya bloqueado, depende de él.
  const voz = vozPara(idiomaVoz(estado.oraciones[estado.idx]));
  if (esNeuronal(voz)) neuronal.mantenerVivo();
  else avisarBloqueo();
  estado.sonando = true;
  pintarBotonReproducir();
  bucle();
}

// La oración queda a medias en el motor: reanudar sigue desde ese punto.
function terminarEsperaTraduccion() {
  estado.esperandoTraduccion = false;
  $('reproducir').dataset.espera = 'no';
}

function pausar() {
  estado.sonando = false;
  if (estado.esperandoTraduccion) {
    // Aún no empezó a sonar: al reanudar, la oración se lee desde el principio.
    terminarEsperaTraduccion();
    estado.turno++;
    pintarBotonReproducir();
    pintarEstado();
    return;
  }
  estado.pausado = true;
  motor?.pausar();
  pintarBotonReproducir();
}

function alternar() {
  if (estado.sonando) pausar();
  else reproducir();
}

function detener() {
  estado.sonando = false;
  estado.pausado = false;
  estado.turno++;
  terminarEsperaTraduccion();
  dispositivo?.detener();
  neuronal.detener();
  pintarBotonReproducir();
}

function irA(i) {
  if (!estado.oraciones[i]) return;
  const seguia = estado.sonando;
  estado.pausado = false;
  estado.turno++;
  terminarEsperaTraduccion();
  motor?.detener();
  estado.idx = i;
  visor.retomarSeguimiento();
  marcar();
  if (seguia) bucle();
}

/* ---------- Voces ---------- */

const esNeuronal = (id) => id.startsWith('piper:');
const vozNeuronal = (id) => [...VOCES_NEURONALES, ...VOCES_INGLESAS].find((v) => `piper:${v.id}` === id);

function nombreVozSistema(v) {
  return `${v.name.replace(/^(Microsoft|Google)\s+/, '').replace(/\s+-\s+.*$/, '').replace(/\s+Online.*$/, '')} (${v.lang})${v.localService ? '' : ', en línea'}`;
}

// Llena una lista de voces y devuelve la que debe quedar elegida.
function pintarListaVoces(select, idioma, claveGuardada, neuronales) {
  const locales = vocesDelDispositivo(idioma);
  const grupos = [];
  if (locales.length) {
    const g = document.createElement('optgroup');
    g.label = 'Voces de este dispositivo (sin descarga)';
    for (const v of locales) {
      const o = document.createElement('option');
      o.value = `disp:${v.voiceURI}`;
      o.textContent = nombreVozSistema(v);
      g.append(o);
    }
    grupos.push(g);
  }
  const g = document.createElement('optgroup');
  g.label = 'Voces neuronales (se descargan una vez)';
  for (const v of neuronales) {
    const o = document.createElement('option');
    o.value = `piper:${v.id}`;
    o.textContent = `${v.nombre}, ${Math.round(v.bytes / 1e6)} MB`;
    g.append(o);
  }
  grupos.push(g);
  select.replaceChildren(...grupos);

  const valores = [...select.options].map((o) => o.value);
  // Sin elección guardada se vuelve a decidir: las voces del sistema suelen llegar tarde.
  const guardada = leer(claveGuardada);
  if (guardada && valores.includes(guardada)) return guardada;
  const mejor = ES_MOVIL ? null : mejorVoz(locales);
  return mejor ? `disp:${mejor.voiceURI}` : `piper:${vozNeuronalInicial(neuronales).id}`;
}

// La ligera se genera más rápido, y en un celular eso evita pausas con la pantalla bloqueada.
function vozNeuronalInicial(neuronales) {
  return (ES_MOVIL && neuronales.find((v) => v.id.endsWith('x_low'))) || neuronales[0];
}

function pintarVoces() {
  const elegida = pintarListaVoces($('voz'), 'es', 'voz', VOCES_NEURONALES);
  $('voz').value = elegida;
  aplicarVoz(elegida, { persistir: false });
  const inglesa = pintarListaVoces($('voz-ingles'), 'en', 'vozIngles', VOCES_INGLESAS);
  $('voz-ingles').value = inglesa;
  aplicarVozIngles(inglesa, { persistir: false });
}

// El botón de voz muestra la que se oye con el idioma elegido.
function pintarVozActual() {
  const leeIngles = !estado.traducir && hayIngles();
  const opcion = (leeIngles ? $('voz-ingles') : $('voz')).selectedOptions[0];
  $('voz-actual').textContent = opcion ? opcion.textContent.replace(/, \d+ MB$/, '').replace(/, en línea$/, '') : 'Sin elegir';
}

function aplicarVoz(id, { persistir = true } = {}) {
  if (id !== estado.vozElegida) detener(); // el sistema avisa de voces nuevas también a mitad de la lectura
  estado.vozElegida = id;
  if (persistir) guardar('voz', id);
  pintarVozActual();
  pintarNotaVoz();
}

function aplicarVozIngles(id, { persistir = true } = {}) {
  if (id !== estado.vozIngles) detener();
  estado.vozIngles = id;
  if (persistir) guardar('vozIngles', id);
  pintarVozActual();
  pintarNotaIngles();
}

// Deja listo el motor de esa voz. Devuelve false si una voz neuronal aún no está descargada.
async function activarVoz(id) {
  if (esNeuronal(id)) {
    motor = neuronal;
    neuronal.cambiarVelocidad(estado.velocidad);
    const v = vozNeuronal(id);
    if (neuronal.vozLista === v.id) return true;
    if (!(await vozGuardada(v))) return false;
    neuronal.mantenerVivo();
    return prepararNeuronal(v);
  }
  motor = dispositivo;
  if (!motor) return false;
  const idioma = estado.vozIngles === id ? 'en' : 'es';
  motor.usarVoz(vocesDelDispositivo(idioma).find((v) => `disp:${v.voiceURI}` === id) ?? null);
  motor.cambiarVelocidad(estado.velocidad, false);
  return true;
}

// Prepara la voz de una oración. Si falta descargarla, ofrece hacerlo con un clic y seguir leyendo.
async function asegurarVoz(o) {
  const id = vozPara(idiomaVoz(o));
  if (await activarVoz(id)) return true;
  if (!esNeuronal(id)) {
    aviso('Este navegador no tiene voces. Elige una voz neuronal en Ajustes.', [{ texto: 'Abrir ajustes', alPulsar: (n) => { n.remove(); abrirAjustes(); } }]);
    return false;
  }
  const v = vozNeuronal(id);
  const [hayVoz, hayMotor] = await Promise.all([vozGuardada(v), motorGuardado()]);
  if (hayVoz) return false; // ya hubo un aviso de error al prepararla
  document.querySelector('[data-pide-voz]')?.remove();
  const mb = Math.round(v.bytes / 1e6) + (hayMotor ? 0 : PESO_MOTOR_MB);
  const nodo = aviso(`Esta lectura necesita la voz ${v.nombre}. Se descargan ${mb} MB una sola vez.`, [{
    texto: 'Descargar y leer',
    principal: true,
    alPulsar: async (n) => {
      n.remove();
      neuronal.mantenerVivo();
      if (await prepararNeuronal(v)) reproducir();
      else neuronal.detener();
    },
  }, { texto: 'Abrir ajustes', alPulsar: (n) => { n.remove(); abrirAjustes(); } }]);
  nodo.dataset.pideVoz = '';
  return false;
}

// Una sola vez por sesión: ofrece pasar a una voz que no se detiene al bloquear la pantalla.
async function avisarBloqueo() {
  if (!ES_MOVIL || estado.avisoBloqueo) return;
  estado.avisoBloqueo = true;
  const idioma = idiomaVoz(estado.oraciones[estado.idx]);
  const v = vozNeuronalInicial(idioma === 'en' ? VOCES_INGLESAS : VOCES_NEURONALES);
  const [hayVoz, hayMotor] = await Promise.all([vozGuardada(v), motorGuardado()]);
  const mb = (hayVoz ? 0 : Math.round(v.bytes / 1e6)) + (hayMotor ? 0 : PESO_MOTOR_MB);
  aviso(`Esta voz del sistema se detiene al bloquear la pantalla. Una voz neuronal sigue sonando${mb ? ` (se descargan ${mb} MB una sola vez)` : ''}.`, [{
    texto: 'Usar voz neuronal',
    principal: true,
    alPulsar: async (n) => {
      n.remove();
      const seleccion = idioma === 'en' ? $('voz-ingles') : $('voz');
      seleccion.value = `piper:${v.id}`;
      if (idioma === 'en') aplicarVozIngles(seleccion.value);
      else aplicarVoz(seleccion.value);
      neuronal.mantenerVivo();
      if (await prepararNeuronal(v)) reproducir();
      else neuronal.detener();
    },
  }]);
}

async function pintarNotaVoz() {
  await pintarNotaDe({ id: estado.vozElegida, idioma: 'es', nota: $('voz-nota'), caja: $('voz-descarga'), descargar: $('voz-descargar'), borrar: $('voz-borrar'), progreso: $('voz-progreso'), actual: () => estado.vozElegida });
}

async function pintarNotaIngles() {
  await pintarNotaDe({ id: estado.vozIngles, idioma: 'en', nota: $('voz-ingles-nota'), caja: $('voz-ingles-descarga'), descargar: $('voz-ingles-descargar'), borrar: $('voz-ingles-borrar'), progreso: $('voz-ingles-progreso'), actual: () => estado.vozIngles });
}

async function pintarNotaDe({ id, idioma, nota, caja: descarga, descargar, borrar, progreso, actual }) {
  nota.classList.remove('problema');
  progreso.hidden = true;
  if (esNeuronal(id)) {
    const v = vozNeuronal(id);
    const [hayVoz, hayMotor] = await Promise.all([vozGuardada(v), motorGuardado()]);
    if (actual() !== id) return;
    descarga.hidden = false;
    descargar.hidden = hayVoz;
    borrar.hidden = !hayVoz;
    if (hayVoz) {
      nota.textContent = 'Voz guardada en este equipo. Lee sin enviar tu texto a ningún servidor.';
    } else {
      const mb = Math.round(v.bytes / 1e6) + (hayMotor ? 0 : PESO_MOTOR_MB);
      nota.textContent = `Se descargan ${mb} MB una sola vez${hayMotor ? '' : `, incluidos ${PESO_MOTOR_MB} MB del motor de voz`}. Después lee sin enviar tu texto a ningún servidor.`;
    }
  } else {
    descarga.hidden = true;
    const voz = vocesDelDispositivo(idioma).find((x) => `disp:${x.voiceURI}` === id);
    if (voz && !voz.localService) {
      nota.classList.add('problema');
      nota.textContent = 'Esta voz funciona en línea: el navegador envía cada oración al proveedor de la voz. Para documentos privados, elige una voz neuronal o una que no diga «en línea».';
    } else {
      nota.textContent = `Esta voz viene con tu sistema y lee sin conexión.${ES_MOVIL ? ' Se detiene si bloqueas la pantalla.' : ''}`;
    }
  }
}

async function prepararNeuronal(v) {
  document.querySelector('#avisos [data-descarga]')?.parentElement.remove();
  const nodo = aviso('Preparando la voz…', [], { conProgreso: true });
  const inglesa = VOCES_INGLESAS.includes(v);
  $('voz-progreso').dataset.activa = inglesa ? 'no' : 'si';
  $('voz-ingles-progreso').dataset.activa = inglesa ? 'si' : 'no';
  $('voz-descargar').disabled = true;
  $('voz-ingles-descargar').disabled = true;
  $('reproducir').dataset.espera = 'si';
  try {
    await neuronal.preparar(v);
    return true;
  } catch (e) {
    aviso(`La voz no se pudo preparar: ${e.message} Revisa la conexión y vuelve a intentarlo.`);
    return false;
  } finally {
    nodo.remove();
    $('voz-descargar').disabled = false;
    $('voz-ingles-descargar').disabled = false;
    $('voz-progreso').hidden = true;
    $('voz-ingles-progreso').hidden = true;
    $('reproducir').dataset.espera = 'no';
    pintarNotaVoz();
    pintarNotaIngles();
  }
}

function abrirAjustes() {
  if (!$('ajustes').open) $('ajustes').showModal();
  pintarNotaVoz();
  pintarNotaIngles();
}

async function probarVoz(idioma) {
  const boton = $(idioma === 'en' ? 'voz-ingles-probar' : 'voz-probar');
  const nota = $(idioma === 'en' ? 'voz-ingles-nota' : 'voz-nota');
  const id = vozPara(idioma);
  detener();
  if (!(await activarVoz(id))) {
    if (esNeuronal(id)) {
      const v = vozNeuronal(id);
      if (!(await prepararNeuronal(v))) return;
    } else {
      return;
    }
  }
  boton.disabled = true;
  try {
    await motor.hablar(-1, idioma === 'en' ? FRASE_PRUEBA_INGLES : FRASE_PRUEBA);
  } catch (e) {
    nota.classList.add('problema');
    nota.textContent = e.message;
  } finally {
    boton.disabled = false;
  }
}

/* ---------- Traducción ---------- */

const traduccion = { motor: null, turno: 0, espera: new Map(), fallo: false };

function faltaTraducir(o) {
  return estado.traducir && !traduccion.fallo && o.idioma === 'en' && !o.referencia && !(estado.omitirElementos && o.elemento) && o.traduccion == null;
}

function esperarTraduccion(o) {
  if (!faltaTraducir(o)) return Promise.resolve();
  return new Promise((resolve) => {
    if (!traduccion.espera.has(o.i)) traduccion.espera.set(o.i, []);
    traduccion.espera.get(o.i).push(resolve);
  });
}

function liberarEsperas(i = null) {
  if (i !== null) {
    for (const r of traduccion.espera.get(i) ?? []) r();
    traduccion.espera.delete(i);
    return;
  }
  for (const lista of traduccion.espera.values()) for (const r of lista) r();
  traduccion.espera.clear();
}

// Sigue a la lectura: traduce primero lo que viene y después lo que quedó atrás.
function siguientePendiente() {
  const { oraciones, idx } = estado;
  for (let i = idx; i < oraciones.length; i++) if (faltaTraducir(oraciones[i])) return oraciones[i];
  for (let i = 0; i < idx; i++) if (faltaTraducir(oraciones[i])) return oraciones[i];
  return null;
}

function mostrarTraduccion(o) {
  o.voz = null;
  if (o.nodo) {
    o.nodo.textContent = textoMostrado(o);
    o.nodo.title = estado.traducir && o.traduccion ? `Original: ${o.texto}` : '';
  }
}

async function arrancarTraduccion() {
  const turno = ++traduccion.turno;
  traduccion.fallo = false;
  liberarEsperasDeOtroDocumento();
  const total = estado.oraciones.filter(faltaTraducir).length;
  if (!total) return;

  const nodo = aviso('Preparando el traductor…', [{
    texto: 'Leer en inglés',
    alPulsar: () => cambiarTraduccion(false),
  }], { conProgreso: true });
  const rotulo = nodo.querySelector('p');
  const barra = nodo.querySelector('progress');
  const motor = new Traductor({
    alProgreso: (hecho, peso) => {
      if (turno !== traduccion.turno) return;
      rotulo.textContent = `Descargando el traductor: ${Math.round(hecho / 1e6)} de ${Math.round(peso / 1e6)} MB. Solo ocurre una vez.`;
      barra.value = peso ? hecho / peso : 0;
    },
  });
  traduccion.motor = motor;
  try {
    await motor.preparar();
    let hechas = 0;
    for (;;) {
      if (turno !== traduccion.turno) return;
      const o = siguientePendiente();
      if (!o) break;
      if (hechas % 5 === 0) {
        rotulo.textContent = `Traduciendo al español: ${hechas} de ${total} oraciones. Ya puedes escuchar.`;
        barra.value = hechas / total;
      }
      let texto;
      try {
        texto = await motor.traducir(o.texto);
      } catch (e) {
        if (turno !== traduccion.turno) return;
        if (!motor.worker) throw e;
        texto = o.texto; // una oración problemática se lee tal cual y no detiene el libro
      }
      if (turno !== traduccion.turno) return;
      o.traduccion = texto;
      mostrarTraduccion(o);
      liberarEsperas(o.i);
      hechas++;
    }
    nodo.remove();
  } catch (e) {
    if (turno !== traduccion.turno) return;
    traduccion.fallo = true;
    for (const x of estado.oraciones) x.voz = null;
    nodo.remove();
    aviso(`No se pudo traducir: ${e.message} El documento se leerá en su idioma original.`);
    liberarEsperas();
  } finally {
    motor.cerrar();
    if (traduccion.motor === motor) traduccion.motor = null;
  }
}

function liberarEsperasDeOtroDocumento() {
  traduccion.motor?.cerrar();
  traduccion.motor = null;
  liberarEsperas();
}

const hayIngles = () => estado.oraciones.some((o) => o.idioma === 'en' && !o.referencia && !o.elemento);

function pintarIdioma() {
  $('control-idioma').hidden = !hayIngles();
  $('traducir').checked = estado.traducir;
  for (const b of $('idioma-lectura').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String((b.dataset.idioma === 'es') === estado.traducir));
  }
  pintarVozActual();
}

// Un clic cambia de idioma y la lectura sigue en la misma oración; la elección queda guardada.
function cambiarTraduccion(activa) {
  if (activa === estado.traducir) return;
  const seguia = estado.sonando;
  estado.traducir = activa;
  guardar('traducir', String(activa));
  detener();
  neuronal.vaciar();
  document.querySelector('[data-pide-voz]')?.remove();
  if (activa) {
    for (const o of estado.oraciones) mostrarTraduccion(o);
    if (estado.oraciones.length) arrancarTraduccion();
  } else {
    traduccion.turno++;
    liberarEsperasDeOtroDocumento();
    for (const n of $('avisos').querySelectorAll('.aviso')) if (n.querySelector('progress')) n.remove();
    for (const o of estado.oraciones) mostrarTraduccion(o);
  }
  pintarIdioma();
  if (seguia) reproducir();
}

/* ---------- Pantalla encendida ---------- */

// Si el celular apaga la pantalla, el navegador detiene la lectura a mitad del libro.
const vigilia = { bloqueo: null, pidiendo: false };

async function actualizarVigilia() {
  // La voz neuronal sigue con la pantalla apagada; la del sistema y la generación del MP3, no siempre.
  const hacePantalla = (estado.sonando && motor === dispositivo) || Boolean(descarga.trabajo);
  if (!hacePantalla) {
    vigilia.bloqueo?.release().catch(() => {});
    vigilia.bloqueo = null;
    return;
  }
  if (vigilia.bloqueo || vigilia.pidiendo || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  vigilia.pidiendo = true;
  try {
    vigilia.bloqueo = await navigator.wakeLock.request('screen');
    vigilia.bloqueo.addEventListener('release', () => {
      vigilia.bloqueo = null;
    });
  } catch { /* sin permiso o sin batería: la lectura sigue igual */ }
  vigilia.pidiendo = false;
}

document.addEventListener('visibilitychange', () => {
  actualizarVigilia();
  if (document.visibilityState !== 'visible' || !estado.sonando || motor !== dispositivo) return;
  // El sistema retuvo la voz durante el bloqueo: se retoma la oración al volver.
  setTimeout(() => {
    if (estado.sonando && motor === dispositivo && !speechSynthesis.speaking) irA(estado.idx);
  }, 400);
});

// Una llamada o desconectar los audífonos pausan el audio: la app debe mostrarlo y poder reanudar.
audio.addEventListener('pause', () => {
  setTimeout(() => {
    if (audio.paused && estado.sonando && motor === neuronal && !estado.esperandoTraduccion) pausar();
  }, 500);
});

/* ---------- Descargar audio ---------- */

const descarga = { trabajo: null, url: null };

function panelDescarga(cual) {
  for (const p of ['opciones', 'proceso', 'lista']) $(`descarga-${p}`).hidden = p !== cual;
  $('cerrar-descarga').hidden = cual === 'proceso';
}

function limitesDescarga() {
  const total = estado.paginas.length;
  const acotar = (v, porDefecto) => Math.min(total, Math.max(1, Number.parseInt(v, 10) || porDefecto));
  const desde = acotar($('descarga-desde').value, 1);
  return { desde, hasta: Math.max(desde, acotar($('descarga-hasta').value, total)), total };
}

function planDescarga() {
  const { desde, hasta } = limitesDescarga();
  return planificar(estado.oraciones, { desde, hasta, omitida, textoVoz, velocidad: estado.velocidad });
}

async function pintarResumenDescarga() {
  const plan = planDescarga();
  const velocidad = estado.velocidad.toFixed(1).replace('.', ',');
  const hay = plan.textos.length > 0;
  $('descarga-generar').disabled = !hay;
  $('descarga-resumen').textContent = hay
    ? `Cerca de ${duracionLegible(plan.segundos)} de audio y ${pesoLegible(plan.bytes)}, a velocidad ${velocidad}×.`
    : 'Esas páginas no tienen texto para leer. Elige otro rango.';
  const v = vozNeuronal(`piper:${$('descarga-voz').value}`);
  const [hayVoz, hayMotor] = await Promise.all([vozGuardada(v), motorGuardado()]);
  const mb = (hayVoz ? 0 : Math.round(v.bytes / 1e6)) + (hayMotor ? 0 : PESO_MOTOR_MB);
  $('descarga-primera').hidden = mb === 0;
  $('descarga-primera').textContent = `Antes se descargan ${mb} MB de la voz y el motor, una sola vez.`;
}

function abrirDescarga() {
  if (descarga.trabajo || !$('descarga-lista').hidden) {
    $('descarga').showModal();
    return;
  }
  // Un MP3 usa una sola voz: la del idioma que predomina en lo que se va a leer.
  const legibles = estado.oraciones.filter((o) => !omitida(o));
  const enIngles = legibles.filter((o) => idiomaVoz(o) === 'en').length;
  const idioma = enIngles > legibles.length / 2 ? 'en' : 'es';
  $('descarga-mezcla').hidden = enIngles === 0 || enIngles === legibles.length;
  const lista = idioma === 'en' ? VOCES_INGLESAS : VOCES_NEURONALES;
  const select = $('descarga-voz');
  select.replaceChildren(...lista.map((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = `${v.nombre}, ${Math.round(v.bytes / 1e6)} MB`;
    return o;
  }));
  const candidatas = [vozPara(idioma).replace(/^piper:/, ''), leer(`vozDescarga-${idioma}`)];
  select.value = candidatas.find((id) => lista.some((v) => v.id === id)) ?? lista[0].id;
  const total = estado.paginas.length;
  for (const id of ['descarga-desde', 'descarga-hasta']) $(id).max = total;
  $('descarga-desde').value = 1;
  $('descarga-hasta').value = total;
  if (!$('descarga').open) $('descarga').showModal();
  pintarResumenDescarga();
}

// Espera a que estén traducidas las oraciones del rango. Devuelve false si se canceló.
async function traducirRango(desde, hasta) {
  const faltan = estado.oraciones.filter((o) => o.pagina + 1 >= desde && o.pagina + 1 <= hasta && !omitida(o) && faltaTraducir(o));
  if (!faltan.length) return true;
  let hechas = 0;
  const pintar = () => {
    $('descarga-estado').textContent = `Traduciendo al español: ${hechas} de ${faltan.length} oraciones.`;
    $('descarga-barra').value = hechas / faltan.length;
  };
  pintar();
  return new Promise((resolve) => {
    descarga.trabajo = { cancelar: () => resolve(false), detenerYGuardar: () => {}, hayAudio: false };
    Promise.all(faltan.map((o) => esperarTraduccion(o).then(() => {
      hechas++;
      pintar();
    }))).then(() => resolve(true));
  });
}

async function generarMp3() {
  const v = vozNeuronal(`piper:${$('descarga-voz').value}`);
  if (!planDescarga().textos.length) return;
  const { desde, hasta, total } = limitesDescarga();
  guardar(`vozDescarga-${VOCES_INGLESAS.includes(v) ? 'en' : 'es'}`, v.id);
  detener();
  neuronal.liberar(); // el modelo de lectura no debe ocupar memoria mientras se genera el archivo
  neuronal.mantenerVivo(); // para que la generación siga si se bloquea la pantalla
  panelDescarga('proceso');
  $('descarga-estado').textContent = 'Preparando la voz…';
  $('descarga-barra').value = 0;
  $('descarga-parcial').disabled = true;

  const traducido = await traducirRango(desde, hasta);
  descarga.trabajo = null;
  if (!traducido) {
    neuronal.detener();
    panelDescarga('opciones');
    pintarResumenDescarga();
    return;
  }
  const plan = planDescarga();
  $('descarga-estado').textContent = 'Preparando la voz…';
  $('descarga-barra').value = 0;

  const trabajo = new ExportacionMp3({ voz: v, textos: plan.textos, velocidad: estado.velocidad }, {
    alDescargar: (hecho, totalBytes) => {
      $('descarga-estado').textContent = `Descargando la voz: ${Math.round(hecho / 1e6)} de ${Math.round(totalBytes / 1e6)} MB.`;
      $('descarga-barra').value = totalBytes ? hecho / totalBytes : 0;
    },
    alGenerar: () => {
      $('descarga-estado').textContent = `Generando la oración 1 de ${plan.textos.length}…`;
      $('descarga-barra').value = 0;
    },
    alAvance: ({ hechas, total: oraciones, restante }) => {
      $('descarga-estado').textContent = hechas >= oraciones
        ? 'Terminando el archivo…'
        : `Generando la oración ${hechas + 1} de ${oraciones}. Quedan cerca de ${duracionLegible(restante)}.`;
      $('descarga-barra').value = hechas / oraciones;
      $('descarga-parcial').disabled = !trabajo.hayAudio;
    },
  });
  descarga.trabajo = trabajo;
  actualizarVigilia();

  let resultado = null;
  let error = null;
  try {
    resultado = await trabajo.promesa;
  } catch (e) {
    error = e;
  }
  descarga.trabajo = null;
  actualizarVigilia();
  neuronal.detener();

  if (error) {
    panelDescarga('opciones');
    $('descarga-resumen').textContent = `No se pudo generar el audio: ${error.message} Revisa la conexión y vuelve a intentarlo.`;
    return;
  }
  if (!resultado) {
    panelDescarga('opciones');
    pintarResumenDescarga();
    return;
  }
  mostrarMp3(resultado, nombreMp3(estado.nombre, { desde, hasta, total, parcial: resultado.parcial }));
}

function mostrarMp3({ blob, segundos, fallos, hechas, total, parcial }, nombre) {
  if (descarga.url) URL.revokeObjectURL(descarga.url);
  descarga.url = URL.createObjectURL(blob);
  $('descarga-oir').src = descarga.url;
  const enlace = $('descarga-guardar');
  enlace.href = descarga.url;
  enlace.download = nombre;
  $('descarga-final').textContent = `${parcial ? 'Audio parcial listo' : 'Tu MP3 está listo'}: ${duracionLegible(segundos)} y ${pesoLegible(blob.size)}.`;
  const avisos = [];
  if (parcial) avisos.push(`Incluye ${hechas} de ${total} oraciones.`);
  if (fallos) avisos.push(`${fallos} ${fallos === 1 ? 'oración no se pudo generar y quedó fuera' : 'oraciones no se pudieron generar y quedaron fuera'}.`);
  $('descarga-aviso').hidden = !avisos.length;
  $('descarga-aviso').textContent = avisos.join(' ');
  panelDescarga('lista');
  enlace.click();
}

/* ---------- Texto escaneado ---------- */

async function ejecutarOcr(numeros) {
  detener();
  let parar = false;
  const nodo = aviso('Cargando el reconocimiento de texto…', [
    { texto: 'Detener', alPulsar: () => { parar = true; } },
  ], { conProgreso: true });
  const p = nodo.querySelector('p');
  delete p.dataset.descarga;
  bloquearMandos(true);
  try {
    const resultado = await reconocerPaginas(estado.pdf, numeros, {
      debeParar: () => parar,
      alAvance: (hecho, total) => {
        p.textContent = `Reconociendo la página ${hecho + 1} de ${total}. Puede tardar varios segundos por página.`;
        nodo.querySelector('progress').value = hecho / total;
      },
    });
    for (const [n, items] of resultado) estado.paginas[n].items = items;
    nodo.remove();
    limpiarAvisos();
    procesarTexto();
    aviso(`Texto reconocido en ${resultado.size} ${resultado.size === 1 ? 'página' : 'páginas'}. Puede contener errores de lectura.`);
  } catch (e) {
    nodo.remove();
    bloquearMandos(!estado.oraciones.length);
    aviso(`No se pudo reconocer el texto: ${e.message ?? e}`);
  }
}

/* ---------- Pantallas ---------- */

function mostrarLector(nombre) {
  $('inicio').hidden = true;
  $('lector').hidden = false;
  $('nombre-archivo').textContent = nombre;
  $('zoom').hidden = false;
  $('vistas').hidden = false;
  $('abrir-otro').hidden = false;
  document.title = `${nombre}: PDF en voz alta`;
  requestAnimationFrame(() => pulso.dibujar());
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: nombre,
      artist: 'PDF en voz alta',
      artwork: [
        { src: 'iconos/icono-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'iconos/icono-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  }
}

function volverAlInicio() {
  $('inicio').hidden = false;
  $('lector').hidden = true;
  $('nombre-archivo').textContent = '';
  $('zoom').hidden = true;
  $('vistas').hidden = true;
  $('abrir-otro').hidden = true;
  document.title = 'PDF en voz alta';
}

function errorInicio(mensaje) {
  let nodo = document.querySelector('.error-inicio');
  if (!nodo) {
    nodo = document.createElement('p');
    nodo.className = 'nota problema error-inicio';
    nodo.setAttribute('role', 'alert');
    $('zona-carga').after(nodo);
  }
  nodo.textContent = mensaje;
}

async function abrirArchivo(archivo) {
  document.querySelector('.error-inicio')?.remove();
  if (!archivo || descarga.trabajo) return;
  panelDescarga('opciones');
  if (archivo.type && archivo.type !== 'application/pdf' && !/\.pdf$/i.test(archivo.name)) {
    errorInicio(`«${archivo.name}» no es un PDF. Elige un archivo que termine en .pdf.`);
    return;
  }
  const buffer = await archivo.arrayBuffer();
  await abrirDatos(new Uint8Array(buffer), archivo.name, archivo.size);
}

async function abrirEjemplo() {
  try {
    const r = await fetch('ejemplo/como-se-lee-un-pdf.pdf?v=20261103a');
    if (!r.ok) throw new Error(`error ${r.status}`);
    const buffer = await r.arrayBuffer();
    await abrirDatos(new Uint8Array(buffer), 'Cómo se lee un PDF en voz alta (ejemplo)', buffer.byteLength);
  } catch (e) {
    errorInicio(`No se pudo cargar el ejemplo (${e.message}). Abre un PDF propio.`);
  }
}

/* ---------- Eventos ---------- */

$('abrir').addEventListener('click', () => $('archivo').click());
$('abrir-otro').addEventListener('click', () => $('archivo').click());
$('ejemplo').addEventListener('click', abrirEjemplo);
$('archivo').addEventListener('change', (e) => {
  abrirArchivo(e.target.files[0]);
  e.target.value = '';
});

let arrastres = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  arrastres++;
  $('soltar').hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  arrastres = Math.max(0, arrastres - 1);
  if (!arrastres) $('soltar').hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  arrastres = 0;
  $('soltar').hidden = true;
  abrirArchivo(e.dataTransfer.files[0]);
});

$('reproducir').addEventListener('click', alternar);
$('anterior').addEventListener('click', () => irA(anteriorLegible(estado.idx)));
$('siguiente').addEventListener('click', () => {
  const sig = siguienteLegible(estado.idx);
  if (sig >= 0) irA(sig);
});

function fijarVelocidad(v) {
  estado.velocidad = Math.round(Math.min(2, Math.max(0.6, v)) * 10) / 10;
  $('velocidad').value = estado.velocidad;
  $('velocidad-valor').textContent = `${estado.velocidad.toFixed(1).replace('.', ',')}×`;
  guardar('velocidad', String(estado.velocidad));
  dispositivo?.cambiarVelocidad(estado.velocidad, estado.sonando && motor === dispositivo);
  neuronal.cambiarVelocidad(estado.velocidad);
  pintarEstado();
}
$('velocidad').addEventListener('input', (e) => fijarVelocidad(Number(e.target.value)));

$('abrir-ajustes').addEventListener('click', abrirAjustes);
$('abrir-voz').addEventListener('click', abrirAjustes);
$('cerrar-ajustes').addEventListener('click', () => $('ajustes').close());
$('ajustes').addEventListener('click', (e) => {
  if (e.target === $('ajustes')) $('ajustes').close();
});

$('abrir-descarga').addEventListener('click', abrirDescarga);
$('cerrar-descarga').addEventListener('click', () => $('descarga').close());
$('descarga').addEventListener('close', () => $('descarga-oir').pause());
$('descarga').addEventListener('cancel', (e) => {
  if (descarga.trabajo) e.preventDefault();
});
$('descarga').addEventListener('click', (e) => {
  if (e.target === $('descarga') && !descarga.trabajo) $('descarga').close();
});
for (const id of ['descarga-voz', 'descarga-desde', 'descarga-hasta']) $(id).addEventListener('input', pintarResumenDescarga);
$('descarga-generar').addEventListener('click', generarMp3);
$('descarga-parcial').addEventListener('click', () => descarga.trabajo?.detenerYGuardar());
$('descarga-cancelar').addEventListener('click', () => descarga.trabajo?.cancelar());
$('descarga-otro').addEventListener('click', () => {
  $('descarga-oir').pause();
  panelDescarga('opciones');
  abrirDescarga();
});

$('voz').addEventListener('change', (e) => aplicarVoz(e.target.value));
$('voz-ingles').addEventListener('change', (e) => aplicarVozIngles(e.target.value));
$('voz-ingles-descargar').addEventListener('click', () => prepararNeuronal(vozNeuronal(estado.vozIngles)));
$('voz-ingles-borrar').addEventListener('click', async () => {
  const v = vozNeuronal(estado.vozIngles);
  detener();
  await borrarVoz(v);
  neuronal.vozLista = null;
  pintarNotaIngles();
});
$('voz-ingles-probar').addEventListener('click', () => probarVoz('en'));
$('idioma-lectura').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-idioma]');
  if (b) cambiarTraduccion(b.dataset.idioma === 'es');
});
$('voz-descargar').addEventListener('click', async () => {
  const v = vozNeuronal(estado.vozElegida);
  $('voz-progreso').hidden = false;
  await prepararNeuronal(v);
});
$('voz-borrar').addEventListener('click', async () => {
  const v = vozNeuronal(estado.vozElegida);
  detener();
  await borrarVoz(v);
  neuronal.vozLista = null;
  pintarNotaVoz();
});
$('voz-probar').addEventListener('click', () => probarVoz('es'));

$('traducir').checked = estado.traducir;
$('traducir').addEventListener('change', (e) => cambiarTraduccion(e.target.checked));
$('omitir-referencias').checked = estado.omitirReferencias;
$('omitir-citas').checked = estado.omitirCitas;
function repintarOmitidas() {
  for (const o of estado.oraciones) o.nodo?.classList.toggle('omitida', omitida(o));
  pulso.usar(estado.oraciones, omitida);
  pulso.mover(estado.idx);
  pintarEstado();
}
$('omitir-referencias').addEventListener('change', (e) => {
  estado.omitirReferencias = e.target.checked;
  guardar('omitirReferencias', String(e.target.checked));
  repintarOmitidas();
});
$('omitir-elementos').checked = estado.omitirElementos;
$('omitir-elementos').addEventListener('change', (e) => {
  estado.omitirElementos = e.target.checked;
  guardar('omitirElementos', String(e.target.checked));
  repintarOmitidas();
  if (estado.oraciones.length) arrancarTraduccion(); // lo que vuelve a leerse también se traduce
});
$('omitir-citas').addEventListener('change', (e) => {
  estado.omitirCitas = e.target.checked;
  guardar('omitirCitas', String(e.target.checked));
  for (const o of estado.oraciones) o.voz = null;
  neuronal.vaciar();
});
$('ocr-forzar').addEventListener('click', () => {
  $('ajustes').close();
  ejecutarOcr(estado.paginas.map((_, n) => n));
});

$('panel-texto').addEventListener('click', (e) => {
  const s = e.target.closest('.oracion');
  if (s && !window.getSelection()?.toString()) irA(Number(s.dataset.i));
});

$('vistas').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-vista]');
  if (!b) return;
  document.querySelector('.paneles').dataset.vista = b.dataset.vista;
  for (const x of $('vistas').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  guardar('vista', b.dataset.vista);
  marcar();
});
if (leer('vista') === 'texto') $('vistas').querySelector('[data-vista="texto"]').click();

$('zoom-menos').addEventListener('click', () => visor.cambiarZoom(1 / 1.2));
$('zoom-mas').addEventListener('click', () => visor.cambiarZoom(1.2));

$('tema').addEventListener('click', () => {
  const oscuro = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const nuevo = oscuro ? 'light' : 'dark';
  document.documentElement.dataset.theme = nuevo;
  guardar('tema', nuevo);
  pulso.dibujar();
});

document.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || !estado.oraciones.length || $('lector').hidden) return;
  if (document.querySelector('dialog[open]')) return;
  const objetivo = e.target;
  if (objetivo.matches?.('input, select, textarea') && !(objetivo.type === 'range' && e.key === ' ')) return;
  if (e.key === ' ' && objetivo.tagName !== 'BUTTON') {
    e.preventDefault();
    alternar();
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    const sig = siguienteLegible(estado.idx);
    if (sig >= 0) irA(sig);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    irA(anteriorLegible(estado.idx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    fijarVelocidad(estado.velocidad + 0.1);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    fijarVelocidad(estado.velocidad - 0.1);
  }
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => { if (!estado.sonando) reproducir(); });
  navigator.mediaSession.setActionHandler('pause', () => { if (estado.sonando) pausar(); });
  navigator.mediaSession.setActionHandler('previoustrack', () => irA(anteriorLegible(estado.idx)));
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    const sig = siguienteLegible(estado.idx);
    if (sig >= 0) irA(sig);
  });
}

window.addEventListener('beforeunload', () => dispositivo?.detener());

iniciarInstalacion();
alCambiarVoces(pintarVoces);
pintarVoces();
fijarVelocidad(estado.velocidad);


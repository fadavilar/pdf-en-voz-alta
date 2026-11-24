// Bitácora técnica de la reproducción, para entender por qué se detiene en un teléfono concreto.
// Nunca guarda texto ni nombres de documentos, y no sale del equipo salvo que la persona la copie.

const CLAVE = 'pdfvoz:registro';
const MAXIMO = 250;
let lista = [];
try {
  lista = JSON.parse(localStorage.getItem(CLAVE) ?? '[]');
} catch {
  lista = [];
}

export function anotar(evento, datos = '') {
  const pantalla = document.visibilityState === 'hidden' ? 'OCULTA' : 'visible';
  lista.push(`${new Date().toISOString().slice(5, 19)} ${pantalla} ${evento} ${datos}`.trim());
  if (lista.length > MAXIMO) lista = lista.slice(-MAXIMO);
  try { localStorage.setItem(CLAVE, JSON.stringify(lista)); } catch { /* sin almacenamiento */ }
}

export function textoRegistro(extra) {
  return ['PDF en voz alta, registro técnico', navigator.userAgent, extra, ...lista].join('\n');
}

export function vigilar(audio) {
  for (const e of ['play', 'pause', 'waiting', 'stalled', 'ended', 'error']) {
    audio.addEventListener(e, () => anotar(`audio:${e}`, `t=${audio.currentTime.toFixed(0)}`));
  }
  document.addEventListener('visibilitychange', () => anotar(`pantalla:${document.visibilityState}`, `pausado=${audio.paused} t=${audio.currentTime.toFixed(0)}`));
  document.addEventListener('freeze', () => anotar('pagina:congelada'));
  document.addEventListener('resume', () => anotar('pagina:descongelada'));
  window.addEventListener('pagehide', (e) => anotar('pagina:salida', `guardada=${e.persisted}`));
}

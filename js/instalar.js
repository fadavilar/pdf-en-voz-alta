// Ofrece instalar la app en la pantalla de inicio. Android la instala con un botón;
// iOS no permite pedirlo desde la página, así que se explican los pasos.

const TEXTOS = {
  boton: 'Queda en tu pantalla de inicio con su logo, sin pasar por una tienda de apps.',
  ios: 'Pulsa Compartir en el navegador y luego «Añadir a pantalla de inicio». Queda con su logo, junto a tus otras apps.',
  android: 'Abre el menú del navegador y elige «Instalar app» o «Añadir a pantalla de inicio». Queda con su logo, junto a tus otras apps.',
  otro: 'En Chrome o Edge, usa el icono de instalar de la barra de direcciones. En el celular se añade a la pantalla de inicio con su logo.',
};

export function plataforma(ua, puntosTactiles = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && puntosTactiles > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'otro';
}

export function iniciarInstalacion() {
  const yaInstalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const sistema = plataforma(navigator.userAgent, navigator.maxTouchPoints);
  const inicio = document.getElementById('instalar-inicio');
  const ajustes = document.getElementById('seccion-instalar');
  let aviso = null;

  const pintar = () => {
    const instalada = yaInstalada || pintar.instalada;
    inicio.hidden = instalada || !(aviso || sistema !== 'otro');
    ajustes.hidden = instalada;
    const texto = TEXTOS[aviso ? 'boton' : sistema];
    for (const p of document.querySelectorAll('[data-instalar-texto]')) p.textContent = texto;
    for (const b of document.querySelectorAll('[data-instalar]')) b.hidden = !aviso;
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // se guarda para mostrarlo cuando la persona pulse el botón
    aviso = e;
    pintar();
  });
  window.addEventListener('appinstalled', () => {
    aviso = null;
    pintar.instalada = true;
    pintar();
  });
  for (const b of document.querySelectorAll('[data-instalar]')) {
    b.addEventListener('click', async () => {
      if (!aviso) return;
      const pendiente = aviso;
      aviso = null;
      pendiente.prompt();
      await pendiente.userChoice;
      pintar();
    });
  }
  pintar();
}

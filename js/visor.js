// Muestra el PDF página a página, dibuja solo lo que está cerca de la vista y resalta la oración en curso.

const MAX_DIBUJADAS = 8;

export class Visor {
  constructor(contenedor, { alPulsar }) {
    this.contenedor = contenedor;
    this.alPulsar = alPulsar;
    this.hojas = [];
    this.zoom = 1;
    this.oraciones = [];
    this.seguirDesde = 0;
    this.observador = new IntersectionObserver((entradas) => {
      for (const e of entradas) {
        const hoja = this.hojas[Number(e.target.dataset.p)];
        hoja.visible = e.isIntersecting;
        if (e.isIntersecting) this.#dibujar(hoja);
      }
    }, { root: contenedor, rootMargin: '60% 0px' });
    const pausarSeguimiento = () => {
      this.seguirDesde = Date.now() + 6000;
    };
    contenedor.addEventListener('wheel', pausarSeguimiento, { passive: true });
    contenedor.addEventListener('touchmove', pausarSeguimiento, { passive: true });
    this.alRedimensionar = new ResizeObserver(() => this.#ajustarAncho());
    this.alRedimensionar.observe(contenedor);
  }

  async abrir(pdf, medidas) {
    this.limpiar();
    this.pdf = pdf;
    this.hojas = medidas.map(({ W, H }, p) => {
      const nodo = document.createElement('div');
      nodo.className = 'hoja';
      nodo.dataset.p = p;
      nodo.style.aspectRatio = `${W} / ${H}`;
      nodo.setAttribute('role', 'img');
      nodo.setAttribute('aria-label', `Página ${p + 1} de ${medidas.length}`);
      const capa = document.createElement('div');
      capa.className = 'hoja-capa';
      nodo.append(capa);
      nodo.addEventListener('click', (e) => this.#pulsar(e, p, nodo));
      this.contenedor.append(nodo);
      this.observador.observe(nodo);
      return { nodo, capa, p, W, H, lienzo: null, visible: false, tarea: null, escala: 0, uso: 0 };
    });
    this.#ajustarAncho();
  }

  limpiar() {
    this.observador.disconnect();
    for (const h of this.hojas) h.tarea?.cancel();
    this.contenedor.replaceChildren();
    this.hojas = [];
    this.marcados = [];
  }

  usarOraciones(oraciones) {
    this.oraciones = oraciones;
    this.porPagina = new Map();
    for (const o of oraciones) {
      for (const r of o.rects) {
        if (!this.porPagina.has(r.p)) this.porPagina.set(r.p, []);
        this.porPagina.get(r.p).push({ ...r, i: o.i });
      }
    }
  }

  #ajustarAncho() {
    const ancho = Math.max(240, this.contenedor.clientWidth - 32);
    const nuevo = Math.round(ancho * this.zoom);
    if (nuevo === this.ancho) return;
    this.ancho = nuevo;
    for (const h of this.hojas) h.nodo.style.width = `${nuevo}px`;
    clearTimeout(this.esperaDibujo);
    this.esperaDibujo = setTimeout(() => {
      for (const h of this.hojas) if (h.visible) this.#dibujar(h);
    }, 120);
  }

  cambiarZoom(factor) {
    this.zoom = Math.min(3, Math.max(0.5, this.zoom * factor));
    this.#ajustarAncho();
    return this.zoom;
  }

  async #dibujar(hoja) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const escala = (this.ancho / hoja.W) * dpr;
    hoja.uso = performance.now();
    if (hoja.lienzo && Math.abs(hoja.escala - escala) < 0.01) return;
    hoja.tarea?.cancel();
    const pagina = await this.pdf.getPage(hoja.p + 1);
    const viewport = pagina.getViewport({ scale: escala });
    const lienzo = document.createElement('canvas');
    lienzo.width = Math.floor(viewport.width);
    lienzo.height = Math.floor(viewport.height);
    hoja.tarea = pagina.render({ canvas: lienzo, viewport });
    try {
      await hoja.tarea.promise;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn(e);
      return;
    }
    hoja.tarea = null;
    hoja.lienzo?.remove();
    hoja.nodo.prepend(lienzo);
    hoja.lienzo = lienzo;
    hoja.escala = escala;
    this.#liberar();
  }

  #liberar() {
    const dibujadas = this.hojas.filter((h) => h.lienzo && !h.visible).sort((a, b) => a.uso - b.uso);
    const sobran = this.hojas.filter((h) => h.lienzo).length - MAX_DIBUJADAS;
    for (const h of dibujadas.slice(0, Math.max(0, sobran))) {
      h.lienzo.width = 0;
      h.lienzo.remove();
      h.lienzo = null;
      h.escala = 0;
    }
  }

  #pulsar(evento, p, nodo) {
    const caja = nodo.getBoundingClientRect();
    const x = (evento.clientX - caja.left) / caja.width;
    const y = (evento.clientY - caja.top) / caja.height;
    const rects = this.porPagina?.get(p) ?? [];
    let mejor = null;
    let distancia = 0.03;
    for (const r of rects) {
      const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - r.x - r.w : 0;
      const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - r.y - r.h : 0;
      const d = Math.hypot(dx, dy);
      if (d < distancia) {
        distancia = d;
        mejor = r;
      }
    }
    if (mejor) this.alPulsar(mejor.i);
  }

  marcar(oracion, { desplazar = true } = {}) {
    for (const nodo of this.marcados ?? []) nodo.remove();
    this.marcados = [];
    if (!oracion) return;
    for (const r of oracion.rects) {
      const hoja = this.hojas[r.p];
      if (!hoja) continue;
      const m = document.createElement('div');
      m.className = 'marca';
      m.style.left = `${r.x * 100}%`;
      m.style.top = `${r.y * 100}%`;
      m.style.width = `${r.w * 100}%`;
      m.style.height = `${r.h * 100}%`;
      hoja.capa.append(m);
      this.marcados.push(m);
    }
    if (desplazar && Date.now() > this.seguirDesde) this.#llevarAVista(oracion);
  }

  #llevarAVista(oracion) {
    const r = oracion.rects[0];
    const hoja = r && this.hojas[r.p];
    if (!hoja || !this.contenedor.clientHeight) return;
    const vista = this.contenedor.getBoundingClientRect();
    const nodo = hoja.nodo.getBoundingClientRect();
    const y = nodo.top + nodo.height * r.y - vista.top;
    if (y < vista.height * 0.15 || y > vista.height * 0.7) {
      const suave = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.contenedor.scrollBy({ top: y - vista.height * 0.3, behavior: suave ? 'smooth' : 'auto' });
    }
  }

  retomarSeguimiento(oracion) {
    this.seguirDesde = 0;
    if (oracion) this.#llevarAVista(oracion);
  }
}

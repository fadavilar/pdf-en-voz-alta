// El pulso del documento: una barra por oración (alto según su longitud) que es progreso y navegación a la vez.

export class Pulso {
  constructor(lienzo, { alElegir, alMover }) {
    this.lienzo = lienzo;
    this.alElegir = alElegir;
    this.alMover = alMover;
    this.oraciones = [];
    this.actual = 0;
    this.omitida = () => false;
    new ResizeObserver(() => this.dibujar()).observe(lienzo);

    const indiceEn = (e) => {
      const caja = lienzo.getBoundingClientRect();
      const f = Math.min(0.9999, Math.max(0, (e.clientX - caja.left) / caja.width));
      return Math.floor(f * this.oraciones.length);
    };
    let arrastrando = false;
    lienzo.addEventListener('pointerdown', (e) => {
      if (!this.oraciones.length) return;
      arrastrando = true;
      lienzo.setPointerCapture(e.pointerId);
      this.vista = indiceEn(e);
      this.dibujar();
    });
    lienzo.addEventListener('pointermove', (e) => {
      if (!this.oraciones.length) return;
      const i = indiceEn(e);
      this.alMover?.(i, e.clientX - lienzo.getBoundingClientRect().left);
      if (arrastrando) {
        this.vista = i;
        this.dibujar();
      }
    });
    lienzo.addEventListener('pointerleave', () => this.alMover?.(null));
    lienzo.addEventListener('pointerup', (e) => {
      if (!arrastrando) return;
      arrastrando = false;
      this.vista = null;
      this.alElegir(indiceEn(e));
    });
    lienzo.addEventListener('keydown', (e) => {
      const salto = { ArrowLeft: -1, ArrowRight: 1, PageUp: -20, PageDown: 20 }[e.key];
      if (salto) {
        e.preventDefault();
        e.stopPropagation();
        this.alElegir(Math.max(0, Math.min(this.oraciones.length - 1, this.actual + salto)));
      }
    });
  }

  usar(oraciones, omitida) {
    this.oraciones = oraciones;
    this.omitida = omitida;
    this.lienzo.setAttribute('aria-valuemax', String(Math.max(0, oraciones.length - 1)));
    this.dibujar();
  }

  mover(i) {
    this.actual = i;
    this.lienzo.setAttribute('aria-valuenow', String(i));
    this.lienzo.setAttribute('aria-valuetext', `Oración ${i + 1} de ${this.oraciones.length}, página ${(this.oraciones[i]?.pagina ?? 0) + 1}`);
    this.dibujar();
  }

  dibujar() {
    const { lienzo } = this;
    const caja = lienzo.getBoundingClientRect();
    if (!caja.width) return;
    const dpr = window.devicePixelRatio || 1;
    lienzo.width = Math.round(caja.width * dpr);
    lienzo.height = Math.round(caja.height * dpr);
    const g = lienzo.getContext('2d');
    g.scale(dpr, dpr);
    const css = getComputedStyle(lienzo);
    const color = (n) => css.getPropertyValue(n).trim();
    const leida = color('--tinta');
    const pendiente = color('--pulso-pendiente');
    const omitida = color('--pulso-omitida');
    const marcador = color('--marcador');
    const contorno = color('--tinta');

    const n = this.oraciones.length;
    if (!n) return;
    const paso = Math.max(3, Math.min(9, caja.width / n));
    const columnas = Math.min(n, Math.floor(caja.width / paso));
    const anchoCol = caja.width / columnas;
    const barra = Math.max(1.5, anchoCol * 0.62);
    const alto = caja.height;
    const piso = 3;
    const actual = this.vista ?? this.actual;
    const colActual = Math.floor((actual / n) * columnas);

    for (let c = 0; c < columnas; c++) {
      const a = Math.floor((c / columnas) * n);
      const b = Math.max(a + 1, Math.floor(((c + 1) / columnas) * n));
      let largo = 0;
      let todasOmitidas = true;
      for (let i = a; i < b; i++) {
        largo = Math.max(largo, this.oraciones[i].texto.length);
        if (!this.omitida(this.oraciones[i])) todasOmitidas = false;
      }
      const h = Math.max(piso, Math.min(1, Math.sqrt(largo / 220)) * (alto - 8));
      const x = c * anchoCol + (anchoCol - barra) / 2;
      const y = (alto - h) / 2;
      if (c === colActual) continue;
      g.fillStyle = todasOmitidas ? omitida : c < colActual ? leida : pendiente;
      g.fillRect(x, y, barra, h);
    }

    // La oración en curso va al final para que el marcador quede encima de sus vecinas.
    const xActual = colActual * anchoCol + anchoCol / 2;
    const anchoMarca = Math.max(5, barra + 2);
    g.fillStyle = marcador;
    g.strokeStyle = contorno;
    g.lineWidth = 1;
    g.beginPath();
    g.rect(xActual - anchoMarca / 2, 1, anchoMarca, alto - 2);
    g.fill();
    g.stroke();
  }
}

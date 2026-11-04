// Comunicación con el worker de traducción. Se cierra al terminar para devolver la memoria al celular.

const WORKER = 'js/traductor-worker.js?v=20261104a';

export class Traductor {
  constructor({ alProgreso } = {}) {
    this.alProgreso = alProgreso;
    this.worker = null;
    this.lista = null;
    this.contador = 0;
    this.solicitudes = new Map();
  }

  #fallarTodo(error) {
    for (const s of this.solicitudes.values()) s.reject(error);
    this.solicitudes.clear();
  }

  #enviar(mensaje) {
    const id = ++this.contador;
    return new Promise((resolve, reject) => {
      this.solicitudes.set(id, { resolve, reject });
      this.worker.postMessage({ ...mensaje, id });
    });
  }

  preparar() {
    if (this.lista) return this.lista;
    this.worker = new Worker(WORKER);
    this.worker.onerror = (e) => this.#fallarTodo(new Error(e.message || 'El traductor no pudo iniciar.'));
    this.worker.onmessage = ({ data }) => {
      if (data.tipo === 'progreso') {
        this.alProgreso?.(data.hecho, data.total);
        return;
      }
      const s = this.solicitudes.get(data.id);
      this.solicitudes.delete(data.id);
      if (data.tipo === 'error') s?.reject(new Error(data.mensaje));
      else s?.resolve(data);
    };
    this.lista = this.#enviar({ tipo: 'preparar' });
    return this.lista;
  }

  async traducir(texto) {
    await this.preparar();
    return (await this.#enviar({ tipo: 'traducir', texto })).texto;
  }

  cerrar() {
    this.worker?.terminate();
    this.worker = null;
    this.lista = null;
    this.#fallarTodo(new Error('El traductor se cerró.'));
  }
}

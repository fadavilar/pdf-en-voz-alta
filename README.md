# PDF en voz alta

Abre un PDF y escúchalo en español, directamente en el navegador. El archivo no se sube a ningún servidor.

**Usar la app:** https://fadavilar.github.io/pdf-en-voz-alta/

## Qué hace

- Lee artículos a varias columnas en el orden correcto y une las palabras partidas por un guion al final de la línea.
- Resalta cada oración en la página y en el panel de texto. Pulsa cualquier frase para seguir desde allí.
- Deja fuera encabezados, pies y números de página. Por defecto salta las referencias y las citas, y ambas opciones se cambian en Ajustes.
- Lee las cifras y abreviaturas como lo haría una persona: «IC 95 %» se oye «intervalo de confianza del 95 por ciento».
- Reconoce el texto de los PDF escaneados con OCR.
- Recuerda en qué oración quedaste con cada archivo.
- Traduce siempre al español lo que esté en inglés, dentro del dispositivo y por bloques, de modo que un resumen en inglés de un artículo en español también se traduce. Se puede desactivar en Ajustes.
- Con un clic en «Escuchar en: Inglés», lee el original con voz inglesa y sigue en la misma oración. En un documento que mezcla idiomas, cada parte suena con la voz de su idioma. La elección queda guardada.
- Descarga el audio en MP3 (64 kbit/s), con voces neuronales, de todo el documento o de un rango de páginas. Usa [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders) (MIT) con el codificador LAME (LGPL), en `vendor/mp3/`.
- Se instala en Android e iOS como app web, con su logo en la pantalla de inicio. No se distribuye por Play Store ni App Store, y necesita conexión para abrirse.

## Voces

| Tipo | Descarga | Privacidad |
|---|---|---|
| Del dispositivo (Web Speech API) | Ninguna | Las locales leen sin conexión. Las marcadas «en línea» envían cada oración al proveedor de la voz. |
| Neuronales (Piper) | 21 a 114 MB por voz, más 33 MB del motor, una sola vez | Se ejecutan en el navegador. El texto no sale del equipo. |

## Bibliotecas elegidas

| Función | Biblioteca | Licencia | Por qué |
|---|---|---|---|
| Leer y mostrar el PDF | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 | Da la posición de cada texto, necesaria para ordenar columnas y resaltar. |
| OCR | [naptha/tesseract.js](https://github.com/naptha/tesseract.js) | Apache-2.0 | Corre en el navegador y tiene modelo de español. |
| Inferencia de voz | [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime) (Web) | MIT | Ejecuta los modelos de Piper en WebAssembly. |
| Fonemas | [diffusion-studio/piper-wasm](https://github.com/diffusion-studio/piper-wasm), con [eSpeak NG](https://github.com/espeak-ng/espeak-ng) | MIT y GPL-3.0 | Convierte el texto en español a los fonemas que espera Piper. |
| Traducción | [mozilla/translations](https://github.com/mozilla/translations) (Bergamot y modelos de Firefox Translations) | MPL-2.0 | Traduce en el dispositivo, sin enviar el texto a ningún servidor; 42 MB y unos 100 ms por oración. |
| Voces | [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) | Ver abajo | Voces neuronales ligeras de México, España y Argentina. |
| Varios hilos en GitHub Pages | [gzuidhof/coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker) | MIT | Hace la voz neuronal unas 2,5 veces más rápida (medido en un equipo de 12 núcleos). |

PDF.js, las tipografías, `coi-serviceworker`, el codificador MP3 y el traductor con sus modelos (`vendor/traduccion/`, descargados de Mozilla y sin modificar) están en este repositorio. ONNX Runtime, piper-wasm y Tesseract.js se cargan desde jsDelivr con versión fijada, y solo cuando se usa esa función. Los modelos de voz se descargan de Hugging Face. eSpeak NG no se redistribuye aquí.

Se descartaron [kokoro-js](https://github.com/hexgrad/kokoro/tree/main/kokoro.js), que solo documenta voces en inglés; [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), cuyo paquete WebAssembly se compila con el modelo incluido, y [piper-tts-web](https://github.com/Mintplex-Labs/piper-tts-web), que corre en el hilo principal y congelaría la interfaz.

**Licencias de las voces en inglés:** LJ y Cori, dominio público. Alba, CC BY 4.0.

**Licencias de las voces en español:** Ald, Unlicense. Claude, Apache-2.0 (voz de HirCoir, sin relación con Anthropic). Davefx, CC0. Daniela, CC BY-SA 4.0 (larcanio).

## Límites conocidos

- Las tablas se leen columna por columna, y las fórmulas no se interpretan. Pulsa la oración siguiente para saltarlas.
- Las notas al pie se leen donde aparecen.
- La traducción automática puede tener errores, sobre todo en terminología especializada. El panel de texto muestra el original al pasar el cursor sobre cada frase.
- El OCR puede cometer errores de lectura.

## Desarrollo

Es una app estática sin paso de compilación. Para probarla en local hace falta un servidor:

```bash
python -m http.server 8767
```

Las pruebas de la lógica de texto no requieren dependencias:

```bash
node --test tests/texto.test.mjs
```

## Autoría y licencia

Fabian Dávila Ramírez, MD, MBA, PhD. Código bajo licencia [MIT](LICENSE). Cada dependencia conserva su propia licencia.

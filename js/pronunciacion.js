// Prepara el texto de una oración para que suene natural en su idioma.
// Solo cambia lo que se oye: la oración mostrada y resaltada sigue siendo la original.

const UNIDADES_ES = [
  [/mg\/dL/g, 'miligramos por decilitro'],
  [/mmol\/L/g, 'milimoles por litro'],
  [/mmHg/g, 'milímetros de mercurio'],
  [/kg\/m2|kg\/m²/g, 'kilogramos por metro cuadrado'],
  [/[µμ]g/g, 'microgramos'],
  [/mg/g, 'miligramos'],
  [/kg/g, 'kilogramos'],
  [/mL|ml/g, 'mililitros'],
  [/°C/g, 'grados centígrados'],
];

const UNIDADES_EN = [
  [/mg\/dL/g, 'milligrams per deciliter'],
  [/mmol\/L/g, 'millimoles per liter'],
  [/mmHg/g, 'millimeters of mercury'],
  [/kg\/m2|kg\/m²/g, 'kilograms per square meter'],
  [/[µμ]g/g, 'micrograms'],
  [/mg/g, 'milligrams'],
  [/kg/g, 'kilograms'],
  [/mL|ml/g, 'milliliters'],
  [/°C/g, 'degrees Celsius'],
];

const ABREVIATURAS_ES = [
  [/\bet al\.?(?=[\s,;:).]|$)/g, 'y colaboradores'],
  [/\bp\.\s?ej\./gi, 'por ejemplo'],
  [/\bFigs\.(?=\s)/g, 'figuras'],
  [/\bFig\.(?=\s)/g, 'figura'],
  [/\bTab\.(?=\s)/g, 'tabla'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bDr\.(?=\s)/g, 'doctor'],
  [/\bDra\.(?=\s)/g, 'doctora'],
  [/\betc\./g, 'etcétera'],
  [/\baprox\.(?=\s)/gi, 'aproximadamente'],
  [/\b(?:Núm|núm|No|Nro)\.\s?(?=\d)/g, 'número '],
  [/\bpp\.\s?(?=\d)/g, 'páginas '],
  [/\bp\.\s?(?=\d)/g, 'página '],
  [/\bvol\.\s?(?=\d)/gi, 'volumen '],
  [/\bIC\s?(?:del\s)?(\d{2})\s?%/g, 'intervalo de confianza del $1 por ciento'],
  [/\bDE\b(?=\s?[=:])/g, 'desviación estándar'],
  [/\bRR\b/g, 'riesgo relativo'],
];

const ABREVIATURAS_EN = [
  [/\bet al\.?(?=[\s,;:).]|$)/g, 'and colleagues'],
  [/\be\.g\.,?/gi, 'for example'],
  [/\bi\.e\.,?/gi, 'that is'],
  [/\bFigs\.(?=\s)/g, 'figures'],
  [/\bFig\.(?=\s)/g, 'figure'],
  [/\bTab\.(?=\s)/g, 'table'],
  [/\bvs\.?(?=\s)/gi, 'versus'],
  [/\bDr\.(?=\s)/g, 'doctor'],
  [/\betc\./g, 'et cetera'],
  [/\bapprox\.(?=\s)/gi, 'approximately'],
  [/\bNo\.\s?(?=\d)/g, 'number '],
  [/\bpp\.\s?(?=\d)/g, 'pages '],
  [/\bp\.\s?(?=\d)/g, 'page '],
  [/\bvol\.\s?(?=\d)/gi, 'volume '],
  [/\b(\d{2})\s?%\s?(?:CI|confidence interval)\b/g, '$1 percent confidence interval'],
  [/\bCI\b/g, 'confidence interval'],
  [/\bSD\b(?=\s?[=:])/g, 'standard deviation'],
  [/\bRR\b/g, 'relative risk'],
  [/\bHR\b/g, 'hazard ratio'],
];

const SIGNOS_ES = [
  [/\s*≤\s*/g, ' menor o igual que '],
  [/\s*≥\s*/g, ' mayor o igual que '],
  [/\s*<\s*/g, ' menor que '],
  [/\s*>\s*/g, ' mayor que '],
  [/\s*±\s*/g, ' más o menos '],
  [/\s*=\s*/g, ' igual a '],
  [/\s*×\s*/g, ' por '],
];

const SIGNOS_EN = [
  [/\s*≤\s*/g, ' less than or equal to '],
  [/\s*≥\s*/g, ' greater than or equal to '],
  [/\s*<\s*/g, ' less than '],
  [/\s*>\s*/g, ' greater than '],
  [/\s*±\s*/g, ' plus or minus '],
  [/\s*=\s*/g, ' equals '],
  [/\s*×\s*/g, ' times '],
];

const REGLAS = {
  es: { unidades: UNIDADES_ES, abreviaturas: ABREVIATURAS_ES, signos: SIGNOS_ES, enlace: 'enlace', dolares: 'dólares', rango: 'a', porcentaje: 'por ciento' },
  en: { unidades: UNIDADES_EN, abreviaturas: ABREVIATURAS_EN, signos: SIGNOS_EN, enlace: 'link', dolares: 'dollars', rango: 'to', porcentaje: 'percent' },
};

// Citas numéricas [1], [2-5] y de autor-año (Pérez, 2020; García y López, 2019).
const CITA_NUMERICA = /\s*\[\s*\d+(?:\s*[-–,;]\s*\d+)*\s*\]/g;
const CITA_AUTOR = /\s*\(\s*\p{Lu}[^()]{0,120}?(?:19|20)\d{2}[a-z]?(?:\s*;\s*[^()]{0,120}?(?:19|20)\d{2}[a-z]?)*\s*\)/gu;

function suavizarMayusculas(texto) {
  const letras = texto.replace(/[^\p{L}]/gu, '');
  if (letras.length < 6) return texto;
  const mayus = letras.replace(/[^\p{Lu}]/gu, '').length;
  if (mayus / letras.length < 0.7) return texto;
  const minusculas = texto.toLowerCase();
  return minusculas.replace(/\p{L}/u, (c) => c.toUpperCase());
}

export function paraVoz(texto, { citas = false, idioma = 'es' } = {}) {
  const r = REGLAS[idioma] ?? REGLAS.es;
  let t = texto;
  t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, r.enlace);
  t = t.replace(/\bdoi:?\s*10\.\S+|\b10\.\d{4,}\/\S+/gi, r.enlace);
  if (!citas) t = t.replace(CITA_NUMERICA, '').replace(CITA_AUTOR, '');
  for (const [re, voz] of r.abreviaturas) t = t.replace(re, voz);
  t = t.replace(/\bUS\$\s?([\d.,]+)/g, `$1 ${r.dolares}`);
  if (idioma === 'es') t = t.replace(/\b\d{1,3}(?:\.\d{3})+\b/g, (n) => n.replace(/\./g, ''));
  t = t.replace(/(\d)\s?[-–]\s?(?=\d)/g, `$1 ${r.rango} `);
  t = t.replace(/(\d)\s?%/g, `$1 ${r.porcentaje}`);
  for (const [re, voz] of r.unidades) t = t.replace(new RegExp(`(\\d\\s?)${re.source}\\b`, 'g'), `$1${voz}`);
  for (const [re, voz] of r.signos) t = t.replace(re, voz);
  t = t.replace(/^[\s•·▪◦*–—-]+/, '').replace(/\s+([,.;:])/g, '$1').replace(/\s+/g, ' ').trim();
  return suavizarMayusculas(t);
}

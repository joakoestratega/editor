// Editor de reels que corre dentro del navegador.
// Nada sale del computador de quien lo usa: no hay servidor, no hay subida, no hay cuenta.
//
// IDEA CENTRAL: el texto de la pantalla representa TODO el audio, no solo lo que el
// reconocimiento entendió. Cada pedazo del video es una ficha: una palabra, un sonido
// sin palabra (una muletilla cortada, un carraspeo) o un silencio. Todas se pueden
// quitar y devolver con un clic. Si algo suena en el video, está en la lista.
//
// Antes solo se mostraban las palabras reconocidas, así que una muletilla que el
// reconocimiento no escribió era invisible e imposible de quitar, y una palabra dicha
// bajito que el detector de silencio se comía no se podía recuperar. Lo reportó Joako
// editando un video suyo.

import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality,
} from './lib/mediabunny.min.mjs';

// ------------------------------------------------------------------- ajustes
const MAX_ENTRADA = 300;       // 5 minutos de material crudo
const MAX_SALIDA = 90;         // el reel terminado
const MAX_LADO_LARGO = 1920;   // el 4K del celular se baja a 1080p al exportar
const MAX_PREVIA = 720;        // la vista previa se pinta más chica, o un 4K va a tirones
const FPS = 30;

const VENTANA = 0.02;          // 20 ms: el grano con que se mide el audio
const SOBRE_EL_RUIDO = 3.0;
const MIN_SILENCIO = 0.35;
const COLCHON = 0.12;
const BUSCAR_VALLE = 0.20;     // cuánto se mueve un corte para caer en un hueco de audio
const MIN_SONIDO = 0.10;       // trozo con voz y sin palabra que vale la pena mostrar

// Se puede pedir otro modelo o otro peso por la dirección, para poder comparar
// cuánto se baja contra qué tan bien queda el texto sin editar el programa:
//   ?modelo=onnx-community/whisper-tiny_timestamped&peso=q8
const AJUSTE = new URLSearchParams(location.search);
const MODELO = AJUSTE.get('modelo') || 'onnx-community/whisper-base_timestamped';
const MODELO_RESPALDO = 'Xenova/whisper-base';

const MULETILLAS = [
  'eh', 'ehh', 'ehhh', 'em', 'emm', 'mm', 'mmm', 'mmmm',
  'ah', 'ahh', 'uh', 'uhh', 'aja', 'ajá', 'o sea', 'osea',
];
const NO_ES_VOZ = /^\s*[\[\(].*[\]\)]\s*$/;

const SUB_MAX_SEG = 1.7;
const SUB_MAX_LETRAS = 30;
const FRASE_DE_MUESTRA = 'Así se van a ver tus subtítulos';

// ------------------------------------------------------------------- utilería
const $ = (id) => document.getElementById(id);
let transcriptor = null;

// Todo vive en el tiempo del video ORIGINAL. Sin espacios de tiempo paralelos:
// esos mapeos eran la fuente de los errores de sincronía más difíciles de ver.
const T = {
  archivo: null, video: null, ctxAudio: null, bufferOriginal: null,
  energia: [],          // energía por ventana de 20 ms, para colocar bien los cortes
  piezas: [],           // { tipo:'palabra'|'sonido'|'silencio', ini, fin, texto, original, fuera }
  ancho: 0, alto: 0, duracionEntrada: 0,
};

function paso(titulo, detalle = '') { $('paso').textContent = titulo; $('detalle').textContent = detalle; }
function avance(p) { $('avance').style.width = Math.max(0, Math.min(100, p)) + '%'; }
function mostrar(cual) {
  for (const id of ['zona', 'estado', 'mesa', 'listo']) $(id).style.display = (id === cual) ? 'block' : 'none';
}
function avisar(texto) {
  const a = $('avisoNavegador');
  if (!texto) { a.style.display = 'none'; return; }
  a.textContent = texto; a.style.display = 'block';
}
function navegadorSirve() {
  const falta = [];
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') falta.push('video');
  if (typeof AudioEncoder === 'undefined') falta.push('audio');
  if (falta.length) {
    avisar('Este navegador no puede procesar video (' + falta.join(' y ') +
           '). Usa Chrome, Edge o Safari actualizados, en un computador.');
    return false;
  }
  return true;
}
const seg1 = (s) => s.toFixed(1).replace('.', ',');

// ----------------------------------------------------------------- el audio
function medirEnergia(audioBuffer) {
  const sr = audioBuffer.sampleRate;
  const datos = audioBuffer.getChannelData(0);
  const v = Math.floor(sr * VENTANA);
  const energia = new Float32Array(Math.floor(datos.length / v));
  for (let k = 0; k < energia.length; k++) {
    let suma = 0;
    const desde = k * v;
    for (let j = desde; j < desde + v; j++) suma += datos[j] * datos[j];
    energia[k] = Math.sqrt(suma / v);
  }
  return energia;
}

function umbralDeVoz(energia) {
  const orden = Array.from(energia).sort((a, b) => a - b);
  const piso = orden[Math.floor(orden.length * 0.10)] || 0;
  const nivelVoz = orden[Math.min(orden.length - 1, Math.floor(orden.length * 0.99))] || 0;
  return Math.max(piso * SOBRE_EL_RUIDO, nivelVoz * 0.15);
}

function tramosConVoz(energia, hasta) {
  const umbral = umbralDeVoz(energia);
  const tramos = [];
  let ini = null, ultimaVoz = null;
  for (let k = 0; k < energia.length; k++) {
    const t = k * VENTANA;
    if (energia[k] > umbral) {
      if (ini === null) ini = t;
      ultimaVoz = t + VENTANA;
    } else if (ini !== null && (t - ultimaVoz) >= MIN_SILENCIO) {
      tramos.push({ ini: Math.max(0, ini - COLCHON), fin: ultimaVoz + COLCHON });
      ini = null;
    }
  }
  if (ini !== null) tramos.push({ ini: Math.max(0, ini - COLCHON), fin: ultimaVoz + COLCHON });

  const limpios = [];
  for (const tr of tramos) {
    if (tr.ini >= hasta) break;
    tr.fin = Math.min(tr.fin, hasta);
    const ult = limpios[limpios.length - 1];
    if (ult && tr.ini <= ult.fin) ult.fin = tr.fin;
    else limpios.push(tr);
  }
  return limpios.length ? limpios : [{ ini: 0, fin: hasta }];
}

// Mueve un corte al hueco de audio más cercano. Los tiempos que da el reconocimiento
// son aproximados: cortar en el número exacto deja sonando el arranque de la palabra
// que se quitó. Medido en un video exportado por Joako: 66 cortes tenían voz a los
// dos lados, y por eso se oía entrecortado.
function alValle(t) {
  const e = T.energia;
  if (!e || !e.length) return t;
  const centro = Math.round(t / VENTANA);
  const radio = Math.round(BUSCAR_VALLE / VENTANA);
  let mejor = centro, menor = Infinity;
  for (let k = Math.max(0, centro - radio); k <= Math.min(e.length - 1, centro + radio); k++) {
    if (e[k] < menor) { menor = e[k]; mejor = k; }
  }
  return mejor * VENTANA;
}

function audioRecortado(ctx, original, tramos) {
  const sr = original.sampleRate;
  const canales = Math.min(original.numberOfChannels, 2);
  const total = tramos.reduce((a, t) => a + Math.round((t.fin - t.ini) * sr), 0);
  const salida = ctx.createBuffer(canales, Math.max(total, 1), sr);
  for (let c = 0; c < canales; c++) {
    const dst = salida.getChannelData(c);
    const src = original.getChannelData(Math.min(c, original.numberOfChannels - 1));
    let pos = 0;
    for (const t of tramos) {
      const a = Math.round(t.ini * sr), b = Math.round(t.fin * sr);
      dst.set(src.subarray(a, Math.min(b, src.length)), pos);
      pos += b - a;
    }
  }
  return salida;
}

async function a16k(audioBuffer) {
  const destino = 16000;
  const off = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * destino), destino);
  const f = off.createBufferSource();
  f.buffer = audioBuffer; f.connect(off.destination); f.start();
  return (await off.startRendering()).getChannelData(0);
}

// ------------------------------------------------------------- reconocer la voz
function pesoPedido(device) {
  const p = AJUSTE.get('peso');
  if (!p) return device === 'webgpu' ? 'fp32' : 'q8';
  if (p.includes('+')) {
    const [enc, dec] = p.split('+');
    return { encoder_model: enc, decoder_model_merged: dec };
  }
  return p;
}

async function cargarTranscriptor() {
  if (transcriptor) return transcriptor;
  // PENDIENTE de seguridad: esta librería todavía viene de un servidor ajeno.
  // Traerla al propio sitio se intentó y arrastra una cadena de dependencias
  // (onnxruntime-web y onnxruntime-common) que hay que resolver con calma.
  // Mientras tanto va con VERSIÓN FIJA, no con un rango: así nadie puede
  // cambiar el archivo bajo los pies de los usuarios sin que nos enteremos.
  const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/+esm');
  const conGrafica = typeof navigator !== 'undefined' && 'gpu' in navigator;
  const bajado = {};
  const intentar = (modelo, device) => {
    if ($('estado').style.display !== 'none') {
      paso('Preparando el reconocimiento de voz',
           'La primera vez hay que traerlo. Después queda guardado en este navegador.');
    }
    return pipeline('automatic-speech-recognition', modelo, {
      // ⚠️ NO TOCAR EL PESO DEL MODELO SIN MEDIR LAS DOS COSAS: lo que se baja Y
      // si el texto sale bien. Medido el 2026-09-14: así se bajan 286 MB la primera
      // vez, que es mucho. Pero comprimir el modelo entero (q8) lo ROMPE (el texto
      // sale con caracteres basura), y comprimir solo el decodificador lo deja tan
      // lento que no termina en 15 minutos. Queda pendiente encontrar un modelo
      // más liviano que sí dé los tiempos por palabra, que es lo que este editor
      // necesita y lo que obliga a usar la versión "_timestamped".
      device, dtype: pesoPedido(device),
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          bajado[p.file] = p.loaded;
          const megas = Object.values(bajado).reduce((a, b) => a + b, 0) / 1024 / 1024;
          if ($('estado').style.display !== 'none') {
            $('detalle').textContent =
              `Trayendo el reconocimiento de voz: ${megas.toFixed(0)} MB. ` +
              `Esto pasa una sola vez; la próxima abre de una.`;
          }
        }
      },
    });
  };
  try { transcriptor = await intentar(MODELO, conGrafica ? 'webgpu' : 'wasm'); }
  catch (e) {
    console.warn('Modelo principal falló, se usa el de respaldo:', e);
    transcriptor = await intentar(MODELO_RESPALDO, 'wasm');
  }
  return transcriptor;
}

// ------------------------------------------------------------------ las piezas
// Construye la lista que cubre TODO el video: palabras, sonidos sin palabra y silencios.
function armarPiezas(tramosVoz, palabrasEnCortado) {
  // Los tiempos del reconocimiento vienen medidos sobre el audio sin silencios.
  // Se traducen al tiempo del video una sola vez, aquí, y de aquí en adelante
  // todo el programa trabaja en tiempo del video original.
  const aOrig = (t) => {
    let acumulado = 0;
    for (const tr of tramosVoz) {
      const dura = tr.fin - tr.ini;
      if (t < acumulado + dura) return tr.ini + (t - acumulado);
      acumulado += dura;
    }
    return tramosVoz.length ? tramosVoz[tramosVoz.length - 1].fin : t;
  };

  const palabras = palabrasEnCortado.map((p) => ({
    tipo: 'palabra', texto: p.texto, original: p.texto,
    ini: aOrig(p.ini), fin: aOrig(p.fin), fuera: false,
  })).sort((a, b) => a.ini - b.ini);

  const piezas = [];
  let cursor = 0;

  for (const tr of tramosVoz) {
    if (tr.ini > cursor + 0.05) {
      piezas.push({ tipo: 'silencio', ini: cursor, fin: tr.ini, fuera: true });
    }
    let dentro = tr.ini;
    for (const p of palabras) {
      if (p.fin <= tr.ini || p.ini >= tr.fin) continue;
      const ini = Math.max(p.ini, tr.ini), fin = Math.min(p.fin, tr.fin);
      // Audio con voz que el reconocimiento no escribió: una muletilla cortada,
      // un carraspeo. Antes era invisible y no había forma de quitarlo.
      if (ini - dentro >= MIN_SONIDO) piezas.push({ tipo: 'sonido', ini: dentro, fin: ini, fuera: false });
      piezas.push({ ...p, ini, fin });
      dentro = fin;
    }
    if (tr.fin - dentro >= MIN_SONIDO) piezas.push({ tipo: 'sonido', ini: dentro, fin: tr.fin, fuera: false });
    cursor = tr.fin;
  }
  if (T.duracionEntrada > cursor + 0.05) {
    piezas.push({ tipo: 'silencio', ini: cursor, fin: T.duracionEntrada, fuera: true });
  }
  return piezas.filter((p) => p.fin > p.ini);
}

// Los pedazos que de verdad van a salir, con los cortes puestos en un hueco de audio
function tramosVivos() {
  const vivos = [];
  for (const p of T.piezas) {
    if (p.fuera) continue;
    const ult = vivos[vivos.length - 1];
    if (ult && p.ini - ult.fin < 0.02) ult.fin = p.fin;
    else vivos.push({ ini: p.ini, fin: p.fin });
  }
  return vivos.map((t) => {
    const ini = Math.max(0, alValle(t.ini));
    const fin = Math.min(T.duracionEntrada, alValle(t.fin));
    return fin - ini > 0.05 ? { ini, fin } : t;
  });
}

function limitarSalida(tramos, tope) {
  const buenos = [];
  let acumulado = 0;
  const total = tramos.reduce((a, t) => a + (t.fin - t.ini), 0);
  for (const t of tramos) {
    const dura = t.fin - t.ini;
    if (acumulado + dura <= tope) { buenos.push(t); acumulado += dura; }
    else {
      const cabe = tope - acumulado;
      if (cabe > 0.25) { buenos.push({ ini: t.ini, fin: t.ini + cabe }); acumulado = tope; }
      break;
    }
  }
  return { tramos: buenos.length ? buenos : tramos.slice(0, 1), sobraron: Math.max(0, total - acumulado) };
}

// ------------------------------------------------- tomas repetidas y erradas
function normalizar(texto) {
  return String(texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function frasesHabladas() {
  const frases = [];
  let actual = null;
  T.piezas.forEach((p, i) => {
    if (p.tipo === 'silencio') { if (actual) { frases.push(actual); actual = null; } return; }
    if (p.tipo !== 'palabra') return;
    if (actual && (p.ini - actual.fin) < 0.45) {
      actual.texto += ' ' + p.texto; actual.fin = p.fin; actual.indices.push(i);
    } else {
      if (actual) frases.push(actual);
      actual = { ini: p.ini, fin: p.fin, texto: p.texto, indices: [i] };
    }
  });
  if (actual) frases.push(actual);
  return frases;
}

function esIntentoFallido(anterior, siguiente) {
  const A = normalizar(anterior).split(' ').filter(Boolean);
  const B = normalizar(siguiente).split(' ').filter(Boolean);
  if (A.length < 2 || B.length < 2) return false;
  let iguales = 0;
  for (let i = 0; i < Math.min(A.length, B.length); i++) { if (A[i] === B[i]) iguales++; else break; }
  if (iguales >= 2 && iguales / A.length >= 0.6) return true;
  const enB = new Set(B);
  const comunes = A.filter((p) => enB.has(p)).length;
  return A.length >= 3 && (2 * comunes) / (A.length + B.length) >= 0.72;
}

function marcarTomasRepetidas() {
  const frases = frasesHabladas();
  let cuantas = 0;
  for (let i = 0; i < frases.length - 1; i++) {
    if (esIntentoFallido(frases[i].texto, frases[i + 1].texto)) {
      for (const idx of frases[i].indices) T.piezas[idx].fuera = true;
      cuantas++;
    }
  }
  return cuantas;
}

// ------------------------------------------------------------------ subtítulos
function esMuletilla(palabra) {
  const limpia = palabra.toLowerCase().replace(/[.,;:!¡?¿"']/g, '').trim();
  return MULETILLAS.includes(limpia);
}

function aSalida(tOriginal) {
  for (const m of R.mapa) if (tOriginal >= m.ini && tOriginal < m.fin) return m.desde + (tOriginal - m.ini);
  return null;
}
function aOriginal(tSalida) {
  for (const m of R.mapa) {
    const dura = m.fin - m.ini;
    if (tSalida < m.desde + dura) return m.ini + Math.max(0, tSalida - m.desde);
  }
  return R.mapa.length ? R.mapa[R.mapa.length - 1].fin : 0;
}

function armarSubtitulos(quitarMuletillas) {
  const subs = [];
  let actual = null;
  for (const p of T.piezas) {
    if (p.fuera || p.tipo !== 'palabra') continue;
    const texto = p.texto.trim();
    if (!texto || NO_ES_VOZ.test(texto)) continue;
    if (quitarMuletillas && esMuletilla(texto)) continue;
    const ini = aSalida(p.ini);
    if (ini === null) continue;
    const fin = ini + Math.max(0.12, p.fin - p.ini);

    if (actual && (fin - actual.ini) <= SUB_MAX_SEG &&
        (actual.texto.length + texto.length + 1) <= SUB_MAX_LETRAS) {
      actual.texto += ' ' + texto; actual.fin = fin;
    } else {
      if (actual) subs.push(actual);
      actual = { ini, fin, texto };
    }
  }
  if (actual) subs.push(actual);
  for (let i = 0; i < subs.length; i++) {
    const sig = subs[i + 1];
    subs[i].fin = Math.min(subs[i].fin + 0.25, sig ? sig.ini : subs[i].fin + 0.6);
    if (subs[i].fin <= subs[i].ini) subs[i].fin = subs[i].ini + 0.25;
  }
  return subs;
}

// -------------------------------------------------------------- dibujar texto
function estiloActual() {
  return {
    fuente: $('fuente').value,
    colorLetra: $('colorLetra').value, colorBorde: $('colorBorde').value,
    colorFondo: $('colorFondo').value,
    usarBorde: $('usarBorde').checked, usarFondo: $('usarFondo').checked,
    transparencia: parseInt($('transparencia').value, 10) / 100,
    tamano: parseInt($('tamano').value, 10),
    altura: parseInt($('altura').value, 10) / 100,
  };
}

function partirEnLineas(ctx, texto, anchoUtil) {
  const palabras = texto.split(' ');
  const lineas = []; let actual = '';
  for (const palabra of palabras) {
    const intento = actual ? actual + ' ' + palabra : palabra;
    if (ctx.measureText(intento).width <= anchoUtil || !actual) actual = intento;
    else { lineas.push(actual); actual = palabra; }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

function dibujarSubtitulo(ctx, ancho, alto, texto, e) {
  if (!texto) return;
  const px = Math.round(alto * (e.tamano / 100));
  ctx.font = `700 ${px}px ${e.fuente}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const margen = ancho * 0.06;
  const lineas = partirEnLineas(ctx, texto, ancho - margen * 2 - px * 0.8);
  const altoLinea = px * 1.25;
  const altoCaja = altoLinea * lineas.length + px * 0.35;
  const anchoCaja = Math.min(ancho - margen,
    Math.max(...lineas.map((l) => ctx.measureText(l).width)) + px * 0.8);
  const arriba = Math.round(alto * e.altura) - altoCaja / 2;

  if (e.usarFondo && e.transparencia > 0) {
    ctx.globalAlpha = e.transparencia;
    ctx.fillStyle = e.colorFondo;
    const x = (ancho - anchoCaja) / 2;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, arriba, anchoCaja, altoCaja, px * 0.2); ctx.fill(); }
    else ctx.fillRect(x, arriba, anchoCaja, altoCaja);
    ctx.globalAlpha = 1;
  }
  ctx.lineWidth = Math.max(2, px * 0.12);
  ctx.strokeStyle = e.colorBorde; ctx.lineJoin = 'round'; ctx.fillStyle = e.colorLetra;
  lineas.forEach((linea, i) => {
    const y = arriba + px * 0.175 + altoLinea * (i + 0.5);
    if (e.usarBorde) ctx.strokeText(linea, ancho / 2, y);
    ctx.fillText(linea, ancho / 2, y);
  });
}

const ALTO_VIDEO_TIPO = 1920;
function pintarMuestra() {
  const c = $('muestra'); const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#23232E'; ctx.fillRect(0, 0, c.width, c.height);
  const escala = c.width / 1080;
  ctx.save(); ctx.scale(escala, escala);
  dibujarSubtitulo(ctx, 1080, ALTO_VIDEO_TIPO, 'Así se van a ver',
    { ...estiloActual(), altura: ((c.height / escala) / 2) / ALTO_VIDEO_TIPO });
  ctx.restore();
}

// ------------------------------------------------- el reproductor de la edición
const R = { tocando: false, mapa: [], dura: 0, subs: [], raf: null, tSalida: 0,
            palabras: [], puntero: 0, ultimoPintado: 0 };

function prepararReproduccion() {
  const { tramos } = limitarSalida(tramosVivos(), MAX_SALIDA);
  R.mapa = []; let acumulado = 0;
  for (const t of tramos) { R.mapa.push({ ini: t.ini, fin: t.fin, desde: acumulado }); acumulado += (t.fin - t.ini); }
  R.dura = acumulado;
  R.subs = armarSubtitulos($('muletillas').checked).filter((s) => s.ini < R.dura);

  // Los tiempos de cada palabra en el resultado, calculados una sola vez.
  // Hacerlo en cada cuadro dejaba la reproducción en 15 cuadros por segundo.
  R.palabras = [];
  T.piezas.forEach((p, i) => {
    if (p.fuera || p.tipo !== 'palabra') return;
    const ini = aSalida(p.ini);
    if (ini === null) return;
    R.palabras.push({ i, ini, fin: ini + (p.fin - p.ini) });
  });
  R.puntero = 0;
  $('relojTotal').textContent = reloj(R.dura / velocidadActual());
  if (R.tSalida > R.dura) R.tSalida = 0;
}

const velocidadActual = () => parseInt($('velocidad').value, 10) / 100;
const reloj = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const textoEn = (t) => { const s = R.subs.find((x) => t >= x.ini && t < x.fin); return s ? s.texto : ''; };

function pintarCuadro() {
  if (!T.video) return;
  const lienzo = $('cuadro'); const ctx = lienzo.getContext('2d');
  try { ctx.drawImage(T.video, 0, 0, lienzo.width, lienzo.height); } catch {}
  const texto = R.mapa.length ? textoEn(R.tSalida) : FRASE_DE_MUESTRA;
  dibujarSubtitulo(ctx, lienzo.width, lienzo.height, texto || FRASE_DE_MUESTRA, estiloActual());
}

function marcarPalabraQueSuena() {
  const lista = R.palabras;
  if (!lista.length) return;
  if (R.puntero >= lista.length || lista[R.puntero].ini > R.tSalida) R.puntero = 0;
  while (R.puntero < lista.length - 1 && lista[R.puntero].fin < R.tSalida) R.puntero++;
  // Entre dos palabras hay un hueco de milésimas. Si ahí se apaga el resaltado,
  // parpadea todo el tiempo: se queda en la última hasta que arranque la siguiente.
  const p = lista[R.puntero];
  const cual = (R.tSalida >= p.ini) ? p.i : (R.puntero > 0 ? lista[R.puntero - 1].i : p.i);

  const antes = document.querySelector('.pal.sonando');
  if (antes && antes.dataset.i != cual) antes.classList.remove('sonando');
  if (cual >= 0) {
    const el = document.querySelector(`.pal[data-i="${cual}"]`);
    if (el && !el.classList.contains('sonando')) {
      el.classList.add('sonando');
      const caja = $('transcripcion');
      const arriba = el.offsetTop - caja.offsetTop;
      if (arriba < caja.scrollTop || arriba > caja.scrollTop + caja.clientHeight - 40) {
        caja.scrollTop = arriba - caja.clientHeight / 2;
      }
    }
  }
}

function refrescarReloj() {
  $('relojVa').textContent = reloj(R.tSalida / velocidadActual());
  $('momento').value = R.dura ? Math.round((R.tSalida / R.dura) * 1000) : 0;
}

function vuelta() {
  if (!R.tocando) return;
  const tOrig = T.video.currentTime;
  let tSal = aSalida(tOrig);
  if (tSal === null) {
    const sig = R.mapa.find((m) => m.ini > tOrig);
    if (!sig) { pausar(); R.tSalida = R.dura; refrescarReloj(); return; }
    T.video.currentTime = sig.ini;
    tSal = sig.desde;
  }
  R.tSalida = tSal;
  if (R.tSalida >= R.dura - 0.05) { pausar(); return; }

  // Como mucho 20 pinturas por segundo. Con un 4K el navegador ya va apretado
  // decodificando, y pintar en cada cuadro le quita el tiempo que necesita.
  const ahora = performance.now();
  if (ahora - R.ultimoPintado > 48) {
    R.ultimoPintado = ahora;
    pintarCuadro(); marcarPalabraQueSuena(); refrescarReloj();
  }
  seguirVuelta();
}

function seguirVuelta() {
  if (!R.tocando) return;
  if (T.video.requestVideoFrameCallback) R.raf = T.video.requestVideoFrameCallback(vuelta);
  else R.raf = requestAnimationFrame(vuelta);
}

function tocar() {
  if (!T.video || !R.mapa.length) return;
  R.tocando = true;
  $('tocar').textContent = '❚❚'; $('tocar').title = 'Pausar';
  T.video.muted = false;
  T.video.playbackRate = velocidadActual();
  T.video.preservesPitch = true;
  const destino = aOriginal(R.tSalida);
  if (Math.abs(T.video.currentTime - destino) > 0.15) T.video.currentTime = destino;
  T.video.play().catch((e) => console.warn('No dejó reproducir:', e));
  seguirVuelta();
}

function pausar() {
  R.tocando = false;
  $('tocar').textContent = '▶'; $('tocar').title = 'Reproducir';
  if (T.video) T.video.pause();
  if (R.raf) {
    if (T.video && T.video.cancelVideoFrameCallback) T.video.cancelVideoFrameCallback(R.raf);
    cancelAnimationFrame(R.raf);
  }
  R.raf = null;
}

async function hayCuadro() {
  if (T.video && T.video.readyState >= 2) return;
  await new Promise((listo) => {
    const fin = () => { T.video.removeEventListener('loadeddata', fin); listo(); };
    T.video.addEventListener('loadeddata', fin);
    setTimeout(listo, 2000);
  });
}

async function irA(tSalida) {
  R.tSalida = Math.max(0, Math.min(tSalida, Math.max(0, R.dura - 0.05)));
  T.video.currentTime = aOriginal(R.tSalida);
  if (!R.tocando) {
    await new Promise((listo) => {
      const fin = () => { T.video.removeEventListener('seeked', fin); listo(); };
      T.video.addEventListener('seeked', fin);
      setTimeout(listo, 800);
    });
    await hayCuadro();
    pintarCuadro(); marcarPalabraQueSuena();
  }
  refrescarReloj();
}

function repintar() {
  if (T.video && $('mesa').style.display !== 'none') {
    prepararReproduccion();
    if (!R.tocando) pintarCuadro();
    if (T.video) T.video.playbackRate = velocidadActual();
  } else pintarMuestra();
}

// --------------------------------------------------- la transcripción editable
function pintarTranscripcion() {
  const caja = $('transcripcion');
  caja.innerHTML = '';
  T.piezas.forEach((p, i) => {
    const s = document.createElement('span');
    s.dataset.i = i;
    if (p.tipo === 'palabra') {
      s.className = 'pal' + (p.fuera ? ' fuera' : '') + (p.texto !== p.original ? ' tocada' : '');
      s.textContent = p.texto;
      s.title = p.texto !== p.original ? `El reconocimiento oyó "${p.original}"` : '';
    } else {
      s.className = 'pal ficha ' + p.tipo + (p.fuera ? ' fuera' : '');
      s.textContent = (p.tipo === 'silencio' ? '␣' : '♪') + seg1(p.fin - p.ini) + 's';
      s.title = p.tipo === 'silencio'
        ? 'Silencio. Está quitado: haz clic para devolverlo.'
        : 'Aquí suena algo que no es una palabra: una muletilla cortada, un carraspeo. Clic para quitarlo.';
    }
    caja.appendChild(s);
    caja.appendChild(document.createTextNode(' '));
  });
  refrescarResumen();
}

function refrescarResumen() {
  const queda = tramosVivos().reduce((a, t) => a + (t.fin - t.ini), 0);
  const fuera = T.duracionEntrada - queda;
  $('duraFinal').textContent = `${seg1(Math.min(queda, MAX_SALIDA))} s`;
  $('duraFuera').textContent = `${seg1(Math.max(0, fuera))} s`;
  avisar(queda > MAX_SALIDA
    ? `Quedan ${queda.toFixed(0)} segundos y un reel son ${MAX_SALIDA}. Se toman los primeros ` +
      `${MAX_SALIDA}: quita algo más desde el texto si quieres elegir qué sale.`
    : '');
}

let piezaBajoElMouse = -1;
$('transcripcion').addEventListener('mouseover', (e) => {
  const s = e.target.closest('.pal');
  if (!s || s.classList.contains('editando')) return;
  piezaBajoElMouse = parseInt(s.dataset.i, 10);
  const lapiz = $('lapiz');
  if (T.piezas[piezaBajoElMouse].tipo !== 'palabra') { lapiz.style.display = 'none'; return; }
  const caja = $('transcripcion');
  lapiz.style.display = 'block';
  lapiz.style.left = (s.offsetLeft + s.offsetWidth - 4) + 'px';
  lapiz.style.top = (s.offsetTop - caja.scrollTop - 12) + 'px';
});
$('transcripcion').closest('.zona-texto').addEventListener('mouseleave', () => {
  $('lapiz').style.display = 'none'; piezaBajoElMouse = -1;
});
$('transcripcion').addEventListener('scroll', () => { $('lapiz').style.display = 'none'; });
$('lapiz').addEventListener('click', (e) => {
  e.stopPropagation();
  if (piezaBajoElMouse < 0) return;
  const s = document.querySelector(`.pal[data-i="${piezaBajoElMouse}"]`);
  if (s) corregirPalabra(s, piezaBajoElMouse);
  $('lapiz').style.display = 'none';
});

// Clic quita o devuelve. El lápiz corrige. Nunca compiten por el mismo gesto.
$('transcripcion').addEventListener('click', (e) => {
  const s = e.target.closest('.pal');
  if (!s || s.classList.contains('editando')) return;
  const i = parseInt(s.dataset.i, 10);
  T.piezas[i].fuera = !T.piezas[i].fuera;
  s.classList.toggle('fuera', T.piezas[i].fuera);
  refrescarResumen();
  repintar();
});

// El doble clic sigue corrigiendo, pero deshace el tachado de su primer clic
$('transcripcion').addEventListener('dblclick', (e) => {
  const s = e.target.closest('.pal');
  if (!s) return;
  const i = parseInt(s.dataset.i, 10);
  if (T.piezas[i].tipo !== 'palabra') return;
  if (T.piezas[i].fuera) {
    T.piezas[i].fuera = false;
    s.classList.remove('fuera');
    refrescarResumen(); repintar();
  }
  corregirPalabra(s, i);
});

function corregirPalabra(s, i) {
  s.classList.add('editando');
  s.contentEditable = 'true';
  s.focus();
  document.execCommand?.('selectAll', false, null);
  const terminar = () => {
    s.contentEditable = 'false';
    s.classList.remove('editando');
    const nuevo = s.textContent.trim();
    T.piezas[i].texto = nuevo || T.piezas[i].original;
    s.textContent = T.piezas[i].texto;
    s.classList.toggle('tocada', T.piezas[i].texto !== T.piezas[i].original);
    s.title = T.piezas[i].texto !== T.piezas[i].original
      ? `El reconocimiento oyó "${T.piezas[i].original}"` : '';
    s.removeEventListener('blur', terminar);
    repintar();
  };
  s.addEventListener('blur', terminar);
  s.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); s.blur(); }
    if (ev.key === 'Escape') { s.textContent = T.piezas[i].texto; s.blur(); }
  });
}

$('devolverTodo').addEventListener('click', () => {
  for (const p of T.piezas) p.fuera = false;
  pintarTranscripcion(); repintar();
});

// ------------------------------------------------------- paso 1: analizar
async function analizar(archivo) {
  mostrar('estado'); avance(0); avisar('');
  T.archivo = archivo;

  paso('Leyendo el video', archivo.name);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(archivo) });
  const pistaVideo = await input.getPrimaryVideoTrack();
  if (!pistaVideo) throw new Error('Ese archivo no tiene video.');

  const duracion = await pistaVideo.computeDuration();
  const anchoOrig = pistaVideo.displayWidth ?? pistaVideo.codedWidth;
  const altoOrig = pistaVideo.displayHeight ?? pistaVideo.codedHeight;
  T.duracionEntrada = Math.min(duracion, MAX_ENTRADA);
  if (duracion > MAX_ENTRADA) {
    avisar(`Tu grabación dura ${Math.round(duracion / 60)} minutos y se toman los primeros ` +
           `${MAX_ENTRADA / 60}. Para material más largo, córtalo antes en pedazos.`);
  }
  const escala = Math.min(1, MAX_LADO_LARGO / Math.max(anchoOrig, altoOrig));
  T.ancho = Math.round(anchoOrig * escala / 2) * 2;
  T.alto = Math.round(altoOrig * escala / 2) * 2;

  const mb = archivo.size / 1024 / 1024;
  const es4k = Math.max(anchoOrig, altoOrig) > 2200;
  if (mb > 150 || es4k) {
    avisar(`Tu video es grande (${Math.round(mb)} MB${es4k ? ', en 4K' : ''}). El análisis se toma ` +
           `unos minutos y la vista previa puede ir a saltos, pero el video que exportes sale bien. ` +
           `Si grabas en 1080 en vez de 4K, todo va mucho más rápido y el reel se ve igual.`);
  }

  paso('Escuchando el audio', 'Buscando dónde hay voz y dónde hay silencio');
  avance(10);
  T.ctxAudio = new AudioContext();
  T.bufferOriginal = await T.ctxAudio.decodeAudioData(await archivo.arrayBuffer());
  T.energia = medirEnergia(T.bufferOriginal);
  const tramosVoz = tramosConVoz(T.energia, T.duracionEntrada);
  avance(26);

  let palabras = [];
  try {
    const reconocer = await cargarTranscriptor();
    paso('Reconociendo lo que dices', 'Esto pasa dentro de tu computador');
    avance(38);
    const sinSilencios = audioRecortado(T.ctxAudio, T.bufferOriginal, tramosVoz);
    const salida = await reconocer(await a16k(sinSilencios), {
      language: 'spanish', task: 'transcribe', return_timestamps: 'word',
      chunk_length_s: 30, stride_length_s: 5,
    });
    palabras = (salida.chunks || [])
      .filter((c) => (c.text || '').trim() && c.timestamp && c.timestamp[0] !== null)
      .map((c) => ({ texto: c.text.trim(), ini: c.timestamp[0], fin: c.timestamp[1] ?? c.timestamp[0] + 0.3 }));
  } catch (e) {
    console.error('No se pudo reconocer la voz:', e);
    avisar('No se pudo reconocer la voz, así que no hay texto para editar. ' +
           'Suele ser falta de internet la primera vez, que es cuando baja el modelo.');
  }
  avance(82);

  T.piezas = armarPiezas(tramosVoz, palabras);
  if (!$('cortar').checked) for (const p of T.piezas) if (p.tipo === 'silencio') p.fuera = false;
  let repetidas = 0;
  if ($('repetidas').checked && palabras.length) repetidas = marcarTomasRepetidas();
  $('avisoRepetidas').textContent = repetidas
    ? `${repetidas} ${repetidas === 1 ? 'toma repetida marcada' : 'tomas repetidas marcadas'}` : '';
  $('avisoRepetidas').style.color = repetidas ? 'var(--amarillo)' : '';

  if (T.video) URL.revokeObjectURL(T.video.src);
  T.video = document.createElement('video');
  T.video.muted = true; T.video.playsInline = true; T.video.preload = 'auto';
  T.video.src = URL.createObjectURL(archivo);
  await new Promise((listo, falla) => {
    T.video.onloadedmetadata = listo;
    T.video.onerror = () => falla(new Error('No se pudo abrir ese video.'));
  });
  // La vista previa se pinta más chica que el original. Con un 4K, dibujar
  // 3840x2160 en cada cuadro deja la reproducción a tirones.
  const esc = Math.min(1, MAX_PREVIA / Math.max(T.video.videoWidth, T.video.videoHeight));
  $('cuadro').width = Math.round(T.video.videoWidth * esc);
  $('cuadro').height = Math.round(T.video.videoHeight * esc);

  avance(100);
  mostrar('mesa');
  pintarTranscripcion();
  R.tSalida = 0;
  prepararReproduccion();
  await irA(0);
  console.log('ANALISIS ' + JSON.stringify({
    piezas: T.piezas.length,
    palabras: T.piezas.filter((p) => p.tipo === 'palabra').length,
    sonidos: T.piezas.filter((p) => p.tipo === 'sonido').length,
    silencios: T.piezas.filter((p) => p.tipo === 'silencio').length,
    repetidas, previa: $('cuadro').width + 'x' + $('cuadro').height,
  }));
}

// --------------------------------------------------------- paso 2: exportar
async function generar() {
  pausar();
  mostrar('estado'); avance(0);
  const t0 = performance.now();

  const { tramos, sobraron } = limitarSalida(tramosVivos(), MAX_SALIDA);
  const dura = tramos.reduce((a, t) => a + (t.fin - t.ini), 0);
  const bufferCortado = audioRecortado(T.ctxAudio, T.bufferOriginal, tramos);
  const subtitulos = R.subs;

  paso('Montando el video', `${subtitulos.length} subtítulos sobre ${dura.toFixed(1)} s`);
  console.log('GENERAR ' + JSON.stringify({
    tramos: tramos.length, dura: +dura.toFixed(2), sobraron: +sobraron.toFixed(2),
    subtitulos: subtitulos.length,
  }));

  const velocidad = velocidadActual();
  const lienzo = document.createElement('canvas');
  lienzo.width = T.ancho; lienzo.height = T.alto;
  const ctx = lienzo.getContext('2d', { alpha: false });

  const salida = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const fuenteVideo = new CanvasSource(lienzo, { codec: 'avc', quality: new Quality({ bitrate: 5e6 }) });
  salida.addVideoTrack(fuenteVideo, { frameRate: FPS });
  const fuenteAudio = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: 128e3 }) });
  salida.addAudioTrack(fuenteAudio);
  await salida.start();

  const estilo = estiloActual();
  const desfase = []; let acumulado = 0;
  for (const t of tramos) { desfase.push(t.ini - acumulado); acumulado += (t.fin - t.ini); }
  const enTramo = (t) => tramos.findIndex((tr) => t >= tr.ini && t < tr.fin);

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(T.archivo) });
  const sink = new VideoSampleSink(await input.getPrimaryVideoTrack());
  let escritos = 0, proximoCuadro = 0;

  for await (const muestra of sink.samples()) {
    const t = muestra.timestamp;
    if (t >= T.duracionEntrada) { muestra.close(); break; }
    const i = enTramo(t);
    if (i === -1) { muestra.close(); continue; }
    const nuevoT = t - desfase[i];
    const tFinal = nuevoT / velocidad;

    // Al acelerar hay que SALTARSE cuadros, no apretarlos todos en menos tiempo.
    // Escribiéndolos todos, un video a 1.5x quedaba a 36 cuadros por segundo: pesa
    // más y no se ve mejor. Pero comparar contra el último escrito descarta de más
    // y lo dejaba en 18. Lo que funciona es marcar el PRÓXIMO tiempo que toca y
    // escribir el primer cuadro que lo alcance: así salen 30 justos.
    if (tFinal + 0.0005 < proximoCuadro) { muestra.close(); continue; }
    proximoCuadro = Math.max(proximoCuadro + 1 / FPS, tFinal);

    muestra.draw(ctx, 0, 0, T.ancho, T.alto);
    dibujarSubtitulo(ctx, T.ancho, T.alto, textoEn(nuevoT), estilo);
    await fuenteVideo.add(tFinal, 1 / FPS);
    muestra.close();
    escritos++;
    if (escritos % 24 === 0) { avance((nuevoT / dura) * 92); await new Promise((r) => setTimeout(r, 0)); }
  }

  paso('Cerrando el archivo');
  let audioFinal = acelerarSinCambiarLaVoz(T.ctxAudio, bufferCortado, velocidad);
  if ($('emparejar').checked) audioFinal = emparejarVolumen(T.ctxAudio, audioFinal);
  await fuenteAudio.add(audioFinal);
  fuenteVideo.close(); fuenteAudio.close();
  await salida.finalize();

  const blob = new Blob([salida.target.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  avance(100);
  $('resultado').src = url;
  $('bajar').href = url;
  $('bajar').download = T.archivo.name.replace(/\.[^.]+$/, '') + ' - editado.mp4';
  mostrar('listo');
  console.log(`Listo en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// Empareja el volumen del audio que sale.
//
// Un video grabado con el celular suele tener los picos al tope pero la voz floja
// de promedio, y eso se oye "bajito" aunque el número de pico diga lo contrario.
// Esto sube el nivel promedio hasta el que usan las redes y frena los picos con una
// curva suave, que aprieta en vez de recortar y por eso no suena a distorsión.
// Es lo mismo que ya hace el motor de edición en Python (nivel parejo).
const RMS_OBJETIVO = 0.126;   // unos -18 dB, que es donde la voz se oye pareja
const TECHO = 0.97;

function emparejarVolumen(ctx, buffer) {
  const canales = buffer.numberOfChannels;
  let suma = 0, muestras = 0;
  for (let c = 0; c < canales; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 7) { suma += d[i] * d[i]; muestras++; }
  }
  const rms = Math.sqrt(suma / Math.max(muestras, 1));
  if (rms < 1e-5) return buffer;

  // Nunca se baja el volumen ni se sube más de 4 veces: subir de más levanta el
  // ruido de fondo y el aire acondicionado empieza a oírse tanto como la voz.
  const ganancia = Math.min(Math.max(RMS_OBJETIVO / rms, 1), 4);
  if (ganancia <= 1.02) return buffer;

  const salida = ctx.createBuffer(canales, buffer.length, buffer.sampleRate);
  for (let c = 0; c < canales; c++) {
    const src = buffer.getChannelData(c);
    const dst = salida.getChannelData(c);
    for (let i = 0; i < src.length; i++) {
      const v = src[i] * ganancia;
      // Curva suave solo cerca del techo: lo que no llega al techo no se toca
      dst[i] = Math.abs(v) < TECHO * 0.8 ? v : Math.sign(v) * (TECHO * Math.tanh(Math.abs(v) / TECHO));
    }
  }
  console.log(`VOLUMEN rms ${rms.toFixed(4)} -> ganancia ${ganancia.toFixed(2)}x`);
  return salida;
}

// Acelera el audio SIN subirle el tono a la voz (estira el tiempo, no remuestrea)
function acelerarSinCambiarLaVoz(ctx, buffer, factor) {
  if (factor === 1) return buffer;
  const sr = buffer.sampleRate, canales = buffer.numberOfChannels;
  const ventana = Math.round(sr * 0.045), mitad = Math.round(ventana / 2);
  const avanceEntrada = Math.round(mitad * factor), busqueda = Math.round(sr * 0.008);
  const hann = new Float32Array(ventana);
  for (let i = 0; i < ventana; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ventana - 1));

  const largoSalida = Math.ceil(buffer.length / factor) + ventana;
  const salida = ctx.createBuffer(canales, largoSalida, sr);
  const guia = buffer.getChannelData(0);
  const destinos = [];
  for (let c = 0; c < canales; c++) destinos.push(salida.getChannelData(c));

  let posEntrada = 0, posSalida = 0, escrito = 0;
  while (posEntrada + ventana + busqueda < buffer.length && posSalida + ventana < largoSalida) {
    let mejor = 0;
    if (posSalida > mitad) {
      let mejorPuntaje = -Infinity;
      for (let d = -busqueda; d <= busqueda; d++) {
        const desde = posEntrada + d;
        if (desde < 0 || desde + mitad >= buffer.length) continue;
        let puntaje = 0;
        for (let i = 0; i < mitad; i += 4) puntaje += guia[desde + i] * destinos[0][posSalida + i];
        if (puntaje > mejorPuntaje) { mejorPuntaje = puntaje; mejor = d; }
      }
    }
    const desde = Math.max(0, posEntrada + mejor);
    for (let c = 0; c < canales; c++) {
      const src = buffer.getChannelData(Math.min(c, canales - 1));
      const dst = destinos[c];
      for (let i = 0; i < ventana; i++) {
        if (desde + i >= src.length || posSalida + i >= largoSalida) break;
        dst[posSalida + i] += src[desde + i] * hann[i];
      }
    }
    escrito = Math.min(largoSalida, posSalida + ventana);
    posSalida += mitad; posEntrada += avanceEntrada;
  }
  const recortado = ctx.createBuffer(canales, Math.max(escrito, 1), sr);
  for (let c = 0; c < canales; c++) recortado.getChannelData(c).set(destinos[c].subarray(0, escrito));
  return recortado;
}

// ------------------------------------------------------------------ interfaz
// Son 282 MB la primera vez, y se bajan una sola vez en la vida de ese navegador.
// Se empiezan a traer en cuanto alguien toca la zona de soltar: para cuando elija
// su video en el explorador de archivos, ya va adelantado. Antes se esperaba a
// tener el video, así que la persona veía la barra quieta sin saber por qué.
let yaPrecargando = false;
function precargarReconocimiento() {
  if (yaPrecargando) return;
  yaPrecargando = true;
  cargarTranscriptor().catch((e) => console.warn('Precarga del reconocimiento:', e));
}
$('zona').addEventListener('mouseenter', precargarReconocimiento, { once: true });
$('zona').addEventListener('touchstart', precargarReconocimiento, { once: true, passive: true });

$('zona').addEventListener('click', () => { precargarReconocimiento(); $('archivo').click(); });
$('zona').addEventListener('dragover', (e) => { e.preventDefault(); $('zona').classList.add('encima'); });
$('zona').addEventListener('dragleave', () => $('zona').classList.remove('encima'));
$('zona').addEventListener('drop', (e) => {
  e.preventDefault(); $('zona').classList.remove('encima');
  if (e.dataTransfer.files[0]) empezar(e.dataTransfer.files[0]);
});
$('archivo').addEventListener('change', (e) => { if (e.target.files[0]) empezar(e.target.files[0]); });

$('editar').addEventListener('click', async () => {
  try { await generar(); }
  catch (e) { console.error(e); avisar('No se pudo exportar: ' + (e && e.message ? e.message : e)); mostrar('mesa'); }
});
$('cambiar').addEventListener('click', () => { pausar(); $('archivo').value = ''; avisar(''); mostrar('zona'); });
$('otro').addEventListener('click', () => { pausar(); $('archivo').value = ''; avisar(''); mostrar('zona'); });
$('volver').addEventListener('click', () => { mostrar('mesa'); repintar(); });
$('tocar').addEventListener('click', () => (R.tocando ? pausar() : tocar()));
$('momento').addEventListener('input', (e) => irA((parseInt(e.target.value, 10) / 1000) * R.dura));
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  if (document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (document.querySelector('.pal.editando')) return;
  if ($('mesa').style.display === 'none') return;
  e.preventDefault();
  R.tocando ? pausar() : tocar();
});

async function empezar(archivo) {
  if (!navegadorSirve()) return;
  try { await analizar(archivo); }
  catch (e) { console.error(e); avisar('No se pudo abrir el video: ' + (e && e.message ? e.message : e)); mostrar('zona'); }
}

for (const [control, destino, sufijo] of [
  ['transparencia', 'valorTransp', '%'], ['tamano', 'valorTamano', ''], ['altura', 'valorAltura', '%'],
]) {
  $(control).addEventListener('input', (e) => { $(destino).textContent = e.target.value + sufijo; repintar(); });
}
$('velocidad').addEventListener('input', (e) => {
  $('valorVel').textContent = (parseInt(e.target.value, 10) / 100).toFixed(2).replace(/0$/, '') + 'x';
  if (T.video) T.video.playbackRate = velocidadActual();
  $('relojTotal').textContent = reloj(R.dura / velocidadActual());
  refrescarReloj();
});
$('fuente').addEventListener('input', repintar);
$('muletillas').addEventListener('change', repintar);
$('cortar').addEventListener('change', () => {
  if (!T.piezas.length) return;
  for (const p of T.piezas) if (p.tipo === 'silencio') p.fuera = $('cortar').checked;
  pintarTranscripcion(); repintar();
});

const CAMPOS_COLOR = ['Letra', 'Borde', 'Fondo'];
let campoActivo = 'Fondo';
function normalizarCodigo(texto) {
  let t = String(texto).trim().replace(/^#/, '').toUpperCase();
  if (/^[0-9A-F]{3}$/.test(t)) t = t.split('').map((c) => c + c).join('');
  return /^[0-9A-F]{6}$/.test(t) ? '#' + t : null;
}
for (const campo of CAMPOS_COLOR) {
  const paleta = $('color' + campo), codigo = $('codigo' + campo);
  paleta.addEventListener('input', () => { codigo.value = paleta.value.toUpperCase(); codigo.classList.remove('malo'); repintar(); });
  codigo.addEventListener('input', () => {
    const bueno = normalizarCodigo(codigo.value);
    codigo.classList.toggle('malo', !bueno && codigo.value.trim() !== '');
    if (bueno) { paleta.value = bueno; repintar(); }
  });
  codigo.addEventListener('blur', () => {
    const bueno = normalizarCodigo(codigo.value);
    codigo.value = bueno || paleta.value.toUpperCase();
    codigo.classList.remove('malo'); repintar();
  });
  codigo.addEventListener('keydown', (e) => { if (e.key === 'Enter') codigo.blur(); });
  for (const el of [paleta, codigo]) {
    el.addEventListener('focus', () => marcarActivo(campo));
    el.addEventListener('click', () => marcarActivo(campo));
  }
}
function marcarActivo(campo) {
  campoActivo = campo;
  document.querySelectorAll('.color').forEach((fila, i) => fila.classList.toggle('activa', CAMPOS_COLOR[i] === campo));
}
document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const color = chip.dataset.color;
    $('color' + campoActivo).value = color;
    $('codigo' + campoActivo).value = color.toUpperCase();
    $('codigo' + campoActivo).classList.remove('malo');
    repintar();
  });
});
marcarActivo('Fondo');

function refrescarApagados() {
  const filas = document.querySelectorAll('.color');
  filas[1].classList.toggle('apagada', !$('usarBorde').checked);
  filas[2].classList.toggle('apagada', !$('usarFondo').checked);
  const sinFondo = !$('usarFondo').checked;
  $('transparencia').disabled = sinFondo;
  $('etiquetaTransp').classList.toggle('apagado', sinFondo);
  repintar();
}
$('usarBorde').addEventListener('change', refrescarApagados);
$('usarFondo').addEventListener('change', refrescarApagados);

navegadorSirve();
refrescarApagados();
document.fonts.ready.then(() => repintar());

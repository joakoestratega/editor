// Version liviana de feria: solo quita los silencios.
//
// POR QUE EXISTE: el editor completo baja un modelo de voz de 286 a 932 MB la
// primera vez. Con el wifi de una feria (3 Mbps) son 15 a 44 minutos. Esta
// version no usa modelo: mide la energia del audio y corta donde no hay voz.
// Pesa lo que pesa la libreria de video, y funciona en el celular en segundos.
//
// Las funciones del audio son COPIA de editor.js (ya medidas y probadas).
// Si se cambian alla, se revisan aqui. No se importan a proposito: editor.js
// arranca todo el editor al cargarse.
//
// Nada sale del aparato: no hay servidor, no hay subida, no se cuenta uso.

import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, AudioBufferSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from './lib/mediabunny.min.mjs';

// ------------------------------------------------------------------- ajustes
const MAX_ENTRADA = 300;       // 5 minutos de material crudo
const MAX_SALIDA = 90;         // el reel terminado
const MAX_LADO_LARGO = 1920;   // el 4K del celular se baja a 1080p
const FPS = 30;

const VENTANA = 0.02;          // 20 ms: el grano con que se mide el audio
const SOBRE_EL_RUIDO = 2.0;    // 6 dB encima del ruido de fondo
const BAJO_LA_VOZ = 0.126;     // 18 dB por debajo del nivel normal de la voz
const MIN_SILENCIO = 0.18;     // desde 180 ms de hueco ya se corta
const COLCHON = 0.06;          // el aire que se deja a cada lado, 60 ms
// En el editor el corte se mueve hasta 0,20 s porque ahi los bordes vienen de las
// palabras, que son aproximadas. Aqui los bordes ya vienen de la energia: moverlos
// 0,20 s solo los empuja hacia el silencio y devuelve lo que se quito (medido:
// 64 s quedaban en 60,6). Se busca el valle solo dentro del aire que se deja.
const BUSCAR_VALLE = COLCHON;

const $ = (id) => document.getElementById(id);
const T = { archivo: null, energia: null, buffer: null, duracion: 0, ancho: 0, alto: 0, url: null };

const reloj = (s) => {
  const t = Math.max(0, Math.round(s));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
};

// ------------------------------------------------------------------ pantallas
function mostrar(cual) {
  for (const id of ['inicio', 'trabajando', 'listo', 'nada']) $(id).hidden = id !== cual;
  window.scrollTo(0, 0);
}
function paso(texto) { $('paso').textContent = texto; }
function avance(p) {
  const v = Math.max(0, Math.min(100, p));
  $('barra').style.width = v + '%';
  $('porcentaje').textContent = Math.round(v) + '%';
}
function avisar(texto) {
  $('aviso').textContent = texto || '';
  $('aviso').hidden = !texto;
}

function navegadorSirve() {
  const falta = [];
  if (typeof VideoDecoder === 'undefined' || typeof VideoEncoder === 'undefined') falta.push('video');
  // AudioDecoder no se exige: si falta, el audio se lee con decodeAudioData
  if (typeof AudioEncoder === 'undefined') falta.push('audio');
  return falta;
}

// ----------------------------------------------------------------- el audio
// COPIA de editor.js
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

// COPIA de editor.js. Percentil 90, NO el 99: un golpe corto en el micro sube
// el 99 entre 20 y 40 dB y el umbral quedaba por encima de toda la voz.
function umbralDeVoz(energia) {
  const orden = Array.from(energia).sort((a, b) => a - b);
  const piso = orden[Math.floor(orden.length * 0.10)] || 0;
  const nivelVoz = orden[Math.min(orden.length - 1, Math.floor(orden.length * 0.90))] || 0;
  return Math.max(piso * SOBRE_EL_RUIDO, nivelVoz * BAJO_LA_VOZ);
}

// COPIA de editor.js
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

// COPIA de editor.js: mueve un corte al hueco de audio mas cercano
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

// Igual que tramosVivos() del editor: cada borde cae en su valle, y lo que
// quede montado despues de moverse se une.
function tramosAlValle(tramos) {
  const movidos = tramos.map((t) => {
    const ini = Math.max(0, alValle(t.ini));
    const fin = Math.min(T.duracion, alValle(t.fin));
    return fin - ini > 0.05 ? { ini, fin } : t;
  });
  const unidos = [];
  for (const t of movidos) {
    const ult = unidos[unidos.length - 1];
    if (ult && t.ini - ult.fin < 0.02) ult.fin = Math.max(ult.fin, t.fin);
    else unidos.push({ ...t });
  }
  return unidos;
}

// COPIA de editor.js
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

// COPIA de editor.js (con new AudioBuffer: aqui no hace falta un AudioContext)
function audioRecortado(original, tramos) {
  const sr = original.sampleRate;
  const canales = Math.min(original.numberOfChannels, 2);
  const total = tramos.reduce((a, t) => a + Math.round((t.fin - t.ini) * sr), 0);
  const salida = new AudioBuffer({ numberOfChannels: canales, length: Math.max(total, 1), sampleRate: sr });
  for (let c = 0; c < canales; c++) {
    const dst = salida.getChannelData(c);
    const src = original.getChannelData(Math.min(c, original.numberOfChannels - 1));
    let pos = 0;
    for (const t of tramos) {
      const a = Math.round(t.ini * sr), b = Math.round(t.fin * sr);
      const trozo = src.subarray(a, Math.min(b, src.length));
      if (pos + trozo.length > dst.length) break;
      dst.set(trozo, pos);
      pos += b - a;
    }
  }
  return salida;
}

// COPIA de editor.js: sube el promedio de la voz y frena los picos con curva suave
const RMS_OBJETIVO = 0.126;
const TECHO = 0.97;
function emparejarVolumen(buffer) {
  const canales = buffer.numberOfChannels;
  let suma = 0, muestras = 0;
  for (let c = 0; c < canales; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i += 7) { suma += d[i] * d[i]; muestras++; }
  }
  const rms = Math.sqrt(suma / Math.max(muestras, 1));
  if (rms < 1e-5) return buffer;
  const ganancia = Math.min(Math.max(RMS_OBJETIVO / rms, 1), 4);
  if (ganancia <= 1.02) return buffer;
  const salida = new AudioBuffer({ numberOfChannels: canales, length: buffer.length, sampleRate: buffer.sampleRate });
  for (let c = 0; c < canales; c++) {
    const src = buffer.getChannelData(c);
    const dst = salida.getChannelData(c);
    for (let i = 0; i < src.length; i++) {
      const v = src[i] * ganancia;
      dst[i] = Math.abs(v) < TECHO * 0.8 ? v : Math.sign(v) * (TECHO * Math.tanh(Math.abs(v) / TECHO));
    }
  }
  return salida;
}

// Lee SOLO la pista de audio, por pedazos. El editor completo carga el archivo
// entero en memoria para decodificarlo; en un celular con un video de 300 MB
// eso puede cerrar la pestaña. Si esta via falla, se usa la del editor.
async function leerAudio(input, hasta) {
  const pista = await input.getPrimaryAudioTrack();
  if (!pista) return null;
  try {
    const sink = new AudioBufferSink(pista);
    let destino = null, canales = 1, sr = 0;
    for await (const { buffer, timestamp } of sink.buffers(0, hasta)) {
      if (!destino) {
        sr = buffer.sampleRate;
        canales = Math.min(2, buffer.numberOfChannels);
        destino = new AudioBuffer({ numberOfChannels: canales, length: Math.ceil(hasta * sr) + sr, sampleRate: sr });
      }
      const desde = Math.round(Math.max(0, timestamp) * sr);
      if (desde >= destino.length) break;
      for (let c = 0; c < canales; c++) {
        const src = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
        destino.getChannelData(c).set(src.subarray(0, destino.length - desde), desde);
      }
      avance(2 + Math.min(1, timestamp / hasta) * 18);
    }
    if (destino) return destino;
  } catch (e) {
    console.warn('Lectura por pedazos fallo, se usa la del editor:', e);
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const b = await ctx.decodeAudioData(await T.archivo.arrayBuffer());
    ctx.close?.();
    return b && b.length ? b : null;
  } catch (e) {
    console.warn('Ese video no trae audio que se pueda leer:', e);
    return null;
  }
}

// ------------------------------------------------------------- el trabajo
async function quitarSilencios(archivo) {
  const t0 = performance.now();
  T.archivo = archivo;
  avisar('');
  mostrar('trabajando');
  paso('Quitando los silencios');
  avance(1);

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(archivo) });
  const pistaVideo = await input.getPrimaryVideoTrack();
  if (!pistaVideo) throw new Error('Ese archivo no es un video.');

  const duracion = await pistaVideo.computeDuration();
  T.duracion = Math.min(duracion, MAX_ENTRADA);
  const anchoOrig = pistaVideo.displayWidth ?? pistaVideo.codedWidth;
  const altoOrig = pistaVideo.displayHeight ?? pistaVideo.codedHeight;
  const escala = Math.min(1, MAX_LADO_LARGO / Math.max(anchoOrig, altoOrig));
  T.ancho = Math.round(anchoOrig * escala / 2) * 2;
  T.alto = Math.round(altoOrig * escala / 2) * 2;

  T.buffer = await leerAudio(input, T.duracion);
  if (!T.buffer) {
    console.log('RAPIDO ' + JSON.stringify({ sinAudio: true, segundos: +((performance.now() - t0) / 1000).toFixed(2) }));
    return nada('Este video no trae sonido', 'Sin sonido no hay silencios que quitar. Prueba con un video donde hables.');
  }
  avance(20);

  T.energia = medirEnergia(T.buffer);
  const conVoz = tramosAlValle(tramosConVoz(T.energia, T.duracion));
  const { tramos, sobraron } = limitarSalida(conVoz, MAX_SALIDA);
  const dura = tramos.reduce((a, t) => a + (t.fin - t.ini), 0);

  if (T.duracion - dura < 0.5 && sobraron < 0.5) {
    console.log('RAPIDO ' + JSON.stringify({ sinSilencios: true, antes: T.duracion, despues: dura }));
    return nada('Tu video ya va sin pausas', 'No encontramos silencios que valga la pena quitar.');
  }

  // Codecs que este aparato SI sabe escribir. En el iPhone y en Android no siempre
  // son los mismos; se pregunta en vez de suponer.
  const codecVideo = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: T.ancho, height: T.alto });
  const codecAudio = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: T.buffer.numberOfChannels, sampleRate: T.buffer.sampleRate });
  if (!codecVideo || !codecAudio) {
    throw new Error('Este navegador no sabe guardar video. Ábrelo en Chrome o Safari actualizados.');
  }

  const lienzo = document.createElement('canvas');
  lienzo.width = T.ancho; lienzo.height = T.alto;
  const ctx = lienzo.getContext('2d', { alpha: false });

  const salida = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  // 5 Mbps es para 1080x1920. Un video mas chico con esa tasa pesa el triple sin
  // verse mejor, y en el celular eso es espacio y datos al compartirlo.
  const bitrate = Math.round(Math.max(1.5e6, 5e6 * (T.ancho * T.alto) / (1080 * 1920)));
  const fuenteVideo = new CanvasSource(lienzo, { codec: codecVideo, quality: new Quality({ bitrate }) });
  salida.addVideoTrack(fuenteVideo, { frameRate: FPS });
  const fuenteAudio = new AudioBufferSource({ codec: codecAudio, quality: new Quality({ bitrate: 128e3 }) });
  salida.addAudioTrack(fuenteAudio);
  await salida.start();

  const desfase = []; let acumulado = 0;
  for (const t of tramos) { desfase.push(t.ini - acumulado); acumulado += (t.fin - t.ini); }
  const ultimoFin = tramos[tramos.length - 1].fin;
  let k = 0;   // los cuadros llegan en orden: el tramo actual solo avanza

  const sink = new VideoSampleSink(pistaVideo);
  let escritos = 0, proximoCuadro = 0;
  for await (const muestra of sink.samples(tramos[0].ini, ultimoFin)) {
    const t = muestra.timestamp;
    if (t >= ultimoFin) { muestra.close(); break; }
    while (k < tramos.length && t >= tramos[k].fin) k++;
    if (k >= tramos.length || t < tramos[k].ini) { muestra.close(); continue; }
    const tFinal = t - desfase[k];
    // COPIA de editor.js: se marca el PROXIMO tiempo que toca, asi salen 30 cuadros justos
    if (tFinal + 0.0005 < proximoCuadro) { muestra.close(); continue; }
    proximoCuadro = Math.max(proximoCuadro + 1 / FPS, tFinal);
    muestra.draw(ctx, 0, 0, T.ancho, T.alto);
    await fuenteVideo.add(tFinal, 1 / FPS);
    muestra.close();
    escritos++;
    if (escritos % 15 === 0) { avance(22 + (tFinal / dura) * 73); await new Promise((r) => setTimeout(r, 0)); }
  }

  paso('Guardando tu video');
  avance(96);
  await fuenteAudio.add(emparejarVolumen(audioRecortado(T.buffer, tramos)));
  fuenteVideo.close(); fuenteAudio.close();
  await salida.finalize();
  T.buffer = null; T.energia = null;

  const blob = new Blob([salida.target.buffer], { type: 'video/mp4' });
  if (T.url) URL.revokeObjectURL(T.url);
  T.url = URL.createObjectURL(blob);
  const nombre = archivo.name.replace(/\.[^.]+$/, '') + ' - sin silencios.mp4';
  T.salida = new File([blob], nombre, { type: 'video/mp4' });
  avance(100);

  const segundos = (performance.now() - t0) / 1000;
  console.log('RAPIDO ' + JSON.stringify({
    antes: +T.duracion.toFixed(2), despues: +dura.toFixed(2), tramos: tramos.length,
    sobraron: +sobraron.toFixed(2), cuadros: escritos, codecVideo, codecAudio,
    mb: +(blob.size / 1048576).toFixed(2), segundos: +segundos.toFixed(2),
  }));

  $('antes').textContent = reloj(T.duracion);
  $('despues').textContent = reloj(dura);
  const menos = Math.round(T.duracion - dura);
  $('ahorro').textContent = menos >= 1 ? `${menos} segundos menos de silencio` : '';
  if (sobraron > 0.5) avisar(`Sin silencios quedaba de ${reloj(dura + sobraron)}. Un reel va hasta 1:30, así que guardamos el primer minuto y medio.`);
  else if (duracion > MAX_ENTRADA) avisar('Tu grabación pasa de 5 minutos. Tomamos los primeros 5.');
  $('resultado').src = T.url;
  $('bajar').href = T.url;
  $('bajar').download = nombre;
  mostrar('listo');
}

function nada(titulo, texto) {
  $('nadaTitulo').textContent = titulo;
  $('nadaTexto').textContent = texto;
  mostrar('nada');
}

// ------------------------------------------------------------------ interfaz
function empezar(archivo) {
  if (!archivo) return;
  if (archivo.type && !archivo.type.startsWith('video/')) {
    avisar('Eso no es un video. Elige un video de tu galería.');
    return;
  }
  quitarSilencios(archivo).catch((e) => {
    console.error(e);
    mostrar('inicio');
    avisar('No pudimos con ese video. ' + (e && e.message ? e.message : ''));
  });
}

function otraVez() {
  $('archivo').value = '';
  $('resultado').removeAttribute('src');
  $('resultado').load();
  avisar('');
  mostrar('inicio');
}

// En el celular, "Descargar" abre el menú de compartir: desde ahí el iPhone lo
// guarda en Fotos, que es donde la persona lo va a buscar. En el computador,
// descarga normal.
$('bajar').addEventListener('click', async (e) => {
  const tactil = matchMedia('(pointer: coarse)').matches;
  if (!tactil || !T.salida || !navigator.canShare || !navigator.canShare({ files: [T.salida] })) return;
  e.preventDefault();
  try { await navigator.share({ files: [T.salida] }); }
  catch (err) {
    if (err && err.name === 'AbortError') return;
    const a = document.createElement('a');
    a.href = T.url; a.download = T.salida.name; a.click();
  }
});

const zona = $('zona');
zona.addEventListener('click', () => $('archivo').click());
zona.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('archivo').click(); } });
zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('encima'); });
zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
zona.addEventListener('drop', (e) => {
  e.preventDefault(); zona.classList.remove('encima');
  empezar(e.dataTransfer.files[0]);
});
$('archivo').addEventListener('change', (e) => empezar(e.target.files[0]));
$('otro').addEventListener('click', otraVez);
$('otroNada').addEventListener('click', otraVez);

const falta = navegadorSirve();
if (falta.length) {
  zona.classList.add('apagada');
  $('archivo').disabled = true;
  avisar('Este navegador no puede editar video. Ábrelo en Chrome (Android) o Safari actualizado (iPhone).');
}

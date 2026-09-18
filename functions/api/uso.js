// Cuenta CÓMO se usa el editor. No quién: cómo.
//
// Esto no lleva nombre, ni correo, ni teléfono, ni la dirección de internet, ni
// el nombre del archivo, ni una letra de lo que la persona dijo en su video.
// Lleva un número al azar que se queda en ese navegador para poder distinguir
// "una persona que abrió diez veces" de "diez personas". Nada más.
//
// Con esto se contesta lo que de verdad hace falta para mejorar el editor:
// cuántos lo abren, cuántos sueltan un video, cuántos llegan a exportar,
// dónde se caen, qué opciones usan y con qué videos falla.

const ORIGENES = [
  'https://joakoestratega.com',
  'https://editor-9qb.pages.dev',
  'https://dev.editor-9qb.pages.dev',
  'http://127.0.0.1:8899',
];

// Solo estos momentos, y ninguno más. Cualquier otra cosa se descarta.
const MOMENTOS = ['abrio', 'solto', 'analizo', 'exporto', 'fallo', 'idea', 'servicios', 'puerta', 'entra', 'tutorial'];

const cabeceras = (origen) => ({
  'Access-Control-Allow-Origin': ORIGENES.includes(origen) ? origen : ORIGENES[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  // La respuesta cambia segun quien pide: que ninguna cache la mezcle
  'Vary': 'Origin',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
});

// Un numero se guarda como numero, y con tope. Asi nadie mete texto por aqui.
const numero = (v, tope) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(Math.round(n), tope)) : 0;
};
// Los dos puntos se dejan pasar: sirven para "tono:cine" y "estilo:karaoke".
const corto = (v, tope) =>
  typeof v === 'string' ? v.replace(/[^\w .,:+-]/g, '').slice(0, tope) : '';

// Tope por direccion de internet, contado en la base (atomico). Medido el
// 2026-09-16: con KV entraban 135 de 135 envios en rafaga, porque KV solo acepta
// una escritura por segundo por llave. La IP no se guarda: solo su huella.
async function pasaElTope(entorno, peticion, tipo, porHora) {
  try {
    const ip = peticion.headers.get('CF-Connecting-IP') || 'sin-ip';
    const hora = new Date().toISOString().slice(0, 13);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${tipo}|${hora}|${ip}`));
    const huella = [...new Uint8Array(bytes)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
    const fila = await entorno.editor_ideas.prepare(
      `INSERT INTO topes (llave, hora, n) VALUES (?, ?, 1)
       ON CONFLICT(llave) DO UPDATE SET n = n + 1 RETURNING n`
    ).bind(huella, hora).first();
    // De vez en cuando se barre lo de horas anteriores. Va aparte: si el barrido
    // falla, NO puede hacer que se salte el tope ya contado ([SEG] ciclo 2).
    if (Math.random() < 0.02) {
      try { await entorno.editor_ideas.prepare('DELETE FROM topes WHERE hora < ?').bind(hora).run(); } catch {}
    }
    return !fila || fila.n <= porHora;
  } catch {
    // Si el tope falla, se deja pasar: no puede ser la razon de que nadie escriba
    return true;
  }
}

export async function onRequest(contexto) {
  const peticion = contexto.request;
  const entorno = contexto.env;
  const origen = peticion.headers.get('Origin') || '';
  const cab = cabeceras(origen);

  if (peticion.method === 'OPTIONS') return new Response(null, { status: 204, headers: cab });
  if (peticion.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false }), { status: 405, headers: cab });
  }
  if (origen && !ORIGENES.includes(origen)) {
    return new Response(JSON.stringify({ ok: false }), { status: 403, headers: cab });
  }

  let c;
  try { c = await peticion.json(); } catch { return new Response('{}', { status: 400, headers: cab }); }

  const momento = MOMENTOS.includes(c.momento) ? c.momento : null;
  if (!momento) return new Response('{}', { status: 400, headers: cab });

  // Tope por direccion: holgado (120 por hora) porque en la feria muchos comparten wifi
  if (!(await pasaElTope(entorno, peticion, 'uso', 120))) {
    return new Response('{}', { status: 429, headers: cab });
  }

  // El numero del navegador se acorta a 16 letras: sirve para contar, no para buscar.
  const quien = corto(c.quien, 16);

  try {
    await entorno.editor_ideas.prepare(
      `INSERT INTO usos (cuando, momento, quien, pais, version, oido, segundos_video,
                         segundos_tarda, palabras, opciones, detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      new Date().toISOString(),
      momento,
      quien,
      peticion.cf?.country || '',
      corto(c.version, 20),
      corto(c.oido, 10),
      numero(c.segundosVideo, 100000),
      numero(c.segundosTarda, 100000),
      numero(c.palabras, 100000),
      corto(c.opciones, 200),
      corto(c.detalle, 120),
    ).run();
  } catch {
    // Si la cuenta falla, la persona no se entera: esto NUNCA puede estorbarle.
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: cab });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cab });
}

// Guarda a quien entra al editor: nombre, WhatsApp y correo, con su permiso.
// Igual que /api/idea, este servicio SOLO escribe: no hay login, no hay sesion
// y nunca devuelve nada de lo guardado. Asi, aunque alguien adivine la
// direccion, no puede sacar la lista de contactos.

const POR_HORA = 60;               // entradas por direccion: en la feria muchos comparten el wifi del stand
const ORIGENES = [
  'https://joakoestratega.com',
  'https://editor-9qb.pages.dev',
  'https://dev.editor-9qb.pages.dev',
  'http://127.0.0.1:8899',
];

const cabeceras = (origen) => ({
  'Access-Control-Allow-Origin': ORIGENES.includes(origen) ? origen : ORIGENES[0],
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
});

const recortar = (v, tope) =>
  // Fuera los caracteres de control: no son texto y ensucian la base.
  typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, tope) : '';

// Mismo contador atomico que /api/idea. La IP no se guarda: solo su huella.
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
    if (Math.random() < 0.02) {
      try { await entorno.editor_ideas.prepare('DELETE FROM topes WHERE hora < ?').bind(hora).run(); } catch {}
    }
    return !fila || fila.n <= porHora;
  } catch {
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
  // Aqui viajan datos de personas, asi que se exige de donde viene. En
  // /api/idea basta con revisar el origen cuando llega; esto es mas estricto a
  // proposito: sin Origin conocido no entra nada ([SEG] 2026-09-17, punto 6).
  if (!ORIGENES.includes(origen)) {
    return new Response(JSON.stringify({ ok: false, porque: 'origen' }), { status: 403, headers: cab });
  }

  let c;
  try { c = await peticion.json(); } catch {
    return new Response(JSON.stringify({ ok: false, porque: 'formato' }), { status: 400, headers: cab });
  }

  const nombre = recortar(c.nombre, 80);
  const telefono = recortar(c.telefono, 30);
  const correo = recortar(c.correo, 120);
  // Lo mismo que se revisa en la pantalla, revisado otra vez aqui: lo del
  // navegador se puede saltar, esto no.
  const digitos = (telefono.match(/\d/g) || []).length;
  if (nombre.length < 2 || digitos < 7 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(correo)) {
    return new Response(JSON.stringify({ ok: false, porque: 'datos' }), { status: 400, headers: cab });
  }
  // Sin permiso no se guarda nada. Y se guarda CUAL aviso acepto: si manana
  // cambia el texto, hay que poder decir que fue lo que la persona leyo
  // (Ley 1581 art. 9 y Decreto 1377 art. 7).
  if (c.acepto !== true) {
    return new Response(JSON.stringify({ ok: false, porque: 'sin-permiso' }), { status: 400, headers: cab });
  }

  if (!(await pasaElTope(entorno, peticion, 'registro', POR_HORA))) {
    return new Response(JSON.stringify({ ok: false, porque: 'muchos' }), { status: 429, headers: cab });
  }

  try {
    await entorno.editor_ideas.prepare(
      `INSERT INTO registros (cuando, nombre, telefono, correo, acepto, aviso, version, pais)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(
      // Solo la hora, no el instante exacto: con los milisegundos se podia
      // emparejar esta fila con la cuenta de uso (que es anonima) y ponerle
      // nombre y correo ([SEG] ciclo 2, punto 4).
      new Date().toISOString().slice(0, 13),
      nombre,
      telefono,
      correo,
      // OJO: el numero del navegador (quien) NO se guarda aqui a proposito. La
      // tabla de uso es anonima; si este registro lo trajera, cruzando las dos
      // quedaria todo el uso con nombre y correo ([SEG] 2026-09-17, punto 3).
      recortar(c.aviso, 24),
      recortar(c.version, 40),
      peticion.cf?.country || '',
    ).run();
  } catch {
    return new Response(JSON.stringify({ ok: false, porque: 'base' }), { status: 500, headers: cab });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cab });
}

// Recibe las sugerencias de quien usa el editor y las guarda en la base de
// Joako. Nada más. No hay login, no hay sesión y no se devuelve nada de lo
// guardado: este servicio SOLO escribe.
//
// Lo que se guarda es lo que la persona escribió a propósito en el formulario.
// No se guarda el video que está editando, ni nada que no haya puesto ahí.

const CUANTO_CABE = 8000;          // letras por campo, de sobra
const POR_HORA = 40;               // envios por direccion: en la feria muchos comparten el wifi del stand
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
  // La respuesta cambia segun quien pide: que ninguna cache la mezcle
  'Vary': 'Origin',
  'Content-Type': 'application/json; charset=utf-8',
  // Este servicio no tiene páginas: nada de lo que llegue se muestra en un navegador.
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
});

const recortar = (v, tope = CUANTO_CABE) =>
  typeof v === 'string' ? v.replace(/\u0000/g, '').trim().slice(0, tope) : '';

// Vive DENTRO del editor, en /api/idea. Por eso es una funcion de Pages y no un
// servicio aparte: no hay otro dominio que abrir ni otro despliegue que cuidar.
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
  {
    const peticion = contexto.request;
    const entorno = contexto.env;
    const origen = peticion.headers.get('Origin') || '';
    const cab = cabeceras(origen);

    if (peticion.method === 'OPTIONS') return new Response(null, { status: 204, headers: cab });
    if (peticion.method !== 'POST') {
      return new Response(JSON.stringify({ ok: false }), { status: 405, headers: cab });
    }
    // Solo desde donde vive el editor. Sin esto cualquiera manda basura desde su casa.
    if (origen && !ORIGENES.includes(origen)) {
      return new Response(JSON.stringify({ ok: false, porque: 'origen' }), { status: 403, headers: cab });
    }

    let cuerpo;
    try {
      cuerpo = await peticion.json();
    } catch {
      return new Response(JSON.stringify({ ok: false, porque: 'formato' }), { status: 400, headers: cab });
    }

    const texto = recortar(cuerpo.texto);
    if (texto.length < 4) {
      return new Response(JSON.stringify({ ok: false, porque: 'vacio' }), { status: 400, headers: cab });
    }

    if (!(await pasaElTope(entorno, peticion, 'idea', POR_HORA))) {
      return new Response(JSON.stringify({ ok: false, porque: 'muchos' }), { status: 429, headers: cab });
    }

    try {
      await entorno.editor_ideas.prepare(
        `INSERT INTO ideas (cuando, texto, nombre, contacto, que_hace, archivos, version, pais)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        new Date().toISOString(),
        texto,
        recortar(cuerpo.nombre, 80),
        recortar(cuerpo.contacto, 120),
        recortar(cuerpo.queHace, 120),
        recortar(cuerpo.archivos, 1200),
        recortar(cuerpo.version, 40),
        peticion.cf?.country || '',
      ).run();
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, porque: 'base' }), { status: 500, headers: cab });
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cab });
  }
}

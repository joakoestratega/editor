// Entrega lo que pasa con el editor para verlo dentro de Joako Platform.
//
// OJO: este es el UNICO servicio del editor que LEE. Los otros tres solo
// escriben. Por eso exige una llave que solo conoce el servidor de la
// plataforma, guardada en Cloudflare como variable protegida LLAVE_INFORME.
// Como se pone, y por que nunca se escribe en el codigo: base/LEEME-llave.md
//
// La llave NUNCA viaja al navegador: la plataforma llama a este servicio desde
// su propio servidor. Sin la llave correcta, esto responde 401 y nada mas.
//
//   GET /api/informe?dias=30     con la llave en la cabecera Authorization

const TOPE_PERSONAS = 500;

const cabeceras = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'",
  // Ningun navegador debe poder pedir esto desde una pagina: no hay CORS a proposito.
  'Cache-Control': 'no-store',
};

// Comparacion que tarda lo mismo acierte o falle: asi no se puede adivinar la
// llave midiendo cuanto se demora en contestar.
function igual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

// Tope de intentos por direccion de internet. Sin esto, la llave se puede
// adivinar probando sin parar, y al otro lado hay nombres, telefonos y correos.
// Es el mismo contador atomico de los otros servicios ([SEG] ciclo 3, punto 4).
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
    return !fila || fila.n <= porHora;
  } catch {
    // Aqui NO se deja pasar si el contador falla: del otro lado hay datos de
    // personas. En los que solo escriben es al reves, y a proposito.
    return false;
  }
}

export async function onRequest(contexto) {
  const peticion = contexto.request;
  const entorno = contexto.env;

  if (peticion.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false }), { status: 405, headers: cabeceras });
  }

  // Dos topes distintos, y esa diferencia importa:
  //   · con llave buena: 300 por hora. La plataforma llama desde UNA sola
  //     direccion para todo el equipo; con un tope bajo, a media manana la
  //     pantalla se quedaba en 429 para todos ([SEG] 2026-09-18, punto 4).
  //   · con llave mala: 20 por hora. Ahi si hay que frenar, porque es alguien
  //     probando a ver si acierta.
  const llave = entorno.LLAVE_INFORME;
  const traida = (peticion.headers.get('Authorization') || '').replace(/^\S+\s+/, '');
  if (!llave || !igual(traida, llave)) {
    if (!(await pasaElTope(entorno, peticion, 'informe-mal', 20))) {
      return new Response(JSON.stringify({ ok: false }), { status: 429, headers: cabeceras });
    }
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: cabeceras });
  }
  if (!(await pasaElTope(entorno, peticion, 'informe', 300))) {
    return new Response(JSON.stringify({ ok: false }), { status: 429, headers: cabeceras });
  }

  const url = new URL(peticion.url);
  const dias = Math.min(365, Math.max(1, parseInt(url.searchParams.get('dias') || '30', 10) || 30));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const desdeHora = desde.slice(0, 13);

  try {
    // Cada persona con lo que ha hecho. Se unen por el numero del navegador,
    // que es justo lo que la casilla del editor autoriza (aviso 2026-09-18-v2).
    const personas = await entorno.editor_ideas.prepare(
      `SELECT r.cuando, r.nombre, r.telefono, r.correo, r.pais, r.aviso,
              (SELECT COUNT(*) FROM usos u WHERE u.quien = r.quien AND u.momento = 'abrio')   veces,
              (SELECT COUNT(*) FROM usos u WHERE u.quien = r.quien AND u.momento = 'solto')   videos,
              (SELECT COUNT(*) FROM usos u WHERE u.quien = r.quien AND u.momento = 'exporto') exporto,
              (SELECT MAX(cuando) FROM usos u WHERE u.quien = r.quien)                        ultima
         FROM registros r
        WHERE r.cuando >= ?
        ORDER BY r.id DESC LIMIT ${TOPE_PERSONAS}`
    ).bind(desdeHora).all();

    const embudo = await entorno.editor_ideas.prepare(
      `SELECT momento, COUNT(*) veces, COUNT(DISTINCT quien) personas
         FROM usos WHERE cuando >= ? GROUP BY momento`
    ).bind(desde).all();

    const ideas = await entorno.editor_ideas.prepare(
      `SELECT cuando, nombre, contacto, que_hace, texto FROM ideas
        WHERE cuando >= ? ORDER BY id DESC LIMIT 50`
    ).bind(desde).all();

    return new Response(JSON.stringify({
      ok: true,
      dias,
      personas: personas.results || [],
      embudo: embudo.results || [],
      ideas: ideas.results || [],
    }), { status: 200, headers: cabeceras });
  } catch {
    return new Response(JSON.stringify({ ok: false, porque: 'base' }), { status: 500, headers: cabeceras });
  }
}

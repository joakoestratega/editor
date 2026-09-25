// Borra lo que ya cumplio 12 meses, que es lo que promete la politica publicada.
//
// POR QUE VIVE AQUI Y NO EN UNA TAREA PROGRAMADA: hasta hoy el borrado se corria
// a MANO con wrangler. El dia que nadie lo corriera, quedabamos incumpliendo lo
// que la pagina promete. Un reloj de Cloudflare (Cron Trigger) seria mas limpio,
// pero es otro servicio que hay que crear, desplegar y vigilar. Esto no necesita
// nada nuevo: se cuelga del tráfico que el editor ya tiene.
//
// Se dispara en 1 de cada 200 registros de uso, y SIEMPRE despues de haber
// contestado (`waitUntil`), asi que nadie espera por esto. Si en un mes nadie
// usa el editor no se purga, y no importa: tampoco entraron datos nuevos.
//
// El plazo se cuenta con las funciones de SQLite, las MISMAS que estan escritas
// en base/registros.sql. Dos formas de contar el mismo plazo terminan dando
// fechas distintas, y ahi ya no se sabe que se prometio.

const LIMITE_HORA = "strftime('%Y-%m-%dT%H','now','-12 months')";  // tabla registros
const LIMITE_FECHA = "datetime('now','-12 months')";               // usos e ideas
const LOTE = 200;

// El orden NO es negociable: primero lo que la persona hizo, despues sus datos.
// Al reves quedan usos huerfanos que ya no se pueden ligar a nadie, y un registro
// solo se borra cuando su uso ya no existe, para que un lote a medias no rompa
// esa promesa.
const PASOS = [
  `DELETE FROM usos WHERE id IN (
     SELECT u.id FROM usos u JOIN registros r ON r.quien = u.quien
      WHERE r.quien IS NOT NULL AND r.cuando < ${LIMITE_HORA} LIMIT ${LOTE})`,

  `DELETE FROM registros WHERE id IN (
     SELECT id FROM registros WHERE cuando < ${LIMITE_HORA}
       AND (quien IS NULL OR NOT EXISTS (SELECT 1 FROM usos u WHERE u.quien = registros.quien))
      LIMIT ${LOTE})`,

  `DELETE FROM usos WHERE id IN (
     SELECT id FROM usos WHERE cuando < ${LIMITE_FECHA} LIMIT ${LOTE})`,

  `DELETE FROM ideas WHERE id IN (
     SELECT id FROM ideas WHERE cuando < ${LIMITE_FECHA} LIMIT ${LOTE})`,
];

/** Borra un lote de cada cosa. Devuelve cuantas filas se fueron. */
export async function purgar(entorno) {
  let borradas = 0;
  for (const paso of PASOS) {
    try {
      const r = await entorno.editor_ideas.prepare(paso).run();
      borradas += (r && r.meta && r.meta.changes) || 0;
    } catch { /* una tabla que no exista no puede frenar a las demas */ }
  }
  return borradas;
}

/**
 * Lo llama quien recibe trafico. `contexto.waitUntil` hace que corra DESPUES de
 * contestar: si esto tarda, la persona no lo siente.
 */
export function purgarDeVezEnCuando(contexto, unaDeCada = 200) {
  try {
    if (Math.random() >= 1 / unaDeCada) return;
    contexto.waitUntil(purgar(contexto.env).catch(() => {}));
  } catch { /* nunca puede tumbar la peticion que la llamo */ }
}

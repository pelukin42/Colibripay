import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

/**
 * PostgreSQL de desarrollo, sin Docker y sin permisos de administrador.
 *
 * Son los binarios OFICIALES de PostgreSQL, corriendo como un proceso más del
 * usuario. No es una emulación ni una reimplementación: es el mismo motor que
 * va a correr en producción.
 *
 * NOTA HISTÓRICA: acá antes había un servidor basado en PGlite (Postgres
 * compilado a WebAssembly). Se descartó por una razón concreta: su servidor de
 * socket atiende una sesión a la vez y un error de query lo desincroniza de
 * forma permanente. Como la idempotencia de esta API está construida sobre
 * atrapar violaciones de índice único —o sea, provocar errores a propósito—,
 * PGlite se bloqueaba justo en el mecanismo más crítico del sistema.
 */

/**
 * El clúster vive FUERA del repositorio, por dos razones:
 *
 *  1. Este repo está dentro de una carpeta sincronizada por OneDrive. Sincronizar
 *     los miles de archivos de un clúster de Postgres hace que `initdb` tarde
 *     minutos en vez de segundos, y deja la base a merced de un conflicto de
 *     sincronización.
 *  2. Aunque sean datos de prueba, una base de una pasarela de pagos no tiene
 *     nada que hacer replicándose a un almacenamiento en la nube corporativo.
 *
 * Se puede sobrescribir con COLIBRI_PGDATA.
 */
const cacheRoot =
  process.env.LOCALAPPDATA ?? process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
const dataDir = process.env.COLIBRI_PGDATA ?? path.join(cacheRoot, 'colibripay', 'pgdata');
const port = Number(process.env.PGPORT ?? 5433);

const alreadyInitialised = fs.existsSync(path.join(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  // Sin esto, initdb hereda la configuración regional de Windows y crea el
  // clúster en WIN1252. Producción va en UTF-8, y un desarrollo con otro
  // encoding esconde exactamente los bugs que aparecen con nombres de comercio
  // acentuados. El locale C además hace que los ORDER BY no dependan de la
  // máquina donde corre.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

if (!alreadyInitialised) {
  console.log('  Inicializando el clúster por primera vez…');
  await pg.initialise();
}

await pg.start();

// `initialise` crea solo la base `postgres`. La nuestra se crea aparte y se
// ignora el error si ya existe, para que el script sea idempotente.
try {
  await pg.createDatabase('colibripay');
  console.log('  Base "colibripay" creada.');
} catch {
  // Ya existía.
}

const url = `postgresql://postgres:postgres@127.0.0.1:${port}/colibripay`;

console.log('');
console.log('  PostgreSQL de desarrollo escuchando.');
console.log('');
console.log(`  DATABASE_URL="${url}"`);
console.log(`  Datos en:     ${dataDir}`);
console.log('');
console.log('  Ctrl+C para detenerlo. Los datos persisten entre reinicios.');
console.log('');

async function shutdown(signal: string): Promise<void> {
  console.log(`\n  ${signal} recibido, cerrando…`);
  await pg.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

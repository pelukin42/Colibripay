import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// Envoltorio a mano en vez de `promisify`: los tipos de promisify no cubren la
// sobrecarga de scrypt con opciones, y esas opciones son justamente los
// parámetros de costo que hacen segura la función.
function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Hash de contraseñas de usuarios del dashboard.
 *
 * NO confundir con `hashApiKey`. Aquello es SHA-256 simple porque las llaves de
 * API son 187 bits de entropía aleatoria. Esto son contraseñas elegidas por
 * humanos —de baja entropía, reutilizadas entre sitios, presentes en cualquier
 * diccionario de filtraciones— y necesitan una función deliberadamente cara.
 *
 * scrypt y no Argon2id: Argon2 sería la primera opción, pero exige
 * dependencias nativas que en Windows fallan al compilar con frecuencia.
 * scrypt viene en la biblioteca estándar de Node, es memory-hard igual, y
 * OWASP lo acepta explícitamente como alternativa. Una dependencia nativa que
 * rompe la instalación acaba costando más de lo que aporta.
 *
 * Parámetros: N=2^16, r=8, p=2 (recomendación de OWASP). Requiere ~64 MB por
 * hash, que es justamente el punto: hace inviable el ataque masivo con GPU.
 */
const N = 2 ** 16;
const R = 8;
const P = 2;
const KEY_LENGTH = 32;
const MAXMEM = 192 * 1024 * 1024;

/** Formato: `scrypt$N$r$p$salt$hash`, todo en base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });

  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifica una contraseña contra su hash.
 *
 * Los parámetros se leen del propio hash y no de las constantes de arriba: así,
 * el día que se suban (porque el hardware mejoró), las contraseñas viejas
 * siguen validando y se pueden re-hashear al vuelo en el próximo login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  // Tope de sanidad: un hash manipulado con N gigante sería una denegación de
  // servicio contra nuestro propio proceso de login.
  if (n > 2 ** 20 || r > 32 || p > 16) return false;

  const expected = Buffer.from(hashRaw, 'base64url');

  try {
    const derived = await scryptAsync(
      password.normalize('NFKC'),
      Buffer.from(saltRaw, 'base64url'),
      expected.length,
      { N: n, r, p, maxmem: MAXMEM },
    );

    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** `true` si el hash usa parámetros viejos y conviene regenerarlo al iniciar sesión. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < N || Number(parts[2]) < R || Number(parts[3]) < P;
}

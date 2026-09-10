import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * Sesión del dashboard.
 *
 * Cookie firmada con HMAC-SHA256, no un JWT de librería: lo único que
 * necesitamos es "este payload lo emitimos nosotros y no venció". Un JWT
 * completo traería negociación de algoritmo —de donde sale la familia de
 * vulnerabilidades `alg: none`— a cambio de nada que usemos.
 *
 * La cookie NO lleva permisos ni datos del comercio más allá de los IDs: todo
 * lo demás se lee de la base en cada petición. Una cookie que cargue el rol
 * queda desactualizada en cuanto a alguien le cambian los permisos, y eso es
 * exactamente lo que no querés en un panel que mueve plata.
 */

const COOKIE = 'colibri_session';
const MAX_AGE_SECONDS = 12 * 60 * 60;

export interface Session {
  userId: string;
  merchantId: string;
  /** Segundos Unix. */
  exp: number;
}

function secret(): string {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) {
    throw new Error('JWT_SECRET falta o es demasiado corto (mínimo 32 caracteres)');
  }
  return value;
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function serializeSession(session: Omit<Session, 'exp'>): {
  value: string;
  maxAge: number;
} {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SECONDS;
  const payload = Buffer.from(JSON.stringify({ ...session, exp })).toString('base64url');
  return { value: `${payload}.${sign(payload)}`, maxAge: MAX_AGE_SECONDS };
}

export function parseSession(raw: string | undefined): Session | null {
  if (!raw) return null;

  const separator = raw.lastIndexOf('.');
  if (separator <= 0) return null;

  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  // Verificar la firma ANTES de parsear el contenido: si primero
  // deserializáramos, estaríamos procesando datos no confiables.
  if (!safeEqual(sign(payload), signature)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    if (!session.userId || !session.merchantId) return null;
    if (session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  return parseSession(store.get(COOKIE)?.value);
}

export async function writeSession(session: Omit<Session, 'exp'>): Promise<void> {
  const { value, maxAge } = serializeSession(session);
  const store = await cookies();

  store.set(COOKIE, value, {
    httpOnly: true, // inaccesible desde JavaScript: un XSS no se lleva la sesión
    sameSite: 'lax', // corta CSRF sin romper la navegación normal
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

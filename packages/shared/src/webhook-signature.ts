/**
 * Firma de webhooks.
 *
 * Usa Web Crypto (`crypto.subtle`) en vez de `node:crypto` a propósito: este
 * módulo se exporta a los comercios en el SDK, y así el mismo código verifica
 * firmas en Node, en Deno, en Bun y en un worker de Cloudflare sin cambiar
 * nada. El precio es que las funciones son asíncronas.
 *
 * FORMATO DE LA CABECERA: `t=<unix>,v1=<hmac-sha256-hex>`
 *
 * El timestamp va DENTRO de lo que se firma (`${t}.${cuerpo}`), no al lado.
 * Si solo acompañara a la firma, un atacante podría capturar una entrega
 * legítima y reenviarla mañana cambiándole la hora: la firma seguiría siendo
 * válida para ese cuerpo. Firmando el timestamp, cambiarlo invalida la firma, y
 * la ventana de tolerancia acota la reproducción a unos minutos.
 */

import { SIGNATURE_TOLERANCE_SECONDS } from './events.js';

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Comparación en tiempo constante.
 *
 * Con `===`, el tiempo de respuesta delata cuántos caracteres iniciales
 * coinciden, y eso permite reconstruir una firma válida byte a byte. Acá el
 * costo siempre es el mismo: se recorren ambas cadenas enteras acumulando
 * diferencias con XOR.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Genera el valor de la cabecera de firma para un cuerpo ya serializado. */
export async function signWebhookPayload(params: {
  payload: string;
  secret: string;
  /** Segundos Unix. Parametrizable para poder probar la tolerancia. */
  timestamp?: number;
}): Promise<string> {
  const timestamp = params.timestamp ?? Math.floor(Date.now() / 1000);
  const signature = await hmacSha256Hex(params.secret, `${timestamp}.${params.payload}`);
  return `t=${timestamp},v1=${signature}`;
}

export type SignatureVerification =
  | { valid: true }
  | { valid: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Verifica una entrega. Esto es lo que corre del lado del comercio.
 *
 * IMPORTANTE para quien integre: `payload` debe ser el cuerpo CRUDO tal como
 * llegó, no el resultado de parsear y volver a serializar el JSON. Un solo
 * espacio de diferencia cambia el HMAC.
 */
export async function verifyWebhookSignature(params: {
  payload: string;
  header: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}): Promise<SignatureVerification> {
  const tolerance = params.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = params.now ?? Math.floor(Date.now() / 1000);

  const parts = new Map(
    params.header
      .split(',')
      .map((piece) => piece.trim().split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key, value] as const),
  );

  const timestampRaw = parts.get('t');
  const provided = parts.get('v1');
  if (!timestampRaw || !provided) return { valid: false, reason: 'malformed' };

  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp)) return { valid: false, reason: 'malformed' };

  // El valor absoluto cubre también los timestamps del futuro: un reloj
  // adelantado en el emisor no debe abrir una ventana de reproducción larga.
  if (Math.abs(now - timestamp) > tolerance) return { valid: false, reason: 'expired' };

  const expected = await hmacSha256Hex(params.secret, `${timestamp}.${params.payload}`);
  return constantTimeEqual(expected, provided)
    ? { valid: true }
    : { valid: false, reason: 'mismatch' };
}

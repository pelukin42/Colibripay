/**
 * Identificadores públicos con prefijo. Que un ID diga qué es a simple vista
 * ahorra horas de depuración: en un log, `pi_` y `ch_` se distinguen de un
 * vistazo y un `sk_live_` que aparece donde no debe salta a la cara.
 */

/** Base58 de Bitcoin: sin 0, O, I ni l, que se confunden al leerlos o dictarlos. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export const ID_PREFIXES = {
  merchant: 'mch',
  customer: 'cus',
  paymentMethod: 'pm',
  paymentIntent: 'pi',
  charge: 'ch',
  refund: 're',
  dispute: 'dp',
  payout: 'po',
  bankAccount: 'ba',
  ledgerTransaction: 'ltx',
  event: 'evt',
  webhookEndpoint: 'we',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

/**
 * Cadena aleatoria criptográficamente segura en base58.
 *
 * Usa muestreo por rechazo en vez de `% ALPHABET.length`: el módulo sesga las
 * primeras letras del alfabeto cuando 256 no es múltiplo del tamaño, y en
 * llaves de API ese sesgo es pérdida real de entropía.
 */
export function randomString(length: number): string {
  const max = 256 - (256 % ALPHABET.length);
  let out = '';

  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length + 8);
    globalThis.crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (out.length === length) break;
      if (byte < max) out += ALPHABET[byte % ALPHABET.length];
    }
  }

  return out;
}

export function generateId(prefix: IdPrefix, length = 24): string {
  return `${prefix}_${randomString(length)}`;
}

/**
 * Llave de API: `sk_live_xxx` / `pk_test_xxx`.
 * 32 caracteres base58 ≈ 187 bits de entropía.
 */
export function generateApiKey(
  type: 'public' | 'secret',
  mode: 'test' | 'live',
): { key: string; prefix: string; lastFour: string } {
  const prefix = `${type === 'public' ? 'pk' : 'sk'}_${mode}`;
  const body = randomString(32);
  const key = `${prefix}_${body}`;
  return { key, prefix, lastFour: body.slice(-4) };
}

/**
 * Secreto de cliente del PaymentIntent. Va embebido en el ID para que el
 * servidor sepa a qué intent pertenece antes de tocar la base de datos.
 */
export function generateClientSecret(paymentIntentPublicId: string): string {
  return `${paymentIntentPublicId}_secret_${randomString(24)}`;
}

/** Extrae el ID del intent desde su client_secret, o null si está malformado. */
export function parseClientSecret(clientSecret: string): string | null {
  const index = clientSecret.indexOf('_secret_');
  if (index <= 0) return null;
  const id = clientSecret.slice(0, index);
  return id.startsWith(`${ID_PREFIXES.paymentIntent}_`) ? id : null;
}

/** Secreto de firma de webhooks: `whsec_xxx`. */
export function generateWebhookSecret(): string {
  return `whsec_${randomString(32)}`;
}

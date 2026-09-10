import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de campos en reposo: secretos de webhook, IBANs, credenciales de
 * adquirente.
 *
 * Está en el paquete de base de datos por la misma razón que `hashApiKey`: lo
 * escriben el seed y las herramientas de administración, y lo lee la API. El
 * formato tiene que ser idéntico entre todos, y una segunda implementación
 * significaría filas que se escriben pero no se pueden desencriptar.
 */

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('Falta ENCRYPTION_KEY');

  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length !== 32) {
    throw new Error(
      'ENCRYPTION_KEY debe ser 32 bytes en base64 (AES-256-GCM no acepta otra longitud)',
    );
  }
  return buffer;
}

/**
 * AES-256-GCM. Formato: `v1.<iv>.<authTag>.<ciphertext>` en base64url.
 *
 * El prefijo de versión permite rotar llave o algoritmo más adelante sin tener
 * que adivinar con qué se cifró cada fila.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Payload cifrado con formato desconocido');
  }

  const [, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  // GCM verifica integridad: si alguien manipuló el ciphertext, `final()` lanza.
  // Es la razón de usarlo en vez de CBC, donde la manipulación pasa desapercibida.
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

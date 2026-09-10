import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { decryptSecret, encryptSecret, hashApiKey } from '@colibripay/db';
import { loadEnv } from '../config/env.js';

/**
 * Fachada criptográfica del core.
 *
 * Las primitivas que tocan datos persistidos —hash de llaves, cifrado de
 * campos— viven en @colibripay/db y acá solo se envuelven. La razón es que el
 * seed y las herramientas de administración escriben esos mismos datos: dos
 * implementaciones del mismo formato terminan, tarde o temprano, en filas que
 * se escriben y no se pueden leer.
 *
 * Lo que sí es propio de la API son las comparaciones en tiempo constante y el
 * hash de cuerpos para idempotencia, que no persisten nada.
 */
@Injectable()
export class CryptoService {
  constructor() {
    // Falla al construirse, no en el primer cobro: si ENCRYPTION_KEY está mal,
    // queremos saberlo al arrancar.
    loadEnv();
  }

  hashApiKey(key: string): string {
    return hashApiKey(key);
  }

  encrypt(plaintext: string): string {
    return encryptSecret(plaintext);
  }

  decrypt(payload: string): string {
    return decryptSecret(payload);
  }

  /**
   * Comparación en tiempo constante, para client_secrets y firmas.
   *
   * Se hashean ambos lados antes de comparar por dos motivos: `timingSafeEqual`
   * exige longitudes iguales, y comparar longitudes crudas filtraría el largo
   * del secreto. Con SHA-256 de por medio, ambos operandos miden siempre 32
   * bytes y no se filtra nada.
   */
  safeEqual(a: string, b: string): boolean {
    const hashA = createHash('sha256').update(a, 'utf8').digest();
    const hashB = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(hashA, hashB);
  }

  /** SHA-256 del cuerpo, para detectar reuso de llave de idempotencia con otros datos. */
  hashRequestBody(body: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}), 'utf8')
      .digest('hex');
  }
}

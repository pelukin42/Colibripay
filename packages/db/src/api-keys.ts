import { createHash } from 'node:crypto';

/**
 * Hash de llaves de API.
 *
 * Vive acá, en el paquete de base de datos, porque tanto la API (al verificar
 * una llave entrante) como el seed y las herramientas de administración (al
 * crearlas) tienen que producir exactamente el mismo valor. Con dos
 * implementaciones, el día que una cambie las llaves dejan de validar y el
 * síntoma —401 en todo— no apunta a la causa.
 *
 * SHA-256 sin sal ni estiramiento es deliberado: las llaves son 32 caracteres
 * base58 (~187 bits de entropía aleatoria), no contraseñas humanas. Argon2
 * protegería contra ataques de diccionario que acá no existen, a cambio de
 * sumar latencia a cada petición autenticada. Las contraseñas de usuarios del
 * dashboard son otro caso y sí llevan Argon2id.
 *
 * Sin sal, además, es un requisito funcional: la verificación es una búsqueda
 * por índice único sobre el hash, y una sal por fila obligaría a leer todas las
 * llaves para comparar una por una.
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

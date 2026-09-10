import { SetMetadata } from '@nestjs/common';

export const SECRET_KEY_ONLY = 'secretKeyOnly';
export const PUBLIC_KEY_ALLOWED = 'publicKeyAllowed';

/**
 * Marca una ruta como accesible con llave pública (pk_).
 *
 * El default es lo contrario —solo llaves secretas— y eso es deliberado: si
 * alguien agrega un endpoint y olvida decorarlo, el fallo es hacia el lado
 * seguro. Un endpoint peligroso expuesto por olvido a una llave que vive en el
 * navegador sería una fuga de datos entre comercios.
 */
export const AllowPublicKey = () => SetMetadata(PUBLIC_KEY_ALLOWED, true);

/** Marca una ruta como abierta (sin autenticación): health checks, webhooks entrantes. */
export const NoAuth = () => SetMetadata('noAuth', true);

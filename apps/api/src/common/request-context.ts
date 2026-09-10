import type { Mode } from '@colibripay/db';

/**
 * Identidad detrás de una petición autenticada. La resuelve ApiKeyGuard y la
 * consumen los servicios; ningún servicio lee la llave de API directamente.
 */
export interface AuthContext {
  merchantId: string;
  merchantPublicId: string;
  apiKeyId: string;
  mode: Mode;
  keyType: 'PUBLIC' | 'SECRET';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

export {};

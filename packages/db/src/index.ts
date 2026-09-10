import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __colibriPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    // El log de queries se activa a mano, no por estar en desarrollo: con
    // tráfico real ahoga cualquier otro mensaje y vuelve inservible el log
    // justo cuando hay que depurar un cobro.
    log:
      process.env.PRISMA_LOG_QUERIES === '1'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });
}

/**
 * Cliente único. En desarrollo se guarda en `globalThis` porque el hot-reload de
 * Next.js recarga el módulo en cada cambio y sin esto se agota el pool de
 * conexiones de Postgres en un par de minutos.
 */
export const prisma: PrismaClient = globalThis.__colibriPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__colibriPrisma = prisma;
}

/**
 * `JSON.stringify` revienta con BigInt y todos nuestros montos son BigInt.
 * Los serializamos como string en el borde de la API: un número de JS pierde
 * precisión a partir de 2^53 y no queremos descubrirlo con el ledger anual de
 * un comercio grande.
 */
export function serializeBigInt<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as T;
}
export * from './api-keys.js';
export * from './encryption.js';
export * from './passwords.js';

import { Global, Module } from '@nestjs/common';
import { prisma } from '@colibripay/db';

export const PRISMA = Symbol('PRISMA');

/**
 * Expone el cliente único de Prisma por inyección de dependencias.
 *
 * Se comparte la instancia de @colibripay/db en vez de crear una propia: dos
 * clientes significan dos pools de conexiones y, peor, transacciones que no se
 * ven entre sí — que en un ledger es catastrófico.
 */
@Global()
@Module({
  providers: [{ provide: PRISMA, useValue: prisma }],
  exports: [PRISMA],
})
export class PrismaModule {}

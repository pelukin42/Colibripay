import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  type Currency,
  type Mode,
  type PrismaClient,
} from '@colibripay/db';
import {
  assertBalanced,
  generateId,
  ID_PREFIXES,
  type LedgerAccountType,
  type PostingSet,
} from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';

/** Valor de `scopeKey` para las cuentas que no pertenecen a ningún comercio. */
const PLATFORM_SCOPE = 'platform';

/**
 * Persistencia del ledger.
 *
 * Las reglas de qué asientos genera cada hecho viven en @colibripay/shared como
 * funciones puras. Este servicio solo se ocupa de escribirlas bien, que es un
 * problema distinto y tiene sus propias trampas:
 *
 *  1. Los asientos y la actualización de saldos van en UNA transacción. Si se
 *     separan, una caída en el medio deja saldos que no corresponden a los
 *     movimientos, y reconstruirlos a mano es un fin de semana perdido.
 *  2. Aislamiento Serializable. Dos cobros simultáneos del mismo comercio leen
 *     y escriben la misma fila de saldo; con el aislamiento por defecto de
 *     Postgres se pierde una de las dos actualizaciones.
 *  3. El índice único (kind, referenceType, referenceId) hace que registrar dos
 *     veces el mismo hecho sea imposible, no solo improbable.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger('Ledger');

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Escribe un conjunto de asientos.
   *
   * Devuelve el ID de la transacción contable, o `null` si el hecho ya estaba
   * registrado — reintentar es seguro y no duplica plata.
   */
  async post(params: {
    merchantId: string;
    mode: Mode;
    set: PostingSet;
    referenceType: string;
    referenceId: string;
  }): Promise<string | null> {
    const { merchantId, mode, set, referenceType, referenceId } = params;

    // Segunda barrera. Las funciones puras ya validaron, pero este es el último
    // punto antes de tocar la base y el costo de repetir la suma es nulo.
    assertBalanced(set.postings);

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const transaction = await tx.ledgerTransaction.create({
            data: {
              publicId: generateId(ID_PREFIXES.ledgerTransaction),
              merchantId,
              mode,
              kind: set.kind,
              currency: set.currency as Currency,
              referenceType,
              referenceId,
              description: set.description,
            },
            select: { id: true },
          });

          for (const posting of set.postings) {
            const account = await this.resolveAccount(tx, {
              merchantId: posting.scope === 'merchant' ? merchantId : null,
              type: posting.account,
              currency: set.currency as Currency,
              mode,
            });

            await tx.ledgerEntry.create({
              data: {
                transactionId: transaction.id,
                accountId: account,
                amount: posting.amount,
              },
            });

            // Incremento atómico: nunca leer-modificar-escribir un saldo.
            await tx.ledgerAccount.update({
              where: { id: account },
              data: { balance: { increment: posting.amount } },
            });
          }

          return transaction.id;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // Ya estaba registrado. Es el caso normal de un reintento, no un error.
        this.logger.debug(
          `Asiento ya registrado para ${set.kind} ${referenceType}:${referenceId}`,
        );
        return null;
      }
      throw error;
    }
  }

  /**
   * Busca o crea la cuenta. El upsert evita la carrera clásica de "existe? no?
   * la creo" entre dos cobros simultáneos de un comercio nuevo.
   *
   * La búsqueda va por `scopeKey`, no por `merchantId`: las cuentas de
   * plataforma tienen merchantId nulo y Postgres no aplica unicidad sobre
   * NULLs, así que un índice con la columna nullable permitiría duplicados
   * silenciosos. Ver el comentario del modelo en schema.prisma.
   */
  private async resolveAccount(
    tx: Prisma.TransactionClient,
    params: {
      merchantId: string | null;
      type: LedgerAccountType;
      currency: Currency;
      mode: Mode;
    },
  ): Promise<string> {
    const scopeKey = params.merchantId ?? PLATFORM_SCOPE;

    const account = await tx.ledgerAccount.upsert({
      where: {
        scopeKey_type_currency_mode: {
          scopeKey,
          type: params.type,
          currency: params.currency,
          mode: params.mode,
        },
      },
      create: {
        scopeKey,
        merchantId: params.merchantId,
        type: params.type,
        currency: params.currency,
        mode: params.mode,
        balance: 0n,
      },
      update: {},
      select: { id: true },
    });

    return account.id;
  }

  /** Saldos de un comercio, tal como los almacena el ledger (signo contable). */
  async balancesFor(params: {
    merchantId: string;
    mode: Mode;
    currency: Currency;
  }): Promise<Record<string, bigint>> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: {
        merchantId: params.merchantId,
        mode: params.mode,
        currency: params.currency,
      },
      select: { type: true, balance: true },
    });

    return Object.fromEntries(accounts.map((a) => [a.type, a.balance]));
  }

  /**
   * Recalcula los saldos desde los asientos y los compara con los almacenados.
   *
   * Los saldos son una caché; los asientos son la verdad. Esta comprobación
   * debería correr como tarea diaria: si alguna vez discrepan, hay que
   * enterarse por una alerta y no por el reclamo de un comercio.
   */
  async verifyIntegrity(mode: Mode): Promise<{
    ok: boolean;
    globalSum: bigint;
    mismatches: { accountId: string; stored: bigint; computed: bigint }[];
  }> {
    const accounts = await this.prisma.ledgerAccount.findMany({
      where: { mode },
      select: { id: true, balance: true },
    });

    const sums = await this.prisma.ledgerEntry.groupBy({
      by: ['accountId'],
      _sum: { amount: true },
    });

    const computedByAccount = new Map(
      sums.map((row) => [row.accountId, row._sum.amount ?? 0n]),
    );

    const mismatches: { accountId: string; stored: bigint; computed: bigint }[] = [];
    let globalSum = 0n;

    for (const account of accounts) {
      const computed = computedByAccount.get(account.id) ?? 0n;
      globalSum += computed;
      if (computed !== account.balance) {
        mismatches.push({ accountId: account.id, stored: account.balance, computed });
      }
    }

    // La invariante maestra: sumando TODAS las cuentas, el resultado es cero.
    // Si no lo es, se escribió un asiento descuadrado y hay que parar todo.
    return { ok: mismatches.length === 0 && globalSum === 0n, globalSum, mismatches };
  }
}

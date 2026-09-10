import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, from, of, switchMap, tap, catchError, throwError } from 'rxjs';
import { Prisma, type PrismaClient } from '@colibripay/db';
import { ColibriError } from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';
import { CryptoService } from '../common/crypto.service.js';

const HEADER = 'idempotency-key';
const REPLAY_HEADER = 'colibri-idempotent-replay';

/** Vida de una llave. Pasado esto se purga y la misma llave vuelve a ser usable. */
const KEY_TTL_MS = 24 * 60 * 60_000;

/**
 * Si un proceso muere a mitad de una petición, su fila queda bloqueada y el
 * comercio recibiría 409 eternamente con esa llave. Pasado este tiempo, un
 * reintento puede tomar posesión del bloqueo.
 *
 * El valor debe superar cómodamente la peor latencia posible de un cobro
 * (adquirente lento más 3DS), o dos peticiones legítimas podrían solaparse.
 */
const LOCK_TIMEOUT_MS = 90_000;

/**
 * Idempotencia de escrituras.
 *
 * Sin esto, un timeout de red del lado del comercio seguido de un reintento
 * cobra dos veces al mismo tarjetahabiente. Es el problema más caro y más común
 * de una pasarela, y no se puede resolver después.
 *
 * El mecanismo es el índice único (merchantId, key): la base de datos actúa de
 * mutex distribuido, así que funciona con cualquier cantidad de instancias sin
 * necesitar Redis ni coordinación externa.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Idempotency');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly crypto: CryptoService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    // Solo las escrituras necesitan protección: un GET repetido no cobra nada.
    if (request.method !== 'POST') return next.handle();

    const rawKey = request.headers[HEADER];
    const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    const auth = request.auth;

    if (!key || !auth) return next.handle();

    if (key.length > 255) {
      return throwError(() =>
        ColibriError.invalidRequest(
          'La llave de idempotencia no puede superar 255 caracteres',
          HEADER,
        ),
      );
    }

    const requestHash = this.crypto.hashRequestBody(request.body);

    return from(
      this.claim({
        merchantId: auth.merchantId,
        mode: auth.mode,
        key,
        method: request.method,
        path: request.path,
        requestHash,
      }),
    ).pipe(
      switchMap((claim) => {
        if (claim.kind === 'replay') {
          response.setHeader(REPLAY_HEADER, 'true');
          response.status(claim.status);
          return of(claim.body);
        }

        return next.handle().pipe(
          tap((body) => {
            void this.complete(claim.id, response.statusCode || 200, body);
          }),
          catchError((error: unknown) => {
            void this.settleFailure(claim.id, error);
            return throwError(() => error);
          }),
        );
      }),
    );
  }

  private async claim(params: {
    merchantId: string;
    mode: 'TEST' | 'LIVE';
    key: string;
    method: string;
    path: string;
    requestHash: string;
  }): Promise<
    { kind: 'owned'; id: string } | { kind: 'replay'; status: number; body: unknown }
  > {
    try {
      const created = await this.prisma.idempotencyKey.create({
        data: {
          merchantId: params.merchantId,
          mode: params.mode,
          key: params.key,
          method: params.method,
          path: params.path,
          requestHash: params.requestHash,
          expiresAt: new Date(Date.now() + KEY_TTL_MS),
        },
        select: { id: true },
      });
      return { kind: 'owned', id: created.id };
    } catch (error) {
      const isDuplicate =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
      if (!isDuplicate) throw error;
    }

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { merchantId_key: { merchantId: params.merchantId, key: params.key } },
    });

    // Se purgó entre el INSERT fallido y este SELECT. Rarísimo, pero reintentar
    // el claim es correcto y barato.
    if (!existing) return this.claim(params);

    // Misma llave con cuerpo distinto: no es un reintento, es un bug del cliente.
    // Se responde 422 antes de tocar nada.
    if (existing.requestHash !== params.requestHash) {
      throw ColibriError.idempotencyConflict(params.key);
    }

    if (existing.completedAt && existing.responseStatus !== null) {
      return {
        kind: 'replay',
        status: existing.responseStatus,
        body: existing.responseBody,
      };
    }

    const lockAge = Date.now() - existing.lockedAt.getTime();
    if (lockAge < LOCK_TIMEOUT_MS) {
      throw ColibriError.idempotencyInFlight(params.key);
    }

    // El dueño anterior murió sin terminar. Tomamos posesión.
    this.logger.warn(
      `Bloqueo de idempotencia vencido tras ${Math.round(lockAge / 1000)}s, se retoma: ${params.key}`,
    );
    await this.prisma.idempotencyKey.update({
      where: { id: existing.id },
      data: { lockedAt: new Date() },
    });
    return { kind: 'owned', id: existing.id };
  }

  private async complete(id: string, status: number, body: unknown): Promise<void> {
    try {
      await this.prisma.idempotencyKey.update({
        where: { id },
        data: {
          responseStatus: status,
          responseBody: body as never,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      // Si esto falla, el peor caso es que un reintento reciba 409 hasta que
      // venza el bloqueo. Preferible a tumbar una respuesta ya exitosa.
      this.logger.error(`No se pudo guardar la respuesta idempotente ${id}`, error);
    }
  }

  /**
   * Qué hacer cuando el handler falla.
   *
   * - Error de cliente (4xx): es determinista. Se guarda, y reintentar con la
   *   misma llave devuelve el mismo error en vez de volver a ejecutar.
   * - Error de servidor o inesperado: puede ser transitorio. Se LIBERA el
   *   bloqueo para que el reintento del comercio tenga una oportunidad real.
   *   Dejarlo puesto convertiría una caída momentánea en un cobro imposible
   *   durante 24 horas.
   */
  private async settleFailure(id: string, error: unknown): Promise<void> {
    const status = error instanceof ColibriError ? error.statusCode : 500;

    try {
      if (status >= 400 && status < 500) {
        await this.prisma.idempotencyKey.update({
          where: { id },
          data: {
            responseStatus: status,
            responseBody: (error instanceof ColibriError
              ? error.toBody()
              : { error: { message: 'error' } }) as never,
            completedAt: new Date(),
          },
        });
      } else {
        await this.prisma.idempotencyKey.delete({ where: { id } });
      }
    } catch (cleanupError) {
      this.logger.error(`No se pudo liberar el bloqueo ${id}`, cleanupError);
    }
  }
}

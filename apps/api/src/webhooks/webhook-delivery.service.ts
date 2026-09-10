import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PrismaClient } from '@colibripay/db';
import {
  API_VERSION,
  MAX_WEBHOOK_ATTEMPTS,
  SIGNATURE_HEADER,
  signWebhookPayload,
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_RETRY_SCHEDULE,
} from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';
import { CryptoService } from '../common/crypto.service.js';
import { checkWebhookUrl } from './url-guard.js';

/** Tiempo máximo que esperamos al endpoint del comercio. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Cuánto tiempo queda "tomada" una entrega al reclamarla.
 *
 * Es un arriendo, no un candado: si el worker muere a mitad del envío, la fila
 * vuelve a estar disponible al vencer. Debe superar cómodamente
 * REQUEST_TIMEOUT_MS, o dos workers intentarían la misma entrega.
 */
const LEASE_MS = 120_000;

/** Cuerpo de respuesta que guardamos para que el comercio depure. Truncado. */
const MAX_RESPONSE_BODY = 2_048;

/** Cada cuánto se refresca `lastSuccessAt` del endpoint. Ver `succeed()`. */
const SUCCESS_MARK_REFRESH_MS = 5 * 60_000;

interface ClaimedDelivery {
  id: string;
  attempt: number;
  endpointId: string;
  eventId: string;
}

/**
 * Entrega de webhooks.
 *
 * La cola vive en Postgres, no en Redis. Es una decisión, no una limitación:
 * la tabla `webhook_deliveries` ya tiene estado, intentos y próxima ejecución
 * —o sea, ya ES una cola—, y duplicarla en Redis introduce el problema de la
 * escritura dual: la fila commiteada pero el job perdido significa un webhook
 * que nunca sale; el job encolado sin fila, uno duplicado. Con
 * `FOR UPDATE SKIP LOCKED` varios workers se reparten el trabajo sin pisarse y
 * sin infraestructura extra.
 *
 * El techo de este enfoque son unos cuantos miles de entregas por segundo. Muy
 * por encima de lo que necesita una pasarela costarricense; si algún día deja
 * de alcanzar, se cambia esta clase y nada más.
 */
@Injectable()
export class WebhookDeliveryService {
  private readonly logger = new Logger('Webhooks');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CryptoService) private readonly crypto: CryptoService,
  ) {}

  /**
   * Toma hasta `limit` entregas vencidas y las arrienda.
   *
   * `SKIP LOCKED` es la pieza clave: sin él, dos workers compitiendo por las
   * mismas filas se bloquearían mutuamente y la cola avanzaría en serie.
   */
  async claimDue(limit: number): Promise<ClaimedDelivery[]> {
    const leaseUntil = new Date(Date.now() + LEASE_MS);

    return this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE webhook_deliveries AS d
      SET "nextRetryAt" = ${leaseUntil}, "updatedAt" = now()
      FROM (
        SELECT id
        FROM webhook_deliveries
        WHERE status = 'PENDING' AND "nextRetryAt" <= now()
        ORDER BY "nextRetryAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      ) AS due
      WHERE d.id = due.id
      RETURNING d.id, d.attempt, d."endpointId", d."eventId"
    `;
  }

  async deliver(claimed: ClaimedDelivery): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: claimed.id },
      include: { endpoint: true, event: true },
    });

    if (!delivery || delivery.status !== 'PENDING') return;

    const { endpoint, event } = delivery;

    // El endpoint pudo apagarse entre que se encoló y ahora.
    if (endpoint.status !== 'ENABLED') {
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'EXHAUSTED', error: 'El endpoint está deshabilitado' },
      });
      return;
    }

    const guard = checkWebhookUrl(endpoint.url, endpoint.mode);
    if (!guard.ok) {
      // No es reintentable: la URL no va a volverse válida sola.
      await this.fail(delivery.id, endpoint.id, delivery.attempt, {
        error: `URL rechazada: ${guard.message}`,
        terminal: true,
      });
      return;
    }

    const payload = JSON.stringify({
      id: event.publicId,
      object: 'event',
      type: event.type,
      apiVersion: event.apiVersion ?? API_VERSION,
      created: Math.floor(event.createdAt.getTime() / 1000),
      livemode: event.mode === 'LIVE',
      data: event.data,
    });

    const signature = await signWebhookPayload({
      payload,
      secret: this.crypto.decrypt(endpoint.secretEncrypted),
    });

    const startedAt = Date.now();

    /**
     * El resultado del envío se calcula primero y se registra después.
     *
     * Antes el `await this.succeed(...)` vivía DENTRO del try que envuelve al
     * fetch, así que un fallo al ESCRIBIR el resultado caía en el catch de
     * errores de red y se interpretaba como entrega fallida: el comercio ya
     * había recibido el webhook y le llegaba otra vez. Separar "enviar" de
     * "anotar lo que pasó" hace que ese error sea imposible por construcción.
     */
    let outcome:
      | { ok: true; responseCode: number; responseBody: string; durationMs: number }
      | {
          ok: false;
          responseCode?: number;
          responseBody?: string;
          durationMs: number;
          error: string;
          terminal?: boolean;
        };

    try {
      const response = await fetch(guard.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'ColibriPay-Webhooks/1.0',
          [SIGNATURE_HEADER]: signature,
          'colibri-event-id': event.publicId,
          'colibri-event-type': event.type,
          // Permite al comercio distinguir un reintento de una entrega nueva
          // sin tener que consultar su propia base.
          'colibri-delivery-attempt': String(delivery.attempt + 1),
        },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });

      const durationMs = Date.now() - startedAt;
      const body = (await response.text().catch(() => '')).slice(0, MAX_RESPONSE_BODY);

      // Cualquier 2xx cuenta como recibido. Exigir exactamente 200 rompería
      // integraciones que devuelven 204 y es una fuente clásica de fricción.
      outcome = response.ok
        ? { ok: true, responseCode: response.status, responseBody: body, durationMs }
        : {
            ok: false,
            responseCode: response.status,
            responseBody: body,
            durationMs,
            error: `El endpoint respondió ${response.status}`,
            // 410 Gone es la forma estándar de decir "no me mandes más".
            terminal: response.status === 410,
          };
    } catch (error) {
      outcome = {
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // A partir de acá ya no hay red de por medio: solo se anota el resultado.
    // Si esta escritura falla, la excepción sube y el arriendo vence sola, de
    // modo que la entrega se reintenta — nunca se marca como exitosa algo que
    // no se pudo registrar.
    if (outcome.ok) {
      await this.succeed(delivery.id, endpoint, delivery.attempt, outcome);
    } else {
      await this.fail(delivery.id, endpoint.id, delivery.attempt, outcome);
    }
  }

  private async succeed(
    deliveryId: string,
    endpoint: { id: string; consecutiveFailures: number; lastSuccessAt: Date | null },
    attempt: number,
    result: { responseCode: number; responseBody: string; durationMs: number },
  ): Promise<void> {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SUCCEEDED',
        attempt: attempt + 1,
        responseCode: result.responseCode,
        responseBody: result.responseBody,
        durationMs: result.durationMs,
        deliveredAt: new Date(),
        nextRetryAt: null,
        error: null,
      },
    });

    // La fila del endpoint se toca solo cuando hace falta.
    //
    // Un lote de 20 entregas del mismo comercio corre en paralelo, y todas
    // apuntan al MISMO endpoint: actualizarlo en cada éxito son 20 UPDATE
    // peleando por una sola fila. Esa contención es exactamente lo que hacía
    // fallar la escritura del resultado y disparaba entregas duplicadas.
    //
    // `lastSuccessAt` es informativo, así que basta refrescarlo de vez en
    // cuando; `consecutiveFailures` solo necesita escribirse si no era ya cero.
    const staleSuccessMark =
      !endpoint.lastSuccessAt ||
      Date.now() - endpoint.lastSuccessAt.getTime() > SUCCESS_MARK_REFRESH_MS;

    if (endpoint.consecutiveFailures > 0 || staleSuccessMark) {
      await this.prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { consecutiveFailures: 0, lastSuccessAt: new Date() },
      });
    }
  }

  private async fail(
    deliveryId: string,
    endpointId: string,
    attempt: number,
    result: {
      responseCode?: number;
      responseBody?: string;
      durationMs?: number;
      error: string;
      terminal?: boolean;
    },
  ): Promise<void> {
    const nextAttempt = attempt + 1;
    const exhausted = result.terminal || nextAttempt >= MAX_WEBHOOK_ATTEMPTS;

    const delaySeconds = WEBHOOK_RETRY_SCHEDULE[nextAttempt] ?? 0;
    const nextRetryAt = exhausted ? null : new Date(Date.now() + delaySeconds * 1000);

    const endpoint = await this.prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { consecutiveFailures: true, publicId: true },
    });

    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: exhausted ? 'EXHAUSTED' : 'PENDING',
        attempt: nextAttempt,
        responseCode: result.responseCode ?? null,
        responseBody: result.responseBody ?? null,
        durationMs: result.durationMs ?? null,
        error: result.error,
        nextRetryAt,
      },
    });

    // Un endpoint que lleva muchísimos fallos seguidos está muerto o mal
    // configurado. Apagarlo evita que sigamos golpeándolo y que su cola crezca
    // sin límite; el comercio lo ve en el panel y lo reactiva cuando lo arregla.
    if (endpoint.consecutiveFailures >= WEBHOOK_AUTO_DISABLE_THRESHOLD) {
      await this.prisma.webhookEndpoint.update({
        where: { id: endpointId },
        data: { status: 'AUTO_DISABLED' },
      });
      this.logger.warn(
        `Endpoint ${endpoint.publicId} deshabilitado tras ${endpoint.consecutiveFailures} fallos consecutivos`,
      );
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Mode, Prisma, PrismaClient } from '@colibripay/db';
import { API_VERSION, generateId, ID_PREFIXES, type EventType } from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';

/**
 * Registro de eventos y encolado de entregas.
 *
 * El evento se persiste SIEMPRE, tenga o no el comercio un webhook configurado.
 * Esa separación importa: el log de eventos es la historia auditable de la
 * cuenta, y los webhooks son apenas un mecanismo de notificación. Un comercio
 * que configura su endpoint la semana que viene puede reprocesar lo que se
 * perdió; si el evento solo existiera como entrega, no habría nada que
 * reprocesar.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger('Events');

  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Emite un evento y crea las entregas pendientes.
   *
   * Acepta un cliente de transacción para que el evento se escriba en el mismo
   * commit que el cambio que lo origina. Si se escribieran por separado, una
   * caída en el medio produciría un cobro exitoso del que el comercio nunca se
   * entera — o peor, un evento de éxito sin cobro detrás.
   */
  async emit(
    params: {
      merchantId: string;
      mode: Mode;
      type: EventType;
      data: unknown;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const client = tx ?? this.prisma;

    const event = await client.event.create({
      data: {
        publicId: generateId(ID_PREFIXES.event),
        merchantId: params.merchantId,
        mode: params.mode,
        type: params.type,
        apiVersion: API_VERSION,
        data: params.data as never,
      },
      select: { id: true, publicId: true },
    });

    const endpoints = await client.webhookEndpoint.findMany({
      where: { merchantId: params.merchantId, mode: params.mode, status: 'ENABLED' },
      select: { id: true, enabledEvents: true },
    });

    // Lista vacía significa "todos los eventos": es el default más útil y evita
    // que un comercio se quede sin notificaciones por olvidar marcar casillas.
    const targets = endpoints.filter(
      (endpoint) =>
        endpoint.enabledEvents.length === 0 ||
        endpoint.enabledEvents.includes(params.type),
    );

    if (targets.length > 0) {
      await client.webhookDelivery.createMany({
        data: targets.map((endpoint) => ({
          endpointId: endpoint.id,
          eventId: event.id,
          status: 'PENDING' as const,
          nextRetryAt: new Date(),
        })),
        skipDuplicates: true,
      });
    }

    this.logger.debug(
      `${params.type} -> ${event.publicId} (${targets.length} entregas encoladas)`,
    );

    return event.publicId;
  }
}

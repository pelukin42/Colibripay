import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { WebhookDeliveryService } from './webhook-delivery.service.js';

const POLL_INTERVAL_MS = 1_000;
const BATCH_SIZE = 20;
/** Espera tras un error de la propia cola (base caída, por ejemplo). */
const ERROR_BACKOFF_MS = 10_000;

/**
 * Worker de entregas.
 *
 * Corre dentro del proceso de la API por simplicidad, pero no depende de eso:
 * como la cola vive en Postgres y se reclama con SKIP LOCKED, se pueden
 * levantar N instancias —o un proceso aparte— sin coordinación ni cambios.
 *
 * Se apaga con WEBHOOK_WORKER=off, que es lo que hace falta al correr tests o
 * al separar la API de los workers en producción.
 */
@Injectable()
export class WebhookWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('WebhookWorker');
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(WebhookDeliveryService) private readonly deliveries: WebhookDeliveryService,
  ) {}

  onModuleInit(): void {
    if (process.env.WEBHOOK_WORKER === 'off') {
      this.logger.log('Worker deshabilitado por WEBHOOK_WORKER=off');
      return;
    }
    this.logger.log('Worker de webhooks iniciado');
    this.schedule(0);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    // setTimeout encadenado, no setInterval: así una vuelta lenta nunca se
    // solapa con la siguiente. Con setInterval, un endpoint que tarda 10 s
    // acumularía vueltas hasta ahogar el proceso.
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    try {
      const claimed = await this.deliveries.claimDue(BATCH_SIZE);

      if (claimed.length > 0) {
        // allSettled y no all: una entrega que falla no debe impedir las otras
        // del mismo lote. Cada `deliver` ya registra su propio resultado.
        await Promise.allSettled(claimed.map((item) => this.deliveries.deliver(item)));
      }

      // Si el lote salió lleno probablemente hay más esperando: seguimos de
      // inmediato en vez de dormir un segundo con la cola acumulada.
      this.schedule(claimed.length === BATCH_SIZE ? 0 : POLL_INTERVAL_MS);
    } catch (error) {
      this.logger.error('Fallo al procesar la cola de webhooks', error);
      this.schedule(ERROR_BACKOFF_MS);
    }
  }
}

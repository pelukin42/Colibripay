import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './common/prisma.provider.js';
import { CryptoService } from './common/crypto.service.js';
import { ApiExceptionFilter } from './common/errors.filter.js';
import { RequestIdMiddleware } from './common/request-id.middleware.js';
import { ApiKeyGuard } from './auth/api-key.guard.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { LedgerService } from './ledger/ledger.service.js';
import { EventsService } from './events/events.service.js';
import { PaymentIntentsController } from './payment-intents/payment-intents.controller.js';
import { PaymentIntentsService } from './payment-intents/payment-intents.service.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [PrismaModule],
  controllers: [PaymentIntentsController, HealthController],
  providers: [
    CryptoService,
    LedgerService,
    EventsService,
    PaymentIntentsService,

    // El guard es GLOBAL a propósito. Si la autenticación se aplicara ruta por
    // ruta, el día que alguien agregue un endpoint y olvide el decorador
    // quedaría abierto al mundo. Así, el olvido se manifiesta como un 401
    // molesto en desarrollo, no como una fuga de datos en producción.
    { provide: APP_GUARD, useClass: ApiKeyGuard },

    // Corre después del guard, porque necesita saber qué comercio es.
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },

    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  // Se valida el entorno ANTES de levantar nada: es preferible no arrancar a
  // arrancar mal configurado y descubrirlo con el primer cobro.
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, {
    logger:
      env.NODE_ENV === 'production'
        ? ['error', 'warn', 'log']
        : ['error', 'warn', 'log', 'debug'],
  });

  // El checkout corre en otro origen (esa separación es lo que nos mantiene en
  // SAQ A), así que necesita CORS explícito. Lista blanca, no comodín: un `*`
  // acá dejaría que cualquier página llame a la API con la llave pública de un
  // comercio.
  app.enableCors({
    origin: [env.CHECKOUT_URL, env.DASHBOARD_URL],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    exposedHeaders: ['colibri-request-id', 'colibri-idempotent-replay'],
  });

  app.enableShutdownHooks();

  await app.listen(env.PORT);
  new Logger('Bootstrap').log(`API escuchando en http://localhost:${env.PORT}`);
}

void bootstrap();

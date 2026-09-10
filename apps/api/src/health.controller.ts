import { Controller, Get, Inject } from '@nestjs/common';
import type { PrismaClient } from '@colibripay/db';
import { listAcquirers } from '@colibripay/acquirers';
import { PRISMA } from './common/prisma.provider.js';
import { NoAuth } from './auth/secret-key.decorator.js';

@Controller()
export class HealthController {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  /**
   * Comprueba las dependencias de verdad, no solo que el proceso responda.
   * Un health check que devuelve 200 con la base caída es peor que no tenerlo:
   * mantiene la instancia en el balanceador mientras rechaza cobros.
   */
  @Get('health')
  @NoAuth()
  async health() {
    const checks: Record<string, string> = {};
    let healthy = true;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
      healthy = false;
    }

    for (const acquirer of listAcquirers()) {
      try {
        checks[`acquirer:${acquirer.name}`] = (await acquirer.ping()) ? 'ok' : 'error';
      } catch {
        checks[`acquirer:${acquirer.name}`] = 'error';
      }
    }

    return { status: healthy ? 'ok' : 'degraded', checks };
  }
}

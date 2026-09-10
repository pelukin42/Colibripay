import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { PrismaClient } from '@colibripay/db';
import { ColibriError } from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';
import { CryptoService } from '../common/crypto.service.js';
import { PUBLIC_KEY_ALLOWED } from './secret-key.decorator.js';

/** Cada cuánto se refresca `lastUsedAt`. Ver comentario abajo. */
const LAST_USED_REFRESH_MS = 5 * 60_000;

@Injectable()
export class ApiKeyGuard implements CanActivate {
  // Todos los tokens de inyección son EXPLÍCITOS a propósito. La inyección por
  // tipo de NestJS depende de la metadata `design:paramtypes` que emite tsc con
  // `emitDecoratorMetadata`, y esbuild —que es lo que usa tsx en desarrollo— no
  // la emite. Sin @Inject, estas dependencias llegan `undefined` solo al correr
  // en dev, mientras el build con tsc funciona: el peor tipo de bug. Con tokens
  // explícitos funciona igual con tsc, esbuild, swc o cualquier bundler.
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const controller = context.getClass();

    if (this.reflector.getAllAndOverride<boolean>('noAuth', [handler, controller])) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = extractKey(request);

    if (!presented) {
      throw ColibriError.unauthorized(
        'Falta la llave de API. Enviala como: Authorization: Bearer sk_test_...',
      );
    }

    // Búsqueda por hash: la llave en claro no existe en la base, así que un
    // volcado de la tabla no le sirve a nadie para cobrar.
    const record = await this.prisma.apiKey.findUnique({
      where: { hashedKey: this.crypto.hashApiKey(presented) },
      include: { merchant: { select: { id: true, publicId: true, status: true } } },
    });

    if (!record || record.revokedAt) {
      throw ColibriError.unauthorized();
    }

    if (record.merchant.status === 'SUSPENDED' || record.merchant.status === 'REJECTED') {
      throw new ColibriError({
        type: 'authentication_error',
        code: 'merchant_inactive',
        message: 'La cuenta del comercio no está activa. Contactá a soporte.',
        statusCode: 403,
      });
    }

    // Un comercio sin aprobar puede integrar en TEST, pero no cobrar de verdad.
    if (record.mode === 'LIVE' && record.merchant.status !== 'ACTIVE') {
      throw new ColibriError({
        type: 'authentication_error',
        code: 'merchant_not_activated',
        message:
          'La cuenta todavía no está habilitada para cobros reales. ' +
          'Usá tus llaves de prueba (sk_test_...) mientras tanto.',
        statusCode: 403,
      });
    }

    if (record.type === 'PUBLIC') {
      const allowed = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY_ALLOWED, [
        handler,
        controller,
      ]);
      if (!allowed) {
        throw new ColibriError({
          type: 'authentication_error',
          code: 'api_key_insufficient',
          message:
            'Esta operación requiere una llave secreta (sk_). ' +
            'Las llaves públicas solo sirven para tokenizar y confirmar desde el navegador.',
          statusCode: 403,
        });
      }
    }

    request.auth = {
      merchantId: record.merchantId,
      merchantPublicId: record.merchant.publicId,
      apiKeyId: record.id,
      mode: record.mode,
      keyType: record.type,
    };

    // `lastUsedAt` es informativo, así que no vale una escritura por petición:
    // un comercio con tráfico normal generaría millones de UPDATE sobre la misma
    // fila y la convertiría en un punto de contención. Se refresca cada 5 min y
    // sin await, para no sumarle latencia al cobro.
    const stale =
      !record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > LAST_USED_REFRESH_MS;
    if (stale) {
      void this.prisma.apiKey
        .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }

    return true;
  }
}

/** Acepta `Authorization: Bearer <llave>` y HTTP Basic con la llave como usuario. */
function extractKey(request: Request): string | null {
  const header = request.headers.authorization;
  if (!header) return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;

  if (scheme.toLowerCase() === 'bearer') return value.trim();

  // Basic con la llave como usuario y contraseña vacía: es como lo hacen varias
  // librerías HTTP viejas y no cuesta nada soportarlo.
  if (scheme.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const [user] = decoded.split(':');
    return user?.trim() || null;
  }

  return null;
}

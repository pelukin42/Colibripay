import { Body, Controller, Get, Inject, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@colibripay/db';
import { selectAcquirer } from '@colibripay/acquirers';
import { ColibriError, formatAmount, parseClientSecret, type Currency } from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';
import { CryptoService } from '../common/crypto.service.js';
import { NoAuth } from '../auth/secret-key.decorator.js';
import type { AuthContext } from '../common/request-context.js';
import { PaymentIntentsService } from '../payment-intents/payment-intents.service.js';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service.js';
import { parseBody } from '../payment-intents/payment-intents.dto.js';

const confirmSchema = z.object({
  clientSecret: z.string().min(20),
  /** Token del vault del adquirente. Nunca datos de tarjeta. */
  token: z.string().min(10).max(2000),
  holderName: z.string().max(200).optional(),
  email: z.string().email().optional(),
});

/**
 * Datos que necesita el checkout hospedado para pintarse.
 *
 * Va sin autenticación por llave de API porque el `client_secret` ES la
 * credencial: lo posee quien el comercio decidió, tiene alcance a UN solo
 * PaymentIntent y muere con él. Pedir además una llave pública no agregaría
 * seguridad y sí obligaría a incrustarla en cada enlace de pago.
 *
 * La respuesta se limita a lo que hace falta para mostrar la pantalla. Nada de
 * metadata del comercio, ni el listado de cobros, ni los montos internos.
 */
@Controller('v1/checkout')
export class CheckoutController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(CryptoService) private readonly crypto: CryptoService,
    @Inject(PaymentIntentsService) private readonly intents: PaymentIntentsService,
    @Inject(PaymentMethodsService) private readonly methods: PaymentMethodsService,
  ) {}

  /**
   * Adjunta el token y confirma, en un solo paso.
   *
   * Existe como ruta aparte porque el checkout no tiene llave de API: su
   * credencial es el `client_secret`, que solo alcanza a ESTE intent. Meter
   * esto en `/v1/payment_intents/:id/confirm` obligaría a que esa ruta acepte
   * dos formas de autenticación distintas, y esa clase de ambigüedad en un
   * endpoint que mueve plata es como se cuelan los agujeros.
   */
  @Post('confirm')
  @NoAuth()
  async confirm(@Req() req: Request, @Body() body: unknown) {
    const dto = parseBody(confirmSchema, body);
    const { intent, auth } = await this.authorize(dto.clientSecret);

    if (intent.status === 'SUCCEEDED') {
      return this.intents.retrieve(auth, intent.publicId);
    }

    const method = await this.methods.create(auth, {
      type: 'CARD',
      token: dto.token,
      billing: dto.holderName || dto.email
        ? { name: dto.holderName, email: dto.email }
        : undefined,
    });

    return this.intents.confirm(
      auth,
      intent.publicId,
      { paymentMethodId: method.id },
      { ipAddress: req.ip, userAgent: req.headers['user-agent'] },
    );
  }

  /**
   * Resuelve el intent a partir del secreto y arma un contexto acotado a su
   * comercio.
   *
   * El contexto se marca como llave PÚBLICA a propósito: si algún día este
   * controlador llamara por error a una operación que exige llave secreta, el
   * guard la rechazaría en vez de permitirla. Falla hacia el lado seguro.
   */
  private async authorize(clientSecret: string) {
    const publicId = parseClientSecret(clientSecret);
    if (!publicId) {
      throw ColibriError.invalidRequest('client_secret con formato inválido', 'clientSecret');
    }

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { publicId },
      include: { merchant: { select: { id: true, publicId: true } } },
    });

    if (!intent || !this.crypto.safeEqual(intent.clientSecret, clientSecret)) {
      throw ColibriError.notFound('PaymentIntent', publicId);
    }

    const auth: AuthContext = {
      merchantId: intent.merchantId,
      merchantPublicId: intent.merchant.publicId,
      apiKeyId: 'checkout-session',
      mode: intent.mode,
      keyType: 'PUBLIC',
    };

    return { intent, auth };
  }

  @Get('session')
  @NoAuth()
  async session(@Query('client_secret') clientSecret?: string) {
    if (!clientSecret) {
      throw ColibriError.invalidRequest('Falta client_secret', 'client_secret');
    }

    // El ID viaja dentro del propio secreto, así que se resuelve el intent sin
    // buscar por el secreto completo y sin exponer un índice sobre él.
    const publicId = parseClientSecret(clientSecret);
    if (!publicId) {
      throw ColibriError.invalidRequest('client_secret con formato inválido', 'client_secret');
    }

    const intent = await this.prisma.paymentIntent.findUnique({
      where: { publicId },
      include: {
        merchant: { select: { tradeName: true, publicId: true } },
        paymentMethod: true,
      },
    });

    // Comparación en tiempo constante: el atacante controla el valor y podría
    // medir tiempos para adivinarlo carácter por carácter.
    if (!intent || !this.crypto.safeEqual(intent.clientSecret, clientSecret)) {
      throw ColibriError.notFound('PaymentIntent', publicId);
    }

    const acquirer = selectAcquirer({
      methodType: 'CARD',
      currency: intent.currency as Currency,
    });

    const tokenization = acquirer.browserTokenizationTarget({
      merchantId: intent.merchant.publicId,
      mode: intent.mode,
      idempotencyKey: '',
      credentials: {},
    });

    return {
      paymentIntent: {
        id: intent.publicId,
        status: intent.status,
        amount: Number(intent.amount),
        currency: intent.currency,
        amountLabel: formatAmount(intent.amount, intent.currency as Currency),
        description: intent.description,
        nextAction: intent.nextAction,
        lastError: intent.lastError,
        livemode: intent.mode === 'LIVE',
        expiresAt: intent.expiresAt?.toISOString() ?? null,
      },
      merchant: { name: intent.merchant.tradeName },
      /**
       * Adónde debe postear el navegador la tarjeta. NO es nuestra API: es el
       * vault del adquirente. Que este dato venga del servidor y no esté
       * cableado en el checkout permite cambiar de adquirente sin desplegar el
       * frontend.
       */
      tokenization,
    };
  }
}

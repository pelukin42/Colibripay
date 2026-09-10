import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ColibriError } from '@colibripay/shared';
import { AllowPublicKey } from '../auth/secret-key.decorator.js';
import { parseBody } from '../payment-intents/payment-intents.dto.js';
import { PaymentMethodsService } from './payment-methods.service.js';
import { createPaymentMethodSchema } from './payment-methods.dto.js';

@Controller('v1/payment_methods')
export class PaymentMethodsController {
  constructor(
    @Inject(PaymentMethodsService) private readonly service: PaymentMethodsService,
  ) {}

  /**
   * Acepta llave pública: lo llama el iframe del checkout desde el navegador
   * del comprador, que es justamente donde una llave secreta no puede estar.
   */
  @Post()
  @AllowPublicKey()
  async create(@Req() req: Request, @Body() body: unknown) {
    if (!req.auth) throw ColibriError.internal('Petición sin contexto de autenticación');
    return this.service.create(req.auth, parseBody(createPaymentMethodSchema, body));
  }
}

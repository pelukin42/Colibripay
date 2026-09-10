import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ColibriError } from '@colibripay/shared';
import { AllowPublicKey } from '../auth/secret-key.decorator.js';
import { PaymentIntentsService } from './payment-intents.service.js';
import {
  cancelPaymentIntentSchema,
  capturePaymentIntentSchema,
  confirmPaymentIntentSchema,
  createPaymentIntentSchema,
  parseBody,
} from './payment-intents.dto.js';

@Controller('v1/payment_intents')
export class PaymentIntentsController {
  constructor(private readonly service: PaymentIntentsService) {}

  @Post()
  async create(@Req() req: Request, @Body() body: unknown) {
    return this.service.create(auth(req), parseBody(createPaymentIntentSchema, body));
  }

  @Get(':id')
  async retrieve(@Req() req: Request, @Param('id') id: string) {
    return this.service.retrieve(auth(req), id);
  }

  /**
   * Confirmar acepta llave pública: es lo que llama el checkout desde el
   * navegador del comprador, donde una llave secreta no puede estar.
   */
  @Post(':id/confirm')
  @AllowPublicKey()
  async confirm(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.service.confirm(
      auth(req),
      id,
      parseBody(confirmPaymentIntentSchema, body),
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      },
    );
  }

  @Post(':id/capture')
  async capture(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.service.capture(auth(req), id, parseBody(capturePaymentIntentSchema, body));
  }

  @Post(':id/cancel')
  async cancel(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    parseBody(cancelPaymentIntentSchema, body);
    return this.service.cancel(auth(req), id);
  }
}

function auth(req: Request) {
  // El guard corre antes que el controlador, así que esto no debería pasar
  // nunca. Si pasa, es un error de configuración y prefiero un 500 explícito
  // antes que un `undefined` propagándose hasta una consulta sin filtro de
  // comercio.
  if (!req.auth) throw ColibriError.internal('Petición sin contexto de autenticación');
  return req.auth;
}

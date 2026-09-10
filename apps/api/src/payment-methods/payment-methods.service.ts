import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@colibripay/db';
import { selectAcquirer } from '@colibripay/acquirers';
import {
  ColibriError,
  generateId,
  ID_PREFIXES,
  type AcquirerContext,
} from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';
import type { AuthContext } from '../common/request-context.js';
import {
  toPublicPaymentMethod,
  type PublicPaymentMethod,
} from '../payment-intents/payment-intents.serializer.js';
import type { CreatePaymentMethodDto } from './payment-methods.dto.js';

/**
 * Tokenización.
 *
 * Este es el ÚNICO punto del sistema que ve un número de tarjeta, y lo ve de
 * paso: lo recibe, lo manda al vault del adquirente y lo descarta. Nada de lo
 * que entra acá se persiste ni se registra en logs.
 *
 * En producción esta ruta no debería recibir el PAN directamente del comercio:
 * lo envía el iframe del checkout desde el navegador del comprador, con llave
 * pública. Esa separación es la que mantiene el alcance PCI en SAQ A.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(
    auth: AuthContext,
    dto: CreatePaymentMethodDto,
  ): Promise<PublicPaymentMethod> {
    if (dto.type === 'CARD') return this.createCard(auth, dto);
    return this.createSinpe(auth, dto);
  }

  private async createCard(
    auth: AuthContext,
    dto: Extract<CreatePaymentMethodDto, { type: 'CARD' }>,
  ): Promise<PublicPaymentMethod> {
    const acquirer = selectAcquirer({ methodType: 'CARD', currency: 'CRC' });

    const context: AcquirerContext = {
      merchantId: auth.merchantPublicId,
      mode: auth.mode,
      idempotencyKey: generateId(ID_PREFIXES.paymentMethod),
      credentials: {},
    };

    const result = await acquirer.tokenize({
      context,
      card: {
        number: dto.card.number,
        expMonth: dto.card.expMonth,
        expYear: dto.card.expYear,
        cvc: dto.card.cvc,
        holderName: dto.billing?.name,
      },
      billing: dto.billing,
    });

    if (result.status === 'declined') {
      throw ColibriError.cardDeclined(result.declineCode);
    }
    if (result.status === 'error') {
      throw ColibriError.internal(`No se pudo tokenizar la tarjeta: ${result.message}`);
    }

    // A partir de acá `dto.card.number` deja de usarse. Lo único que se guarda
    // es el token opaco más metadatos que no permiten reconstruir la tarjeta.
    const method = await this.prisma.paymentMethod.create({
      data: {
        publicId: generateId(ID_PREFIXES.paymentMethod),
        merchantId: auth.merchantId,
        mode: auth.mode,
        customerId: dto.customerId ? await this.resolveCustomerId(auth, dto.customerId) : null,
        type: 'CARD',
        brand: result.brand,
        last4: result.last4,
        bin: result.bin,
        expMonth: result.expMonth,
        expYear: result.expYear,
        fingerprint: result.fingerprint ?? null,
        cvcCheck: result.cvcCheck ?? null,
        acquirerToken: result.token,
        acquirerAdapter: acquirer.name,
        billingName: dto.billing?.name ?? null,
        billingEmail: dto.billing?.email ?? null,
        billingCountry: dto.billing?.country ?? 'CR',
      },
    });

    return toPublicPaymentMethod(method);
  }

  private async createSinpe(
    auth: AuthContext,
    dto: Extract<CreatePaymentMethodDto, { type: 'SINPE_MOVIL' }>,
  ): Promise<PublicPaymentMethod> {
    const method = await this.prisma.paymentMethod.create({
      data: {
        publicId: generateId(ID_PREFIXES.paymentMethod),
        merchantId: auth.merchantId,
        mode: auth.mode,
        customerId: dto.customerId ? await this.resolveCustomerId(auth, dto.customerId) : null,
        type: 'SINPE_MOVIL',
        phoneNumber: dto.sinpe.phoneNumber,
        bankName: dto.sinpe.bankName ?? null,
        billingName: dto.billing?.name ?? null,
        billingEmail: dto.billing?.email ?? null,
        billingCountry: 'CR',
      },
    });

    return toPublicPaymentMethod(method);
  }

  private async resolveCustomerId(auth: AuthContext, publicId: string): Promise<string> {
    const customer = await this.prisma.customer.findFirst({
      where: { publicId, merchantId: auth.merchantId, mode: auth.mode },
      select: { id: true },
    });
    if (!customer) throw ColibriError.notFound('Customer', publicId);
    return customer.id;
  }
}

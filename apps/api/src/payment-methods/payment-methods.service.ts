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
import type {
  CardRawDto,
  CardTokenDto,
  CreatePaymentMethodDto,
  SinpeDto,
} from './payment-methods.dto.js';

/**
 * Métodos de pago.
 *
 * Dos caminos con consecuencias PCI opuestas:
 *
 *  - `createCardFromToken` — el navegador tokenizó contra el vault del
 *    adquirente y acá solo llega la referencia. El PAN nunca tocó nuestra
 *    infraestructura. Es lo que usa el checkout y es el camino por defecto.
 *
 *  - `createCard` — el PAN llega a nuestros servidores. Nos pone en alcance
 *    PCI DSS completo como proveedor de servicio. Existe para adquirentes sin
 *    tokenización desde el navegador y para comercios ya certificados.
 *
 * Ninguno de los dos persiste ni registra el número: lo que se guarda es el
 * token opaco más metadatos con los que la tarjeta no se puede reconstruir.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(
    auth: AuthContext,
    dto: CreatePaymentMethodDto,
  ): Promise<PublicPaymentMethod> {
    if (dto.type === 'SINPE_MOVIL') return this.createSinpe(auth, dto);
    return 'token' in dto ? this.createCardFromToken(auth, dto) : this.createCard(auth, dto);
  }

  /**
   * Camino normal: el navegador ya tokenizó contra el vault del adquirente y
   * acá solo llega la referencia opaca. El PAN nunca tocó nuestros servidores.
   */
  private async createCardFromToken(
    auth: AuthContext,
    dto: CardTokenDto,
  ): Promise<PublicPaymentMethod> {
    const acquirer = selectAcquirer({ methodType: 'CARD', currency: 'CRC' });

    // Los metadatos se resuelven contra el adquirente, NO se toman de lo que
    // mande el cliente. Si confiáramos en el navegador, cualquiera podría
    // guardar una tarjeta declarando la marca y los últimos 4 que quisiera —
    // y esos datos terminan en recibos, en el panel y en la evidencia de una
    // disputa.
    const described = await acquirer.describeToken(dto.token, {
      merchantId: auth.merchantPublicId,
      mode: auth.mode,
      idempotencyKey: '',
      credentials: {},
    });

    if (described.status !== 'approved') {
      throw ColibriError.invalidRequest(
        'El token de tarjeta no es válido o ya venció',
        'token',
      );
    }

    const method = await this.prisma.paymentMethod.create({
      data: {
        publicId: generateId(ID_PREFIXES.paymentMethod),
        merchantId: auth.merchantId,
        mode: auth.mode,
        customerId: dto.customerId
          ? await this.resolveCustomerId(auth, dto.customerId)
          : null,
        type: 'CARD',
        brand: described.brand,
        last4: described.last4,
        bin: described.bin,
        expMonth: described.expMonth,
        expYear: described.expYear,
        fingerprint: described.fingerprint ?? null,
        cvcCheck: described.cvcCheck ?? null,
        acquirerToken: described.token,
        acquirerAdapter: acquirer.name,
        billingName: dto.billing?.name ?? null,
        billingEmail: dto.billing?.email ?? null,
        billingCountry: dto.billing?.country ?? 'CR',
      },
    });

    return toPublicPaymentMethod(method);
  }

  /**
   * Camino servidor-a-servidor. RECIBE EL PAN, con el alcance PCI que eso
   * implica. Solo para comercios ya certificados o adquirentes sin
   * tokenización desde el navegador.
   */
  private async createCard(
    auth: AuthContext,
    dto: CardRawDto,
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
    dto: SinpeDto,
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

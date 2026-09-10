import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Charge, Merchant, PaymentIntent, PrismaClient } from '@colibripay/db';
import { selectAcquirer } from '@colibripay/acquirers';
import {
  assertTransition,
  calculateFee,
  chargeCaptured,
  ColibriError,
  generateClientSecret,
  generateId,
  ID_PREFIXES,
  validateAmount,
  type AcquirerContext,
  type Currency,
  type NextAction,
  type PaymentIntentStatus,
} from '@colibripay/shared';
import { PRISMA } from '../common/prisma.provider.js';
import type { AuthContext } from '../common/request-context.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { EventsService } from '../events/events.service.js';
import {
  toPublicPaymentIntent,
  type PublicPaymentIntent,
} from './payment-intents.serializer.js';
import type {
  CapturePaymentIntentDto,
  ConfirmPaymentIntentDto,
  CreatePaymentIntentDto,
} from './payment-intents.dto.js';

/** Un intent sin confirmar se vence para no dejar autorizaciones colgando. */
const INTENT_TTL_MS = 24 * 60 * 60_000;

@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger('PaymentIntents');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  // -------------------------------------------------------------------------
  // Crear
  // -------------------------------------------------------------------------

  async create(auth: AuthContext, dto: CreatePaymentIntentDto): Promise<PublicPaymentIntent> {
    const amount = BigInt(dto.amount);
    const currency = dto.currency as Currency;

    const problem = validateAmount(amount, currency);
    if (problem) throw ColibriError.invalidRequest(problem, 'amount');

    const merchant = await this.loadMerchant(auth.merchantId);
    const publicId = generateId(ID_PREFIXES.paymentIntent);

    const customer = dto.customerId
      ? await this.resolveCustomer(auth, dto.customerId)
      : null;
    const paymentMethod = dto.paymentMethodId
      ? await this.resolvePaymentMethod(auth, dto.paymentMethodId)
      : null;

    const intent = await this.prisma.paymentIntent.create({
      data: {
        publicId,
        merchantId: auth.merchantId,
        mode: auth.mode,
        amount,
        currency,
        captureMethod: dto.captureMethod,
        setupFutureUsage: dto.setupFutureUsage,
        customerId: customer?.id ?? null,
        paymentMethodId: paymentMethod?.id ?? null,
        status: paymentMethod ? 'REQUIRES_CONFIRMATION' : 'REQUIRES_PAYMENT_METHOD',
        description: dto.description ?? null,
        statementDescriptor: dto.statementDescriptor ?? merchant.statementDescriptor,
        returnUrl: dto.returnUrl ?? null,
        metadata: (dto.metadata ?? {}) as never,
        clientSecret: generateClientSecret(publicId),
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      },
      include: { paymentMethod: true },
    });

    const payload = toPublicPaymentIntent(intent);
    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'payment_intent.created',
      data: payload,
    });

    return payload;
  }

  // -------------------------------------------------------------------------
  // Consultar
  // -------------------------------------------------------------------------

  async retrieve(auth: AuthContext, publicId: string): Promise<PublicPaymentIntent> {
    const intent = await this.loadIntent(auth, publicId);
    return toPublicPaymentIntent(intent);
  }

  // -------------------------------------------------------------------------
  // Confirmar — el camino crítico
  // -------------------------------------------------------------------------

  async confirm(
    auth: AuthContext,
    publicId: string,
    dto: ConfirmPaymentIntentDto,
    requestContext: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<PublicPaymentIntent> {
    const intent = await this.loadIntent(auth, publicId);
    const merchant = await this.loadMerchant(auth.merchantId);

    if (intent.status === 'SUCCEEDED') {
      // Confirmar dos veces no es un error del comercio: suele ser un reintento.
      // Devolver el intent tal cual es más útil que un 409.
      return toPublicPaymentIntent(intent);
    }

    const paymentMethod = dto.paymentMethodId
      ? await this.resolvePaymentMethod(auth, dto.paymentMethodId)
      : intent.paymentMethod;

    if (!paymentMethod) {
      throw ColibriError.invalidRequest(
        'El PaymentIntent no tiene método de pago. Enviá paymentMethodId al confirmar.',
        'paymentMethodId',
      );
    }

    // OJO: cada transición devuelve la fila actualizada y hay que seguir
    // trabajando sobre ELLA. Reusar el objeto original después de un UPDATE
    // hace que la siguiente transición valide contra un estado que ya no
    // existe — y como las transiciones son una cadena, el error aparece dos
    // pasos más adelante y parece otra cosa.
    let current: PaymentIntent = intent;

    // Adjuntar el método de pago ES la transición a REQUIRES_CONFIRMATION.
    // Validarla sin persistirla dejaba el intent en REQUIRES_PAYMENT_METHOD y
    // el salto a PROCESSING fallaba después.
    if (current.status !== 'REQUIRES_CONFIRMATION') {
      current = await this.transition(current, 'REQUIRES_CONFIRMATION', {
        paymentMethodId: paymentMethod.id,
      });
    }

    const acquirer = selectAcquirer({
      methodType: paymentMethod.type,
      currency: intent.currency as Currency,
    });

    const context: AcquirerContext = {
      merchantId: merchant.publicId,
      mode: auth.mode,
      idempotencyKey: `${intent.publicId}:confirm`,
      credentials: {},
    };

    const fee = calculateFee(intent.amount, merchant.feeBps, merchant.feeFixed);
    const reserve = calculateFee(intent.amount, merchant.reserveBps, 0n);

    // El cargo se crea ANTES de llamar al adquirente. Si el proceso muere en el
    // medio, queda la evidencia de que se intentó — que es lo que permite
    // conciliar después contra el estado del banco.
    const charge = await this.prisma.charge.create({
      data: {
        publicId: generateId(ID_PREFIXES.charge),
        merchantId: auth.merchantId,
        mode: auth.mode,
        paymentIntentId: intent.id,
        paymentMethodId: paymentMethod.id,
        status: 'PENDING',
        amount: intent.amount,
        currency: intent.currency,
        feeAmount: fee,
        netAmount: intent.amount - fee,
        acquirerAdapter: acquirer.name,
        ipAddress: requestContext.ipAddress ?? null,
        userAgent: requestContext.userAgent ?? null,
      },
    });

    current = await this.transition(current, 'PROCESSING');

    const result = await acquirer.authorize({
      context,
      reference: charge.publicId,
      amount: intent.amount,
      currency: intent.currency as Currency,
      methodType: paymentMethod.type,
      token: paymentMethod.acquirerToken ?? undefined,
      phoneNumber: paymentMethod.phoneNumber ?? undefined,
      statementDescriptor: intent.statementDescriptor ?? merchant.statementDescriptor,
      manualCapture: intent.captureMethod === 'MANUAL',
      returnUrl: dto.returnUrl ?? intent.returnUrl ?? undefined,
      customer: { ipAddress: requestContext.ipAddress },
    });

    if (result.status === 'declined') {
      return this.failCharge(auth, current, charge, {
        code: 'card_declined',
        declineCode: result.declineCode,
        message: result.rawMessage ?? 'El cobro fue rechazado',
        acquirerCode: result.rawCode,
      });
    }

    if (result.status === 'error') {
      return this.failCharge(auth, current, charge, {
        code: result.retryable ? 'processing_error' : 'api_error',
        message: result.message,
        acquirerCode: result.rawCode,
      });
    }

    // --- Aprobado, pero falta acción del cliente (3DS o redirección) ---
    if (result.pendingAction) {
      const nextAction: NextAction = {
        type: 'redirect_to_url',
        redirectToUrl: {
          url: result.pendingAction.url ?? '',
          returnUrl: dto.returnUrl ?? intent.returnUrl ?? '',
        },
      };

      await this.prisma.charge.update({
        where: { id: charge.id },
        data: {
          acquirerChargeId: result.acquirerChargeId,
          responseCode: result.rawCode ?? null,
          responseMessage: result.rawMessage ?? null,
        },
      });

      const updated = await this.transition(current, 'REQUIRES_ACTION', {
        nextAction: nextAction as never,
      });

      const payload = toPublicPaymentIntent(updated);
      await this.events.emit({
        merchantId: auth.merchantId,
        mode: auth.mode,
        type: 'payment_intent.requires_action',
        data: payload,
      });
      return payload;
    }

    // --- Autorizado limpio ---
    await this.prisma.charge.update({
      where: { id: charge.id },
      data: {
        status: 'AUTHORIZED',
        acquirerChargeId: result.acquirerChargeId,
        authCode: result.authCode,
        rrn: result.rrn ?? null,
        responseCode: result.rawCode ?? null,
        responseMessage: result.rawMessage ?? null,
        rawResponse: (result.raw ?? {}) as never,
        authorizedAt: new Date(),
      },
    });

    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'charge.authorized',
      data: { chargeId: charge.publicId, paymentIntentId: intent.publicId },
    });

    if (current.captureMethod === 'MANUAL') {
      const updated = await this.transition(current, 'REQUIRES_CAPTURE', {
        amountCapturable: current.amount,
      });
      return toPublicPaymentIntent(updated);
    }

    return this.captureCharge(auth, current, charge.id, current.amount, merchant, fee, reserve);
  }

  // -------------------------------------------------------------------------
  // Capturar
  // -------------------------------------------------------------------------

  async capture(
    auth: AuthContext,
    publicId: string,
    dto: CapturePaymentIntentDto,
  ): Promise<PublicPaymentIntent> {
    const intent = await this.loadIntent(auth, publicId);
    const merchant = await this.loadMerchant(auth.merchantId);

    if (intent.status !== 'REQUIRES_CAPTURE') {
      throw ColibriError.invalidState(
        `Solo se puede capturar un PaymentIntent en REQUIRES_CAPTURE; este está en ${intent.status}`,
        intent.publicId,
      );
    }

    const charge = await this.prisma.charge.findFirst({
      where: { paymentIntentId: intent.id, status: 'AUTHORIZED' },
      orderBy: { createdAt: 'desc' },
    });

    if (!charge) {
      throw ColibriError.invalidState(
        'No hay ninguna autorización pendiente de captura para este PaymentIntent',
        intent.publicId,
      );
    }

    const amount = dto.amountToCapture ? BigInt(dto.amountToCapture) : intent.amount;
    if (amount > intent.amount) {
      throw ColibriError.invalidRequest(
        'No se puede capturar más que el monto autorizado',
        'amountToCapture',
      );
    }

    // La comisión se recalcula sobre lo efectivamente capturado, no sobre lo
    // autorizado: en una captura parcial, cobrarle al comercio la comisión del
    // total sería cobrarle de más.
    const fee = calculateFee(amount, merchant.feeBps, merchant.feeFixed);
    const reserve = calculateFee(amount, merchant.reserveBps, 0n);

    return this.captureCharge(auth, intent, charge.id, amount, merchant, fee, reserve);
  }

  // -------------------------------------------------------------------------
  // Cancelar
  // -------------------------------------------------------------------------

  async cancel(auth: AuthContext, publicId: string): Promise<PublicPaymentIntent> {
    const intent = await this.loadIntent(auth, publicId);

    assertTransitionOrFail(intent.status, 'CANCELED', intent.publicId);

    const authorized = await this.prisma.charge.findFirst({
      where: { paymentIntentId: intent.id, status: 'AUTHORIZED' },
    });

    // Anular es más barato que reembolsar y no le aparece al tarjetahabiente
    // como un movimiento seguido de una devolución. Siempre que se pueda, anular.
    if (authorized?.acquirerChargeId) {
      const acquirer = selectAcquirer({
        methodType: 'CARD',
        currency: intent.currency as Currency,
      });
      const result = await acquirer.void({
        context: {
          merchantId: auth.merchantPublicId,
          mode: auth.mode,
          idempotencyKey: `${intent.publicId}:void`,
          credentials: {},
        },
        acquirerChargeId: authorized.acquirerChargeId,
      });

      if (result.status === 'approved') {
        await this.prisma.charge.update({
          where: { id: authorized.id },
          data: { status: 'REVERSED' },
        });
      } else {
        this.logger.warn(
          `No se pudo anular ${authorized.publicId}; el intent se cancela igual y queda para conciliación`,
        );
      }
    }

    const updated = await this.transition(intent, 'CANCELED', {
      canceledAt: new Date(),
      amountCapturable: 0n,
    });

    const payload = toPublicPaymentIntent(updated);
    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'payment_intent.canceled',
      data: payload,
    });
    return payload;
  }

  // -------------------------------------------------------------------------
  // Internos
  // -------------------------------------------------------------------------

  private async captureCharge(
    auth: AuthContext,
    intent: PaymentIntent,
    chargeId: string,
    amount: bigint,
    merchant: Merchant,
    fee: bigint,
    reserve: bigint,
  ): Promise<PublicPaymentIntent> {
    const charge = await this.prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    const acquirer = selectAcquirer({
      methodType: 'CARD',
      currency: intent.currency as Currency,
    });

    const result = await acquirer.capture({
      context: {
        merchantId: merchant.publicId,
        mode: auth.mode,
        idempotencyKey: `${charge.publicId}:capture`,
        credentials: {},
      },
      acquirerChargeId: charge.acquirerChargeId ?? '',
      amount,
      currency: intent.currency as Currency,
    });

    if (result.status !== 'approved') {
      const message =
        result.status === 'declined'
          ? (result.rawMessage ?? 'La captura fue rechazada')
          : result.message;
      return this.failCharge(auth, intent, charge, {
        code: 'capture_failed',
        message,
      });
    }

    await this.prisma.charge.update({
      where: { id: charge.id },
      data: {
        status: 'CAPTURED',
        feeAmount: fee,
        netAmount: amount - fee,
        amount,
        rrn: result.rrn ?? charge.rrn,
        capturedAt: new Date(),
      },
    });

    // El asiento contable se escribe DESPUÉS de que el adquirente confirmó.
    // Escribirlo antes registraría plata que quizá nunca llegue.
    await this.ledger.post({
      merchantId: auth.merchantId,
      mode: auth.mode,
      set: chargeCaptured({
        amount,
        fee,
        reserve,
        currency: intent.currency as Currency,
      }),
      referenceType: 'charge',
      referenceId: charge.id,
    });

    const updated = await this.transition(intent, 'SUCCEEDED', {
      amountReceived: amount,
      amountCapturable: 0n,
      succeededAt: new Date(),
      nextAction: null,
      lastError: null,
    });

    const payload = toPublicPaymentIntent(updated);
    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'charge.captured',
      data: { chargeId: charge.publicId, paymentIntentId: intent.publicId },
    });
    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'payment_intent.succeeded',
      data: payload,
    });

    return payload;
  }

  private async failCharge(
    auth: AuthContext,
    intent: PaymentIntent,
    charge: Charge,
    failure: {
      code: string;
      message: string;
      declineCode?: string;
      acquirerCode?: string;
    },
  ): Promise<PublicPaymentIntent> {
    await this.prisma.charge.update({
      where: { id: charge.id },
      data: {
        status: 'FAILED',
        responseCode: failure.acquirerCode ?? failure.code,
        responseMessage: failure.message,
        failedAt: new Date(),
      },
    });

    // Vuelve a REQUIRES_PAYMENT_METHOD, no a FAILED: un rechazo no termina el
    // intent, deja al comprador probar con otra tarjeta sobre el mismo cobro.
    const updated = await this.transition(intent, 'REQUIRES_PAYMENT_METHOD', {
      lastError: {
        type: failure.declineCode ? 'card_error' : 'api_error',
        code: failure.code,
        message: failure.message,
        ...(failure.declineCode ? { declineCode: failure.declineCode } : {}),
      } as never,
    });

    const payload = toPublicPaymentIntent(updated);
    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'payment_intent.payment_failed',
      data: payload,
    });
    await this.events.emit({
      merchantId: auth.merchantId,
      mode: auth.mode,
      type: 'charge.failed',
      data: { chargeId: charge.publicId, paymentIntentId: intent.publicId },
    });

    return payload;
  }

  private async transition(
    intent: PaymentIntent,
    to: PaymentIntentStatus,
    extra: Record<string, unknown> = {},
  ) {
    assertTransitionOrFail(intent.status, to, intent.publicId);

    return this.prisma.paymentIntent.update({
      where: { id: intent.id },
      data: { status: to, ...extra } as never,
      include: { paymentMethod: true },
    });
  }

  private async loadIntent(auth: AuthContext, publicId: string) {
    const intent = await this.prisma.paymentIntent.findFirst({
      where: { publicId, merchantId: auth.merchantId, mode: auth.mode },
      include: { paymentMethod: true },
    });

    // El filtro por merchantId y mode va en el WHERE, no en un chequeo posterior:
    // así es imposible que un bug futuro deje ver el intent de otro comercio.
    if (!intent) throw ColibriError.notFound('PaymentIntent', publicId);
    return intent;
  }

  private async loadMerchant(merchantId: string): Promise<Merchant> {
    return this.prisma.merchant.findUniqueOrThrow({ where: { id: merchantId } });
  }

  private async resolveCustomer(auth: AuthContext, publicId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { publicId, merchantId: auth.merchantId, mode: auth.mode },
    });
    if (!customer) throw ColibriError.notFound('Customer', publicId);
    return customer;
  }

  private async resolvePaymentMethod(auth: AuthContext, publicId: string) {
    const method = await this.prisma.paymentMethod.findFirst({
      where: { publicId, merchantId: auth.merchantId, mode: auth.mode, detachedAt: null },
    });
    if (!method) throw ColibriError.notFound('PaymentMethod', publicId);
    return method;
  }
}

function assertTransitionOrFail(
  from: string,
  to: PaymentIntentStatus,
  resourceId: string,
): void {
  try {
    assertTransition(from as PaymentIntentStatus, to);
  } catch {
    throw ColibriError.invalidState(
      `No se puede pasar el PaymentIntent de ${from} a ${to}`,
      resourceId,
    );
  }
}

import type { Charge, PaymentIntent, PaymentMethod } from '@colibripay/db';
import type { NextAction } from '@colibripay/shared';

/**
 * Convierte modelos internos a la forma pública.
 *
 * Existe como capa explícita —en vez de devolver la fila de Prisma— porque el
 * modelo interno tiene campos que NO deben salir nunca: `acquirerToken`,
 * `rawResponse` del adquirente, IDs internos. Serializar a mano hace que
 * exponer un campo nuevo sea una decisión y no un descuido al agregar una
 * columna.
 */

export interface PublicPaymentIntent {
  id: string;
  object: 'payment_intent';
  status: string;
  amount: number;
  currency: string;
  amountReceived: number;
  amountCapturable: number;
  amountRefunded: number;
  captureMethod: string;
  clientSecret: string | null;
  customerId: string | null;
  paymentMethod: PublicPaymentMethod | null;
  description: string | null;
  statementDescriptor: string | null;
  nextAction: NextAction | null;
  lastError: unknown;
  metadata: Record<string, unknown>;
  livemode: boolean;
  createdAt: string;
}

export interface PublicPaymentMethod {
  id: string;
  object: 'payment_method';
  type: string;
  card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null;
  sinpe: { phoneNumber: string | null; bankName: string | null } | null;
}

export interface PublicCharge {
  id: string;
  object: 'charge';
  status: string;
  amount: number;
  currency: string;
  feeAmount: number;
  netAmount: number;
  authCode: string | null;
  /** Se expone porque es lo que el comercio necesita para conciliar con su banco. */
  rrn: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
}

export function toPublicPaymentMethod(pm: PaymentMethod): PublicPaymentMethod {
  return {
    id: pm.publicId,
    object: 'payment_method',
    type: pm.type,
    card:
      pm.type === 'CARD'
        ? {
            brand: pm.brand,
            last4: pm.last4,
            expMonth: pm.expMonth,
            expYear: pm.expYear,
          }
        : null,
    sinpe:
      pm.type === 'SINPE_MOVIL'
        ? { phoneNumber: pm.phoneNumber, bankName: pm.bankName }
        : null,
  };
}

export function toPublicPaymentIntent(
  intent: PaymentIntent & { paymentMethod?: PaymentMethod | null },
  options: { includeClientSecret?: boolean } = {},
): PublicPaymentIntent {
  return {
    id: intent.publicId,
    object: 'payment_intent',
    status: intent.status,
    amount: Number(intent.amount),
    currency: intent.currency,
    amountReceived: Number(intent.amountReceived),
    amountCapturable: Number(intent.amountCapturable),
    amountRefunded: Number(intent.amountRefunded),
    captureMethod: intent.captureMethod,
    // El client_secret solo viaja cuando hace falta: al crear el intent y al
    // consultarlo desde el checkout. En un listado no pinta nada.
    clientSecret: options.includeClientSecret === false ? null : intent.clientSecret,
    customerId: intent.customerId,
    paymentMethod: intent.paymentMethod ? toPublicPaymentMethod(intent.paymentMethod) : null,
    description: intent.description,
    statementDescriptor: intent.statementDescriptor,
    nextAction: (intent.nextAction as NextAction | null) ?? null,
    lastError: intent.lastError ?? null,
    metadata: (intent.metadata as Record<string, unknown>) ?? {},
    livemode: intent.mode === 'LIVE',
    createdAt: intent.createdAt.toISOString(),
  };
}

export function toPublicCharge(charge: Charge): PublicCharge {
  return {
    id: charge.publicId,
    object: 'charge',
    status: charge.status,
    amount: Number(charge.amount),
    currency: charge.currency,
    feeAmount: Number(charge.feeAmount),
    netAmount: Number(charge.netAmount),
    authCode: charge.authCode,
    rrn: charge.rrn,
    failureCode: charge.responseCode,
    failureMessage: charge.responseMessage,
    createdAt: charge.createdAt.toISOString(),
  };
}

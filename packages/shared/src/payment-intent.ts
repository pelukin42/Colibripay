/**
 * Máquina de estados del PaymentIntent.
 *
 * Está acá y no dentro del servicio a propósito: el checkout, el dashboard y la
 * API necesitan coincidir en qué transiciones son legales. Una sola definición
 * evita que la UI muestre un botón "Capturar" sobre un estado que el core va a
 * rechazar.
 */

export const PAYMENT_INTENT_STATUSES = [
  'REQUIRES_PAYMENT_METHOD',
  'REQUIRES_CONFIRMATION',
  'REQUIRES_ACTION',
  'PROCESSING',
  'REQUIRES_CAPTURE',
  'SUCCEEDED',
  'CANCELED',
  'FAILED',
] as const;

export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * Transiciones permitidas. Todo lo que no esté acá es un bug, no un caso borde.
 *
 * Nótese que SUCCEEDED y CANCELED son terminales: un cargo exitoso no "vuelve"
 * a otro estado ni siquiera al reembolsarse — el reembolso es un objeto aparte
 * que ajusta `amountRefunded`. Confundir esas dos cosas es el origen clásico de
 * los descuadres de ledger.
 */
const TRANSITIONS: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  REQUIRES_PAYMENT_METHOD: ['REQUIRES_CONFIRMATION', 'CANCELED'],
  REQUIRES_CONFIRMATION: [
    'REQUIRES_ACTION',
    'PROCESSING',
    'REQUIRES_PAYMENT_METHOD',
    'CANCELED',
  ],
  REQUIRES_ACTION: ['PROCESSING', 'REQUIRES_PAYMENT_METHOD', 'CANCELED', 'FAILED'],
  PROCESSING: ['SUCCEEDED', 'REQUIRES_CAPTURE', 'REQUIRES_PAYMENT_METHOD', 'FAILED'],
  REQUIRES_CAPTURE: ['PROCESSING', 'SUCCEEDED', 'CANCELED'],
  SUCCEEDED: [],
  CANCELED: [],
  // Un fallo admite otro intento con distinto método: es un rechazo, no el fin del intent.
  FAILED: ['REQUIRES_PAYMENT_METHOD', 'CANCELED'],
};

export function canTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: PaymentIntentStatus,
  to: PaymentIntentStatus,
): void {
  if (!canTransition(from, to)) {
    throw new Error(`Transición inválida del PaymentIntent: ${from} -> ${to}`);
  }
}

export function isTerminal(status: PaymentIntentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** ¿El cliente todavía tiene que hacer algo en el navegador? */
export function requiresCustomerAction(status: PaymentIntentStatus): boolean {
  return (
    status === 'REQUIRES_PAYMENT_METHOD' ||
    status === 'REQUIRES_CONFIRMATION' ||
    status === 'REQUIRES_ACTION'
  );
}

/**
 * Lo que el intent le pide al cliente. El checkout hace un switch exhaustivo
 * sobre `type`, así que agregar un caso acá rompe la compilación allá — que es
 * exactamente lo que queremos.
 */
export type NextAction =
  | { type: 'redirect_to_url'; redirectToUrl: { url: string; returnUrl: string } }
  | {
      type: 'use_3ds_challenge';
      threeDs: { acsUrl: string; creq: string; sessionId: string };
    }
  | {
      type: 'display_sinpe_instructions';
      sinpe: {
        phoneNumber: string;
        holderName: string;
        reference: string;
        amountLabel: string;
        expiresAt: string;
      };
    }
  | {
      type: 'display_bank_transfer_instructions';
      bankTransfer: {
        bankName: string;
        iban: string;
        holderName: string;
        reference: string;
        amountLabel: string;
        expiresAt: string;
      };
    };

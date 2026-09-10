/**
 * Reglas de asiento contable.
 *
 * Funciones puras: reciben un hecho económico y devuelven los asientos que lo
 * representan. No tocan la base de datos. Esa separación es lo que permite
 * probar exhaustivamente la parte que de verdad importa —que la plata cuadre—
 * sin levantar Postgres.
 *
 * CONVENCIÓN DE SIGNO: positivo = débito, negativo = crédito.
 * Un solo campo con signo hace que "el asiento cuadra" sea literalmente
 * SUM(amount) = 0, sin tener que interpretar un enum de dirección.
 *
 * Naturaleza de las cuentas (por qué los signos caen donde caen):
 *   - ACQUIRER_RECEIVABLE es un ACTIVO. Un cobro exitoso lo aumenta (débito).
 *   - MERCHANT_PENDING / MERCHANT_AVAILABLE / RESERVE / PAYOUTS_PAYABLE son
 *     PASIVOS: plata que le debemos al comercio. Aumentan con crédito.
 *   - PLATFORM_FEE_REVENUE es INGRESO. Aumenta con crédito.
 *
 * Consecuencia práctica: el saldo almacenado de una cuenta de pasivo es
 * negativo. Es contabilidad correcta pero confunde en una UI, así que usá
 * `displayBalance()` antes de mostrarlo.
 */

import type { Currency } from './money.js';

export const LEDGER_ACCOUNT_TYPES = [
  'ACQUIRER_RECEIVABLE',
  'MERCHANT_PENDING',
  'MERCHANT_AVAILABLE',
  'PLATFORM_FEE_REVENUE',
  'PAYOUTS_PAYABLE',
  'RESERVE',
  'CHARGEBACK_LOSS',
] as const;

export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

export const LEDGER_TRANSACTION_KINDS = [
  'CHARGE_CAPTURED',
  'CHARGE_REFUNDED',
  'FEE_APPLIED',
  'FUNDS_RELEASED',
  'PAYOUT_CREATED',
  'PAYOUT_SETTLED',
  'PAYOUT_FAILED',
  'DISPUTE_OPENED',
  'DISPUTE_WON',
  'DISPUTE_LOST',
  'ADJUSTMENT',
] as const;

export type LedgerTransactionKind = (typeof LEDGER_TRANSACTION_KINDS)[number];

/** `debit` = el saldo sube con débito (activos). `credit` = sube con crédito (pasivos, ingresos). */
const ACCOUNT_NATURE: Record<LedgerAccountType, 'debit' | 'credit'> = {
  ACQUIRER_RECEIVABLE: 'debit',
  CHARGEBACK_LOSS: 'debit',
  MERCHANT_PENDING: 'credit',
  MERCHANT_AVAILABLE: 'credit',
  PLATFORM_FEE_REVENUE: 'credit',
  PAYOUTS_PAYABLE: 'credit',
  RESERVE: 'credit',
};

/**
 * Convierte el saldo interno a un número presentable.
 * Un comercio con ₡50.000 disponibles tiene saldo interno -5000000n; esto
 * devuelve 5000000n.
 */
export function displayBalance(type: LedgerAccountType, balance: bigint): bigint {
  return ACCOUNT_NATURE[type] === 'credit' ? -balance : balance;
}

/** `merchant` = la cuenta pertenece al comercio; `platform` = es nuestra. */
export type PostingScope = 'merchant' | 'platform';

export interface Posting {
  account: LedgerAccountType;
  scope: PostingScope;
  /** Positivo = débito, negativo = crédito. Nunca cero. */
  amount: bigint;
}

export interface PostingSet {
  kind: LedgerTransactionKind;
  currency: Currency;
  postings: Posting[];
  description: string;
}

export class UnbalancedLedgerError extends Error {
  constructor(readonly delta: bigint, readonly postings: readonly Posting[]) {
    super(
      `Asiento descuadrado por ${delta}. Postings: ` +
        postings.map((p) => `${p.account}:${p.amount}`).join(', '),
    );
    this.name = 'UnbalancedLedgerError';
  }
}

/**
 * La única puerta por la que puede pasar un asiento. Se llama en cada
 * constructor de este archivo y otra vez en el servicio antes de escribir, para
 * que ni un bug futuro ni una migración a mano puedan meter un asiento torcido.
 */
export function assertBalanced(postings: readonly Posting[]): void {
  if (postings.length < 2) {
    throw new Error('Un asiento necesita al menos dos movimientos');
  }
  if (postings.some((p) => p.amount === 0n)) {
    throw new Error('Un movimiento en cero no representa nada; omitilo');
  }
  const delta = postings.reduce((sum, p) => sum + p.amount, 0n);
  if (delta !== 0n) {
    throw new UnbalancedLedgerError(delta, postings);
  }
}

function build(
  kind: LedgerTransactionKind,
  currency: Currency,
  description: string,
  postings: Posting[],
): PostingSet {
  const cleaned = postings.filter((p) => p.amount !== 0n);
  assertBalanced(cleaned);
  return { kind, currency, description, postings: cleaned };
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

/**
 * Cobro capturado.
 *
 * El adquirente nos debe el bruto; de ahí sale nuestra comisión, la reserva de
 * riesgo (si el comercio tiene) y el resto queda como saldo pendiente del
 * comercio hasta que venza la retención T+N.
 */
export function chargeCaptured(params: {
  amount: bigint;
  fee: bigint;
  reserve?: bigint;
  currency: Currency;
}): PostingSet {
  const { amount, fee, currency } = params;
  const reserve = params.reserve ?? 0n;

  if (amount <= 0n) throw new Error('El monto capturado debe ser positivo');
  if (fee < 0n || reserve < 0n) throw new Error('Comisión y reserva no pueden ser negativas');

  const toMerchant = amount - fee - reserve;
  if (toMerchant < 0n) {
    throw new Error(
      `La comisión (${fee}) más la reserva (${reserve}) superan el monto cobrado (${amount})`,
    );
  }

  return build('CHARGE_CAPTURED', currency, 'Cobro capturado', [
    { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount },
    { account: 'PLATFORM_FEE_REVENUE', scope: 'platform', amount: -fee },
    { account: 'RESERVE', scope: 'merchant', amount: -reserve },
    { account: 'MERCHANT_PENDING', scope: 'merchant', amount: -toMerchant },
  ]);
}

/**
 * Vence la retención: los fondos pasan de pendientes a disponibles.
 * No cambia cuánto le debemos al comercio, solo en qué bolsillo está.
 */
export function fundsReleased(params: { amount: bigint; currency: Currency }): PostingSet {
  if (params.amount <= 0n) throw new Error('El monto liberado debe ser positivo');

  return build('FUNDS_RELEASED', params.currency, 'Fondos liberados', [
    { account: 'MERCHANT_PENDING', scope: 'merchant', amount: params.amount },
    { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: -params.amount },
  ]);
}

/**
 * Reembolso.
 *
 * Por defecto la comisión NO se devuelve: es la práctica de la industria y
 * refleja que el procesamiento ya ocurrió y ya se pagó. `refundFee` permite
 * devolverla cuando el comercio así lo pacte.
 */
export function chargeRefunded(params: {
  amount: bigint;
  currency: Currency;
  refundedFee?: bigint;
}): PostingSet {
  const { amount, currency } = params;
  const refundedFee = params.refundedFee ?? 0n;

  if (amount <= 0n) throw new Error('El monto reembolsado debe ser positivo');
  if (refundedFee < 0n) throw new Error('La comisión devuelta no puede ser negativa');

  // Al comercio se le descuenta el bruto y se le reintegra la comisión devuelta.
  const fromMerchant = amount - refundedFee;

  return build('CHARGE_REFUNDED', currency, 'Cobro reembolsado', [
    { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: fromMerchant },
    { account: 'PLATFORM_FEE_REVENUE', scope: 'platform', amount: refundedFee },
    { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: -amount },
  ]);
}

/** Se emite un payout: la deuda pasa de "saldo del comercio" a "transferencia en camino". */
export function payoutCreated(params: { amount: bigint; currency: Currency }): PostingSet {
  if (params.amount <= 0n) throw new Error('El monto del payout debe ser positivo');

  return build('PAYOUT_CREATED', params.currency, 'Payout emitido', [
    { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: params.amount },
    { account: 'PAYOUTS_PAYABLE', scope: 'merchant', amount: -params.amount },
  ]);
}

/** El banco confirmó el depósito: sale plata de verdad. */
export function payoutSettled(params: { amount: bigint; currency: Currency }): PostingSet {
  if (params.amount <= 0n) throw new Error('El monto del payout debe ser positivo');

  return build('PAYOUT_SETTLED', params.currency, 'Payout liquidado', [
    { account: 'PAYOUTS_PAYABLE', scope: 'merchant', amount: params.amount },
    { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: -params.amount },
  ]);
}

/** El payout rebotó: la plata vuelve al saldo disponible del comercio. */
export function payoutFailed(params: { amount: bigint; currency: Currency }): PostingSet {
  if (params.amount <= 0n) throw new Error('El monto del payout debe ser positivo');

  return build('PAYOUT_FAILED', params.currency, 'Payout fallido, fondos devueltos', [
    { account: 'PAYOUTS_PAYABLE', scope: 'merchant', amount: params.amount },
    { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: -params.amount },
  ]);
}

/**
 * Contracargo perdido: se le descuenta al comercio el monto disputado más la
 * comisión de contracargo, si aplica.
 */
export function disputeLost(params: {
  amount: bigint;
  currency: Currency;
  disputeFee?: bigint;
}): PostingSet {
  const { amount, currency } = params;
  const disputeFee = params.disputeFee ?? 0n;

  if (amount <= 0n) throw new Error('El monto disputado debe ser positivo');
  if (disputeFee < 0n) throw new Error('La comisión de disputa no puede ser negativa');

  return build('DISPUTE_LOST', currency, 'Contracargo perdido', [
    { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: amount + disputeFee },
    { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: -amount },
    { account: 'PLATFORM_FEE_REVENUE', scope: 'platform', amount: -disputeFee },
  ]);
}

/**
 * Contracargo ganado.
 *
 * Solo devuelve la comisión de disputa si se había cobrado. El monto en sí
 * nunca salió del ledger: al abrirse la disputa no se movió plata, así que acá
 * no hay nada que reintegrar por ese lado.
 */
export function disputeWon(params: {
  currency: Currency;
  refundedDisputeFee: bigint;
}): PostingSet {
  if (params.refundedDisputeFee <= 0n) {
    throw new Error('Sin comisión que devolver, un contracargo ganado no genera asiento');
  }

  return build('DISPUTE_WON', params.currency, 'Contracargo ganado', [
    { account: 'PLATFORM_FEE_REVENUE', scope: 'platform', amount: params.refundedDisputeFee },
    { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: -params.refundedDisputeFee },
  ]);
}

/**
 * Ajuste manual. Existe porque siempre aparece un caso que las reglas no
 * cubren, y es preferible un asiento explícito y auditable a un UPDATE a mano
 * sobre la tabla de saldos.
 */
export function adjustment(params: {
  currency: Currency;
  postings: Posting[];
  description: string;
}): PostingSet {
  return build('ADJUSTMENT', params.currency, params.description, params.postings);
}

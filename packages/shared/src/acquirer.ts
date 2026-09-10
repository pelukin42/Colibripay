/**
 * Contrato con el adquirente.
 *
 * Esta es la apuesta arquitectónica central del proyecto: el core de pagos no
 * sabe con quién habla. Habla con un `AcquirerAdapter`. Cuando exista contrato
 * con BAC, Promerica o quien sea, se escribe un adaptador nuevo y el core no se
 * toca — ni el ledger, ni los webhooks, ni el checkout.
 *
 * Reglas que todo adaptador debe respetar:
 *
 *  1. NUNCA recibe ni devuelve PAN, CVV ni datos de banda. `tokenize()` es el
 *     único punto de contacto con datos de tarjeta y su implementación debe
 *     delegar en el vault del adquirente, no manipularlos acá.
 *  2. Un rechazo del emisor NO es una excepción: es un resultado `declined`.
 *     Las excepciones se reservan para fallos de transporte o del adaptador.
 *  3. Toda operación acepta `idempotencyKey` y debe propagarla al adquirente si
 *     este la soporta. Si no la soporta, el adaptador documenta cómo evita el
 *     doble cobro.
 */

import type { Currency } from './money.js';
import type { DeclineCode } from './errors.js';

export type AcquirerPaymentMethodType = 'CARD' | 'SINPE_MOVIL' | 'BANK_TRANSFER';

// ---------------------------------------------------------------------------
// Resultados
// ---------------------------------------------------------------------------

/**
 * Toda operación devuelve una de estas tres formas. El core hace un switch
 * exhaustivo sobre `status`, así que un adaptador no puede "olvidar" un caso.
 */
export type AcquirerResult<T> =
  | ({ status: 'approved' } & T)
  | {
      status: 'declined';
      declineCode: DeclineCode;
      /** Código crudo del adquirente, para soporte y conciliación. */
      rawCode?: string;
      rawMessage?: string;
    }
  | {
      status: 'error';
      /** `true` si reintentar la MISMA operación es seguro (timeout, 5xx). */
      retryable: boolean;
      message: string;
      rawCode?: string;
    };

export interface AuthorizationData {
  /** ID de la transacción en el sistema del adquirente. */
  acquirerChargeId: string;
  authCode: string;
  /** Retrieval Reference Number — la llave para conciliar contra el banco. */
  rrn?: string;
  rawCode?: string;
  rawMessage?: string;
  /** Respuesta cruda YA saneada de datos sensibles. Se guarda en `charges.rawResponse`. */
  raw?: Record<string, unknown>;
}

export interface CaptureData {
  acquirerChargeId: string;
  capturedAmount: bigint;
  rrn?: string;
  raw?: Record<string, unknown>;
}

export interface RefundData {
  acquirerRefundId: string;
  refundedAmount: bigint;
  raw?: Record<string, unknown>;
}

export interface TokenData {
  /** Token opaco. Es lo único con lo que el core puede volver a cobrar. */
  token: string;
  brand: string;
  last4: string;
  bin: string;
  expMonth: number;
  expYear: number;
  /** Huella estable: identifica la misma tarjeta sin guardar el número. */
  fingerprint?: string;
  cvcCheck?: 'pass' | 'fail' | 'unavailable';
}

/**
 * Cuando el emisor pide 3-D Secure, `authorize()` devuelve `approved` con
 * `pendingAction`. El core pasa el intent a REQUIRES_ACTION y el checkout se
 * encarga; la autorización se completa después vía `resumeAuthorization()`.
 */
export interface PendingAction {
  kind: 'three_ds_challenge' | 'redirect' | 'offline_instructions';
  url?: string;
  payload?: Record<string, string>;
  /** Referencia opaca que hay que devolverle al adaptador para retomar el flujo. */
  sessionRef: string;
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Peticiones
// ---------------------------------------------------------------------------

export interface AcquirerContext {
  merchantId: string;
  mode: 'TEST' | 'LIVE';
  idempotencyKey: string;
  /** Credenciales del comercio ante el adquirente (MID/TID), ya desencriptadas. */
  credentials: Record<string, string>;
}

/**
 * Datos crudos de tarjeta. SOLO existe en el borde de tokenización, viajando
 * desde el iframe del checkout hacia el vault. Ninguna otra parte del sistema
 * debe aceptar este tipo, y nunca se persiste.
 */
export interface RawCardInput {
  number: string;
  expMonth: number;
  expYear: number;
  cvc: string;
  holderName?: string;
}

export interface TokenizeRequest {
  context: AcquirerContext;
  card: RawCardInput;
  billing?: { name?: string; email?: string; country?: string };
}

export interface AuthorizeRequest {
  context: AcquirerContext;
  /** Nuestro ID público de cargo. Se envía como referencia del comercio. */
  reference: string;
  amount: bigint;
  currency: Currency;
  methodType: AcquirerPaymentMethodType;
  /** Token del vault. Requerido para CARD. */
  token?: string;
  /** Para SINPE_MOVIL. */
  phoneNumber?: string;
  /** Máx. 22 caracteres — lo que ve el tarjetahabiente en su estado de cuenta. */
  statementDescriptor: string;
  /** `false` = autorizar y capturar en una sola operación. */
  manualCapture: boolean;
  /** URL a la que vuelve el cliente tras 3DS. */
  returnUrl?: string;
  customer?: { email?: string; name?: string; ipAddress?: string };
  metadata?: Record<string, string>;
}

export interface CaptureRequest {
  context: AcquirerContext;
  acquirerChargeId: string;
  /** Captura parcial: menor o igual al monto autorizado. */
  amount: bigint;
  currency: Currency;
}

export interface VoidRequest {
  context: AcquirerContext;
  acquirerChargeId: string;
}

export interface RefundRequest {
  context: AcquirerContext;
  acquirerChargeId: string;
  amount: bigint;
  currency: Currency;
  reference: string;
  reason?: string;
}

export interface ResumeAuthorizationRequest {
  context: AcquirerContext;
  sessionRef: string;
  /** Lo que devolvió el ACS tras el desafío 3DS. */
  payload: Record<string, string>;
}

/**
 * Una línea del archivo de liquidación del adquirente. Conciliar esto contra
 * nuestros `charges` es lo que detecta cobros que creemos exitosos y el banco
 * no, que es el error más caro que puede tener una pasarela.
 */
export interface SettlementRecord {
  acquirerChargeId: string;
  rrn?: string;
  reference?: string;
  grossAmount: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  currency: Currency;
  transactionDate: Date;
  settlementDate: Date;
  type: 'sale' | 'refund' | 'chargeback' | 'adjustment';
}

// ---------------------------------------------------------------------------
// La interfaz
// ---------------------------------------------------------------------------

export interface AcquirerAdapter {
  /** Identificador estable. Se persiste en `charges.acquirerAdapter`. */
  readonly name: string;
  readonly supportedMethods: readonly AcquirerPaymentMethodType[];
  readonly supportedCurrencies: readonly Currency[];
  /** `false` si el adquirente solo hace venta directa (sin auth/capture en dos pasos). */
  readonly supportsManualCapture: boolean;
  readonly supportsPartialRefund: boolean;

  tokenize(req: TokenizeRequest): Promise<AcquirerResult<TokenData>>;

  authorize(
    req: AuthorizeRequest,
  ): Promise<AcquirerResult<AuthorizationData & { pendingAction?: PendingAction }>>;

  /** Retoma una autorización que quedó esperando 3DS o una redirección. */
  resumeAuthorization(
    req: ResumeAuthorizationRequest,
  ): Promise<AcquirerResult<AuthorizationData>>;

  capture(req: CaptureRequest): Promise<AcquirerResult<CaptureData>>;

  /** Anula una autorización no capturada. Más barato que reembolsar. */
  void(req: VoidRequest): Promise<AcquirerResult<{ acquirerChargeId: string }>>;

  refund(req: RefundRequest): Promise<AcquirerResult<RefundData>>;

  /** Liquidación del día. Vacío si el adquirente no publica archivo. */
  fetchSettlement(date: Date, context: AcquirerContext): Promise<SettlementRecord[]>;

  /** Sonda para el health check. */
  ping(): Promise<boolean>;
}

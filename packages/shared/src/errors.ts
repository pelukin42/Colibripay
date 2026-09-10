/**
 * Errores de la API pública.
 *
 * El formato imita el de las pasarelas establecidas por una razón práctica: los
 * desarrolladores que integran ya conocen la forma `{ error: { type, code,
 * message } }`, y los códigos de rechazo estándar les permiten reutilizar la
 * lógica de manejo que ya tienen escrita.
 */

export type ApiErrorType =
  | 'api_error' // fallo nuestro
  | 'card_error' // la tarjeta fue rechazada — mostrable al comprador
  | 'invalid_request_error' // el comercio mandó algo mal
  | 'authentication_error'
  | 'idempotency_error'
  | 'rate_limit_error';

/**
 * Códigos de rechazo. `insufficient_funds` y `do_not_honor` cubren la enorme
 * mayoría de los rechazos reales; el resto existe para que el comercio pueda
 * decidir si reintentar (rechazo suave) o no (rechazo duro).
 */
export const DECLINE_CODES = {
  insufficient_funds: 'Fondos insuficientes',
  do_not_honor: 'El banco emisor rechazó el cobro',
  expired_card: 'La tarjeta está vencida',
  incorrect_cvc: 'El código de seguridad es incorrecto',
  incorrect_number: 'El número de tarjeta es incorrecto',
  invalid_expiry: 'La fecha de vencimiento es inválida',
  lost_card: 'La tarjeta fue reportada como extraviada',
  stolen_card: 'La tarjeta fue reportada como robada',
  fraudulent: 'El cobro fue marcado como fraudulento',
  card_not_supported: 'La tarjeta no admite este tipo de compra',
  currency_not_supported: 'La tarjeta no admite esta moneda',
  restricted_card: 'La tarjeta tiene restricciones de uso',
  processing_error: 'Error al procesar el cobro',
  issuer_unavailable: 'No se pudo contactar al banco emisor',
  authentication_required: 'El banco requiere autenticación 3-D Secure',
} as const;

export type DeclineCode = keyof typeof DECLINE_CODES;

/** Rechazos que vale la pena reintentar: el mismo cobro puede pasar más tarde. */
export const SOFT_DECLINES: readonly DeclineCode[] = [
  'issuer_unavailable',
  'processing_error',
  'do_not_honor',
];

export function isSoftDecline(code: DeclineCode): boolean {
  return SOFT_DECLINES.includes(code);
}

export interface ApiErrorBody {
  type: ApiErrorType;
  code: string;
  message: string;
  /** Campo del request que causó el problema, en errores de validación. */
  param?: string;
  declineCode?: DeclineCode;
  /** ID del objeto relacionado — típicamente el PaymentIntent que falló. */
  resourceId?: string;
  /** Para correlacionar con nuestros logs al abrir un ticket. */
  requestId?: string;
  docUrl?: string;
}

export class ColibriError extends Error {
  readonly type: ApiErrorType;
  readonly code: string;
  readonly statusCode: number;
  readonly param?: string;
  readonly declineCode?: DeclineCode;
  readonly resourceId?: string;

  constructor(params: {
    type: ApiErrorType;
    code: string;
    message: string;
    statusCode: number;
    param?: string;
    declineCode?: DeclineCode;
    resourceId?: string;
  }) {
    super(params.message);
    this.name = 'ColibriError';
    this.type = params.type;
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.param = params.param;
    this.declineCode = params.declineCode;
    this.resourceId = params.resourceId;
  }

  toBody(requestId?: string): { error: ApiErrorBody } {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param ? { param: this.param } : {}),
        ...(this.declineCode ? { declineCode: this.declineCode } : {}),
        ...(this.resourceId ? { resourceId: this.resourceId } : {}),
        ...(requestId ? { requestId } : {}),
      },
    };
  }

  static cardDeclined(declineCode: DeclineCode, resourceId?: string): ColibriError {
    return new ColibriError({
      type: 'card_error',
      code: 'card_declined',
      message: DECLINE_CODES[declineCode],
      statusCode: 402,
      declineCode,
      resourceId,
    });
  }

  static invalidRequest(message: string, param?: string): ColibriError {
    return new ColibriError({
      type: 'invalid_request_error',
      code: 'parameter_invalid',
      message,
      statusCode: 400,
      param,
    });
  }

  static notFound(resource: string, id: string): ColibriError {
    return new ColibriError({
      type: 'invalid_request_error',
      code: 'resource_missing',
      message: `No existe ${resource} con ID ${id}`,
      statusCode: 404,
      resourceId: id,
    });
  }

  static unauthorized(message = 'La llave de API es inválida o fue revocada'): ColibriError {
    return new ColibriError({
      type: 'authentication_error',
      code: 'invalid_api_key',
      message,
      statusCode: 401,
    });
  }

  /** Misma llave de idempotencia, cuerpo distinto: es un bug del cliente. */
  static idempotencyConflict(key: string): ColibriError {
    return new ColibriError({
      type: 'idempotency_error',
      code: 'idempotency_key_reused',
      message:
        `La llave de idempotencia "${key}" ya se usó con parámetros distintos. ` +
        'Usá una llave nueva para cada operación diferente.',
      statusCode: 422,
    });
  }

  /** La petición original con esa llave todavía está en vuelo. */
  static idempotencyInFlight(key: string): ColibriError {
    return new ColibriError({
      type: 'idempotency_error',
      code: 'idempotency_key_in_progress',
      message: `Ya hay una petición en curso con la llave "${key}". Reintentá en unos segundos.`,
      statusCode: 409,
    });
  }

  static invalidState(message: string, resourceId?: string): ColibriError {
    return new ColibriError({
      type: 'invalid_request_error',
      code: 'resource_state_invalid',
      message,
      statusCode: 409,
      resourceId,
    });
  }

  static rateLimited(retryAfterSeconds: number): ColibriError {
    return new ColibriError({
      type: 'rate_limit_error',
      code: 'rate_limit_exceeded',
      message: `Demasiadas peticiones. Reintentá en ${retryAfterSeconds} segundos.`,
      statusCode: 429,
    });
  }

  static internal(message = 'Ocurrió un error inesperado al procesar la petición'): ColibriError {
    return new ColibriError({
      type: 'api_error',
      code: 'internal_error',
      message,
      statusCode: 500,
    });
  }
}

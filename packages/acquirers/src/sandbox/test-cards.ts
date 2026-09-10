import type { DeclineCode } from '@colibripay/shared';

/**
 * Tarjetas de prueba con comportamiento determinista.
 *
 * Que un número siempre produzca el mismo resultado es lo que hace posible
 * escribir tests de integración de verdad y que el comercio pueda reproducir un
 * rechazo concreto sin depender del humor del sandbox del banco.
 */

export type SandboxBehavior =
  | { kind: 'approve' }
  | { kind: 'decline'; declineCode: DeclineCode }
  | { kind: 'require_3ds'; thenApprove: boolean }
  | { kind: 'error'; retryable: boolean; message: string }
  /** Aprueba, pero abre un contracargo a los 30 s. Para probar el flujo de disputas. */
  | { kind: 'approve_then_dispute' }
  /** Autoriza, pero la captura falla. Reproduce el caso más incómodo de conciliar. */
  | { kind: 'approve_then_capture_fails' }
  /** Nunca responde: dispara el timeout del adaptador. */
  | { kind: 'timeout' };

export const TEST_CARDS: Record<string, SandboxBehavior> = {
  // --- Aprobadas ---
  '4242424242424242': { kind: 'approve' }, // Visa
  '4000000000000077': { kind: 'approve' }, // Visa débito
  '5555555555554444': { kind: 'approve' }, // Mastercard
  '5200828282828210': { kind: 'approve' }, // Mastercard débito
  '378282246310005': { kind: 'approve' }, //  Amex

  // --- Rechazos ---
  '4000000000000002': { kind: 'decline', declineCode: 'do_not_honor' },
  '4000000000009995': { kind: 'decline', declineCode: 'insufficient_funds' },
  '4000000000000069': { kind: 'decline', declineCode: 'expired_card' },
  '4000000000000127': { kind: 'decline', declineCode: 'incorrect_cvc' },
  '4000000000000101': { kind: 'decline', declineCode: 'fraudulent' },
  '4000000000009987': { kind: 'decline', declineCode: 'lost_card' },
  '4000000000009979': { kind: 'decline', declineCode: 'stolen_card' },
  '4000000000000036': { kind: 'decline', declineCode: 'card_not_supported' },

  // --- 3-D Secure ---
  '4000000000003220': { kind: 'require_3ds', thenApprove: true },
  '4000000000003063': { kind: 'require_3ds', thenApprove: false },

  // --- Casos borde que rompen integraciones mal hechas ---
  '4000000000000119': { kind: 'error', retryable: true, message: 'Emisor no disponible' },
  '4000000000000259': { kind: 'approve_then_dispute' },
  '4000000000000341': { kind: 'approve_then_capture_fails' },
  '4000000000000010': { kind: 'timeout' },
};

/** Comportamiento por defecto de cualquier número válido que no esté en la tabla. */
export const DEFAULT_BEHAVIOR: SandboxBehavior = { kind: 'approve' };

export function behaviorFor(cardNumber: string): SandboxBehavior {
  return TEST_CARDS[cardNumber.replace(/\D/g, '')] ?? DEFAULT_BEHAVIOR;
}

/**
 * Algoritmo de Luhn. El sandbox lo valida igual que un adquirente real: si no
 * lo hiciéramos, el comercio descubriría en producción que su formulario deja
 * pasar números imposibles.
 */
export function isLuhnValid(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectBrand(cardNumber: string): string {
  const n = cardNumber.replace(/\D/g, '');
  if (/^4/.test(n)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'mastercard';
  if (/^3[47]/.test(n)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(n)) return 'discover';
  return 'unknown';
}

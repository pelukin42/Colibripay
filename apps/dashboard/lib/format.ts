import { formatAmount, type Currency } from '@colibripay/shared';
import type { Mode } from '@colibripay/db';

export function money(amount: bigint, currency: string): string {
  return formatAmount(amount, currency as Currency);
}

export function when(date: Date): string {
  return new Intl.DateTimeFormat('es-CR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function whenLong(date: Date): string {
  return new Intl.DateTimeFormat('es-CR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(date);
}

/**
 * El modo viaja por query string y por defecto es TEST.
 *
 * El default importa: si el dashboard abriera en LIVE, alguien podría creer que
 * está mirando cobros reales cuando recién integra, o al revés. Entrar siempre
 * en pruebas y tener que pedir explícitamente los datos reales es el lado
 * seguro del error.
 */
export function resolveMode(raw: string | undefined): Mode {
  return raw?.toUpperCase() === 'LIVE' ? 'LIVE' : 'TEST';
}

const INTENT_LABELS: Record<string, { text: string; tone: string }> = {
  SUCCEEDED: { text: 'Completado', tone: 'ok' },
  PROCESSING: { text: 'Procesando', tone: 'wait' },
  REQUIRES_ACTION: { text: 'Requiere verificación', tone: 'wait' },
  REQUIRES_CAPTURE: { text: 'Por capturar', tone: 'wait' },
  REQUIRES_CONFIRMATION: { text: 'Sin confirmar', tone: 'mute' },
  REQUIRES_PAYMENT_METHOD: { text: 'Sin completar', tone: 'mute' },
  CANCELED: { text: 'Cancelado', tone: 'mute' },
  FAILED: { text: 'Fallido', tone: 'bad' },
};

export function intentLabel(status: string): { text: string; tone: string } {
  return INTENT_LABELS[status] ?? { text: status, tone: 'mute' };
}

const CHARGE_LABELS: Record<string, { text: string; tone: string }> = {
  CAPTURED: { text: 'Capturado', tone: 'ok' },
  AUTHORIZED: { text: 'Autorizado', tone: 'wait' },
  PENDING: { text: 'Pendiente', tone: 'mute' },
  FAILED: { text: 'Fallido', tone: 'bad' },
  REVERSED: { text: 'Anulado', tone: 'mute' },
};

export function chargeLabel(status: string): { text: string; tone: string } {
  return CHARGE_LABELS[status] ?? { text: status, tone: 'mute' };
}

export function cardLabel(pm: {
  type: string;
  brand: string | null;
  last4: string | null;
  phoneNumber: string | null;
} | null): string {
  if (!pm) return '—';
  if (pm.type === 'CARD') {
    const brand = pm.brand ? pm.brand[0]!.toUpperCase() + pm.brand.slice(1) : 'Tarjeta';
    return `${brand} ····${pm.last4 ?? '????'}`;
  }
  if (pm.type === 'SINPE_MOVIL') return `SINPE ${pm.phoneNumber ?? ''}`.trim();
  return 'Transferencia';
}

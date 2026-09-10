/**
 * Catálogo de eventos. Es contrato público: los comercios se suscriben a estos
 * nombres, así que renombrar uno rompe integraciones ajenas. Se agregan
 * eventos; no se renombran ni se borran sin versionar la API.
 */

export const EVENT_TYPES = [
  'payment_intent.created',
  'payment_intent.requires_action',
  'payment_intent.processing',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',

  'charge.authorized',
  'charge.captured',
  'charge.failed',
  'charge.refunded',

  'refund.created',
  'refund.succeeded',
  'refund.failed',

  'dispute.created',
  'dispute.updated',
  'dispute.closed',

  'payout.created',
  'payout.paid',
  'payout.failed',

  'customer.created',
  'customer.updated',
  'payment_method.attached',
  'payment_method.detached',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/** Versión del formato de los objetos que van en `event.data`. */
export const API_VERSION = '2026-01-01';

/**
 * Cabecera de firma de los webhooks: `t=<unix>,v1=<hmac-sha256-hex>`.
 *
 * El timestamp va DENTRO de la carga firmada (`${t}.${body}`) para que un
 * atacante no pueda reproducir una entrega vieja cambiándole la hora. El
 * receptor debe rechazar timestamps con más de 5 minutos de desfase y comparar
 * la firma en tiempo constante.
 */
export const SIGNATURE_HEADER = 'colibri-signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Backoff de reintentos, en segundos. Un endpoint caído se recupera solo dentro
 * de las ~26 horas siguientes sin que el comercio pierda eventos.
 */
export const WEBHOOK_RETRY_SCHEDULE = [
  0, // inmediato
  10,
  60,
  300, // 5 min
  1_800, // 30 min
  7_200, // 2 h
  21_600, // 6 h
  64_800, // 18 h
] as const;

export const MAX_WEBHOOK_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE.length;

/** Fallos consecutivos tras los cuales el endpoint se apaga solo. */
export const WEBHOOK_AUTO_DISABLE_THRESHOLD = 20;

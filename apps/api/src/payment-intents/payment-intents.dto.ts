import { z } from 'zod';
import { CURRENCIES, ColibriError } from '@colibripay/shared';

/**
 * Contratos de entrada y salida de /v1/payment_intents.
 *
 * Los montos entran y salen como ENTEROS en unidades mínimas (céntimos), no
 * como strings. Es seguro porque MAX_AMOUNT tope ₡500.000.000 = 5e10 céntimos,
 * cuatro órdenes de magnitud por debajo del entero seguro de JS (9e15). Un
 * integrador puede usar `number` sin pensar. Internamente igual se convierte a
 * BigInt de inmediato: la aritmética nunca ocurre en `number`.
 */

const metadata = z
  .record(z.string().max(40), z.string().max(500))
  .refine((value) => Object.keys(value).length <= 50, {
    message: 'metadata admite como máximo 50 claves',
  })
  .optional();

export const createPaymentIntentSchema = z.object({
  amount: z.number().int().positive(),
  currency: z.enum(CURRENCIES),
  customerId: z.string().startsWith('cus_').optional(),
  paymentMethodId: z.string().startsWith('pm_').optional(),
  captureMethod: z.enum(['AUTOMATIC', 'MANUAL']).default('AUTOMATIC'),
  setupFutureUsage: z.boolean().default(false),
  description: z.string().max(1000).optional(),
  // 22 caracteres es el límite duro de las redes de tarjetas.
  statementDescriptor: z.string().max(22).optional(),
  returnUrl: z.string().url().optional(),
  metadata,
});

export const confirmPaymentIntentSchema = z.object({
  paymentMethodId: z.string().startsWith('pm_').optional(),
  returnUrl: z.string().url().optional(),
});

export const capturePaymentIntentSchema = z.object({
  /** Captura parcial. Si se omite, se captura todo lo autorizado. */
  amountToCapture: z.number().int().positive().optional(),
});

export const cancelPaymentIntentSchema = z.object({
  reason: z.string().max(500).optional(),
});

export type CreatePaymentIntentDto = z.infer<typeof createPaymentIntentSchema>;
export type ConfirmPaymentIntentDto = z.infer<typeof confirmPaymentIntentSchema>;
export type CapturePaymentIntentDto = z.infer<typeof capturePaymentIntentSchema>;
export type CancelPaymentIntentDto = z.infer<typeof cancelPaymentIntentSchema>;

/**
 * Valida con Zod y traduce el fallo al formato de error de la API.
 *
 * Se hace a mano en vez de con ValidationPipe porque queremos que un campo mal
 * enviado devuelva `param` apuntando exactamente a él: es la diferencia entre
 * un integrador que resuelve en un minuto y uno que abre un ticket.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  throw ColibriError.invalidRequest(
    issue?.message ?? 'Parámetros inválidos',
    issue?.path.join('.') || undefined,
  );
}

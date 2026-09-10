import { z } from 'zod';

/**
 * Entrada de tokenización.
 *
 * El esquema valida forma, no validez de la tarjeta: Luhn, vencimiento y CVC
 * los verifica el adquirente. Duplicar esas reglas acá crearía dos fuentes de
 * verdad que se desincronizan.
 */

const billing = z
  .object({
    name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    country: z.string().length(2).optional(),
  })
  .optional();

const cardSchema = z.object({
  type: z.literal('CARD'),
  card: z.object({
    // Solo dígitos y espacios: rechazar basura antes de mandarla al adquirente
    // evita gastar una llamada de red en algo que no puede funcionar.
    number: z.string().regex(/^[\d\s-]{12,25}$/, 'Número de tarjeta inválido'),
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2024).max(2099),
    cvc: z.string().regex(/^\d{3,4}$/, 'Código de seguridad inválido'),
  }),
  customerId: z.string().startsWith('cus_').optional(),
  billing,
});

const sinpeSchema = z.object({
  type: z.literal('SINPE_MOVIL'),
  sinpe: z.object({
    // Móvil costarricense: 8 dígitos empezando en 6, 7 u 8.
    phoneNumber: z.string().regex(/^[678]\d{7}$/, 'Número SINPE Móvil inválido'),
    bankName: z.string().max(100).optional(),
  }),
  customerId: z.string().startsWith('cus_').optional(),
  billing,
});

export const createPaymentMethodSchema = z.discriminatedUnion('type', [
  cardSchema,
  sinpeSchema,
]);

export type CreatePaymentMethodDto = z.infer<typeof createPaymentMethodSchema>;

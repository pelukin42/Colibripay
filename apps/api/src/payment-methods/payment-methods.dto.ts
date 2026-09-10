import { z } from 'zod';

/**
 * Entrada de `POST /v1/payment_methods`. Dos caminos, con consecuencias muy
 * distintas para el alcance PCI:
 *
 *  - **`token`** — el navegador ya tokenizó la tarjeta contra el vault del
 *    adquirente y acá solo llega la referencia opaca. Es el camino normal, el
 *    que usa el checkout, y el que mantiene el PAN fuera de nuestra
 *    infraestructura.
 *
 *  - **`card`** — el número crudo llega a nuestros servidores. Nos mete en
 *    alcance PCI DSS completo como proveedor de servicio. Existe solo para
 *    comercios que ya están certificados y quieren integración
 *    servidor-a-servidor, y para adquirentes sin tokenización desde el
 *    navegador. No es el default y no debería serlo nunca.
 */

const billing = z
  .object({
    name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    country: z.string().length(2).optional(),
  })
  .optional();

const cardTokenSchema = z.object({
  type: z.literal('CARD'),
  token: z.string().min(10).max(2000),
  customerId: z.string().startsWith('cus_').optional(),
  billing,
});

const cardRawSchema = z.object({
  type: z.literal('CARD'),
  card: z.object({
    // Solo dígitos, espacios y guiones: rechazar basura antes de gastar una
    // llamada de red. La validación real (Luhn, vencimiento) la hace el
    // adquirente; duplicarla acá crearía dos fuentes de verdad.
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

/**
 * Se usa `union` y no `discriminatedUnion` porque dos variantes comparten el
 * mismo `type: 'CARD'` y se distinguen por el campo presente. El orden importa:
 * la variante con token va primero para que sea la que se intenta antes.
 */
export const createPaymentMethodSchema = z.union([
  cardTokenSchema,
  cardRawSchema,
  sinpeSchema,
]);

export type CreatePaymentMethodDto = z.infer<typeof createPaymentMethodSchema>;
export type CardTokenDto = z.infer<typeof cardTokenSchema>;
export type CardRawDto = z.infer<typeof cardRawSchema>;
export type SinpeDto = z.infer<typeof sinpeSchema>;

import { z } from 'zod';

/**
 * Validación del entorno al arrancar.
 *
 * El proceso se niega a levantar si falta algo o si un valor no cumple. En una
 * pasarela, arrancar con `ENCRYPTION_KEY` mal formada significa escribir IBANs
 * que después no se pueden desencriptar — es preferible no arrancar.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),

  CHECKOUT_URL: z.string().url(),
  DASHBOARD_URL: z.string().url(),

  JWT_SECRET: z.string().min(32),

  // 32 bytes exactos en base64: AES-256-GCM no acepta otra cosa.
  ENCRYPTION_KEY: z
    .string()
    .refine((value) => Buffer.from(value, 'base64').length === 32, {
      message:
        'ENCRYPTION_KEY debe ser 32 bytes en base64. Generá una con: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    }),

  DEFAULT_ACQUIRER: z.string().default('sandbox'),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuración de entorno inválida:\n${details}`);
  }

  // Un secreto de desarrollo en producción es una fuga de seguridad silenciosa.
  if (parsed.data.NODE_ENV === 'production') {
    const weak = [
      ['JWT_SECRET', parsed.data.JWT_SECRET],
      ['ENCRYPTION_KEY', parsed.data.ENCRYPTION_KEY],
    ].filter(([, value]) => /dev|cambiame|change ?me|test/i.test(String(value)));

    if (weak.length > 0) {
      throw new Error(
        `Secretos de desarrollo detectados en producción: ${weak.map(([k]) => k).join(', ')}`,
      );
    }
  }

  cached = parsed.data;
  return cached;
}

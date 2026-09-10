/**
 * Aritmética monetaria. Todo se expresa en unidades mínimas (céntimos) como
 * BigInt: ₡1.500,00 son 150000n y US$25,99 son 2599n.
 *
 * Regla del proyecto: ningún monto pasa por `number` en ningún punto del
 * camino, ni siquiera "temporalmente para formatear". Los enteros de JS son
 * exactos solo hasta 2^53 y los flotantes ni siquiera representan 0.1.
 */

export const CURRENCIES = ['CRC', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Dígitos decimales según ISO 4217. Ambas monedas usan 2. */
const EXPONENT: Record<Currency, number> = {
  CRC: 2,
  USD: 2,
};

/**
 * Monto mínimo cobrable. Por debajo de esto la comisión del adquirente se come
 * la transacción y las redes suelen rechazarla igual.
 */
export const MIN_AMOUNT: Record<Currency, bigint> = {
  CRC: 50000n, // ₡500
  USD: 100n, //  US$1
};

/** Techo de seguridad. Un monto mayor casi siempre es un bug de unidades del comercio. */
export const MAX_AMOUNT: Record<Currency, bigint> = {
  CRC: 500_000_000_00n, // ₡500.000.000
  USD: 1_000_000_00n, //   US$1.000.000
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

/**
 * Convierte de unidades mayores a menores. Acepta string para no obligar al
 * llamante a pasar por un float: `toMinorUnits('1500.50', 'CRC')` → 150050n.
 */
export function toMinorUnits(major: string | number, currency: Currency): bigint {
  const exponent = EXPONENT[currency];
  const text = typeof major === 'number' ? major.toFixed(exponent) : major.trim();

  const match = /^(-?)(\d+)(?:[.,](\d+))?$/.exec(text);
  if (!match) {
    throw new RangeError(`Monto inválido: ${JSON.stringify(major)}`);
  }

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > exponent) {
    throw new RangeError(
      `${currency} admite ${exponent} decimales; se recibieron ${fraction.length}`,
    );
  }

  const padded = fraction.padEnd(exponent, '0');
  const value = BigInt(`${whole}${padded}`);
  return sign === '-' ? -value : value;
}

/** Convierte a string de unidades mayores sin separadores: 150050n → "1500.50". */
export function toMajorUnits(minor: bigint, currency: Currency): string {
  const exponent = EXPONENT[currency];
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole}${exponent > 0 ? `.${fraction}` : ''}`;
}

/** Formato para mostrarle al usuario: 150050n → "₡1.500,50". */
export function formatAmount(
  minor: bigint,
  currency: Currency,
  locale = 'es-CR',
): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: EXPONENT[currency],
  }).format(Number(toMajorUnits(minor, currency)));
}

/**
 * Comisión de la plataforma: `bps` puntos básicos sobre el monto más un fijo.
 * Redondeo half-up sobre el componente porcentual — es lo que espera cualquier
 * contador que revise el cálculo a mano.
 */
export function calculateFee(amount: bigint, bps: number, fixed: bigint): bigint {
  if (amount < 0n) throw new RangeError('La comisión no aplica a montos negativos');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`bps fuera de rango: ${bps}`);
  }
  const percentage = (amount * BigInt(bps) + 5_000n) / 10_000n;
  return percentage + fixed;
}

/** Valida que el monto sea cobrable. Devuelve el motivo, o null si está bien. */
export function validateAmount(amount: bigint, currency: Currency): string | null {
  if (amount <= 0n) return 'El monto debe ser mayor a cero';
  if (amount < MIN_AMOUNT[currency]) {
    return `El monto mínimo para ${currency} es ${formatAmount(MIN_AMOUNT[currency], currency)}`;
  }
  if (amount > MAX_AMOUNT[currency]) {
    return `El monto máximo para ${currency} es ${formatAmount(MAX_AMOUNT[currency], currency)}`;
  }
  return null;
}

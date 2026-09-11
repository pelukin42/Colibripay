/**
 * Reglas específicas de Costa Rica.
 *
 * Todo lo que dependa del marco regulatorio, los identificadores o los rieles
 * de pago costarricenses vive acá, y no disperso en el resto del código. La
 * razón práctica: estas reglas cambian por resolución del BCCR o por reforma de
 * ley, y cuando eso pasa hay que poder encontrar TODO lo afectado en un solo
 * archivo.
 *
 * ADVERTENCIA IMPORTANTE PARA QUIEN MANTENGA ESTO: varios valores de acá
 * dependen de resoluciones que se actualizan periódicamente. Están marcados con
 * VERIFICAR y NO deben tomarse como vigentes sin contrastarlos contra la fuente
 * oficial. Un límite de comisión desactualizado no es un bug menor: es cobrarle
 * de más a un comercio por encima de lo que permite la ley.
 */

// ---------------------------------------------------------------------------
// Identificación tributaria
// ---------------------------------------------------------------------------

export type TaxIdKind = 'FISICA' | 'JURIDICA' | 'DIMEX' | 'NITE';

/**
 * Cédulas y demás identificaciones que emite Costa Rica.
 *
 *  - Física:   9 dígitos. Primer dígito = provincia (1-7), o 0 para casos viejos.
 *  - Jurídica: 10 dígitos, empieza en 3. Es la de cualquier S.A. o S.R.L.
 *  - DIMEX:    11 o 12 dígitos. Residentes extranjeros.
 *  - NITE:     10 dígitos. Para quienes no tienen cédula ni DIMEX.
 *
 * Se valida la FORMA, no la existencia. Confirmar que una cédula esté inscrita
 * y activa requiere consultar al Registro Nacional o a Hacienda (ATV), y eso es
 * parte del KYC de alta del comercio, no de esta función.
 */
export function classifyTaxId(raw: string): TaxIdKind | null {
  const digits = raw.replace(/\D/g, '');

  if (digits.length === 9 && /^[0-7]/.test(digits)) return 'FISICA';
  if (digits.length === 10 && digits.startsWith('3')) return 'JURIDICA';
  if (digits.length === 10 && digits.startsWith('5')) return 'NITE';
  if (digits.length === 11 || digits.length === 12) return 'DIMEX';

  return null;
}

export function isValidTaxId(raw: string): boolean {
  return classifyTaxId(raw) !== null;
}

/** Normaliza a solo dígitos, que es como lo espera Hacienda en la factura electrónica. */
export function normalizeTaxId(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Formato legible: 3-101-123456 para jurídica, 1-1234-5678 para física. */
export function formatTaxId(raw: string): string {
  const digits = normalizeTaxId(raw);
  const kind = classifyTaxId(digits);

  if (kind === 'JURIDICA') {
    return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4)}`;
  }
  if (kind === 'FISICA') {
    return `${digits.slice(0, 1)}-${digits.slice(1, 5)}-${digits.slice(5)}`;
  }
  return digits;
}

// ---------------------------------------------------------------------------
// Cuenta IBAN costarricense
// ---------------------------------------------------------------------------

/**
 * El IBAN de Costa Rica tiene 22 caracteres: `CR` + 2 dígitos de control + 18
 * dígitos de cuenta. Los primeros dígitos de la parte de cuenta identifican a
 * la entidad financiera.
 *
 * El dígito de control se valida con el algoritmo mod-97 de la norma ISO 13616,
 * que es matemática pura y no depende de ninguna tabla que se desactualice.
 * Esto detecta el error real y cotidiano: un dígito mal tecleado al que si no
 * le hacés esta comprobación le terminás transfiriendo plata a nadie.
 */
export const IBAN_CR_LENGTH = 22;

export function isValidCostaRicanIban(raw: string): boolean {
  const iban = raw.replace(/[\s-]/g, '').toUpperCase();

  if (iban.length !== IBAN_CR_LENGTH) return false;
  if (!/^CR\d{20}$/.test(iban)) return false;

  return mod97(iban) === 1;
}

/** ISO 13616: se rotan los 4 primeros caracteres al final y se calcula mod 97. */
function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);

  // Se procesa en trozos para no desbordar el entero seguro de JS: el número
  // completo de un IBAN tiene más de 30 dígitos.
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char)
      ? char
      : String(char.charCodeAt(0) - 55); // A=10 … Z=35
    remainder = Number(`${remainder}${value}`) % 97;
  }
  return remainder;
}

/**
 * Extrae el código de entidad financiera del IBAN.
 *
 * Devuelve el código en crudo y NO el nombre del banco, deliberadamente. La
 * tabla que asocia código con entidad la publica el BCCR y yo no la voy a
 * adivinar: en un sistema de pagos, un código mal mapeado significa plata
 * enviada al banco equivocado. Cargá la tabla oficial en la configuración y
 * resolvé el nombre contra ella.
 *
 * VERIFICAR: la posición y longitud del código de entidad dentro del BBAN
 * contra la documentación vigente del BCCR antes de usar esto para enrutar.
 */
export function ibanBankCode(raw: string): string | null {
  const iban = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!isValidCostaRicanIban(iban)) return null;
  // CR(2) + control(2) + relleno(1) + entidad(3) + resto
  return iban.slice(5, 8);
}

/** Oculta el IBAN para mostrarlo: `CR·····················1234`. */
export function maskIban(raw: string): string {
  const iban = raw.replace(/[\s-]/g, '').toUpperCase();
  if (iban.length < 4) return '····';
  return `${iban.slice(0, 2)}${'·'.repeat(iban.length - 6)}${iban.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// SINPE Móvil
// ---------------------------------------------------------------------------

/**
 * SINPE Móvil identifica al destinatario por número de teléfono.
 *
 * Los móviles costarricenses son 8 dígitos y empiezan en 6, 7 u 8. Los fijos
 * empiezan en 2 y NO sirven para SINPE Móvil, que es la confusión habitual.
 *
 * El acceso a SINPE es a través de una entidad financiera supervisada; el BCCR
 * no conecta a entidades no reguladas. Esta validación es de forma: la
 * existencia de la cuenta la confirma el banco.
 */
export function isValidSinpePhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('506') && digits.length === 11 ? digits.slice(3) : digits;
  return /^[678]\d{7}$/.test(local);
}

export function formatSinpePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  const local = digits.startsWith('506') && digits.length === 11 ? digits.slice(3) : digits;
  return `${local.slice(0, 4)} ${local.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Límites de comisión — Ley 9831
// ---------------------------------------------------------------------------

/**
 * Costa Rica REGULA POR LEY cuánto se le puede cobrar a un comercio por
 * procesar tarjetas.
 *
 * La Ley 9831 ("Ley para mejorar la competencia en el mercado de tarjetas de
 * crédito y débito") faculta al BCCR a fijar topes máximos, que revisa y
 * publica periódicamente y que han ido bajando año con año. Hay dos que
 * importan:
 *
 *   - Comisión de ADQUIRENCIA: lo que se le cobra al comercio. Es la tuya.
 *   - Comisión de INTERCAMBIO: lo que el adquirente le paga al emisor.
 *
 * Esto NO es una recomendación de buenas prácticas: es un límite legal. Cobrar
 * por encima expone a sanción.
 *
 * VERIFICAR ANTES DE PRODUCCIÓN: los topes vigentes se consultan en las
 * resoluciones del BCCR sobre comisiones de tarjetas. NO hay un valor
 * hardcodeado acá a propósito — cualquier número que yo escriba queda
 * desactualizado en la próxima revisión y nadie se entera. Se configura por
 * entorno y se revisa cuando el BCCR publica.
 */
export const ACQUIRING_FEE_CAP_ENV = 'CR_ACQUIRING_FEE_CAP_BPS';

/**
 * Tope por defecto mientras no se configure uno: deliberadamente BAJO.
 *
 * Si alguien olvida configurar el valor real, el sistema cobra de menos —que es
 * un problema de negocio— en vez de cobrar de más, que es un problema legal.
 */
export const CONSERVATIVE_FEE_CAP_BPS = 150; // 1.50 %

export function acquiringFeeCapBps(env: Record<string, string | undefined> = {}): number {
  const configured = Number(env[ACQUIRING_FEE_CAP_ENV]);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : CONSERVATIVE_FEE_CAP_BPS;
}

export interface FeeCheck {
  allowed: boolean;
  capBps: number;
  message?: string;
}

/**
 * Verifica que la tarifa de un comercio no supere el tope regulado.
 *
 * El componente fijo se evalúa sobre el monto MÍNIMO cobrable, porque es ahí
 * donde un fijo pequeño representa el porcentaje más alto: ₡100 sobre una venta
 * de ₡500 son 20 %, aunque sobre ₡50.000 sean 0,2 %.
 */
export function checkAcquiringFee(params: {
  bps: number;
  fixed: bigint;
  minimumAmount: bigint;
  capBps?: number;
}): FeeCheck {
  const capBps = params.capBps ?? CONSERVATIVE_FEE_CAP_BPS;

  const fixedAsBps =
    params.minimumAmount > 0n
      ? Number((params.fixed * 10_000n) / params.minimumAmount)
      : 0;
  const effective = params.bps + fixedAsBps;

  if (effective > capBps) {
    return {
      allowed: false,
      capBps,
      message:
        `La tarifa efectiva (${(effective / 100).toFixed(2)} % sobre el monto mínimo) ` +
        `supera el tope de ${(capBps / 100).toFixed(2)} % que fija el BCCR bajo la Ley 9831. ` +
        'Verificá la resolución vigente antes de configurar esta tarifa.',
    };
  }

  return { allowed: true, capBps };
}

// ---------------------------------------------------------------------------
// Impuestos
// ---------------------------------------------------------------------------

/**
 * IVA general en Costa Rica: 13 % (Ley 9635, Ley de Fortalecimiento de las
 * Finanzas Públicas).
 *
 * Si tu comisión lleva IVA o está exenta depende de cómo se clasifique el
 * servicio, y esa es una consulta para un contador, no una decisión de
 * arquitectura. La constante está acá para que el cálculo, cuando aplique, no
 * se escriba a mano en tres lugares distintos.
 */
export const IVA_BPS = 1_300;

export function applyIva(amount: bigint): bigint {
  return (amount * BigInt(IVA_BPS) + 5_000n) / 10_000n;
}

/**
 * PENDIENTE DE CONFIRMAR CON UN CONTADOR: en Costa Rica el adquirente practica
 * una retención sobre las ventas con tarjeta, a cuenta del impuesto sobre la
 * renta del comercio, y la reporta a Hacienda.
 *
 * No se modela acá porque no tengo certeza del porcentaje vigente ni de a quién
 * le corresponde practicarla en un esquema agregador. Cuando se confirme, es un
 * asiento contable más en el ledger —una cuenta de retenciones por enterar— y
 * no un cambio estructural.
 */
export const TAX_WITHHOLDING_UNCONFIRMED = true;

import { describe, expect, it } from 'vitest';
import {
  acquiringFeeCapBps,
  applyIva,
  checkAcquiringFee,
  classifyTaxId,
  CONSERVATIVE_FEE_CAP_BPS,
  formatSinpePhone,
  formatTaxId,
  ibanBankCode,
  isValidCostaRicanIban,
  isValidSinpePhone,
  isValidTaxId,
  maskIban,
} from './costa-rica.js';

describe('identificación tributaria', () => {
  it('reconoce cédula jurídica', () => {
    expect(classifyTaxId('3101123456')).toBe('JURIDICA');
    expect(classifyTaxId('3-101-123456')).toBe('JURIDICA');
  });

  it('reconoce cédula física', () => {
    expect(classifyTaxId('112345678')).toBe('FISICA');
    expect(classifyTaxId('1-1234-5678')).toBe('FISICA');
  });

  it('reconoce DIMEX', () => {
    expect(classifyTaxId('12345678901')).toBe('DIMEX');
    expect(classifyTaxId('123456789012')).toBe('DIMEX');
  });

  it('rechaza lo que no tiene forma válida', () => {
    expect(classifyTaxId('123')).toBeNull();
    expect(classifyTaxId('')).toBeNull();
    expect(classifyTaxId('9101123456')).toBeNull(); // 10 dígitos que no empiezan en 3 ni 5
    expect(isValidTaxId('abc')).toBe(false);
  });

  it('formatea para mostrar', () => {
    expect(formatTaxId('3101123456')).toBe('3-101-123456');
    expect(formatTaxId('112345678')).toBe('1-1234-5678');
  });
});

describe('IBAN costarricense', () => {
  // Se construye un IBAN con dígitos de control correctos en vez de inventar
  // uno: un IBAN inventado casi nunca pasa el mod-97 y el test no probaría nada.
  const valid = buildCostaRicanIban('015108410010012345');

  it('acepta un IBAN bien formado', () => {
    expect(isValidCostaRicanIban(valid)).toBe(true);
  });

  it('tolera espacios y guiones al escribirlo', () => {
    const spaced = valid.replace(/(.{4})/g, '$1 ').trim();
    expect(isValidCostaRicanIban(spaced)).toBe(true);
  });

  it('detecta un dígito mal tecleado', () => {
    // Es el error real y cotidiano, y el que manda plata a ninguna parte.
    const lastDigit = valid.slice(-1);
    const swapped = valid.slice(0, -1) + (lastDigit === '9' ? '8' : String(Number(lastDigit) + 1));
    expect(isValidCostaRicanIban(swapped)).toBe(false);
  });

  it('detecta dos dígitos transpuestos', () => {
    const chars = valid.split('');
    [chars[10], chars[11]] = [chars[11]!, chars[10]!];
    const transposed = chars.join('');
    if (transposed !== valid) {
      expect(isValidCostaRicanIban(transposed)).toBe(false);
    }
  });

  it('rechaza longitudes incorrectas y otros países', () => {
    expect(isValidCostaRicanIban(valid.slice(0, 21))).toBe(false);
    expect(isValidCostaRicanIban(`${valid}0`)).toBe(false);
    expect(isValidCostaRicanIban('DE89370400440532013000')).toBe(false);
  });

  it('extrae el código de entidad', () => {
    expect(ibanBankCode(valid)).toHaveLength(3);
    expect(ibanBankCode('no-es-un-iban')).toBeNull();
  });

  it('enmascara dejando ver los últimos cuatro', () => {
    const masked = maskIban(valid);
    expect(masked.startsWith('CR')).toBe(true);
    expect(masked.endsWith(valid.slice(-4))).toBe(true);
    expect(masked).not.toContain(valid.slice(6, 12));
  });
});

describe('SINPE Móvil', () => {
  it('acepta móviles costarricenses', () => {
    for (const phone of ['88887777', '6123 4567', '7000-0000', '50688887777']) {
      expect(isValidSinpePhone(phone), phone).toBe(true);
    }
  });

  it('rechaza fijos, que es la confusión habitual', () => {
    // Los fijos empiezan en 2 y no funcionan con SINPE Móvil.
    expect(isValidSinpePhone('22334455')).toBe(false);
  });

  it('rechaza longitudes incorrectas', () => {
    expect(isValidSinpePhone('8888777')).toBe(false);
    expect(isValidSinpePhone('888877778')).toBe(false);
  });

  it('formatea legible', () => {
    expect(formatSinpePhone('88887777')).toBe('8888 7777');
    expect(formatSinpePhone('50688887777')).toBe('8888 7777');
  });
});

describe('tope de comisión (Ley 9831)', () => {
  it('usa un tope conservador si no se configuró ninguno', () => {
    expect(acquiringFeeCapBps({})).toBe(CONSERVATIVE_FEE_CAP_BPS);
    expect(acquiringFeeCapBps({ CR_ACQUIRING_FEE_CAP_BPS: 'basura' })).toBe(
      CONSERVATIVE_FEE_CAP_BPS,
    );
  });

  it('respeta el tope configurado', () => {
    expect(acquiringFeeCapBps({ CR_ACQUIRING_FEE_CAP_BPS: '200' })).toBe(200);
  });

  it('rechaza la tarifa que yo había inventado', () => {
    // 2,90 % + ₡100 sobre un mínimo de ₡500. El fijo solo ya son 20 puntos
    // porcentuales sobre esa venta.
    const result = checkAcquiringFee({
      bps: 290,
      fixed: 10_000n,
      minimumAmount: 50_000n,
      capBps: 200,
    });
    expect(result.allowed).toBe(false);
    expect(result.message).toMatch(/Ley 9831/);
  });

  it('acepta una tarifa dentro del tope', () => {
    expect(
      checkAcquiringFee({ bps: 150, fixed: 0n, minimumAmount: 50_000n, capBps: 200 }).allowed,
    ).toBe(true);
  });

  it('cuenta el componente fijo sobre el monto mínimo, no sobre uno cómodo', () => {
    // Mismo fijo, distinto mínimo: sobre ventas chicas el fijo pesa mucho más.
    const chico = checkAcquiringFee({
      bps: 100,
      fixed: 10_000n,
      minimumAmount: 50_000n, // ₡500 -> el fijo son 20 %
      capBps: 200,
    });
    const grande = checkAcquiringFee({
      bps: 100,
      fixed: 10_000n,
      minimumAmount: 5_000_000n, // ₡50.000 -> el fijo son 0,2 %
      capBps: 200,
    });
    expect(chico.allowed).toBe(false);
    expect(grande.allowed).toBe(true);
  });
});

describe('IVA', () => {
  it('calcula el 13 %', () => {
    expect(applyIva(100_000n)).toBe(13_000n); // ₡1.000 -> ₡130
  });

  it('redondea half-up', () => {
    expect(applyIva(1n)).toBe(0n);
    expect(applyIva(4n)).toBe(1n);
  });
});

/**
 * Construye un IBAN costarricense válido calculando sus dígitos de control.
 * Es la operación inversa a la validación, y sirve para no depender de un
 * número real de nadie en los tests.
 */
function buildCostaRicanIban(bban18: string): string {
  const rearranged = `${bban18}CR00`;
  let remainder = 0;
  for (const char of rearranged) {
    const value = /\d/.test(char) ? char : String(char.charCodeAt(0) - 55);
    remainder = Number(`${remainder}${value}`) % 97;
  }
  const check = String(98 - remainder).padStart(2, '0');
  return `CR${check}${bban18}`;
}

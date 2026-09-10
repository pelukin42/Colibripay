import { describe, expect, it } from 'vitest';
import {
  calculateFee,
  formatAmount,
  toMajorUnits,
  toMinorUnits,
  validateAmount,
} from './money.js';

describe('toMinorUnits', () => {
  it('convierte strings sin pasar por float', () => {
    expect(toMinorUnits('1500.50', 'CRC')).toBe(150050n);
    expect(toMinorUnits('0.01', 'USD')).toBe(1n);
    expect(toMinorUnits('1500', 'CRC')).toBe(150000n);
  });

  it('acepta coma decimal, que es lo que escribe la gente en CR', () => {
    expect(toMinorUnits('1500,50', 'CRC')).toBe(150050n);
  });

  it('preserva montos que un double redondearía mal', () => {
    // 0.1 + 0.2 !== 0.3 en punto flotante. Acá sí.
    const total = toMinorUnits('0.10', 'USD') + toMinorUnits('0.20', 'USD');
    expect(total).toBe(toMinorUnits('0.30', 'USD'));
  });

  it('rechaza más decimales de los que admite la moneda', () => {
    expect(() => toMinorUnits('10.005', 'USD')).toThrow(/decimales/);
  });

  it('rechaza basura', () => {
    expect(() => toMinorUnits('abc', 'CRC')).toThrow();
    expect(() => toMinorUnits('', 'CRC')).toThrow();
  });

  it('hace ida y vuelta sin perder nada', () => {
    for (const value of ['0.00', '1.05', '999999.99', '1500.50']) {
      expect(toMajorUnits(toMinorUnits(value, 'USD'), 'USD')).toBe(value);
    }
  });
});

describe('calculateFee', () => {
  it('aplica bps más fijo', () => {
    // 2.90% de ₡10.000 = ₡290, más ₡100 fijos.
    expect(calculateFee(1_000_000n, 290, 10_000n)).toBe(39_000n);
  });

  it('redondea half-up, como lo haría un contador a mano', () => {
    // 1% de 1050 = 10.5 -> 11
    expect(calculateFee(1050n, 100, 0n)).toBe(11n);
    // 1% de 1049 = 10.49 -> 10
    expect(calculateFee(1049n, 100, 0n)).toBe(10n);
  });

  it('no cobra nada sobre cero', () => {
    expect(calculateFee(0n, 290, 0n)).toBe(0n);
  });

  it('rechaza bps fuera de rango', () => {
    expect(() => calculateFee(100n, -1, 0n)).toThrow();
    expect(() => calculateFee(100n, 10_001n as unknown as number, 0n)).toThrow();
  });

  it('es exacto en montos grandes donde un double ya perdió precisión', () => {
    const huge = 90_071_992_547_409_93n; // > 2^53 en céntimos
    expect(calculateFee(huge, 290, 0n)).toBe((huge * 290n + 5_000n) / 10_000n);
  });
});

describe('validateAmount', () => {
  it('acepta montos normales', () => {
    expect(validateAmount(1_000_000n, 'CRC')).toBeNull();
  });

  it('rechaza cero y negativos', () => {
    expect(validateAmount(0n, 'CRC')).toMatch(/mayor a cero/);
    expect(validateAmount(-100n, 'CRC')).toMatch(/mayor a cero/);
  });

  it('rechaza por debajo del mínimo y por encima del máximo', () => {
    expect(validateAmount(100n, 'CRC')).toMatch(/mínimo/);
    expect(validateAmount(999_999_999_999n, 'CRC')).toMatch(/máximo/);
  });
});

describe('formatAmount', () => {
  it('formatea sin romperse', () => {
    const formatted = formatAmount(150050n, 'CRC');
    expect(formatted).toContain('1');
    expect(formatted).toMatch(/₡|CRC/);
  });
});

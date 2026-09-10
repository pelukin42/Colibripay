import { describe, expect, it } from 'vitest';
import {
  adjustment,
  assertBalanced,
  chargeCaptured,
  chargeRefunded,
  disputeLost,
  disputeWon,
  displayBalance,
  fundsReleased,
  payoutCreated,
  payoutFailed,
  payoutSettled,
  UnbalancedLedgerError,
  type LedgerAccountType,
  type PostingSet,
} from './ledger.js';
import { calculateFee } from './money.js';

/** Libro mayor en memoria, para verificar saldos a lo largo de una secuencia. */
class Book {
  private readonly balances = new Map<string, bigint>();

  post(set: PostingSet): void {
    assertBalanced(set.postings); // segunda barrera, igual que en el servicio real
    for (const posting of set.postings) {
      const key = `${posting.scope}:${posting.account}`;
      this.balances.set(key, (this.balances.get(key) ?? 0n) + posting.amount);
    }
  }

  raw(scope: string, account: LedgerAccountType): bigint {
    return this.balances.get(`${scope}:${account}`) ?? 0n;
  }

  /** Saldo presentable (signo ya volteado para cuentas de pasivo/ingreso). */
  shown(scope: string, account: LedgerAccountType): bigint {
    return displayBalance(account, this.raw(scope, account));
  }

  /** La invariante global: todo el libro suma cero, siempre. */
  total(): bigint {
    let sum = 0n;
    for (const value of this.balances.values()) sum += value;
    return sum;
  }
}

describe('assertBalanced', () => {
  it('acepta un asiento que cuadra', () => {
    expect(() =>
      assertBalanced([
        { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: 100n },
        { account: 'MERCHANT_PENDING', scope: 'merchant', amount: -100n },
      ]),
    ).not.toThrow();
  });

  it('rechaza un asiento descuadrado, aunque sea por un céntimo', () => {
    expect(() =>
      assertBalanced([
        { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: 100n },
        { account: 'MERCHANT_PENDING', scope: 'merchant', amount: -99n },
      ]),
    ).toThrow(UnbalancedLedgerError);
  });

  it('rechaza movimientos en cero y asientos de una sola pata', () => {
    expect(() =>
      assertBalanced([
        { account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: 0n },
        { account: 'MERCHANT_PENDING', scope: 'merchant', amount: 0n },
      ]),
    ).toThrow(/cero/);

    expect(() =>
      assertBalanced([{ account: 'ACQUIRER_RECEIVABLE', scope: 'platform', amount: 0n }]),
    ).toThrow(/dos movimientos/);
  });
});

describe('chargeCaptured', () => {
  it('reparte bruto entre comisión, reserva y saldo del comercio', () => {
    const set = chargeCaptured({
      amount: 1_000_000n, // ₡10.000
      fee: 39_000n, // 2.90% + ₡100
      reserve: 50_000n,
      currency: 'CRC',
    });

    const by = (account: LedgerAccountType) =>
      set.postings.find((p) => p.account === account)?.amount;

    expect(by('ACQUIRER_RECEIVABLE')).toBe(1_000_000n);
    expect(by('PLATFORM_FEE_REVENUE')).toBe(-39_000n);
    expect(by('RESERVE')).toBe(-50_000n);
    expect(by('MERCHANT_PENDING')).toBe(-911_000n);
  });

  it('omite la reserva cuando es cero en vez de escribir un movimiento vacío', () => {
    const set = chargeCaptured({ amount: 1_000_000n, fee: 39_000n, currency: 'CRC' });
    expect(set.postings.some((p) => p.account === 'RESERVE')).toBe(false);
    expect(set.postings).toHaveLength(3);
  });

  it('se niega si la comisión más la reserva superan el cobro', () => {
    expect(() =>
      chargeCaptured({ amount: 100n, fee: 80n, reserve: 50n, currency: 'CRC' }),
    ).toThrow(/superan el monto/);
  });

  it('rechaza montos no positivos', () => {
    expect(() => chargeCaptured({ amount: 0n, fee: 0n, currency: 'CRC' })).toThrow();
    expect(() => chargeCaptured({ amount: -1n, fee: 0n, currency: 'CRC' })).toThrow();
  });
});

describe('ciclo de vida completo', () => {
  it('cobrar, liberar, pagar y liquidar deja el libro en cero y sin deuda al comercio', () => {
    const book = new Book();
    const amount = 1_000_000n;
    const fee = calculateFee(amount, 290, 10_000n); // 39.000

    book.post(chargeCaptured({ amount, fee, currency: 'CRC' }));

    // Recién cobrado: la plata está pendiente, no disponible.
    expect(book.shown('merchant', 'MERCHANT_PENDING')).toBe(961_000n);
    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(0n);
    expect(book.shown('platform', 'PLATFORM_FEE_REVENUE')).toBe(fee);

    // Vence la retención T+2.
    book.post(fundsReleased({ amount: 961_000n, currency: 'CRC' }));
    expect(book.shown('merchant', 'MERCHANT_PENDING')).toBe(0n);
    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(961_000n);

    // Se emite el payout.
    book.post(payoutCreated({ amount: 961_000n, currency: 'CRC' }));
    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(0n);
    expect(book.shown('merchant', 'PAYOUTS_PAYABLE')).toBe(961_000n);

    // El banco confirma.
    book.post(payoutSettled({ amount: 961_000n, currency: 'CRC' }));
    expect(book.shown('merchant', 'PAYOUTS_PAYABLE')).toBe(0n);

    // Nos queda por cobrar del adquirente solo nuestra comisión.
    expect(book.raw('platform', 'ACQUIRER_RECEIVABLE')).toBe(fee);
    expect(book.total()).toBe(0n);
  });

  it('un payout rebotado devuelve los fondos al comercio', () => {
    const book = new Book();
    book.post(chargeCaptured({ amount: 1_000_000n, fee: 39_000n, currency: 'CRC' }));
    book.post(fundsReleased({ amount: 961_000n, currency: 'CRC' }));
    book.post(payoutCreated({ amount: 961_000n, currency: 'CRC' }));
    book.post(payoutFailed({ amount: 961_000n, currency: 'CRC' }));

    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(961_000n);
    expect(book.shown('merchant', 'PAYOUTS_PAYABLE')).toBe(0n);
    expect(book.total()).toBe(0n);
  });
});

describe('chargeRefunded', () => {
  it('por defecto la plataforma se queda con la comisión', () => {
    const book = new Book();
    book.post(chargeCaptured({ amount: 1_000_000n, fee: 39_000n, currency: 'CRC' }));
    book.post(fundsReleased({ amount: 961_000n, currency: 'CRC' }));
    book.post(chargeRefunded({ amount: 1_000_000n, currency: 'CRC' }));

    // El comercio queda debiendo la comisión: cobró ₡10.000, devolvió ₡10.000,
    // y la comisión ya se pagó. Saldo negativo, que es lo correcto.
    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(-39_000n);
    expect(book.shown('platform', 'PLATFORM_FEE_REVENUE')).toBe(39_000n);
    expect(book.total()).toBe(0n);
  });

  it('devolver la comisión deja al comercio en cero', () => {
    const book = new Book();
    book.post(chargeCaptured({ amount: 1_000_000n, fee: 39_000n, currency: 'CRC' }));
    book.post(fundsReleased({ amount: 961_000n, currency: 'CRC' }));
    book.post(
      chargeRefunded({ amount: 1_000_000n, currency: 'CRC', refundedFee: 39_000n }),
    );

    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(0n);
    expect(book.shown('platform', 'PLATFORM_FEE_REVENUE')).toBe(0n);
    expect(book.total()).toBe(0n);
  });

  it('varios reembolsos parciales suman exactamente el total', () => {
    const book = new Book();
    book.post(chargeCaptured({ amount: 1_000_000n, fee: 0n, currency: 'CRC' }));
    book.post(fundsReleased({ amount: 1_000_000n, currency: 'CRC' }));

    for (const part of [333_333n, 333_333n, 333_334n]) {
      book.post(chargeRefunded({ amount: part, currency: 'CRC' }));
    }

    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(0n);
    expect(book.total()).toBe(0n);
  });
});

describe('disputas', () => {
  it('perder un contracargo descuenta monto más comisión', () => {
    const book = new Book();
    book.post(chargeCaptured({ amount: 1_000_000n, fee: 0n, currency: 'CRC' }));
    book.post(fundsReleased({ amount: 1_000_000n, currency: 'CRC' }));
    book.post(disputeLost({ amount: 1_000_000n, currency: 'CRC', disputeFee: 1_500_00n }));

    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(-1_500_00n);
    expect(book.shown('platform', 'PLATFORM_FEE_REVENUE')).toBe(1_500_00n);
    expect(book.total()).toBe(0n);
  });

  it('ganar un contracargo devuelve la comisión cobrada', () => {
    const book = new Book();
    book.post(disputeWon({ currency: 'CRC', refundedDisputeFee: 1_500_00n }));
    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(1_500_00n);
    expect(book.total()).toBe(0n);
  });

  it('sin comisión que devolver no hay asiento que hacer', () => {
    expect(() => disputeWon({ currency: 'CRC', refundedDisputeFee: 0n })).toThrow();
  });
});

describe('adjustment', () => {
  it('acepta un ajuste que cuadra', () => {
    expect(() =>
      adjustment({
        currency: 'CRC',
        description: 'Corrección por incidente 2026-03-01',
        postings: [
          { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: -50_000n },
          { account: 'CHARGEBACK_LOSS', scope: 'platform', amount: 50_000n },
        ],
      }),
    ).not.toThrow();
  });

  it('rechaza un ajuste descuadrado, que es justo para lo que existe la barrera', () => {
    expect(() =>
      adjustment({
        currency: 'CRC',
        description: 'Ajuste mal hecho',
        postings: [
          { account: 'MERCHANT_AVAILABLE', scope: 'merchant', amount: -50_000n },
          { account: 'CHARGEBACK_LOSS', scope: 'platform', amount: 49_999n },
        ],
      }),
    ).toThrow(UnbalancedLedgerError);
  });
});

describe('invariante global bajo secuencias aleatorias', () => {
  it('mil operaciones al azar y el libro sigue sumando cero', () => {
    // Determinista: mismo generador, misma secuencia. Un fallo se reproduce.
    let seed = 42;
    const rand = (max: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % max;
    };

    const book = new Book();
    let pending = 0n;
    let available = 0n;
    let inTransit = 0n;

    for (let i = 0; i < 1000; i++) {
      const action = rand(4);

      if (action === 0) {
        const amount = BigInt(rand(1_000_000) + 50_000);
        const fee = calculateFee(amount, 290, 10_000n);
        if (fee >= amount) continue;
        book.post(chargeCaptured({ amount, fee, currency: 'CRC' }));
        pending += amount - fee;
      } else if (action === 1 && pending > 0n) {
        const amount = pending / 2n > 0n ? pending / 2n : pending;
        book.post(fundsReleased({ amount, currency: 'CRC' }));
        pending -= amount;
        available += amount;
      } else if (action === 2 && available > 0n) {
        const amount = available;
        book.post(payoutCreated({ amount, currency: 'CRC' }));
        available -= amount;
        inTransit += amount;
      } else if (action === 3 && inTransit > 0n) {
        const amount = inTransit;
        // Mitad se liquidan, mitad rebotan.
        if (rand(2) === 0) {
          book.post(payoutSettled({ amount, currency: 'CRC' }));
        } else {
          book.post(payoutFailed({ amount, currency: 'CRC' }));
          available += amount;
        }
        inTransit -= amount;
      }

      // La invariante se verifica en CADA paso, no solo al final: así el fallo
      // apunta a la operación que lo rompió.
      expect(book.total(), `descuadre en la operación ${i}`).toBe(0n);
    }

    expect(book.shown('merchant', 'MERCHANT_PENDING')).toBe(pending);
    expect(book.shown('merchant', 'MERCHANT_AVAILABLE')).toBe(available);
    expect(book.shown('merchant', 'PAYOUTS_PAYABLE')).toBe(inTransit);
  });
});

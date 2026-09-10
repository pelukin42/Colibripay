import { describe, expect, it } from 'vitest';
import type { AcquirerContext } from '@colibripay/shared';
import { SandboxAcquirer } from './index.js';

const acquirer = new SandboxAcquirer({ latencyMs: 0, timeoutMs: 0 });

const context: AcquirerContext = {
  merchantId: 'mch_test',
  mode: 'TEST',
  idempotencyKey: 'idem_test',
  credentials: {},
};

async function tokenOf(cardNumber: string): Promise<string> {
  const result = await acquirer.tokenize({
    context,
    card: { number: cardNumber, expMonth: 12, expYear: 2032, cvc: '123' },
  });
  if (result.status !== 'approved') {
    throw new Error(`No se pudo tokenizar ${cardNumber}: ${result.status}`);
  }
  return result.token;
}

function authorizeArgs(token: string, amount = 1_000_000n) {
  return {
    context,
    reference: 'ch_test',
    amount,
    currency: 'CRC' as const,
    methodType: 'CARD' as const,
    token,
    statementDescriptor: 'COLIBRI TEST',
    manualCapture: false,
  };
}

describe('tokenize', () => {
  it('emite un token que no contiene el número de tarjeta', async () => {
    const number = '4242424242424242';
    const result = await acquirer.tokenize({
      context,
      card: { number, expMonth: 12, expYear: 2032, cvc: '123' },
    });

    expect(result.status).toBe('approved');
    if (result.status !== 'approved') return;

    // La garantía central: el PAN no sobrevive a la tokenización.
    expect(result.token).not.toContain(number);
    expect(result.token).not.toContain(number.slice(0, 12));
    expect(result.last4).toBe('4242');
    expect(result.brand).toBe('visa');
  });

  it('rechaza números que no pasan Luhn', async () => {
    const result = await acquirer.tokenize({
      context,
      card: { number: '4242424242424243', expMonth: 12, expYear: 2032, cvc: '123' },
    });
    expect(result.status).toBe('declined');
    if (result.status === 'declined') {
      expect(result.declineCode).toBe('incorrect_number');
    }
  });

  it('rechaza tarjetas vencidas', async () => {
    const result = await acquirer.tokenize({
      context,
      card: { number: '4242424242424242', expMonth: 1, expYear: 2020, cvc: '123' },
    });
    expect(result.status).toBe('declined');
    if (result.status === 'declined') {
      expect(result.declineCode).toBe('expired_card');
    }
  });

  it('detecta la marca', async () => {
    const mc = await acquirer.tokenize({
      context,
      card: { number: '5555555555554444', expMonth: 12, expYear: 2032, cvc: '123' },
    });
    expect(mc.status === 'approved' && mc.brand).toBe('mastercard');
  });
});

describe('authorize', () => {
  it('aprueba la tarjeta feliz', async () => {
    const result = await acquirer.authorize(authorizeArgs(await tokenOf('4242424242424242')));
    expect(result.status).toBe('approved');
    if (result.status !== 'approved') return;
    expect(result.authCode).toHaveLength(6);
    expect(result.rrn).toBeTruthy();
  });

  it('devuelve el rechazo correcto por cada tarjeta de prueba', async () => {
    const cases = [
      ['4000000000000002', 'do_not_honor'],
      ['4000000000009995', 'insufficient_funds'],
      ['4000000000000101', 'fraudulent'],
      ['4000000000009987', 'lost_card'],
    ] as const;

    for (const [number, expected] of cases) {
      const result = await acquirer.authorize(authorizeArgs(await tokenOf(number)));
      expect(result.status, `${number} debería rechazarse`).toBe('declined');
      if (result.status === 'declined') {
        expect(result.declineCode).toBe(expected);
      }
    }
  });

  it('un rechazo del emisor es un resultado, no una excepción', async () => {
    // Si esto lanzara, todo el core tendría que envolver cada llamada en try/catch.
    await expect(
      acquirer.authorize(authorizeArgs(await tokenOf('4000000000000002'))),
    ).resolves.toMatchObject({ status: 'declined' });
  });

  it('pide 3DS cuando corresponde', async () => {
    const result = await acquirer.authorize(authorizeArgs(await tokenOf('4000000000003220')));
    expect(result.status).toBe('approved');
    if (result.status !== 'approved') return;
    expect(result.pendingAction?.kind).toBe('three_ds_challenge');
    expect(result.pendingAction?.sessionRef).toBeTruthy();
  });

  it('marca los errores de red como reintentables', async () => {
    const result = await acquirer.authorize(authorizeArgs(await tokenOf('4000000000000119')));
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.retryable).toBe(true);
    }
  });
});

describe('3DS', () => {
  it('completa la autorización tras un desafío exitoso', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4000000000003220')));
    if (auth.status !== 'approved' || !auth.pendingAction) throw new Error('sin pendingAction');

    const resumed = await acquirer.resumeAuthorization({
      context,
      sessionRef: auth.pendingAction.sessionRef,
      payload: { result: 'ok' },
    });
    expect(resumed.status).toBe('approved');
  });

  it('rechaza cuando el desafío falla', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4000000000003063')));
    if (auth.status !== 'approved' || !auth.pendingAction) throw new Error('sin pendingAction');

    const resumed = await acquirer.resumeAuthorization({
      context,
      sessionRef: auth.pendingAction.sessionRef,
      payload: { result: 'ok' },
    });
    expect(resumed.status).toBe('declined');
  });
});

describe('capture', () => {
  it('captura el monto autorizado', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4242424242424242')));
    if (auth.status !== 'approved') throw new Error('no autorizó');

    const captured = await acquirer.capture({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 1_000_000n,
      currency: 'CRC',
    });
    expect(captured.status).toBe('approved');
  });

  it('permite captura parcial', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4242424242424242')));
    if (auth.status !== 'approved') throw new Error('no autorizó');

    const captured = await acquirer.capture({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 400_000n,
      currency: 'CRC',
    });
    expect(captured.status).toBe('approved');
    if (captured.status === 'approved') {
      expect(captured.capturedAmount).toBe(400_000n);
    }
  });

  it('impide capturar más de lo autorizado', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4242424242424242')));
    if (auth.status !== 'approved') throw new Error('no autorizó');

    const captured = await acquirer.capture({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 2_000_000n,
      currency: 'CRC',
    });
    expect(captured.status).toBe('error');
  });

  it('simula el fallo de captura tras autorización exitosa', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4000000000000341')));
    if (auth.status !== 'approved') throw new Error('no autorizó');

    const captured = await acquirer.capture({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 1_000_000n,
      currency: 'CRC',
    });
    expect(captured.status).toBe('error');
  });
});

describe('sin estado', () => {
  it('una instancia nueva puede capturar lo que autorizó otra', async () => {
    // Es la prueba de que el sandbox sobrevive a reinicios y corre con varios
    // workers: si guardara las autorizaciones en memoria, esto fallaría.
    const first = new SandboxAcquirer({ latencyMs: 0 });
    const auth = await first.authorize({
      ...authorizeArgs(await tokenOf('4242424242424242')),
    });
    if (auth.status !== 'approved') throw new Error('no autorizó');

    const second = new SandboxAcquirer({ latencyMs: 0 });
    const captured = await second.capture({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 1_000_000n,
      currency: 'CRC',
    });
    expect(captured.status).toBe('approved');
  });
});

describe('refund', () => {
  it('reembolsa total y parcialmente', async () => {
    const auth = await acquirer.authorize(authorizeArgs(await tokenOf('4242424242424242')));
    if (auth.status !== 'approved') throw new Error('no autorizó');

    const partial = await acquirer.refund({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 300_000n,
      currency: 'CRC',
      reference: 're_test',
    });
    expect(partial.status).toBe('approved');

    const excessive = await acquirer.refund({
      context,
      acquirerChargeId: auth.acquirerChargeId,
      amount: 5_000_000n,
      currency: 'CRC',
      reference: 're_test2',
    });
    expect(excessive.status).toBe('error');
  });
});

describe('métodos locales', () => {
  it('aprueba SINPE Móvil sin token', async () => {
    const result = await acquirer.authorize({
      context,
      reference: 'ch_sinpe',
      amount: 500_000n,
      currency: 'CRC',
      methodType: 'SINPE_MOVIL',
      phoneNumber: '88887777',
      statementDescriptor: 'COLIBRI TEST',
      manualCapture: false,
    });
    expect(result.status).toBe('approved');
  });
});

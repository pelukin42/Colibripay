'use client';

import { useMemo, useState, type FormEvent } from 'react';

export interface CheckoutSession {
  paymentIntent: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    amountLabel: string;
    description: string | null;
    livemode: boolean;
    lastError: { message?: string } | null;
  };
  merchant: { name: string };
  tokenization: {
    url: string;
    method: 'POST';
    fields: Record<string, string>;
    fieldNames: {
      number: string;
      expMonth: string;
      expYear: string;
      cvc: string;
      holderName?: string;
    };
  };
}

type Phase =
  | { kind: 'form'; error?: string }
  | { kind: 'working'; step: 'tokenizing' | 'charging' }
  | { kind: 'done'; intentId: string }
  | { kind: 'action'; message: string };

export default function CardForm({
  session,
  clientSecret,
  apiUrl,
}: {
  session: CheckoutSession;
  clientSecret: string;
  apiUrl: string;
}) {
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvc, setCvc] = useState('');
  const [name, setName] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  const digits = number.replace(/\D/g, '');
  const brand = useMemo(() => detectBrand(digits), [digits]);
  const busy = phase.kind === 'working';

  const errors = {
    number: digits.length < 12 ? 'Número incompleto' : luhn(digits) ? null : 'Número inválido',
    expiry: validateExpiry(expiry),
    cvc: cvc.length < (brand === 'amex' ? 4 : 3) ? 'Código incompleto' : null,
  };
  const valid = !errors.number && !errors.expiry && !errors.cvc;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched({ number: true, expiry: true, cvc: true });
    if (!valid || busy) return;

    const [month, year] = expiry.split('/');
    const { fieldNames } = session.tokenization;

    try {
      setPhase({ kind: 'working', step: 'tokenizing' });

      /**
       * PASO 1 — La tarjeta va DIRECTO al vault del adquirente.
       *
       * Esta petición no toca nuestra API. Es lo que mantiene el número de
       * tarjeta fuera de la infraestructura de ColibriPay y, con eso, el
       * alcance PCI acotado. Si algún día alguien "simplifica" esto mandando
       * los datos a nuestro backend, el costo de cumplimiento se multiplica.
       */
      const vaultResponse = await fetch(session.tokenization.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...session.tokenization.fields,
          [fieldNames.number]: digits,
          [fieldNames.expMonth]: Number(month),
          [fieldNames.expYear]: 2000 + Number(year),
          [fieldNames.cvc]: cvc,
          ...(fieldNames.holderName && name ? { [fieldNames.holderName]: name } : {}),
        }),
      });

      const vaultBody = (await vaultResponse.json()) as {
        token?: string;
        error?: { message?: string };
      };

      if (!vaultResponse.ok || !vaultBody.token) {
        setPhase({
          kind: 'form',
          error: vaultBody.error?.message ?? 'No pudimos validar la tarjeta.',
        });
        return;
      }

      // PASO 2 — A nuestra API solo le llega el token.
      setPhase({ kind: 'working', step: 'charging' });

      const confirmResponse = await fetch(`${apiUrl}/v1/checkout/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientSecret,
          token: vaultBody.token,
          holderName: name || undefined,
        }),
      });

      const intent = (await confirmResponse.json()) as {
        id?: string;
        status?: string;
        lastError?: { message?: string } | null;
        error?: { message?: string };
      };

      if (!confirmResponse.ok) {
        setPhase({
          kind: 'form',
          error: intent.error?.message ?? 'No pudimos procesar el cobro.',
        });
        return;
      }

      if (intent.status === 'SUCCEEDED') {
        setPhase({ kind: 'done', intentId: intent.id ?? session.paymentIntent.id });
        return;
      }

      if (intent.status === 'REQUIRES_ACTION') {
        setPhase({
          kind: 'action',
          message: 'Tu banco pide una verificación adicional para completar este pago.',
        });
        return;
      }

      // Rechazo: el intent vuelve a REQUIRES_PAYMENT_METHOD y se puede
      // reintentar con otra tarjeta sin empezar el cobro de nuevo.
      setPhase({
        kind: 'form',
        error: intent.lastError?.message ?? 'La tarjeta fue rechazada. Probá con otra.',
      });
    } catch {
      setPhase({
        kind: 'form',
        error: 'Hubo un problema de conexión. Revisá tu internet e intentá de nuevo.',
      });
    }
  }

  if (phase.kind === 'done') {
    return (
      <div className="result">
        <div className="mark" aria-hidden="true">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h1>Pago completado</h1>
        <p>
          Se cobraron {session.paymentIntent.amountLabel} a tu tarjeta terminada en{' '}
          {digits.slice(-4)}.
        </p>
        <p className="receipt">{phase.intentId}</p>
      </div>
    );
  }

  if (phase.kind === 'action') {
    return (
      <div className="result">
        <div className="mark" aria-hidden="true">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M12 8v5" />
            <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <h1>Verificación pendiente</h1>
        <p>{phase.message}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      {phase.kind === 'form' && phase.error ? (
        <div className="alert" role="alert">
          {phase.error}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor="cc-number">Número de tarjeta</label>
        <div className="control">
          <input
            id="cc-number"
            className="numeric"
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="4242 4242 4242 4242"
            value={number}
            disabled={busy}
            aria-invalid={touched.number && !!errors.number}
            aria-describedby={touched.number && errors.number ? 'err-number' : undefined}
            onChange={(e) => setNumber(formatCardNumber(e.target.value))}
            onBlur={() => setTouched((t) => ({ ...t, number: true }))}
          />
          {brand !== 'unknown' ? <span className="brand">{brand}</span> : null}
        </div>
        {touched.number && errors.number ? (
          <p className="hint" id="err-number">
            {errors.number}
          </p>
        ) : null}
      </div>

      <div className="field">
        <div className="row">
          <div>
            <label htmlFor="cc-exp">Vencimiento</label>
            <input
              id="cc-exp"
              className="numeric"
              inputMode="numeric"
              autoComplete="cc-exp"
              placeholder="MM/AA"
              value={expiry}
              disabled={busy}
              aria-invalid={touched.expiry && !!errors.expiry}
              onChange={(e) => setExpiry(formatExpiry(e.target.value))}
              onBlur={() => setTouched((t) => ({ ...t, expiry: true }))}
            />
            {touched.expiry && errors.expiry ? <p className="hint">{errors.expiry}</p> : null}
          </div>
          <div>
            <label htmlFor="cc-cvc">Código</label>
            <input
              id="cc-cvc"
              className="numeric"
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder={brand === 'amex' ? '1234' : '123'}
              value={cvc}
              disabled={busy}
              aria-invalid={touched.cvc && !!errors.cvc}
              onChange={(e) =>
                setCvc(e.target.value.replace(/\D/g, '').slice(0, brand === 'amex' ? 4 : 3))
              }
              onBlur={() => setTouched((t) => ({ ...t, cvc: true }))}
            />
            {touched.cvc && errors.cvc ? <p className="hint">{errors.cvc}</p> : null}
          </div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="cc-name">Nombre en la tarjeta</label>
        <input
          id="cc-name"
          autoComplete="cc-name"
          placeholder="Como aparece en la tarjeta"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <button type="submit" disabled={busy}>
        {busy ? (
          <>
            <span className="spinner" aria-hidden="true" />
            {phase.step === 'tokenizing' ? 'Validando tarjeta…' : 'Procesando pago…'}
          </>
        ) : (
          `Pagar ${session.paymentIntent.amountLabel}`
        )}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Utilidades de formato y validación
//
// La validación de acá es UX, no autoridad: sirve para avisar antes de gastar
// un viaje de red. La verdad la dice el adquirente.
// ---------------------------------------------------------------------------

function formatCardNumber(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 19);
  // Amex agrupa 4-6-5; el resto, de a 4.
  if (/^3[47]/.test(digits)) {
    return [digits.slice(0, 4), digits.slice(4, 10), digits.slice(10, 15)]
      .filter(Boolean)
      .join(' ');
  }
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4);
  if (digits.length === 0) return '';

  // Si escriben "3" para marzo, se completa a "03/" — evita el error clásico
  // de que quede "31" como mes.
  if (digits.length === 1) return Number(digits) > 1 ? `0${digits}/` : digits;
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

function validateExpiry(value: string): string | null {
  const match = /^(\d{2})\/(\d{2})$/.exec(value);
  if (!match) return 'Formato MM/AA';

  const month = Number(match[1]);
  const year = 2000 + Number(match[2]);
  if (month < 1 || month > 12) return 'Mes inválido';

  const now = new Date();
  // La tarjeta sirve hasta el ÚLTIMO día del mes de vencimiento.
  const expiresAt = new Date(year, month, 1);
  return expiresAt > now ? null : 'Tarjeta vencida';
}

function detectBrand(digits: string): string {
  if (/^4/.test(digits)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(digits)) return 'mastercard';
  if (/^3[47]/.test(digits)) return 'amex';
  if (/^(6011|65|64[4-9])/.test(digits)) return 'discover';
  return 'unknown';
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

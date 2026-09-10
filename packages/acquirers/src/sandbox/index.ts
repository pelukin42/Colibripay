import {
  randomString,
  type AcquirerAdapter,
  type AcquirerResult,
  type AuthorizationData,
  type AuthorizeRequest,
  type CaptureData,
  type CaptureRequest,
  type Currency,
  type PendingAction,
  type RefundData,
  type RefundRequest,
  type ResumeAuthorizationRequest,
  type SettlementRecord,
  type TokenData,
  type TokenizeRequest,
  type VoidRequest,
} from '@colibripay/shared';
import {
  behaviorFor,
  detectBrand,
  isLuhnValid,
  type SandboxBehavior,
} from './test-cards.js';

/**
 * Adquirente simulado.
 *
 * Es un adaptador de primera clase, no un mock de tests: se comporta como un
 * adquirente real (rechaza, pide 3DS, se cae, tarda) para que el core, el
 * checkout y el dashboard se puedan construir y probar de punta a punta antes
 * de que exista un contrato bancario.
 *
 * DISEÑO: es completamente **sin estado**. El monto autorizado y el escenario
 * viajan codificados dentro del propio `acquirerChargeId`, así que capturas y
 * reembolsos funcionan tras un reinicio y con varios workers en paralelo — cosa
 * que un `Map` en memoria no da. Lo único que no puede detectar sin estado es
 * "ya se capturó": eso lo cubre el estado de nuestro propio `Charge`, que se
 * valida antes de llegar acá.
 */

interface SandboxRef {
  /** Monto en unidades mínimas. */
  a: string;
  c: Currency;
  /** Escenario serializado, para que capture/refund se comporten coherentemente. */
  s: SandboxBehavior;
}

function encodeRef(ref: SandboxRef): string {
  const json = JSON.stringify(ref);
  const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `sbx_${b64}_${randomString(8)}`;
}

function decodeRef(reference: string): SandboxRef | null {
  const parts = reference.split('_');
  // sbx_<payload>_<random>
  if (parts.length !== 3 || parts[0] !== 'sbx' || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)) as SandboxRef;
  } catch {
    return null;
  }
}

function encodeToken(behavior: SandboxBehavior): string {
  const b64 = btoa(JSON.stringify(behavior))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `tok_sbx_${b64}_${randomString(12)}`;
}

function decodeToken(token: string): SandboxBehavior | null {
  const parts = token.split('_');
  // tok_sbx_<payload>_<random>
  if (parts.length !== 4 || parts[0] !== 'tok' || parts[1] !== 'sbx' || !parts[2]) {
    return null;
  }
  try {
    const b64 = parts[2].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64)) as SandboxBehavior;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SandboxOptions {
  /** Latencia simulada. Poner 0 en tests unitarios. */
  latencyMs?: number;
  /** Milisegundos que espera la tarjeta `4000000000000010` antes de fallar. */
  timeoutMs?: number;
}

export class SandboxAcquirer implements AcquirerAdapter {
  readonly name = 'sandbox';
  readonly supportedMethods = ['CARD', 'SINPE_MOVIL', 'BANK_TRANSFER'] as const;
  readonly supportedCurrencies = ['CRC', 'USD'] as const;
  readonly supportsManualCapture = true;
  readonly supportsPartialRefund = true;

  private readonly latencyMs: number;
  private readonly timeoutMs: number;

  constructor(options: SandboxOptions = {}) {
    this.latencyMs = options.latencyMs ?? 120;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async tokenize(req: TokenizeRequest): Promise<AcquirerResult<TokenData>> {
    await sleep(this.latencyMs);

    const number = req.card.number.replace(/\D/g, '');

    if (!isLuhnValid(number)) {
      return {
        status: 'declined',
        declineCode: 'incorrect_number',
        rawCode: 'SBX_LUHN',
        rawMessage: 'El número de tarjeta no pasa la validación de Luhn',
      };
    }

    const now = new Date();
    const expired =
      req.card.expYear < now.getFullYear() ||
      (req.card.expYear === now.getFullYear() && req.card.expMonth < now.getMonth() + 1);
    if (expired) {
      return { status: 'declined', declineCode: 'expired_card', rawCode: 'SBX_EXP' };
    }

    const behavior = behaviorFor(number);

    // El CVC se valida y se descarta acá mismo. Nunca sale de esta función.
    const cvcValid = /^\d{3,4}$/.test(req.card.cvc);
    if (!cvcValid) {
      return { status: 'declined', declineCode: 'incorrect_cvc', rawCode: 'SBX_CVC' };
    }

    return {
      status: 'approved',
      token: encodeToken(behavior),
      brand: detectBrand(number),
      last4: number.slice(-4),
      bin: number.slice(0, 6),
      expMonth: req.card.expMonth,
      expYear: req.card.expYear,
      // Huella estable por tarjeta, sin permitir reconstruir el número.
      fingerprint: `sbxfp_${number.slice(0, 6)}${number.slice(-4)}`,
      cvcCheck: behavior.kind === 'decline' && behavior.declineCode === 'incorrect_cvc'
        ? 'fail'
        : 'pass',
    };
  }

  async authorize(
    req: AuthorizeRequest,
  ): Promise<AcquirerResult<AuthorizationData & { pendingAction?: PendingAction }>> {
    await sleep(this.latencyMs);

    if (!this.supportedCurrencies.includes(req.currency)) {
      return {
        status: 'declined',
        declineCode: 'currency_not_supported',
        rawCode: 'SBX_CUR',
      };
    }

    // SINPE y transferencia se aprueban siempre: el core los resuelve por
    // conciliación posterior, no por respuesta en línea.
    if (req.methodType !== 'CARD') {
      return this.approved(req.amount, req.currency, { kind: 'approve' });
    }

    if (!req.token) {
      return {
        status: 'error',
        retryable: false,
        message: 'authorize() para CARD requiere un token',
      };
    }

    const behavior = decodeToken(req.token);
    if (!behavior) {
      return { status: 'error', retryable: false, message: 'Token de sandbox inválido' };
    }

    switch (behavior.kind) {
      case 'approve':
      case 'approve_then_dispute':
      case 'approve_then_capture_fails':
        return this.approved(req.amount, req.currency, behavior);

      case 'decline':
        return {
          status: 'declined',
          declineCode: behavior.declineCode,
          rawCode: `SBX_${behavior.declineCode.toUpperCase()}`,
          rawMessage: `Sandbox: rechazo simulado (${behavior.declineCode})`,
        };

      case 'error':
        return {
          status: 'error',
          retryable: behavior.retryable,
          message: `Sandbox: ${behavior.message}`,
          rawCode: 'SBX_ERR',
        };

      case 'timeout':
        await sleep(this.timeoutMs);
        return {
          status: 'error',
          retryable: true,
          message: 'Sandbox: el adquirente no respondió a tiempo',
          rawCode: 'SBX_TIMEOUT',
        };

      case 'require_3ds':
        // El core traduce esto a REQUIRES_ACTION y el checkout muestra el desafío.
        return {
          status: 'approved',
          acquirerChargeId: encodeRef({
            a: req.amount.toString(),
            c: req.currency,
            s: behavior,
          }),
          authCode: '',
          rawCode: 'SBX_3DS',
          rawMessage: 'Se requiere autenticación 3-D Secure',
          pendingAction: {
            kind: 'three_ds_challenge',
            url: `/sandbox/3ds?session=${randomString(16)}`,
            sessionRef: encodeRef({
              a: req.amount.toString(),
              c: req.currency,
              s: behavior,
            }),
            expiresAt: new Date(Date.now() + 15 * 60_000),
          },
        };
    }
  }

  async resumeAuthorization(
    req: ResumeAuthorizationRequest,
  ): Promise<AcquirerResult<AuthorizationData>> {
    await sleep(this.latencyMs);

    const ref = decodeRef(req.sessionRef);
    if (!ref) {
      return { status: 'error', retryable: false, message: 'Sesión 3DS inválida' };
    }

    const passed = req.payload.result !== 'fail';
    const shouldApprove = ref.s.kind === 'require_3ds' ? ref.s.thenApprove : true;

    if (!passed || !shouldApprove) {
      return {
        status: 'declined',
        declineCode: 'authentication_required',
        rawCode: 'SBX_3DS_FAIL',
        rawMessage: 'Sandbox: la autenticación 3-D Secure no se completó',
      };
    }

    return this.approved(BigInt(ref.a), ref.c, { kind: 'approve' });
  }

  async capture(req: CaptureRequest): Promise<AcquirerResult<CaptureData>> {
    await sleep(this.latencyMs);

    const ref = decodeRef(req.acquirerChargeId);
    if (!ref) {
      return { status: 'error', retryable: false, message: 'Referencia de cargo inválida' };
    }

    const authorized = BigInt(ref.a);
    if (req.amount > authorized) {
      return {
        status: 'error',
        retryable: false,
        message: `No se puede capturar ${req.amount} sobre una autorización de ${authorized}`,
      };
    }

    if (ref.s.kind === 'approve_then_capture_fails') {
      return {
        status: 'error',
        retryable: false,
        message: 'Sandbox: fallo simulado en la captura',
        rawCode: 'SBX_CAP_FAIL',
      };
    }

    return {
      status: 'approved',
      acquirerChargeId: req.acquirerChargeId,
      capturedAmount: req.amount,
      rrn: randomString(12).toUpperCase(),
      raw: { sandbox: true, capturedAt: new Date().toISOString() },
    };
  }

  async void(req: VoidRequest): Promise<AcquirerResult<{ acquirerChargeId: string }>> {
    await sleep(this.latencyMs);
    if (!decodeRef(req.acquirerChargeId)) {
      return { status: 'error', retryable: false, message: 'Referencia de cargo inválida' };
    }
    return { status: 'approved', acquirerChargeId: req.acquirerChargeId };
  }

  async refund(req: RefundRequest): Promise<AcquirerResult<RefundData>> {
    await sleep(this.latencyMs);

    const ref = decodeRef(req.acquirerChargeId);
    if (!ref) {
      return { status: 'error', retryable: false, message: 'Referencia de cargo inválida' };
    }

    // El tope por reembolsos parciales acumulados lo controla el core, que es
    // quien conoce el historial completo del cargo.
    if (req.amount > BigInt(ref.a)) {
      return {
        status: 'error',
        retryable: false,
        message: 'El reembolso excede el monto del cargo',
      };
    }

    return {
      status: 'approved',
      acquirerRefundId: `sbxre_${randomString(16)}`,
      refundedAmount: req.amount,
      raw: { sandbox: true, reason: req.reason ?? null },
    };
  }

  /** El sandbox no publica archivo de liquidación: la conciliación se prueba con seeds. */
  async fetchSettlement(): Promise<SettlementRecord[]> {
    return [];
  }

  async ping(): Promise<boolean> {
    return true;
  }

  private approved(
    amount: bigint,
    currency: Currency,
    behavior: SandboxBehavior,
  ): AcquirerResult<AuthorizationData & { pendingAction?: PendingAction }> {
    return {
      status: 'approved',
      acquirerChargeId: encodeRef({ a: amount.toString(), c: currency, s: behavior }),
      authCode: randomString(6).toUpperCase(),
      rrn: randomString(12).toUpperCase(),
      rawCode: '00',
      rawMessage: 'Aprobada',
      raw: { sandbox: true, authorizedAt: new Date().toISOString() },
    };
  }
}

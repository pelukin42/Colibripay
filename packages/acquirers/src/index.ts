import type { AcquirerAdapter } from '@colibripay/shared';
import { SandboxAcquirer } from './sandbox/index.js';

export { SandboxAcquirer } from './sandbox/index.js';
export * from './sandbox/test-cards.js';

/**
 * Registro de adaptadores.
 *
 * Acá se enchufan los adquirentes reales cuando existan los contratos. El core
 * resuelve el adaptador por nombre, así que agregar BAC o Promerica es
 * registrar una línea más — no tocar la lógica de pagos.
 */
const registry = new Map<string, AcquirerAdapter>();

export function registerAcquirer(adapter: AcquirerAdapter): void {
  if (registry.has(adapter.name)) {
    throw new Error(`El adquirente "${adapter.name}" ya está registrado`);
  }
  registry.set(adapter.name, adapter);
}

export function getAcquirer(name: string): AcquirerAdapter {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(
      `Adquirente desconocido: "${name}". Registrados: ${[...registry.keys()].join(', ') || 'ninguno'}`,
    );
  }
  return adapter;
}

export function listAcquirers(): AcquirerAdapter[] {
  return [...registry.values()];
}

/**
 * Elige adaptador para un cobro. Hoy es trivial; es el punto donde después vive
 * el ruteo real (por BIN, por moneda, por tasa de aprobación, o failover a un
 * segundo adquirente cuando el primero se cae).
 */
export function selectAcquirer(params: {
  merchantPreference?: string;
  methodType: 'CARD' | 'SINPE_MOVIL' | 'BANK_TRANSFER';
  currency: 'CRC' | 'USD';
}): AcquirerAdapter {
  if (params.merchantPreference) {
    return getAcquirer(params.merchantPreference);
  }

  const candidate = listAcquirers().find(
    (a) =>
      a.supportedMethods.includes(params.methodType) &&
      a.supportedCurrencies.includes(params.currency),
  );

  if (!candidate) {
    throw new Error(
      `Ningún adquirente registrado soporta ${params.methodType} en ${params.currency}`,
    );
  }
  return candidate;
}

// El sandbox se registra siempre: es el que permite que todo funcione sin banco.
registerAcquirer(new SandboxAcquirer());

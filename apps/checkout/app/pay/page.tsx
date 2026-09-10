import CardForm, { type CheckoutSession } from './CardForm';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

/**
 * Pantalla de pago.
 *
 * La sesión se carga en el SERVIDOR, no en el navegador. Así el `client_secret`
 * no viaja en una petición visible desde la consola del comprador más veces de
 * las necesarias, y la página llega ya pintada con el monto — que es lo primero
 * que alguien quiere confirmar antes de escribir su tarjeta.
 */
export default async function PayPage({
  searchParams,
}: {
  searchParams: Promise<{ cs?: string }>;
}) {
  const { cs } = await searchParams;

  if (!cs) return <Failure title="Enlace de pago inválido" detail="Falta la sesión de pago." />;

  let session: CheckoutSession;
  try {
    const response = await fetch(
      `${API_URL}/v1/checkout/session?client_secret=${encodeURIComponent(cs)}`,
      { cache: 'no-store' },
    );
    if (!response.ok) {
      return (
        <Failure
          title="No encontramos este pago"
          detail="El enlace venció o ya no es válido. Pedile uno nuevo al comercio."
        />
      );
    }
    session = (await response.json()) as CheckoutSession;
  } catch {
    return (
      <Failure
        title="No pudimos cargar el pago"
        detail="Hubo un problema de conexión. Recargá la página para intentar de nuevo."
      />
    );
  }

  if (session.paymentIntent.status === 'SUCCEEDED') {
    return (
      <main className="shell">
        <div className="card">
          <div className="result">
            <div className="mark" aria-hidden="true">
              <CheckIcon />
            </div>
            <h1>Este pago ya se completó</h1>
            <p>No hay nada más que hacer.</p>
            <p className="receipt">{session.paymentIntent.id}</p>
          </div>
        </div>
      </main>
    );
  }

  if (session.paymentIntent.status === 'CANCELED') {
    return <Failure title="Este pago fue cancelado" detail="Pedile un enlace nuevo al comercio." />;
  }

  return (
    <main className="shell">
      <div className="card">
        <div className="summary">
          <p className="merchant">{session.merchant.name}</p>
          <p className="amount">{session.paymentIntent.amountLabel}</p>
          {session.paymentIntent.description ? (
            <p className="concept">{session.paymentIntent.description}</p>
          ) : null}
          {!session.paymentIntent.livemode ? (
            <span className="testbadge">Modo de prueba</span>
          ) : null}
        </div>
        <CardForm session={session} clientSecret={cs} apiUrl={API_URL} />
      </div>
      <p className="footer">
        Pago protegido por <strong>ColibriPay</strong>
      </p>
    </main>
  );
}

function Failure({ title, detail }: { title: string; detail: string }) {
  return (
    <main className="shell">
      <div className="card">
        <div className="result">
          <div className="mark bad" aria-hidden="true">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
          <h1>{title}</h1>
          <p>{detail}</p>
        </div>
      </div>
    </main>
  );
}

function CheckIcon() {
  return (
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
  );
}

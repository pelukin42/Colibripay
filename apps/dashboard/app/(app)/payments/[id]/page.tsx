import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@colibripay/db';
import { requireMember } from '../../../../lib/auth';
import {
  cardLabel,
  chargeLabel,
  intentLabel,
  money,
  when,
  whenLong,
} from '../../../../lib/format';

export default async function PaymentDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const member = await requireMember();
  const { id } = await params;

  // El filtro por comercio va en el WHERE, no en un chequeo posterior: así es
  // imposible que un cambio futuro deje ver el cobro de otro comercio.
  const intent = await prisma.paymentIntent.findFirst({
    where: { publicId: id, merchantId: member.merchant.id },
    include: {
      paymentMethod: true,
      customer: true,
      charges: { orderBy: { createdAt: 'asc' }, include: { refunds: true } },
    },
  });

  if (!intent) notFound();

  const events = await prisma.event.findMany({
    where: {
      merchantId: member.merchant.id,
      mode: intent.mode,
      data: { path: ['id'], equals: intent.publicId },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const label = intentLabel(intent.status);
  const lastError = intent.lastError as { message?: string } | null;

  return (
    <>
      <div className="page-head">
        <Link
          href="/payments"
          style={{ color: 'var(--ink-faint)', fontSize: 13 }}
        >
          ← Cobros
        </Link>
        <h1 style={{ marginTop: 8 }}>{money(intent.amount, intent.currency)}</h1>
        <p>
          <span className={`tag ${label.tone}`}>{label.text}</span>{' '}
          <span className="mono">{intent.publicId}</span>
        </p>
      </div>

      {lastError?.message ? <div className="alert">{lastError.message}</div> : null}

      <div className="stack">
        <div className="panel">
          <div className="panel-head">Detalle</div>
          <div className="panel-body">
            <dl className="detail-grid">
              <dt>Creado</dt>
              <dd>{whenLong(intent.createdAt)}</dd>

              {intent.succeededAt ? (
                <>
                  <dt>Completado</dt>
                  <dd>{whenLong(intent.succeededAt)}</dd>
                </>
              ) : null}

              <dt>Método</dt>
              <dd>{cardLabel(intent.paymentMethod)}</dd>

              {intent.description ? (
                <>
                  <dt>Concepto</dt>
                  <dd>{intent.description}</dd>
                </>
              ) : null}

              {intent.customer?.email ? (
                <>
                  <dt>Cliente</dt>
                  <dd>{intent.customer.email}</dd>
                </>
              ) : null}

              <dt>Recibido</dt>
              <dd>{money(intent.amountReceived, intent.currency)}</dd>

              {intent.amountRefunded > 0n ? (
                <>
                  <dt>Reembolsado</dt>
                  <dd>{money(intent.amountRefunded, intent.currency)}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">Intentos de cobro</div>
          {intent.charges.length === 0 ? (
            <p className="empty">Todavía no se intentó cobrar.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Cargo</th>
                    <th>Estado</th>
                    <th>Autorización</th>
                    <th>Referencia</th>
                    <th className="num">Comisión</th>
                    <th className="num">Neto</th>
                  </tr>
                </thead>
                <tbody>
                  {intent.charges.map((charge) => {
                    const tag = chargeLabel(charge.status);
                    return (
                      <tr key={charge.id}>
                        <td className="mono">{charge.publicId}</td>
                        <td>
                          <span className={`tag ${tag.tone}`}>{tag.text}</span>
                          {charge.responseMessage && charge.status === 'FAILED' ? (
                            <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>
                              {charge.responseMessage}
                            </div>
                          ) : null}
                        </td>
                        <td className="mono">{charge.authCode || '—'}</td>
                        {/* El RRN es lo que el comercio necesita para cuadrar
                            contra el estado de cuenta de su banco. */}
                        <td className="mono">{charge.rrn || '—'}</td>
                        <td className="num">{money(charge.feeAmount, charge.currency)}</td>
                        <td className="num">{money(charge.netAmount, charge.currency)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head">Historial</div>
          <div className="panel-body">
            {events.length === 0 ? (
              <p style={{ color: 'var(--ink-faint)', margin: 0 }}>Sin eventos registrados.</p>
            ) : (
              <ul className="timeline">
                {events.map((event) => (
                  <li key={event.id}>
                    <time>{when(event.createdAt)}</time>
                    <span className="mono">{event.type}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

import Link from 'next/link';
import { prisma } from '@colibripay/db';
import { requireMember } from '../../../lib/auth';
import { cardLabel, intentLabel, money, resolveMode, when } from '../../../lib/format';

const PAGE_SIZE = 40;

export default async function Payments({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; page?: string }>;
}) {
  const member = await requireMember();
  const params = await searchParams;
  const mode = resolveMode(params.mode);

  const page = Math.max(1, Number(params.page ?? '1') || 1);

  const [intents, total] = await Promise.all([
    prisma.paymentIntent.findMany({
      where: { merchantId: member.merchant.id, mode },
      include: { paymentMethod: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.paymentIntent.count({ where: { merchantId: member.merchant.id, mode } }),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (target: number) =>
    `/payments?page=${target}${mode === 'LIVE' ? '&mode=live' : ''}`;

  return (
    <>
      <div className="page-head">
        <h1>Cobros</h1>
        <p>
          {total} {total === 1 ? 'cobro' : 'cobros'} ·{' '}
          {mode === 'LIVE' ? 'datos reales' : 'modo de prueba'}
        </p>
      </div>

      <div className="panel">
        {intents.length === 0 ? (
          <p className="empty">No hay cobros para mostrar.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Cobro</th>
                  <th>Método</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th className="num">Monto</th>
                </tr>
              </thead>
              <tbody>
                {intents.map((intent) => {
                  const label = intentLabel(intent.status);
                  return (
                    <tr key={intent.id}>
                      <td>
                        <Link className="mono" href={`/payments/${intent.publicId}`}>
                          {intent.publicId}
                        </Link>
                        {intent.description ? (
                          <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>
                            {intent.description}
                          </div>
                        ) : null}
                      </td>
                      <td>{cardLabel(intent.paymentMethod)}</td>
                      <td>
                        <span className={`tag ${label.tone}`}>{label.text}</span>
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>{when(intent.createdAt)}</td>
                      <td className="num">{money(intent.amount, intent.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pages > 1 ? (
        <div className="row-actions" style={{ marginTop: 16, justifyContent: 'space-between' }}>
          {page > 1 ? (
            <Link className="btn ghost" href={link(page - 1)}>
              Anteriores
            </Link>
          ) : (
            <span />
          )}
          <span style={{ color: 'var(--ink-faint)', fontSize: 13 }}>
            Página {page} de {pages}
          </span>
          {page < pages ? (
            <Link className="btn ghost" href={link(page + 1)}>
              Siguientes
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </>
  );
}

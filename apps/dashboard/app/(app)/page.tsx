import Link from 'next/link';
import { prisma } from '@colibripay/db';
import { displayBalance, type LedgerAccountType } from '@colibripay/shared';
import { requireMember } from '../../lib/auth';
import { cardLabel, intentLabel, money, resolveMode, when } from '../../lib/format';

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const member = await requireMember();
  const mode = resolveMode((await searchParams).mode);
  const currency = member.merchant.defaultCurrency;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [accounts, captured, attempts, recent] = await Promise.all([
    prisma.ledgerAccount.findMany({
      where: { merchantId: member.merchant.id, mode, currency },
      select: { type: true, balance: true },
    }),
    prisma.charge.aggregate({
      where: {
        merchantId: member.merchant.id,
        mode,
        status: 'CAPTURED',
        capturedAt: { gte: since },
      },
      _sum: { amount: true, feeAmount: true },
      _count: true,
    }),
    // Tasa de aprobación: de los cargos que llegaron a decidirse, cuántos
    // pasaron. Los PENDING se excluyen porque todavía no dicen nada.
    prisma.charge.groupBy({
      by: ['status'],
      where: { merchantId: member.merchant.id, mode, createdAt: { gte: since } },
      _count: true,
    }),
    prisma.paymentIntent.findMany({
      where: { merchantId: member.merchant.id, mode },
      include: { paymentMethod: true },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
  ]);

  const balance = (type: LedgerAccountType): bigint => {
    const row = accounts.find((account) => account.type === type);
    return displayBalance(type, row?.balance ?? 0n);
  };

  const decided = attempts.filter((row) => row.status !== 'PENDING');
  const approved = decided
    .filter((row) => row.status === 'CAPTURED' || row.status === 'AUTHORIZED')
    .reduce((sum, row) => sum + row._count, 0);
  const total = decided.reduce((sum, row) => sum + row._count, 0);

  return (
    <>
      <div className="page-head">
        <h1>Resumen</h1>
        <p>Últimos 30 días · {mode === 'LIVE' ? 'datos reales' : 'modo de prueba'}</p>
      </div>

      <dl className="metrics">
        <div className="metric">
          <dt>Disponible</dt>
          <dd>
            {money(balance('MERCHANT_AVAILABLE'), currency)}
            <span className="note">Listo para transferir</span>
          </dd>
        </div>
        <div className="metric">
          <dt>Pendiente</dt>
          <dd>
            {money(balance('MERCHANT_PENDING'), currency)}
            <span className="note">Se libera a los {member.merchant.holdDays} días</span>
          </dd>
        </div>
        <div className="metric">
          <dt>Cobrado</dt>
          <dd>
            {money(captured._sum.amount ?? 0n, currency)}
            <span className="note">
              {captured._count} {captured._count === 1 ? 'cobro' : 'cobros'}
            </span>
          </dd>
        </div>
        <div className="metric">
          <dt>Aprobación</dt>
          <dd>
            {total > 0 ? `${Math.round((approved / total) * 100)}%` : '—'}
            <span className="note">
              {total > 0 ? `${approved} de ${total} intentos` : 'Sin intentos aún'}
            </span>
          </dd>
        </div>
      </dl>

      <div className="panel">
        <div className="panel-head">
          Cobros recientes
          <Link
            className="btn ghost"
            href={mode === 'LIVE' ? '/payments?mode=live' : '/payments'}
          >
            Ver todos
          </Link>
        </div>

        {recent.length === 0 ? (
          <p className="empty">
            Todavía no hay cobros en {mode === 'LIVE' ? 'modo real' : 'modo de prueba'}.
          </p>
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
                {recent.map((intent) => {
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
    </>
  );
}

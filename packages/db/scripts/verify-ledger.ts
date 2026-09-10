import { PrismaClient } from '@prisma/client';

/**
 * Verificación de integridad del libro mayor.
 *
 * Comprueba tres cosas, en orden de gravedad:
 *
 *  1. Que cada TRANSACCIÓN sume cero. Si una no lo hace, se escribió un asiento
 *     descuadrado y hay plata inventada o desaparecida.
 *  2. Que el saldo almacenado de cada cuenta coincida con la suma de sus
 *     asientos. Los saldos son una caché; los asientos son la verdad.
 *  3. Que el libro completo sume cero.
 *
 * Debería correr como tarea diaria. Un descuadre hay que descubrirlo por una
 * alerta, no por el reclamo de un comercio tres meses después.
 */

const prisma = new PrismaClient();

const money = (value: bigint) => (Number(value) / 100).toFixed(2).padStart(14);

async function main(): Promise<void> {
  let problems = 0;

  // --- 1. Cada transacción cuadra ---
  const byTransaction = await prisma.ledgerEntry.groupBy({
    by: ['transactionId'],
    _sum: { amount: true },
  });

  const unbalanced = byTransaction.filter((row) => (row._sum.amount ?? 0n) !== 0n);
  if (unbalanced.length > 0) {
    problems += unbalanced.length;
    console.log(`\n  ${unbalanced.length} TRANSACCIONES DESCUADRADAS:\n`);
    for (const row of unbalanced) {
      console.log(`    ${row.transactionId}  delta=${row._sum.amount}`);
    }
  }

  // --- 2. Saldos vs. asientos ---
  const accounts = await prisma.ledgerAccount.findMany({
    orderBy: [{ scopeKey: 'asc' }, { type: 'asc' }],
  });
  const sums = await prisma.ledgerEntry.groupBy({
    by: ['accountId'],
    _sum: { amount: true },
  });
  const computed = new Map(sums.map((row) => [row.accountId, row._sum.amount ?? 0n]));

  console.log('\n  Cuentas\n');
  console.log(`    ${'ámbito'.padEnd(28)} ${'cuenta'.padEnd(22)} ${'saldo'.padStart(14)}`);
  console.log(`    ${'-'.repeat(28)} ${'-'.repeat(22)} ${'-'.repeat(14)}`);

  let global = 0n;
  for (const account of accounts) {
    const actual = computed.get(account.id) ?? 0n;
    global += actual;

    const scope = account.scopeKey === 'platform' ? 'plataforma' : account.scopeKey;
    let line = `    ${scope.padEnd(28)} ${account.type.padEnd(22)} ${money(actual)}`;

    if (actual !== account.balance) {
      problems += 1;
      line += `  <-- CACHÉ DESINCRONIZADA (guardado ${account.balance})`;
    }
    console.log(line);
  }

  // --- 3. El libro completo ---
  console.log('');
  if (global === 0n) {
    console.log(`    El libro suma exactamente cero. ${byTransaction.length} transacciones verificadas.`);
  } else {
    problems += 1;
    console.log(`    EL LIBRO NO CUADRA. Diferencia global: ${global}`);
  }

  console.log('');
  if (problems > 0) {
    console.log(`  ${problems} problema(s) detectado(s). NO liquidar hasta resolverlos.\n`);
    process.exitCode = 1;
  } else {
    console.log('  Integridad verificada.\n');
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

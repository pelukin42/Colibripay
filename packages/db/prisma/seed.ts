import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashApiKey } from '../src/api-keys.js';
import { encryptSecret } from '../src/encryption.js';
import { hashPassword } from '../src/passwords.js';

const prisma = new PrismaClient();

/** Solo para desarrollo. En producción el alta la hace el propio comercio. */
const DEMO_PASSWORD = 'colibri-demo-2026';

/** Base58 sin caracteres ambiguos, igual que en @colibripay/shared. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function randomString(length: number): string {
  const max = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length + 8)) {
      if (out.length === length) break;
      if (byte < max) out += ALPHABET[byte % ALPHABET.length];
    }
  }
  return out;
}

async function main(): Promise<void> {
  const merchant = await prisma.merchant.upsert({
    where: { publicId: 'mch_demo_colibri' },
    // Igual que con la contraseña: con `update: {}` un comercio ya existente
    // conservaba la configuración vieja y el seed mentía sobre lo que dejaba
    // en la base. La tarifa en particular importa, porque está regulada.
    update: { feeBps: 150, feeFixed: 0n, status: 'ACTIVE' },
    create: {
      publicId: 'mch_demo_colibri',
      legalName: 'Comercio Demo S.A.',
      tradeName: 'Comercio Demo',
      taxId: '3101999999', // cédula jurídica: 10 dígitos empezando en 3
      email: 'demo@colibripay.test',
      status: 'ACTIVE',
      defaultCurrency: 'CRC',
      statementDescriptor: 'COMERCIO DEMO',
      // Costa Rica REGULA este número: la Ley 9831 faculta al BCCR a fijar el
      // tope de la comisión de adquirencia. El 2,90 % + ₡100 que había acá
      // antes era un invento tomado de pasarelas de otros países y muy
      // probablemente ilegal en CR. Este valor es conservador a propósito;
      // el real hay que tomarlo de la resolución vigente del BCCR.
      feeBps: 150,
      feeFixed: 0n,
      holdDays: 2,
      reserveBps: 0,
    },
  });

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const user = await prisma.user.upsert({
    where: { email: 'demo@colibripay.test' },
    // La contraseña se reescribe en cada seed. Con `update: {}` un usuario ya
    // existente conservaba el hash viejo y las credenciales que imprime este
    // script dejaban de servir — sin ninguna señal de por qué.
    update: { passwordHash },
    create: {
      email: 'demo@colibripay.test',
      name: 'Dueño Demo',
      passwordHash,
    },
  });

  await prisma.merchantMember.upsert({
    where: { merchantId_userId: { merchantId: merchant.id, userId: user.id } },
    update: {},
    create: { merchantId: merchant.id, userId: user.id, role: 'OWNER' },
  });

  // Las llaves se regeneran en cada seed: se muestran una sola vez, igual que
  // en producción, porque la base solo guarda el hash.
  await prisma.apiKey.deleteMany({ where: { merchantId: merchant.id } });

  const created: string[] = [];
  for (const type of ['PUBLIC', 'SECRET'] as const) {
    for (const mode of ['TEST', 'LIVE'] as const) {
      const prefix = `${type === 'PUBLIC' ? 'pk' : 'sk'}_${mode.toLowerCase()}`;
      const body = randomString(32);
      const key = `${prefix}_${body}`;

      await prisma.apiKey.create({
        data: {
          merchantId: merchant.id,
          type,
          mode,
          name: `${type === 'PUBLIC' ? 'Pública' : 'Secreta'} ${mode}`,
          prefix,
          lastFour: body.slice(-4),
          hashedKey: hashApiKey(key),
        },
      });

      created.push(key);
    }
  }

  const webhookSecret = `whsec_${randomString(32)}`;
  await prisma.webhookEndpoint.upsert({
    where: { publicId: 'we_demo_local' },
    update: { secretEncrypted: encryptSecret(webhookSecret) },
    create: {
      publicId: 'we_demo_local',
      merchantId: merchant.id,
      mode: 'TEST',
      url: 'http://localhost:3001/webhooks/colibri',
      description: 'Endpoint local de pruebas',
      secretEncrypted: encryptSecret(webhookSecret),
      enabledEvents: [], // vacío = todos
    },
  });

  console.log('\n  Comercio demo listo.\n');
  console.log(`  Comercio:  ${merchant.publicId}`);
  console.log(`  Dashboard: ${user.email} / ${DEMO_PASSWORD}`);
  console.log(
    `  Comisión:  ${merchant.feeBps / 100} % — tope regulado por el BCCR (Ley 9831)\n`,
  );
  console.log('  Llaves de API (guardalas, no se vuelven a mostrar):\n');
  for (const key of created) console.log(`    ${key}`);
  console.log(`\n  Secreto de webhook:\n    ${webhookSecret}\n`);
  console.log('  Probá con:\n');
  console.log(
    `    curl -X POST http://localhost:4000/v1/payment_intents \\\n` +
      `      -H "Authorization: Bearer ${created.find((k) => k.startsWith('sk_test'))}" \\\n` +
      `      -H "Content-Type: application/json" \\\n` +
      `      -H "Idempotency-Key: $(date +%s)" \\\n` +
      `      -d '{"amount":1000000,"currency":"CRC"}'\n`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });

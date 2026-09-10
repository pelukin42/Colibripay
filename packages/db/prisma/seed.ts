import { randomBytes, createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { hashApiKey } from '../src/api-keys.js';
import { encryptSecret } from '../src/encryption.js';

const prisma = new PrismaClient();

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
    update: {},
    create: {
      publicId: 'mch_demo_colibri',
      legalName: 'Comercio Demo S.A.',
      tradeName: 'Comercio Demo',
      taxId: '3101999999',
      email: 'demo@colibripay.test',
      status: 'ACTIVE',
      defaultCurrency: 'CRC',
      statementDescriptor: 'COMERCIO DEMO',
      feeBps: 290,
      feeFixed: 10_000n, // ₡100
      holdDays: 2,
      reserveBps: 0,
    },
  });

  const user = await prisma.user.upsert({
    where: { email: 'demo@colibripay.test' },
    update: {},
    create: {
      email: 'demo@colibripay.test',
      name: 'Dueño Demo',
      // Placeholder: el login del dashboard usará Argon2id, no esto.
      passwordHash: createHash('sha256').update('demo-no-usar').digest('hex'),
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
  console.log(`  Usuario:   ${user.email}\n`);
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

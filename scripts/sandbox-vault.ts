import { createServer } from 'node:http';
import { SandboxAcquirer } from '@colibripay/acquirers';

/**
 * Vault de tarjetas simulado.
 *
 * Corre como servidor SEPARADO, en otro puerto, a propósito. En producción esto
 * sería el dominio del adquirente —otra empresa, otra infraestructura, otro
 * alcance PCI— y el navegador le postea la tarjeta directamente. Levantarlo
 * como parte de nuestra API en desarrollo daría una falsa sensación de que el
 * flujo funciona, y escondería que el PAN estaría pasando por donde no debe.
 *
 * Lo único que sale de acá hacia nuestra plataforma es un token opaco.
 *
 *   pnpm vault
 */

const port = Number(process.env.VAULT_PORT ?? 4002);
const allowedOrigins = (process.env.VAULT_ALLOWED_ORIGINS ?? 'http://localhost:4001')
  .split(',')
  .map((value) => value.trim());

const acquirer = new SandboxAcquirer({ latencyMs: 300 });

const server = createServer((req, res) => {
  const origin = req.headers.origin ?? '';
  const allowed = allowedOrigins.includes(origin);

  // El navegador postea desde el origen del checkout, así que hace falta CORS.
  // Lista blanca y no comodín: este endpoint recibe números de tarjeta.
  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(allowed ? 204 : 403).end();
    return;
  }

  if (req.method !== 'POST' || !req.url?.startsWith('/tokenize')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no encontrado' }));
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));

  req.on('end', () => {
    void (async () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'JSON inválido' } }));
        return;
      }

      const result = await acquirer.tokenize({
        context: {
          merchantId: String(body.merchant ?? ''),
          mode: body.mode === 'LIVE' ? 'LIVE' : 'TEST',
          idempotencyKey: '',
          credentials: {},
        },
        card: {
          number: String(body.number ?? ''),
          expMonth: Number(body.expMonth),
          expYear: Number(body.expYear),
          cvc: String(body.cvc ?? ''),
          holderName: body.holderName ? String(body.holderName) : undefined,
        },
      });

      // NUNCA registrar el cuerpo de la petición: contiene el PAN y el CVC.
      // Solo se registra el resultado.
      if (result.status !== 'approved') {
        const message =
          result.status === 'declined'
            ? `Tarjeta rechazada (${result.declineCode})`
            : result.message;
        console.log(`  RECHAZADA  ${message}`);
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: result.status === 'declined' ? result.declineCode : 'processing_error',
              message,
            },
          }),
        );
        return;
      }

      console.log(`  TOKENIZADA  ${result.brand} ****${result.last4}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          token: result.token,
          brand: result.brand,
          last4: result.last4,
          expMonth: result.expMonth,
          expYear: result.expYear,
        }),
      );
    })();
  });
});

server.listen(port, () => {
  console.log(`\n  Vault de tarjetas (simulado) en http://localhost:${port}`);
  console.log(`  Orígenes permitidos: ${allowedOrigins.join(', ')}`);
  console.log('\n  Representa al adquirente. El PAN llega acá y NO a la API.\n');
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});

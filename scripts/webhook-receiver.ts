import { createServer } from 'node:http';
import { verifyWebhookSignature, SIGNATURE_HEADER } from '@colibripay/shared';

/**
 * Receptor de webhooks de prueba.
 *
 * Hace exactamente lo que debería hacer un comercio integrando, y sirve de
 * ejemplo copiable: leer el cuerpo CRUDO, verificar la firma antes de mirar el
 * contenido, y responder rápido.
 *
 *   WEBHOOK_SECRET=whsec_... tsx scripts/webhook-receiver.ts
 *
 * Con FAIL_TIMES=n rechaza las primeras n entregas, para ver los reintentos.
 */

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error('Falta WEBHOOK_SECRET');

const port = Number(process.env.PORT ?? 3001);
let failuresLeft = Number(process.env.FAIL_TIMES ?? 0);
let received = 0;

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));

  req.on('end', () => {
    void (async () => {
      // El cuerpo CRUDO, sin parsear. Parsear y re-serializar cambiaría el
      // HMAC por un solo espacio de diferencia.
      const payload = Buffer.concat(chunks).toString('utf8');
      const header = req.headers[SIGNATURE_HEADER];

      const verification = await verifyWebhookSignature({
        payload,
        header: Array.isArray(header) ? (header[0] ?? '') : (header ?? ''),
        secret,
      });

      const attempt = req.headers['colibri-delivery-attempt'] ?? '?';

      if (!verification.valid) {
        console.log(`  RECHAZADO  firma inválida (${verification.reason})`);
        res.writeHead(400).end('firma inválida');
        return;
      }

      const event = JSON.parse(payload) as { id: string; type: string };
      received += 1;

      if (failuresLeft > 0) {
        failuresLeft -= 1;
        console.log(
          `  FALLO SIMULADO  ${event.type.padEnd(32)} ${event.id}  intento ${attempt}`,
        );
        res.writeHead(500).end('fallo simulado');
        return;
      }

      console.log(`  OK  firma válida  ${event.type.padEnd(32)} ${event.id}  intento ${attempt}`);
      res.writeHead(200).end('ok');
    })();
  });
});

server.listen(port, () => {
  console.log(`\n  Receptor de webhooks escuchando en http://localhost:${port}`);
  if (failuresLeft > 0) console.log(`  Va a rechazar las primeras ${failuresLeft} entregas.`);
  console.log('');
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => {
  console.log(`\n  ${received} eventos recibidos.\n`);
  server.close();
  process.exit(0);
});

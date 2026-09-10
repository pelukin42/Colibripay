import { describe, expect, it } from 'vitest';
import { signWebhookPayload, verifyWebhookSignature } from './webhook-signature.js';

const secret = 'whsec_prueba1234567890';
const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

describe('firma de webhooks', () => {
  it('una firma recién generada verifica', async () => {
    const header = await signWebhookPayload({ payload, secret });
    await expect(verifyWebhookSignature({ payload, header, secret })).resolves.toEqual({
      valid: true,
    });
  });

  it('tiene el formato documentado', async () => {
    const header = await signWebhookPayload({ payload, secret, timestamp: 1_700_000_000 });
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('es determinista con el mismo timestamp', async () => {
    const a = await signWebhookPayload({ payload, secret, timestamp: 1_700_000_000 });
    const b = await signWebhookPayload({ payload, secret, timestamp: 1_700_000_000 });
    expect(a).toBe(b);
  });

  it('rechaza si cambia el cuerpo', async () => {
    const header = await signWebhookPayload({ payload, secret });
    const result = await verifyWebhookSignature({
      payload: payload.replace('succeeded', 'failed'),
      header,
      secret,
    });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rechaza si cambia el secreto', async () => {
    const header = await signWebhookPayload({ payload, secret });
    const result = await verifyWebhookSignature({ payload, header, secret: 'whsec_otro' });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rechaza una entrega vieja', async () => {
    const header = await signWebhookPayload({ payload, secret, timestamp: 1_700_000_000 });
    const result = await verifyWebhookSignature({
      payload,
      header,
      secret,
      now: 1_700_000_000 + 400, // tolerancia por defecto: 300 s
    });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('rechaza un timestamp del futuro', async () => {
    // Un reloj adelantado en el emisor no debe abrir una ventana larga de reproducción.
    const header = await signWebhookPayload({ payload, secret, timestamp: 1_700_000_000 });
    const result = await verifyWebhookSignature({
      payload,
      header,
      secret,
      now: 1_700_000_000 - 400,
    });
    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('no acepta una firma vieja reetiquetada con hora nueva', async () => {
    // El ataque que motiva firmar el timestamp: capturar una entrega legítima y
    // reenviarla con `t` actualizado. La firma ya no corresponde.
    const original = await signWebhookPayload({ payload, secret, timestamp: 1_700_000_000 });
    const stolenSignature = original.split('v1=')[1];
    const now = Math.floor(Date.now() / 1000);
    const forged = `t=${now},v1=${stolenSignature}`;

    const result = await verifyWebhookSignature({ payload, header: forged, secret });
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rechaza cabeceras malformadas', async () => {
    for (const header of ['', 'basura', 't=123', 'v1=abc', 't=abc,v1=def']) {
      const result = await verifyWebhookSignature({ payload, header, secret });
      expect(result.valid, `debería rechazar: ${header}`).toBe(false);
    }
  });

  it('sobrevive a cuerpos con acentos y emoji', async () => {
    // El HMAC va sobre bytes UTF-8; si alguien codificara mal, esto lo delata.
    const raro = JSON.stringify({ descripcion: 'Café con ñ y 🎉' });
    const header = await signWebhookPayload({ payload: raro, secret });
    await expect(
      verifyWebhookSignature({ payload: raro, header, secret }),
    ).resolves.toEqual({ valid: true });
  });
});

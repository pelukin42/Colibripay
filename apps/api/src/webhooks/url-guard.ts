/**
 * Defensa contra SSRF en las URLs de webhook.
 *
 * Esto no es paranoia teórica: la URL de destino la elige el comercio, y
 * nuestro servidor la visita desde ADENTRO de la red. Sin filtro, cualquiera
 * que abra una cuenta puede apuntar un webhook a `http://169.254.169.254/` y
 * usar nuestra infraestructura para leer las credenciales del proveedor de
 * nube, o barrer la red interna usando los códigos de respuesta que le
 * mostramos en el panel como oráculo.
 *
 * En TEST se permite loopback, porque un desarrollador integrando necesita
 * apuntar a su máquina. En LIVE no.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  // Endpoint de metadatos de AWS, GCP y Azure.
  '169.254.169.254',
  'metadata.google.internal',
]);

/** Rangos privados de RFC 1918, loopback, link-local y carrier-grade NAT. */
const PRIVATE_IPV4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export type UrlRejection =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'private_address'
  | 'credentials_in_url';

export function checkWebhookUrl(
  raw: string,
  mode: 'TEST' | 'LIVE',
): { ok: true; url: URL } | { ok: false; reason: UrlRejection; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url', message: 'La URL del webhook no es válida' };
  }

  // En LIVE se exige HTTPS: el cuerpo lleva datos del cobro y la firma no
  // sirve de nada si cualquiera en el camino puede leerlo.
  const allowedSchemes = mode === 'LIVE' ? ['https:'] : ['https:', 'http:'];
  if (!allowedSchemes.includes(url.protocol)) {
    return {
      ok: false,
      reason: 'scheme_not_allowed',
      message:
        mode === 'LIVE'
          ? 'Los webhooks en modo real deben usar https://'
          : 'Solo se admiten URLs http:// o https://',
    };
  }

  // Credenciales embebidas (`https://user:pass@host`) se filtrarían a nuestros
  // logs de entrega y al panel del comercio.
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'credentials_in_url',
      message: 'La URL no puede incluir usuario ni contraseña',
    };
  }

  if (mode === 'LIVE') {
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname) || PRIVATE_IPV4.test(hostname)) {
      return {
        ok: false,
        reason: 'private_address',
        message: 'La URL no puede apuntar a una dirección interna o privada',
      };
    }
    // IPv6 privadas: unique-local (fc00::/7) y link-local (fe80::/10).
    if (/^\[?(f[cd]|fe[89ab])/i.test(hostname)) {
      return {
        ok: false,
        reason: 'private_address',
        message: 'La URL no puede apuntar a una dirección interna o privada',
      };
    }
  }

  return { ok: true, url };
}

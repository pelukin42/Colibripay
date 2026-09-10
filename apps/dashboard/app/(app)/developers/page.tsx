import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { encryptSecret, hashApiKey, prisma } from '@colibripay/db';
import { generateApiKey, generateId, generateWebhookSecret, ID_PREFIXES } from '@colibripay/shared';
import { requireMember } from '../../../lib/auth';
import { resolveMode, when } from '../../../lib/format';

/**
 * Los secretos recién creados se muestran UNA vez.
 *
 * Viajan por una cookie de un solo uso y no por la URL: un `?key=sk_live_...`
 * termina en el historial del navegador, en los logs del servidor y en el
 * encabezado `Referer` de la siguiente petición a cualquier dominio externo.
 */
const FLASH = 'colibri_flash_secret';

async function flash(value: string): Promise<void> {
  const store = await cookies();
  store.set(FLASH, value, { httpOnly: true, path: '/developers', maxAge: 60 });
}

async function takeFlash(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(FLASH)?.value ?? null;
  if (value) store.delete(FLASH);
  return value;
}

export default async function Developers({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const member = await requireMember();
  const mode = resolveMode((await searchParams).mode);
  const canManage = member.role !== 'VIEWER';
  const revealed = await takeFlash();

  const [keys, endpoints] = await Promise.all([
    prisma.apiKey.findMany({
      where: { merchantId: member.merchant.id, mode, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.webhookEndpoint.findMany({
      where: { merchantId: member.merchant.id, mode },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { deliveries: true } } },
    }),
  ]);

  async function createKey(formData: FormData) {
    'use server';
    const me = await requireMember();
    if (me.role === 'VIEWER') return;

    const type = formData.get('type') === 'PUBLIC' ? 'PUBLIC' : 'SECRET';
    const keyMode = formData.get('mode') === 'LIVE' ? 'LIVE' : 'TEST';

    const { key, prefix, lastFour } = generateApiKey(
      type === 'PUBLIC' ? 'public' : 'secret',
      keyMode === 'LIVE' ? 'live' : 'test',
    );

    // Se guarda el hash. La llave en claro solo existe en esta petición.
    await prisma.apiKey.create({
      data: {
        merchantId: me.merchant.id,
        type,
        mode: keyMode,
        name: String(formData.get('name') || 'Sin nombre').slice(0, 60),
        prefix,
        lastFour,
        hashedKey: hashApiKey(key),
      },
    });

    await flash(key);
    revalidatePath('/developers');
  }

  async function revokeKey(formData: FormData) {
    'use server';
    const me = await requireMember();
    if (me.role === 'VIEWER') return;

    // El filtro por comercio va en el WHERE: sin él, un id adivinado revocaría
    // la llave de otro comercio.
    await prisma.apiKey.updateMany({
      where: { id: String(formData.get('id')), merchantId: me.merchant.id },
      data: { revokedAt: new Date() },
    });

    revalidatePath('/developers');
  }

  async function createEndpoint(formData: FormData) {
    'use server';
    const me = await requireMember();
    if (me.role === 'VIEWER') return;

    const url = String(formData.get('url') ?? '').trim();
    const endpointMode = formData.get('mode') === 'LIVE' ? 'LIVE' : 'TEST';

    // Validación de forma. La comprobación autoritativa —incluido el filtro
    // anti-SSRF— la hace el worker antes de CADA entrega, porque una URL puede
    // volverse peligrosa después de guardarse (por ejemplo si su DNS cambia).
    try {
      const parsed = new URL(url);
      if (endpointMode === 'LIVE' && parsed.protocol !== 'https:') return;
      if (!['http:', 'https:'].includes(parsed.protocol)) return;
    } catch {
      return;
    }

    const secret = generateWebhookSecret();
    await prisma.webhookEndpoint.create({
      data: {
        publicId: generateId(ID_PREFIXES.webhookEndpoint),
        merchantId: me.merchant.id,
        mode: endpointMode,
        url,
        description: String(formData.get('description') || '').slice(0, 200) || null,
        secretEncrypted: encryptSecret(secret),
        enabledEvents: [],
      },
    });

    await flash(secret);
    revalidatePath('/developers');
  }

  return (
    <>
      <div className="page-head">
        <h1>Desarrolladores</h1>
        <p>
          Llaves de API y webhooks · {mode === 'LIVE' ? 'datos reales' : 'modo de prueba'}
        </p>
      </div>

      {revealed ? (
        <div className="alert good">
          <strong>Guardá esto ahora. No se vuelve a mostrar.</strong>
          <code className="secret">{revealed}</code>
        </div>
      ) : null}

      <div className="stack">
        <div className="panel">
          <div className="panel-head">Llaves de API</div>

          {keys.length === 0 ? (
            <p className="empty">No hay llaves activas en este modo.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    <th>Llave</th>
                    <th>Último uso</th>
                    {canManage ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id}>
                      <td>{key.name}</td>
                      <td className="mono">
                        {key.prefix}_····{key.lastFour}
                      </td>
                      <td style={{ color: 'var(--ink-soft)' }}>
                        {key.lastUsedAt ? when(key.lastUsedAt) : 'Nunca'}
                      </td>
                      {canManage ? (
                        <td className="num">
                          <form action={revokeKey}>
                            <input type="hidden" name="id" value={key.id} />
                            <button className="btn danger" type="submit">
                              Revocar
                            </button>
                          </form>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canManage ? (
            <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
              <form action={createKey} className="row-actions" style={{ flexWrap: 'wrap' }}>
                <input type="hidden" name="mode" value={mode} />
                <input
                  name="name"
                  type="text"
                  placeholder="Nombre de la llave"
                  style={{ maxWidth: 220 }}
                  required
                />
                <select
                  name="type"
                  style={{
                    padding: '9px 11px',
                    borderRadius: 6,
                    border: '1px solid var(--line-strong)',
                    background: 'var(--surface)',
                    color: 'var(--ink)',
                    font: 'inherit',
                  }}
                >
                  <option value="SECRET">Secreta (servidor)</option>
                  <option value="PUBLIC">Pública (navegador)</option>
                </select>
                <button className="btn" type="submit">
                  Crear llave
                </button>
              </form>
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="panel-head">Webhooks</div>

          {endpoints.length === 0 ? (
            <p className="empty">No hay endpoints configurados en este modo.</p>
          ) : (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Estado</th>
                    <th className="num">Entregas</th>
                    <th>Último éxito</th>
                  </tr>
                </thead>
                <tbody>
                  {endpoints.map((endpoint) => (
                    <tr key={endpoint.id}>
                      <td>
                        <span className="mono">{endpoint.url}</span>
                        {endpoint.description ? (
                          <div style={{ fontSize: 12.5, color: 'var(--ink-faint)' }}>
                            {endpoint.description}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span
                          className={`tag ${
                            endpoint.status === 'ENABLED'
                              ? 'ok'
                              : endpoint.status === 'AUTO_DISABLED'
                                ? 'bad'
                                : 'mute'
                          }`}
                        >
                          {endpoint.status === 'ENABLED'
                            ? 'Activo'
                            : endpoint.status === 'AUTO_DISABLED'
                              ? 'Desactivado por fallos'
                              : 'Inactivo'}
                        </span>
                      </td>
                      <td className="num">{endpoint._count.deliveries}</td>
                      <td style={{ color: 'var(--ink-soft)' }}>
                        {endpoint.lastSuccessAt ? when(endpoint.lastSuccessAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canManage ? (
            <div className="panel-body" style={{ borderTop: '1px solid var(--line)' }}>
              <form action={createEndpoint} className="row-actions" style={{ flexWrap: 'wrap' }}>
                <input type="hidden" name="mode" value={mode} />
                <input
                  name="url"
                  type="url"
                  placeholder="https://tusitio.com/webhooks/colibri"
                  style={{ maxWidth: 340 }}
                  required
                />
                <button className="btn" type="submit">
                  Agregar endpoint
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

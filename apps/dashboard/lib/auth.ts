import { redirect } from 'next/navigation';
import { prisma, verifyPassword, type MemberRole } from '@colibripay/db';
import { readSession } from './session';

/**
 * Acceso a la sesión desde componentes de servidor.
 *
 * `requireMember` se llama al principio de CADA página protegida. No alcanza
 * con esconder los enlaces del menú: sin esta comprobación, escribir la URL a
 * mano entraría igual.
 */

export interface Member {
  userId: string;
  name: string;
  email: string;
  role: MemberRole;
  merchant: {
    id: string;
    publicId: string;
    tradeName: string;
    status: string;
    defaultCurrency: 'CRC' | 'USD';
    feeBps: number;
    feeFixed: bigint;
    holdDays: number;
  };
}

export async function getMember(): Promise<Member | null> {
  const session = await readSession();
  if (!session) return null;

  // El rol y el estado del comercio se leen de la base en cada petición, no de
  // la cookie: si a alguien le revocan el acceso, tiene que dejar de entrar en
  // el acto y no cuando venza su sesión.
  const membership = await prisma.merchantMember.findUnique({
    where: {
      merchantId_userId: { merchantId: session.merchantId, userId: session.userId },
    },
    include: {
      user: { select: { name: true, email: true } },
      merchant: {
        select: {
          id: true,
          publicId: true,
          tradeName: true,
          status: true,
          defaultCurrency: true,
          feeBps: true,
          feeFixed: true,
          holdDays: true,
        },
      },
    },
  });

  if (!membership) return null;

  return {
    userId: session.userId,
    name: membership.user.name,
    email: membership.user.email,
    role: membership.role,
    merchant: membership.merchant as Member['merchant'],
  };
}

export async function requireMember(): Promise<Member> {
  const member = await getMember();
  if (!member) redirect('/login');
  return member;
}

export type LoginResult =
  | { ok: true; userId: string; merchantId: string }
  | { ok: false; message: string };

/**
 * Verifica credenciales.
 *
 * Devuelve siempre el mismo mensaje para usuario inexistente y contraseña
 * incorrecta. Distinguirlos convierte el login en un verificador de qué correos
 * tienen cuenta, que es media entrada para un ataque dirigido.
 */
export async function attemptLogin(email: string, password: string): Promise<LoginResult> {
  const generic = { ok: false as const, message: 'Correo o contraseña incorrectos' };

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } },
  });

  if (!user) {
    // Se gasta el tiempo de un hash igual, para que la ausencia de cuenta no se
    // note por lo rápido que responde.
    await verifyPassword(password, 'scrypt$65536$8$2$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    return generic;
  }

  if (!(await verifyPassword(password, user.passwordHash))) return generic;

  const membership = user.memberships[0];
  if (!membership) {
    return { ok: false, message: 'Tu usuario no está asociado a ningún comercio' };
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  return { ok: true, userId: user.id, merchantId: membership.merchantId };
}

import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { requireMember } from '../../lib/auth';
import { clearSession } from '../../lib/session';
import { Logo } from '../../lib/logo';
import { Nav, ModeSwitch } from '../../lib/nav';

/**
 * Envoltorio de todo lo autenticado.
 *
 * `requireMember` acá cubre el grupo entero, pero cada página lo llama igual:
 * un layout no es una frontera de seguridad —Next puede renderizar una página
 * sin volver a ejecutar el layout— y en un panel con datos financieros no
 * conviene depender de ese detalle.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const member = await requireMember();

  async function logout() {
    'use server';
    await clearSession();
    redirect('/login');
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          ColibriPay
        </div>

        <Suspense fallback={null}>
          <Nav />
        </Suspense>

        <div className="sidebar-foot">
          <strong>{member.merchant.tradeName}</strong>
          {member.email}
          <Suspense fallback={null}>
            <ModeSwitch />
          </Suspense>
          <form action={logout}>
            <button className="logout" type="submit">
              Cerrar sesión
            </button>
          </form>
        </div>
      </aside>

      <main className="main">{children}</main>
    </div>
  );
}

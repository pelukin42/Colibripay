import { redirect } from 'next/navigation';
import { attemptLogin, getMember } from '../../lib/auth';
import { writeSession } from '../../lib/session';
import { Logo } from '../../lib/logo';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Quien ya tiene sesión no debería ver el login.
  if (await getMember()) redirect('/');

  const { error } = await searchParams;

  async function login(formData: FormData) {
    'use server';

    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    const result = await attemptLogin(email, password);
    if (!result.ok) {
      redirect(`/login?error=${encodeURIComponent(result.message)}`);
    }

    await writeSession({ userId: result.userId, merchantId: result.merchantId });
    redirect('/');
  }

  return (
    <main className="login-shell">
      <div className="login-card">
        <div className="brand">
          <Logo />
          ColibriPay
        </div>

        {error ? (
          <div className="alert" role="alert">
            {error}
          </div>
        ) : null}

        <form action={login}>
          <div className="field">
            <label htmlFor="email">Correo</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="password">Contraseña</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          <button className="btn" type="submit">
            Entrar
          </button>
        </form>

        {process.env.NODE_ENV !== 'production' ? (
          <p className="login-hint">
            Datos de prueba: <code>demo@colibripay.test</code> /{' '}
            <code>colibri-demo-2026</code>
          </p>
        ) : null}
      </div>
    </main>
  );
}

export default function Home() {
  return (
    <main className="shell">
      <div className="card">
        <div className="result">
          <div className="mark bad" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </div>
          <h1>Enlace de pago inválido</h1>
          <p>
            Este enlace no incluye una sesión de pago. Volvé al comercio y
            comenzá el pago de nuevo.
          </p>
        </div>
      </div>
    </main>
  );
}

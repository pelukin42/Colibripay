import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pago seguro',
  // Una página de pago no tiene por qué aparecer en buscadores, y su URL lleva
  // el client_secret.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CR">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ColibriPay',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-CR">
      <body>{children}</body>
    </html>
  );
}

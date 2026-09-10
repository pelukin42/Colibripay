'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

const ITEMS = [
  { href: '/', label: 'Resumen' },
  { href: '/payments', label: 'Cobros' },
  { href: '/developers', label: 'Desarrolladores' },
];

/**
 * El modo se lee del query string en el cliente y no se pasa como prop desde el
 * layout: así el menú y el interruptor reflejan siempre lo que está viendo la
 * página, aunque Next reutilice el layout entre navegaciones.
 */
function useMode(): 'TEST' | 'LIVE' {
  return useSearchParams().get('mode')?.toUpperCase() === 'LIVE' ? 'LIVE' : 'TEST';
}

export function Nav() {
  const pathname = usePathname();
  const mode = useMode();
  const suffix = mode === 'LIVE' ? '?mode=live' : '';

  return (
    <nav className="nav">
      {ITEMS.map((item) => {
        // La raíz solo coincide exacta; el resto también en sus subrutas, para
        // que el detalle de un cobro deje "Cobros" marcado.
        const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={`${item.href}${suffix}`}
            aria-current={active ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function ModeSwitch() {
  const pathname = usePathname();
  const mode = useMode();

  return (
    <Link
      href={mode === 'LIVE' ? pathname : `${pathname}?mode=live`}
      className={`tag ${mode === 'LIVE' ? 'ok' : 'mute'}`}
      style={{ marginTop: 10, display: 'inline-block' }}
    >
      {mode === 'LIVE' ? 'Datos reales' : 'Modo de prueba'} · cambiar
    </Link>
  );
}

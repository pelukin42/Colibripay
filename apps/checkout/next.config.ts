import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // El checkout se sirve para incrustarse en el sitio del comercio, pero solo
  // permitimos que lo enmarque quien nosotros digamos. Sin esto, cualquiera
  // podria enmarcarlo y superponer un formulario falso encima (clickjacking).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // Un checkout no tiene por que acceder a camara, microfono ni ubicacion.
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default config;

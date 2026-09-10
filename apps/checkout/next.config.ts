import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Los paquetes del monorepo usan especificadores con extension .js (estilo
  // NodeNext), pero apuntan a archivos .ts. El resolvedor de Next los busca
  // literalmente y no los encuentra. Este alias cierra esa brecha sin obligar a
  // los paquetes a abandonar la resolucion correcta para Node.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
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

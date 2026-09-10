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
  // El dashboard lee la base directamente desde componentes de servidor, asi
  // que Prisma tiene que quedar fuera del bundle del cliente.
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default config;

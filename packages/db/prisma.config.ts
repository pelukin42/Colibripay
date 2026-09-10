import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

const here = path.dirname(fileURLToPath(import.meta.url));

// Prisma 7 deja de cargar .env solo, y en un monorepo igual buscaría en
// packages/db/. Apuntamos explícitamente al .env compartido de la raíz para no
// terminar con dos copias de DATABASE_URL desincronizadas.
loadEnv({ path: path.resolve(here, '../../.env'), quiet: true });

export default defineConfig({
  schema: path.join(here, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(here, 'prisma', 'migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});

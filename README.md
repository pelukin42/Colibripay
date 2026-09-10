# ColibriPay

Pasarela de pagos para Costa Rica. Monorepo con el core de pagos, checkout hospedado y dashboard de comercios.

> **Nombre provisional.** Renombrarlo es un find/replace sobre `colibripay` / `ColibriPay`.

---

## Lo que hay que tener claro antes de seguir

Este repositorio construye **la plataforma**. No construye —porque no se puede construir con código— lo siguiente:

| Requisito | Cómo se resuelve |
|---|---|
| Procesar tarjetas de verdad | Contrato de afiliación con un adquirente (BAC Credomatic, Promerica, BN, Davivienda) y certificación con ellos |
| Tocar el número de tarjeta | Certificación PCI DSS. **La acotamos**: el navegador postea la tarjeta directo al vault del adquirente y a nuestra API solo le llega un token opaco. Verificado: el PAN no aparece ni en los logs ni en la base |
| SINPE Móvil | Se accede a través de un banco. El BCCR no conecta entidades no reguladas |
| Retener fondos de terceros | Régimen SUGEF / Ley 8204. Mientras el adquirente liquide directo al comercio, no aplica |

La arquitectura está diseñada para que **nada de lo anterior bloquee el desarrollo hoy**: el core habla con un `AcquirerAdapter`, y el adaptador `sandbox` implementa la interfaz completa. Cuando exista contrato bancario se escribe un adaptador nuevo y el core no se toca.

---

## Estructura

```
packages/
  shared/      Contratos compartidos: dinero, IDs, errores, eventos,
               máquina de estados e interfaz AcquirerAdapter
  db/          Prisma + Postgres. El esquema es la fuente de verdad del dominio
  acquirers/   Adaptadores. Hoy: sandbox. Mañana: BAC, Promerica, …
apps/
  api/         NestJS. Core de pagos: auth, idempotencia, ledger, eventos
  checkout/    Next.js. Checkout hospedado — origen separado a propósito
  dashboard/   Next.js. Panel del comercio
```

### Por qué está partido así

- **`checkout` aparte no es capricho**: vive en otro origen y con superficie mínima. Junto con la tokenización desde el navegador, es lo que mantiene el PAN fuera de nuestra infraestructura.
- **`acquirers` aparte**: se prueba sin levantar la API y se puede certificar un adaptador nuevo en aislamiento.
- **`db` aparte**: el ledger necesita migraciones versionadas y transacciones serializables. Sin capas de por medio.

---

## Decisiones que no se negocian

1. **Los montos son `BigInt` en unidades mínimas.** Nunca `number`, nunca `Decimal` en la ruta caliente. `0.1 + 0.2 !== 0.3` y los enteros de JS mienten después de 2^53.
2. **El PAN nunca toca nuestros servidores.** El navegador lo postea directo al vault del adquirente; a la API solo le llega un token. Existe un camino servidor-a-servidor (`card` en vez de `token`) pero expande el alcance PCI y no es el default.
3. **Un rechazo del emisor es un resultado, no una excepción.** Los `throw` se reservan para fallos de transporte.
4. **Toda escritura pasa por idempotencia.** Sin eso, un reintento de red del comercio cobra dos veces.
5. **El ledger es de doble partida y cuadra o no se escribe.** `SUM(entries.amount) = 0`, con signo: positivo = débito, negativo = crédito.
6. **`TEST` y `LIVE` nunca se cruzan.** Por eso `mode` está en casi todos los modelos.
7. **Los webhooks son *at-least-once*.** Si la red se corta después de que el comercio respondió 200, reintentamos. El comercio DEBE descartar eventos repetidos por `id`. Prometer *exactly-once* sobre HTTP es mentira.

---

## Puesta en marcha

```bash
pnpm install
cp .env.example .env
```

Levantá PostgreSQL. **No hace falta Docker ni permisos de administrador**: `pnpm db:local` descarga los binarios oficiales de PostgreSQL 18 y los corre como un proceso más del usuario.

```bash
pnpm db:local
```

El clúster se guarda en `%LOCALAPPDATA%\colibripay\pgdata`, deliberadamente fuera del repositorio — está en una carpeta de OneDrive, y sincronizar una base de datos hace que `initdb` tarde minutos y quede expuesta a conflictos de sincronización.

En otra terminal, aplicá el esquema y creá el comercio de prueba:

```bash
pnpm db:push && pnpm db:seed
```

El seed imprime las llaves de API. Luego levantá la API:

```bash
pnpm --filter @colibripay/api dev
```

### Comandos

| Comando | Qué hace |
|---|---|
| `pnpm db:local` | Levanta PostgreSQL local (sin Docker) |
| `pnpm db:push` | Sincroniza el esquema con la base |
| `pnpm db:seed` | Crea el comercio demo e imprime sus llaves |
| `pnpm db:studio` | Explorador visual de la base |
| `pnpm db:verify-ledger` | Comprueba que el libro contable cuadre |
| `pnpm test` | Corre las pruebas de todos los paquetes |
| `pnpm typecheck` | Verifica tipos en todo el monorepo |
| `SK=… PK=… bash scripts/smoke.sh` | Prueba de humo HTTP de punta a punta |

---

## Dashboard del comercio

Vive en `apps/dashboard`. Muestra saldos, cobros, el detalle de cada intento con su RRN para conciliar contra el banco, y la gestión de llaves de API y webhooks.

**Lee la base directamente** desde componentes de servidor, en vez de hablar con la API de pagos. La razón: esa API existe para que los comercios integren con llaves de API, y el dashboard se autentica con usuario y contraseña. Mezclarlas obligaría a que cada endpoint acepte dos formas de autenticación distintas, y esa ambigüedad en un servicio que mueve plata es como se cuelan los agujeros. Cuando el panel necesite ejecutar lógica de pagos —un reembolso, por ejemplo— sí llamará a la API.

**Contraseñas con scrypt**, no Argon2id. Argon2 sería la primera opción, pero exige dependencias nativas que en Windows fallan al compilar con frecuencia. scrypt viene en Node, es memory-hard igual y OWASP lo acepta explícitamente. Los parámetros se guardan dentro del propio hash, así que subirlos más adelante no invalida las contraseñas viejas.

**Sesión en cookie firmada con HMAC**, no un JWT de librería: lo único que se necesita es "este payload lo emitimos nosotros y no venció". Un JWT traería negociación de algoritmo —de donde sale la familia `alg: none`— sin aportar nada que usemos. La cookie lleva solo IDs; el rol y el estado del comercio se leen de la base en cada petición, para que revocarle el acceso a alguien tenga efecto inmediato.

El modo por defecto es **TEST**. Ver datos reales exige pedirlo explícitamente.

```bash
pnpm --filter @colibripay/dashboard dev
```

---

## Checkout hospedado

Vive en `apps/checkout`, en su propio origen y su propio puerto. El flujo tiene dos pasos y el orden es lo que importa:

1. El navegador postea la tarjeta **al vault del adquirente** — no a nuestra API.
2. El navegador manda el **token** a `POST /v1/checkout/confirm`.

Nuestra infraestructura nunca ve el número. Está verificado de punta a punta: tras un cobro real, el PAN completo tiene cero apariciones en los logs de la API y cero en la base de datos; lo único guardado es marca, últimos 4, BIN y vencimiento.

La credencial del checkout es el `client_secret`, no una llave de API: alcanza a un solo PaymentIntent y muere con él.

```bash
pnpm vault
```

```bash
pnpm --filter @colibripay/checkout dev
```

El enlace de pago es `http://localhost:4001/pay?cs=<client_secret>`.

> **Pendiente:** completar el desafío 3-D Secure. Hoy un intent que lo requiere queda en `REQUIRES_ACTION` y el checkout lo muestra como verificación pendiente, pero no hay pantalla que lo resuelva.

---

## Webhooks

La cola vive en Postgres, no en Redis. Es una decisión: la tabla `webhook_deliveries` ya tiene estado, intentos y próxima ejecución — ya *es* una cola. Duplicarla en Redis traería el problema de la escritura dual: fila commiteada con job perdido es un webhook que nunca sale; job encolado sin fila es uno duplicado. Con `FOR UPDATE SKIP LOCKED` varios workers se reparten el trabajo sin coordinación externa.

El techo son unos cuantos miles de entregas por segundo — muy por encima de lo que necesita una pasarela costarricense.

**Firma.** Cabecera `colibri-signature: t=<unix>,v1=<hmac-sha256-hex>`. El timestamp va *dentro* de lo firmado (`${t}.${cuerpo}`), así que reenviar una entrega vieja con hora nueva invalida la firma. Tolerancia: 5 minutos.

Verificación del lado del comercio — ver [scripts/webhook-receiver.ts](scripts/webhook-receiver.ts) para el ejemplo completo:

```ts
const result = await verifyWebhookSignature({ payload: cuerpoCrudo, header, secret });
```

> El `payload` debe ser el cuerpo **crudo**, no el JSON parseado y vuelto a serializar. Un espacio de diferencia cambia el HMAC.

**Reintentos.** 8 intentos con backoff creciente: inmediato, 10 s, 1 min, 5 min, 30 min, 2 h, 6 h, 18 h. Un endpoint caído se recupera solo dentro de las ~26 horas siguientes sin perder eventos. Tras 20 fallos consecutivos el endpoint se apaga solo.

**Probarlo localmente:**

```bash
WEBHOOK_SECRET=whsec_... pnpm webhook:receiver
```

Con `FAIL_TIMES=3` rechaza las primeras 3 entregas para ver los reintentos.

---

## Tarjetas de prueba

El adaptador sandbox es determinista: el mismo número produce siempre el mismo resultado.

| Número | Resultado |
|---|---|
| `4242 4242 4242 4242` | Aprobada (Visa) |
| `5555 5555 5555 4444` | Aprobada (Mastercard) |
| `3782 822463 10005` | Aprobada (Amex) |
| `4000 0000 0000 0002` | Rechazo — `do_not_honor` |
| `4000 0000 0000 9995` | Rechazo — `insufficient_funds` |
| `4000 0000 0000 0069` | Rechazo — `expired_card` |
| `4000 0000 0000 0127` | Rechazo — `incorrect_cvc` |
| `4000 0000 0000 0101` | Rechazo — `fraudulent` |
| `4000 0000 0000 3220` | Pide 3-D Secure, luego aprueba |
| `4000 0000 0000 3063` | Pide 3-D Secure, luego rechaza |
| `4000 0000 0000 0119` | Error reintentable (emisor caído) |
| `4000 0000 0000 0259` | Aprueba y abre contracargo |
| `4000 0000 0000 0341` | Autoriza, pero la captura falla |
| `4000 0000 0000 0010` | Timeout |

Las últimas cuatro existen porque son los casos que rompen integraciones mal hechas — y los que nadie prueba hasta que pasan en producción.

---

## Estado

**Listo y verificado** (51 pruebas en verde, typecheck limpio en los 4 paquetes):

- **Esquema de datos completo** — comercios, llaves, clientes, bóveda de métodos, intents, cargos, reembolsos, disputas, ledger de doble partida, payouts, eventos, webhooks e idempotencia
- **Contratos compartidos** — aritmética monetaria, IDs con prefijo, errores y rechazos, eventos, máquina de estados del PaymentIntent
- **Reglas de asiento contable** — funciones puras, con una prueba que corre 1000 operaciones aleatorias verificando en cada paso que el libro suma cero
- **Interfaz `AcquirerAdapter` y adaptador sandbox** — tokenización, autorización, 3DS, captura parcial, anulación, reembolso. Sin estado
- **API** — autenticación por llave de API, idempotencia, ledger persistente, eventos, `payment_intents` y `payment_methods`
- **Webhooks** — cola en Postgres con `SKIP LOCKED`, firma HMAC-SHA256, 8 reintentos con backoff, apagado automático de endpoints muertos y filtro anti-SSRF
- **Checkout hospedado** — tokenización desde el navegador, verificado: el PAN no llega a la API ni a la base
- **Dashboard** — login con scrypt, sesión firmada, saldos, cobros, detalle con RRN, llaves de API y webhooks

### Endpoints

| Método | Ruta | Llave |
|---|---|---|
| `POST` | `/v1/payment_intents` | secreta |
| `GET` | `/v1/payment_intents/:id` | secreta |
| `POST` | `/v1/payment_intents/:id/confirm` | pública o secreta |
| `POST` | `/v1/payment_intents/:id/capture` | secreta |
| `POST` | `/v1/payment_intents/:id/cancel` | secreta |
| `POST` | `/v1/payment_methods` | pública o secreta |
| `GET` | `/health` | ninguna |

**Verificado contra PostgreSQL 18 real**, no solo compilado: 51 pruebas unitarias, 21 pruebas de humo HTTP de punta a punta (autenticación, idempotencia con reproducción y conflicto, tokenización, cobro, rechazo, captura parcial y cancelación) y el libro contable cuadrando en cero tras cobros reales.

**Pendiente:**

- Recursos `customers` y `refunds`
- Job de liberación de fondos T+N y payouts
- Completar el desafío 3-D Secure en el checkout
- Conciliación contra archivo de liquidación
- Motor de reglas de riesgo

## Nota sobre la ubicación del repo

El proyecto vive dentro de una carpeta sincronizada por OneDrive. `node_modules/` está en `.gitignore`, pero OneDrive igual intenta sincronizar sus decenas de miles de archivos, lo que ralentiza instalaciones y builds. Conviene excluir la carpeta desde *Configuración de OneDrive → Sincronización → Elegir carpetas*, o mover el repo fuera del área sincronizada.

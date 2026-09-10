# ColibriPay

Pasarela de pagos para Costa Rica. Monorepo con el core de pagos, checkout hospedado y dashboard de comercios.

> **Nombre provisional.** Renombrarlo es un find/replace sobre `colibripay` / `ColibriPay`.

---

## Lo que hay que tener claro antes de seguir

Este repositorio construye **la plataforma**. No construye —porque no se puede construir con código— lo siguiente:

| Requisito | Cómo se resuelve |
|---|---|
| Procesar tarjetas de verdad | Contrato de afiliación con un adquirente (BAC Credomatic, Promerica, BN, Davivienda) y certificación con ellos |
| Tocar el número de tarjeta | Certificación PCI DSS. **La evitamos**: el checkout va en su propio origen y el PAN viaja del iframe al vault del adquirente sin pasar por nuestros servidores → alcance SAQ A |
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
  api/         (pendiente) Core de pagos, webhooks, workers
  checkout/    (pendiente) Checkout hospedado — origen separado a propósito
  dashboard/   (pendiente) Panel del comercio
```

### Por qué está partido así

- **`checkout` aparte no es capricho**: vive en otro origen y con superficie mínima. Es lo que mantiene el alcance PCI en SAQ A en vez de SAQ D.
- **`acquirers` aparte**: se prueba sin levantar la API y se puede certificar un adaptador nuevo en aislamiento.
- **`db` aparte**: el ledger necesita migraciones versionadas y transacciones serializables. Sin capas de por medio.

---

## Decisiones que no se negocian

1. **Los montos son `BigInt` en unidades mínimas.** Nunca `number`, nunca `Decimal` en la ruta caliente. `0.1 + 0.2 !== 0.3` y los enteros de JS mienten después de 2^53.
2. **Ningún modelo guarda PAN, CVV ni datos de banda.** Solo tokens opacos del adquirente. Si aparece un campo así en el esquema, el alcance PCI del proyecto se multiplica.
3. **Un rechazo del emisor es un resultado, no una excepción.** Los `throw` se reservan para fallos de transporte.
4. **Toda escritura pasa por idempotencia.** Sin eso, un reintento de red del comercio cobra dos veces.
5. **El ledger es de doble partida y cuadra o no se escribe.** `SUM(entries.amount) = 0`, con signo: positivo = débito, negativo = crédito.
6. **`TEST` y `LIVE` nunca se cruzan.** Por eso `mode` está en casi todos los modelos.

---

## Puesta en marcha

```bash
pnpm install
cp .env.example .env
```

Necesitás Postgres y Redis. Con Docker:

```bash
docker run -d --name colibri-pg -e POSTGRES_USER=colibri -e POSTGRES_PASSWORD=colibri -e POSTGRES_DB=colibripay -p 5432:5432 postgres:16
```

```bash
docker run -d --name colibri-redis -p 6379:6379 redis:7
```

Luego:

```bash
pnpm db:generate && pnpm db:migrate
```

### Comandos

| Comando | Qué hace |
|---|---|
| `pnpm db:generate` | Regenera el cliente de Prisma |
| `pnpm db:migrate` | Crea y aplica una migración |
| `pnpm db:studio` | Explorador visual de la base |
| `pnpm test` | Corre las pruebas de todos los paquetes |
| `pnpm typecheck` | Verifica tipos en todo el monorepo |

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

**Listo y verificado** (33 pruebas en verde, typecheck limpio):

- Esquema de datos completo — comercios, llaves, clientes, bóveda de métodos, intents, cargos, reembolsos, disputas, ledger de doble partida, payouts, eventos, webhooks e idempotencia
- Contratos compartidos — aritmética monetaria, IDs con prefijo, catálogo de errores y rechazos, catálogo de eventos, máquina de estados del PaymentIntent
- Interfaz `AcquirerAdapter` y adaptador sandbox completo (tokenización, autorización, 3DS, captura parcial, anulación, reembolso)

**Pendiente:**

- `apps/api` — endpoints, middleware de idempotencia, autenticación por API key, servicio de ledger, cola de webhooks
- `apps/checkout` — checkout hospedado con campos en iframe
- `apps/dashboard` — panel del comercio
- Conciliación contra archivo de liquidación
- Motor de reglas de riesgo

---

## Nota sobre la ubicación del repo

El proyecto vive dentro de una carpeta sincronizada por OneDrive. `node_modules/` está en `.gitignore`, pero OneDrive igual intenta sincronizar sus decenas de miles de archivos, lo que ralentiza instalaciones y builds. Conviene excluir la carpeta desde *Configuración de OneDrive → Sincronización → Elegir carpetas*, o mover el repo fuera del área sincronizada.

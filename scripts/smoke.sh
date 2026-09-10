#!/usr/bin/env bash
# Prueba de humo de punta a punta contra una API corriendo.
#
# No reemplaza a los tests unitarios: verifica el pegamento que esos no tocan
# —autenticación, idempotencia, serialización, transiciones de estado y el
# asiento contable— haciendo peticiones HTTP reales contra Postgres real.
#
#   Uso: SK=sk_test_... PK=pk_test_... bash scripts/smoke.sh

set -uo pipefail

API="${API:-http://localhost:4000}"
SK="${SK:?Falta SK (llave secreta de prueba)}"
PK="${PK:?Falta PK (llave pública de prueba)}"

PASS=0
FAIL=0

# Extrae un campo del último cuerpo JSON recibido.
field() { node -e "try{console.log(JSON.parse(process.argv[1])[process.argv[2]]??'')}catch(e){console.log('')}" "$1" "$2"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    printf '  \033[32mOK\033[0m   %-52s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  \033[31mFALLA\033[0m %-52s esperado=%s obtenido=%s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

# Ejecuta curl y deja el cuerpo en $BODY y el código en $CODE.
call() {
  local out
  out=$(curl -s -w '\n%{http_code}' "$@")
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

echo ""
echo "  Prueba de humo contra $API"
echo ""
echo "  --- Salud y autenticación ---"

call "$API/health"
check "health sin llave" "200" "$CODE"

call "$API/v1/payment_intents" -X POST -H 'Content-Type: application/json' -d '{"amount":100000,"currency":"CRC"}'
check "sin llave devuelve 401" "401" "$CODE"

call "$API/v1/payment_intents" -X POST -H 'Authorization: Bearer sk_test_llave_falsa' \
  -H 'Content-Type: application/json' -d '{"amount":100000,"currency":"CRC"}'
check "llave inválida devuelve 401" "401" "$CODE"

echo ""
echo "  --- Validación ---"

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d '{"amount":100,"currency":"CRC"}'
check "monto bajo el mínimo devuelve 400" "400" "$CODE"

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d '{"amount":100000,"currency":"EUR"}'
check "moneda no soportada devuelve 400" "400" "$CODE"

echo ""
echo "  --- Idempotencia ---"

KEY="smoke-$(date +%s)-$RANDOM"
BODY_JSON='{"amount":1000000,"currency":"CRC","description":"Prueba de humo"}'

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" -d "$BODY_JSON"
check "crear PaymentIntent" "201" "$CODE"
PI=$(field "$BODY" id)
printf '       intent: %s\n' "$PI"

REPLAY=$(curl -s -D - -o /dev/null -X POST "$API/v1/payment_intents" \
  -H "Authorization: Bearer $SK" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" -d "$BODY_JSON" | grep -i '^colibri-idempotent-replay:' | tr -d '\r' | awk '{print $2}')
check "reintento con misma llave se reproduce" "true" "$REPLAY"

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  -d '{"amount":9999999,"currency":"CRC"}'
check "misma llave con otro cuerpo devuelve 422" "422" "$CODE"

echo ""
echo "  --- Permisos de llave pública ---"

call "$API/v1/payment_intents/$PI" -H "Authorization: Bearer $PK"
check "llave pública no puede leer intents" "403" "$CODE"

echo ""
echo "  --- Tokenización ---"

call "$API/v1/payment_methods" -X POST -H "Authorization: Bearer $PK" \
  -H 'Content-Type: application/json' \
  -d '{"type":"CARD","card":{"number":"4242424242424242","expMonth":12,"expYear":2032,"cvc":"123"}}'
check "tokenizar con llave pública" "201" "$CODE"
PM=$(field "$BODY" id)
printf '       método: %s\n' "$PM"

LEAK=$(echo "$BODY" | grep -c '4242424242424242' || true)
check "la respuesta no contiene el PAN" "0" "$LEAK"

call "$API/v1/payment_methods" -X POST -H "Authorization: Bearer $PK" \
  -H 'Content-Type: application/json' \
  -d '{"type":"CARD","card":{"number":"4242424242424243","expMonth":12,"expYear":2032,"cvc":"123"}}'
check "tarjeta que falla Luhn devuelve 402" "402" "$CODE"

echo ""
echo "  --- Cobro ---"

call "$API/v1/payment_intents/$PI/confirm" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: confirm-$KEY" \
  -d "{\"paymentMethodId\":\"$PM\"}"
check "confirmar el cobro" "201" "$CODE"
check "estado final SUCCEEDED" "SUCCEEDED" "$(field "$BODY" status)"
check "monto recibido" "1000000" "$(field "$BODY" amountReceived)"

call "$API/v1/payment_intents/$PI" -H "Authorization: Bearer $SK"
check "consultar deja ver el cobro exitoso" "SUCCEEDED" "$(field "$BODY" status)"

echo ""
echo "  --- Rechazo ---"

call "$API/v1/payment_methods" -X POST -H "Authorization: Bearer $PK" \
  -H 'Content-Type: application/json' \
  -d '{"type":"CARD","card":{"number":"4000000000009995","expMonth":12,"expYear":2032,"cvc":"123"}}'
PM_BAD=$(field "$BODY" id)

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: decline-$KEY" \
  -d '{"amount":500000,"currency":"CRC"}'
PI_BAD=$(field "$BODY" id)

call "$API/v1/payment_intents/$PI_BAD/confirm" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d "{\"paymentMethodId\":\"$PM_BAD\"}"
check "fondos insuficientes vuelve a pedir método" "REQUIRES_PAYMENT_METHOD" "$(field "$BODY" status)"

echo ""
echo "  --- Captura manual ---"

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: manual-$KEY" \
  -d '{"amount":800000,"currency":"CRC","captureMethod":"MANUAL"}'
PI_MAN=$(field "$BODY" id)

call "$API/v1/payment_intents/$PI_MAN/confirm" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d "{\"paymentMethodId\":\"$PM\"}"
check "autoriza y queda pendiente de captura" "REQUIRES_CAPTURE" "$(field "$BODY" status)"

call "$API/v1/payment_intents/$PI_MAN/capture" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d '{"amountToCapture":500000}'
check "captura parcial queda SUCCEEDED" "SUCCEEDED" "$(field "$BODY" status)"
check "solo se capturó lo pedido" "500000" "$(field "$BODY" amountReceived)"

echo ""
echo "  --- Cancelación ---"

call "$API/v1/payment_intents" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: cancel-$KEY" \
  -d '{"amount":600000,"currency":"CRC"}'
PI_CAN=$(field "$BODY" id)

call "$API/v1/payment_intents/$PI_CAN/cancel" -X POST -H "Authorization: Bearer $SK" \
  -H 'Content-Type: application/json' -d '{}'
check "cancelar un intent sin confirmar" "CANCELED" "$(field "$BODY" status)"

echo ""
printf '  %d pruebas pasaron, %d fallaron\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

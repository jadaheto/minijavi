#!/bin/bash
# Carga el programa del "Javi de bolsillo" en la placa conectada por USB.
#   ./cargar.sh            compila y carga (programa + cara)
#   ./cargar.sh ver        ademas deja abierto el registro de la placa (se sale con Ctrl+])
#   ./cargar.sh compilar   solo compila, sin placa
set -e
cd "$(dirname "$0")"
IDF="${IDF_PATH:-$HOME/esp/esp-idf}"
if [ ! -f "$IDF/export.sh" ]; then echo "No encuentro ESP-IDF en $IDF. Instalalo (v5.5.x) o define IDF_PATH."; exit 1; fi
# La cara se empaqueta de nuevo si no existe o si la cara 2D cambio.
if [ ! -f cara.bin ] || [ ../public/bolsillo/cara.json -nt cara.bin ]; then (cd .. && node scripts/cara-placa.mjs); fi
. "$IDF/export.sh" > /dev/null
case "${1:-cargar}" in
  compilar) idf.py build ;;
  ver)      idf.py build flash monitor ;;
  *)        idf.py build flash; echo; echo "Listo. Si es la primera vez, la pantalla muestra una red Wi-Fi y su clave: entra desde el celular y abre 192.168.4.1" ;;
esac

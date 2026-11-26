#!/bin/sh
# Comprobaciones de un agente Google ADK creado desde la plantilla (las mismas del CI de la plantilla). Las ejecuta el
# SERVIDOR del taller, dentro de la carpeta del proyecto, como el usuario "taller" (sudo solo permite estas cuatro
# formas exactas: ver Dockerfile). El entorno de Python esta en /opt/adk (en local, ADK_VENV).
V="${ADK_VENV:-/opt/adk}"
case "$1" in
  pruebas) exec "$V/bin/pytest" -q --cov=agents --cov-fail-under=80 ;;
  ruff)    exec "$V/bin/ruff" check . ;;
  formato) exec "$V/bin/ruff" format --check . ;;
  env)     exec "$V/bin/python" scripts/check_env_vars.py .github/workflows/deploy.yml ;;
  *) echo "comprobación desconocida: $1" >&2; exit 2 ;;
esac

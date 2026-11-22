# sloplint.mjs (Hallmark)

Copia sin modificar de `skills/hallmark/scripts/sloplint.mjs` del repositorio https://github.com/Nutlope/hallmark,
commit `04977e15f3dfd6ee4b74c887dac3eb52665d6c92` (2026-11-11). Licencia MIT (ver `LICENSE`).

Lo usa la comprobación «diseño» del taller (`src/workshop/design-check.ts`): el SERVIDOR lo ejecuta sobre `sitio/` con
`--json --scope page`, sin red, como el usuario del taller y con un entorno sin claves. Solo usa módulos propios de Node.
No se instala la skill de Hallmark, ni sus hooks, ni sus temas: de sus reglas solo cuentan las que lista
`content/taller-diseno.json`.

Para actualizarlo: reemplazar el archivo por el de un commit revisado, anotar aquí el commit y correr `npm run verificar`.

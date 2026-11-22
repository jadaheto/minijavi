---
name: crear-avatar
description: Crea imágenes de avatares en el estilo de minijavi (cabeza 3D de caricatura) con el modelo de imagen de OpenAI. Úsala cuando pidan un avatar nuevo para el catálogo, candidatos de un personaje, las vistas de un personaje para modelarlo, o el retrato de una persona en ese estilo a partir de su foto.
---

# Crear avatar

Todo pasa por un solo comando, que usa el mismo módulo del servidor (`src/avatars/avatar-studio.ts`). Córrelo desde la
raíz del repositorio (`kiosco-avatar/`):

```
npm run avatar -- comprobar
npm run avatar -- prompt <id | "descripción">
npm run avatar -- catalogo <id | "descripción"> [n]
npm run avatar -- vistas <imagen> [perfil,trescuartos,ojoscerrados,atras]
npm run avatar -- retrato <foto> [n]
```

Opciones: `--salida <carpeta>` (por defecto `./avatares-salida`) y `--calidad low|medium|high` (por defecto `medium`).

## Reglas

- **No escribas prompts.** Los textos viven en `content/avatares.json` (`estilo`, `catalogo`, `vistas`, `retrato`).
  Para cambiar el estilo o agregar un personaje se edita ese archivo, no el código ni el prompt a mano.
- **Empieza por `comprobar`.** Dice si la cuenta tiene el modelo de imagen y no gasta. Si falla, detente y di por qué.
- **Cada imagen se cobra.** Antes de generar, di cuántas imágenes vas a pedir. Para probar usa `--calidad low` y `n` 1.
- **La clave** sale de `.env` (`OPENAI_API_KEY` o `MODELO_CAPAZ_KEY`; modelo en `IMAGEN_OPENAI_MODELO` o
  `IMAGEN_RESPALDO_MODELO`). El comando la carga solo. No la leas, no la muestres y no uses `source .env`.
- **Fotos de personas:** solo con la autorización de esa persona. No uses fotos de menores ni de varias personas. No
  dejes la foto ni el retrato dentro del repositorio: usa `--salida` hacia una carpeta fuera de git.
- **Mira el resultado** (abre la imagen) antes de darlo por bueno, y di con franqueza en qué no se parece.
- OpenAI limita a 20 imágenes de entrada por minuto: si responde 429, espera un minuto y repite solo lo que faltó.

## Qué hace cada orden

| Orden | Entra | Sale |
|---|---|---|
| `catalogo` | un id del catálogo o una descripción entre comillas | `n` candidatos (3) del personaje, con el estilo de `content/avatar-estilo.png` |
| `vistas` | la imagen elegida de un personaje | perfil, tres cuartos, ojos cerrados y atrás del MISMO personaje |
| `retrato` | la foto de una persona | esa persona en el estilo de los avatares |
| `prompt` | id o descripción | el prompt que se enviaría, sin generar |

## Flujos

**Personaje nuevo para el catálogo**
1. Agrega el personaje a `catalogo` en `content/avatares.json` (id en minúsculas, descripción de una frase larga,
   `humano` true o false). La descripción debe dejar la boca y los ojos despejados: se animan.
2. `npm run avatar -- catalogo <id>` → tres candidatos. Muéstralos y espera a que elijan uno.
3. `npm run avatar -- vistas <elegida>` → las vistas para modelar.
4. El modelado en Blender no es parte de esta skill: sigue `../avatares/GUIA-variantes.md`. Al terminar, el GLB va a
   `public/models/avatar-<id>.glb`, la miniatura a `public/img/avatares/<id>.jpg` y el id a `AVATARS`
   (`src/business/business.ts`).

**Retrato de una persona**
1. `npm run avatar -- retrato <foto> --salida <carpeta fuera de git>`.
2. El retrato es una IMAGEN. No produce una cabeza 3D con esa cara: en el visor se usa el avatar del catálogo que más
   se le parezca. No prometas otra cosa.

## Límites

- No genera modelos 3D ni archivos GLB.
- El texto de `retrato` es nuevo (2026-11-21); los demás son los que ya hicieron los ocho avatares del catálogo.
- No atiende a visitantes: es una herramienta de trabajo de Javier. El servidor usa el mismo módulo por su cuenta.

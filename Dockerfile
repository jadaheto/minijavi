# --- compilacion ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

# --- ejecucion ---
FROM node:22-alpine
# SQLite integrado de Node (base de interesados) aun avisa que es experimental en Node 22: se silencia ese aviso.
ENV NODE_ENV=production PORT=3000 NODE_OPTIONS=--disable-warning=ExperimentalWarning
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY prompts ./prompts
COPY content ./content
COPY vendor ./vendor
COPY package.json ./
# Lista de dispositivos del dueño. Montar un volumen en /app/data para que sobreviva a los despliegues.
RUN mkdir -p /app/data && chown node:node /app/data
# Taller de programacion: Claude Code corre como el usuario "taller" (no como el avatar), para que los comandos que
# ejecute no puedan leer las claves ni los datos del avatar. sudo solo permite al avatar lanzar `claude` como ese usuario
# y `rm` (para borrar un proyecto: sus archivos son de "taller"; no le da al avatar nada que no pueda ya).
# umask 0022 para el taller: el avatar crea sus archivos privados (umask 077) pero debe poder leer los sitios que publica.
RUN apk add --no-cache bash git sudo \
 && npm install -g @anthropic-ai/claude-code@2.1.326 && npm cache clean --force \
 && adduser -D -s /bin/bash taller \
 && printf '%s\n' 'Defaults:node umask=0022, umask_override, !lecture' 'Defaults:node secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' 'Defaults:node env_keep += "CI"' 'node ALL=(taller) NOPASSWD:SETENV: /usr/local/bin/claude' 'node ALL=(taller) NOPASSWD: /bin/rm' 'node ALL=(taller) NOPASSWD: /usr/local/bin/npm test, /usr/local/bin/npm run lint' 'node ALL=(taller) NOPASSWD: /usr/local/bin/node /app/vendor/hallmark/sloplint.mjs sitio --json --scope page' > /etc/sudoers.d/taller && chmod 440 /etc/sudoers.d/taller
ENV TALLER_USER=taller CLAUDE_BIN=/usr/local/bin/claude
USER node
EXPOSE 3000
# Audio de las llamadas de WhatsApp (WebRTC). Publicar el mismo rango en Easypanel y abrirlo en el firewall.
EXPOSE 40000-40009/udp
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1
CMD ["node", "dist/main.js"]

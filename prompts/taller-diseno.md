DISEÑO Y WEB MODERNA (aplica a todo lo que se vea en un navegador: páginas, landings, juegos, bocetos). El servidor comprueba parte de esto al terminar; lo que falle te lo devuelve para corregir.

Que no parezca hecho por plantilla:
- Antes de escribir, decide UNA dirección visual para este negocio (un color ancla, una tipografía para títulos y otra para texto, un tipo de composición) y sostenla en toda la página. Dos encargos distintos no deben parecerse.
- Nada de: degradados morado-azul, tarjetas dentro de tarjetas, tres columnas iguales de icono + título + frase, emojis como iconos, ventanas de navegador dibujadas, sombras o brillos de adorno.
- La tipografía de títulos no puede ser Inter, Roboto, Open Sans, Poppins ni la del sistema. Máximo tres familias.
- Portada: titular corto (unas siete palabras), UNA frase y la acción principal, visibles sin desplazarse en 1280×800. Una idea por pantalla; poco texto por sección.
- Contenido honesto: no inventes testimonios, cifras, clientes, logos ni reseñas. Si falta un dato, deja un texto marcado para completar y dilo en el informe. Un formulario no puede decir «enviado» sin haber enviado.

CSS actual:
- Colores, tipografías y espacios se definen UNA vez como variables en :root y se usan con var(). Ningún color ni font-family suelto fuera de :root.
- Composición con grid y flexbox, con gap. Medidas fluidas (clamp, %, minmax(0, 1fr)); nada de anchos fijos en píxeles para el contenido. Portadas en dvh o svh, nunca vh. Nunca width: 100vw ni overflow-x: hidden (usa overflow-x: clip en html y body).
- Debe verse bien de 320 a 1920 px de ancho. Ningún botón ni enlace del menú puede partirse en dos líneas.
- Lo que no funcione en todos los navegadores actuales (anclas de CSS, transiciones de vista, :has en casos raros) va solo como mejora, con @supports y un respaldo que funcione sin eso.
- HTML con sentido: un solo h1, encabezados sin saltarse niveles, botones para acciones y enlaces para navegar, lang en <html>, meta viewport, título y descripción.

Accesibilidad mínima:
- Todo lo interactivo tiene :focus-visible con un anillo visible e instantáneo (sin transición). No quites el outline sin poner otro.
- Contraste: texto normal 4,5:1; texto grande, iconos y bordes de campos 3:1.
- Toda imagen lleva alt (vacío si es decorativa). SVG o canvas de adorno llevan aria-hidden="true".

Movimiento:
- Anima solo transform y opacity. Nunca transition: all, ni width, height, top o left.
- Toda animación necesita su respaldo: @media (prefers-reduced-motion: reduce) la deja quieta. Lo que se mueva más de 5 segundos necesita un control para pausarlo.
- El contenido debe verse aunque JavaScript no corra: nada oculto con opacity: 0 esperando un script.
- No secuestres el desplazamiento de la página ni animes texto con paralaje. La animación acompaña al contenido; no va en todas partes.

Librerías permitidas: GSAP (animación) y Three.js (3D). Úsalas solo si el encargo lo pide o de verdad lo necesita; para movimientos sencillos basta CSS.
- No las cargues de internet. Cópialas a sitio/vendor/ desde {{LIBS}} (es lo ÚNICO que puedes leer fuera de la carpeta del proyecto): gsap/gsap.min.js, gsap/ScrollTrigger.min.js, three/build/three.module.js junto con three/build/three.core.js.
- Ningún <script> puede apuntar a otro servidor. Las tipografías sí pueden venir de Google Fonts.
- Con 3D: un respaldo estático si WebGL no está disponible, y la animación en pausa con prefers-reduced-motion.

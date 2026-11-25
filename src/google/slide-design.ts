/**
 * El diseño de las presentaciones que crea el avatar (pedido por Javier el 2026-11-24: las primeras salian blancas, con
 * el diseño basico de Google, y las imagenes eran objetos sueltos sobre fondo blanco).
 *
 * No se usan los diseños predefinidos de Google: cada diapositiva nace en blanco (BLANK) y aqui se pone todo con medidas
 * propias: color de fondo, barra de acento, cajas de texto con su letra y la imagen. Asi el resultado no depende del tema
 * que traiga el archivo. Ordenes de la API de Slides leidas el 2026-11-24 (createSlide, createShape, insertText,
 * updateTextStyle, updateParagraphStyle, createParagraphBullets, updateShapeProperties, updatePageProperties,
 * createImage, updatePageElementsZOrder). Medidas en EMU: una diapositiva 16:9 mide 9.144.000 x 5.143.500.
 */
export interface SlideSpec { title: string; points: string[]; /** Direccion publica de la imagen de esta diapositiva (opcional). */ image?: string; /** Notas del orador (opcional). */ notes?: string }

export interface SlideTheme { label: string; bg: string; title: string; text: string; accent: string; titleFont: string; bodyFont: string; /** Como deben verse las imagenes para ir con este tema. */ art: string }
export const SLIDE_THEMES: Record<string, SlideTheme> = {
  noche: { label: 'oscuro azul', bg: '#0B1220', title: '#FFFFFF', text: '#C9D4E5', accent: '#4F8CFF', titleFont: 'Montserrat', bodyFont: 'Inter', art: 'paleta azul marino profundo con luces azul eléctrico y toques cian' },
  grafito: { label: 'oscuro grafito', bg: '#16181D', title: '#F5F5F2', text: '#C8C9CC', accent: '#F2A33A', titleFont: 'Poppins', bodyFont: 'Inter', art: 'paleta gris carbón con luz cálida ámbar y dorada' },
  bosque: { label: 'oscuro verde', bg: '#0E1F1A', title: '#F1F7F3', text: '#BFD3C8', accent: '#3DDC97', titleFont: 'Space Grotesk', bodyFont: 'Inter', art: 'paleta verde bosque profundo con luces verde menta' },
  arena: { label: 'claro cálido', bg: '#F6F1E7', title: '#1E1B16', text: '#4A443A', accent: '#D95926', titleFont: 'Playfair Display', bodyFont: 'Lato', art: 'paleta cálida de tonos arena, crema y terracota, luz suave de atardecer' },
  claro: { label: 'claro', bg: '#FFFFFF', title: '#101828', text: '#475467', accent: '#3987E5', titleFont: 'Montserrat', bodyFont: 'Inter', art: 'paleta luminosa de azules suaves y grises claros, luz de día' },
};
export const DEFAULT_THEME = 'noche';
/** El tema pedido, o el de fabrica. Acepta tambien "oscura" / "clara" dichos por voz. */
export function themeName(v: unknown, fallback = DEFAULT_THEME): string {
  const t = String(v ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (SLIDE_THEMES[t]) return t;
  if (/^oscur/.test(t)) return 'noche'; if (/^clar/.test(t)) return 'claro'; if (/calid|arena|crema/.test(t)) return 'arena'; if (/verde/.test(t)) return 'bosque'; if (/gris|grafito|negr/.test(t)) return 'grafito'; if (/azul/.test(t)) return 'noche';
  return SLIDE_THEMES[fallback] ? fallback : DEFAULT_THEME;
}

/**
 * La descripcion que se le da al generador para una imagen de la presentacion: una sola direccion de arte para todas
 * (el estilo del guion + la paleta del tema), escena a sangre completa (nunca un objeto sobre blanco) y sin texto.
 */
export function slideImagePrompt(theme: string, style: string, scene: string, cover = false): string {
  const t = SLIDE_THEMES[themeName(theme)];
  return [
    `${(style || 'Ilustración 3D editorial, formas suaves, materiales mate con detalles brillantes').replace(/[.\s]+$/, '')}.`,
    `Escena: ${scene.replace(/[.\s]+$/, '')}.`,
    `Composición a sangre completa: el ambiente ocupa todo el encuadre de borde a borde, con ${t.art}. Nunca fondo blanco ni liso, nunca un objeto aislado o recortado.`,
    'Iluminación cinematográfica con profundidad, primer plano y fondo desenfocado, acabado de portada de revista.',
    cover ? 'Deja la mitad inferior más oscura y despejada, sin elementos importantes ahí (encima irá un título).' : 'Formato vertical; el sujeto principal centrado.',
    'Sin ningún texto, letras, números, rótulos, logos ni marcas de agua. Sin personas reales reconocibles.',
  ].join(' ');
}

const W = 9_144_000, H = 5_143_500;
const rgb = (hex: string) => ({ red: parseInt(hex.slice(1, 3), 16) / 255, green: parseInt(hex.slice(3, 5), 16) / 255, blue: parseInt(hex.slice(5, 7), 16) / 255 });
const emu = (magnitude: number) => ({ magnitude, unit: 'EMU' });
const box = (page: string, x: number, y: number, w: number, h: number) => ({ pageObjectId: page, size: { width: emu(w), height: emu(h) }, transform: { scaleX: 1, scaleY: 1, translateX: x, translateY: y, unit: 'EMU' } });

/**
 * Las ordenes para armar una presentacion con el tema dado: portada (con la imagen `cover` de fondo si hay) y una
 * diapositiva por punto, con barra de acento, titulo, viñetas y, si trae, su imagen vertical a toda la altura a la
 * derecha. Las imagenes se devuelven aparte, cada una como su propio envio, para que una que falle no tumbe las demas.
 * Con `append` (un prefijo unico para los identificadores) no hay portada y las diapositivas quedan al final.
 */
export function slideRequests(title: string, subtitle: string, slides: SlideSpec[], append = '', theme = 'claro', cover = ''): { requests: Record<string, unknown>[]; images: Record<string, unknown>[][]; notes: { page: string; text: string }[] } {
  const T = SLIDE_THEMES[themeName(theme, 'claro')], requests: Record<string, unknown>[] = [], images: Record<string, unknown>[][] = [], notes: { page: string; text: string }[] = [];
  const background = (page: string) => requests.push({ updatePageProperties: { objectId: page, pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: rgb(T.bg) } } } }, fields: 'pageBackgroundFill.solidFill.color' } });
  const rect = (id: string, page: string, x: number, y: number, w: number, h: number, color: string, alpha = 1) => requests.push(
    { createShape: { objectId: id, shapeType: 'RECTANGLE', elementProperties: box(page, x, y, w, h) } },
    { updateShapeProperties: { objectId: id, shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: rgb(color) }, alpha } }, outline: { propertyState: 'NOT_RENDERED' } }, fields: 'shapeBackgroundFill.solidFill.color,shapeBackgroundFill.solidFill.alpha,outline.propertyState' } });
  const text = (id: string, page: string, x: number, y: number, w: number, h: number, value: string, o: { color: string; font: string; size: number; bold?: boolean; align?: 'TOP' | 'MIDDLE' | 'BOTTOM'; bullets?: boolean }) => {
    requests.push({ createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: box(page, x, y, w, h) } }, { insertText: { objectId: id, text: value } },
      { updateTextStyle: { objectId: id, textRange: { type: 'ALL' }, style: { foregroundColor: { opaqueColor: { rgbColor: rgb(o.color) } }, fontFamily: o.font, fontSize: { magnitude: o.size, unit: 'PT' }, bold: !!o.bold }, fields: 'foregroundColor,fontFamily,fontSize,bold' } });
    if (o.align) requests.push({ updateShapeProperties: { objectId: id, shapeProperties: { contentAlignment: o.align }, fields: 'contentAlignment' } });
    if (o.bullets) requests.push({ updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' }, style: { lineSpacing: 125, spaceBelow: { magnitude: 9, unit: 'PT' } }, fields: 'lineSpacing,spaceBelow' } }, { createParagraphBullets: { objectId: id, textRange: { type: 'ALL' }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
  };
  if (!append) {
    const p = 'mj_portada';
    requests.push({ createSlide: { objectId: p, insertionIndex: 0, slideLayoutReference: { predefinedLayout: 'BLANK' } } }); background(p);
    // Con imagen: un velo del color del tema para que el titulo se lea siempre. La imagen (3:2) se pone mas alta que la
    // diapositiva y centrada, para cubrirla sin deformarse, y se manda al fondo porque llega despues que el texto.
    if (cover) {
      rect(`${p}_velo`, p, 0, 0, W, H, T.bg, 0.58);
      images.push([{ createImage: { objectId: `${p}_img`, url: cover, elementProperties: box(p, 0, -Math.round((W / 1.5 - H) / 2), W, Math.round(W / 1.5)) } }, { updatePageElementsZOrder: { pageElementObjectIds: [`${p}_img`], operation: 'SEND_TO_BACK' } }]);
    }
    rect(`${p}_barra`, p, 571_500, subtitle ? 3_990_000 : 4_420_000, 1_000_000, 64_000, T.accent);
    text(`${p}_t`, p, 571_500, 1_300_000, 8_000_000, subtitle ? 2_600_000 : 3_030_000, title, { color: T.title, font: T.titleFont, size: title.length <= 38 ? 40 : title.length <= 75 ? 32 : 26, bold: true, align: 'BOTTOM' });
    if (subtitle) text(`${p}_s`, p, 571_500, 4_120_000, 8_000_000, 620_000, subtitle, { color: T.text, font: T.bodyFont, size: 16, align: 'TOP' });
  }
  slides.forEach((sl, k) => {
    const n = String(k + 1).padStart(2, '0'), page = append ? `${append}_${n}` : `mj_dia_${n}`, imgW = Math.round(H * 2 / 3), textW = sl.image ? W - imgW - 500_000 - 400_000 : W - 1_000_000;
    requests.push({ createSlide: { objectId: page, ...(append ? {} : { insertionIndex: k + 1 }), slideLayoutReference: { predefinedLayout: 'BLANK' } } }); background(page);
    rect(`${page}_barra`, page, 500_000, 600_000, 70_000, 860_000, T.accent);
    text(`${page}_t`, page, 690_000, 520_000, textW - 190_000, 1_020_000, sl.title, { color: T.title, font: T.titleFont, size: sl.title.length <= 34 ? 26 : 21, bold: true, align: 'MIDDLE' });
    if (sl.points.length) text(`${page}_b`, page, 500_000, 1_760_000, textW, 2_950_000, sl.points.join('\n'), { color: T.text, font: T.bodyFont, size: sl.image ? 16 : 19, align: 'TOP', bullets: true });
    if (sl.image) images.push([{ createImage: { objectId: `${page}_img`, url: sl.image, elementProperties: box(page, W - imgW, 0, imgW, H) } }]);
    if (sl.notes) notes.push({ page, text: sl.notes });
  });
  return { requests, images, notes };
}

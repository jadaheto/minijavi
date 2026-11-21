/** Clima de Open-Meteo (geocoding + forecast, sin clave; probado el 2026-11-13). Lo usan la herramienta `clima` y el resumen del dia. */

/** Fondo segun el codigo de tiempo (OMM) y si es de dia. */
export function weatherScene(code: number, isDay: boolean): string {
  if (code >= 95) return 'tormenta';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'lluvia';
  if (code === 3 || code === 45 || code === 48 || (code >= 71 && code <= 86)) return 'nublado';
  return isDay ? 'soleado' : 'estrellas'; // despejado o pocas nubes
}

/** Codigos de tiempo de la OMM que devuelve Open-Meteo. */
export const WMO: Record<number, string> = {
  0: 'cielo despejado', 1: 'mayormente despejado', 2: 'parcialmente nublado', 3: 'nublado', 45: 'niebla', 48: 'niebla',
  51: 'llovizna ligera', 53: 'llovizna', 55: 'llovizna fuerte', 61: 'lluvia ligera', 63: 'lluvia', 65: 'lluvia fuerte',
  66: 'lluvia helada', 67: 'lluvia helada', 71: 'nieve ligera', 73: 'nieve', 75: 'nieve fuerte', 77: 'granizo fino',
  80: 'chubascos ligeros', 81: 'chubascos', 82: 'chubascos fuertes', 85: 'nevadas', 86: 'nevadas fuertes',
  95: 'tormenta eléctrica', 96: 'tormenta con granizo', 99: 'tormenta fuerte con granizo',
};

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`el servicio respondió ${res.status}`);
  return res.json();
}

export interface Weather { place: string; city: string; desc: string; temp: number; feels: number; max: number; min: number; rain: number; scene: string; text: string; }

/** Clima actual y de hoy. `null` si no se encontro la ciudad; lanza un error si el servicio falla. */
export async function weatherNow(city: string): Promise<Weather | null> {
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`);
  const place = geo.results?.[0];
  if (!place) return null;
  const w = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto',
  );
  const c = w.current, d = w.daily;
  const lugar = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
  const desc = WMO[c.weather_code] ?? 'condición desconocida';
  const out = { place: lugar, city: String(place.name), desc, temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature), max: Math.round(d.temperature_2m_max[0]), min: Math.round(d.temperature_2m_min[0]), rain: Number(d.precipitation_probability_max[0]) || 0, scene: weatherScene(Number(c.weather_code), c.is_day !== 0) };
  const text =
    `Clima en ${lugar}: ${desc}, ${out.temp} grados (sensación de ${out.feels}), humedad ${c.relative_humidity_2m} por ciento, viento ${Math.round(c.wind_speed_10m)} km/h. ` +
    `Hoy: máxima ${out.max}, mínima ${out.min}, probabilidad de lluvia ${out.rain} por ciento.`;
  return { ...out, text };
}

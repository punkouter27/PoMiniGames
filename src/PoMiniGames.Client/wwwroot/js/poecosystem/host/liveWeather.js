// liveWeather.js — Optional real-world weather & astronomy sync for PoEcosystem.
// Uses Open-Meteo (free, no API key) and Sunrise-Sunset.org (free, no API key)
// solely to drive the renderer's sky, sun angle, clouds, and precipitation when
// opted in by the viewer. Never alters deterministic simulation state.

export const LIVE_CITIES = Object.freeze([
  { id: 'off', name: 'Sim Island Clock (Default)', lat: 0, lon: 0 },
  { id: 'tokyo', name: 'Tokyo', lat: 35.6762, lon: 139.6503 },
  { id: 'london', name: 'London', lat: 51.5072, lon: -0.1276 },
  { id: 'reykjavik', name: 'Reykjavik', lat: 64.1466, lon: -21.9426 },
  { id: 'cairo', name: 'Cairo', lat: 30.0444, lon: 31.2357 },
  { id: 'seattle', name: 'Seattle', lat: 47.6062, lon: -122.3321 },
  { id: 'sydney', name: 'Sydney', lat: -33.8688, lon: 151.2093 },
]);

const CACHE_MS = 15 * 60 * 1000;
const cache = new Map();

/** Map WMO weather interpretation code to PoEcosystem WEATHER_KIND (0 Clear, 1 Rain, 2 Storm, 3 Drought, 4 Snow). */
export function mapWmoToWeather(code, tempC) {
  const c = Number(code) | 0;
  if (c >= 95) return { kind: 2, name: 'Storm', intensity: 0.9 };
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return { kind: 4, name: 'Snow', intensity: 0.85 };
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return { kind: 1, name: 'Rain', intensity: c >= 63 ? 0.85 : 0.6 };
  if (c === 0 && typeof tempC === 'number' && tempC >= 33) return { kind: 3, name: 'Heatwave', intensity: 0.7 };
  if (c >= 1 && c <= 3) return { kind: 0, name: c === 3 ? 'Overcast' : 'Partly Cloudy', intensity: 0 };
  if (c === 45 || c === 48) return { kind: 1, name: 'Mist', intensity: 0.2 };
  return { kind: 0, name: 'Clear', intensity: 0 };
}

/**
 * Compute dayFraction (0 = midnight, 0.25 = sunrise, 0.5 = solar noon, 0.75 = sunset)
 * from ISO sunrise/sunset UTC strings, or fallback to longitude solar approximation.
 */
export function computeDayFraction(nowMs, sunriseIso, sunsetIso, lon = 0) {
  const sr = sunriseIso ? Date.parse(sunriseIso) : NaN;
  const ss = sunsetIso ? Date.parse(sunsetIso) : NaN;
  if (Number.isFinite(sr) && Number.isFinite(ss) && ss > sr) {
    const dayLen = ss - sr;
    if (nowMs >= sr && nowMs <= ss) {
      return 0.25 + ((nowMs - sr) / dayLen) * 0.5;
    }
    const nightLen = 86400000 - dayLen;
    const afterSunset = nowMs > ss ? (nowMs - ss) : (nowMs + 86400000 - ss);
    return (0.75 + (afterSunset / Math.max(1, nightLen)) * 0.5) % 1;
  }
  const d = new Date(nowMs);
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  return (((utcHours + lon / 15) % 24) + 24) % 24 / 24;
}

export async function fetchLiveWeather(cityId) {
  const city = LIVE_CITIES.find(c => c.id === cityId);
  if (!city || city.id === 'off') return null;

  const hit = cache.get(city.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 4500) : null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,weather_code,cloud_cover,is_day&daily=sunrise,sunset&timezone=GMT&forecast_days=1`;
    const resp = await fetch(url, { signal: ctrl?.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const cur = json?.current ?? {};
    const daily = json?.daily ?? {};
    let sunrise = Array.isArray(daily.sunrise) ? daily.sunrise[0] + 'Z' : null;
    let sunset = Array.isArray(daily.sunset) ? daily.sunset[0] + 'Z' : null;

    // Fallback astronomical lookup via Sunrise-Sunset.org if Open-Meteo daily fields were omitted.
    if (!sunrise || !sunset) {
      try {
        const astroResp = await fetch(`https://api.sunrise-sunset.org/json?lat=${city.lat}&lng=${city.lon}&formatted=0`, { signal: ctrl?.signal });
        if (astroResp.ok) {
          const astro = await astroResp.json();
          sunrise = astro?.results?.sunrise ?? sunrise;
          sunset = astro?.results?.sunset ?? sunset;
        }
      } catch { /* fallback to solar longitude */ }
    }

    const tempC = typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null;
    const mapped = mapWmoToWeather(cur.weather_code, tempC);
    const cloud = typeof cur.cloud_cover === 'number' ? Math.max(0, Math.min(1, cur.cloud_cover / 100)) : (mapped.kind === 1 || mapped.kind === 2 ? 0.85 : 0.15);
    const dayFraction = computeDayFraction(Date.now(), sunrise, sunset, city.lon);

    const data = {
      cityId: city.id,
      cityName: city.name,
      weatherKind: mapped.kind,
      weatherName: mapped.name,
      intensity: mapped.intensity,
      overcast: Math.max(cloud, mapped.kind === 2 ? 0.95 : mapped.kind === 1 ? 0.65 : 0),
      dayFraction,
      tempC,
      label: `${city.name}${tempC !== null ? ` · ${tempC}°C` : ''} · ${mapped.name}`,
    };
    cache.set(city.id, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

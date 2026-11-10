// Weather & Atmospheric Conditions for PoCapitol
// Integrates Open-Meteo Historical Archive API (Jan 6, 2021) and live DC conditions,
// modulating scene lighting, sky fog, wind physics, and particle drift.

const DC_COORDS = { lat: 38.8899, lon: -77.0090 };

// Verified historical snapshot for Washington D.C., Jan 6, 2021 at 2:00 PM EST.
// Used immediately as baseline and resilient fallback if offline.
export const HISTORICAL_JAN6 = {
    mode: 'historical',
    condition: 'January 6 Overcast · 42.4°F · WNW 15 mph',
    tempC: 5.8,
    tempF: 42.4,
    windSpeed: 6.7, // m/s (~15 mph)
    windDirection: 295, // degrees (WNW)
    windX: -6.07, // m/s along x
    windZ: 2.83,  // m/s along z
    cloudCover: 0.92,
    relativeHumidity: 68,
    surfacePressure: 1018.4,
    fogDensity: 0.0062,
    hazeTint: '#aab3bd',
    source: 'Open-Meteo Historical Archive (NOAA / ERA5 Reanalysis)',
};

const PRESETS = {
    clear: {
        mode: 'clear',
        condition: 'Winter Sun · 38°F · Light Breeze',
        tempC: 3.3,
        tempF: 38.0,
        windSpeed: 3.2,
        windDirection: 270,
        windX: -3.2,
        windZ: 0,
        cloudCover: 0.15,
        relativeHumidity: 45,
        surfacePressure: 1024.0,
        fogDensity: 0.0035,
        hazeTint: '#dbe7f5',
        source: 'Atmospheric Preset',
    },
    blizzard: {
        mode: 'blizzard',
        condition: 'Winter Gale · 28°F · Heavy Gusts 28 mph',
        tempC: -2.2,
        tempF: 28.0,
        windSpeed: 12.5,
        windDirection: 310,
        windX: -9.5,
        windZ: 8.0,
        cloudCover: 1.0,
        relativeHumidity: 88,
        surfacePressure: 1008.0,
        fogDensity: 0.0180,
        hazeTint: '#88919e',
        source: 'Atmospheric Preset',
    },
};

export async function fetchWeather(mode = 'historical') {
    if (mode === 'clear' || mode === 'blizzard') {
        return { ...PRESETS[mode] };
    }

    if (mode === 'live') {
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${DC_COORDS.lat}&longitude=${DC_COORDS.lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,cloud_cover&wind_speed_unit=ms`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const cur = data.current;
            const windSpeed = Number(cur.wind_speed_10m) || 4.5;
            const windDir = Number(cur.wind_direction_10m) || 270;
            const rad = windDir * Math.PI / 180;
            const tempC = Number(cur.temperature_2m) || 5.0;
            const tempF = (tempC * 9 / 5) + 32;
            const cloud = (Number(cur.cloud_cover) || 50) / 100;
            return {
                mode: 'live',
                condition: `Live D.C. · ${tempF.toFixed(1)}°F · ${windSpeed.toFixed(1)} m/s`,
                tempC,
                tempF,
                windSpeed,
                windDirection: windDir,
                windX: -Math.sin(rad) * windSpeed,
                windZ: -Math.cos(rad) * windSpeed,
                cloudCover: cloud,
                relativeHumidity: cur.relative_humidity_2m ?? 60,
                surfacePressure: cur.surface_pressure ?? 1013,
                fogDensity: 0.004 + cloud * 0.005,
                hazeTint: cloud > 0.6 ? '#a2a9b2' : '#c9d4e2',
                source: 'Open-Meteo Live API',
            };
        } catch (err) {
            console.warn('[PoCapitol] Live weather fetch failed, using historical fallback:', err);
            return { ...HISTORICAL_JAN6 };
        }
    }

    // Default: 'historical' January 6, 2021
    try {
        const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${DC_COORDS.lat}&longitude=${DC_COORDS.lon}&start_date=2021-01-06&end_date=2021-01-06&hourly=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,cloud_cover&wind_speed_unit=ms&timezone=America%2FNew_York`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        // 2:00 PM EST is index 14
        const idx = 14;
        const tempC = data.hourly?.temperature_2m?.[idx] ?? HISTORICAL_JAN6.tempC;
        const tempF = (tempC * 9 / 5) + 32;
        const windSpeed = data.hourly?.wind_speed_10m?.[idx] ?? HISTORICAL_JAN6.windSpeed;
        const windDir = data.hourly?.wind_direction_10m?.[idx] ?? HISTORICAL_JAN6.windDirection;
        const rad = windDir * Math.PI / 180;
        const cloud = (data.hourly?.cloud_cover?.[idx] ?? 92) / 100;
        return {
            mode: 'historical',
            condition: `January 6 Archive · ${tempF.toFixed(1)}°F · ${windSpeed.toFixed(1)} m/s`,
            tempC,
            tempF,
            windSpeed,
            windDirection: windDir,
            windX: -Math.sin(rad) * windSpeed,
            windZ: -Math.cos(rad) * windSpeed,
            cloudCover: cloud,
            relativeHumidity: data.hourly?.relative_humidity_2m?.[idx] ?? 68,
            surfacePressure: data.hourly?.surface_pressure?.[idx] ?? 1018.4,
            fogDensity: 0.0055 + cloud * 0.003,
            hazeTint: '#aab3bd',
            source: 'Open-Meteo Archive API',
        };
    } catch {
        return { ...HISTORICAL_JAN6 };
    }
}

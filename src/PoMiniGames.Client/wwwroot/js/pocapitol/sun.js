// Where the sun really stood over the Capitol on the afternoon of 6 January 2021.
//
// NOAA's solar position equations (the ones behind its Solar Calculator, after Jean Meeus,
// Astronomical Algorithms): good to about a hundredth of a degree for this century, which is
// far finer than a shadow can show. Pure arithmetic, no three.js, so it can be checked against
// published tables (sunset that day in Washington was 4:58 pm EST).

export const CAPITOL = { lat: 38.889939, lon: -77.009051 };
const RAD = Math.PI / 180;

/** Julian day number for a UTC instant in milliseconds. */
const julian = ms => ms / 86400000 + 2440587.5;

/**
 * The sun's position at `ms` (UTC milliseconds) seen from `lat`/`lon` in degrees.
 * Returns { altitude, azimuth } in degrees: azimuth clockwise from true north, altitude with
 * atmospheric refraction folded in (the sun looks a little higher than it is near the horizon).
 */
export function solarPosition(ms, lat = CAPITOL.lat, lon = CAPITOL.lon) {
    const t = (julian(ms) - 2451545) / 36525;
    const meanLon = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const m = meanAnomaly * RAD;
    const centre = Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
        Math.sin(2 * m) * (0.019993 - 0.000101 * t) + Math.sin(3 * m) * 0.000289;
    const trueLon = meanLon + centre;
    const omega = 125.04 - 1934.136 * t;
    const apparentLon = trueLon - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const obliquity = meanObliquity + 0.00256 * Math.cos(omega * RAD);
    const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLon * RAD));
    // Equation of time, minutes: how far the sun runs ahead of or behind the clock.
    const y = Math.tan(obliquity * RAD / 2) ** 2;
    const l0 = meanLon * RAD;
    const eot = 4 / RAD * (y * Math.sin(2 * l0) - 2 * eccentricity * Math.sin(m) +
        4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) - 0.5 * y * y * Math.sin(4 * l0) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * m));
    const utcMinutes = (ms / 60000) % 1440;
    const solarMinutes = ((utcMinutes + eot + 4 * lon) % 1440 + 1440) % 1440;
    const hourAngle = (solarMinutes / 4 < 0 ? solarMinutes / 4 + 180 : solarMinutes / 4 - 180) * RAD;
    const phi = lat * RAD;
    const cosZenith = Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
    const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
    let altitude = 90 - zenith / RAD;
    // Refraction (Bennett's approximation, as NOAA uses it), degrees.
    if (altitude > -0.575) {
        const tanA = Math.tan(altitude * RAD);
        const r = altitude > 5 ? 58.1 / tanA - 0.07 / tanA ** 3 + 0.000086 / tanA ** 5
            : 1735 + altitude * (-518.2 + altitude * (103.4 + altitude * (-12.79 + altitude * 0.711)));
        altitude += r / 3600;
    }
    const azimuthDenominator = Math.cos(phi) * Math.sin(zenith);
    let azimuth = 180;
    if (Math.abs(azimuthDenominator) > 1e-9) {
        const cosAz = (Math.sin(phi) * Math.cos(zenith) - Math.sin(declination)) / azimuthDenominator;
        const a = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
        azimuth = hourAngle > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { altitude, azimuth };
}

/** 6 January 2021, 12:50 pm EST (UTC−5) as UTC milliseconds: the scenario clock's zero. */
export const SCENARIO_START_UTC = Date.UTC(2021, 0, 6, 17, 50);

/** The sun at a scenario second (one second is one minute of the afternoon). */
export function scenarioSun(elapsedSeconds) {
    return solarPosition(SCENARIO_START_UTC + elapsedSeconds * 60000);
}

/**
 * Daylight through cloud, 0..1, from the sun's altitude and the cloud cover: a clear-sky curve
 * (air mass through the atmosphere) dimmed by overcast. Below the horizon the sky still glows for
 * about half an hour of civil twilight.
 */
export function daylightFactor(altitude, cloudCover = 0.9) {
    if (altitude <= -6) return 0;
    if (altitude <= 0.5) return daylightFactor(0.5, cloudCover) * (1 + altitude / 6) / (1 + 0.5 / 6);
    const airMass = 1 / (Math.sin(altitude * RAD) + 0.50572 * (altitude + 6.07995) ** -1.6364);
    const clear = Math.pow(0.7, Math.pow(airMass, 0.678));
    const cloud = Math.max(0, Math.min(1, cloudCover));
    return clear * (1 - 0.72 * cloud ** 3.4);
}

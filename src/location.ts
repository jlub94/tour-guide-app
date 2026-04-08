/**
 * location.ts
 *
 * Handles all GPS location tracking via expo-location.
 * Requests foreground + background permissions, starts a high-accuracy
 * position watcher, and exports a Haversine distance helper.
 *
 * Background location is required so narration continues when the screen
 * is off. On iOS this also requires UIBackgroundModes=location in app.json
 * and the expo-location plugin with isAndroidBackgroundLocationEnabled.
 *
 * NOTE: In Expo Go on iOS, background location is not supported.
 * The app will still work in foreground-only mode.
 */

import * as Location from 'expo-location';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LocationData {
  latitude: number;
  longitude: number;
  /** Estimated horizontal accuracy in metres; null if unavailable. */
  accuracy: number | null;
  timestamp: number;
}

export type LocationCallback = (location: LocationData) => void;

// ─── State ───────────────────────────────────────────────────────────────────

let subscription: Location.LocationSubscription | null = null;

// ─── Permissions ─────────────────────────────────────────────────────────────

/**
 * Asks the user for foreground then background location permissions.
 * Returns true if foreground is granted (background is optional — Expo Go
 * does not support it and requestBackgroundPermissionsAsync may throw there).
 */
export async function requestLocationPermissions(): Promise<boolean> {
  console.log('[location] Requesting foreground location permission...');
  const { status: fg } = await Location.requestForegroundPermissionsAsync();
  console.log('[location] Foreground permission result:', fg);

  if (fg !== 'granted') {
    console.warn('[location] Foreground location permission denied.');
    return false;
  }

  // Background permission is optional — Expo Go on iOS will reject or throw.
  // Wrap in try/catch so a failure here doesn't block the whole tour.
  try {
    const { status: bg } = await Location.requestBackgroundPermissionsAsync();
    console.log('[location] Background permission result:', bg);
    if (bg !== 'granted') {
      console.warn('[location] Background location permission denied — narration will pause when screen is off.');
    }
  } catch (err) {
    console.warn('[location] Background permission request failed (expected in Expo Go):', err);
  }

  return true;
}

// ─── Tracking ────────────────────────────────────────────────────────────────

/**
 * Starts a continuous high-accuracy location watcher.
 * Updates fire every 3 s or when the device moves ≥ 1 m (whichever first),
 * giving the triggering logic good resolution for detecting the 15 m threshold.
 */
export async function startLocationTracking(
  onLocation: LocationCallback
): Promise<void> {
  if (subscription) {
    console.log('[location] Already tracking, skipping duplicate start.');
    return;
  }

  console.log('[location] Starting watchPositionAsync...');
  subscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: 3_000,   // ms — fire at least every 3 seconds
      distanceInterval: 1,   // metres — fire on any movement ≥ 1 m
    },
    (pos) => {
      const data: LocationData = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        timestamp: pos.timestamp,
      };
      console.log(
        `[location] Update received — lat: ${data.latitude.toFixed(6)}, lng: ${data.longitude.toFixed(6)}, accuracy: ${data.accuracy?.toFixed(1) ?? 'n/a'} m`
      );
      onLocation(data);
    }
  );
  console.log('[location] watchPositionAsync started successfully.');
}

/**
 * Stops the location watcher and releases resources.
 */
export function stopLocationTracking(): void {
  if (subscription) {
    console.log('[location] Stopping location tracking.');
    subscription.remove();
    subscription = null;
  }
}

// ─── Reverse geocoding ───────────────────────────────────────────────────────

export interface GeocodedAddress {
  /** Human-readable address string ready to pass to the AI prompt. */
  formatted: string;
}

/**
 * Converts GPS coordinates into a human-readable address using Expo's
 * reverseGeocodeAsync. Returns null if geocoding fails or returns no results.
 *
 * The returned `formatted` string includes the street number + name,
 * district/suburb, and any named place (e.g. a landmark or neighbourhood)
 * so the AI has rich location context beyond raw coordinates.
 */
export async function reverseGeocode(
  latitude: number,
  longitude: number
): Promise<GeocodedAddress | null> {
  try {
    const results = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (!results || results.length === 0) return null;

    const r = results[0];

    // Build an ordered set of address parts, omitting any that are null/empty.
    const parts: string[] = [];

    // Street name only — no number; cleaner for display and sufficient for AI context.
    if (r.street) parts.push(r.street);

    // Named POI only if genuinely distinct from the street address in all forms.
    // On iOS, r.name is often "${streetNumber} ${street}", so we must check that
    // combined form too to avoid duplicates like "105 Rylston Road, Rylston Road".
    const composedStreet = [r.streetNumber, r.street].filter(Boolean).join(' ');
    if (
      r.name &&
      r.name !== r.street &&
      r.name !== r.streetNumber &&
      r.name !== composedStreet
    ) {
      parts.unshift(r.name);
    }

    // Area: prefer the specific sub-locality (e.g. "Fulham") over the wider
    // borough/district (e.g. "Hammersmith and Fulham") for a readable pill.
    const area = r.subregion ?? r.district ?? null;
    if (area && area !== r.street) parts.push(area);

    if (parts.length === 0) return null;

    const formatted = parts.join(', ');
    console.log(`[location] Reverse geocode result: ${formatted}`);
    return { formatted };
  } catch (err) {
    console.warn('[location] reverseGeocodeAsync failed:', err);
    return null;
  }
}

// ─── Distance helper ─────────────────────────────────────────────────────────

/**
 * Calculates the great-circle distance between two GPS coordinates using
 * the Haversine formula. Returns the result in **metres**.
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6_371_000; // Earth's radius in metres
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

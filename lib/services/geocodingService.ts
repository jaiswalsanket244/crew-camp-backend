/**
 * Geocoding Service
 *
 * Service for parsing and geocoding addresses using Google Maps API.
 * Provides fallback to simple parsing if API is unavailable or not configured.
 */

import { config } from "../utils/configuration/config";

export interface ParsedAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  formattedAddress?: string;
}

export interface GeocodingResult extends ParsedAddress {
  latitude?: number;
  longitude?: number;
}

/**
 * Parse address using Google Geocoding API.
 * Returns structured address components.
 *
 * @param addressString - Address string to parse (e.g., "2F9C+98R Unikicherla, Telangana, India")
 * @returns Parsed address components
 */
export async function parseAddressWithGeocoding(
  addressString: string,
): Promise<GeocodingResult | null> {
  // Check if Google Maps API key is configured
  const apiKey = config.GOOGLE_API_KEY;

  if (!apiKey || apiKey === "" || apiKey === "your_api_key_here") {
    return parseAddressSimple(addressString);
  }

  try {
    // Call Google Geocoding API
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addressString)}&key=${apiKey}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Geocoding API returned ${response.status}`);
    }

    const data = await response.json();

    if (data.status !== "OK" || !data.results || data.results.length === 0) {
      return parseAddressSimple(addressString);
    }

    const result = data.results[0];
    const components = result.address_components;

    // Extract address components
    const parsed: GeocodingResult = {
      formattedAddress: result.formatted_address,
    };

    // Extract latitude and longitude
    if (result.geometry?.location) {
      parsed.latitude = result.geometry.location.lat;
      parsed.longitude = result.geometry.location.lng;
    }

    // Parse address components
    for (const component of components) {
      const types = component.types;

      if (types.includes("street_number")) {
        parsed.line1 = component.long_name;
      } else if (types.includes("route")) {
        parsed.line1 = parsed.line1
          ? `${parsed.line1} ${component.long_name}`
          : component.long_name;
      } else if (types.includes("subpremise")) {
        parsed.line2 = component.long_name;
      } else if (
        types.includes("locality") ||
        types.includes("administrative_area_level_2")
      ) {
        parsed.city = component.long_name;
      } else if (types.includes("administrative_area_level_1")) {
        parsed.state = component.short_name; // Use short name for state (e.g., "TX" instead of "Texas")
      } else if (types.includes("postal_code")) {
        parsed.zip = component.long_name;
      } else if (types.includes("country")) {
        parsed.country = component.long_name;
      }
    }
    return parsed;
  } catch (error) {
    // Fallback to simple parsing
    return parseAddressSimple(addressString);
  }
}

/**
 * Simple address parsing fallback (comma-separated).
 * Used when Google API is not available or configured.
 *
 * @param addressString - Address string (e.g., "123 Main St, Austin, TX, 78701")
 * @returns Parsed address components
 */
export function parseAddressSimple(addressString: string): ParsedAddress {
  if (!addressString || addressString.trim() === "") {
    return {};
  }

  // Split by comma and trim each part
  const parts = addressString
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return {};
  }

  // Try to intelligently assign parts based on count
  const parsed: ParsedAddress = {};

  if (parts.length === 1) {
    // Just one part - could be anything, use as line1
    parsed.line1 = parts[0];
  } else if (parts.length === 2) {
    // Two parts: likely "street, city" or "city, state"
    parsed.line1 = parts[0];
    parsed.city = parts[1];
  } else if (parts.length === 3) {
    // Three parts: "street, city, state" or "city, state, country"
    parsed.line1 = parts[0];
    parsed.city = parts[1];
    parsed.state = parts[2];
  } else if (parts.length >= 4) {
    // Four+ parts: "street, city, state, zip" or "street, city, state, country"
    parsed.line1 = parts[0];
    parsed.city = parts[1];
    parsed.state = parts[2];

    // Check if last part looks like a zip code (digits or digits with dash)
    const lastPart = parts[parts.length - 1];
    if (/^\d{5}(-\d{4})?$/.test(lastPart)) {
      parsed.zip = lastPart;
      // If we have 5 parts, part[3] might be country
      if (parts.length === 5) {
        parsed.country = parts[3];
      }
    } else {
      // Last part is probably country
      parsed.country = lastPart;
      // Part before country might be zip
      if (parts.length >= 4 && /^\d/.test(parts[parts.length - 2])) {
        parsed.zip = parts[parts.length - 2];
      }
    }
  }

  return parsed;
}

/**
 * Format address components back to a string
 */
export function formatAddress(address: ParsedAddress): string {
  const parts = [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.zip,
    address.country,
  ].filter(Boolean);

  return parts.join(", ");
}

/**
 * Geocode structured address components to get coordinates and formatted address.
 * Useful when you have address fields from a CRM (line1, city, state, zip).
 *
 * @param addressComponents - Structured address components
 * @returns Formatted address and coordinates
 */
export async function geocodeStructuredAddress(addressComponents: {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}): Promise<GeocodingResult | null> {
  // Build address string from components
  const addressString = formatAddress(addressComponents);

  if (!addressString || addressString.trim() === "") {
    return null;
  }

  // Use Google Geocoding API to get coordinates and formatted address
  const result = await parseAddressWithGeocoding(addressString);

  if (result) {
    return {
      ...addressComponents, // Keep original components
      formattedAddress: result.formattedAddress || addressString,
      latitude: result.latitude,
      longitude: result.longitude,
    };
  }

  // Fallback: return components with formatted address but no coordinates
  return {
    ...addressComponents,
    formattedAddress: addressString,
  };
}

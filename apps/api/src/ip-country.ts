import { createRequire } from 'node:module'

/** Country of a client IP (ISO 3166-1 alpha-2) or null when unknown. Country only; never stored as an IP. */
export interface IpCountryResolver {
  countryOf(ip: string): string | null
}

/**
 * Offline lookup with geoip-country (bundled MaxMind GeoLite2 country data, refreshed by package updates; see
 * docs/DEPENDENCIES.md). No IP leaves the server.
 */
export class GeoipCountryResolver implements IpCountryResolver {
  private readonly geoip = createRequire(import.meta.url)('geoip-country') as { lookup(ip: string): { country?: string } | null }

  countryOf(ip: string): string | null {
    const country = this.geoip.lookup(ip)?.country
    return country && /^[A-Z]{2}$/.test(country) ? country : null
  }
}

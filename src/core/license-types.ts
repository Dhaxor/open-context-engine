/** License token payload — the ONLY shape shared between the offline verifier
 *  (src/core/license.ts, shipped to users) and the server-side issuer
 *  (src/server/license-activate.ts, runs on the Worker). Kept in its own
 *  module so the issuer doesn't depend on the fs/os/path-touching verifier. */

export type Plan = "community" | "team" | "enterprise";

export interface LicensePayload {
  /** Unique license id (for revocation lists). */
  id: string;
  /** Organization the license is issued to. */
  org: string;
  email?: string;
  /** SSO-lite: bind activation to an email domain (e.g. "acme.com"). */
  orgDomain?: string;
  plan: Exclude<Plan, "community">;
  /** Seats purchased. Offline enforcement is honor-based; the control plane can audit. */
  seats: number;
  /** Optional explicit feature grants beyond the plan default. */
  features?: string[];
  /** Issued-at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. 0 = perpetual. */
  exp: number;
}

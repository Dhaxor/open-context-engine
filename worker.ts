/**
 * Cloudflare Worker entry — serves the marketing site (static assets) and the
 * license-activation API. All logic lives in src/server/license-activate.ts
 * (unit-tested there); this file only wires the Worker runtime.
 */
import { handleRequest } from "./src/server/license-activate";

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  POLAR_ACCESS_TOKEN?: string;
  LICENSE_SIGNING_KEY?: string;
  POLAR_API?: string;
  POLAR_TEAM_BENEFIT_ID?: string;
  POLAR_ENTERPRISE_BENEFIT_ID?: string;
  DEFAULT_SEATS?: string;
  LICENSE_DAYS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

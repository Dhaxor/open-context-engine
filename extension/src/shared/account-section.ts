import { icon } from "../chat/webview/icons";
import { esc } from "../chat/webview/render";

export const GET_TEAM_URL = "https://opencontextengine.com/pricing.html";

export type LicenseStatus = {
  plan?: string;
  valid?: boolean;
  exp?: number;
  org?: string;
  seats?: number | string;
  inGrace?: boolean;
  daysLeft?: number;
};

export function renderAccountSection(
  bodyEl: HTMLElement,
  license: LicenseStatus | null,
  opts: {
    $: (id: string) => HTMLElement | null;
    post: (m: unknown) => void;
    getTeamUrl?: string;
  },
): void {
  const lic = license || { plan: "free", valid: false };
  const teamUrl = opts.getTeamUrl ?? GET_TEAM_URL;

  if (lic.valid) {
    const exp = lic.exp ? new Date(lic.exp * 1000).toISOString().slice(0, 10) : "perpetual";
    bodyEl.innerHTML =
      `<div class="lic-status">` +
      `<div class="lic-line"><span class="lic-k">Plan</span><b style="text-transform:capitalize">${esc(lic.plan || "free")}</b></div>` +
      (lic.org ? `<div class="lic-line"><span class="lic-k">Org</span>${esc(String(lic.org))}</div>` : "") +
      (lic.seats ? `<div class="lic-line"><span class="lic-k">Seats</span>${esc(String(lic.seats))}</div>` : "") +
      `<div class="lic-line"><span class="lic-k">Expires</span>${esc(exp)}</div>` +
      (lic.inGrace ? `<div class="notice err" style="border:none;padding-left:0">In grace period — ${esc(String(lic.daysLeft))} day(s) left.</div>` : "") +
      `</div><div class="actions"><button class="btn" id="deactivateBtn">Deactivate</button></div>`;
    const btn = opts.$("deactivateBtn");
    if (btn) btn.onclick = () => opts.post({ type: "deactivateLicense" });
  } else {
    bodyEl.innerHTML =
      `<div class="upsell"><div class="up-title">${icon("sparkle")} Open Context Team</div><ul>` +
      `<li>${icon("check")} Multi-repo search across all your repositories</li>` +
      `<li>${icon("check")} Shared team index — index once, everyone benefits</li>` +
      `<li>${icon("check")} Commercial-use license &amp; priority support</li></ul>` +
      `<button class="btn primary block" id="getTeamBtn">Get Team</button>` +
      `<div class="up-note">Your code stays on your machine — license keys verify offline.</div></div>` +
      `<div class="sep"></div><div class="row"><input id="licKey" type="text" placeholder="Paste license key…" /></div>` +
      `<div class="actions"><button class="btn primary" id="activateBtn">Activate</button></div>`;
    const getTeam = opts.$("getTeamBtn");
    if (getTeam) getTeam.onclick = () => opts.post({ type: "openExternal", url: teamUrl });
    const activate = opts.$("activateBtn");
    if (activate) {
      activate.onclick = () => {
        const k = (opts.$("licKey") as HTMLInputElement | null)?.value.trim();
        if (k) opts.post({ type: "activateLicense", key: k });
      };
    }
  }
}

/**
 * True on the laptop page Orvane Host serves (src/host/agents.ts). The host
 * marks that page with <meta name="orvane-host">; desktop-only actions (app
 * snapshots, Open folder, Notes, schedules, settings) hide there.
 */
export const hostMode =
  typeof document !== "undefined" && !!document.querySelector('meta[name="orvane-host"]');

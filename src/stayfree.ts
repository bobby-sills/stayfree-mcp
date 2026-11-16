// Client for StayFree's cross-device sync API (api.stayfreeapps.com).
// There is no public API; these are the calls the official StayFree browser extension makes.
// The connector joins your StayFree device group as its own "device" via the normal pairing-code
// flow, then reads the usage sessions every device in the group has uploaded.

export interface Env {
  STATE: KVNamespace;
  MCP_SECRET: string;
  TIMEZONE?: string;
}

const API = "https://api.stayfreeapps.com";
// The extension identifies itself with this header; the API expects it.
const CLIENT_HEADER = { "Panel-Client": "StayFree Extension" };
// The StayFree Chrome extension's app ID, used when registering this connector as a device.
const EXTENSION_APP_ID = "elfaihghhjjoknimpccccmkioofjjfkf";
const DEVICE_NAME = "Claude connector";

export type Platform = "android" | "ios" | "windows" | "mac" | "linux" | "web";

export interface Session {
  appId: string;
  start: number; // epoch ms
  end: number; // epoch ms
  installId: string;
  platform: Platform;
}

export interface DeviceGroup {
  key: string;
  [k: string]: unknown;
}

export class NotInGroupError extends Error {
  constructor() {
    super("This connector isn't in a StayFree device group. Run connect_device to pair it with your StayFree apps.");
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type RawApps = Record<string, { sessions: { timestamp: number; duration: number; install_id: string }[] }>;
export interface RawSessionsResponse {
  android_apps?: RawApps;
  ios_apps?: RawApps;
  windows_apps?: RawApps;
  mac_apps?: RawApps;
  linux_apps?: RawApps;
  websites?: RawApps;
}

export function flattenSessions(r: RawSessionsResponse): Session[] {
  const out: Session[] = [];
  const add = (apps: RawApps | undefined, platform: Platform) => {
    for (const [appId, v] of Object.entries(apps ?? {}))
      for (const s of v?.sessions ?? [])
        out.push({ appId, start: s.timestamp * 1000, end: (s.timestamp + s.duration) * 1000, installId: s.install_id, platform });
  };
  add(r.android_apps, "android");
  add(r.ios_apps, "ios");
  add(r.windows_apps, "windows");
  add(r.mac_apps, "mac");
  add(r.linux_apps, "linux");
  add(r.websites, "web");
  return out.sort((a, b) => a.start - b.start);
}

function newInstallId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(13));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export class StayFree {
  private env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  get timezone(): string {
    const tz = this.env.TIMEZONE?.trim() || "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      return "UTC";
    }
  }

  private async call<T>(path: string, opts: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, API);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...CLIENT_HEADER, Accept: "application/json" };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { method: opts.method ?? "GET", headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      if (res.status < 500 || (opts.method ?? "GET") !== "GET") break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    if (!res!.ok) {
      const text = (await res!.text().catch(() => "")).slice(0, 300);
      throw new ApiError(res!.status, `StayFree API ${res!.status} on ${url.pathname}${text ? `: ${text}` : ""}`);
    }
    const text = await res!.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---- this connector's identity --------------------------------------------------------

  async installId(): Promise<string> {
    let id = await this.env.STATE.get("install_id");
    if (!id) {
      id = newInstallId();
      await this.env.STATE.put("install_id", id);
    }
    return id;
  }

  /** Register this connector as a device (same as the extension's createDevice: an empty usage upload). */
  async register(): Promise<void> {
    if (await this.env.STATE.get("registered")) return;
    await this.call("/v1/web/upload", {
      method: "POST",
      body: {
        app_id: EXTENSION_APP_ID,
        install_id: await this.installId(),
        time_zone: this.timezone,
        device_name: DEVICE_NAME,
        device_type: "Cloudflare Worker",
        websites: {},
      },
    });
    await this.env.STATE.put("registered", "1");
  }

  // ---- pairing --------------------------------------------------------------------------

  /** Generate a code to type into StayFree (Manage Devices → Connect Device → Enter a Code). */
  async createPairingCode(): Promise<{ code: string; expires: string }> {
    await this.register().catch(() => {});
    const r = await this.call<{ code: string; expiration: number }>("/v1/sync/pairing/generate", {
      method: "POST",
      query: { install_id: await this.installId() },
    });
    return { code: r.code, expires: new Date(r.expiration * 1000).toISOString() };
  }

  /** Join a device group with a code shown by one of your StayFree apps. */
  async enterPairingCode(code: string): Promise<void> {
    await this.register().catch(() => {});
    try {
      await this.call("/v1/sync/pairing/validate", { method: "POST", query: { install_id: await this.installId(), code } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) throw new Error("StayFree says that code is invalid or expired. Generate a new one and try again.");
      if (e instanceof ApiError && e.status === 403) throw new Error("StayFree says both devices already belong to a device group. Run disconnect first if this connector was paired to a different group.");
      throw e;
    }
    await this.env.STATE.delete("group");
  }

  /** The device group this connector belongs to (cached in KV), or undefined. */
  async group(refresh = false): Promise<DeviceGroup | undefined> {
    if (!refresh) {
      const cached = await this.env.STATE.get<DeviceGroup>("group", "json");
      if (cached?.key) return cached;
    }
    let g: DeviceGroup | undefined;
    try {
      g = await this.call<DeviceGroup>("/v1/sync/pairing/check", { query: { install_id: await this.installId() } });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) g = undefined;
      else throw e;
    }
    if (g?.key) await this.env.STATE.put("group", JSON.stringify(g));
    else await this.env.STATE.delete("group");
    return g?.key ? g : undefined;
  }

  private async groupKey(): Promise<string> {
    const g = await this.group();
    if (!g) throw new NotInGroupError();
    return g.key;
  }

  private async inGroup<T>(fn: (key: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.groupKey());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        await this.env.STATE.delete("group");
        throw new NotInGroupError();
      }
      throw e;
    }
  }

  async disconnect(): Promise<boolean> {
    const g = await this.group(true);
    if (!g) return false;
    await this.call("/v1/sync/devices/remove", { method: "POST", query: { key: g.key, install_id: await this.installId() } });
    await this.env.STATE.delete("group");
    return true;
  }

  // ---- data -----------------------------------------------------------------------------

  async devices(): Promise<any[]> {
    return this.inGroup((key) => this.call<any[]>("/v1/sync/devices", { query: { key } }));
  }

  async config(): Promise<unknown> {
    return this.inGroup((key) => this.call("/v1/sync/config", { query: { key } }));
  }

  /** All sessions uploaded by every device in the group between two instants. Fetched in 7-day chunks. */
  async sessions(startMs: number, endMs: number): Promise<Session[]> {
    const install = await this.installId();
    return this.inGroup(async (key) => {
      const WEEK = 7 * 864e5;
      const chunks: [number, number][] = [];
      for (let s = startMs; s < endMs; s += WEEK) chunks.push([s, Math.min(s + WEEK, endMs)]);
      const parts = await Promise.all(
        chunks.map(([s, e]) =>
          this.call<RawSessionsResponse>("/v1/sync/devices/sessions", {
            query: { key, install_id: install, start_time: new Date(s).toISOString(), end_time: new Date(e).toISOString() },
          })
        )
      );
      const seen = new Set<string>();
      const all: Session[] = [];
      for (const p of parts)
        for (const s of flattenSessions(p ?? {})) {
          const id = `${s.platform}|${s.appId}|${s.installId}|${s.start}`;
          if (!seen.has(id)) {
            seen.add(id);
            all.push(s);
          }
        }
      return all.sort((a, b) => a.start - b.start);
    });
  }

  /** Display names for Android package IDs, e.g. com.google.android.youtube → YouTube. Cached in KV. */
  async appNames(appIds: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const cached = (await this.env.STATE.get<Record<string, string>>("app_names", "json")) ?? {};
    const missing = appIds.filter((id) => !(id in cached));
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      try {
        const info = await this.call<{ app_id: string; display_name?: string }[]>("/v1/android/apps", { query: { app_ids: batch.join(",") } });
        for (const a of info ?? []) if (a?.app_id && a.display_name) cached[a.app_id] = a.display_name;
        for (const id of batch) if (!(id in cached)) cached[id] = "";
      } catch {
        /* names are a nicety */
      }
    }
    if (missing.length) await this.env.STATE.put("app_names", JSON.stringify(cached), { expirationTtl: 30 * 86400 });
    for (const id of appIds) if (cached[id]) out[id] = cached[id];
    return out;
  }
}

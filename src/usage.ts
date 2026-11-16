// Pure helpers: time zones and usage aggregation. No network access, so they're easy to test.
import type { Session, Platform } from "./stayfree";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---- time zones ---------------------------------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string) {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday,
  };
}

/** Offset of tz from UTC at the given instant, in ms (e.g. +7h for Asia/Vientiane). */
function offsetAt(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const [y, m, d] = p.date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant (epoch ms) when the given local date starts in tz. */
export function startOfDay(date: string, tz: string): number {
  if (!DATE_RE.test(date)) throw new Error(`Dates must look like 2026-11-16 (got "${date}")`);
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz); // second pass handles DST changes near midnight
  return t;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function today(tz: string, now = Date.now()): string {
  return localParts(now, tz).date;
}

export function localTime(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.date} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Resolve start/end dates (inclusive, local) into an instant range. */
export function dateRange(tz: string, start?: string, end?: string, now = Date.now()) {
  const t = today(tz, now);
  const s = start || end || t;
  const e = end || (start ? s : t);
  if (e < s) throw new Error("end_date is before start_date");
  const days = Math.round((startOfDay(addDays(e, 1), tz) - startOfDay(s, tz)) / 864e5);
  if (days > 92) throw new Error("Please ask for at most 92 days at a time.");
  return { start: s, end: e, startMs: startOfDay(s, tz), endMs: Math.min(startOfDay(addDays(e, 1), tz), now), days };
}

// ---- intervals ------------------------------------------------------------------------------

type Interval = [number, number];

export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Split an interval at local hour boundaries: yields [ms, date, hour] pieces. */
export function* hourPieces(a: number, b: number, tz: string): Generator<[number, string, number]> {
  let t = a;
  while (t < b) {
    const p = localParts(t, tz);
    const toNextHour = ((59 - p.minute) * 60 + (60 - p.second)) * 1000 - (t % 1000);
    const next = Math.min(b, t + Math.max(toNextHour, 1000));
    yield [next - t, p.date, p.hour];
    t = next;
  }
}

// ---- aggregation ------------------------------------------------------------------------------

export const minutes = (ms: number) => Math.round(ms / 6000) / 10;
export function pretty(ms: number): string {
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
const dur = (ms: number) => ({ minutes: minutes(ms), time: pretty(ms) });

export interface Filters {
  app?: string; // substring of app ID, website, or display name
  platform?: Platform | "apps"; // "apps" = everything except websites
  device?: string; // substring of device name or install ID
}

export interface Ctx {
  tz: string;
  startMs: number;
  endMs: number;
  names: Record<string, string>; // appId → display name
  devices: Record<string, string>; // installId → device name
}

export function clipAndFilter(sessions: Session[], ctx: Ctx, f: Filters = {}): Session[] {
  const app = f.app?.toLowerCase().trim();
  const dev = f.device?.toLowerCase().trim();
  return sessions
    .map((s) => ({ ...s, start: Math.max(s.start, ctx.startMs), end: Math.min(s.end, ctx.endMs) }))
    .filter((s) => s.end > s.start)
    .filter((s) => !f.platform || (f.platform === "apps" ? s.platform !== "web" : s.platform === f.platform))
    .filter((s) => !app || s.appId.toLowerCase().includes(app) || (ctx.names[s.appId] ?? "").toLowerCase().includes(app))
    .filter((s) => !dev || s.installId.toLowerCase().includes(dev) || (ctx.devices[s.installId] ?? "").toLowerCase().includes(dev));
}

function groupBy<T>(list: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of list) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

const label = (s: Session, ctx: Ctx) => ctx.names[s.appId] || s.appId;

/**
 * Overall screen time. Overlapping sessions on the same device count once (e.g. a website and
 * the browser app it was open in), and different devices add up.
 */
export function summarize(sessions: Session[], ctx: Ctx, opts: { top?: number } = {}) {
  const top = opts.top ?? 15;
  const byDevice = groupBy(sessions, (s) => s.installId);
  let total = 0;
  const perDay = new Map<string, number>();
  const perHour = new Array(24).fill(0);
  const devices: any[] = [];
  for (const [installId, list] of byDevice) {
    const merged = mergeIntervals(list.map((s) => [s.start, s.end]));
    let devTotal = 0;
    for (const [a, b] of merged)
      for (const [ms, date, hour] of hourPieces(a, b, ctx.tz)) {
        devTotal += ms;
        perDay.set(date, (perDay.get(date) ?? 0) + ms);
        perHour[hour] += ms;
      }
    total += devTotal;
    const platforms = [...new Set(list.map((s) => s.platform))];
    devices.push({ device: ctx.devices[installId] || installId, install_id: installId, platforms, ...dur(devTotal) });
  }
  devices.sort((a, b) => b.minutes - a.minutes);

  const appRows = (list: Session[]) => {
    const rows = [...groupBy(list, (s) => `${s.platform}|${s.appId}`).values()].map((g) => {
      const byDev = groupBy(g, (s) => s.installId);
      let ms = 0;
      for (const d of byDev.values()) for (const [a, b] of mergeIntervals(d.map((s) => [s.start, s.end]))) ms += b - a;
      return { app: label(g[0], ctx), app_id: g[0].appId, platform: g[0].platform, sessions: g.length, ...dur(ms) };
    });
    return rows.sort((a, b) => b.minutes - a.minutes);
  };
  const apps = appRows(sessions.filter((s) => s.platform !== "web"));
  const sites = appRows(sessions.filter((s) => s.platform === "web"));

  const days = [...perDay.entries()].sort().map(([date, ms]) => ({ date, weekday: localParts(startOfDay(date, ctx.tz) + 12 * 36e5, ctx.tz).weekday, ...dur(ms) }));
  const nDays = Math.max(1, Math.round((ctx.endMs - ctx.startMs) / 864e5));
  return {
    total: dur(total),
    daily_average: nDays > 1 ? dur(total / nDays) : undefined,
    by_device: devices,
    by_day: days.length > 1 ? days : undefined,
    by_hour_of_day: perHour.map((ms, h) => ({ hour: h, minutes: minutes(ms) })).filter((x) => x.minutes > 0),
    top_apps: apps.slice(0, top),
    more_apps: apps.length > top ? apps.length - top : undefined,
    top_websites: sites.slice(0, top),
    more_websites: sites.length > top ? sites.length - top : undefined,
  };
}

/** Detail for the apps/sites matching a filter: per day, per hour, session stats, recent sessions. */
export function appDetail(sessions: Session[], ctx: Ctx, opts: { maxSessions?: number } = {}) {
  const groups = [...groupBy(sessions, (s) => `${s.platform}|${s.appId}`).values()];
  return groups
    .map((g) => {
      const perDay = new Map<string, number>();
      const perHour = new Array(24).fill(0);
      let total = 0;
      for (const d of groupBy(g, (s) => s.installId).values())
        for (const [a, b] of mergeIntervals(d.map((s) => [s.start, s.end])))
          for (const [ms, date, hour] of hourPieces(a, b, ctx.tz)) {
            total += ms;
            perDay.set(date, (perDay.get(date) ?? 0) + ms);
            perHour[hour] += ms;
          }
      const lengths = g.map((s) => s.end - s.start).sort((a, b) => a - b);
      const longest = g.reduce((x, y) => (y.end - y.start > x.end - x.start ? y : x));
      const recent = g.slice(-(opts.maxSessions ?? 20)).reverse();
      return {
        app: label(g[0], ctx),
        app_id: g[0].appId,
        platform: g[0].platform,
        ...dur(total),
        sessions: g.length,
        median_session: pretty(lengths[Math.floor(lengths.length / 2)]),
        longest_session: { started: localTime(longest.start, ctx.tz), ...dur(longest.end - longest.start) },
        first_use: localTime(g[0].start, ctx.tz),
        last_use: localTime(g[g.length - 1].end, ctx.tz),
        by_day: [...perDay.entries()].sort().map(([date, ms]) => ({ date, ...dur(ms) })),
        by_hour_of_day: perHour.map((ms, h) => ({ hour: h, minutes: minutes(ms) })).filter((x) => x.minutes > 0),
        recent_sessions: recent.map((s) => ({ start: localTime(s.start, ctx.tz), minutes: minutes(s.end - s.start), device: ctx.devices[s.installId] || s.installId })),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);
}

/** A chronological timeline of sessions (merging back-to-back sessions of the same app). */
export function timeline(sessions: Session[], ctx: Ctx, opts: { minMinutes?: number; limit?: number } = {}) {
  const min = (opts.minMinutes ?? 1) * 60000;
  const merged: Session[] = [];
  for (const s of [...sessions].sort((a, b) => a.start - b.start)) {
    const prev = [...merged].reverse().find((m) => m.appId === s.appId && m.installId === s.installId);
    if (prev && s.start - prev.end <= 60000) prev.end = Math.max(prev.end, s.end);
    else merged.push({ ...s });
  }
  const rows = merged.filter((s) => s.end - s.start >= min);
  const limit = opts.limit ?? 200;
  return {
    sessions: rows.slice(0, limit).map((s) => ({
      start: localTime(s.start, ctx.tz),
      end: localTime(s.end, ctx.tz).slice(11),
      app: label(s, ctx),
      platform: s.platform,
      device: ctx.devices[s.installId] || s.installId,
      minutes: minutes(s.end - s.start),
    })),
    truncated: rows.length > limit ? rows.length - limit : undefined,
    hidden_short_sessions: merged.length - rows.length || undefined,
  };
}

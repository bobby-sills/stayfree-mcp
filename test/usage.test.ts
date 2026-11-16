// Run with: npm test   (node --experimental-strip-types)
import assert from "node:assert/strict";
import { flattenSessions } from "../src/stayfree.ts";
import { appDetail, clipAndFilter, dateRange, mergeIntervals, startOfDay, summarize, timeline, type Ctx } from "../src/usage.ts";

const TZ = "Asia/Vientiane"; // UTC+7, no DST
const at = (local: string) => Date.parse(local + "+07:00");
const ts = (local: string) => at(local) / 1000;

// Response shape used by GET /v1/sync/devices/sessions (timestamps and durations in seconds).
const raw = {
  android_apps: {
    "com.google.android.youtube": {
      sessions: [
        { timestamp: ts("2026-11-15T23:30:00"), duration: 3600, install_id: "phone" }, // crosses midnight
        { timestamp: ts("2026-11-16T08:00:00"), duration: 600, install_id: "phone" },
      ],
    },
    "com.instagram.android": {
      sessions: [{ timestamp: ts("2026-11-16T08:05:00"), duration: 600, install_id: "phone" }], // overlaps YouTube by 5 min
    },
  },
  websites: {
    "reddit.com": { sessions: [{ timestamp: ts("2026-11-16T20:00:00"), duration: 1800, install_id: "chrome" }] },
  },
  windows_apps: {},
};

const sessions = flattenSessions(raw);
assert.equal(sessions.length, 4);
assert.equal(sessions[0].platform, "android");
assert.equal(sessions[3].platform, "web");
assert.equal(sessions[0].end - sessions[0].start, 3600_000);

// Time zone helpers
assert.equal(startOfDay("2026-11-16", TZ), Date.parse("2026-11-15T17:00:00Z"));
assert.equal(startOfDay("2026-03-08", "America/New_York"), Date.parse("2026-03-08T05:00:00Z")); // DST day starts at EST midnight
assert.equal(startOfDay("2026-03-09", "America/New_York"), Date.parse("2026-03-09T04:00:00Z")); // next day in EDT
const now = at("2026-11-16T22:00:00");
const r = dateRange(TZ, undefined, undefined, now);
assert.equal(r.start, "2026-11-16");
assert.equal(r.endMs, now); // capped at now
assert.equal(dateRange(TZ, "2026-11-10", "2026-11-16", now).days, 7);
assert.throws(() => dateRange(TZ, "2026-11-16", "2026-11-10", now));
assert.throws(() => dateRange(TZ, "2026-01-01", "2026-11-16", now));

assert.deepEqual(mergeIntervals([[5, 10], [0, 3], [2, 6], [20, 25]]), [[0, 10], [20, 25]]);

// One day (16th): midnight-crossing YouTube session is clipped to 30 min.
const ctx: Ctx = { tz: TZ, startMs: r.startMs, endMs: r.endMs, names: { "com.google.android.youtube": "YouTube" }, devices: { phone: "Pixel", chrome: "Chrome" } };
const day = clipAndFilter(sessions, ctx);
const s = summarize(day, ctx);
// phone: 00:00–00:30 (30) + 08:00–08:15 merged (15) = 45; chrome: 30 → 75 total
assert.equal(s.total.minutes, 75);
assert.equal(s.total.time, "1h 15m");
assert.equal(s.by_device[0].device, "Pixel");
assert.equal(s.by_device[0].minutes, 45);
assert.equal(s.top_apps[0].app, "YouTube");
assert.equal(s.top_apps[0].minutes, 40); // 30 + 10
assert.equal(s.top_apps[1].app, "com.instagram.android"); // no name known → package ID
assert.equal(s.top_websites[0].app, "reddit.com");
const hours = Object.fromEntries(s.by_hour_of_day.map((h) => [h.hour, h.minutes]));
assert.deepEqual(hours, { 0: 30, 8: 15, 20: 30 });

// Filters
assert.equal(clipAndFilter(sessions, ctx, { app: "youtube" }).length, 2);
assert.equal(clipAndFilter(sessions, ctx, { platform: "web" }).length, 1);
assert.equal(clipAndFilter(sessions, ctx, { platform: "apps" }).length, 3);
assert.equal(clipAndFilter(sessions, ctx, { device: "pixel" }).length, 3);

// Two days: midnight session split across days
const r2 = dateRange(TZ, "2026-11-15", "2026-11-16", now);
const ctx2 = { ...ctx, startMs: r2.startMs, endMs: r2.endMs };
const two = summarize(clipAndFilter(sessions, ctx2), ctx2);
assert.equal(two.total.minutes, 105);
assert.deepEqual(two.by_day?.map((d) => [d.date, d.minutes, d.weekday]), [["2026-11-15", 30, "Sun"], ["2026-11-16", 75, "Mon"]]);
assert.equal(two.daily_average?.minutes, 52.5);

const yt = appDetail(clipAndFilter(sessions, ctx2, { app: "youtube" }), ctx2);
assert.equal(yt.length, 1);
assert.equal(yt[0].minutes, 70);
assert.equal(yt[0].longest_session.started, "2026-11-15 23:30");
assert.deepEqual(yt[0].by_day.map((d) => d.minutes), [30, 40]);

const tl = timeline(day, ctx);
assert.deepEqual(tl.sessions.map((x) => [x.start, x.end, x.app]), [
  ["2026-11-16 00:00", "00:30", "YouTube"],
  ["2026-11-16 08:00", "08:10", "YouTube"],
  ["2026-11-16 08:05", "08:15", "com.instagram.android"],
  ["2026-11-16 20:00", "20:30", "reddit.com"],
]);

console.log("all tests passed");

// StayFree screen time MCP server for Cloudflare Workers, built on the official MCP TypeScript SDK.
// Stateless Streamable HTTP: each request gets a fresh server + transport.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { StayFree, Env, NotInGroupError, Session } from "./stayfree";
import { Ctx, Filters, appDetail, clipAndFilter, dateRange, summarize, timeline, today } from "./usage";

const READ = { readOnlyHint: true, openWorldHint: true };
type Args = Record<string, any>;
interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: Record<string, boolean>;
  run: (sf: StayFree, a: Args) => Promise<unknown>;
}

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const rangeArgs = {
  start_date: dateArg.optional().describe("First day, YYYY-MM-DD, in the user's time zone. Defaults to today."),
  end_date: dateArg.optional().describe("Last day (inclusive), YYYY-MM-DD. Defaults to start_date, or today if neither is given. Max 92 days."),
};
const filterArgs = {
  app: z.string().optional().describe("Only apps/websites whose name, package ID or domain contains this text, e.g. 'youtube', 'instagram', 'reddit.com'"),
  platform: z.enum(["android", "ios", "windows", "mac", "linux", "web", "apps"]).optional().describe("Only this platform. 'web' = websites tracked by the browser extension; 'apps' = everything except websites"),
  device: z.string().optional().describe("Only this device (name or install ID from list_devices)"),
};

function deviceName(d: any): string {
  return String(d?.name || d?.device_name || d?.device_type || d?.install_id || "device");
}

/** Fetch sessions for a range and the lookup tables needed to label them. */
async function load(sf: StayFree, a: Args) {
  const tz = sf.timezone;
  const range = dateRange(tz, a.start_date, a.end_date);
  const [raw, devs] = await Promise.all([sf.sessions(range.startMs, range.endMs), sf.devices().catch(() => [] as any[])]);
  const devices: Record<string, string> = {};
  for (const d of devs ?? []) if (d?.install_id) devices[d.install_id] = deviceName(d);
  const androidIds = [...new Set(raw.filter((s) => s.platform === "android").map((s) => s.appId))];
  const names = await sf.appNames(androidIds);
  const ctx: Ctx = { tz, startMs: range.startMs, endMs: range.endMs, names, devices };
  const sessions: Session[] = clipAndFilter(raw, ctx, a as Filters);
  const filters = Object.fromEntries(Object.entries({ app: a.app, platform: a.platform, device: a.device }).filter(([, v]) => v));
  return { tz, range, ctx, sessions, filters: Object.keys(filters).length ? filters : undefined };
}

const TOOLS: Tool[] = [
  {
    name: "get_status",
    title: "Connection status",
    description:
      "Check whether this connector is paired with the user's StayFree device group, and list the linked devices. Run this first if anything fails, and after the user enters a pairing code from connect_device.",
    inputSchema: {},
    annotations: READ,
    async run(sf) {
      const group = await sf.group(true);
      const base = { timezone: sf.timezone, today: today(sf.timezone), connector_install_id: await sf.installId() };
      if (!group) return { ...base, paired: false, next_step: "Not paired yet. Run connect_device to get a pairing code (or pass a code shown by a StayFree app)." };
      const devs = await sf.devices();
      return { ...base, paired: true, devices: devs.map((d) => ({ name: deviceName(d), ...d })) };
    },
  },
  {
    name: "connect_device",
    title: "Pair with StayFree",
    description:
      "Link this connector to the user's StayFree apps so it can read their screen time. Without a code: returns a code the user types into StayFree (browser extension: Dashboard → Manage Devices → Connect Device → Enter a Code; or the phone app's cross-platform / connect device screen); then call get_status to confirm. With a code: joins using a code that one of the user's StayFree apps is showing.",
    inputSchema: { code: z.string().optional().describe("A pairing code currently shown by one of the user's StayFree apps. Leave empty to generate a code instead.") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async run(sf, a) {
      if (a.code) {
        await sf.enterPairingCode(String(a.code).replace(/\s+/g, ""));
        const g = await sf.group(true);
        return g ? { paired: true, devices: (await sf.devices()).map(deviceName) } : { paired: false, note: "Code accepted, but StayFree hasn't confirmed the group yet. Try get_status in a few seconds." };
      }
      const existing = await sf.group(true);
      const { code, expires } = await sf.createPairingCode();
      return {
        code,
        expires,
        already_paired: existing ? true : undefined,
        instructions:
          "In the StayFree browser extension open Dashboard → Manage Devices → Connect Device → Enter a Code, and type this code (or use 'Enter a code' in the StayFree phone app). Then ask Claude to check the connection.",
      };
    },
  },
  {
    name: "disconnect",
    title: "Unpair from StayFree",
    description: "Remove this connector from the user's StayFree device group. Only use when the user asks to disconnect or re-pair.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async run(sf) {
      return { removed: await sf.disconnect() };
    },
  },
  {
    name: "list_devices",
    title: "List devices",
    description: "Devices in the user's StayFree group (phone, browsers, computers), with their names and install IDs.",
    inputSchema: {},
    annotations: READ,
    async run(sf) {
      return (await sf.devices()).map((d) => ({ name: deviceName(d), ...d }));
    },
  },
  {
    name: "get_screen_time",
    title: "Screen time summary",
    description:
      "Screen time for a day or date range across all linked devices: total, daily average, per device, per day, per hour of day, top apps and top websites. Overlapping sessions on one device are counted once. Use for 'how much screen time did I have today/this week?', 'what did I use most?', comparisons between weeks (call twice).",
    inputSchema: {
      ...rangeArgs,
      ...filterArgs,
      top: z.number().int().min(1).max(100).default(15).describe("How many top apps and websites to list"),
    },
    annotations: READ,
    async run(sf, a) {
      const { tz, range, ctx, sessions, filters } = await load(sf, a);
      return {
        timezone: tz,
        start_date: range.start,
        end_date: range.end,
        days: range.days,
        filters,
        ...summarize(sessions, ctx, { top: a.top }),
        note: sessions.length ? undefined : "No usage found. If this is unexpected, check get_status and that the phone app has synced recently.",
      };
    },
  },
  {
    name: "get_app_usage",
    title: "Usage of one app or site",
    description:
      "Detailed usage of the apps/websites matching `app`: total, number of sessions, median and longest session, first and last use, time per day and per hour of day, and the most recent sessions. Use for 'how much YouTube this week?', 'when do I usually open Instagram?'.",
    inputSchema: {
      app: z.string().describe("Text to match against app names, package IDs and website domains, e.g. 'youtube'"),
      ...rangeArgs,
      platform: filterArgs.platform,
      device: filterArgs.device,
      recent_sessions: z.number().int().min(0).max(100).default(15),
    },
    annotations: READ,
    async run(sf, a) {
      const { tz, range, ctx, sessions } = await load(sf, a);
      const matches = appDetail(sessions, ctx, { maxSessions: a.recent_sessions });
      return { timezone: tz, start_date: range.start, end_date: range.end, query: a.app, matches, note: matches.length ? undefined : `Nothing matching "${a.app}" in this period.` };
    },
  },
  {
    name: "get_timeline",
    title: "Session timeline",
    description:
      "Chronological list of what was used and when (start, end, app, device), merging back-to-back sessions of the same app. Best for a single day: 'what was I doing on my phone last night?', 'what did I do between 9 and 11?'.",
    inputSchema: {
      date: dateArg.optional().describe("Day to show, YYYY-MM-DD. Defaults to today."),
      ...filterArgs,
      min_minutes: z.number().min(0).default(1).describe("Hide sessions shorter than this"),
      limit: z.number().int().min(1).max(500).default(200),
    },
    annotations: READ,
    async run(sf, a) {
      const { tz, range, ctx, sessions, filters } = await load(sf, { ...a, start_date: a.date, end_date: a.date });
      return { timezone: tz, date: range.start, filters, ...timeline(sessions, ctx, { minMinutes: a.min_minutes, limit: a.limit }) };
    },
  },
  {
    name: "get_limits_and_settings",
    title: "Limits and settings",
    description: "The user's synced StayFree settings: usage limits, blocked keywords, categories, ignore list, and daily reset time (raw data from StayFree).",
    inputSchema: {},
    annotations: READ,
    async run(sf) {
      return await sf.config();
    },
  },
];

function buildServer(sf: StayFree): McpServer {
  const server = new McpServer(
    { name: "stayfree", title: "StayFree", version: "1.0.0" },
    {
      instructions:
        "Tools for the user's StayFree screen time data, synced from their phone, browsers and computers. Dates are in the user's time zone (get_status reports it). Start with get_screen_time; use get_app_usage for one app and get_timeline for what happened on a day. If a tool says the connector isn't paired, run connect_device and walk the user through entering the code.",
    }
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: Args) => {
        try {
          const data = await tool.run(sf, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 1) }] };
        } catch (e) {
          const text = e instanceof NotInGroupError ? e.message : `Error: ${(e as Error)?.message ?? e}`;
          return { isError: true, content: [{ type: "text" as const, text }] };
        }
      }
    );
  }
  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.MCP_SECRET || env.MCP_SECRET.length < 16 || /CHANGE_ME|long-random-string/i.test(env.MCP_SECRET)) {
      return new Response("Set the MCP_SECRET secret to your own random string (at least 16 characters) first.", { status: 500 });
    }
    if (url.pathname !== `/mcp/${env.MCP_SECRET}`) return new Response("Not found", { status: 404 });
    if (!env.STATE) return new Response("The STATE KV namespace binding is missing. Redeploy with the default storage setting.", { status: 500 });

    const server = buildServer(new StayFree(env));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

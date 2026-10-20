// The development dashboard's page: one self-contained HTML document with no
// external assets. It polls the dashboard's JSON API and renders everything
// with `textContent`, never as HTML, so application data cannot inject markup.

/** The page's styles. */
const styles = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --bg: #fafafa; --panel: #ffffff; --line: #e3e3e6; --ok: #1a7f37; --warn: #9a6700; --bad: #c62828; --accent: #2457c5; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #9a9aa0; --bg: #151517; --panel: #1e1e21; --line: #33333a; --ok: #4ac26b; --warn: #d4a72c; --bad: #ff6b6b; --accent: #7aa2ff; } }
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg); }
header { display: flex; gap: 16px; align-items: baseline; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; }
header h1 { font-size: 15px; margin: 0; }
#banner { padding: 10px 20px; display: none; font-weight: 600; }
#banner.stale { display: block; background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
#banner.down { display: block; background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
main { display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 16px; padding: 16px 20px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow: auto; max-height: 460px; }
section.wide { grid-column: 1 / -1; }
h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.muted { color: var(--muted); }
.ok { color: var(--ok); } .warn { color: var(--warn); } .bad { color: var(--bad); }
button.link { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; }
.footnote { padding: 0 20px 16px; }
input { font: inherit; padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--fg); }
`;

/** The page's script. */
const script = `
const api = path => fetch("/_holqa/dashboard/api/" + path, { cache: "no-store" }).then(response => response.ok ? response.json() : undefined).catch(() => undefined);
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
const time = iso => typeof iso === "string" ? iso.slice(11, 19) : "";
function table(target, headers, rows) {
  const box = document.getElementById(target);
  box.replaceChildren();
  if (rows.length === 0) { box.append(el("p", "Nothing yet.", "muted")); return; }
  const tableNode = el("table");
  const head = el("tr");
  for (const header of headers) head.append(el("th", header));
  tableNode.append(head);
  for (const row of rows) {
    const line = el("tr");
    for (const cell of row) {
      const td = el("td");
      if (cell instanceof Node) td.append(cell); else if (cell && typeof cell === "object") { td.textContent = cell.text; td.className = cell.className || ""; } else td.textContent = cell === undefined ? "" : String(cell);
      line.append(td);
    }
    tableNode.append(line);
  }
  box.append(tableNode);
}
let handlerFilter = "";
document.getElementById("filter").addEventListener("input", event => { handlerFilter = event.target.value.trim(); });
async function showTrace(traceId) {
  const result = await api("traces/" + encodeURIComponent(traceId));
  const spans = result ? result.spans : [];
  document.getElementById("trace-title").textContent = "Trace " + traceId;
  const byId = new Map(spans.map(span => [span.spanId, span]));
  const depth = span => { let level = 0; let current = span; while (current && current.parentSpanId && byId.has(current.parentSpanId) && level < 32) { current = byId.get(current.parentSpanId); level += 1; } return level; };
  table("trace", ["Span", "Duration", "Status"], spans.map(span => ["\\u2003".repeat(depth(span)) + span.name, Math.round((span.endTime - span.startTime) * 10) / 10 + " ms", { text: span.status && span.status.code === "error" ? "error" : "ok", className: span.status && span.status.code === "error" ? "bad" : "ok" }]));
}
async function refresh() {
  const [status, state, logs, traces] = await Promise.all([api("status"), api("state"), api("logs"), api("traces")]);
  const banner = document.getElementById("banner");
  if (!status) { banner.className = "down"; banner.textContent = "The dev session does not answer."; return; }
  document.getElementById("generation").textContent = status.serving ? "generation " + status.serving.generation + " · process " + status.serving.pid + " · " + status.serving.swaps + " hot swaps" : "no generation running";
  document.getElementById("mode").textContent = status.hot ? "hot replacement on" : "hot replacement off (restarts)";
  if (status.stale) { banner.className = "stale"; banner.textContent = "STALE: the running code is from before changes to " + status.stale.files.join(", ") + " (since " + time(status.stale.since) + "). " + (status.stale.diagnostics[0] ? status.stale.diagnostics.map(d => d.code + ": " + d.message).join(" ") : ""); }
  else if (!status.serving) { banner.className = "down"; banner.textContent = "No generation is running; see the holqa dev output."; }
  else { banner.className = ""; banner.textContent = ""; }
  const versions = new Map(((status.serving && status.serving.versions) || []).map(version => [version.handlerId, version]));
  const summary = status.summary || { handlers: [], resources: [] };
  table("handlers", ["Handler", "Trigger", "Source", "Version", "Running", "Retiring"], summary.handlers.map(handler => {
    const version = versions.get(handler.id);
    return [handler.id, handler.endpoint || handler.trigger + " \\u2190 " + handler.resourceId, { text: handler.source, className: "mono" }, version ? "v" + version.version : "v1", version ? version.active : "", version ? version.retiring.map(old => "v" + old.version + " (" + old.active + ")").join(", ") : ""];
  }));
  table("resources", ["Kind", "Resource", "Settings"], summary.resources.map(resource => [resource.kind, resource.id, resource.details]));
  table("reloads", ["Time", "Files", "Outcome", "How", "Duration"], status.reloads.slice().reverse().map(reload => [time(reload.at), reload.files.join(", ") || "\\u2014", { text: reload.outcome + (reload.version ? " v" + reload.version : ""), className: reload.outcome === "failed" ? "bad" : "ok" }, reload.plan ? (reload.plan.strategy === "swap" ? "swap " + reload.plan.handlers.length + " handlers" : "restart: " + reload.plan.reason) : "", reload.durationMs + " ms"]));
  const queues = state ? state.queues : [];
  table("queues", ["Queue", "Ready", "Delayed", "In flight", "Done", "Dead-lettered", "Latest failure"], queues.map(queue => {
    const failed = queue.messages.filter(message => message.lastError).at(-1);
    return [queue.id, queue.counts.ready, queue.counts.delayed, queue.counts["in-flight"], queue.counts.acknowledged, { text: queue.counts["dead-lettered"], className: queue.counts["dead-lettered"] > 0 ? "bad" : "" }, failed ? failed.lastError.code + ": " + failed.lastError.message : ""];
  }));
  const deadLetters = queues.flatMap(queue => queue.messages.filter(message => message.state === "dead-lettered").map(message => [queue.id, { text: message.messageId, className: "mono" }, message.attempts, message.lastError ? message.lastError.code : ""]));
  table("dead-letters", ["Queue", "Message", "Attempts", "Last error"], deadLetters);
  table("schedules", ["Schedule", "Next run", "Recent runs"], (state ? state.schedules : []).map(schedule => [schedule.id, schedule.nextRun || "never", schedule.runs.slice(0, 5).map(run => time(run.scheduledTime) + " " + run.status + " (" + run.trigger + ")").join(", ")]));
  const entries = (logs ? logs.entries : []).filter(entry => handlerFilter === "" || (entry.handlerId || "").includes(handlerFilter)).slice(-200).reverse();
  table("logs", ["Time", "Level", "Handler", "Message", "Outcome", "Trace", "Caused by"], entries.map(entry => [time(entry.time), { text: entry.level, className: entry.level === "error" ? "bad" : entry.level === "warn" ? "warn" : "muted" }, (entry.handlerId || "runtime") + (entry.handlerVersion ? " v" + entry.handlerVersion : ""), entry.message, entry.outcome ? { text: entry.outcome + (entry.code ? " " + entry.code : ""), className: entry.outcome === "ok" ? "ok" : "bad" } : (entry.code || ""), { text: (entry.correlationId || "").slice(0, 8), className: "mono" }, { text: (entry.causationId || "").slice(0, 8) + (entry.depth ? " depth " + entry.depth : ""), className: "mono" }]));
  table("traces", ["Started", "Trace", "Spans", "Errors", "Duration"], (traces ? traces.traces : []).map(trace => {
    const button = el("button", trace.name, "link");
    button.addEventListener("click", () => showTrace(trace.traceId));
    return [time(new Date(trace.startTime).toISOString()), button, trace.spans, { text: trace.errors, className: trace.errors > 0 ? "bad" : "" }, Math.round(trace.durationMs) + " ms"];
  }));
  const warnings = (status.diagnostics || []);
  table("diagnostics", ["Severity", "Code", "Message"], warnings.map(d => [{ text: d.severity, className: d.severity === "error" ? "bad" : "warn" }, d.code, d.message]));
}
refresh();
setInterval(refresh, 2000);
`;

/**
 * Renders the dashboard page.
 *
 * @param nonce - The content security policy nonce of the inline style and script.
 * @returns The HTML document.
 */
export function dashboardPage(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>holqa dev</title>
<style nonce="${nonce}">${styles}</style>
</head>
<body>
<header><h1>holqa dev</h1><span id="generation" class="muted"></span><span id="mode" class="muted"></span></header>
<div id="banner" role="status"></div>
<main>
<section class="wide"><h2>Handlers</h2><div id="handlers"></div></section>
<section><h2>Resources</h2><div id="resources"></div></section>
<section><h2>Queues</h2><div id="queues"></div></section>
<section><h2>Dead letters</h2><div id="dead-letters"></div></section>
<section><h2>Schedules</h2><div id="schedules"></div></section>
<section><h2>Reloads</h2><div id="reloads"></div></section>
<section><h2>Build diagnostics</h2><div id="diagnostics"></div></section>
<section class="wide"><h2>Logs and invocations <input id="filter" placeholder="filter by handler" aria-label="Filter by handler"></h2><div id="logs"></div></section>
<section><h2>Traces</h2><div id="traces"></div></section>
<section><h2 id="trace-title">Trace</h2><div id="trace"><p class="muted">Select a trace.</p></div></section>
</main>
<p class="muted footnote">A read-only view of the dev session, the local state and the local telemetry store. Message payloads are not shown; use <code>holqa state</code>.</p>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}
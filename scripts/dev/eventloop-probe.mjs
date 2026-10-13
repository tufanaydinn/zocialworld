/**
 * A preload for the game server during a load run (scripts/dev/hall-load.mts) — measures the
 * server's event-loop delay and CPU without changing the server. Loaded with `node --import tsx --import
 * ./scripts/dev/eventloop-probe.mjs src/index.ts`; every 5 s it writes one line to stderr:
 *   [eventloop] {"p50Ms":…,"p99Ms":…,"maxMs":…,"meanMs":…,"cpuMs":…,"rssMb":…}
 * (cpuMs: user + system CPU time in that window). Never use it in production.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

// 1 ms sampling: an idle loop reads about 1 ms (the timer itself); anything above is delay.
const histogram = monitorEventLoopDelay({ resolution: 1 });
histogram.enable();
let cpu = process.cpuUsage();
setInterval(() => {
  const used = process.cpuUsage(cpu);
  cpu = process.cpuUsage();
  const ms = (ns) => Math.round((ns / 1e6) * 100) / 100;
  process.stderr.write(`[eventloop] ${JSON.stringify({ p50Ms: ms(histogram.percentile(50)), p99Ms: ms(histogram.percentile(99)), maxMs: ms(histogram.max), meanMs: ms(histogram.mean), cpuMs: Math.round((used.user + used.system) / 1000), rssMb: Math.round(process.memoryUsage().rss / 1048576) })}\n`);
  histogram.reset();
}, 5000).unref();

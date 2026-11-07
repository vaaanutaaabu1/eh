"use strict";
/* Live CPU % and RAM % of the Railway container (reads the container limits; falls back to the whole machine). */
const fs = require("fs"), os = require("os");
const rd = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch (e) { return null; } };
let last = null;

function cgroupCpuUsec() {
  const v2 = rd("/sys/fs/cgroup/cpu.stat");
  if (v2) { const m = /usage_usec\s+(\d+)/.exec(v2); if (m) return Number(m[1]); }
  const v1 = rd("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  return v1 ? Number(v1) / 1000 : null;
}
function cpuLimitCores() {
  const v2 = rd("/sys/fs/cgroup/cpu.max");
  if (v2) { const [q, p] = v2.split(" "); if (q !== "max" && Number(p)) return Number(q) / Number(p); }
  const q1 = rd("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"), p1 = rd("/sys/fs/cgroup/cpu/cpu.cfs_period_us");
  if (q1 && Number(q1) > 0 && Number(p1)) return Number(q1) / Number(p1);
  return os.cpus().length;
}
function memory() {
  const cur = rd("/sys/fs/cgroup/memory.current") || rd("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  let lim = rd("/sys/fs/cgroup/memory.max") || rd("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  let limit = lim && lim !== "max" && Number(lim) < os.totalmem() * 2 ? Number(lim) : os.totalmem();
  const used = cur ? Number(cur) : os.totalmem() - os.freemem();
  return { used, limit };
}
function sample() {
  const now = Date.now(), usec = cgroupCpuUsec(), pc = process.cpuUsage(), cores = cpuLimitCores();
  let pct = null, procPct = null;
  if (last) {
    const dt = (now - last.t) * 1000;       /* microseconds */
    if (dt > 0) {
      if (usec != null && last.usec != null) pct = (usec - last.usec) / dt / cores * 100;
      procPct = ((pc.user + pc.system) - (last.pc.user + last.pc.system)) / dt / cores * 100;
    }
  }
  last = { t: now, usec, pc };
  if (pct == null) pct = procPct;
  const m = memory(), mu = process.memoryUsage();
  const r1 = (x) => Math.round(x * 10) / 10;
  return { cpuPct: pct == null ? null : r1(Math.max(0, Math.min(100, pct))), cpuCores: r1(cores),
    ramPct: r1(m.used / m.limit * 100), ramUsedMB: Math.round(m.used / 1048576), ramLimitMB: Math.round(m.limit / 1048576),
    appRssMB: Math.round(mu.rss / 1048576), appHeapMB: Math.round(mu.heapUsed / 1048576), uptimeMin: Math.round(process.uptime() / 60) };
}
sample();   /* first reading so the next call has something to compare with */
module.exports = { sample };

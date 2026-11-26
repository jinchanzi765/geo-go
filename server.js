#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// GEO Go 本地服务：只监听本机 127.0.0.1，数据都存在 ./geo-data/
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, ask } from './lib/providers.js';
import { analyze } from './lib/analyze.js';
import { writingRoutes } from './lib/writing.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.GEO_DATA || path.join(process.cwd(), 'geo-data'));
const PORT = +process.env.PORT || 3000;
fs.mkdirSync(path.join(DATA, 'projects'), { recursive: true });

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const CFG = path.join(DATA, 'config.json');
const cfg = () => readJSON(CFG, { providers: {} });
const mask = (k) => (k ? k.slice(0, 5) + '••••' + k.slice(-4) : '');
const pdir = (id) => path.join(DATA, 'projects', id.replace(/[^\w-]/g, ''));
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

// ---------- 问法模板 ----------
function template(p) {
  const c = p.category, b = p.brand;
  return {
    品类推荐: [`${c}推荐？`, `推荐一些${c}？`, `有哪些${c}推荐？`, `${c}推荐哪些好？`, `${c}推荐哪些靠谱？`],
    品牌情绪: [`${b}怎么样？`, `${b}靠谱吗？`, `${b}口碑如何？`, `${b}有什么缺点？`, `${b}值得选吗？`],
    联系方式: [`${b}电话是多少？`, `${b}在哪里？`, `${b}怎么联系？`, `${b}官网是什么？`, `${b}的地址和联系方式？`],
  };
}

// ---------- 跑数 ----------
const jobs = {}; // runId -> {total, done, ok, failed, status, errors}
async function startRun(pid, run) {
  const dir = pdir(pid);
  const project = readJSON(path.join(dir, 'project.json'));
  const conf = cfg().providers;
  const all = [];
  for (const prov of run.providers) for (const [intent, qs] of Object.entries(run.questions || project.questions))
    for (const q of qs) for (let k = 0; k < run.times; k++) all.push({ provider: prov, intent, q, k });
  const file = path.join(dir, 'runs', run.id + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 续跑：已经有结果的跳过（服务重启、电脑休眠后接着跑）
  const prev = loadResults(pid, run.id);
  const have = new Set(prev.map((r) => `${r.provider}|${r.q}|${r.k}`));
  const tasks = all.filter((t) => !have.has(`${t.provider}|${t.q}|${t.k}`));
  const job = (jobs[run.id] = { total: all.length, done: prev.length, ok: prev.filter((r) => r.ok).length, failed: prev.filter((r) => !r.ok).length, status: 'running', errors: {}, resumed: prev.length > 0 });
  let next = 0;
  const conc = Math.max(1, Math.min(8, run.concurrency || 3));
  async function worker() {
    while (next < tasks.length && !job.stop) {
      const t = tasks[next++];
      let rec;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await ask(t.provider, conf[t.provider], t.q);
          rec = { ...t, ok: true, text: r.text, sources: r.sources, usage: r.usage, at: new Date().toISOString() };
          break;
        } catch (e) {
          rec = { ...t, ok: false, error: String(e.message || e), at: new Date().toISOString() };
          if (/Key|ToolNotOpen|Arrearage|InvalidApiKey|AccessDenied|401|403/.test(rec.error)) break; // 配置类错误不重试
          await new Promise((s) => setTimeout(s, 2000 * (attempt + 1)));
        }
      }
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      job.done++; rec.ok ? job.ok++ : (job.failed++, (job.errors[rec.error] = (job.errors[rec.error] || 0) + 1));
    }
  }
  await Promise.all(Array.from({ length: conc }, worker));
  job.status = job.stop ? 'stopped' : 'done';
  const meta = readJSON(path.join(dir, 'runs', run.id + '.json'), run);
  writeJSON(path.join(dir, 'runs', run.id + '.json'), { ...meta, finishedAt: new Date().toISOString(), ok: job.ok, failed: job.failed, stopped: !!job.stop });
}
const loadResults = (pid, rid) => {
  const f = path.join(pdir(pid), 'runs', rid + '.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
function resumeAll() {
  for (const pid of fs.readdirSync(path.join(DATA, 'projects'))) {
    const d = path.join(pdir(pid), 'runs');
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
      const run = readJSON(path.join(d, f));
      if (run && !run.finishedAt) { console.log(`  续跑 ${run.id}`); startRun(pid, run).catch((e) => console.error(e)); }
    }
  }
}

// ---------- HTTP ----------
const send = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(v)); };
const body = (req) => new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } }); });

const routes = {
  'GET /api/config': () => {
    const c = cfg();
    return Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, { name: p.name, keyHint: p.keyHint, model: c.providers[id]?.model || p.defaultModel, key: mask(c.providers[id]?.key), status: c.providers[id]?.status || null }]));
  },
  'POST /api/config': async (req) => {
    const b = await body(req); const c = cfg();
    const cur = (c.providers[b.id] ||= {});
    if (b.key) cur.key = b.key.trim();
    if (b.model) cur.model = b.model.trim();
    writeJSON(CFG, c); return { ok: true };
  },
  'POST /api/config/test': async (req) => {
    const b = await body(req); const c = cfg();
    try {
      const r = await ask(b.id, c.providers[b.id], '今天杭州天气怎么样？');
      c.providers[b.id].status = { ok: true, sources: r.sources.length, at: new Date().toISOString() };
    } catch (e) { c.providers[b.id] = { ...(c.providers[b.id] || {}), status: { ok: false, error: String(e.message), at: new Date().toISOString() } }; }
    writeJSON(CFG, c); return c.providers[b.id].status;
  },
  'GET /api/projects': () => fs.readdirSync(path.join(DATA, 'projects')).map((id) => readJSON(path.join(pdir(id), 'project.json'))).filter(Boolean),
  'POST /api/projects': async (req) => {
    const b = await body(req);
    const p = { id: b.id || uid(), brand: b.brand, aliases: b.aliases || [], category: b.category, site: b.site || '', competitors: b.competitors || [], contacts: b.contacts || [], createdAt: b.createdAt || new Date().toISOString() };
    p.questions = b.questions || template(p);
    writeJSON(path.join(pdir(p.id), 'project.json'), p); return p;
  },
  'POST /api/template': async (req) => template(await body(req)),
  'GET /api/runs': (req, q) => {
    const d = path.join(pdir(q.get('project')), 'runs');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => { const m = readJSON(path.join(d, f)); return { ...m, live: jobs[m.id] || null }; }).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  },
  'POST /api/runs': async (req) => {
    const b = await body(req);
    const project = readJSON(path.join(pdir(b.project), 'project.json'));
    const run = { id: uid(), project: b.project, providers: b.providers, times: Math.max(1, Math.min(50, +b.times || 10)), concurrency: b.concurrency || 3, questions: project.questions, startedAt: new Date().toISOString() };
    writeJSON(path.join(pdir(b.project), 'runs', run.id + '.json'), run);
    startRun(b.project, run).catch((e) => { jobs[run.id] = { ...(jobs[run.id] || {}), status: 'error', fatal: String(e) }; });
    return run;
  },
  'POST /api/run/stop': async (req) => { const b = await body(req); if (jobs[b.id]) jobs[b.id].stop = true; return { ok: true }; },
  'GET /api/run': (req, q) => {
    const pid = q.get('project'), rid = q.get('id');
    const project = readJSON(path.join(pdir(pid), 'project.json'));
    const results = loadResults(pid, rid);
    return { live: jobs[rid] || null, report: analyze(project, results), samples: results.filter((r) => r.ok).slice(-0) };
  },
  'GET /api/answers': (req, q) => {
    const rs = loadResults(q.get('project'), q.get('id'));
    return rs.filter((r) => (!q.get('provider') || r.provider === q.get('provider')) && (!q.get('intent') || r.intent === q.get('intent')));
  },
};
Object.assign(routes, writingRoutes({ DATA, pdir, readJSON, writeJSON, body, loadResults, uid }));

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const h = routes[`${req.method} ${u.pathname}`];
  try {
    if (h) return send(res, 200, await h(req, u.searchParams));
    if (req.method === 'GET') {
      const f = path.join(ROOT, 'public', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(path.join(ROOT, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return fs.createReadStream(f).pipe(res);
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`✓ GEO Go 已启动  http://localhost:${PORT}`);
  console.log(`  数据目录 ${DATA}`);
  resumeAll();
});

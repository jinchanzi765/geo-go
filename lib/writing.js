// SPDX-License-Identifier: AGPL-3.0-only
// 第 5~7 步：写稿（知识库 → 母稿 → 子稿）、发布登记（链接 + 收录）、回查对比
import path from 'node:path';
import fs from 'node:fs';
import { ask } from './providers.js';
import { analyze } from './analyze.js';

export const DEFAULT_PROMPT = `你是一名熟悉{平台}写法的作者。
只根据下面的品牌资料和母稿，写一篇回答「{问题}」的文章。
要求：
1. 第一行写标题，标题里直接带上问题里的关键词
2. 开头先直接回答问题，再展开理由
3. 写清楚具体信息：服务内容、地址、电话、官网
4. 不编造资料里没有的事实，不贬低其他品牌
5. 按{平台}常见的写法和篇幅来写，800 字左右

品牌资料：
{知识库}

母稿：
{母稿}`;

const MASTER_PROMPT = `根据下面的品牌资料，写一篇 1500 字左右的品牌完整介绍（母稿）。
要求：
1. 第一行写标题
2. 分小节写清楚：是谁、做什么、适合谁、怎么做、价格或收费方式、地址和联系方式、常见问题
3. 只用资料里写到的事实，资料里没有的不要写，也不要编数字
4. 语气平实，不用「第一」「最好」这类绝对化说法

品牌资料：
{知识库}`;

export function normUrl(u) {
  try {
    const x = new URL(u);
    const host = x.hostname.toLowerCase().replace(/^(www|m)\./, '');
    return host + x.pathname.replace(/\/+$/, '') + (x.search || '');
  } catch { return String(u || '').trim().toLowerCase(); }
}

export function writingRoutes({ pdir, readJSON, writeJSON, body, loadResults, uid }) {
  const wfile = (pid) => path.join(pdir(pid), 'writing.json');
  const load = (pid) => readJSON(wfile(pid), { kb: '', prompt: DEFAULT_PROMPT, master: null, drafts: [] });
  const save = (pid, w) => writeJSON(wfile(pid), w);
  const project = (pid) => readJSON(path.join(pdir(pid), 'project.json'));
  const runsOf = (pid) => {
    const d = path.join(pdir(pid), 'runs');
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(d, f))).filter(Boolean).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  };
  const fill = (tpl, v) => tpl.replace(/\{(平台|问题|知识库|母稿)\}/g, (_, k) => v[k] ?? '');
  const split = (text) => {
    const lines = text.trim().split('\n');
    const title = (lines[0] || '').replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').replace(/^标题[：:]\s*/, '').trim();
    return { title, text: text.trim() };
  };

  return {
    'GET /api/writing': (req, q) => ({ ...load(q.get('project')), defaultPrompt: DEFAULT_PROMPT }),

    'POST /api/writing': async (req) => {
      const b = await body(req); const w = load(b.project);
      if (b.kb != null) w.kb = b.kb;
      if (b.prompt != null) w.prompt = b.prompt;
      save(b.project, w); return { ok: true };
    },

    // 按某一轮的诊断给出建议待办：各 AI 引用最多的平台 + 联系方式问题
    'GET /api/suggest': (req, q) => {
      const pid = q.get('project'); const p = project(pid);
      const rid = q.get('run') || runsOf(pid).filter((r) => r.finishedAt).pop()?.id;
      if (!rid) return { run: null, items: [] };
      const rep = analyze(p, loadResults(pid, rid));
      const merged = {};
      for (const [prov, r] of Object.entries(rep.providers)) for (const s of r.sources.slice(0, 8)) {
        if (s.own || ['企业信息', '政府'].includes(s.kind)) continue;
        (merged[s.name] ||= { name: s.name, kind: s.kind, score: 0, by: [] });
        merged[s.name].score += s.pct; merged[s.name].by.push(`${prov}:${Math.round(s.pct * 100)}%`);
      }
      const cats = p.questions['品类推荐'] || [];
      const items = Object.values(merged).sort((a, b) => b.score - a.score).slice(0, 6).map((m, i) => ({
        platform: m.name, question: cats[i % Math.max(1, cats.length)] || p.category, intent: '品类推荐',
        why: `AI 引用占比：${m.by.join('、')}（${m.kind}）`,
      }));
      const wrong = Object.values(rep.providers).flatMap((r) => r.contact.wrongPhones);
      const low = Object.entries(rep.providers).filter(([, r]) => r.contact.rate != null && r.contact.rate < 0.8);
      if (wrong.length || low.length) items.push({
        platform: '品牌官网', question: (p.questions['联系方式'] || [])[0] || `${p.brand}怎么联系？`, intent: '联系方式',
        why: [wrong.length ? `AI 给了错误电话 ${[...new Set(wrong.map((w) => w.phone))].join('、')}` : '', low.length ? `联系方式给对率低：${low.map(([k, r]) => `${k} ${Math.round(r.contact.rate * 100)}%`).join('、')}` : ''].filter(Boolean).join('；') + '。在官网写一页清楚的联系方式，给 AI 一个准确来源',
      });
      return { run: rid, items };
    },

    'POST /api/drafts': async (req) => {
      const b = await body(req); const w = load(b.project);
      for (const it of b.items || []) w.drafts.push({ id: uid(), platform: it.platform, question: it.question, intent: it.intent || '', why: it.why || '', title: '', text: '', url: '', indexed: null, createdAt: new Date().toISOString() });
      save(b.project, w); return w.drafts;
    },
    'POST /api/draft/update': async (req) => {
      const b = await body(req); const w = load(b.project);
      const d = w.drafts.find((x) => x.id === b.id); if (!d) throw new Error('稿件不存在');
      for (const k of ['title', 'text', 'url', 'indexed', 'platform', 'question']) if (k in b) d[k] = b[k];
      if ('url' in b) d.publishedAt = b.url ? (d.publishedAt || new Date().toISOString()) : null;
      if ('indexed' in b) d.indexedAt = new Date().toISOString();
      save(b.project, w); return d;
    },
    'POST /api/draft/delete': async (req) => {
      const b = await body(req); const w = load(b.project);
      w.drafts = w.drafts.filter((x) => x.id !== b.id); save(b.project, w); return { ok: true };
    },

    'POST /api/master': async (req) => {
      const b = await body(req); const w = load(b.project);
      if (!w.kb.trim()) throw new Error('先填品牌资料');
      const conf = readJSON(path.join(path.dirname(path.dirname(pdir(b.project))), 'config.json'), { providers: {} }).providers;
      const r = await ask(b.provider, conf[b.provider], fill(MASTER_PROMPT, { 知识库: w.kb }), { search: false });
      w.master = { ...split(r.text), provider: b.provider, at: new Date().toISOString() };
      save(b.project, w); return w.master;
    },
    'POST /api/draft/gen': async (req) => {
      const b = await body(req); const w = load(b.project);
      const d = w.drafts.find((x) => x.id === b.id); if (!d) throw new Error('稿件不存在');
      if (!w.kb.trim()) throw new Error('先填品牌资料');
      const conf = readJSON(path.join(path.dirname(path.dirname(pdir(b.project))), 'config.json'), { providers: {} }).providers;
      const r = await ask(b.provider, conf[b.provider], fill(w.prompt || DEFAULT_PROMPT, { 平台: d.platform, 问题: d.question, 知识库: w.kb, 母稿: w.master?.text || '（没有母稿）' }), { search: false });
      Object.assign(d, split(r.text), { provider: b.provider, genAt: new Date().toISOString() });
      save(b.project, w); return d;
    },

    // 回查：两轮对比 + 每篇已发稿件有没有被引用
    'GET /api/compare': (req, q) => {
      const pid = q.get('project'); const p = project(pid);
      const done = runsOf(pid).filter((r) => r.finishedAt);
      const base = q.get('base') || done[0]?.id, cur = q.get('cur') || done[done.length - 1]?.id;
      if (!base || !cur) return { runs: done, base, cur, rows: [], drafts: [] };
      const A = analyze(p, loadResults(pid, base)), curRes = loadResults(pid, cur), B = analyze(p, curRes);
      const rows = Object.keys(B.providers).map((prov) => {
        const a = A.providers[prov], b2 = B.providers[prov];
        return { provider: prov, base: a ? { rate: a.category.rate, n: a.category.n, ci: a.category.ci, contact: a.contact.rate, wrong: a.contact.wrongPhones.reduce((x, y) => x + y.n, 0) } : null,
          cur: { rate: b2.category.rate, n: b2.category.n, ci: b2.category.ci, contact: b2.contact.rate, wrong: b2.contact.wrongPhones.reduce((x, y) => x + y.n, 0) } };
      });
      const w = load(pid);
      const curRun = done.find((r) => r.id === cur);
      const drafts = w.drafts.map((d) => {
        if (!d.url) return { ...d, state: '未发布' };
        const u = normUrl(d.url);
        const by = {};
        for (const r of curRes) if (r.ok) for (const s of r.sources || []) if (s.cited && normUrl(s.url) === u) by[r.provider] = (by[r.provider] || 0) + 1;
        const after = d.publishedAt && curRun && curRun.startedAt > d.publishedAt;
        const state = !after ? '发布晚于这轮回查' : Object.keys(by).length ? '已被引用' : d.indexed === false ? '未收录' : '已发布未被引用';
        return { ...d, citedBy: by, state };
      });
      return { runs: done, base, cur, rows, drafts };
    },
  };
}

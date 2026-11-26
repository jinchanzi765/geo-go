// SPDX-License-Identifier: AGPL-3.0-only
// 各 AI 平台的联网问答接口。统一返回 { text, sources:[{i,site,title,url,cited}], usage }
const T = 180000;

async function postJSON(url, key, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(T),
  });
  const txt = await r.text();
  let d;
  try { d = JSON.parse(txt); } catch { throw new Error(`HTTP ${r.status}：返回的不是 JSON`); }
  return { ok: r.ok, status: r.status, d };
}

// 千问：阿里云百炼原生接口，开联网 + 返回信源 + 正文标注引用编号
async function qwen({ key, model, q, search = true }) {
  const { ok, status, d } = await postJSON(
    'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', key, {
      model: model || 'qwen-plus',
      input: { messages: [{ role: 'user', content: q }] },
      parameters: search ? {
        result_format: 'message',
        enable_search: true,
        search_options: { forced_search: true, enable_source: true, enable_citation: true, citation_format: '[ref_<number>]' },
      } : { result_format: 'message' },
    });
  if (!ok || d.code) {
    if (d.code === 'Arrearage') throw new Error('Arrearage：百炼账户欠费或免费额度用完，去阿里云充值后再跑');
    throw new Error(`${d.code || status}：${d.message || '请求失败'}`);
  }
  const text = d.output?.choices?.[0]?.message?.content || '';
  const cited = new Set([...text.matchAll(/\[ref_(\d+)\]/g)].map((m) => +m[1]));
  const sources = (d.output?.search_info?.search_results || []).map((s) => ({
    i: s.index, site: s.site_name, title: s.title, url: s.url, cited: cited.has(s.index),
  }));
  return { text: text.replace(/\[ref_\d+\]/g, ''), sources, usage: d.usage };
}

// 豆包：火山方舟 Responses 接口 + web_search 工具（需要先在火山控制台开通「联网内容插件」）
async function doubao({ key, model, q, search = true }) {
  const { ok, status, d } = await postJSON('https://ark.cn-beijing.volces.com/api/v3/responses', key, {
    model: model || 'doubao-seed-2-1-lite-260915',
    input: q,
    ...(search ? { tools: [{ type: 'web_search' }] } : {}),
    ...(String(model || '').startsWith('deepseek') ? {} : { thinking: { type: 'disabled' } }),
  });
  if (!ok || d.error) {
    const c = d.error?.code || status;
    if (c === 'ToolNotOpen') throw new Error('ToolNotOpen：火山账号还没开通联网搜索（联网内容插件）');
    throw new Error(`${c}：${d.error?.message || '请求失败'}`);
  }
  let text = '';
  const sources = [];
  for (const o of d.output || []) {
    if (o.type !== 'message') continue;
    for (const c of o.content || []) {
      text += c.text || '';
      for (const a of c.annotations || []) {
        if (!a.url || sources.some((s) => s.url === a.url)) continue;
        const m = (a.title || '').match(/\s[-–—|_]\s*([^-–—|_]{2,20})\s*$/);
        sources.push({ i: sources.length + 1, site: a.site_name || (m ? m[1].trim() : ''), title: a.title || '', url: a.url, cited: true });
      }
    }
  }
  return { text, sources, usage: d.usage };
}

export const PROVIDERS = {
  qwen: { name: '千问', fn: qwen, defaultModel: 'qwen-plus', keyHint: '阿里云百炼 API Key' },
  doubao: { name: '豆包', fn: doubao, defaultModel: 'doubao-seed-2-1-lite-260915', keyHint: '火山方舟 API Key' },
  // DeepSeek：用火山方舟托管的 DeepSeek 模型 + 火山联网搜索。搜索引擎是火山的，不是 DeepSeek App 自己的，口径和 App 有差别
  deepseek: { name: 'DeepSeek', fn: doubao, defaultModel: 'deepseek-v4-1-flash-261017', keyHint: '火山方舟 API Key（可以和豆包用同一个）' },
};

export async function ask(pid, cfg, q, opts = {}) {
  const p = PROVIDERS[pid];
  if (!p) throw new Error('未知平台 ' + pid);
  if (!cfg?.key) throw new Error(`${p.name}没填 Key`);
  return p.fn({ key: cfg.key, model: cfg.model || p.defaultModel, q, search: opts.search !== false });
}

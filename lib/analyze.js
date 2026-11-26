// SPDX-License-Identifier: AGPL-3.0-only
// 把一轮跑数结果算成诊断：提及率（分端×意图）、竞品、信源表（分端）、联系方式、要不要做

const PLATFORMS = [
  ['mp.weixin.qq.com', '微信公众号', '自媒体'],
  ['zhihu.com', '知乎', '问答'],
  ['baijiahao.baidu.com', '百家号', '资讯'],
  ['baike.baidu.com', '百度百科', '百科'],
  ['zhidao.baidu.com', '百度知道', '问答'],
  ['toutiao.com', '今日头条', '资讯'],
  ['sohu.com', '搜狐', '资讯'],
  ['163.com', '网易', '资讯'],
  ['qq.com', '腾讯网', '资讯'],
  ['ifeng.com', '凤凰网', '资讯'],
  ['sina.com.cn', '新浪', '资讯'],
  ['sina.cn', '新浪', '资讯'],
  ['douyin.com', '抖音', '短视频'],
  ['iesdouyin.com', '抖音', '短视频'],
  ['xiaohongshu.com', '小红书', '笔记'],
  ['bilibili.com', 'B站', '视频'],
  ['csdn.net', 'CSDN', '博客'],
  ['cnblogs.com', '博客园', '博客'],
  ['jianshu.com', '简书', '博客'],
  ['36kr.com', '36氪', '资讯'],
  ['ithome.com', 'IT之家', '资讯'],
  ['tianyancha.com', '天眼查', '企业信息'],
  ['qcc.com', '企查查', '企业信息'],
  ['aiqicha.baidu.com', '爱企查', '企业信息'],
  ['qixin.com', '启信宝', '企业信息'],
  ['gov.cn', '政府网站', '政府'],
];

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const ends = (h, d) => h === d || h.endsWith('.' + d);

export function classify(url, siteName, own) {
  const h = host(url);
  if (own && own.some((d) => d && ends(h, d))) return { name: '品牌官网（你自己的）', kind: '官网', own: true };
  for (const [d, n, k] of PLATFORMS) if (ends(h, d)) return { name: n, kind: k };
  const sn = siteName && siteName !== '无' ? siteName : '';
  return { name: sn || h || '未知', kind: '其他', host: h };
}

// 95% Wilson 区间，用来告诉学员这个提及率有多大误差
export function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, m = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-－—()（）]/g, '');
const hasAny = (text, names) => { const t = norm(text); return names.some((n) => n && t.includes(norm(n))); };

export function analyze(project, results) {
  const brandNames = [project.brand, ...(project.aliases || [])].filter(Boolean);
  const comps = project.competitors || [];
  const own = [host(project.site ? (project.site.startsWith('http') ? project.site : 'https://' + project.site) : '')].filter(Boolean);
  const contactTokens = (project.contacts || []).filter(Boolean);

  const by = {};
  for (const r of results) {
    if (!r.ok) continue;
    const k = r.provider + '|' + r.intent;
    (by[k] ||= []).push(r);
  }
  const providers = [...new Set(results.map((r) => r.provider))];
  const out = { providers: {}, totals: { all: results.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } };

  for (const p of providers) {
    const cat = by[p + '|品类推荐'] || [];
    const emo = by[p + '|品牌情绪'] || [];
    const con = by[p + '|联系方式'] || [];
    const hit = cat.filter((r) => hasAny(r.text, brandNames)).length;
    const ci = wilson(hit, cat.length);
    const compRates = comps.map((c) => ({ name: c, rate: cat.length ? cat.filter((r) => hasAny(r.text, [c])).length / cat.length : 0 }))
      .sort((a, b) => b.rate - a.rate);

    // 信源：只算品类回答里被正文引用的（没有引用标注的平台就退回全部搜到的）
    const anyCited = cat.some((r) => r.sources?.some((s) => s.cited));
    const src = {};
    let total = 0;
    for (const r of cat) for (const s of r.sources || []) {
      if (anyCited && !s.cited) continue;
      const c = classify(s.url, s.site, own);
      const key = c.name;
      src[key] ||= { name: c.name, kind: c.kind, own: !!c.own, n: 0, urls: {} };
      src[key].n++; total++;
      src[key].urls[s.url] = (src[key].urls[s.url] || 0) + 1;
    }
    const sources = Object.values(src).sort((a, b) => b.n - a.n).map((s) => ({
      name: s.name, kind: s.kind, own: s.own, n: s.n, pct: total ? s.n / total : 0,
      top: Object.entries(s.urls).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([url, n]) => ({ url, n })),
    }));

    const conOk = contactTokens.length ? con.filter((r) => hasAny(r.text, contactTokens)).length : null;

    // AI 给出的电话里，不在「正确联系方式」里的 = 给错了
    const goodDigits = contactTokens.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 7);
    const wrong = {};
    for (const r of [...con, ...emo]) for (const m of r.text.match(PHONE) || []) {
      const d = m.replace(/\D/g, '');
      if (!goodDigits.some((g) => g.endsWith(d) || d.endsWith(g))) (wrong[m.replace(/\s/g, '')] ||= new Set()).add(r.q + '#' + r.k);
    }
    const wrongPhones = Object.entries(wrong).map(([phone, set]) => ({ phone, n: set.size })).sort((x, y) => y.n - x.n);

    // 品类回答里 AI 实际推荐的名字（粗提取，给学员挑竞品用）
    const known = new Set([...brandNames, ...comps].map(norm));
    const cand = {};
    for (const r of cat) {
      const seen = new Set();
      for (const m of r.text.matchAll(/\*\*([^*\n]{2,24})\*\*|^\s*\d+[.、]\s*([^\s：:，,（(*]{2,20})/gm)) {
        if (m[1] && /^[：:]/.test(r.text.slice(m.index + m[0].length))) continue; // 「**优势**：」这类小标题
        let n = (m[1] || m[2] || '').replace(/^\s*\d+[.、．]\s*/, '').replace(/^[🥇🥈🥉]\s*/u, '').replace(/[（(].*$/, '').replace(/\s*[·|｜-]\s.*$/, '').replace(/[：:]$/, '').trim();
        if (n.length < 2 || /[，。；、！？]/.test(n) || /^\d/.test(n) || known.has(norm(n))) continue;
        seen.add(n);
      }
      for (const n of seen) cand[n] = (cand[n] || 0) + 1;
    }
    const recommended = Object.entries(cand).filter(([, c]) => c >= 2).sort((x, y) => y[1] - x[1]).slice(0, 15).map(([name, n]) => ({ name, n }));
    const rate = cat.length ? hit / cat.length : 0;
    const top = compRates[0];
    const lights = [
      { name: '头部竞品占满、你是 0？', red: hit === 0 && top && top.rate >= 0.5,
        detail: `${top ? `${top.name} ${pct(top.rate)}` : '没填竞品'} · 你 ${pct(rate)}` },
      { name: '你的提及率已经 ≥50%？', red: rate >= 0.5, detail: pct(rate) },
    ];

    out.providers[p] = {
      category: { n: cat.length, hit, rate, ci, comps: compRates },
      emotion: { n: emo.length, mentioned: emo.filter((r) => hasAny(r.text, brandNames)).length },
      contact: { n: con.length, ok: conOk, rate: conOk == null || !con.length ? null : conOk / con.length, wrongPhones },
      recommended,
      sources, sourceTotal: total, citedOnly: anyCited,
      lights,
      verdict: !cat.length ? '没有数据' : lights[1].red ? '不用做' : lights[0].red ? '先换更细的词' : '可以做',
    };
  }
  return out;
}

const PHONE = /(?<!\d)(?:1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}|400[\s-]?\d{3}[\s-]?\d{4}|0\d{2,3}[\s-]?\d{7,8})(?!\d)/g;
const pct = (x) => Math.round(x * 100) + '%';

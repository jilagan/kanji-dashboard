import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'kanji';

// ── Basic Auth ─────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Kanji Dashboard"');
    return res.status(401).send('Unauthorized');
  }
  const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
  if (user === 'kanji' && pass === DASHBOARD_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="Kanji Dashboard"');
  return res.status(401).send('Unauthorized');
}

// ── Supabase helpers ────────────────────────────────────────────────────────

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`sb ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function sbAdmin(path) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`sbAdmin ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// ── Data fetching ──────────────────────────────────────────────────────────
// Column names: overall_score (not score), stroke_order_result/stroke_count_result
// (flat, not JSONB), interval_days/repetition/next_review (not interval/repetitions/due_date)

async function fetchStats() {
  const [usersRes, attempts, srsCards, meaningChecks] = await Promise.all([
    sbAdmin('users?per_page=100'),
    sb('attempts?select=user_id,overall_score,kanji,jlpt_level,created_at,stroke_order_result,stroke_count_result,radical_balance,center_of_gravity,spacing,proportions&order=created_at.desc&limit=500'),
    sb('srs_cards?select=user_id,kanji,jlpt_level,interval_days,ease_factor,repetition,next_review'),
    sb('meaning_checks?select=user_id,correct,created_at&order=created_at.desc&limit=200'),
  ]);

  const users = (usersRes.users || []).filter(u =>
    !['test@archmob.com', 'e2e-test@kanji-mentor.test'].includes(u.email)
  );

  // Per-user attempt stats
  const userAttempts = {};
  for (const a of attempts) {
    if (!userAttempts[a.user_id]) userAttempts[a.user_id] = [];
    userAttempts[a.user_id].push(a);
  }

  // Daily attempt counts (last 14 days)
  const dailyCounts = {};
  const dailyUsers = {};
  for (const a of attempts) {
    const day = a.created_at.slice(0, 10);
    dailyCounts[day] = (dailyCounts[day] || 0) + 1;
    if (!dailyUsers[day]) dailyUsers[day] = new Set();
    dailyUsers[day].add(a.user_id);
  }

  const today = new Date();
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (13 - i));
    return d.toISOString().slice(0, 10);
  });

  const dailyActivity = days.map(day => ({
    date: day,
    attempts: dailyCounts[day] || 0,
    users: dailyUsers[day]?.size || 0,
  }));

  // Score distribution
  const scoreDist = Array(11).fill(0);
  let totalScore = 0, scoreCount = 0;
  for (const a of attempts) {
    const s = a.overall_score;
    if (s != null && s >= 0 && s <= 10) {
      scoreDist[s]++;
      totalScore += s;
      scoreCount++;
    }
  }

  // Top kanji
  const kanjiStats = {};
  for (const a of attempts) {
    if (!a.kanji) continue;
    if (!kanjiStats[a.kanji]) kanjiStats[a.kanji] = { kanji: a.kanji, count: 0, total: 0, users: new Set() };
    kanjiStats[a.kanji].count++;
    kanjiStats[a.kanji].total += a.overall_score || 0;
    kanjiStats[a.kanji].users.add(a.user_id);
  }
  const topKanji = Object.values(kanjiStats)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map(k => ({ ...k, avg: k.count ? +(k.total / k.count).toFixed(1) : 0, users: k.users.size }));

  // Writing quality (flat columns on attempts table)
  const quality = {
    strokeOrder: { correct: 0, incorrect: 0, mostly: 0 },
    strokeCount: { correct: 0, incorrect: 0 },
    spacing: { good: 0, too_loose: 0, too_tight: 0 },
    proportions: { good: 0, disproportionate: 0 },
    radicalBalance: { balanced: 0, off_balance: 0 },
    centerOfGravity: { centered: 0, shifted: 0 },
  };
  for (const a of attempts) {
    if (a.stroke_order_result === 'correct') quality.strokeOrder.correct++;
    else if (a.stroke_order_result === 'incorrect') quality.strokeOrder.incorrect++;
    else if (a.stroke_order_result === 'mostly_correct') quality.strokeOrder.mostly++;
    if (a.stroke_count_result === 'correct') quality.strokeCount.correct++;
    else if (a.stroke_count_result === 'incorrect') quality.strokeCount.incorrect++;
    if (a.spacing && a.spacing in quality.spacing) quality.spacing[a.spacing]++;
    if (a.proportions === 'good') quality.proportions.good++;
    else if (a.proportions) quality.proportions.disproportionate++;
    if (a.radical_balance === 'balanced') quality.radicalBalance.balanced++;
    else if (a.radical_balance) quality.radicalBalance.off_balance++;
    if (a.center_of_gravity === 'centered') quality.centerOfGravity.centered++;
    else if (a.center_of_gravity) quality.centerOfGravity.shifted++;
  }

  // SRS per user
  const userSRS = {};
  const now = new Date().toISOString().slice(0, 10);
  for (const card of srsCards) {
    if (!userSRS[card.user_id]) userSRS[card.user_id] = { total: 0, due: 0 };
    userSRS[card.user_id].total++;
    if (card.next_review <= now) userSRS[card.user_id].due++;
  }

  // Meaning check accuracy
  const mcByUser = {};
  for (const mc of meaningChecks) {
    if (!mcByUser[mc.user_id]) mcByUser[mc.user_id] = { total: 0, correct: 0 };
    mcByUser[mc.user_id].total++;
    if (mc.correct) mcByUser[mc.user_id].correct++;
  }

  // Build user rows
  const userRows = users
    .filter(u => userAttempts[u.id]?.length > 0)
    .map(u => {
      const atts = userAttempts[u.id] || [];
      const avg = atts.length ? +(atts.reduce((s, a) => s + (a.overall_score || 0), 0) / atts.length).toFixed(1) : 0;
      return {
        id: u.id,
        email: u.email ?? '',
        displayName: u.user_metadata?.display_name ?? u.email?.split('@')[0] ?? ('anon-' + u.id.slice(-6)),
        initials: (() => {
          const name = u.user_metadata?.display_name ?? u.email?.split('@')[0] ?? '';
          return name.split(/[\s._]/).map(p => p[0]?.toUpperCase()).filter(Boolean).join('').slice(0, 2) || u.id.slice(-2).toUpperCase();
        })(),
        isPro: u.app_metadata?.is_pro === true,
        joined: u.created_at?.slice(0, 10),
        lastSeen: u.last_sign_in_at?.slice(0, 10),
        lastAttempt: atts[0]?.created_at?.slice(0, 10) || null,
        attempts: atts.length,
        avgScore: avg,
        srs: userSRS[u.id] || { total: 0, due: 0 },
        meaningChecks: mcByUser[u.id] || { total: 0, correct: 0 },
      };
    })
    .sort((a, b) => b.attempts - a.attempts);

  return {
    updatedAt: new Date().toISOString(),
    totals: {
      users: users.length,
      externalUsers: userRows.length,
      attempts: attempts.length,
      uniqueKanji: Object.keys(kanjiStats).length,
      avgScore: scoreCount ? +(totalScore / scoreCount).toFixed(1) : 0,
      srsCards: srsCards.length,
      srsCardsDue: Object.values(userSRS).reduce((s, u) => s + u.due, 0),
      meaningChecks: meaningChecks.length,
    },
    dailyActivity,
    scoreDist,
    topKanji,
    quality,
    userRows,
  };
}

// ── Dashboard HTML ──────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="60">
<title>Kanji Mentor — Live Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f7; color: #1d1d1f; }
  header { background: #fff; border-bottom: 1px solid #e5e5ea; padding: 18px 32px; display: flex; align-items: center; gap: 14px; }
  .logo { font-size: 28px; }
  header h1 { font-size: 20px; font-weight: 700; }
  header p { font-size: 12px; color: #86868b; margin-top: 2px; }
  #updated { font-size: 11px; color: #86868b; margin-left: auto; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #34c759; margin-right: 5px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .container { max-width: 1120px; margin: 0 auto; padding: 24px 20px; }
  .stats-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 20px; }
  .stat-card { background: #fff; border-radius: 14px; padding: 18px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .stat-card .lbl { font-size: 11px; color: #86868b; font-weight: 600; text-transform: uppercase; letter-spacing: .5px; }
  .stat-card .val { font-size: 34px; font-weight: 700; margin: 5px 0 2px; }
  .stat-card .sub { font-size: 11px; color: #86868b; }
  .red{color:#ff3b30} .green{color:#34c759} .blue{color:#007aff} .orange{color:#ff9500}
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 20px; }
  .three-col { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; margin-bottom: 20px; }
  .card { background:#fff; border-radius:14px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,.06); }
  .card h2 { font-size:14px; font-weight:600; margin-bottom:14px; }
  .card h2 span { font-size:11px; color:#86868b; font-weight:400; margin-left:5px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th { text-align:left; font-size:10px; font-weight:600; color:#86868b; text-transform:uppercase; letter-spacing:.4px; padding:0 0 8px; border-bottom:1px solid #f2f2f7; }
  td { padding:9px 0; border-bottom:1px solid #f2f2f7; vertical-align:middle; }
  tr:last-child td { border-bottom:none; }
  .kanji-cell { font-size:20px; font-family:'Hiragino Mincho ProN','Yu Mincho',serif; width:32px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:20px; font-size:11px; font-weight:600; }
  .pill-hi  { background:#d1fae5; color:#065f46; }
  .pill-mid { background:#fef3c7; color:#92400e; }
  .pill-lo  { background:#fee2e2; color:#991b1b; }
  .av { width:26px; height:26px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; color:#fff; margin-right:7px; }
  .av-0{background:#ff3b30} .av-1{background:#007aff} .av-2{background:#34c759} .av-3{background:#ff9500} .av-4{background:#5856d6}
  .user-cell { display:flex; align-items:center; }
  .bar-row { display:flex; align-items:center; margin-bottom:9px; }
  .bar-label { font-size:12px; width:100px; }
  .bar-wrap { background:#f2f2f7; border-radius:4px; height:6px; flex:1; margin:0 8px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:4px; }
  .bar-pct { font-size:11px; color:#86868b; width:34px; text-align:right; }
  .chart-wrap { position:relative; height:170px; }
  .note { font-size:11px; color:#86868b; font-style:italic; margin-top:10px; }
  .q-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .q-item { background:#f5f5f7; border-radius:10px; padding:10px 12px; }
  .q-item .ql { font-size:10px; color:#86868b; margin-bottom:3px; }
  .q-item .qv { font-size:13px; font-weight:600; }
  .qg{color:#34c759} .qw{color:#ff9500}
  @media(max-width:700px){.stats-grid{grid-template-columns:repeat(2,1fr)}.two-col,.three-col{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div class="logo">漢</div>
  <div><h1>Kanji Mentor</h1><p>Live Beta Dashboard</p></div>
  <div id="updated"><span class="dot"></span>__UPDATED_AT__</div>
</header>
<div class="container">
  <div class="stats-grid" id="statCards">
    <div class="stat-card"><div class="lbl">Users</div><div class="val red">—</div><div class="sub">—</div></div>
    <div class="stat-card"><div class="lbl">Attempts</div><div class="val blue">—</div><div class="sub">—</div></div>
    <div class="stat-card"><div class="lbl">Avg Score</div><div class="val orange">—</div><div class="sub">—</div></div>
    <div class="stat-card"><div class="lbl">SRS Cards</div><div class="val green">—</div><div class="sub">—</div></div>
  </div>
  <div class="two-col">
    <div class="card"><h2>Daily Attempts <span>last 14 days</span></h2><div class="chart-wrap"><canvas id="actChart"></canvas></div></div>
    <div class="card"><h2>Score Distribution <span>0–10</span></h2><div class="chart-wrap"><canvas id="scoreChart"></canvas></div></div>
  </div>
  <div class="three-col">
    <div class="card">
      <h2>Users</h2>
      <table><thead><tr><th>User</th><th>Att.</th><th>Avg</th><th>SRS</th><th>Due</th><th>Joined</th><th>Last Seen</th><th>Last Attempt</th></tr></thead>
      <tbody id="userTable"></tbody></table>
    </div>
    <div class="card">
      <h2>Top Kanji <span>by attempts</span></h2>
      <table><thead><tr><th></th><th>Meaning</th><th>Att.</th><th>Avg</th></tr></thead>
      <tbody id="kanjiTable"></tbody></table>
    </div>
  </div>
  <div class="two-col">
    <div class="card"><h2>Writing Quality</h2><div id="qualityBars"></div></div>
    <div class="card"><h2>Engagement</h2><div class="q-grid" id="engGrid"></div></div>
  </div>
</div>
<script>
const KANJI_MEANINGS = {
  '七':'seven','一':'one','八':'eight','九':'nine','人':'person','口':'mouth',
  '万':'ten-thousand','二':'two','上':'above','下':'below','三':'three','力':'power',
  '十':'ten','千':'thousand','入':'enter','土':'earth','子':'child','日':'sun/day',
  '月':'moon','火':'fire','水':'water','木':'tree','金':'gold'
};

let actChart, scoreChart;

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {month:'short', day:'numeric'});
}

function scorePill(s) {
  const cls = s >= 7 ? 'pill-hi' : s >= 5 ? 'pill-mid' : 'pill-lo';
  return '<span class="pill ' + cls + '">' + s.toFixed(1) + '</span>';
}

function render(data) {
  document.getElementById('updated').innerHTML =
    '<span class="dot"></span>Updated ' + new Date(data.updatedAt).toLocaleTimeString();

  const t = data.totals;
  const cards = document.querySelectorAll('#statCards .stat-card');
  cards[0].innerHTML = '<div class="lbl">Users</div><div class="val red">' + t.users + '</div><div class="sub">' + t.externalUsers + ' with activity</div>';
  cards[1].innerHTML = '<div class="lbl">Attempts</div><div class="val blue">' + t.attempts + '</div><div class="sub">' + t.uniqueKanji + ' unique kanji</div>';
  cards[2].innerHTML = '<div class="lbl">Avg Score</div><div class="val orange">' + t.avgScore + '<span style="font-size:18px">/10</span></div><div class="sub">across all attempts</div>';
  cards[3].innerHTML = '<div class="lbl">SRS Cards</div><div class="val green">' + t.srsCards + '</div><div class="sub">' + t.srsCardsDue + ' due today</div>';

  const labels = data.dailyActivity.map(d => {
    return new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', {month:'short', day:'numeric'});
  });
  if (actChart) actChart.destroy();
  actChart = new Chart(document.getElementById('actChart'), {
    type:'bar',
    data:{ labels, datasets:[
      { label:'Attempts', data:data.dailyActivity.map(d=>d.attempts), backgroundColor:'rgba(255,59,48,.15)', borderColor:'#ff3b30', borderWidth:2, borderRadius:5 },
      { label:'Users', data:data.dailyActivity.map(d=>d.users), type:'line', borderColor:'#007aff', backgroundColor:'transparent', borderWidth:2, pointBackgroundColor:'#007aff', pointRadius:3, yAxisID:'y2', tension:.3 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ x:{grid:{display:false},ticks:{font:{size:10}}},
        y:{grid:{color:'#f2f2f7'},ticks:{font:{size:10},stepSize:5},beginAtZero:true},
        y2:{position:'right',grid:{display:false},ticks:{font:{size:10},stepSize:1},beginAtZero:true,max:5} } }
  });

  const scoreColors = data.scoreDist.map((_,i) =>
    i>=8?'rgba(52,199,89,.7)':i>=6?'rgba(255,149,0,.7)':'rgba(255,59,48,.7)');
  if (scoreChart) scoreChart.destroy();
  scoreChart = new Chart(document.getElementById('scoreChart'), {
    type:'bar',
    data:{ labels:['0','1','2','3','4','5','6','7','8','9','10'],
      datasets:[{data:data.scoreDist,backgroundColor:scoreColors,borderRadius:4}]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
      scales:{ x:{grid:{display:false},ticks:{font:{size:10}}},
        y:{grid:{color:'#f2f2f7'},ticks:{font:{size:10},stepSize:5},beginAtZero:true} } }
  });

  const avColors = ['av-0','av-1','av-2','av-3','av-4'];
  document.getElementById('userTable').innerHTML = data.userRows.map((u, i) =>
    '<tr>' +
      '<td><div class="user-cell"><div class="av ' + avColors[i%5] + '">' + u.initials + '</div>' +
        '<span>' + u.displayName + '<br><small style="color:' + (u.isPro?'#34c759':'#86868b') + ';font-weight:600">' + (u.isPro?'★ pro':'') + '</small></span></div></td>' +
      '<td>' + u.attempts + '</td>' +
      '<td>' + scorePill(u.avgScore) + '</td>' +
      '<td>' + u.srs.total + '</td>' +
      '<td>' + u.srs.due + '</td>' +
      '<td>' + fmt(u.joined) + '</td>' +
      '<td>' + fmt(u.lastSeen) + '</td>' +
      '<td>' + fmt(u.lastAttempt) + '</td>' +
    '</tr>'
  ).join('');

  document.getElementById('kanjiTable').innerHTML = data.topKanji.map(k =>
    '<tr>' +
      '<td class="kanji-cell">' + k.kanji + '</td>' +
      '<td style="color:#86868b;font-size:12px">' + (KANJI_MEANINGS[k.kanji]||'') + '</td>' +
      '<td>' + k.count + '</td>' +
      '<td>' + scorePill(k.avg) + '</td>' +
    '</tr>'
  ).join('');

  const q = data.quality;
  const soT = q.strokeOrder.correct + q.strokeOrder.incorrect + q.strokeOrder.mostly || 1;
  const scT = q.strokeCount.correct + q.strokeCount.incorrect || 1;
  const spT = q.spacing.good + q.spacing.too_loose + q.spacing.too_tight || 1;
  const prT = q.proportions.good + q.proportions.disproportionate || 1;
  const rbT = q.radicalBalance.balanced + q.radicalBalance.off_balance || 1;
  const cgT = q.centerOfGravity.centered + q.centerOfGravity.shifted || 1;
  const bars = [
    ['Stroke order',    q.strokeOrder.correct / soT, '#34c759'],
    ['Stroke count',    q.strokeCount.correct / scT, '#34c759'],
    ['Spacing',         q.spacing.good / spT,        '#34c759'],
    ['Proportions',     q.proportions.good / prT,    '#ff9500'],
    ['Radical balance', q.radicalBalance.balanced / rbT, '#ff9500'],
    ['Center gravity',  q.centerOfGravity.centered / cgT, '#ff9500'],
  ];
  document.getElementById('qualityBars').innerHTML = bars.map(b =>
    '<div class="bar-row">' +
      '<span class="bar-label">' + b[0] + '</span>' +
      '<div class="bar-wrap"><div class="bar-fill" style="width:' + Math.round(b[1]*100) + '%;background:' + b[2] + '"></div></div>' +
      '<span class="bar-pct" style="color:' + b[2] + '">' + Math.round(b[1]*100) + '%</span>' +
    '</div>'
  ).join('');

  const mcTotal   = data.userRows.reduce((s,u) => s + u.meaningChecks.total, 0);
  const mcCorrect = data.userRows.reduce((s,u) => s + u.meaningChecks.correct, 0);
  document.getElementById('engGrid').innerHTML =
    '<div class="q-item"><div class="ql">Meaning checks</div><div class="qv">' + mcTotal + '</div></div>' +
    '<div class="q-item"><div class="ql">MC accuracy</div><div class="qv qg">' + (mcTotal ? Math.round(mcCorrect/mcTotal*100)+'%' : '—') + '</div></div>' +
    '<div class="q-item"><div class="ql">Feedback flags</div><div class="qv qg">0</div></div>' +
    '<div class="q-item"><div class="ql">Client errors</div><div class="qv qg">0</div></div>' +
    '<div class="q-item"><div class="ql">SRS due today</div><div class="qv qw">' + t.srsCardsDue + '</div></div>' +
    '<div class="q-item"><div class="ql">Unique kanji</div><div class="qv">' + t.uniqueKanji + '</div></div>';
}

// Data is injected server-side — just render it.
const __DATA__ = __SSR_DATA__;
render(__DATA__);
<\/script>
</body>
</html>`;

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/', requireAuth, async (_req, res) => {
  try {
    const data = await fetchStats();
    const ts = new Date(data.updatedAt);
    const updatedStr = ts.toUTCString().replace('GMT', 'UTC');
    const safeJson = JSON.stringify(data);
    const page = HTML
      .replace('__UPDATED_AT__', updatedStr)
      .replace('__SSR_DATA__', safeJson);
    res.type('html').send(page);
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).send(`<pre>Dashboard error: ${e.message}</pre>`);
  }
});

app.get('/api/stats', requireAuth, async (_req, res) => {
  try {
    res.json(await fetchStats());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Kanji Dashboard on port ${PORT}`));

// ══════════════════════════════════════════════════════════════
//  NinjuBot Dashboard · app.js
//
//  Auth flow:
//  1. User clicks "Login with Discord"
//  2. Redirect to Discord OAuth2 → returns ?code=xxx
//  3. Exchange code at bot API /auth/discord → get user + token
//  4. Fetch user's guilds → filter by admin + bot present
//  5. User picks a server → load that server's MongoDB settings
//  6. All saves go to POST /settings/update with Authorization header
// ══════════════════════════════════════════════════════════════

const BOT_API      = 'https://ninjubot.onrender.com';

// ── Discord OAuth2 config ──────────────────────────────────
// Replace CLIENT_ID with your actual Discord application client ID
const DISCORD_CLIENT_ID    = '1483732014380224552';
// Derive redirect URI from current page path so GitHub Pages subdirectories work correctly.
// e.g. https://sohamdasbiswas.github.io/NinjuBot-Dashboard/dashboard.html
const DISCORD_REDIRECT_URI = encodeURIComponent(
  window.location.origin +
  window.location.pathname.replace(/[^/]*$/, '') +
  'dashboard.html'
);
const DISCORD_SCOPES       = 'identify+guilds';
const OAUTH_URL = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${DISCORD_REDIRECT_URI}&response_type=code&scope=${DISCORD_SCOPES}`;

// ── Session state ──────────────────────────────────────────
let discordToken   = sessionStorage.getItem('discord_token') || null;
let currentUser    = JSON.parse(sessionStorage.getItem('discord_user') || 'null');
let currentGuild   = JSON.parse(sessionStorage.getItem('current_guild') || 'null');
let dirtyCategories = new Set();
let auditLogPage   = 1;
let auditLogFilter = 'all';
let allLogEntries  = [];
let boostGrad      = 'forest';
let boostAccent    = '#4eff91';
let boostEmoji     = '💎';

// ── Gradient definitions ───────────────────────────────────
const GRADS = {
  forest:  'linear-gradient(135deg,#0e2a1a,#1a5c2e)',
  purple:  'linear-gradient(135deg,#1a0a2e,#5c1a8e)',
  crimson: 'linear-gradient(135deg,#1a0e0e,#5c1a8e)',
  ocean:   'linear-gradient(135deg,#0a1a2e,#1a3a5c)',
  sunset:  'linear-gradient(135deg,#2e1a0a,#5c3a1a)',
  dark:    'linear-gradient(135deg,#1a1a1a,#3a3a3a)',
};

// ══════════════════════════════════════════════════════════════
//  BOOT — decide which screen to show
// ══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  // Handle OAuth2 callback (?code=xxx in URL)
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (code) {
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);
    await handleOAuthCallback(code);
    return;
  }

  if (discordToken && currentUser) {
    if (currentGuild) {
      showDashboard();
    } else {
      showServerPicker();
    }
  } else {
    showOAuthGate();
  }

  // Init health polling
  fetchHealth();
  setInterval(fetchHealth, 30000);
  // Scroll reveal for landing page
  initReveal();
});

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════

function startOAuth() {
  window.location.href = OAUTH_URL;
}

async function handleOAuthCallback(code) {
  showOAuthGate();
  const gate = document.getElementById('oauth-gate');
  if (gate) gate.querySelector('.oauth-gate').innerHTML = `
    <div class="oauth-icon" style="animation:none">⏳</div>
    <div class="oauth-title">Logging you in…</div>
    <p class="oauth-sub">Exchanging OAuth code with Discord. Please wait.</p>`;

  try {
    // Exchange code via bot API (bot handles the client_secret)
    const res  = await fetch(`${BOT_API}/auth/discord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: decodeURIComponent(DISCORD_REDIRECT_URI) })
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) throw new Error(data.error || 'Auth failed');

    discordToken = data.access_token;
    currentUser  = data.user;
    sessionStorage.setItem('discord_token', discordToken);
    sessionStorage.setItem('discord_user',  JSON.stringify(currentUser));

    showServerPicker();
  } catch (e) {
    showOAuthGate();
    showToast('❌ Login failed: ' + e.message, 'error');
  }
}

function logout() {
  sessionStorage.clear();
  discordToken = null; currentUser = null; currentGuild = null;
  dirtyCategories.clear();
  window.location.reload();
}

// ══════════════════════════════════════════════════════════════
//  SCREEN ROUTING
// ══════════════════════════════════════════════════════════════

function showOAuthGate() {
  document.getElementById('oauth-gate').style.display       = 'block';
  document.getElementById('server-picker-page').style.display = 'none';
  document.getElementById('dashboard-app').style.display    = 'none';
}

function showServerPicker() {
  document.getElementById('oauth-gate').style.display       = 'none';
  document.getElementById('server-picker-page').style.display = 'block';
  document.getElementById('dashboard-app').style.display    = 'none';

  // Populate user info
  if (currentUser) {
    const avatarUrl = currentUser.avatar
      ? `https://cdn.discordapp.com/avatars/${currentUser.id}/${currentUser.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(currentUser.discriminator || 0) % 5}.png`;
    const spav = document.getElementById('sp-avatar');
    const spun = document.getElementById('sp-username');
    if (spav) spav.src = avatarUrl;
    if (spun) spun.textContent = currentUser.username || currentUser.global_name || 'Unknown';
  }

  loadGuilds();
}

function showDashboard() {
  document.getElementById('oauth-gate').style.display       = 'none';
  document.getElementById('server-picker-page').style.display = 'none';
  document.getElementById('dashboard-app').style.display    = 'flex';

  populateUserUI();
  loadSettings();
  fetchBoostStats();
}

function showServerPicker() {
  // If called from inside dashboard
  sessionStorage.removeItem('current_guild');
  currentGuild = null;

  document.getElementById('oauth-gate').style.display       = 'none';
  document.getElementById('server-picker-page').style.display = 'block';
  document.getElementById('dashboard-app').style.display    = 'none';

  if (currentUser) {
    const avatarUrl = currentUser.avatar
      ? `https://cdn.discordapp.com/avatars/${currentUser.id}/${currentUser.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;
    const spav = document.getElementById('sp-avatar');
    const spun = document.getElementById('sp-username');
    if (spav) spav.src = avatarUrl;
    if (spun) spun.textContent = currentUser.username || '';
  }

  loadGuilds();
}

// ══════════════════════════════════════════════════════════════
//  GUILD / SERVER LOADING
// ══════════════════════════════════════════════════════════════

async function loadGuilds() {
  const grid = document.getElementById('guild-grid');
  if (!grid) return;
  grid.innerHTML = `<div class="loading-state" style="grid-column:1/-1"><div class="spinner"></div><p>Loading your servers…</p></div>`;

  try {
    // Fetch guilds the user has admin access to from our bot API
    const res  = await fetch(`${BOT_API}/auth/guilds`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const guilds = await res.json();
    if (!res.ok) throw new Error(guilds.error || 'Failed');

    if (!guilds.length) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--tx-2)">No servers found where you have admin permission and NinjuBot is present.</div>`;
      return;
    }

    grid.innerHTML = guilds.map(g => {
      const icon = g.icon
        ? `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64" class="guild-img" alt="">`
        : `<div class="guild-fb">${g.name.charAt(0).toUpperCase()}</div>`;
      return `
        <div class="guild-card" onclick="selectGuild(${JSON.stringify(g).replace(/"/g,'&quot;')})">
          ${icon}
          <div class="guild-name">${g.name}</div>
          <div class="guild-members">${(g.approximate_member_count||0).toLocaleString()} members</div>
          <div class="guild-admin-badge">Admin ✓</div>
        </div>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--tx-2)">
      <p>❌ Could not load servers.</p>
      <p style="font-size:0.78rem;margin-top:8px">Add <code style="color:var(--green)">GET /auth/guilds</code> endpoint to your bot API.</p>
    </div>`;
  }
}

function selectGuild(guild) {
  currentGuild = guild;
  sessionStorage.setItem('current_guild', JSON.stringify(guild));
  showDashboard();
}

// ══════════════════════════════════════════════════════════════
//  POPULATE USER UI
// ══════════════════════════════════════════════════════════════

function populateUserUI() {
  if (!currentUser) return;
  const avatarUrl = currentUser.avatar
    ? `https://cdn.discordapp.com/avatars/${currentUser.id}/${currentUser.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/0.png`;

  ['s-avatar','tb-avatar'].forEach(id => { const el=document.getElementById(id); if(el) el.src=avatarUrl; });
  ['s-username','tb-username'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=currentUser.username||''; });
  const stag = document.getElementById('s-tag');
  if (stag) stag.textContent = `#${currentUser.discriminator||'0000'}`;

  if (currentGuild) {
    const csName = document.getElementById('cs-name');
    const csIcon = document.getElementById('cs-icon');
    const dSn    = document.getElementById('d-servername');
    if (csName) csName.textContent = currentGuild.name;
    if (dSn)    dSn.textContent    = currentGuild.name;
    if (csIcon && currentGuild.icon) {
      csIcon.innerHTML = `<img src="https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.png?size=32" style="width:100%;height:100%;border-radius:8px;object-fit:cover">`;
    } else if (csIcon) {
      csIcon.textContent = currentGuild.name.charAt(0).toUpperCase();
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS — LOAD
// ══════════════════════════════════════════════════════════════

async function loadSettings() {
  if (!discordToken || !currentGuild) return;
  try {
    const res  = await fetch(`${BOT_API}/settings?guild_id=${currentGuild.id}`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error('load failed');
    populateForm(data);
    dirtyCategories.clear();
    updateAllDots();
  } catch {
    // Use defaults silently if endpoint doesn't exist yet
  }
}

function populateForm(d) {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (!el || val === undefined || val === null) return;
    if (el.type === 'checkbox') el.checked = Boolean(val);
    else if (el.type === 'range') {
      el.value = val;
      const valEl = document.getElementById(id + '-val');
      if (valEl) {
        const sfx = id.includes('vol') ? '%' : id.includes('xp-cd') ? 's'
                  : id.includes('daily-cd') ? 'h' : id.includes('cd') ? 'm'
                  : id.includes('mult') ? '×' : '';
        valEl.textContent = val + sfx;
      }
    } else el.value = val;
  };
  set('cfg-prefix',d.prefix); set('cfg-botname-edit',d.bot_nickname); set('cfg-ai-model',d.ai_model);
  set('cfg-ai-enabled',d.ai_enabled); set('cfg-hinglish',d.hinglish_mode); set('cfg-music-enabled',d.music_enabled);
  set('cfg-247',d.always_247); set('cfg-max-queue',d.max_queue_size); set('cfg-default-vol',d.default_volume);
  set('cfg-daily-min',d.daily_min); set('cfg-daily-max',d.daily_max); set('cfg-daily-cd',d.daily_cooldown_hours);
  set('cfg-work-min',d.work_min); set('cfg-work-max',d.work_max); set('cfg-work-cd',d.work_cooldown_minutes);
  set('cfg-gambling',d.gambling_enabled); set('cfg-gamble-min',d.gamble_min_bet); set('cfg-gamble-max',d.gamble_max_bet);
  set('cfg-start-balance',d.starting_balance);
  set('cfg-xp-min',d.xp_min); set('cfg-xp-max',d.xp_max); set('cfg-xp-cd',d.xp_cooldown_seconds);
  set('cfg-xp-enabled',d.xp_enabled); set('cfg-levelup-msg',d.levelup_announcements);
  set('cfg-levelup-text',d.levelup_message); set('cfg-xp-mult',d.xp_multiplier); set('cfg-level-base',d.level_base_xp);
  set('cfg-welcome-enabled',d.welcome_enabled); set('cfg-welcome-channel',d.welcome_channel_id);
  set('cfg-welcome-msg',d.welcome_message); set('cfg-welcome-card',d.welcome_card_enabled);
  set('cfg-welcome-bg',d.welcome_card_bg); set('cfg-welcome-color',d.welcome_card_color);
  set('cfg-leave-enabled',d.leave_enabled); set('cfg-leave-channel',d.leave_channel_id); set('cfg-leave-msg',d.leave_message);
  set('cfg-yt-alerts',d.yt_alerts); set('cfg-yt-uploads',d.yt_uploads);
  set('cfg-yt-channel-id',d.yt_channel_id); set('cfg-yt-alert-channel',d.yt_alert_channel_id);
  set('cfg-yt-alert-msg',d.yt_alert_message);
  set('cfg-tw-alerts',d.tw_alerts); set('cfg-tw-username',d.tw_username);
  set('cfg-tw-alert-channel',d.tw_alert_channel_id); set('cfg-tw-alert-msg',d.tw_alert_message);
  set('cfg-tw-statsvc',d.tw_stats_vc); set('cfg-yt-statsvc',d.yt_stats_vc);
  set('cfg-boost-enabled',d.boost_enabled); set('cfg-boost-channel',d.boost_channel_id);
  set('cfg-boost-msg',d.boost_message);
  if (d.boost_gradient) selectGrad(null, d.boost_gradient);
  if (d.boost_accent)   selectAccent(null, d.boost_accent);
  if (d.boost_emoji)    selectEmoji(null, d.boost_emoji);
  set('cfg-antispam',d.antispam_enabled); set('cfg-linkfilter',d.link_filter_enabled);
  set('cfg-profanity',d.profanity_filter); set('cfg-raid',d.raid_protection);
  set('cfg-spam-threshold',d.spam_threshold);
  set('cfg-modlog',d.modlog_enabled); set('cfg-modlog-channel',d.modlog_channel_id);
  set('cfg-admin-role',d.admin_role_id); set('cfg-mod-role',d.mod_role_id); set('cfg-muted-role',d.muted_role_id);
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS — SAVE
// ══════════════════════════════════════════════════════════════

async function saveSettings(category) {
  if (!discordToken || !currentGuild) { showToast('Not authenticated', 'error'); return; }
  const payload = buildPayload(category);
  payload.guild_id = currentGuild.id;

  try {
    const res = await fetch(`${BOT_API}/settings/update`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${discordToken}` },
      body:    JSON.stringify({ category, guild_id: currentGuild.id, settings: payload })
    });
    if (res.status === 401) { showToast('❌ Session expired — please log in again', 'error'); logout(); return; }
    if (!res.ok) throw new Error('Server error ' + res.status);
    dirtyCategories.delete(category);
    updateAllDots();
    showToast(`✅ ${category.charAt(0).toUpperCase()+category.slice(1)} saved to MongoDB!`);
  } catch (e) {
    showToast('❌ Save failed — ' + e.message, 'error');
  }
}

function buildPayload(cat) {
  const v  = id => document.getElementById(id)?.value;
  const vn = id => Number(document.getElementById(id)?.value) || 0;
  const vb = id => document.getElementById(id)?.checked ?? false;
  const maps = {
    bot: { prefix:v('cfg-prefix'), bot_nickname:v('cfg-botname-edit'), ai_model:v('cfg-ai-model'),
      ai_enabled:vb('cfg-ai-enabled'), hinglish_mode:vb('cfg-hinglish'), music_enabled:vb('cfg-music-enabled'),
      always_247:vb('cfg-247'), max_queue_size:vn('cfg-max-queue'), default_volume:vn('cfg-default-vol') },
    economy: { daily_min:vn('cfg-daily-min'), daily_max:vn('cfg-daily-max'), daily_cooldown_hours:vn('cfg-daily-cd'),
      work_min:vn('cfg-work-min'), work_max:vn('cfg-work-max'), work_cooldown_minutes:vn('cfg-work-cd'),
      gambling_enabled:vb('cfg-gambling'), gamble_min_bet:vn('cfg-gamble-min'), gamble_max_bet:vn('cfg-gamble-max'),
      starting_balance:vn('cfg-start-balance') },
    levels: { xp_min:vn('cfg-xp-min'), xp_max:vn('cfg-xp-max'), xp_cooldown_seconds:vn('cfg-xp-cd'),
      xp_enabled:vb('cfg-xp-enabled'), levelup_announcements:vb('cfg-levelup-msg'),
      levelup_message:v('cfg-levelup-text'), xp_multiplier:Number(v('cfg-xp-mult'))||1, level_base_xp:vn('cfg-level-base') },
    welcome: { welcome_enabled:vb('cfg-welcome-enabled'), welcome_channel_id:v('cfg-welcome-channel'),
      welcome_message:v('cfg-welcome-msg'), welcome_card_enabled:vb('cfg-welcome-card'),
      welcome_card_bg:v('cfg-welcome-bg'), welcome_card_color:v('cfg-welcome-color'),
      leave_enabled:vb('cfg-leave-enabled'), leave_channel_id:v('cfg-leave-channel'), leave_message:v('cfg-leave-msg') },
    streams: { yt_alerts:vb('cfg-yt-alerts'), yt_uploads:vb('cfg-yt-uploads'), yt_channel_id:v('cfg-yt-channel-id'),
      yt_alert_channel_id:v('cfg-yt-alert-channel'), yt_alert_message:v('cfg-yt-alert-msg'),
      tw_alerts:vb('cfg-tw-alerts'), tw_username:v('cfg-tw-username'),
      tw_alert_channel_id:v('cfg-tw-alert-channel'), tw_alert_message:v('cfg-tw-alert-msg'),
      tw_stats_vc:vb('cfg-tw-statsvc'), yt_stats_vc:vb('cfg-yt-statsvc') },
    booster: { boost_enabled:vb('cfg-boost-enabled'), boost_channel_id:v('cfg-boost-channel'),
      boost_message:v('cfg-boost-msg'), boost_gradient:boostGrad, boost_accent:boostAccent, boost_emoji:boostEmoji },
    moderation: { antispam_enabled:vb('cfg-antispam'), link_filter_enabled:vb('cfg-linkfilter'),
      profanity_filter:vb('cfg-profanity'), raid_protection:vb('cfg-raid'), spam_threshold:vn('cfg-spam-threshold'),
      modlog_enabled:vb('cfg-modlog'), modlog_channel_id:v('cfg-modlog-channel'),
      admin_role_id:v('cfg-admin-role'), mod_role_id:v('cfg-mod-role'), muted_role_id:v('cfg-muted-role') },
  };
  return maps[cat] || {};
}

// ══════════════════════════════════════════════════════════════
//  DIRTY STATE
// ══════════════════════════════════════════════════════════════
function markDirty(cat) { dirtyCategories.add(cat); updateAllDots(); }
function updateAllDots() {
  ['bot','economy','levels','welcome','streams','booster','moderation'].forEach(cat => {
    const dot = document.getElementById('dd-' + cat);
    if (dot) dot.classList.toggle('show', dirtyCategories.has(cat));
  });
}

// ══════════════════════════════════════════════════════════════
//  BOOST CARD DESIGNER
// ══════════════════════════════════════════════════════════════
function selectGrad(el, name) {
  boostGrad = name;
  if (el) {
    document.querySelectorAll('#gradient-picker .grad-opt').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
  } else {
    document.querySelectorAll('#gradient-picker .grad-opt').forEach(e => {
      e.classList.toggle('selected', e.dataset.grad === name);
    });
  }
  updateBoostPreview();
  markDirty('booster');
}
function selectAccent(el, color) {
  boostAccent = color;
  if (el) {
    document.querySelectorAll('#accent-picker .color-swatch').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
  } else {
    document.querySelectorAll('#accent-picker .color-swatch').forEach(e => {
      e.classList.toggle('selected', e.dataset.color === color);
    });
  }
  updateBoostPreview();
  markDirty('booster');
}
function selectEmoji(el, emoji) {
  boostEmoji = emoji;
  if (el) {
    document.querySelectorAll('#emoji-picker .emoji-opt').forEach(e => e.classList.remove('selected'));
    el.classList.add('selected');
  } else {
    document.querySelectorAll('#emoji-picker .emoji-opt').forEach(e => {
      e.classList.toggle('selected', e.dataset.emoji === emoji);
    });
  }
  const bpe = document.getElementById('bp-emoji');
  if (bpe) bpe.textContent = emoji;
  markDirty('booster');
}
function updateBoostPreview() {
  const preview = document.getElementById('boost-card-preview');
  if (preview) preview.style.background = GRADS[boostGrad] || GRADS.forest;
  const bpmsg = document.getElementById('bp-msg');
  const msgInput = document.getElementById('cfg-boost-msg');
  if (bpmsg && msgInput) bpmsg.textContent = msgInput.value || '💎 {user} just boosted {server}!';
}
async function fetchBoostStats() {
  if (!currentGuild) return;
  try {
    const res  = await fetch(`${BOT_API}/booster/stats?guild_id=${currentGuild.id}`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const data = await res.json();
    const bt = document.getElementById('boost-total');
    const bu = document.getElementById('boost-unique');
    const bl = document.getElementById('boost-level');
    if (bt) bt.textContent = data.total_boosts || '—';
    if (bu) bu.textContent = data.unique_boosters || '—';
    if (bl) bl.textContent = data.server_level || '—';
  } catch { /* no boost data yet */ }
}

// ══════════════════════════════════════════════════════════════
//  AUDIT LOG
// ══════════════════════════════════════════════════════════════
async function fetchAuditLog() {
  const c = document.getElementById('audit-log-list');
  if (!c) return;
  c.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading audit log from MongoDB…</p></div>`;
  try {
    const guildParam = currentGuild ? `&guild_id=${currentGuild.id}` : '';
    const res  = await fetch(`${BOT_API}/audit/log?limit=200${guildParam}`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error('failed');
    allLogEntries = data.entries || [];

    // Update badge count
    const badge = document.getElementById('log-badge');
    if (badge) badge.textContent = allLogEntries.length;

    renderLog();
  } catch {
    c.innerHTML = `<div class="loading-state">
      <p>❌ Audit log not available.</p>
      <p style="font-size:0.78rem;color:var(--tx-3);margin-top:6px">Add <code style="color:var(--green)">GET /audit/log</code> to your bot API to display MongoDB mod logs here.</p>
      <button class="btn-sm-o" onclick="fetchAuditLog()" style="margin-top:10px">🔄 Retry</button>
    </div>`;
  }
}

function filterLog(filter, btn) {
  auditLogFilter = filter;
  auditLogPage   = 1;
  document.querySelectorAll('#log-filters .log-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderLog();
}

function logPage(dir) {
  auditLogPage = Math.max(1, auditLogPage + dir);
  renderLog();
}

const LOG_ICONS = { ban:'🔨', kick:'👢', timeout:'⏱', mute:'🔇', warn:'⚠️', delete:'🗑', join:'✅', leave:'🚪', unban:'🔓', unmute:'🔊' };
const PER_PAGE  = 20;

function renderLog() {
  const c = document.getElementById('audit-log-list');
  const pg = document.getElementById('log-pagination');
  if (!c) return;

  const filtered = auditLogFilter === 'all'
    ? allLogEntries
    : allLogEntries.filter(e => e.action === auditLogFilter);

  const total     = Math.ceil(filtered.length / PER_PAGE) || 1;
  auditLogPage    = Math.min(auditLogPage, total);
  const slice     = filtered.slice((auditLogPage-1)*PER_PAGE, auditLogPage*PER_PAGE);

  if (!slice.length) {
    c.innerHTML = `<div class="loading-state"><p>No log entries found.</p></div>`;
    if (pg) pg.style.display = 'none';
    return;
  }

  c.innerHTML = `<div class="log-list">${slice.map(e => `
    <div class="log-entry ${e.action||''}">
      <div class="log-icon">${LOG_ICONS[e.action]||'📌'}</div>
      <div class="log-body">
        <div class="log-action">
          <span class="log-tag ${e.action||''}">${(e.action||'action').toUpperCase()}</span>
          <strong>${e.target || 'Unknown'}</strong>${e.reason ? ` — ${e.reason}` : ''}
        </div>
        <div class="log-meta">By ${e.moderator||'System'} ${e.guild_name?'in '+e.guild_name:''}</div>
      </div>
      <div class="log-time">${formatTime(e.timestamp)}</div>
    </div>`).join('')}</div>`;

  if (pg) {
    pg.style.display = 'flex';
    const pi = document.getElementById('log-page-info');
    if (pi) pi.textContent = `Page ${auditLogPage} of ${total} (${filtered.length} entries)`;
    const prev = document.getElementById('log-prev');
    const next = document.getElementById('log-next');
    if (prev) prev.disabled = auditLogPage <= 1;
    if (next) next.disabled = auditLogPage >= total;
  }
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60000)   return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
  return d.toLocaleDateString();
}

function exportAuditLog() {
  const data = JSON.stringify(allLogEntries, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `ninjubot_audit_${currentGuild?.name||'log'}_${Date.now()}.json`;
  a.click();
  showToast('⬇ Audit log exported!');
}

// ══════════════════════════════════════════════════════════════
//  PANEL SWITCHING
// ══════════════════════════════════════════════════════════════
function showPanel(name, el) {
  if (event) event.preventDefault();
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sl').forEach(l  => l.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  if (el)   el.classList.add('active');
  const titles = {
    overview:'Overview', stats:'Live Stats', servers:'Server List', leaderboard:'Leaderboards',
    'cfg-bot':'Bot Settings', 'cfg-economy':'Economy Config', 'cfg-levels':'XP & Levels',
    'cfg-welcome':'Welcome / Leave', 'cfg-streams':'Stream Alerts', 'cfg-booster':'Booster Cards',
    'cfg-moderation':'Moderation', 'audit-log':'Audit Log', mongodb:'MongoDB Stats'
  };
  const t = document.getElementById('page-title');
  if (t) t.textContent = titles[name] || name;

  if (name === 'stats')       fetchStats();
  if (name === 'servers')     fetchServerList();
  if (name === 'leaderboard') { fetchEconomy(); fetchLevels(); }
  if (name === 'audit-log')   fetchAuditLog();
  if (name === 'mongodb')     fetchMongoStats();
}

// ══════════════════════════════════════════════════════════════
//  DATA FETCHERS
// ══════════════════════════════════════════════════════════════
async function fetchHealth() {
  try {
    const res  = await fetch(`${BOT_API}/health`);
    const data = await res.json();
    const fmt  = v => typeof v === 'number' ? v.toLocaleString() : (v||'—');
    ['hm-g','st-g'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=fmt(data.guilds); });
    ['hm-u','st-u'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=fmt(data.users); });
    const hmup = document.getElementById('hm-up'); if(hmup) hmup.textContent=(data.uptime||'—').split('.')[0];
    const online = data.status==='online';
    const dot = document.getElementById('status-dot'); const txt = document.getElementById('status-text');
    const ub  = document.getElementById('uptime-badge');
    if (dot) dot.style.background = online ? '#4eff91' : '#faa61a';
    if (txt) txt.textContent = online ? '🟢 Online' : '🟡 Starting…';
    if (ub)  ub.textContent  = 'Uptime: '+(data.uptime||'—').split('.')[0];
    const dm = {
      'd-guilds':fmt(data.guilds),'d-users':fmt(data.users),
      'd-uptime':(data.uptime||'—').split('.')[0],
      'd-status':online?'🟢 Online':'🟡 Starting',
      'd-botname':data.bot_name||'—','d-botid':data.bot_id||'—'
    };
    Object.entries(dm).forEach(([id,v]) => { const el=document.getElementById(id); if(el) el.textContent=v; });
  } catch { const t=document.getElementById('status-text'); if(t) t.textContent='🔴 Offline'; }
}

async function fetchStats() {
  const c = document.getElementById('live-stats-display');
  if (!c) return;
  c.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Fetching…</p></div>`;
  try {
    const res=await fetch(`${BOT_API}/stats`); const data=await res.json();
    if(data.error) throw new Error(data.error);
    c.innerHTML=`<div class="ls-grid">
      <div class="ls-item"><div class="ls-num">${data.guild_count||0}</div><div class="ls-lbl">🌐 Servers</div></div>
      <div class="ls-item"><div class="ls-num">${(data.user_count||0).toLocaleString()}</div><div class="ls-lbl">👥 Users</div></div>
      <div class="ls-item"><div class="ls-num">${data.uptime||'—'}</div><div class="ls-lbl">⏱️ Uptime</div></div>
    </div>
    <div class="info-list">
      <div class="info-row"><span>Bot Name</span><strong>${data.bot_name||'—'}</strong></div>
      <div class="info-row"><span>Bot ID</span><strong>${data.bot_id||'—'}</strong></div>
      <div class="info-row"><span>Guild Count</span><strong>${data.guild_count||0}</strong></div>
      <div class="info-row"><span>Total Users</span><strong>${(data.user_count||0).toLocaleString()}</strong></div>
      <div class="info-row"><span>Status</span><strong style="color:var(--green)">🟢 Online</strong></div>
    </div>`;
  } catch {
    c.innerHTML=`<div class="loading-state"><p>❌ Bot offline or /stats endpoint missing</p><button class="btn-sm-o" onclick="fetchStats()" style="margin-top:8px">🔄 Retry</button></div>`;
  }
}

async function fetchServerList() {
  const c = document.getElementById('servers-list');
  if (!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div><p>Loading…</p></div>`;
  try {
    const res=await fetch(`${BOT_API}/stats`); const data=await res.json();
    if(!data.guilds?.length){c.innerHTML=`<div class="loading-state"><p>No server data in API.</p></div>`;return;}
    c.innerHTML=`<div class="srv-grid">${data.guilds.map(g=>`
      <div class="srv-card">
        ${g.icon?`<img src="${g.icon}" class="srv-icon" alt="">`:`<div class="srv-fb">${g.name.charAt(0).toUpperCase()}</div>`}
        <div><div class="srv-name">${g.name}</div><div class="srv-members">👥 ${(g.members||0).toLocaleString()}</div></div>
      </div>`).join('')}</div>`;
  } catch {c.innerHTML=`<div class="loading-state"><p>❌ Could not load servers.</p></div>`;}
}

async function fetchEconomy() {
  const c=document.getElementById('eco-leaderboard');
  if(!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const res=await fetch(`${BOT_API}/economy/leaderboard${currentGuild?'?guild_id='+currentGuild.id:''}`,{headers:{'Authorization':`Bearer ${discordToken}`}});
    const data=await res.json();
    if(!data?.length) throw new Error('empty');
    const max=data[0]?.balance||1;
    const rank=i=>i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1);
    c.innerHTML=`<div class="lb-list">${data.slice(0,10).map((u,i)=>`
      <div class="lb-row ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">
        <div class="lb-rank ${i<3?'r'+(i+1):''}">${rank(i)}</div>
        <div class="lb-name">${u.username||'Unknown'}</div>
        <div class="lb-bar-wrap"><div class="lb-bar" style="width:${Math.round((u.balance/max)*100)}%"></div></div>
        <div class="lb-val">₹${(u.balance||0).toLocaleString()}</div>
      </div>`).join('')}</div>`;
  } catch {c.innerHTML=`<div class="loading-state" style="padding:24px"><p style="font-size:0.8rem">Add <code style="color:var(--green)">GET /economy/leaderboard</code> to your bot</p></div>`;}
}

async function fetchLevels() {
  const c=document.getElementById('levels-leaderboard');
  if(!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const res=await fetch(`${BOT_API}/levels/leaderboard${currentGuild?'?guild_id='+currentGuild.id:''}`,{headers:{'Authorization':`Bearer ${discordToken}`}});
    const data=await res.json();
    if(!data?.length) throw new Error('empty');
    const max=data[0]?.xp||1;
    const rank=i=>i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1);
    c.innerHTML=`<div class="lb-list">${data.slice(0,10).map((u,i)=>`
      <div class="lb-row ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">
        <div class="lb-rank ${i<3?'r'+(i+1):''}">${rank(i)}</div>
        <div class="lb-name">${u.username||'Unknown'}</div>
        <div style="font-size:0.7rem;color:var(--tx-3);font-family:var(--font-m)">Lv.${u.level||0}</div>
        <div class="lb-bar-wrap"><div class="lb-bar" style="width:${Math.round((u.xp/max)*100)}%"></div></div>
        <div class="lb-val">${(u.xp||0).toLocaleString()} XP</div>
      </div>`).join('')}</div>`;
  } catch {c.innerHTML=`<div class="loading-state" style="padding:24px"><p style="font-size:0.8rem">Add <code style="color:var(--green)">GET /levels/leaderboard</code> to your bot</p></div>`;}
}

async function fetchMongoStats() {
  const c=document.getElementById('mongo-display');
  if(!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div><p>Connecting…</p></div>`;
  try {
    const res=await fetch(`${BOT_API}/db/stats`,{headers:{'Authorization':`Bearer ${discordToken}`}});
    const data=await res.json();
    if(data.error) throw new Error(data.error);
    c.innerHTML=`<div class="ls-grid" style="grid-template-columns:repeat(4,1fr)">
      <div class="ls-item"><div class="ls-num">${data.users||'—'}</div><div class="ls-lbl">👥 Users</div></div>
      <div class="ls-item"><div class="ls-num">${data.guilds||'—'}</div><div class="ls-lbl">🌐 Guilds</div></div>
      <div class="ls-item"><div class="ls-num">${data.economy_entries||'—'}</div><div class="ls-lbl">💰 Economy</div></div>
      <div class="ls-item"><div class="ls-num">${data.xp_entries||'—'}</div><div class="ls-lbl">📈 XP</div></div>
    </div>
    <div class="info-list" style="margin-top:16px">
      <div class="info-row"><span>Collections</span><strong>${data.collections||'—'}</strong></div>
      <div class="info-row"><span>Total Documents</span><strong>${(data.total_documents||0).toLocaleString()}</strong></div>
      <div class="info-row"><span>Last Sync</span><strong>${data.last_sync||new Date().toLocaleTimeString()}</strong></div>
    </div>`;
  } catch {
    c.innerHTML=`<div class="loading-state"><p>❌ Add <code>GET /db/stats</code> to your bot API</p><button class="btn-sm-o" onclick="fetchMongoStats()" style="margin-top:8px">🔄 Retry</button></div>`;
  }
}

// ══════════════════════════════════════════════════════════════
//  LANDING PAGE TABS
// ══════════════════════════════════════════════════════════════
function showTab(tab, btn) {
  document.querySelectorAll('.cpanel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ctab').forEach(b=>b.classList.remove('active'));
  const p=document.getElementById('p-'+tab); if(p) p.classList.add('active');
  if(btn) btn.classList.add('active');
}

// ══════════════════════════════════════════════════════════════
//  MOBILE NAV
// ══════════════════════════════════════════════════════════════
function toggleMenu() {
  const nav=document.querySelector('.nav-links');
  if(!nav) return;
  const open=nav.dataset.open==='1';
  nav.dataset.open=open?'0':'1';
  if(!open){
    Object.assign(nav.style,{display:'flex',flexDirection:'column',position:'absolute',top:'68px',right:'20px',background:'var(--surface)',padding:'16px',borderRadius:'var(--r-lg)',boxShadow:'var(--neu-out)',gap:'4px',minWidth:'200px',border:'1px solid var(--green-border)'});
    nav.querySelectorAll('.nl').forEach(l=>l.style.display='block');
  } else {
    nav.style.display='';
    nav.querySelectorAll('.nl').forEach(l=>l.style.display='');
  }
}

// ══════════════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════════════
function showToast(msg, type='success') {
  const wrap=document.getElementById('toast-wrap');
  if(!wrap) return;
  const t=document.createElement('div');
  t.className='toast'+(type==='error'?' error':type==='warn'?' warn':'');
  t.textContent=msg;
  wrap.appendChild(t);
  setTimeout(()=>t.remove(),3200);
}

// ══════════════════════════════════════════════════════════════
//  SCROLL REVEAL
// ══════════════════════════════════════════════════════════════
function initReveal() {
  const obs=new IntersectionObserver((entries)=>{
    entries.forEach((e,i)=>{if(e.isIntersecting) setTimeout(()=>e.target.classList.add('in'),i*50);});
  },{threshold:0.08});
  document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));
  document.querySelectorAll('.fc').forEach((el,i)=>{
    el.style.opacity='0'; el.style.transform='translateY(22px)';
    el.style.transition=`opacity 0.5s var(--ease) ${i*0.05}s,transform 0.5s var(--ease) ${i*0.05}s`;
    obs.observe(el);
  });
}

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

// ── Admin config ──────────────────────────────────────────────
// Only this Discord user ID sees the Database / MongoDB section
const ADMIN_USER_ID = '769225445803032617';

// ── Discord OAuth2 config ──────────────────────────────────
// Replace CLIENT_ID with your actual Discord application client ID
const DISCORD_CLIENT_ID    = '1483732014380224552';
// Hardcoded to exactly match the URI registered in Discord Developer Portal → OAuth2 → Redirects
const DISCORD_REDIRECT_URI = encodeURIComponent('https://sohamdasbiswas.github.io/NinjuBot-dashboard/dashboard.html');
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
let lbScope        = 'server';  // 'server' or 'global'
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
//  ADMIN — show/hide privileged sections
// ══════════════════════════════════════════════════════════════

function isAdmin() {
  return currentUser && String(currentUser.id) === ADMIN_USER_ID;
}

function applyAdminVisibility() {
  const adminSection = document.getElementById('admin-sidebar-section');
  if (adminSection) {
    adminSection.style.display = isAdmin() ? '' : 'none';
  }

  // Economy panel — fully unlock for admin
  const ecoSaveBar = document.getElementById('eco-save-bar');
  if (ecoSaveBar) ecoSaveBar.style.display = isAdmin() ? 'flex' : 'none';
  if (isAdmin()) {
    document.querySelectorAll('#panel-cfg-economy input, #panel-cfg-economy select').forEach(el => {
      el.disabled = false;
      el.style.opacity = '';
      el.style.cursor = '';
    });
    // re-attach oninput for range sliders
    const cdDaily = document.getElementById('cfg-daily-cd');
    if (cdDaily) cdDaily.oninput = function(){ document.getElementById('cfg-daily-cd-val').textContent=this.value+'h'; markDirty('economy'); };
    const cdWork = document.getElementById('cfg-work-cd');
    if (cdWork) cdWork.oninput = function(){ document.getElementById('cfg-work-cd-val').textContent=this.value+'m'; markDirty('economy'); };
    // re-attach oninput for number inputs
    ['cfg-daily-min','cfg-daily-max','cfg-work-min','cfg-work-max','cfg-gamble-min','cfg-gamble-max','cfg-start-balance'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.oninput = () => markDirty('economy');
    });
    const gambling = document.getElementById('cfg-gambling');
    if (gambling) gambling.onchange = () => markDirty('economy');
  }

  // If non-admin somehow lands on mongodb/currency-admin panel, redirect to overview
  if (!isAdmin()) {
    const mongoPanel = document.getElementById('panel-mongodb');
    if (mongoPanel && mongoPanel.classList.contains('active')) {
      showPanel('overview', document.querySelector('.sl.active'));
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  BOOT — decide which screen to show
// ══════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  const isDashboard = !!document.getElementById('oauth-gate');

  // ── Landing page (index.html) ──────────────────────────────
  if (!isDashboard) {
    fetchHealth();
    setInterval(fetchHealth, 30000);
    initReveal();
    return;
  }

  // ── Dashboard page (dashboard.html) ───────────────────────
  // Handle OAuth2 callback (?code=xxx in URL)
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (code) {
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

  fetchHealth();
  setInterval(fetchHealth, 30000);
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
  sessionStorage.removeItem('current_guild');
  currentGuild = null;
  document.getElementById('oauth-gate').style.display         = 'none';
  document.getElementById('server-picker-page').style.display = 'block';
  document.getElementById('dashboard-app').style.display      = 'none';
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
  document.getElementById('oauth-gate').style.display         = 'none';
  document.getElementById('server-picker-page').style.display = 'none';
  document.getElementById('dashboard-app').style.display      = 'flex';
  populateUserUI();
  applyAdminVisibility();
  loadSettings();
  loadChannels();
  fetchBoostStats();
  fetchHealth();
  fetchHealth();
}


// ══════════════════════════════════════════════════════════════
//  CHANNELS — populate all channel dropdowns
// ══════════════════════════════════════════════════════════════

let _cachedChannels = [];

async function loadChannels() {
  if (!discordToken || !currentGuild) return;
  try {
    const res = await fetch(`${BOT_API}/channels?guild_id=${currentGuild.id}`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const channels = await res.json();
    if (!Array.isArray(channels) || channels.length === 0) {
      // fallback: show text inputs so user can still enter manually
      populateChannelDropdowns([]);
      return;
    }
    _cachedChannels = channels;
    populateChannelDropdowns(channels);
  } catch (e) {
    console.warn('Could not load channels:', e);
    populateChannelDropdowns([]);
  }
}

function populateChannelDropdowns(channels) {
  const channelSelectIds = [
    'cfg-welcome-channel',
    'cfg-leave-channel',
    'cfg-boost-channel',
    'cfg-modlog-channel',
    'cfg-yt-alert-channel',
    'cfg-tw-alert-channel',
  ];

  if (!channels || channels.length === 0) {
    // Bot can't see this guild's channels — swap selects for text inputs
    channelSelectIds.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const val = el.value || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.className = 'f-input';
      input.placeholder = 'Paste Channel ID';
      input.value = val;
      input.oninput = () => markDirty('welcome');
      el.replaceWith(input);
    });
    return;
  }

  // Group by category
  const cats = {};
  channels.forEach(ch => {
    const cat = ch.category || 'Uncategorized';
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(ch);
  });

  channelSelectIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const currentVal = el.value;
    el.innerHTML = '<option value="">— Select a channel —</option>';
    Object.entries(cats).forEach(([cat, chs]) => {
      const grp = document.createElement('optgroup');
      grp.label = cat;
      chs.forEach(ch => {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = '# ' + ch.name;
        grp.appendChild(opt);
      });
      el.appendChild(grp);
    });
    if (currentVal) el.value = currentVal;
  });
}

// Re-populate dropdowns after settings are loaded (so saved values are selected)
function applyChannelValues(settings) {
  const map = {
    'cfg-welcome-channel': settings.welcome_channel_id,
    'cfg-leave-channel':   settings.leave_channel_id,
    'cfg-boost-channel':   settings.boost_channel_id,
    'cfg-modlog-channel':  settings.modlog_channel_id,
    'cfg-yt-alert-channel':settings.yt_alert_channel_id,
    'cfg-tw-alert-channel':settings.tw_alert_channel_id,
  };
  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  });
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
  // Apply saved channel IDs to dropdowns after channels load
  if (_cachedChannels.length) applyChannelValues(d); else setTimeout(()=>applyChannelValues(d), 1500);
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
  c.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading server audit log…</p></div>`;
  try {
    if (!currentGuild) throw new Error('No guild selected');
    const res  = await fetch(`${BOT_API}/server/audit-log?guild_id=${currentGuild.id}&limit=100`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    allLogEntries = data.entries || [];
    const badge = document.getElementById('log-badge');
    if (badge) badge.textContent = allLogEntries.length;
    renderLog();
  } catch(err) {
    c.innerHTML = `<div class="loading-state">
      <p>❌ Could not load server audit log.</p>
      <p style="font-size:0.78rem;color:var(--tx-3);margin-top:6px">${err.message}</p>
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

const LOG_ICONS = { ban:'🔨', unban:'🔓', kick:'👢', timeout:'⏱', untimeout:'🔊', mute:'🔇', unmute:'🔊', warn:'⚠️', purge:'🧹', delete:'🗑️', edit:'✏️', join:'✅', leave:'🚪', nick:'✏️', role_add:'➕', role_remove:'➖', role_create:'🎭', role_delete:'🗑️', role_rename:'🏷️', channel_create:'📢', channel_delete:'🗑️', channel_rename:'📝', voice_join:'🎙️', voice_leave:'🔇', voice_move:'🔀', invite_create:'🔗', invite_delete:'❌', server_rename:'🏠', emoji_add:'😀', emoji_remove:'🗑️', slowmode:'🐢', lock:'🔒', unlock:'🔓',
  member_ban_add:'🔨', member_ban_remove:'🔓', member_kick:'👢', member_update:'✏️', member_role_update:'🏷️',
  message_delete:'🗑️', message_bulk_delete:'🧹', channel_update:'📝', role_update:'🏷️',
  guild_update:'🏠', bot_add:'🤖', invite_create:'🔗',
};
const PER_PAGE  = 20;

function renderLog() {
  const c = document.getElementById('audit-log-list');
  const pg = document.getElementById('log-pagination');
  if (!c) return;

  const multiFilters = {
    'voice_join':     ['voice_join','voice_leave','voice_move'],
    'role_add':       ['role_add','role_remove','role_create','role_delete','role_rename'],
    'channel_create': ['channel_create','channel_delete','channel_rename'],
    'invite_create':  ['invite_create','invite_delete'],
  };
  const filtered = auditLogFilter === 'all'
    ? allLogEntries
    : allLogEntries.filter(e => multiFilters[auditLogFilter]
        ? multiFilters[auditLogFilter].includes(e.action)
        : e.action === auditLogFilter);

  const total     = Math.ceil(filtered.length / PER_PAGE) || 1;
  auditLogPage    = Math.min(auditLogPage, total);
  const slice     = filtered.slice((auditLogPage-1)*PER_PAGE, auditLogPage*PER_PAGE);

  if (!slice.length) {
    c.innerHTML = `<div class="loading-state"><p>No log entries found.</p></div>`;
    if (pg) pg.style.display = 'none';
    return;
  }

  c.innerHTML = `<div class="log-list">${slice.map(e => {
    const action = e.action || 'unknown';
    const label  = action.toUpperCase().replace(/_/g,' ');
    const icon   = LOG_ICONS[action] || '📌';
    // Strip numeric Discord IDs from names
    const clean  = s => (s||'').replace(/\s*\(\d{10,20}\)/g,'').replace(/#0$/,'').trim() || s || '?';
    return `
    <div class="log-entry ${action}">
      <div class="log-icon">${icon}</div>
      <div class="log-body">
        <div class="log-action">
          <span class="log-tag ${action}">${label}</span>
          <strong>${clean(e.target)}</strong>${e.reason ? ` — ${e.reason}` : ''}
        </div>
        <div class="log-meta">By ${clean(e.moderator)} ${e.guild_name?'in '+e.guild_name:''}</div>
      </div>
      <div class="log-time">${formatTime(e.timestamp)}</div>
    </div>`;
  }).join('')}</div>`;

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
  // Always scroll the panels container back to top when switching panels
  const panelsEl = document.querySelector('.panels');
  if (panelsEl) panelsEl.scrollTop = 0;
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
  if (name === 'admin-hq')    hqLoad();
}

// ══════════════════════════════════════════════════════════════
//  DATA FETCHERS
// ══════════════════════════════════════════════════════════════
// Live uptime ticker — increments every second so it feels real-time
let _uptimeSeconds = 0;
let _uptimeTicker  = null;

function startUptimeTicker(uptimeStr) {
  // Parse "H:MM:SS" into total seconds
  const parts = (uptimeStr || '0:00:00').split(':').map(Number);
  _uptimeSeconds = (parts[0]||0)*3600 + (parts[1]||0)*60 + (parts[2]||0);
  if (_uptimeTicker) clearInterval(_uptimeTicker);
  function tick() {
    _uptimeSeconds++;
    const h = Math.floor(_uptimeSeconds / 3600);
    const m = Math.floor((_uptimeSeconds % 3600) / 60);
    const s = _uptimeSeconds % 60;
    const str = `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    const ids = ['d-uptime', 'hm-up'];
    ids.forEach(id => { const el=document.getElementById(id); if(el) el.textContent=str; });
    const ub = document.getElementById('uptime-badge');
    if (ub) ub.textContent = 'Uptime: ' + str;
  }
  tick(); // run immediately so there's no 1s delay
  _uptimeTicker = setInterval(tick, 1000);
}

async function fetchHealth() {
  try {
    const res  = await fetch(`${BOT_API}/health`);
    const data = await res.json();
    const fmt  = v => typeof v === 'number' ? v.toLocaleString() : (v||'—');
    ['hm-g','st-g'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=fmt(data.guilds); });
    ['hm-u','st-u'].forEach(id => { const el=document.getElementById(id); if(el) el.textContent=fmt(data.users); });
    const online = data.status==='online';
    const dot = document.getElementById('status-dot');
    const txt = document.getElementById('status-text');
    if (dot) dot.style.background = online ? '#4eff91' : '#faa61a';
    if (txt) txt.textContent = online ? '🟢 Online' : '🟡 Starting…';
    const fmt2 = v => typeof v === 'number' ? v.toLocaleString() : (v||'—');
    const dm = {
      'd-guilds': fmt2(data.guilds),
      'd-users':  fmt2(data.users),
      'd-status': online ? '🟢 Online' : '🟡 Starting',
      'd-botname': data.bot_name || '—',
    };
    Object.entries(dm).forEach(([id,v]) => { const el=document.getElementById(id); if(el) el.textContent=v; });
    // Start live uptime ticker synced to real server uptime
    startUptimeTicker(data.uptime || '0:00:00');
  } catch {
    const t=document.getElementById('status-text');
    if(t) t.textContent='🔴 Offline';
  }
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


// ══════════════════════════════════════════════════════════════
//  LEADERBOARD TABS
// ══════════════════════════════════════════════════════════════

function switchLbTab(scope) {
  lbScope = scope;
  const server = document.getElementById('lb-tab-server');
  const global = document.getElementById('lb-tab-global');
  const label  = document.getElementById('lb-scope-label');
  if (server) server.className = scope === 'server' ? 'btn-sm' : 'btn-sm-o';
  if (global) global.className = scope === 'global' ? 'btn-sm' : 'btn-sm-o';
  if (label)  label.textContent = scope === 'server' ? 'Showing: This Server' : 'Showing: Global (all servers)';
  fetchEconomy();
  fetchLevels();
}

async function fetchEconomy() {
  const c=document.getElementById('eco-leaderboard');
  if(!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const scope=lbScope||'server';
    const params=new URLSearchParams({scope});
    if(scope==='server'&&currentGuild) params.set('guild_id',currentGuild.id);
    const res=await fetch(`${BOT_API}/economy/leaderboard?${params}`,{headers:{'Authorization':`Bearer ${discordToken}`}});
    const data=await res.json();
    if(!data?.length){c.innerHTML=`<div class="loading-state" style="padding:24px"><p style="font-size:1.5rem">💰</p><p style="font-size:0.85rem;margin-top:8px;color:var(--tx-2)">No economy data yet.</p><p style="font-size:0.75rem;color:var(--tx-3);margin-top:4px">Members need to use <code style="color:var(--green)">-daily</code> or <code style="color:var(--green)">-work</code> first.</p></div>`;return;}
    const max=data[0]?.balance||1;
    const rank=i=>i===0?'🥇':i===1?'🥈':i===2?'🥉':'#'+(i+1);
    c.innerHTML=`<div class="lb-list">${data.slice(0,10).map((u,i)=>`
      <div class="lb-row ${i===0?'gold':i===1?'silver':i===2?'bronze':''}">
        <div class="lb-rank ${i<3?'r'+(i+1):''}">${rank(i)}</div>
        <div class="lb-name">${u.username||'Unknown'}</div>
        <div class="lb-bar-wrap"><div class="lb-bar" style="width:${Math.round((u.balance/max)*100)}%"></div></div>
        <div class="lb-val">₹${(u.balance||0).toLocaleString()}</div>
      </div>`).join('')}</div>`;
  } catch {c.innerHTML=`<div class="loading-state" style="padding:24px"><p style="font-size:1.5rem">💰</p><p style="font-size:0.85rem;margin-top:8px;color:var(--tx-2)">No economy data yet.</p><p style="font-size:0.75rem;color:var(--tx-3);margin-top:4px">Members need to use <code style="color:var(--green)">-daily</code> or <code style="color:var(--green)">-work</code> first.</p></div>`;}
}

async function fetchLevels() {
  const c=document.getElementById('levels-leaderboard');
  if(!c) return;
  c.innerHTML=`<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const scope=lbScope||'server';
    const params=new URLSearchParams({scope});
    if(scope==='server'&&currentGuild) params.set('guild_id',currentGuild.id);
    const res=await fetch(`${BOT_API}/levels/leaderboard?${params}`,{headers:{'Authorization':`Bearer ${discordToken}`}});
    const data=await res.json();
    if(!data?.length){c.innerHTML=`<div class="loading-state" style="padding:24px"><p style="font-size:1.5rem">📈</p><p style="font-size:0.85rem;margin-top:8px;color:var(--tx-2)">No XP data yet.</p><p style="font-size:0.75rem;color:var(--tx-3);margin-top:4px">Members need to send some messages first to earn XP.</p></div>`;return;}
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
  } catch {c.innerHTML=`<div class="loading-state" style="padding:24px"><p style="font-size:1.5rem">📈</p><p style="font-size:0.85rem;margin-top:8px;color:var(--tx-2)">No XP data yet.</p><p style="font-size:0.75rem;color:var(--tx-3);margin-top:4px">Members need to send some messages first to earn XP.</p></div>`;}
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
//  ADMIN — Currency Manager
// ══════════════════════════════════════════════════════════════

let cadminCurrentUser = null;
const cadminLog = [];

function cadminToggleAmount() {
  const action = document.getElementById('cadmin-action')?.value;
  const field  = document.getElementById('cadmin-amount-field');
  if (field) field.style.display = action === 'reset' ? 'none' : 'flex';
}

async function cadminLookup() {
  const userId = document.getElementById('cadmin-user-id')?.value?.trim();
  if (!userId) return showToast('Enter a user ID first', 'warn');
  if (!currentGuild) return showToast('Select a server first', 'warn');

  const card = document.getElementById('cadmin-user-card');
  if (card) card.style.display = 'none';
  cadminCurrentUser = null;

  try {
    const res  = await fetch(`${BOT_API}/economy/user?guild_id=${currentGuild.id}&user_id=${userId}`, {
      headers: { 'Authorization': `Bearer ${discordToken}` }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lookup failed');

    cadminCurrentUser = { ...data, guild_id: currentGuild.id };

    // Avatar: use hash from bot cache, fall back to default avatar
    const discrim = data.discriminator || '0';
    const defaultAvatar = `https://cdn.discordapp.com/embed/avatars/${parseInt(discrim) % 5}.png`;
    const avatarUrl = data.avatar_hash
      ? `https://cdn.discordapp.com/avatars/${userId}/${data.avatar_hash}.png?size=64`
      : defaultAvatar;
    const avatarEl = document.getElementById('cadmin-avatar');
    avatarEl.src = avatarUrl;
    avatarEl.onerror = function(){ this.src = defaultAvatar; };
    // Show username + discriminator tag (not raw ID)
    const tag = discrim && discrim !== '0' ? `${data.username}#${discrim}` : data.username || 'Unknown';
    document.getElementById('cadmin-uname').textContent = tag;
    document.getElementById('cadmin-uid-display').textContent = `ID: ${userId}`;
    document.getElementById('cadmin-balance').textContent = `₹${(data.balance||0).toLocaleString()}`;
    document.getElementById('cadmin-wl').textContent = `W: ${data.wins||0}  L: ${data.losses||0}`;
    if (card) card.style.display = 'block';

    showToast(`✅ Loaded ${data.username}`);
  } catch(e) {
    showToast('❌ ' + e.message, 'error');
  }
}

async function cadminExecute() {
  if (!cadminCurrentUser) return showToast('Look up a user first', 'warn');

  const action = document.getElementById('cadmin-action')?.value;
  const amount = parseInt(document.getElementById('cadmin-amount')?.value || '0');

  if (action !== 'reset' && (!amount || amount <= 0)) {
    return showToast('Enter a valid amount', 'warn');
  }

  try {
    const res  = await fetch(`${BOT_API}/economy/admin`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${discordToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        guild_id: cadminCurrentUser.guild_id,
        user_id:  cadminCurrentUser.user_id,
        amount,
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    // Update balance display
    document.getElementById('cadmin-balance').textContent = `₹${(data.new_balance||0).toLocaleString()}`;
    cadminCurrentUser.balance = data.new_balance;

    // Add to log
    const actionLabels = { add:'➕ Added', remove:'➖ Removed', set:'⚙️ Set to', reset:'🔄 Reset' };
    const amountStr    = action === 'reset' ? '' : ` ₹${amount.toLocaleString()}`;
    cadminAddLog(actionLabels[action] + amountStr, data.username, data.old_balance, data.new_balance);

    showToast(`✅ Done! New balance: ₹${(data.new_balance||0).toLocaleString()}`);
  } catch(e) {
    showToast('❌ ' + e.message, 'error');
  }
}

function cadminAddLog(action, username, oldBal, newBal) {
  const log = document.getElementById('cadmin-log');
  if (!log) return;

  const diff    = newBal - oldBal;
  const diffStr = diff >= 0 ? `+₹${diff.toLocaleString()}` : `-₹${Math.abs(diff).toLocaleString()}`;
  const color   = diff >= 0 ? 'var(--green)' : '#ff6b6b';
  const time    = new Date().toLocaleTimeString();

  // Clear empty state
  if (log.querySelector('div[style*="No actions"]')) log.innerHTML = '';

  const entry = document.createElement('div');
  entry.style.cssText = 'background:var(--base-down);border-radius:var(--r-md);padding:10px 14px;border:1px solid rgba(78,255,145,0.08);display:flex;align-items:center;gap:10px';
  entry.innerHTML = `
    <div style="flex:1">
      <div style="font-size:0.82rem;font-weight:700">${action} — <span style="color:var(--tx-2)">${username}</span></div>
      <div style="font-size:0.7rem;color:var(--tx-3);margin-top:2px">${time} · ₹${oldBal.toLocaleString()} → ₹${newBal.toLocaleString()}</div>
    </div>
    <div style="font-family:var(--font-d);font-weight:800;font-size:0.95rem;color:${color}">${diffStr}</div>`;
  log.prepend(entry);
}

function cadminClearLog() {
  const log = document.getElementById('cadmin-log');
  if (log) log.innerHTML = '<div style="text-align:center;padding:40px;color:var(--tx-3);font-size:0.8rem">No actions yet</div>';
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
    const fcObs=new IntersectionObserver((entries)=>{
      entries.forEach(e=>{
        if(e.isIntersecting){
          setTimeout(()=>{
            e.target.classList.add('in');
            setTimeout(()=>{ e.target.style.transform=''; e.target.style.transition=''; },600);
          },i*50);
          fcObs.unobserve(e.target);
        }
      });
    },{threshold:0.08});
    fcObs.observe(el);
  });
}

// ══════════════════════════════════════════════════════════════
//  ADMIN HQ
// ══════════════════════════════════════════════════════════════
let _hqInt = null;
const _HQICONS = {ban:'🔨',unban:'🔓',kick:'👢',timeout:'⏱',untimeout:'🔊',warn:'⚠️',purge:'🧹',delete:'🗑️',edit:'✏️',join:'✅',leave:'🚪',nick:'✏️',role_add:'➕',role_remove:'➖',role_create:'🎭',role_delete:'🗑️',role_rename:'🏷️',channel_create:'📢',channel_delete:'🗑️',channel_rename:'📝',voice_join:'🎙️',voice_leave:'🔇',voice_move:'🔀',invite_create:'🔗',invite_delete:'❌',server_rename:'🏠',slowmode:'🐢',lock:'🔒',unlock:'🔓',bot_start:'🚀'};

function hqLoad() {
  hqRefresh();
  if (_hqInt) clearInterval(_hqInt);
  _hqInt = setInterval(hqRefresh, 30000);
}

async function hqRefresh() {
  const ts = document.getElementById('hq__ts');
  if (ts) ts.textContent = 'SYNCING… ' + new Date().toLocaleTimeString('en-GB',{hour12:false});
  const t0 = Date.now();
  await Promise.all([hq_health(), hq_servers(), hq_db(), hq_eco(), hq_xp(), hq_feed()]);
  const p = Date.now() - t0;
  const pe = document.getElementById('hq__ping'); if (pe) pe.textContent = `PING: ${p}ms`;
  if (ts) ts.textContent = 'LAST SYNC: ' + new Date().toLocaleTimeString('en-GB',{hour12:false});
}

function hq_s(id,v){const e=document.getElementById(id);if(e)e.innerHTML=v;}
function hq_fmt(v){return typeof v==='number'?v.toLocaleString():(v||'—');}
function hq_get(url){return fetch(`${BOT_API}${url}`,{headers:{'Authorization':`Bearer ${discordToken}`}});}

async function hq_health(){
  try{
    const d=await(await fetch(`${BOT_API}/health`)).json();
    const on=d.status==='online';
    hq_s('hq__sg',hq_fmt(d.guilds));hq_s('hq__su',hq_fmt(d.users));hq_s('hq__sup',(d.uptime||'—').split('.')[0]);
    hq_s('hq__health',[
      ['STATUS',on?'<span style="color:#4eff91">🟢 ONLINE</span>':'<span style="color:#faa61a">🟡 STARTING</span>'],
      ['BOT',d.bot_name||'—'],['UPTIME',(d.uptime||'—').split('.')[0]],
      ['SERVERS',hq_fmt(d.guilds)],['USERS',hq_fmt(d.users)],
    ].map(([k,v])=>`<div class="hq__hr"><span class="hq__hk">${k}</span><span class="hq__hv">${v}</span></div>`).join(''));
  }catch(e){console.warn('hq_health',e);}
}

async function hq_servers(){
  try{
    const d=await(await fetch(`${BOT_API}/stats`)).json();
    const gs=d.guilds||[];
    hq_s('hq__servers',gs.length?gs.map((g,i)=>`
      <div class="hq__sr">
        <div class="hq__ico">${g.icon?`<img src="${g.icon}" alt="">`:(g.name||'?').charAt(0)}</div>
        <span class="hq__sn">${g.name}</span>
        <span class="hq__sm">👥 ${(g.members||0).toLocaleString()}</span>
        <span class="hq__sm" style="margin-left:6px;opacity:.4">#${i+1}</span>
      </div>`).join(''):'<div class="hq__em">NO SERVERS</div>');
  }catch{hq_s('hq__servers','<div class="hq__em">ERROR</div>');}
}

async function hq_db(){
  try{
    const d=await(await hq_get('/db/stats')).json();
    if(d.error)throw new Error(d.error);
    hq_s('hq__sdb',(d.total_documents||0).toLocaleString());
    hq_s('hq__dbm',[
      ['USERS',d.users||0],['GUILDS',d.guilds||0],['ECONOMY',d.economy_entries||0],
      ['XP',d.xp_entries||0],['COLLECTIONS',d.collections||0],
      ['TOTAL DOCS',(d.total_documents||0).toLocaleString()],['LAST SYNC',d.last_sync||'—'],
    ].map(([k,v])=>`<div class="hq__kv"><span class="hq__kk">${k}</span><span class="hq__vv">${v}</span></div>`).join(''));
  }catch{hq_s('hq__dbm','<div class="hq__em">DB ERROR</div>');}
}

async function hq_eco(){
  try{
    const data=await(await hq_get('/economy/leaderboard?scope=global')).json();
    if(!data.length){hq_s('hq__eco','<div class="hq__em">NO DATA</div>');return;}
    const max=data[0]?.balance||1,M=['🥇','🥈','🥉'];
    hq_s('hq__eco',data.slice(0,10).map((u,i)=>`
      <div class="hq__lb">
        <span class="hq__lr">${M[i]||'#'+(i+1)}</span>
        <span class="hq__ln">${u.username||'Unknown'}</span>
        <div class="hq__bw"><div class="hq__bb" style="width:${Math.round((u.balance/max)*100)}%"></div></div>
        <span class="hq__lv">₹${(u.balance||0).toLocaleString()}</span>
      </div>`).join(''));
  }catch{hq_s('hq__eco','<div class="hq__em">ERROR</div>');}
}

async function hq_xp(){
  try{
    const data=await(await hq_get('/levels/leaderboard?scope=global')).json();
    if(!data.length){hq_s('hq__xp','<div class="hq__em">NO DATA</div>');return;}
    const max=data[0]?.xp||1,M=['🥇','🥈','🥉'];
    hq_s('hq__xp',data.slice(0,10).map((u,i)=>`
      <div class="hq__lb">
        <span class="hq__lr">${M[i]||'#'+(i+1)}</span>
        <span class="hq__ln">${u.username||'Unknown'}</span>
        <div class="hq__bw"><div class="hq__bb" style="width:${Math.round((u.xp/max)*100)}%"></div></div>
        <span class="hq__lv">Lv.${u.level||0}</span>
      </div>`).join(''));
  }catch{hq_s('hq__xp','<div class="hq__em">ERROR</div>');}
}

async function hq_feed(){
  try{
    const data=await(await hq_get('/audit/log?limit=200')).json();
    const entries=data.entries||[];
    hq_s('hq__sal',entries.length);
    const fc=document.getElementById('hq__fc');if(fc)fc.textContent=entries.length+' entries';
    if(!entries.length){hq_s('hq__feed','<div class="hq__em">NO LOG ENTRIES YET</div>');hq_chart([]);return;}
    hq_s('hq__feed',entries.slice(0,60).map(e=>{
      const icon=_HQICONS[e.action]||'📌';
      const time=e.timestamp?new Date(e.timestamp).toLocaleTimeString('en-GB',{hour12:false}):'—';
      const reason=e.reason?` · ${e.reason.substring(0,40)}`:'';
      return `<div class="hq__fe">
        <span class="hq__fi">${icon}</span>
        <div class="hq__fb">
          <div class="hq__fa">[${(e.action||'?').toUpperCase()}] ${e.target||'?'}</div>
          <div class="hq__fm">BY: ${e.moderator||'System'}${e.guild_name?' · '+e.guild_name:''}${reason}</div>
        </div>
        <span class="hq__ft">${time}</span>
      </div>`;
    }).join(''));
    hq_chart(entries);
  }catch(e){hq_s('hq__feed',`<div class="hq__em">ERROR: ${e.message}</div>`);}
}

function hq_chart(entries){
  const canvas=document.getElementById('hq__chart');if(!canvas)return;
  const counts={};
  entries.forEach(e=>{if(e.action)counts[e.action]=(counts[e.action]||0)+1;});
  const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,12);
  if(!sorted.length)return;
  if(canvas._c)canvas._c.destroy();
  canvas._c=new Chart(canvas.getContext('2d'),{
    type:'bar',
    data:{labels:sorted.map(([k])=>k.toUpperCase()),datasets:[{data:sorted.map(([,v])=>v),backgroundColor:'rgba(78,255,145,.15)',borderColor:'#4eff91',borderWidth:1,borderRadius:4,hoverBackgroundColor:'rgba(78,255,145,.3)'}]},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{
      x:{ticks:{color:'rgba(78,255,145,.55)',font:{family:'"Courier New"',size:9}},grid:{color:'rgba(78,255,145,.04)'}},
      y:{ticks:{color:'rgba(78,255,145,.55)',font:{family:'"Courier New"',size:9}},grid:{color:'rgba(78,255,145,.04)'}}
    }}
  });
}

function hqExportAudit(){
  if(!allLogEntries.length)return showToast('No audit entries','warn');
  const csv=['action,target,moderator,reason,guild,timestamp',
    ...allLogEntries.map(e=>[e.action,e.target,e.moderator,e.reason,e.guild_name,e.timestamp]
      .map(v=>`"${(v||'').toString().replace(/"/g,'""')}"`).join(','))].join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=`audit_${Date.now()}.csv`;a.click();showToast('✅ Exported');
}

async function hqExportEco(){
  try{
    const data=await(await hq_get('/economy/leaderboard?scope=global')).json();
    if(!data.length)return showToast('No economy data','warn');
    const csv=['username,user_id,balance,wins,losses',
      ...data.map(u=>`"${u.username}","${u.user_id}","${u.balance}","${u.wins||0}","${u.losses||0}"`)].join('\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    a.download=`economy_${Date.now()}.csv`;a.click();showToast('✅ Exported');
  }catch{showToast('❌ Export failed','error');}
}

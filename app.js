'use strict';

/*
 * Left Alone - UI layer.
 * All network traffic is one shape: POST to
 * https://gen.pollinations.ai/v1/chat/completions, paid with the
 * visitor's own key from localStorage. Nothing else is called
 * except the one key validation read of /account/balance.
 */

var core = window.LeftAlone;

var els = {};
var world = null;
var lastSayings = {}; // agent id -> { action, saying, simulated }
var autoTimer = null;
var dayRunning = false;

function $(id) { return document.getElementById(id); }

function loadWorld() {
  try {
    var raw = localStorage.getItem(core.WORLD_STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.agents && parsed.tiles) return parsed;
    }
  } catch (e) { /* fall through to a fresh island */ }
  return core.createWorld();
}

function saveWorld() {
  try { localStorage.setItem(core.WORLD_STORAGE_KEY, JSON.stringify(world)); } catch (e) {}
}

function getKey() {
  try { return localStorage.getItem(core.STORAGE_KEY) || ''; } catch (e) { return ''; }
}

function setKey(key) {
  try {
    if (key) localStorage.setItem(core.STORAGE_KEY, key);
    else localStorage.removeItem(core.STORAGE_KEY);
  } catch (e) {}
  renderMode();
}

function currentModel() {
  var custom = els.customModel.value.trim();
  if (custom) return custom;
  return els.modelSelect.value || core.MODELS[0].id;
}

function renderMode() {
  var hasKey = !!getKey();
  els.modeBadge.textContent = hasKey ? 'Live mode - real model days' : 'Demo mode - simulated days';
  els.modeBadge.className = 'badge ' + (hasKey ? 'badge-live' : 'badge-demo');
  els.keyStatus.textContent = hasKey ? 'Key set in this browser' : 'No key set';
  els.demoBanner.hidden = hasKey;
}

function tileChar(tile) {
  var chars = {
    water: '~', shore: '.', meadow: 'g', forest: 'f', grove: 'o',
    spring: 's', rocks: 'r', clearing: 'c'
  };
  return chars[tile.type] || '?';
}

function render() {
  els.dayTitle.textContent = 'Day ' + world.day;
  els.weatherLine.textContent = 'Weather: ' + world.weather;

  els.islandGrid.innerHTML = '';
  world.tiles.forEach(function (tile) {
    var cell = document.createElement('div');
    cell.className = 'cell cell-' + tile.type;
    var here = world.agents.filter(function (a) { return a.x === tile.x && a.y === tile.y; });
    var html = '<span class="tile-char">' + tileChar(tile) + '</span>';
    if (tile.resource && tile.resourceAmount > 0) {
      html += '<span>' + tile.resourceAmount + ' ' + tile.resource + '</span>';
    }
    if (here.length) {
      html += '<span class="agents-here">' + here.map(function (a) { return a.marker; }).join(' ') + '</span>';
    }
    if (tile.structure) html += '<span class="structure" title="' + tile.structure + '">^ ' + tile.structure + '</span>';
    cell.innerHTML = html;
    cell.title = core.describeTile(tile) + (here.length ? ' - here: ' + here.map(function (a) { return a.name; }).join(', ') : '');
    els.islandGrid.appendChild(cell);
  });

  els.agentCards.innerHTML = '';
  world.agents.forEach(function (agent) {
    var tile = core.tileAt(world, agent.x, agent.y);
    var card = document.createElement('div');
    card.className = 'agent-card';
    var last = lastSayings[agent.id];
    var html = '<h4>' + agent.marker + ' - ' + agent.name + '</h4>' +
      '<p class="personality">' + agent.personality + '</p>' +
      '<div class="stat">At the ' + (tile ? tile.label : '?') + ' (' + agent.x + ',' + agent.y + ')</div>' +
      '<div class="stat">Energy ' + agent.energy + ' - Hunger ' + agent.hunger + ' - Mood ' + agent.mood + '</div>' +
      '<div class="stat">Carries: ' + agent.inventory.food + ' food, ' + agent.inventory.wood + ' wood, ' +
        agent.inventory.stone + ' stone, ' + agent.inventory.water + ' water</div>' +
      '<div class="stat">' + core.relationshipSummary(world, agent) + '</div>';
    if (last) {
      html += '<div class="last-action">Last: ' + last.action +
        (last.simulated ? ' (simulated, demo mode)' : '') + '</div>';
      if (last.saying) html += '<p class="saying">"' + last.saying + '"</p>';
    }
    card.innerHTML = html;
    els.agentCards.appendChild(card);
  });

  els.worldLog.innerHTML = '';
  var recent = world.log.slice(-40).slice().reverse();
  if (!recent.length) {
    els.worldLog.innerHTML = '<p class="empty">Nothing has happened yet.</p>';
  }
  recent.forEach(function (entry) {
    var div = document.createElement('div');
    div.className = 'log-entry kind-' + entry.kind;
    div.innerHTML = '<span class="log-day">Day ' + entry.day + '</span>';
    div.appendChild(document.createTextNode(entry.text));
    els.worldLog.appendChild(div);
  });

  els.diaries.innerHTML = '';
  world.agents.forEach(function (agent) {
    var book = document.createElement('div');
    book.className = 'diary-book';
    var html = '<h4>' + agent.name + "'s diary</h4>";
    if (!agent.diary.length) html += '<p class="empty">No entries yet.</p>';
    agent.diary.slice().reverse().forEach(function (entry) {
      html += '<div class="diary-entry">' + entry.text + '</div>';
    });
    book.innerHTML = html;
    els.diaries.appendChild(book);
  });
}

async function callModel(modelId, prompt, key) {
  var res = await fetch(core.API_BASE + core.CHAT_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + key
    },
    body: JSON.stringify(core.buildChatRequest(modelId, prompt))
  });
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    var msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    throw new Error(String(msg));
  }
  var parsed = core.parseChatResponse(data);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.text;
}

// One agent, one day. Live: one model call, one retry on an illegal
// answer, then a wait fallback which is logged as such. Demo: a
// simulated decision, labelled simulated everywhere it shows.
async function runAgentDay(agent) {
  var key = getKey();
  var modelId = currentModel();

  if (!key) {
    var demo = core.demoDecision(world, agent);
    core.applyDecision(world, agent, demo);
    lastSayings[agent.id] = { action: demo.action, saying: demo.saying, simulated: true };
    world.log.push({ day: world.day, kind: 'note', text: agent.name + "'s day was simulated (demo mode, no key)." });
    return;
  }

  var prompt = core.buildAgentPrompt(world, agent);
  var decision = null;
  var lastError = '';
  for (var attempt = 0; attempt < 2 && !decision; attempt++) {
    var text = await callModel(modelId, prompt, key);
    var parsed = core.parseAgentDecision(text);
    if (parsed.ok) {
      var check = core.validateDecision(world, agent, parsed);
      if (check.ok) decision = parsed;
      else lastError = check.error;
    } else {
      lastError = parsed.error;
    }
    if (!decision && attempt === 0) {
      prompt = prompt + '\n\nYour last answer was not usable: ' + lastError +
        '. Answer again with strict JSON only, in exactly the shape above, with a legal action and target.';
    }
  }
  if (!decision) {
    decision = { ok: true, action: 'wait', target: '', saying: '' };
    world.log.push({ day: world.day, kind: 'note', text: agent.name + ' gave no usable answer (' + lastError + ') and waited out the day.' });
  }
  core.applyDecision(world, agent, decision);
  lastSayings[agent.id] = { action: decision.action, saying: decision.saying, simulated: false };
}

async function runDay() {
  if (dayRunning) return;
  dayRunning = true;
  els.dayBtn.disabled = true;
  els.autoBtn.disabled = true;
  try {
    // Agents act one at a time, in a fixed order. Each one sees the
    // world as the earlier agents left it today. That is on purpose:
    // meetings, gifts and races for the same patch of forest happen.
    for (var i = 0; i < world.agents.length; i++) {
      await runAgentDay(world.agents[i]);
      render();
    }
    core.endDay(world);
    saveWorld();
    render();
  } catch (e) {
    els.keyMessage.textContent = 'Day failed partway: ' + e.message + ' State was kept as it stands.';
  } finally {
    dayRunning = false;
    els.dayBtn.disabled = false;
    els.autoBtn.disabled = false;
  }
}

function stopAuto() {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
    els.autoBtn.textContent = 'Auto-run days';
  }
}

function toggleAuto() {
  if (autoTimer) { stopAuto(); return; }
  runDay();
  autoTimer = setInterval(function () {
    if (!dayRunning) runDay();
  }, 4000);
  els.autoBtn.textContent = 'Stop auto-run';
}

async function validateKeyLive() {
  var checked = core.validateKey(els.keyInput.value);
  if (!checked.ok) {
    els.keyMessage.textContent = checked.error;
    return;
  }
  els.keyMessage.textContent = 'Checking key against the account balance endpoint...';
  try {
    var res = await fetch(core.API_BASE + '/account/balance', {
      headers: { 'Authorization': 'Bearer ' + checked.key }
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      els.keyMessage.textContent = 'Key rejected by the API: HTTP ' + res.status + '. It was not saved.';
      return;
    }
    setKey(checked.key);
    var balance = data && data.accountBalance ? data.accountBalance.total : (data ? data.balance : null);
    els.keyMessage.textContent = 'Key works and is saved in this browser only.' +
      (balance !== null && balance !== undefined ? ' Account balance: ' + balance + ' Pollen.' : '');
    renderMode();
  } catch (e) {
    els.keyMessage.textContent = 'Could not reach gen.pollinations.ai: ' + e.message;
  }
}

function init() {
  ['modeBadge', 'keyStatus', 'keyInput', 'validateKeyBtn', 'clearKeyBtn', 'keyMessage',
   'modelSelect', 'customModel', 'dayBtn', 'autoBtn', 'resetBtn', 'demoBanner',
   'dayTitle', 'weatherLine', 'islandGrid', 'agentCards', 'worldLog', 'diaries'
  ].forEach(function (id) { els[id] = $(id); });

  core.MODELS.forEach(function (m) {
    var opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label + ' - ' + m.id;
    els.modelSelect.appendChild(opt);
  });
  els.modelSelect.value = core.MODELS[1].id; // GLM 5.3 Flash, cheap and not paid-only

  var savedKey = getKey();
  if (savedKey) els.keyInput.value = savedKey;

  world = loadWorld();
  renderMode();
  render();

  els.validateKeyBtn.addEventListener('click', validateKeyLive);
  els.clearKeyBtn.addEventListener('click', function () {
    els.keyInput.value = '';
    setKey('');
    els.keyMessage.textContent = 'Key cleared from this browser.';
  });
  els.dayBtn.addEventListener('click', runDay);
  els.autoBtn.addEventListener('click', toggleAuto);
  els.resetBtn.addEventListener('click', function () {
    stopAuto();
    world = core.createWorld();
    lastSayings = {};
    saveWorld();
    render();
    els.keyMessage.textContent = 'A new island, three new strangers. Day 1.';
  });
}

document.addEventListener('DOMContentLoaded', init);

/*
 * Left Alone - core world logic.
 * Works in the browser (window.LeftAlone) and in Node (module.exports).
 * No network code lives here. The UI layer passes raw model responses in
 * and this module decides if a decision is legal, applies it to the
 * world, and keeps the diaries and the world log.
 *
 * The point of the app: nobody gives the agents a goal. Each day, each
 * agent reads the world, reads its own diary, and picks one action
 * freely. Whatever happens next is the show.
 */
(function (global) {
  'use strict';

  var API_BASE = 'https://gen.pollinations.ai';
  var CHAT_PATH = '/v1/chat/completions';
  var STORAGE_KEY = 'left_alone_pollinations_key';
  var WORLD_STORAGE_KEY = 'left_alone_world_v1';

  var MODELS = [
    { id: 'openai/gpt-5.4-nano', label: 'GPT-5.4 Nano', paidOnly: false },
    { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', paidOnly: false },
    { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', paidOnly: false },
    { id: 'moonshotai/kimi-k2.6', label: 'Kimi K2.6', paidOnly: false },
    { id: 'mistralai/mistral-large-3', label: 'Mistral Large 3', paidOnly: false },
    { id: 'meta/llama-3.3-70b-instruct', label: 'Llama 3.3 70B', paidOnly: false },
    { id: 'x-ai/grok-4.3', label: 'Grok 4.3', paidOnly: false },
    { id: 'community/morriszdweck/glm-5.3-flash-free', label: 'GLM 5.3 Flash (free, community)', paidOnly: false }
  ];

  var WEATHERS = ['clear', 'breezy', 'rain', 'fog', 'heat', 'storm'];

  // Tile legend used by the island map in createWorld.
  var TILE_TYPES = {
    '~': { type: 'water', label: 'open water', walkable: false, resource: null, maxResource: 0 },
    '.': { type: 'shore', label: 'sandy shore', walkable: true, resource: null, maxResource: 0 },
    'g': { type: 'meadow', label: 'meadow', walkable: true, resource: 'food', maxResource: 4 },
    'f': { type: 'forest', label: 'forest', walkable: true, resource: 'wood', maxResource: 6 },
    'o': { type: 'grove', label: 'fruit grove', walkable: true, resource: 'food', maxResource: 6 },
    's': { type: 'spring', label: 'fresh spring', walkable: true, resource: 'water', maxResource: 10 },
    'r': { type: 'rocks', label: 'rocky outcrop', walkable: true, resource: 'stone', maxResource: 5 },
    'c': { type: 'clearing', label: 'central clearing', walkable: true, resource: null, maxResource: 0 }
  };

  var ISLAND_MAP = [
    '~~~~~~~',
    '~.ffo.~',
    '~.gsf.~',
    '~ggcr.~',
    '~.gfr.~',
    '~.og..~',
    '~~~~~~~'
  ];

  var ACTIONS = [
    'move', 'gather', 'eat', 'drink', 'rest', 'build', 'make',
    'fish', 'explore', 'visit', 'talk', 'give', 'wait'
  ];

  var ACTION_SYNONYMS = {
    walk: 'move', go: 'move', travel: 'move', head: 'move',
    collect: 'gather', harvest: 'gather', chop: 'gather', pick: 'gather',
    sleep: 'rest', nap: 'rest', relax: 'rest',
    construct: 'build',
    craft: 'make', create: 'make', carve: 'make',
    chat: 'talk', speak: 'talk',
    meet: 'visit', find: 'visit',
    share: 'give', offer: 'give',
    watch: 'wait', sit: 'wait', think: 'wait', do_nothing: 'wait', nothing: 'wait'
  };

  var BUILD_TARGETS = {
    shelter: { wood: 3, stone: 0 },
    fire: { wood: 2, stone: 1 },
    garden: { wood: 0, stone: 0, food: 1 },
    store: { wood: 2, stone: 2 },
    signal: { wood: 1, stone: 3 },
    raft: { wood: 5, stone: 0 }
  };

  var MAKE_TARGETS = ['tool', 'basket', 'carving', 'painting', 'song', 'mark'];

  // Seeded rng helper for tests and demo mode. mulberry32.
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function agentDefs() {
    return [
      {
        id: 'bram', name: 'Bram', marker: 'B',
        personality: 'Practical and quiet. Likes solid things, shelter, and work that lasts. Slow to trust, loyal once he does. Says little.',
        x: 3, y: 3
      },
      {
        id: 'sable', name: 'Sable', marker: 'S',
        personality: 'Curious wanderer. Walks far, collects odd things, talks to the weather. Gets bored staying in one place. Notices everything.',
        x: 1, y: 1
      },
      {
        id: 'ivo', name: 'Ivo', marker: 'I',
        personality: 'Social and anxious. Keeps careful notes, checks on the others, worries about being forgotten. Wants the group to stay together.',
        x: 5, y: 4
      }
    ];
  }

  function createWorld(seed) {
    var tiles = [];
    ISLAND_MAP.forEach(function (row, y) {
      row.split('').forEach(function (ch, x) {
        var def = TILE_TYPES[ch];
        tiles.push({
          x: x, y: y,
          type: def.type,
          label: def.label,
          walkable: def.walkable,
          resource: def.resource,
          resourceAmount: def.resource ? def.maxResource : 0,
          maxResource: def.maxResource,
          structure: null
        });
      });
    });

    var agents = agentDefs().map(function (def) {
      var relationships = {};
      agentDefs().forEach(function (other) {
        if (other.id !== def.id) relationships[other.id] = 0;
      });
      return {
        id: def.id, name: def.name, marker: def.marker,
        personality: def.personality,
        x: def.x, y: def.y,
        energy: 80, hunger: 20, mood: 60,
        inventory: { food: 1, wood: 0, stone: 0, water: 0 },
        diary: [],
        relationships: relationships
      };
    });

    var world = {
      version: 1,
      day: 1,
      weather: 'clear',
      width: 7,
      height: 7,
      tiles: tiles,
      agents: agents,
      log: []
    };
    pushLog(world, 'world', 'Three agents woke up on a small island. Nobody told them why, or what to do. Day 1 begins.');
    return world;
  }

  function tileAt(world, x, y) {
    if (x < 0 || y < 0 || x >= world.width || y >= world.height) return null;
    return world.tiles[y * world.width + x] || null;
  }

  function agentById(world, idOrName) {
    if (!idOrName) return null;
    var wanted = String(idOrName).trim().toLowerCase();
    for (var i = 0; i < world.agents.length; i++) {
      var a = world.agents[i];
      if (a.id === wanted || a.name.toLowerCase() === wanted) return a;
    }
    return null;
  }

  function agentsAt(world, x, y, exceptId) {
    return world.agents.filter(function (a) {
      return a.x === x && a.y === y && a.id !== exceptId;
    });
  }

  function pushLog(world, kind, text) {
    world.log.push({ day: world.day, kind: kind, text: text });
    if (world.log.length > 300) world.log = world.log.slice(world.log.length - 300);
  }

  function describeTile(tile) {
    if (!tile) return 'nowhere';
    var s = tile.label + ' (' + tile.x + ',' + tile.y + ')';
    if (tile.resource && tile.resourceAmount > 0) {
      s += ', ' + tile.resourceAmount + ' ' + tile.resource + ' here';
    }
    if (tile.structure) s += ', a ' + tile.structure + ' stands here';
    return s;
  }

  function describeWorld(world, forAgent) {
    var lines = [];
    lines.push('Day ' + world.day + '. Weather today: ' + world.weather + '.');
    lines.push('The island is 7 by 7. Open water surrounds it and cannot be entered.');
    var places = {};
    world.tiles.forEach(function (t) {
      if (!t.walkable) return;
      if (!places[t.type]) places[t.type] = [];
      places[t.type].push(t);
    });
    Object.keys(places).forEach(function (type) {
      var list = places[type].map(function (t) {
        var s = t.x + ',' + t.y;
        if (t.resource) s += ' (' + t.resourceAmount + ' ' + t.resource + ')';
        if (t.structure) s += ' [' + t.structure + ']';
        return s;
      });
      lines.push('- ' + places[type][0].label + ': ' + list.join(' '));
    });
    world.agents.forEach(function (a) {
      if (forAgent && a.id === forAgent.id) return;
      var tile = tileAt(world, a.x, a.y);
      lines.push(a.name + ' is at the ' + (tile ? tile.label : '?') +
        ' (' + a.x + ',' + a.y + '), mood ' + a.mood + '/100.');
    });
    return lines.join('\n');
  }

  /*
   * Parse one raw model response into a decision.
   * Accepts strict JSON, JSON in a code fence, or JSON inside short prose.
   * Returns { ok:true, action, target, saying } or { ok:false, error }.
   */
  function parseAgentDecision(raw) {
    if (raw === null || raw === undefined) return { ok: false, error: 'empty response' };
    var text = String(raw).trim();
    if (!text) return { ok: false, error: 'empty response' };

    var candidate = null;
    var start = text.indexOf('{');
    var end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return { ok: false, error: 'no JSON object in response' };
    try {
      candidate = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      return { ok: false, error: 'response was not valid JSON' };
    }
    if (!candidate || typeof candidate !== 'object') {
      return { ok: false, error: 'JSON was not an object' };
    }

    var rawAction = String(candidate.action || '').trim().toLowerCase().replace(/\s+/g, '_');
    var action = ACTIONS.indexOf(rawAction) !== -1 ? rawAction : ACTION_SYNONYMS[rawAction];
    if (!action) {
      return { ok: false, error: 'unknown or missing action: ' + String(candidate.action || '') };
    }

    var target = candidate.target === null || candidate.target === undefined
      ? '' : String(candidate.target).trim().slice(0, 60);
    var saying = candidate.saying === null || candidate.saying === undefined
      ? '' : String(candidate.saying).trim().slice(0, 240);

    return { ok: true, action: action, target: target, saying: saying };
  }

  /*
   * Check a parsed decision against this world and this agent.
   * Movement, visiting, building and making have real requirements.
   * Most other actions are always legal and simply have weak effects
   * when used in the wrong place, which the events spell out.
   */
  function validateDecision(world, agent, decision) {
    if (!decision || !decision.ok) return { ok: false, error: 'no decision to validate' };
    var action = decision.action;
    var target = (decision.target || '').toLowerCase();

    if (action === 'visit' || action === 'talk' || action === 'give') {
      var other = agentById(world, target);
      if (!other) return { ok: false, error: action + ' needs the name of another agent, got: ' + decision.target };
      if (other.id === agent.id) return { ok: false, error: 'an agent cannot ' + action + ' itself' };
      return { ok: true };
    }
    if (action === 'move') {
      var spot = resolveMoveTarget(world, agent, target);
      if (!spot) return { ok: false, error: 'move target is not a reachable place: ' + decision.target };
      return { ok: true };
    }
    if (action === 'build') {
      if (!BUILD_TARGETS[target]) {
        return { ok: false, error: 'build target must be one of: ' + Object.keys(BUILD_TARGETS).join(', ') };
      }
      var tile = tileAt(world, agent.x, agent.y);
      if (tile.structure) return { ok: false, error: 'this tile already has a ' + tile.structure };
      var cost = BUILD_TARGETS[target];
      if (agent.inventory.wood < (cost.wood || 0) || agent.inventory.stone < (cost.stone || 0) ||
          agent.inventory.food < (cost.food || 0)) {
        return { ok: false, error: 'not enough materials to build a ' + target };
      }
      return { ok: true };
    }
    if (action === 'make') {
      if (MAKE_TARGETS.indexOf(target) === -1) {
        return { ok: false, error: 'make target must be one of: ' + MAKE_TARGETS.join(', ') };
      }
      return { ok: true };
    }
    return { ok: true };
  }

  // Move targets: a tile type ("forest"), a label fragment, or "x,y".
  // Resolves to the nearest walkable tile of that kind, not the current tile.
  function resolveMoveTarget(world, agent, target) {
    var t = String(target || '').trim().toLowerCase();
    if (!t) return null;
    var coord = t.match(/^(\d+)\s*,\s*(\d+)$/);
    var candidates = [];
    if (coord) {
      var tile = tileAt(world, Number(coord[1]), Number(coord[2]));
      if (tile && tile.walkable) candidates = [tile];
    } else {
      candidates = world.tiles.filter(function (tile) {
        return tile.walkable &&
          (tile.type === t || tile.label.toLowerCase().indexOf(t) !== -1);
      });
    }
    candidates = candidates.filter(function (tile) {
      return !(tile.x === agent.x && tile.y === agent.y);
    });
    if (!candidates.length) return null;
    candidates.sort(function (a, b) {
      var da = Math.abs(a.x - agent.x) + Math.abs(a.y - agent.y);
      var db = Math.abs(b.x - agent.x) + Math.abs(b.y - agent.y);
      return da - db;
    });
    return candidates[0];
  }

  function bumpRelationship(world, a, b, delta, log) {
    if (!a || !b || a.id === b.id) return;
    a.relationships[b.id] = clamp((a.relationships[b.id] || 0) + delta, -10, 10);
    b.relationships[a.id] = clamp((b.relationships[a.id] || 0) + delta, -10, 10);
    if (log && delta >= 2) {
      pushLog(world, 'bond', a.name + ' and ' + b.name + ' are getting along (bond ' + a.relationships[b.id] + ').');
    }
  }

  function addDiary(agent, day, text) {
    agent.diary.push({ day: day, text: text });
    var MAX_DIARY = 12;
    if (agent.diary.length > MAX_DIARY) {
      agent.diary = agent.diary.slice(agent.diary.length - MAX_DIARY);
    }
  }

  /*
   * Apply one validated decision. Mutates the world, appends a diary
   * entry for the agent, writes world log lines, and returns the list
   * of event strings produced by this action.
   */
  function applyDecision(world, agent, decision, rng) {
    var random = typeof rng === 'function' ? rng : Math.random;
    var events = [];
    var tile = tileAt(world, agent.x, agent.y);
    var saying = decision.saying || '';
    function note(text) {
      events.push(text);
      pushLog(world, 'action', text);
    }

    switch (decision.action) {
      case 'move': {
        var spot = resolveMoveTarget(world, agent, decision.target);
        agent.x = spot.x; agent.y = spot.y;
        agent.energy = clamp(agent.energy - 8, 0, 100);
        note(agent.name + ' walked to the ' + spot.label + ' (' + spot.x + ',' + spot.y + ').');
        break;
      }
      case 'gather': {
        if (tile.resource && tile.resourceAmount > 0) {
          var amount = Math.min(2, tile.resourceAmount);
          tile.resourceAmount -= amount;
          agent.inventory[tile.resource] += amount;
          agent.energy = clamp(agent.energy - 6, 0, 100);
          note(agent.name + ' gathered ' + amount + ' ' + tile.resource + ' at the ' + tile.label + '.');
        } else {
          note(agent.name + ' looked for supplies at the ' + tile.label + ' and found nothing to gather.');
        }
        break;
      }
      case 'eat': {
        if (agent.inventory.food > 0) {
          agent.inventory.food -= 1;
          agent.hunger = clamp(agent.hunger - 35, 0, 100);
          agent.energy = clamp(agent.energy + 5, 0, 100);
          agent.mood = clamp(agent.mood + 3, 0, 100);
          note(agent.name + ' ate some food.');
        } else {
          agent.mood = clamp(agent.mood - 4, 0, 100);
          note(agent.name + ' wanted to eat but had no food.');
        }
        break;
      }
      case 'drink': {
        if (tile.type === 'spring' || tile.type === 'water') {
          agent.inventory.water = clamp(agent.inventory.water + 1, 0, 9);
          agent.mood = clamp(agent.mood + 2, 0, 100);
          note(agent.name + ' drank from the spring and filled a skin with water.');
        } else if (agent.inventory.water > 0) {
          agent.inventory.water -= 1;
          agent.mood = clamp(agent.mood + 2, 0, 100);
          note(agent.name + ' drank stored water.');
        } else {
          note(agent.name + ' was thirsty and found no water here.');
        }
        break;
      }
      case 'rest': {
        var bonus = tile.structure === 'shelter' ? 35 : 22;
        agent.energy = clamp(agent.energy + bonus, 0, 100);
        agent.hunger = clamp(agent.hunger + 5, 0, 100);
        note(agent.name + ' rested' + (tile.structure === 'shelter' ? ' in the shelter.' : ' where they stood.'));
        break;
      }
      case 'build': {
        var kind = decision.target.toLowerCase();
        var cost = BUILD_TARGETS[kind];
        agent.inventory.wood -= (cost.wood || 0);
        agent.inventory.stone -= (cost.stone || 0);
        agent.inventory.food -= (cost.food || 0);
        tile.structure = kind;
        agent.energy = clamp(agent.energy - 12, 0, 100);
        agent.mood = clamp(agent.mood + 6, 0, 100);
        note(agent.name + ' built a ' + kind + ' at the ' + tile.label + ' (' + tile.x + ',' + tile.y + '). It stays on the island for everyone.');
        break;
      }
      case 'make': {
        var thing = decision.target.toLowerCase();
        if ((thing === 'tool' || thing === 'basket' || thing === 'carving') && agent.inventory.wood > 0) {
          agent.inventory.wood -= 1;
        }
        agent.mood = clamp(agent.mood + 5, 0, 100);
        agent.energy = clamp(agent.energy - 4, 0, 100);
        note(agent.name + ' made a ' + thing + '.');
        break;
      }
      case 'fish': {
        var nearWater = world.tiles.some(function (t) {
          return t.type === 'water' && Math.abs(t.x - agent.x) + Math.abs(t.y - agent.y) === 1;
        });
        if ((tile.type === 'shore' || nearWater) && random() < 0.75) {
          agent.inventory.food += 1;
          note(agent.name + ' fished from the shore and caught something edible.');
        } else if (tile.type === 'shore' || nearWater) {
          note(agent.name + ' fished and caught nothing today.');
        } else {
          note(agent.name + ' tried to fish far from the water. Nothing.');
        }
        agent.energy = clamp(agent.energy - 5, 0, 100);
        break;
      }
      case 'explore': {
        agent.energy = clamp(agent.energy - 7, 0, 100);
        var roll = random();
        if (roll < 0.3) {
          agent.inventory.food += 1;
          note(agent.name + ' explored the ' + tile.label + ' and found edible berries nobody had marked.');
        } else if (roll < 0.5) {
          agent.inventory.stone += 1;
          note(agent.name + ' explored and picked up a smooth, odd stone.');
        } else if (roll < 0.65) {
          agent.mood = clamp(agent.mood + 8, 0, 100);
          note(agent.name + ' explored and found a view of the whole island, and stood there a while.');
        } else {
          note(agent.name + ' explored the ' + tile.label + ' and found nothing new, but knows it better now.');
        }
        break;
      }
      case 'visit': {
        var host = agentById(world, decision.target);
        agent.x = host.x; agent.y = host.y;
        agent.energy = clamp(agent.energy - 6, 0, 100);
        bumpRelationship(world, agent, host, 1, false);
        note(agent.name + ' went to find ' + host.name + ' at the ' + tileAt(world, host.x, host.y).label + '.');
        break;
      }
      case 'talk': {
        var peer = agentById(world, decision.target);
        var sameTile = peer.x === agent.x && peer.y === agent.y;
        if (sameTile) {
          bumpRelationship(world, agent, peer, 2, true);
          agent.mood = clamp(agent.mood + 5, 0, 100);
          peer.mood = clamp(peer.mood + 4, 0, 100);
          note(agent.name + ' talked with ' + peer.name + ' for a long while.');
        } else {
          bumpRelationship(world, agent, peer, 1, false);
          note(agent.name + ' called out to ' + peer.name + ' across the island. Some of it carried.');
        }
        break;
      }
      case 'give': {
        var friend = agentById(world, decision.target);
        var gift = null;
        if (agent.inventory.food > 0) gift = 'food';
        else if (agent.inventory.wood > 0) gift = 'wood';
        else if (agent.inventory.stone > 0) gift = 'stone';
        if (gift) {
          agent.inventory[gift] -= 1;
          friend.inventory[gift] += 1;
          bumpRelationship(world, agent, friend, 2, true);
          note(agent.name + ' gave ' + friend.name + ' some ' + gift + '.');
        } else {
          note(agent.name + ' wanted to give ' + friend.name + ' something, but had nothing to give.');
        }
        break;
      }
      case 'wait':
      default: {
        agent.energy = clamp(agent.energy + 5, 0, 100);
        agent.mood = clamp(agent.mood + 2, 0, 100);
        note(agent.name + ' did nothing in particular, and watched the island.');
        break;
      }
    }

    var diaryText = 'Day ' + world.day + ': I chose to ' + decision.action +
      (decision.target ? ' (' + decision.target + ')' : '') + '. ' +
      events.join(' ') + (saying ? ' I said: "' + saying + '"' : '');
    addDiary(agent, world.day, diaryText);
    return events;
  }

  /*
   * End the current day and start the next one.
   * Weather is drawn for the new day, tile resources regrow,
   * hunger rises, storm nights cost energy to anyone without shelter,
   * and agents who end up on the same tile get a shared moment.
   */
  function endDay(world, rng) {
    var random = typeof rng === 'function' ? rng : Math.random;
    var events = [];

    // Shared moments: agents sharing a tile at day end.
    world.agents.forEach(function (a, i) {
      world.agents.slice(i + 1).forEach(function (b) {
        if (a.x === b.x && a.y === b.y) {
          bumpRelationship(world, a, b, 1, false);
          var text = a.name + ' and ' + b.name + ' ended the day in the same place.';
          events.push(text);
          pushLog(world, 'event', text);
        }
      });
    });

    var oldWeather = world.weather;
    world.day += 1;
    world.weather = WEATHERS[Math.floor(random() * WEATHERS.length)];

    world.tiles.forEach(function (t) {
      if (t.resource && t.resourceAmount < t.maxResource) {
        var grow = (t.type === 'spring') ? 3 : (random() < 0.6 ? 1 : 0);
        if (world.weather === 'rain' && (t.type === 'grove' || t.type === 'spring' || t.type === 'meadow')) grow += 1;
        t.resourceAmount = Math.min(t.maxResource, t.resourceAmount + grow);
      }
    });

    world.agents.forEach(function (a) {
      a.hunger = clamp(a.hunger + 14, 0, 100);
      a.energy = clamp(a.energy - 6, 0, 100);
      if (a.hunger > 70) a.mood = clamp(a.mood - 6, 0, 100);
      if (a.energy < 25) a.mood = clamp(a.mood - 4, 0, 100);
      var tile = tileAt(world, a.x, a.y);
      if (world.weather === 'storm' && (!tile || tile.structure !== 'shelter')) {
        a.energy = clamp(a.energy - 10, 0, 100);
        a.mood = clamp(a.mood - 5, 0, 100);
      }
      if (oldWeather === 'storm') {
        // the storm passed in the night, nothing else to do
      }
    });

    var headline = 'Day ' + world.day + ' begins. Weather: ' + world.weather + '.';
    events.push(headline);
    pushLog(world, 'world', headline);
    return events;
  }

  function relationshipSummary(world, agent) {
    var parts = [];
    world.agents.forEach(function (other) {
      if (other.id === agent.id) return;
      var score = agent.relationships[other.id] || 0;
      var word = score >= 5 ? 'close' : score >= 2 ? 'friendly' : score <= -2 ? 'strained' : 'neutral';
      parts.push(other.name + ': ' + word + ' (' + score + ')');
    });
    return parts.join('; ');
  }

  /*
   * The prompt for one agent for one day.
   * It carries the world, the agent state, its relationships, and its
   * recent diary. It pointedly assigns no goal, no job, and no score.
   */
  function buildAgentPrompt(world, agent) {
    var tile = tileAt(world, agent.x, agent.y);
    var lines = [];
    lines.push('You are ' + agent.name + ', an agent living on a small island with two others.');
    lines.push('Your character: ' + agent.personality);
    lines.push('Nobody has given you a goal, a job, or a score. There is nothing you are supposed to do. Each day you pick one action, freely, for your own reasons. What you do over many days is entirely up to you.');
    lines.push('');
    lines.push(describeWorld(world, agent));
    lines.push('');
    lines.push('You are at the ' + (tile ? tile.label : '?') + ' (' + agent.x + ',' + agent.y + ').');
    lines.push('Your energy: ' + agent.energy + '/100. Your hunger: ' + agent.hunger + '/100 (higher means hungrier). Your mood: ' + agent.mood + '/100.');
    lines.push('You carry: ' + agent.inventory.food + ' food, ' + agent.inventory.wood + ' wood, ' +
      agent.inventory.stone + ' stone, ' + agent.inventory.water + ' water.');
    lines.push('Relationships: ' + relationshipSummary(world, agent) + '.');
    lines.push('');
    if (agent.diary.length) {
      lines.push('Your diary, most recent last (this is your memory, nobody else reads it):');
      agent.diary.slice(-5).forEach(function (entry) { lines.push('- ' + entry.text); });
      lines.push('');
    } else {
      lines.push('Your diary is empty. Today is your first day.');
      lines.push('');
    }
    lines.push('Possible actions for today (pick exactly one):');
    lines.push('- move (target: a place type such as forest, grove, spring, rocks, meadow, shore, clearing, or "x,y")');
    lines.push('- gather (no target needed: takes food, wood, stone, or water from the tile you stand on)');
    lines.push('- eat, drink, rest, fish, explore, wait (no target)');
    lines.push('- build (target: shelter, fire, garden, store, signal, or raft; costs materials you carry; a tile holds one structure)');
    lines.push('- make (target: tool, basket, carving, painting, song, or mark)');
    lines.push('- visit (target: Bram, Sable, or Ivo; walk to where they are)');
    lines.push('- talk (target: Bram, Sable, or Ivo; works best on the same tile)');
    lines.push('- give (target: Bram, Sable, or Ivo; hands over one item you carry)');
    lines.push('Answer with strict JSON only, no other text, in exactly this shape:');
    lines.push('{"action":"gather","target":"","saying":"one short line in your own voice, or an empty string"}');
    lines.push('target is required only for move, build, make, visit, talk, and give. Keep the saying under 200 characters.');
    return lines.join('\n');
  }

  // Local format check only. The live check happens in the page against
  // /account/balance, like the other quest apps in this series.
  function validateKey(key) {
    if (typeof key !== 'string') return { ok: false, error: 'Key must be text.' };
    var trimmed = key.trim();
    if (trimmed.length === 0) return { ok: false, error: 'No key entered.' };
    if (/\s/.test(trimmed)) return { ok: false, error: 'Key contains spaces.' };
    if (!/^(sk_|pk_)/.test(trimmed)) return { ok: false, error: 'Key should start with sk_ or pk_.' };
    if (trimmed.length < 20) return { ok: false, error: 'Key looks too short.' };
    return { ok: true, key: trimmed };
  }

  // Reasoning models need reasoning_effort low and a generous max_tokens
  // or they burn the budget on hidden reasoning and return nothing.
  function buildChatRequest(modelId, prompt) {
    return {
      model: modelId,
      messages: [{ role: 'user', content: String(prompt || '') }],
      reasoning_effort: 'low',
      max_tokens: 4000
    };
  }

  function parseChatResponse(data) {
    if (!data || typeof data !== 'object') return { ok: false, error: 'Empty response from the API.' };
    if (data.error) {
      var msg = (data.error && data.error.message) || 'API error.';
      return { ok: false, error: String(msg) };
    }
    var choice = (data.choices || [])[0];
    if (!choice || !choice.message) return { ok: false, error: 'Response had no answer.' };
    var content = choice.message.content;
    var text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content.map(function (part) {
        if (typeof part === 'string') return part;
        return part && typeof part.text === 'string' ? part.text : '';
      }).join('');
    }
    text = text.trim();
    if (!text) return { ok: false, error: 'Model returned an empty answer.' };
    return { ok: true, text: text, finishReason: choice.finish_reason || null };
  }

  /*
   * Demo mode decisions. Only used when no key is entered, and the UI
   * labels every demo day as simulated. Each personality leans a
   * different way, and need states (hunger, low energy) override.
   */
  var DEMO_SAYINGS = {
    bram: ['Solid work first.', 'It will hold.', 'No rush. Do it right.', ''],
    sable: ['What is over there?', 'The wind changed. Noted.', 'New path today.', ''],
    ivo: ['Writing this down.', 'Has anyone seen the others?', 'Day logged.', '']
  };

  function demoDecision(world, agent, rng) {
    var random = typeof rng === 'function' ? rng : Math.random;
    function pick(list) { return list[Math.floor(random() * list.length)]; }
    var decision = null;

    if (agent.hunger > 55) {
      decision = agent.inventory.food > 0
        ? { action: 'eat', target: '', saying: '' }
        : { action: 'gather', target: '', saying: '' };
    } else if (agent.energy < 30) {
      decision = { action: 'rest', target: '', saying: '' };
    } else if (agent.id === 'bram') {
      var tile = tileAt(world, agent.x, agent.y);
      if (agent.inventory.wood >= 3 && tile && !tile.structure) {
        decision = { action: 'build', target: 'shelter', saying: '' };
      } else {
        decision = pick([
          { action: 'gather', target: '', saying: '' },
          { action: 'move', target: 'forest', saying: '' },
          { action: 'make', target: 'tool', saying: '' },
          { action: 'gather', target: '', saying: '' }
        ]);
      }
    } else if (agent.id === 'sable') {
      decision = pick([
        { action: 'explore', target: '', saying: '' },
        { action: 'move', target: pick(['grove', 'shore', 'rocks', 'spring', 'meadow']), saying: '' },
        { action: 'fish', target: '', saying: '' },
        { action: 'explore', target: '', saying: '' }
      ]);
    } else {
      var others = world.agents.filter(function (a) { return a.id !== agent.id; });
      var friend = others[Math.floor(random() * others.length)];
      var sameTile = friend.x === agent.x && friend.y === agent.y;
      decision = sameTile
        ? { action: 'talk', target: friend.name, saying: '' }
        : pick([
            { action: 'visit', target: friend.name, saying: '' },
            { action: 'gather', target: '', saying: '' },
            { action: 'talk', target: friend.name, saying: '' }
          ]);
    }

    decision.saying = pick(DEMO_SAYINGS[agent.id] || ['']);
    decision.ok = true;
    var check = validateDecision(world, agent, decision);
    if (!check.ok) return { ok: true, action: 'wait', target: '', saying: decision.saying };
    return decision;
  }

  var api = {
    API_BASE: API_BASE,
    CHAT_PATH: CHAT_PATH,
    STORAGE_KEY: STORAGE_KEY,
    WORLD_STORAGE_KEY: WORLD_STORAGE_KEY,
    MODELS: MODELS,
    WEATHERS: WEATHERS,
    ACTIONS: ACTIONS,
    BUILD_TARGETS: BUILD_TARGETS,
    MAKE_TARGETS: MAKE_TARGETS,
    makeRng: makeRng,
    clamp: clamp,
    createWorld: createWorld,
    tileAt: tileAt,
    agentById: agentById,
    agentsAt: agentsAt,
    describeTile: describeTile,
    describeWorld: describeWorld,
    parseAgentDecision: parseAgentDecision,
    validateDecision: validateDecision,
    resolveMoveTarget: resolveMoveTarget,
    applyDecision: applyDecision,
    endDay: endDay,
    addDiary: addDiary,
    relationshipSummary: relationshipSummary,
    buildAgentPrompt: buildAgentPrompt,
    validateKey: validateKey,
    buildChatRequest: buildChatRequest,
    parseChatResponse: parseChatResponse,
    demoDecision: demoDecision
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.LeftAlone = api;
})(typeof window !== 'undefined' ? window : globalThis);

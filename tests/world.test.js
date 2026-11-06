'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../world.js');

// ------- world creation -------

test('createWorld builds a 7 by 7 island with 3 distinct agents', () => {
  const w = core.createWorld();
  assert.equal(w.day, 1);
  assert.equal(w.weather, 'clear');
  assert.equal(w.tiles.length, 49);
  assert.equal(w.agents.length, 3);
  const names = w.agents.map((a) => a.name);
  assert.deepEqual(names, ['Bram', 'Sable', 'Ivo']);
  const spots = new Set(w.agents.map((a) => a.x + ',' + a.y));
  assert.equal(spots.size, 3, 'agents start on distinct tiles');
  for (const a of w.agents) {
    const tile = core.tileAt(w, a.x, a.y);
    assert.ok(tile.walkable, a.name + ' starts on a walkable tile');
    assert.ok(a.personality.length > 20, a.name + ' has a personality');
    assert.equal(a.diary.length, 0);
  }
  assert.ok(w.tiles.some((t) => t.type === 'water' && !t.walkable));
  assert.ok(w.tiles.some((t) => t.type === 'grove' && t.resource === 'food'));
  assert.ok(w.tiles.some((t) => t.type === 'spring' && t.resource === 'water'));
  assert.equal(w.log.length, 1);
});

test('agent personalities are distinct', () => {
  const w = core.createWorld();
  const texts = new Set(w.agents.map((a) => a.personality));
  assert.equal(texts.size, 3);
});

// ------- action parsing -------

test('parseAgentDecision accepts strict JSON', () => {
  const d = core.parseAgentDecision('{"action":"gather","target":"","saying":"Berries today."}');
  assert.equal(d.ok, true);
  assert.equal(d.action, 'gather');
  assert.equal(d.saying, 'Berries today.');
});

test('parseAgentDecision accepts fenced and prose wrapped JSON', () => {
  const fenced = core.parseAgentDecision('```json\n{"action":"rest","target":"","saying":""}\n```');
  assert.equal(fenced.ok, true);
  assert.equal(fenced.action, 'rest');
  const prose = core.parseAgentDecision('Here is my choice: {"action":"explore","target":"","saying":"Off I go."} That is all.');
  assert.equal(prose.ok, true);
  assert.equal(prose.action, 'explore');
});

test('parseAgentDecision maps synonyms and rejects unknown actions', () => {
  assert.equal(core.parseAgentDecision('{"action":"walk","target":"forest"}').action, 'move');
  assert.equal(core.parseAgentDecision('{"action":"sleep"}').action, 'rest');
  assert.equal(core.parseAgentDecision('{"action":"chat","target":"Bram"}').action, 'talk');
  const bad = core.parseAgentDecision('{"action":"teleport","target":"moon"}');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown/);
});

test('parseAgentDecision rejects non JSON and empty input', () => {
  assert.equal(core.parseAgentDecision('').ok, false);
  assert.equal(core.parseAgentDecision(null).ok, false);
  assert.equal(core.parseAgentDecision('I will gather today, trust me').ok, false);
  assert.equal(core.parseAgentDecision('{not json}').ok, false);
});

test('parseAgentDecision clamps long sayings and targets', () => {
  const long = 'x'.repeat(500);
  const d = core.parseAgentDecision(JSON.stringify({ action: 'wait', target: long, saying: long }));
  assert.equal(d.ok, true);
  assert.ok(d.saying.length <= 240);
  assert.ok(d.target.length <= 60);
});

// ------- decision validation -------

test('validateDecision requires a real other agent for social actions', () => {
  const w = core.createWorld();
  const sable = core.agentById(w, 'sable');
  assert.equal(core.validateDecision(w, sable, { ok: true, action: 'talk', target: 'Bram' }).ok, true);
  assert.equal(core.validateDecision(w, sable, { ok: true, action: 'talk', target: 'Nobody' }).ok, false);
  assert.equal(core.validateDecision(w, sable, { ok: true, action: 'visit', target: 'Sable' }).ok, false);
  assert.equal(core.validateDecision(w, sable, { ok: true, action: 'give', target: '' }).ok, false);
});

test('validateDecision resolves move targets and rejects water and nonsense', () => {
  const w = core.createWorld();
  const bram = core.agentById(w, 'bram');
  assert.equal(core.validateDecision(w, bram, { ok: true, action: 'move', target: 'forest' }).ok, true);
  assert.equal(core.validateDecision(w, bram, { ok: true, action: 'move', target: 'water' }).ok, false);
  assert.equal(core.validateDecision(w, bram, { ok: true, action: 'move', target: 'the moon' }).ok, false);
  assert.equal(core.validateDecision(w, bram, { ok: true, action: 'move', target: '0,0' }).ok, false);
});

test('validateDecision enforces build materials and target list', () => {
  const w = core.createWorld();
  const bram = core.agentById(w, 'bram');
  const broke = core.validateDecision(w, bram, { ok: true, action: 'build', target: 'shelter' });
  assert.equal(broke.ok, false);
  assert.match(broke.error, /not enough/);
  bram.inventory.wood = 3;
  assert.equal(core.validateDecision(w, bram, { ok: true, action: 'build', target: 'shelter' }).ok, true);
  assert.equal(core.validateDecision(w, bram, { ok: true, action: 'build', target: 'castle' }).ok, false);
});

// ------- world state transitions -------

test('gather takes resources from the tile into the inventory', () => {
  const w = core.createWorld();
  const rng = core.makeRng(7);
  const sable = core.agentById(w, 'sable');
  // Sable starts next to the grove at 4,1. Walk her onto it via a move.
  core.applyDecision(w, sable, { ok: true, action: 'move', target: 'grove', saying: '' }, rng);
  const tile = core.tileAt(w, sable.x, sable.y);
  assert.equal(tile.type, 'grove');
  const tileBefore = tile.resourceAmount;
  const foodBefore = sable.inventory.food;
  core.applyDecision(w, sable, { ok: true, action: 'gather', target: '', saying: '' }, rng);
  assert.equal(tile.resourceAmount, tileBefore - 2);
  assert.equal(sable.inventory.food, foodBefore + 2);
});

test('gather on a tile with no resource changes nothing but logs the miss', () => {
  const w = core.createWorld();
  const bram = core.agentById(w, 'bram'); // clearing, no resource
  const before = { ...bram.inventory };
  const events = core.applyDecision(w, bram, { ok: true, action: 'gather', target: '', saying: '' }, core.makeRng(1));
  assert.deepEqual(bram.inventory, before);
  assert.match(events[0], /found nothing/);
});

test('eat consumes food and cuts hunger, and fails honestly with no food', () => {
  const w = core.createWorld();
  const ivo = core.agentById(w, 'ivo');
  ivo.hunger = 80;
  core.applyDecision(w, ivo, { ok: true, action: 'eat', target: '', saying: '' }, core.makeRng(2));
  assert.equal(ivo.inventory.food, 0);
  assert.equal(ivo.hunger, 45);
  const events = core.applyDecision(w, ivo, { ok: true, action: 'eat', target: '', saying: '' }, core.makeRng(2));
  assert.match(events[0], /no food/);
});

test('build spends materials, places a structure, and rest inside it pays more', () => {
  const w = core.createWorld();
  const bram = core.agentById(w, 'bram');
  bram.inventory.wood = 5;
  core.applyDecision(w, bram, { ok: true, action: 'build', target: 'shelter', saying: '' }, core.makeRng(3));
  assert.equal(bram.inventory.wood, 2);
  assert.equal(core.tileAt(w, bram.x, bram.y).structure, 'shelter');
  bram.energy = 40;
  core.applyDecision(w, bram, { ok: true, action: 'rest', target: '', saying: '' }, core.makeRng(3));
  assert.equal(bram.energy, 75); // 40 + 35 shelter bonus
});

test('visit moves the agent onto the other agent tile', () => {
  const w = core.createWorld();
  const ivo = core.agentById(w, 'ivo');
  const bram = core.agentById(w, 'bram');
  core.applyDecision(w, ivo, { ok: true, action: 'visit', target: 'Bram', saying: '' }, core.makeRng(4));
  assert.equal(ivo.x, bram.x);
  assert.equal(ivo.y, bram.y);
  assert.ok(ivo.relationships.bram > 0);
  assert.ok(bram.relationships.ivo > 0);
});

test('talk on the same tile raises the bond both ways, talk from afar less', () => {
  const w = core.createWorld();
  const ivo = core.agentById(w, 'ivo');
  const bram = core.agentById(w, 'bram');
  core.applyDecision(w, ivo, { ok: true, action: 'talk', target: 'Bram', saying: '' }, core.makeRng(5));
  assert.equal(ivo.relationships.bram, 1); // apart: +1
  ivo.x = bram.x; ivo.y = bram.y;
  core.applyDecision(w, ivo, { ok: true, action: 'talk', target: 'Bram', saying: '' }, core.makeRng(5));
  assert.equal(ivo.relationships.bram, 3); // together: +2 more
});

test('give transfers one item and raises the bond', () => {
  const w = core.createWorld();
  const bram = core.agentById(w, 'bram');
  const sable = core.agentById(w, 'sable');
  const sableFood = sable.inventory.food;
  core.applyDecision(w, bram, { ok: true, action: 'give', target: 'Sable', saying: '' }, core.makeRng(6));
  assert.equal(bram.inventory.food, 0);
  assert.equal(sable.inventory.food, sableFood + 1);
  assert.equal(bram.relationships.sable, 2);
});

test('endDay advances the day, picks a valid weather, regrows and hungers', () => {
  const w = core.createWorld();
  const grove = w.tiles.find((t) => t.type === 'grove');
  grove.resourceAmount = 0;
  const hungerBefore = w.agents[0].hunger;
  const events = core.endDay(w, core.makeRng(42));
  assert.equal(w.day, 2);
  assert.ok(core.WEATHERS.includes(w.weather));
  assert.ok(grove.resourceAmount > 0, 'grove regrew overnight');
  assert.equal(w.agents[0].hunger, hungerBefore + 14);
  assert.ok(events.some((e) => /Day 2 begins/.test(e)));
  assert.ok(w.log.some((e) => e.day === 2));
});

test('endDay records a shared moment for agents sharing a tile', () => {
  const w = core.createWorld();
  const [a, b] = w.agents;
  b.x = a.x; b.y = a.y;
  const bondBefore = a.relationships[b.id];
  core.endDay(w, core.makeRng(9));
  assert.ok(a.relationships[b.id] > bondBefore);
  assert.ok(w.log.some((e) => /same place/.test(e.text)));
});

test('storm nights cost extra energy to agents without shelter', () => {
  const w = core.createWorld();
  // Force the rng so endDay draws 'storm': scan seeds for one that does.
  let stormSeed = -1;
  for (let s = 1; s < 500; s++) {
    const probe = core.createWorld();
    core.endDay(probe, core.makeRng(s));
    if (probe.weather === 'storm') { stormSeed = s; break; }
  }
  assert.ok(stormSeed > 0, 'found a seed that draws a storm');
  const bram = core.agentById(w, 'bram');
  bram.energy = 90;
  core.endDay(w, core.makeRng(stormSeed));
  assert.equal(w.weather, 'storm');
  // base overnight -6, storm -10
  assert.equal(bram.energy, 74);
});

// ------- diary memory -------

test('every applied decision writes a diary entry with the saying', () => {
  const w = core.createWorld();
  const sable = core.agentById(w, 'sable');
  core.applyDecision(w, sable, { ok: true, action: 'wait', target: '', saying: 'Just watching.' }, core.makeRng(11));
  assert.equal(sable.diary.length, 1);
  assert.match(sable.diary[0].text, /Day 1/);
  assert.match(sable.diary[0].text, /Just watching/);
});

test('diary is capped and keeps the most recent entries', () => {
  const w = core.createWorld();
  const agent = w.agents[0];
  for (let i = 0; i < 20; i++) core.addDiary(agent, i + 1, 'entry ' + i);
  assert.equal(agent.diary.length, 12);
  assert.equal(agent.diary[agent.diary.length - 1].text, 'entry 19');
  assert.equal(agent.diary[0].text, 'entry 8');
});

test('buildAgentPrompt feeds back personality, diary, world and no goal', () => {
  const w = core.createWorld();
  const ivo = core.agentById(w, 'ivo');
  core.applyDecision(w, ivo, { ok: true, action: 'wait', target: '', saying: 'First day nerves.' }, core.makeRng(12));
  const prompt = core.buildAgentPrompt(w, ivo);
  assert.match(prompt, /Ivo/);
  assert.match(prompt, /Social and anxious/);
  assert.match(prompt, /First day nerves/, 'diary memory is fed back into the prompt');
  assert.match(prompt, /Day 1/);
  assert.match(prompt, /Weather today: clear/);
  assert.match(prompt, /Nobody has given you a goal/);
  assert.match(prompt, /\{"action":"gather"/, 'prompt shows the strict JSON shape');
  assert.match(prompt, /Bram/);
  assert.match(prompt, /Sable/);
});

test('relationshipSummary reports the bond words', () => {
  const w = core.createWorld();
  const bram = core.agentById(w, 'bram');
  bram.relationships.sable = 6;
  bram.relationships.ivo = -3;
  const s = core.relationshipSummary(w, bram);
  assert.match(s, /Sable: close \(6\)/);
  assert.match(s, /Ivo: strained \(-3\)/);
});

// ------- key and request shape -------

test('validateKey follows the shared quest app rules', () => {
  assert.equal(core.validateKey('sk_' + 'a'.repeat(24)).ok, true);
  assert.equal(core.validateKey('pk_' + 'a'.repeat(24)).ok, true);
  assert.equal(core.validateKey('').ok, false);
  assert.equal(core.validateKey('hello world this is long').ok, false);
  assert.equal(core.validateKey('sk_short').ok, false);
  assert.equal(core.validateKey(42).ok, false);
});

test('buildChatRequest sets reasoning low and a generous token budget', () => {
  const req = core.buildChatRequest('z-ai/glm-5.3-flash', 'hello');
  assert.equal(req.model, 'z-ai/glm-5.3-flash');
  assert.equal(req.reasoning_effort, 'low');
  assert.ok(req.max_tokens >= 2000);
  assert.equal(req.messages[0].content, 'hello');
  assert.equal(core.API_BASE + core.CHAT_PATH, 'https://gen.pollinations.ai/v1/chat/completions');
});

test('parseChatResponse reads text and surfaces API errors', () => {
  const ok = core.parseChatResponse({ choices: [{ message: { content: '{"action":"wait"}' }, finish_reason: 'stop' }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '{"action":"wait"}');
  const err = core.parseChatResponse({ error: { message: 'insufficient balance' } });
  assert.equal(err.ok, false);
  assert.match(err.error, /insufficient/);
  assert.equal(core.parseChatResponse(null).ok, false);
});

// ------- demo mode -------

test('demoDecision always returns a valid decision for every agent over many days', () => {
  const w = core.createWorld();
  const rng = core.makeRng(2026);
  for (let day = 0; day < 30; day++) {
    for (const agent of w.agents) {
      const d = core.demoDecision(w, agent, rng);
      assert.equal(d.ok, true);
      const check = core.validateDecision(w, agent, d);
      assert.equal(check.ok, true, 'day ' + w.day + ' ' + agent.name + ' ' + d.action + ': ' + (check.error || ''));
      core.applyDecision(w, agent, d, rng);
    }
    core.endDay(w, rng);
  }
  assert.equal(w.day, 31);
  for (const agent of w.agents) {
    assert.ok(agent.diary.length > 0, agent.name + ' kept a diary');
    assert.ok(agent.energy >= 0 && agent.energy <= 100);
    assert.ok(agent.hunger >= 0 && agent.hunger <= 100);
    const tile = core.tileAt(w, agent.x, agent.y);
    assert.ok(tile.walkable, agent.name + ' never ends up in the water');
  }
  assert.ok(w.log.length > 50, 'a month alone produces a real log');
});

test('a full live style day runs end to end from raw model text', () => {
  const w = core.createWorld();
  const rng = core.makeRng(99);
  const replies = {
    bram: '{"action":"gather","target":"","saying":"Wood first."}',
    sable: '```json\n{"action":"explore","target":"","saying":"Over the hill."}\n```',
    ivo: '{"action":"visit","target":"Bram","saying":"Checking in."}'
  };
  for (const agent of w.agents) {
    const d = core.parseAgentDecision(replies[agent.id]);
    assert.equal(d.ok, true, agent.name + ' reply parses');
    assert.equal(core.validateDecision(w, agent, d).ok, true, agent.name + ' reply is legal');
    core.applyDecision(w, agent, d, rng);
  }
  core.endDay(w, rng);
  assert.equal(w.day, 2);
  const ivo = core.agentById(w, 'ivo');
  const bram = core.agentById(w, 'bram');
  assert.equal(ivo.x, bram.x);
  assert.equal(ivo.y, bram.y);
  for (const agent of w.agents) assert.equal(agent.diary.length, 1);
});

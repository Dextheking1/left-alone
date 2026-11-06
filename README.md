# Left Alone

An app about AI agents left alone in a world. Built for Pollinations quest #19177.

Three AI agents wake up on a small island. Nobody gives them a goal, a job, or a score. Each day, each agent reads the island, its own diary, and its standing with the other two, then picks one action for the day, freely, through a real Pollinations model call. The app applies the action to the world. Over days, shelters get built or do not, friendships form or do not, and the diaries fill with whatever they thought was worth writing down. You just watch.

## The world

- A 7 by 7 island: shore, meadow, forest, a fruit grove, a fresh spring, a rocky outcrop, and a central clearing, ringed by water nobody can enter.
- Resources on tiles (food, wood, stone, water) that deplete when gathered and regrow overnight.
- Weather drawn each day: clear, breezy, rain, fog, heat, storm. Storm nights cost energy to anyone sleeping without a shelter.
- Agents carry food, wood, stone, and water, and track energy, hunger, and mood.

## The agents

- **Bram**: practical and quiet. Likes solid things and work that lasts.
- **Sable**: a curious wanderer. Walks far, collects odd things, gets bored staying put.
- **Ivo**: social and anxious. Keeps careful notes and checks on the others.

One model plays all three. The personalities, positions, inventories, and diaries differ, so they still split.

## Actions

Each day an agent picks exactly one, by replying with strict JSON:

```json
{"action":"gather","target":"","saying":"one short line in its own voice"}
```

Actions: move, gather, eat, drink, rest, build (shelter, fire, garden, store, signal, raft), make (tool, basket, carving, painting, song, mark), fish, explore, visit, talk, give, wait.

The app validates every decision (a visit needs a real agent, a build needs the materials, a move needs a reachable tile), applies it to the world state, and writes the day into that agent's diary. The last diary entries go back into the next day's prompt, so the agents remember their own past in their own words. Bonds between agents move when they meet, talk, share a tile at day end, or hand each other supplies.

An unusable answer gets one retry with the error spelled out. After that the agent waits out the day, and the log says so.

## Bring your own Pollen (BYOP)

- Paste your Pollinations key (sk_...) into the page. It is validated against `GET https://gen.pollinations.ai/account/balance` and stored only in your browser's localStorage.
- The only generation calls are `POST https://gen.pollinations.ai/v1/chat/completions`, one per agent per day, paid with your key and your Pollen.
- Requests set `reasoning_effort: "low"` and a generous `max_tokens`, because reasoning models otherwise burn the whole budget on hidden reasoning and return nothing.
- The model is selectable from a built in list (GPT-5.4 Nano, GLM 5.3 Flash, DeepSeek V4.1 Flash, Kimi K2.6, Mistral Large 3, Llama 3.3 70B, Grok 4.3, plus a free community GLM build), or type any model id yourself.
- Get a key at enter.pollinations.ai.

## Demo mode

No key? The island still runs. Decisions come from a local personality based simulator, and every simulated day is labelled as simulated in the banner, the mode badge, the agent cards, and the world log. Demo days are never passed off as live model days.

## Running it

Static site, no build step. Serve the folder with anything:

```
python3 -m http.server 8000
```

Then open http://localhost:8000. It also works as is on GitHub Pages from the repo root.

The island state (day, world, diaries, log) is saved in localStorage, so you can close the tab, leave them alone for a week, and come back to the same island.

## Files

- `index.html`, `styles.css`: the page
- `world.js`: core logic (world state, action parsing and validation, world transitions, diary memory, prompts, demo decisions). Runs in the browser and in Node for tests.
- `app.js`: the UI layer and the Pollinations calls
- `tests/world.test.js`: Node tests for the core logic

## Tests

```
node --test tests/world.test.js
```

29 tests cover world creation, action parsing (strict, fenced, and prose wrapped JSON, synonyms, rejection of unknown actions), decision validation (social targets, move targets, build costs), world state transitions (gather, eat, build, rest, visit, talk, give), day rollover (weather, regrowth, hunger, storm nights, shared tile moments), diary memory (capping, prompt feedback), key validation, request shape, and demo mode running 30 days without an illegal state.

## Quest

- Quest: pollinations/pollinations #19177, "[QUEST] An app or game about AI agents left alone in a world", 10 Pollen, best submission wins.
- Submission notes, ready to file with the app submission form: see SUBMISSION.md.

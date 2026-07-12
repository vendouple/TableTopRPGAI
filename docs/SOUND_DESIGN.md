# Mythweaver — Sound Design Guide

The table finds its own music. Drop files into the folders below and the
engine does the rest — no code changes, no restarts (the manifest is read
on each `/api/music` call).

## How music is picked

```
public/music/BGM/
  lobby/     ← the Gathering (join code on screen)
  weaving/   ← the loading interlude while the AI writes the world
  main/      ← general adventuring fallback for every mood
  calm/      ← DM mood: safety, camps, taverns, travel
  tense/     ← DM mood: stealth, standoffs, storm brewing
  battle/    ← DM mood: combat
  mystery/   ← DM mood: investigation, ruins, arcane strangeness
  dread/     ← DM mood: horror, something is very wrong
  triumph/   ← DM mood: victory, celebration
  wonder/    ← DM mood: awe, vistas, magic revealed
  somber/    ← DM mood: loss, mourning, quiet aftermath
  outro/               ← generic end credits (fallback for any ending)
  outro-victory/       ← end credits: the party WON
  outro-defeat/        ← end credits: the party lost / died / failed
  outro-bittersweet/   ← end credits: mixed — gains paid for in losses
  outro-escape/        ← end credits: survived by fleeing, threat remains
  outro-draw/          ← end credits: stalemate, neither side prevailed
  outro-cliffhanger/   ← end credits: deliberately unresolved, "to be continued"
```

The AI Dungeon Master sets an ambience mood as the story shifts; the host
screen crossfades to a track from the matching shelf. Empty shelves fall
back gracefully (e.g. `battle → tense → main → any`), so you can start
with just `lobby/`, `weaving/`, and `main/` and add moods over time.
Loose files directly in `BGM/` act as a final catch-all pool.

### Genre theming (important — read before generating)

The same *mood* wants different *instruments* depending on the campaign. A
lute-and-dulcimer "calm" is perfect for D&D but wrong for a modern spy
thriller or sci-fi story. So each mood shelf can hold a **genre-neutral
root** plus **themed subfolders one level down**:

```
public/music/BGM/calm/            ← genre-neutral (plays for ANY campaign)
public/music/BGM/calm/fantasy/    ← the "calm-fantasy" shelf
```

**Each campaign picks one theme at start.** The theme is chosen once, when
the table is raised, from the campaign's genre — D&D is always `fantasy`;
Story Engine campaigns are classified from their premise text (see
`src/lib/campaign/musicTheme.ts`). From then on the AI DM only ever sets
*moods* (`calm`, `tense`, `battle`…); the engine combines the fixed theme
with the current mood to pick the shelf:

- It looks for `BGM/<mood>/<theme>/` first.
- If that themed shelf is empty, it **falls back to the neutral `BGM/<mood>/`
  root** — never to another genre's music. A half-stocked theme is safe.

Supported themes (auto-detected from the premise): **`fantasy`**,
**`scifi`**, **`horror`**, **`noir`**, **`modern`** (spy / thriller /
heist / present-day), **`western`**. A campaign that matches none (e.g.
slice-of-life) stays themeless and plays the neutral roots.

So the winning strategy:

1. Fill the **mood roots** with *genre-neutral cinematic / orchestral-hybrid*
   tracks that don't scream any single setting — these are the safety net
   for every campaign, and the fallback for every theme.
2. Add themed tracks into `<mood>/<theme>/` for the genres you actually run
   (start with `fantasy/` for D&D, then whichever others you play).

> Adding a new theme is just making folders — no code change. The classifier
> keyword lists in `musicTheme.ts` decide which campaigns map to it.

**Suggested fill order** for the empty mood roots (most-used first):
`tense → battle → mystery → triumph → somber → dread → wonder → outro`.
`lobby/`, `weaving/`, `main/`, and `calm/` already have tracks. Fill themed
folders only for the moods a given genre reaches for most. `outro/` plays
exactly once per campaign but it's the last thing the table hears — worth
stocking early (until then it falls back `outro → triumph → somber → main`).

## Format & looping

**Format:** mp3 (ogg/m4a/wav also work). **2–3 tracks per shelf is plenty**
— the engine shuffles within a shelf and crossfades between tracks, so you
don't need a huge library to avoid repetition.

**Looping is automatic.** Tracks do **not** need to loop cleanly on their
own: the bard begins crossfading into the next track (or back into the same
one, on a single-track shelf) ~4.5 s before the current track ends. Because
of this:

- **Avoid hard cold stops and long silent tails** at the very end — they'll
  be caught mid-fade and sound abrupt. Let the track stay active to the end.
- **Skip big dramatic intros/outros.** A track that opens with 8 s of
  silence-then-swell will do that swell every loop. Ask for a "seamless loop
  feel, no big intro or outro, no fade to silence."
- Everything must be **instrumental** — vocals fight the narrator (wordless
  vocalise *used as an instrument* is fine).

## Suno prompts (paste as the Style, tick "Instrumental")

General tips: add `[Instrumental]` and exclude vocals; ask for a "seamless
loop feel, no big intro or outro, no fade to silence"; generate a couple of
variations per prompt and keep the best.

Each mood below gives a **Neutral** prompt (goes in the mood root — works
for any genre) and a **Fantasy** prompt (goes in `<mood>/fantasy/` for D&D
tables). `lobby/`, `weaving/`, and `main/` are app framing shared across
genres — a fantasy variant is optional there. Prompts for the other themes
(`scifi`, `horror`, `noir`, `modern`, `western`) are in their own section
below the moods.

### `lobby/` — the Gathering
**Neutral:**
> Warm, inviting cinematic ambience for a gathering, soft piano and string
> pads over a low drone, gentle woodwind or synth melody, candlelit and
> anticipatory, patient tempo around 70 bpm, understated, seamless loop
> feel, no percussion climax, no fade to silence, instrumental

**Fantasy** (`lobby/fantasy/`):
> Warm mystical fantasy tavern ambience, soft harp arpeggios and dulcimer
> over low string drones, gentle woodwind melody, candlelit and inviting,
> patient tempo around 70 bpm, cinematic but understated, seamless loop
> feel, no percussion climax, instrumental

### `weaving/` — the loading interlude
**Neutral:**
> Arcane creation soundscape, slow building choir pads and shimmering bells,
> deep cello or synth drone, threads of celesta and reversed textures, sense
> of a world being written into existence, mysterious and expectant, gradual
> swell without resolution, no fade to silence, instrumental

**Fantasy** (`weaving/fantasy/`):
> Arcane ritual soundscape, slow building choir pads and shimmering bells,
> deep cello drone, threads of celesta and reversed harp, sense of a world
> being written into existence, mysterious and expectant, gradual swell
> without resolution, instrumental

### `main/` — general adventuring (the workhorse shelf)
**Neutral:**
> Cinematic exploration underscore, hybrid orchestral, warm strings and
> subtle synth textures with light percussion, wandering melodic motif,
> hopeful with shadows at the edges, mid tempo, loopable bed that stays out
> of the way of a narrator, no big intro or outro, instrumental

**Fantasy** (`main/fantasy/`):
> Cinematic fantasy exploration score, warm strings and light hand
> percussion, wandering flute and fiddle motifs, hopeful but with shadows
> at the edges, mid tempo, orchestral folk hybrid, loopable underscore that
> stays out of the way of a narrator, instrumental

### `calm/` — safety, camps, taverns
**Neutral:**
> Peaceful ambient underscore, soft nylon guitar or felt piano, warm pads
> and distant strings, unhurried and tender, low dynamic range, safe haven
> at dusk, seamless loop feel, no fade to silence, instrumental

**Fantasy** (`calm/fantasy/`):
> Peaceful medieval campfire underscore, solo nylon guitar and soft
> hammered dulcimer, distant strings, crackling warmth, unhurried and
> tender, low dynamic range, sleepy village at dusk, instrumental

### `tense/` — stealth, standoffs, storm brewing
**Neutral:**
> Suspenseful low underscore, staccato cello ostinato, muted low pulses,
> dissonant sustained strings, ticking percussive textures, coiled spring
> tension that never releases, dark cinematic thriller tone, no fade to
> silence, instrumental

**Fantasy** (`tense/fantasy/`):
> Suspenseful low underscore, staccato cello ostinato, muted taiko pulses,
> dissonant sustained violins, ticking percussive textures, coiled spring
> tension that never releases, dark cinematic thriller in a fantasy world,
> instrumental

### `battle/` — combat
**Neutral:**
> Epic high-energy action music, driving percussion and frame drums,
> aggressive string ostinatos, brass and synth stabs, choir hits, fast
> heroic tempo around 140 bpm, relentless momentum, cinematic trailer
> energy, no big intro or outro, instrumental

**Fantasy** (`battle/fantasy/`):
> Epic fantasy battle music, driving taiko and frame drums, aggressive
> string ostinatos, brass stabs and war horns, choir hits, fast heroic
> tempo around 140 bpm, relentless momentum, cinematic trailer energy,
> instrumental

### `mystery/` — investigation, ruins, arcane strangeness
**Neutral:**
> Enigmatic underscore, music box and glass textures, slow viola or synth
> phrases in a minor mode, subtle wind-chime shimmer, curious and unsettling
> in equal measure, sparse and spacious, no fade to silence, instrumental

**Fantasy** (`mystery/fantasy/`):
> Enigmatic arcane underscore, glass harmonica and music box textures,
> slow viola phrases in a minor mode, subtle whispers of wind chimes,
> curious and unsettling in equal measure, fog over old stone, sparse and
> spacious, instrumental

### `dread/` — horror
**Neutral:**
> Dark ambient horror drone, sub bass swells, bowed metal and detuned
> strings, distant heartbeat pulse, dissonant breaths, creeping dread
> without jump scares, very sparse, glacial pacing, no fade to silence,
> instrumental

**Fantasy** (`dread/fantasy/`):
> Dark ambient horror drone, sub bass swells, bowed metal and detuned
> strings, distant heartbeat pulse, dissonant choir breaths, creeping
> dread without jump scares, very sparse, glacial pacing, instrumental

### `triumph/` — victory
**Neutral:**
> Triumphant cinematic swell turned underscore, soaring strings and brass,
> bright major key, timpani rolls and cymbal swells, golden dawn after the
> storm, celebratory but not cheesy, resolves gently so it can loop,
> instrumental

**Fantasy** (`triumph/fantasy/`):
> Triumphant fantasy fanfare turned underscore, noble French horns and
> soaring strings, bright major key, timpani rolls and cymbal swells,
> golden sunrise after the battle, celebratory but not cheesy, resolves
> gently so it can loop, instrumental

### `wonder/` — awe and revealed magic
**Neutral:**
> Ethereal wonder theme, celesta and glass bells over lush string or synth
> pads, wordless soprano vocalise used as an instrument, floating glissandi,
> starlight and first snowfall, weightless and luminous, no fade to silence,
> instrumental

**Fantasy** (`wonder/fantasy/`):
> Ethereal wonder theme, celesta and glass bells over lush string pads,
> wordless soprano vocalise used as an instrument, floating harp
> glissandi, starlight and first snowfall, weightless and luminous,
> instrumental

### `somber/` — loss and aftermath
**Neutral:**
> Mournful solo cello elegy with sparse piano, slow air on strings, rainy
> grey light, dignified grief, long silences between phrases, quiet and
> restrained, no fade to silence, instrumental

**Fantasy** (`somber/fantasy/`):
> Mournful solo cello elegy with sparse piano, slow air on strings, rainy
> grey light, dignified grief, long silences between phrases, funeral for
> a hero, quiet and restrained, instrumental

### `outro-<state>/` — the end credits, tailored to the ending

Plays when the AI calls `end_campaign` and the Three.js outro takes the TV.
The **kind** of ending now picks the shelf, so a triumphant win and a
total-party-wipe no longer share a cue. The host resolves
`outro-<kind>` → generic `outro` → the nearest existing mood, so every
folder is optional: an unfilled `outro-defeat/` still lands on `somber`
music you already have. Fill the ones you care about first.

Each shelf takes genre subfolders exactly like the moods do
(`outro-victory/fantasy/`, `outro-defeat/scifi/`, …), preferred when the
campaign's theme matches. All loop under the credits until the host leaves,
so keep the no-intro/no-outro/no-silent-tail rule.

Fallbacks per ending (most-specific first):
| Shelf | Falls back to |
| --- | --- |
| `outro-victory` | `outro → triumph → wonder → main` |
| `outro-defeat` | `outro → somber → dread → main` |
| `outro-bittersweet` | `outro → somber → calm → triumph → main` |
| `outro-escape` | `outro → tense → triumph → main` |
| `outro-draw` | `outro → somber → calm → main` |
| `outro-cliffhanger` | `outro → mystery → dread → tense → main` |

**Generic `outro/`** (the catch-all when a state shelf is empty):
> Cinematic end-credits theme, warm strings and reflective piano over a
> slow noble pulse, equal parts gratitude and farewell, grand but tender,
> gentle swells that resolve and return, works over victory or loss alike,
> seamless loop feel, no big intro or outro, no fade to silence,
> instrumental

Neutral (any-genre) prompts for each ending state — drop these in the shelf
root (`outro-victory/`, etc.); add `outro-<state>/<genre>/` variants later:

**`outro-victory/`** — the party won:
> Triumphant end-credits theme, soaring strings and noble brass over a warm
> major-key pulse, bright harp and choir swells, earned jubilation and
> gratitude, heroic but not gloating, seamless loop feel, no big intro or
> outro, no fade to silence, instrumental

**`outro-defeat/`** — the party lost, died, or failed:
> Mournful end-credits elegy, solo cello and sparse piano over a low dark
> drone, distant muted horn, dignified grief and finality, the cost of
> failure, slow and restrained but not hopeless, seamless loop feel, no big
> intro or outro, no fade to silence, instrumental

**`outro-bittersweet/`** — a mixed ending, gains paid for in losses:
> Bittersweet end-credits theme, warm strings and reflective piano with a
> single wistful solo instrument, a major melody shadowed by minor
> harmony, gratitude and grief entwined, tender and resolved but aching,
> seamless loop feel, no big intro or outro, no fade to silence, instrumental

**`outro-escape/`** — survived by fleeing, the threat remains:
> Tense-relief end-credits theme, breathless strings settling over a steady
> pulse, a cautious hopeful lead that keeps glancing over its shoulder,
> survival without safety, restless resolve, seamless loop feel, no big
> intro or outro, no fade to silence, instrumental

**`outro-draw/`** — a stalemate, neither side prevailed:
> Ambivalent end-credits theme, muted strings and piano circling an
> unresolved cadence, a weary truce, neither victory nor defeat, quiet and
> contemplative, gentle swells that never quite land, seamless loop feel, no
> big intro or outro, no fade to silence, instrumental

**`outro-cliffhanger/`** — deliberately unresolved, "to be continued":
> Ominous cliffhanger end-credits theme, a curious unresolved motif over
> pulsing low synth and ticking percussion, mystery and anticipation, one
> last question hanging in the dark, tension that promises more, seamless
> loop feel, no big intro or outro, no fade to silence, instrumental

## Other genre themes

Each theme below leads with a signature **palette** (its instruments and
tone), then gives a paste-ready prompt for every shelf. All are written for
the auto-crossfade loop, so they avoid intros, outros, and silent tails.
Only fill the shelves a given genre actually reaches for — an empty themed
shelf simply falls back to the neutral mood root.

### `scifi` — `<mood>/scifi/`
**Palette:** analog synths, pulsing arpeggiators, deep sub bass, metallic and
glassy pads, granular sound-design textures, distant sonar blips; cold, vast,
electronic, chrome-and-starlight.
- **lobby** (`lobby/scifi/`): > Inviting sci-fi lobby ambience, soft warm synth pads and a slow gentle arpeggio, distant sonar pings, patient and anticipatory around 70 bpm, the calm bridge of a ship at dock, understated, no percussion climax, no fade to silence, instrumental
- **weaving** (`weaving/scifi/`): > Sci-fi creation soundscape, building synth pads and shimmering digital bells, deep sub drone, granular textures assembling, a universe booting into existence, gradual swell without resolution, no fade to silence, instrumental
- **main** (`main/scifi/`): > Cinematic sci-fi exploration bed, warm evolving synth pads with a light pulsing arpeggio, subtle electronic percussion, curious and hopeful with cold edges, mid tempo, loopable underscore that stays under a narrator, no big intro or outro, instrumental
- **calm** (`calm/scifi/`): > Weightless ambient sci-fi underscore, slow warm synth pads and soft arpeggio, distant sonar pings, gentle sub bass, the quiet hum of a sleeping starship, unhurried and safe, low dynamics, no fade to silence, instrumental
- **tense** (`tense/scifi/`): > Cold sci-fi suspense, pulsing low synth ostinato, ticking metallic textures, dissonant glassy pads, a reactor about to breach, coiled tension that never releases, no big intro or outro, instrumental
- **battle** (`battle/scifi/`): > High-energy sci-fi action, driving electronic percussion and distorted synth bass, aggressive arpeggiators, brass-synth stabs, relentless momentum, cinematic space-combat trailer energy, no big intro or outro, instrumental
- **mystery** (`mystery/scifi/`): > Enigmatic sci-fi underscore, sparse metallic pings and glassy pads, slow detuned synth phrases, faint radio-static shimmer, an anomaly in deep space, curious and unsettling, spacious, no fade to silence, instrumental
- **dread** (`dread/scifi/`): > Sci-fi horror drone, groaning hull sub-bass swells, bowed metal and detuned synth, distant alarm pulse, something loose on the ship, very sparse, glacial pacing, no fade to silence, instrumental
- **triumph** (`triumph/scifi/`): > Triumphant sci-fi swell, soaring synth leads over bright pads, rising arpeggios and cymbal shimmer, a ship breaking orbit into dawn light, celebratory, resolves gently to loop, instrumental
- **wonder** (`wonder/scifi/`): > Ethereal sci-fi wonder, glassy bells and lush synth pads, wordless vocalise used as an instrument, slow floating arpeggios, a nebula unfolding, weightless and luminous, no fade to silence, instrumental
- **somber** (`somber/scifi/`): > Mournful sci-fi elegy, lone sustained synth pad and sparse piano, slow airy drone, cold starlight through a viewport, dignified grief, long silences, quiet and restrained, no fade to silence, instrumental
- **outro** (`outro/scifi/`): > Sci-fi end-credits theme, warm analog synth pads and a slow soaring lead, gentle arpeggios like receding stars, reflective and vast, a farewell transmission from orbit, works over victory or loss alike, gentle swells that resolve and return, no fade to silence, instrumental

### `horror` — `<mood>/horror/`
**Palette:** detuned strings, bowed metal, prepared piano, sub-bass swells,
breathy dissonant choir, scraping textures, distant music-box; dread-soaked,
sparse, wrong.
- **lobby** (`lobby/horror/`): > Uneasy horror lobby ambience, faint detuned music box over a hollow low drone, distant creaks, a waiting room that feels watched, patient and understated, no percussion climax, no fade to silence, instrumental
- **weaving** (`weaving/horror/`): > Ominous horror creation soundscape, slowly gathering dissonant string clusters and breathy choir, sub-bass swell, a dread taking shape, gradual build without release, no fade to silence, instrumental
- **main** (`main/horror/`): > Creeping horror underscore, sparse prepared piano and hollow drone, subtle scraping textures, wary and off-balance, mid-low dynamics, loopable bed that stays under a narrator, no big intro or outro, instrumental
- **calm** (`calm/horror/`): > Uneasy quiet horror ambience, hollow sustained drone, faint detuned music box, distant creaks, a false calm that never feels safe, very sparse, low dynamics, no fade to silence, instrumental
- **tense** (`tense/horror/`): > Horror suspense, scraping bowed-metal textures, sub-bass pulse like a held breath, dissonant string clusters swelling and receding, stalking dread, coiled and airless, no big intro or outro, instrumental
- **battle** (`battle/horror/`): > Frantic horror chase, pounding irregular percussion, shrieking dissonant strings, distorted low brass, panic and adrenaline, relentless and ugly, no big intro or outro, instrumental
- **mystery** (`mystery/horror/`): > Unsettling horror mystery, lone music box and prepared-piano plinks, faint whispering textures, slow minor viola, dread curiosity in an abandoned place, very sparse and spacious, no fade to silence, instrumental
- **dread** (`dread/horror/`): > Pure horror dread drone, deep sub-bass swells, bowed metal and detuned strings, distant heartbeat, breathy dissonant choir, creeping terror without jump scares, glacial and airless, no fade to silence, instrumental
- **triumph** (`triumph/horror/`): > Grim horror reprieve, a fragile major chord emerging from dissonance, warm strings pushing back the dark, uneasy relief rather than celebration, swells and resolves gently to loop, instrumental
- **wonder** (`wonder/horror/`): > Eerie horror wonder, shimmering glassy bells over cold pads, wordless vocalise turned ghostly, beautiful but wrong, floating and weightless with a chill, no fade to silence, instrumental
- **somber** (`somber/horror/`): > Mournful horror elegy, lone cello over hollow drone, sparse detuned piano, funeral in a haunted place, dignified grief shot through with dread, long silences, quiet, no fade to silence, instrumental
- **outro** (`outro/horror/`): > Horror end-credits theme, a fragile piano melody over dark ambient drones, distant detuned music box, mournful strings, the dread recedes but never quite leaves, reflective and uneasy, works whether the survivors won or lost, no jump scares, no fade to silence, instrumental

### `noir` — `<mood>/noir/`
**Palette:** smoky muted trumpet, brushed jazz drums, upright bass walking
lines, lounge piano, vibraphone, sultry clarinet; rain-slick, 1940s, dim and
world-weary.
- **lobby** (`lobby/noir/`): > Smoky noir lounge ambience, soft brushed drums and mellow lounge piano, distant muted trumpet, a dim bar before the story starts, patient and inviting, low dynamics, no fade to silence, instrumental
- **weaving** (`weaving/noir/`): > Noir mood-setting soundscape, slow sultry clarinet and vibraphone over a walking upright bass, rain on the window, a case coming into focus, gradual build without resolution, no fade to silence, instrumental
- **main** (`main/noir/`): > Noir investigation underscore, brushed drums and walking upright bass, mellow piano and muted trumpet motif, world-weary and watchful, mid-slow tempo, loopable bed that stays under a narrator, no big intro or outro, instrumental
- **calm** (`calm/noir/`): > Late-night noir lounge, brushed drums and soft walking upright bass, muted trumpet and mellow piano, cigarette smoke and neon rain, slow and world-weary, low dynamics, no fade to silence, instrumental
- **tense** (`tense/noir/`): > Noir suspense, sparse pizzicato bass, muted trumpet stabs, ticking brushed cymbal, a dark alley and a tail you can't shake, coiled tension that never resolves, no big intro or outro, instrumental
- **battle** (`battle/noir/`): > Frantic noir chase, driving upright bass and snare, stabbing brass, dissonant piano, a shootout in the rain, breathless momentum, no big intro or outro, instrumental
- **mystery** (`mystery/noir/`): > Enigmatic noir mystery, lone vibraphone and sparse piano, muted trumpet sighs, ticking clock, clues in the fog, curious and unsettling, spacious and slow, no fade to silence, instrumental
- **dread** (`dread/noir/`): > Dark noir dread, low bowed bass drone, dissonant muted brass, distant siren-like clarinet, a body in the alley, very sparse and heavy, glacial pacing, no fade to silence, instrumental
- **triumph** (`triumph/noir/`): > Bittersweet noir resolve, warm swelling strings with a lone muted trumpet, the case closed at dawn, hard-won and understated rather than cheesy, resolves gently to loop, instrumental
- **wonder** (`wonder/noir/`): > Wistful noir wonder, shimmering vibraphone and soft strings, a sultry clarinet line, neon reflected in rain, weightless and bittersweet, floating, no fade to silence, instrumental
- **somber** (`somber/noir/`): > Mournful noir elegy, lone muted trumpet over sparse piano and brushed cymbal, rainy grey light, dignified grief in a dim room, long silences between phrases, quiet, no fade to silence, instrumental
- **outro** (`outro/noir/`): > Noir end-credits theme, smoky muted trumpet over brushed drums and lounge piano, one last slow walk into the rain, world-weary but warm, bittersweet resolve that suits a closed case or a cold one, gentle swells that resolve and return, no fade to silence, instrumental

### `modern` — `<mood>/modern/`
Spy / thriller / heist / present-day.
**Palette:** hybrid orchestral + electronic, pulsing synth bass, taut string
ostinatos, processed percussion, ticking clock textures, low brass; sleek,
tense, contemporary.
- **lobby** (`lobby/modern/`): > Sleek contemporary lobby ambience, warm synth pads over soft piano, a slow subtle pulse, poised and anticipatory around 70 bpm, understated, no percussion climax, no fade to silence, instrumental
- **weaving** (`weaving/modern/`): > Modern thriller mood-setter, building pulsing synth bass and taut string swells, processed ticking textures, a plan coming together, gradual build without resolution, no fade to silence, instrumental
- **main** (`main/modern/`): > Contemporary hybrid underscore, light processed percussion and warm synth pads with a subtle string ostinato, purposeful and alert, mid tempo, loopable bed that stays under a narrator, no big intro or outro, instrumental
- **calm** (`calm/modern/`): > Sleek contemporary underscore, warm synth pads over soft piano, subtle processed percussion, quiet safehouse before the op, unhurried but alert, low dynamics, no fade to silence, instrumental
- **tense** (`tense/modern/`): > Spy-thriller suspense, taut string ostinato and pulsing synth bass, ticking clock percussion, low brass swell, surveillance and a countdown, coiled tension that never releases, no big intro or outro, instrumental
- **battle** (`battle/modern/`): > Modern action, driving hybrid percussion and distorted synth bass, aggressive string ostinatos, brass hits, a rooftop firefight, relentless trailer momentum, no big intro or outro, instrumental
- **mystery** (`mystery/modern/`): > Modern investigation mystery, sparse piano and glassy synth textures, a slow pulsing bass, faint ticking, following a lead in the dark, curious and unsettling, spacious, no fade to silence, instrumental
- **dread** (`dread/modern/`): > Modern dread drone, deep synth sub-bass swells, dissonant sustained strings, distant low alarm, an operation gone wrong, very sparse and heavy, glacial pacing, no fade to silence, instrumental
- **triumph** (`triumph/modern/`): > Triumphant modern swell, soaring strings and bright brass over a driving pulse, mission accomplished at sunrise, celebratory but sleek, resolves gently to loop, instrumental
- **wonder** (`wonder/modern/`): > Contemporary wonder, shimmering synth bells and lush pads, wordless vocalise, a city skyline at night, weightless and luminous, floating, no fade to silence, instrumental
- **somber** (`somber/modern/`): > Mournful modern elegy, lone piano over a soft sustained synth pad, slow strings, grey rain on glass, dignified grief, long silences between phrases, quiet and restrained, no fade to silence, instrumental
- **outro** (`outro/modern/`): > Modern end-credits theme, warm hybrid pads and reflective piano over a slow steady pulse, strings swelling with quiet resolve, the debrief after the operation, sleek and heartfelt, works over success or failure alike, resolves gently to loop, no fade to silence, instrumental

### `western` — `<mood>/western/`
**Palette:** twanging reverb guitar, lonesome whistle, harmonica, upright bass,
fiddle, sparse mariachi trumpet, distant coyote-night ambience; dusty, wide,
sun-bleached.
- **lobby** (`lobby/western/`): > Warm western porch ambience, soft reverb guitar and gentle harmonica, a lazy upright-bass sway, dusk on the frontier before the tale, patient and inviting, low dynamics, no fade to silence, instrumental
- **weaving** (`weaving/western/`): > Western mood-setting soundscape, slow lonesome whistle and swelling reverb guitar over a low drone, wind across the plains, a legend taking shape, gradual build without resolution, no fade to silence, instrumental
- **main** (`main/western/`): > Cinematic western exploration bed, ambling reverb guitar and light brushed percussion, distant whistle and fiddle motif, wide and weathered with hope at the edges, mid tempo, loopable underscore under a narrator, no big intro or outro, instrumental
- **calm** (`calm/western/`): > Lonesome western dusk, soft reverb guitar and distant whistle, gentle harmonica, wide open prairie at sundown, unhurried and weary, low dynamics, no fade to silence, instrumental
- **tense** (`tense/western/`): > Western standoff tension, single twanging guitar notes, low tremolo strings, creaking silence and a ticking pocket watch, coiled tension before the draw, never releasing, no big intro or outro, instrumental
- **battle** (`battle/western/`): > Western action, galloping percussion and driving upright bass, frantic fiddle and stabbing brass, a chase across the badlands, relentless momentum, no big intro or outro, instrumental
- **mystery** (`mystery/western/`): > Enigmatic western mystery, sparse muted guitar harmonics and lonesome whistle, low tremolo strings, dust and secrets in a ghost town, curious and unsettling, spacious and slow, no fade to silence, instrumental
- **dread** (`dread/western/`): > Grim western dread, low bowed drone and detuned guitar, distant coyote wail, a scraping wind, something waiting in the dark canyon, very sparse, glacial pacing, no fade to silence, instrumental
- **triumph** (`triumph/western/`): > Triumphant western swell, soaring fiddle and mariachi trumpet over full strings, a warm sunrise after the showdown, celebratory but rugged, resolves gently to loop, instrumental
- **wonder** (`wonder/western/`): > Expansive western wonder, shimmering reverb guitar and soft strings, a lonesome whistle turned luminous, endless sky over the mesa, weightless and awed, floating, no fade to silence, instrumental
- **somber** (`somber/western/`): > Mournful western elegy, lone reverb guitar over sparse strings and harmonica, dignified grief on the frontier, a grave at dusk, long silences between phrases, quiet and restrained, no fade to silence, instrumental
- **outro** (`outro/western/`): > Western end-credits theme, warm reverb guitar and fiddle over slow strings, a lonesome whistle bidding farewell, riding toward the horizon at dusk, dusty and tender, suits a won showdown or a lost one, gentle swells that resolve and return, no fade to silence, instrumental

## Sound effects — `public/music/SFX/`

Every cue below already has a built-in synthesized fallback, so the game is
fully voiced with zero files. Drop a file with the exact name to replace a
cue with something richer (Suno's SFX-style generations or any foley pack).

| File name       | Cue                                            | Suggested character |
|-----------------|------------------------------------------------|---------------------|
| `tap.mp3`       | small UI touch (tabs, minor buttons)           | soft wooden tick, felt piano damper |
| `confirm.mp3`   | "Begin the Adventure" / big confirmations      | short warm chime, two rising notes |
| `send.mp3`      | player sends an action to the Weaver           | quick parchment whoosh with a spark |
| `join.mp3`      | a hero takes a seat in the lobby               | gentle three-note bell arpeggio |
| `beat.mp3`      | the chronicle advances to a new story beat     | whisper-quiet page turn |
| `flash.mp3`     | stage flash effect (explosions, lightning)     | bright impact crack with air |
| `rumble.mp3`    | stage shake effect                             | deep earth rumble, sub-heavy |
| `darkness.mp3`  | darkness falls                                 | descending drone, air being swallowed |
| `heartbeat.mp3` | horror pulse                                   | slow double heartbeat thump |

Dice rolls keep their bespoke synthesized tumble/impact/crit chimes in the
Dice Theater.

Keep SFX short (≤ 1.5 s except rumble/darkness), mixed quiet, and free of
reverb tails that overlap the music.

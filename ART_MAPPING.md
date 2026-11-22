# Art inventory and mapping (Stage 0)

**What was supplied.** The spec's §C6 table names `Card_Fronts/*.jpg` files from the old Unity demo. Those files were not supplied. The art that exists on this PC is:

| Source | What it is |
|---|---|
| `../Final Cards Single Number Full Art/NN_<name>.psd` ×46 | Finished card faces by the artist, 1576×2176 (exactly 2× the 788×1088 card), CMYK with embedded ICC profile. This is the art used. |
| `../Final Cards Single Number Full Art.zip` | Byte-identical copy of the folder above. Not used. |
| `Archive Initial 3 samples.zip` | Three PSDs that are already in the folder. Not used. |
| `Hover Transport DO NOT USE.psd` | Marked "do not use". Not used. |
| `Vector Smart Object1.psd`, `Vector Smart Object1 .psd`, `Vector Smart Object11.psd` | Small vector fragments (logo pieces?). Not used. |
| `../Psi wars 3.jpg` (410×410), `../Psi wars.jfif` (695×431) | The hexagon logo. Used as `ui/logo`. |
| `../unnamed.jpg` (788×1088) | An **older** Dark Shredder card face (Psionic 2, with rules text). Not used. |
| `../1ac01666…_original.jpg` (680×907) | Unframed Creation Oracle illustration (the splash picture). Used as a **stand-in** menu background. |
| 12 other `../<hash>_original.jpg` (680×907) | Unframed illustrations of cards that already have framed PSDs. Not used. |

Extraction: `tools/assets/extract_psd.py` reads each PSD's merged composite with psd-tools and converts CMYK→sRGB through the embedded ICC profile. Eight PSDs (Siana, Zomber, Blade Master, Lodner, Third I, Davileam, Mental Shield, Vegian) carry a 5th (alpha) channel that Pillow misreads as garbage. psd-tools reads them correctly. The mapping is driven by `artSource` in `data/cards.json`, not by file names.

## Part B cards (29) — all have art

"Printed vs data" compares the printed numbers on the art with Part B. Part B is what `cards.json` uses.

| ID | Card (Part B) | Spec §C6 file | Actual file | Printed vs data |
|---|---|---|---|---|
| BU_DSH | Dark Shredder | Dark-Shredder-art.jpg | 01_Dark Shredder.psd | **Differs:** prints Psionic **1** (Part B: 2) and **has no rules text** |
| BU_SA | Shadow Assassin | Shadow-Assasin-art.jpg | 02_Shadow Assassin.psd | **Differs:** prints Psionic **1**, Physical **X** (Part B: Psionic X, Physical 2). Text matches. |
| BU_TS | Trangarey Scythe | Trangarey-Scythe-art.jpg | 04_Trangarey Scythe.psd | match |
| BU_JPA | Jingwa Psi Avenger | Jingwa-Psi-Avenger-art.jpg | 05_Jingwa Psi Avenger.psd | match |
| BU_LS | Life Snatcher | Life-Snatcher-art.jpg | 06_Life Snatcher.psd | match |
| BU_SC | Siana Commander | Siana-Creature-Commander-art.jpg | 09_Siana Creature Commander Card.psd | match |
| BU_ZM | Zomber Mercenary | Zomber-Mercenary-art.jpg | 11_Zomber Mercenary.psd | match |
| BU_BM | Blade Master | Blade-Master-art.jpg | 13_Blade Master.psd | match |
| BU_LP | Lodner Predator | Lodner-Predator-art.jpg | 14_Lodner Predator.psd | match |
| BU_TB | Therabot Seeker | Therabot-art.jpg | 22_Therabot.psd | match |
| BU_LQ | Loquidor Stalker | Laquidor-Stalker-art.jpg | 24_Laquidor Stalker.psd | match (file misspelled) |
| BU_HB | Hydra Bot | Hydra-Bot-art.jpg | 25_Hydra Bot.psd | match |
| BU_DC | Davileam Commander | Daviliam-Robot-Commander-art.jpg | 28_Daviliam Robot Commander.psd | match (file misspelled) |
| EQ_PB | Psi Bolster | Psionic-Bolster-art.jpg | 33_Psionic Bolster.psd | match (file name differs) |
| EQ_PA | Physical Augmentation | Intelliborg-Fusion-art.jpg | 34_Physical Augmentation.psd | match (this file name is correct) |
| EQ_CO | Cyber Onslaught | Cyber-Onslaught-art.jpg | 35_Cyber Onslaught.psd | match |
| EQ_MS | Mental Shield | Mental-Shield-art.jpg | 36_Mental Shield.psd | match |
| EQ_VCS | Vegian Cyber Shield | Veqian-Cyber-Defense-art.jpg | 37_Veqian Cyber Defense.psd | match (art title reads "Vegian Cyber Shield") |
| EQ_KA | Kranthard Armour | Kranthard-Armour-art.jpg | 38_Kranthard Armour.psd | match |
| PW_EH | Equipment Hunter | Equipment-Hunter-art.jpg | 39_Equipment Hunter.psd | match |
| TR_GSF | Grankor Stasis Field | Grankor-Statsis-Field-art.jpg | 41_Grankor Statsis Field.psd | match (file misspelled) |
| PW_EM | Equipment Mechanic | Equipment-Mechanic-art.jpg | 42_Equipment Mechanic.psd | match |
| PW_CR | Creature Regenerate | Being-Regenerate-art.jpg | 43_Being Regenerate.psd | match (art title reads "Creature Regenerate") |
| PW_HEP | High-Energy Pulse | High-Energy-Pulse-art.jpg | 46_High Energy Pulse.psd | match |
| CU_NG | Neurogenesis | Creation-Unit-Blue-art.jpg | 29_Neurogenesis Creation Unit.psd | — |
| CU_BA | Bio-Acceleration | Creation-Unit-Red-art.jpg | 30_Bioacceleration Creation Unit.psd | — |
| CU_DS | Digital Splicing | Creation-Unit-Green-art.jpg | 31_Digital Splicing Creation Unit.psd | — |
| CU_MA | Material Animation | Creation-Unit-Purple-art.jpg | 32_Material Animation Creation Unit.psd | — |
| RS_CO | Creation Oracle | Creation-Oracle-art.jpg | 40_Creation Oracle as Creation Unit.psd | — |

How the differences are handled: `cards.json` keeps Part B values in `stats` (the rules) and the art's values in `printed`. The renderer overlays a stat chip whenever the current value differs from `printed`. So Dark Shredder shows a green "2" chip over its printed Psionic 1, and Shadow Assassin shows chips on Psionic and Physical. The same mechanism covers future balance changes, which will drift from the printed art anyway.

## Cards in the art but not in Part B (17) — added as data, `enabled: false`

| ID | Printed name | File | Notes |
|---|---|---|---|
| BU_WR | Warend Reaper | 07_Warend Reaper.psd | Named in rule book; matches its stats |
| BU_PI | Pencar Inferno | 21_Pencar Inferno.psd | Named in rule book (Physical X) |
| BU_AD | Acorbeac Destroyer | 12_Acorbeac Destroyer.psd | Rule book says "Acrobeac", **Cyber 3**; art prints **Cyber 1** |
| BU_XP | Xardy Piercer | 26_Xardy Beast.psd | Spec/demo "Xaboy Piercer", cost G1 P1; art prints **Xardy Piercer, G1 P1 W1** |
| BU_GS | Garilian Seer | 03_Garilian Seer.psd | new |
| BU_FB | Fengar Berserker | 08_Fengar Beserker.psd | new |
| BU_UO | Urilian Overlord | 10_Urilian Overlord.psd | new |
| BU_BC | Bellarn Cyborg | 15_Bellarn Cyborg.psd | new |
| BU_KC | Kyler Cyborg | 16_Kyler Cyborg.psd | new ("If Physical win…") |
| BU_JP | Javarow Protector | 17_Javarow Protector.psd | new ("If Digital win…") |
| BU_TI | Third I | 18_Third I.psd | new |
| BU_VC | Veeda Commander | 19_Veeda Cyborg Commander.psd | new Cyborg Commander |
| BU_SS | Stealth Skyfire | 20_Stealth Skyfire.psd | new, no ability |
| BU_NA | Nomis Analyzer | 23_Nomis Analyzer.psd | new ("With Cyber win…") |
| BU_TG | Tricapia Guardian | 27_Tricapia Guardian.psd | new |
| PW_RR | Robo Refurb | 44_Robot Mechanic.psd | file name ≠ printed name |
| PW_MD | Mental Disrupter | 45_Mental Disrupter.psd | Creature/Cyborg counterpart of High-Energy Pulse |

Every ability on these cards maps onto an existing effect class (RollX, ModifyRollTable, CommanderAura, RevealPowerFromHand, ReturnFromDiscard, DisableUnits) or onto one new class, TutorToTop. Enabling them is a data flip in `cards.json` or the balance file.

## Missing

| Asset | Status | What the game does meanwhile |
|---|---|---|
| Battle Deck card back | **not supplied** | Generated blue back (SVG + supplied logo) at `art/generated/backs/battle-*`. Drop a real file at `art/masters/backs/battle.jpg` and it wins. |
| Resource Deck card back | **not supplied** | Generated gold back, same mechanism (`resource.jpg`). |
| Splash art 4500×6000 | **not supplied** | 680×907 unframed Creation Oracle illustration, upscaled to 1920 and darkened/blurred as a stand-in. Drop the real file at `art/masters/ui/splash.jpg`. |
| High-resolution logo | only 410×410 | Used up to 512 px; fine for the title screen at normal sizes. |
| Dice faces | not expected | Drawn as SVG components (spec §C6). |

# Office Royale v12 – plán na neděli (po resetu usage)

## 0. Pořadí Genů
1. **Gen 1 (malé):** Trojan ult "Virus Run" + loterie varianta B + log System / Chat / Incidents.
2. **Gen 2 (velké):** SHIFT = "Night Shift" deckbuilder (Slay-the-Spire styl) + nový art direction jen pro Shift.

## 1. Trojan ult – "Virus Run" (hs_qte.html, nahradí ultSimon)
- Náhodná klikatá chodba (polyline z 8–10 bodů, šířka 34 px PC / 44 px mobil) v canvasu 100 % × 260 px.
- Virus 🦠 se táhne RELATIVNĚ (pointerdown kdekoliv = kotva, pohyb = delta) -> prst ho nezakrývá; kreslí se 40 px nad prstem jen na touch.
- 3 checkpointy; dotyk stěny = "DETECTED": bliknutí, návrat na poslední checkpoint, -1 bod. Limit 7 s.
- Body = checkpointy×3 + cíl×3 − detekce → qOf(body, 12); all = dorazil do cíle.
- Šipky na PC jako alternativa.

## 2. Loterie varianta B (code.gs lottoDraw_)
- Losuje se 3 čísla + 1 BONUS (z ostatních 17). 2 shody + bonus = MINI JACKPOT 25 % poolu (dělí se), 3 shody = jackpot 90 % jako teď.
- UI extras.html: zobrazit bonusové číslo a typ výhry; changelog.

## 3. Log – 3 záložky (script.html log(), index / mobile panel)
- System (log() hráče), Chat (stávající), Incidents (duely, MK kill, jackpoty, announce, systémové zprávy chatu od '⚔ DUEL' / '📢').
- Tečka nepřečtených na záložce; mobil: stejné záložky v panelu.

## 4. SHIFT rework – "NIGHT SHIFT" (hs_modes.html, nový soubor hs_shift.html)
### Run
- Mapa 3 sloupce × ~10 pater (generovaná seedem), uzly: ⚔ boj, ☠ elita, ❓ incident, 🛒 automat (shop), ☕ kuchyňka (rest: heal 30 % NEBO upgrade karty), 👑 boss.
- Run = ~12 uzlů, HP a balíček se nesou mezi boji, energie HS 3 za run (jako teď).
### Souboj = karty
- Engine se NEMĚNÍ: karta = akce enginu + modifikátor. Každé kolo ruka 4 karet z balíčku, zahraješ 1 útok (+ případně 0-cost kartu), reakce zůstávají jako teď (block/dodge/... jsou "basic" a vždy dostupné).
- Startovní balíček 10: 4× STRIKE, 2× HEAVY, 1× GAMBLE, 1× BREATHE, 2× třídní (Warden "Shield Bash", Trojan "Exploit", Mág "Hotfix", Caffeine "Espresso Shot", Hunter "Twin Shot").
- Nové karty (výběr 1 ze 3 po boji, ~30 karet): např. Overtime (HEAVY ×1.3, stojí 10 HP), Coffee Break (+40 STA, karta navíc), Reply All (2× strike 0.6), Escalate (příští útok ×2), Root Cause (vuln + break 40), Code Freeze (enemy stun, exhaust), Rubber Duck (dodge jistý příští kolo)...
- Upgrade karty v kuchyňce (+), odebrání karty v automatu.
### Relikvie
- Stávající PERKS -> relikvie (pasivní předměty), výběr 1 ze 3 po elitě / bossovi; 10–15 kusů.
### Incidenty (❓)
- Karta incidentu s ilustrací (SVG) a 2–3 volbami s rizikem, např. "Printer on fire", "Phishing e-mail", "CEO in the elevator".

## 5. ART DIRECTION pro Night Shift (vlastní, NE podobný kamarádově hře)
Kamarád: tmavá břidlice + zlatá + patkové písmo + fantasy ilustrace. My uděláme opak – **"kancelář v noci / papír a sodíkové lampy"**:
- Paleta: noční modrá #0f1b2d, teplé sodíkové světlo #f2a541, papír #efe6d2, inkoust #2b2b2b, razítko červená #c8372d.
- Karty = **kartotéční lístky / post-it** (papírová textura CSS gradientem, mírné natočení, kancelářská sponka), font na karty: "Special Elite" (psací stroj) – na nadpisy "IBM Plex Mono", čísla velká.
- Mapa = **půdorys budovy (blueprint)**: modré čáry na mřížce, uzly jako místnosti s cedulkami ("SERVER ROOM", "KITCHEN", "CEO OFFICE").
- Incidenty = **vytištěný ticket** s razítkem "URGENT" a SVG ilustrací.
- Výhra = razítko "RESOLVED" přes ticket (žádný zlatý panel "Victory").
- Nepřátelé zůstávají HSRig postavy (náš styl), jen scéna noční kancelář s okny a monitory.
- Motiv volitelný jen pro Shift (zbytek hry zůstává neonový).

## 6. Soubory (firemní verze)
- Gen 1: hsqte/hsqte2, server2/3, extras, office/office2, index, changelog (+ mobile).
- Gen 2: nový soubor hs_shift (vlastní skupina v build_work GROUPS), hs_modes, hsengine (jen pokud bude potřeba), index, changelog.

## 7. CLASS REWORK (WoW inspirace) + duel bez oneshotů – návrh, čeká na schválení
- Duel: HP ×3 místo ×2, ŽÁDNÁ rána nad 35 % max HP soupeře (mimo náhlou smrt), náhlá smrt zůstává -> žádný oneshot ani nekonečný fight.
- Debuffy: BEZ limitu počtu (zrušeno 1. 11.) – platí pravidla níž: stejný debuff se nestackuje, DoT max 15 % max HP/kolo, BREATHE sundá 1 debuff.
- Warden -> FURY WARRIOR (Rage z dávaného/přijatého dmg, Enrage po critu +20 % 2 kola, Bloodthirst malý heal, ult RAMPAGE; slabší block, není tank).
- Trojan -> DESTRO WARLOCK (Immolate DoT, Soul Shards z DoT ticků, ult CHAOS BOLT = jistý crit, Dark Pact štít místo dodge).
- Mage -> ARCANE MAGE (Arcane Charges 0-4: každý útok +dmg i +cena, Arcane Barrage je vybije, Clearcasting proc, Evocation místo BREATHE).
- Caffeine -> WINDWALKER MONK (Chi = káva: STRIKE generuje, schopnosti utrácí; Touch of Karma vrací dmg; ult FISTS OF FURY; menší lifesteal) – alternativa Blood DK.
- Hunter beze změny (MM/BM).
- Hunter -> volba: MARKSMANSHIP (Aimed Shot nabíjení přes kolo, Trueshot ult, Hunter's Mark) NEBO BEAST MASTERY (mazlíček "Office Cat" útočí každé kolo, Kill Command, ult Bestial Wrath). Návrh: BM - mazlíček je zábavnější a odliší ho.

## 8. Spellbook + talenty + nové UI boje (součást Gen 3)
- Každá třída: SPELLBOOK ~8 schopností (odemykají se levelem), do boje si vybereš 4 do akčního panelu (+ STRIKE a BREATHE vždy).
- TALENTY: každých 10 levelů řádek se 3 volbami (vybereš 1), max 6 řádků; přenastavení zdarma mimo boj. Talent mění schopnost (např. Fury: Rampage léčí / Rampage 3 rány / Enrage déle).
- Engine: schopnosti jako DATA (cena, zdroj, efekty), jeden společný resolver; duel server ověřuje loadout + talenty z karty hráče.
- Resource lišta podle třídy: Rage (Fury), Soul Shards (Warlock), Arcane Charges (Mage), Chi (Monk), Focus + mazlíček (BM Hunter).
- NOVÉ UI BOJE (náš vlastní styl, ne kamarádův): akční panel s ikonami schopností (cooldown jako výseč, cena, klávesa 1-6), resource lišta pod HP, ikony buffů, tooltip u každé schopnosti. Zachovat neon High Stakes, ale čistší a klidnější (méně glow, větší mezery).
- UI se smí změnit kompletně (uživatel OK). LEVÝ PANEL v High Stakes = "OFFICE DOCK" (stálý):
  - 🎫 Ticket button (klik = stejná funkce jako v office, počítá se normálně), Buy chest, Open chest (+ počet).
  - Suroviny (tickety, gold, materiály) živě.
  - Inventář (mřížka, malé ikony) + Merger (přetáhnout/2 kliky = merge) – volá STÁVAJÍCÍ funkce ze script.html, žádná kopie logiky.
  - Během boje se dock dá sbalit (◀), stav se pamatuje (localStorage v try/catch).
  - Mobil: dock = vysouvací šuplík zleva (tlačítko 🗄), boj zůstává přes celou šířku.
  - Rozložení PC: [Office dock ~260px] | [scéna boje + akční panel dole] | [soupeř/log vpravo].
- Firemní verze: dock jako nový malý soubor (skupina "hsdock"), aby se neměnily velké soubory office.

## 9. DATA NÁVRH – spellbooky (8 schopností) + talenty (6 řádků × 3)
Společné: STRIKE + BREATHE vždy, do panelu 4 z 8. Odemykání: L1, L1, L5, L10, L15, L20, L30, L40. Talentové řádky: L10/20/30/40/50/60.
Ult (fokus) zůstává 1 na třídu + minihra. Cap: žádná rána >35 % max HP (duel); debuffy bez limitu počtu (viz §7).

### FURY WARRIOR (Rage 0–100: STRIKE +15, přijatý dmg +1 za 1 % max HP, rozpad −5/kolo)
| Schopnost | Cena | CD | Efekt |
|---|---|---|---|
| Bloodthirst | 0 (+10 Rage) | 1 | 1.1× dmg, heal 3 % max HP, 30 % šance Enrage |
| Raging Blow | 0 (+12 Rage) | 0 | 0.9× dmg, za Enrage 1.2× |
| Rampage | 80 Rage | 0 | 4 rány 0.45×, vždy Enrage (+20 % dmg 2 kola) |
| Whirlwind | 20 Rage | 2 | 0.7× + další 2 útoky +1 rána 0.3× |
| Execute | 30 Rage | 0 | jen když cíl <25 % HP: 1.8× (cap 35 %) |
| Enraged Regeneration | 0 | 5 | heal 12 % během 2 kol, nelze ve Enrage |
| Battle Shout | 0 | 6 | +15 % ATK 3 kola |
| Pummel | 10 Rage | 4 | přeruší channel/ult soupeře (zruší mu příští speciál) |
Ult: ODYN'S FURY → přejmenovat **"Blood Rush"**: 3 rány, každá +Rage, minihra mash.
Talenty: R1 Fresh Meat (Bloodthirst 1. hit jistý Enrage) / Warpaint (Enrage −10 % dmg přijatého) / Fast Footwork (+10 STA za Enrage)
R2 Rampage léčí 5 % / Rampage 5 ran 0.4× / Enrage trvá 3 kola
R3 Massacre (Execute <35 %) / Sudden Death (Execute proc 15 % kdykoliv) / Cold Steel (Execute neplatí Rage, CD 3)
R4 Bladestorm nahradí Whirlwind (3 kola 0.5×, imunní na stun) / Ravager / Storm Bolt (stun 1 kolo, CD 6)
R5 Bloodcraze (Bloodthirst crit +10 % za stack) / Reckless Abandon (Rage za crit ×2) / Second Wind (regen 2 %/kolo mimo boj… v boji když nedostal dmg)
R6 Titan's Grip (+12 % dmg, −10 % max HP) / Unbridled Ferocity (Rampage 20 % šance ult +25 %) / Berserker Stance (Rage z přijatého dmg ×2)

### DESTRO WARLOCK (Soul Shards 0–5)
| Schopnost | Cena | CD | Efekt |
|---|---|---|---|
| Incinerate | 0 (+1 Shard) | 0 | 1.0× fire |
| Immolate | 0 | 3 | DoT 0.3×/kolo 4 kola, tick 40 % +1 Shard |
| Chaos Bolt | 2 Shards | 0 | 1.6× vždy crit (cap 35 %) |
| Conflagrate | 0 | 3 | 1.0×, cíl s Immolate +1 Shard a Backdraft (příští Incinerate ×1.3) |
| Rain of Fire | 3 Shards | 0 | 3 kola 0.5×/kolo, nelze dodge |
| Dark Pact | 0 | 5 | štít 15 % max HP (stojí 5 % HP) – místo dodge |
| Shadowburn | 1 Shard | 4 | 1.2×, cíl <20 % → Shard zpět |
| Fear | 1 Shard | 6 | soupeř 1 kolo jen BREATHE (debuff) |
Ult: **"Summon Infernal"** (pet 3 kola 0.5×/kolo + Shard/kolo), minihra = stávající Virus Run přeskinovat? (ne – Virus Run zůstává Trojanův, pokud Trojan zůstane jako skin).
Talenty: R1 Backdraft lepší / Eradication (Chaos Bolt +12 % dmg cíli 2 kola) / Soul Fire (nová 1.5× CD 4)
R2 Dark Pact 25 % / Burning Rush (+20 STA, −2 % HP/kolo) / Mortal Coil (heal 10 % + fear)
R3 Roaring Blaze (Conflagrate zesílí Immolate) / Internal Combustion (Chaos Bolt dopálí Immolate) / Channel Demonfire
R4 Cataclysm (Immolate + 1.0×, CD 5) / Inferno (Rain of Fire +Shardy) / Fire and Brimstone
R5 Grimoire of Sacrifice (bez petu +15 % dmg) / Soul Conduit (utracený Shard 20 % zpět) / Demonic Embrace (+10 % max HP)
R6 Dimensional Rift / Ritual of Ruin (každých 10 Shardů zdarma Chaos Bolt) / Avatar of Destruction

### ARCANE MAGE (Mana = stamina, Arcane Charges 0–4: každá +15 % dmg Arcane Blast i +25 % ceny)
| Schopnost | Cena | CD | Efekt |
|---|---|---|---|
| Arcane Blast | 15 STA | 0 | 1.0×, +1 Charge |
| Arcane Barrage | 0 | 0 | 0.6× + 0.3× za Charge, vybije Charges, vrátí 5 STA/Charge |
| Arcane Missiles | 0 | 0 | jen s Clearcasting: 3× 0.4×, nelze blok |
| Arcane Explosion | 20 STA | 0 | 0.8×, +1 Charge, 25 % Clearcasting |
| Evocation | 0 | 5 | místo BREATHE: +60 STA, vybije Charges |
| Ice Block | 0 | 7 | 1 kolo imunita, nemůže útočit |
| Counterspell | 15 STA | 5 | přeruší + soupeř −20 Focus |
| Arcane Surge | 30 STA | 6 | 2.0× × (STA/max STA), cap 35 % |
Clearcasting: 20 % po každém Arcane Blastu.
Ult: **"Touch of the Magi"** – značka sbírá 25 % dmg 2 kola a pak exploduje; minihra = stávající Math.
Talenty: R1 Amplification (Missiles +1 střela) / Rule of Threes (3. Charge zdarma Blast) / Arcane Familiar (+5 % STA)
R2 Shimmer (perfektní dodge šance +) / Mass Barrier / Alter Time (vrátí HP po 2 kolech)
R3 Resonance / Chrono Shift (Barrage −dmg soupeře) / Nether Precision
R4 Supernova / Orb Barrage / Overpowered (Surge +30 % dmg, více ceny)
R5 Slipstream (Missiles při pohybu… = dodge+missiles stejné kolo) / Energized Barrage / Arcane Tempo
R6 Enlightened (při >70 % STA +10 % dmg) / Arcane Harmony / Time Anomaly

### WINDWALKER MONK – "Caffeine" (Chi 0–5, STA = Energy)
| Schopnost | Cena | CD | Efekt |
|---|---|---|---|
| Tiger Palm | 10 STA (+2 Chi) | 0 | 0.6× |
| Rising Sun Kick | 2 Chi | 2 | 1.3×, soupeř −30 % léčení 2 kola |
| Blackout Kick | 1 Chi | 0 | 0.9×, −1 kolo CD RSK |
| Fists of Fury | 3 Chi | 3 | 4× 0.35×, během kanálu −30 % dmg přijatého |
| Touch of Karma | 0 | 7 | 2 kola: 50 % přijatého dmg vrací (cap 20 % jeho max HP), sám dostane 50 % |
| Expel Harm / Vivify | 1 Chi | 3 | heal 8 % (lifesteal z pasivky snížen na 5 %) |
| Flying Serpent Kick | 15 STA | 4 | 0.8× + jistý dodge příští kolo |
| Paralysis | 2 Chi | 6 | stun 1 kolo (ne ult) |
Mastery "Combo Strikes": použít jinou schopnost než minule = +8 % dmg.
Ult: **"Storm, Earth & Fire" → "Triple Shot Espresso"**: 2 klony 2 kola kopírují útoky 0.4×; minihra Brew (stávající).
Talenty: R1 Ascension (max Chi 6) / Fast Feet / Eye of the Tiger (RSK DoT)
R2 Diffuse Magic / Dampen Harm / Healing Elixir
R3 Whirling Dragon Punch / Strike of the Windlord / Jadefire
R4 Hit Combo (Combo Strikes stackuje 3×) / Dance of Chi-Ji (Spinning Crane zdarma proc) / Xuen's Bond
R5 Tiger's Lust / Ring of Peace (soupeř −1 akce) / Transcendence
R6 Serenity / Invoke Xuen (pet) / Teachings (Tiger Palm +Chi)

### BEAST MASTERY HUNTER (Focus 0–100 +10/kolo, pet "Office Cat" útočí každé kolo 0.25×)
| Schopnost | Cena | CD | Efekt |
|---|---|---|---|
| Barbed Shot | 0 (+20 Focus) | 2 | DoT 0.2× 3 kola, Frenzy kočky +1 (max 3, +8 % pet dmg) |
| Kill Command | 30 Focus | 1 | kočka 1.1× |
| Cobra Shot | 35 Focus | 0 | 0.8×, −1 CD Kill Command |
| Multi-Shot | 40 Focus | 0 | 0.6× + Beast Cleave (pet 2 kola +30 %) |
| Bestial Wrath | 0 | 6 | +25 % dmg ty i kočka 2 kola |
| Mend Pet / Exhilaration | 0 | 6 | heal 10 % tobě a kočce |
| Freezing Trap | 20 Focus | 7 | soupeř ztratí příští akci (ne ult) |
| Disengage | 10 Focus | 4 | jistý dodge + 10 Focus |
Ult: **"Call of the Wild" → "Cat Distribution System"**: 3 kočky 2 kola; minihra Bow (stávající) + Hunter's Mark zůstává pasivka.
Talenty: R1 Pack Tactics (+Focus) / Thrill of the Hunt / Killer Instinct (Kill Command +50 % <35 % HP)
R2 Natural Mending / Survival of the Fittest / Posthaste
R3 Dire Beast / Kill Cleave / Animal Companion (2 kočky, každá 0.6×)
R4 Bloodshed / A Murder of Crows / Wild Instincts
R5 Stomp / Barrage / Scent of Blood
R6 Dire Pack / Brutal Companion / Bloody Frenzy

## 10. KANCELÁŘSKÁ JMÉNA (návrh, čeká na volbu) – mechaniky WoW, názvy office
- Fury Warrior → **Overtime Berserker** (Rage = "Stress"): Bloodthirst→Energy Drink Chug, Raging Blow→Keyboard Smash, Rampage→Rage Quit, Whirlwind→Desk Flip, Execute→"You're Fired", Enraged Regen→Lunch Break, Battle Shout→Motivational Speech, Pummel→"Let me stop you there". Ult Blood Rush→Crunch Time.
- Destro Warlock → **Burnout Specialist** (Soul Shards = "Burnout"): Incinerate→Hot Take, Immolate→Toxic Feedback (DoT), Chaos Bolt→Reply-All Nuke, Conflagrate→Escalation, Rain of Fire→Spam Storm, Dark Pact→Sick Day, Shadowburn→Final Warning, Fear→Calendar Invite: 1:1 with HR. Ult→Summon the Intern.
- Arcane Mage → **Excel Wizard** (Charges = "Nested Formulas"): Arcane Blast→=SUM(), Barrage→Ctrl+Enter, Missiles→Autofill, Explosion→Pivot Table, Evocation→Ctrl+S (save), Ice Block→Read-Only Mode, Counterspell→#REF!, Surge→Macro. Ult→VLOOKUP of Doom.
- Caffeine Monk → **Espresso Monk** (Chi = "Shots"): Tiger Palm→Quick Sip, RSK→Rising Deadline, Blackout Kick→Power Nap, Fists of Fury→Jittery Hands, Touch of Karma→"Per my last email", Vivify→Refill, FSK→Coffee Run, Paralysis→Out of Office. Ult→Triple Shot Espresso.
- BM Hunter → **Headhunter** (HR recruiter + Office Cat): Barbed Shot→Cold Call, Kill Command→"Sic 'em, Whiskers", Cobra Shot→LinkedIn Ping, Multi-Shot→Mass Mail, Bestial Wrath→Hiring Spree, Mend Pet→Treats, Freezing Trap→Endless Onboarding, Disengage→"Let's circle back". Ult→Cat Distribution System.
- Tooltip může mít malým WoW narážku? NE – čistě office.

## 11. ULTY + styl hraní (q = kvalita minihry 0–1, vše pod capem 35 %)
- **Overtime Berserker – CRUNCH TIME** (minihra: padající úkoly, chytáš do krabice, 6 s, max 9): každý chycený = 1 rána 0.15× okamžitě; ≥6 → Enrage 3 kola; vše chyceno → finále "Rage Quit" zdarma. +40 Stress. Styl: generuj Stress (Keyboard Smash/Energy Drink), drž Enrage, utrať Rage Quit; když soupeř <25 % → You're Fired. Hraje se agresivně, málo bránění.
- **Burnout Specialist – SUMMON THE INTERN** (minihra: Intern Run = provést stážistu chodbou tak, aby ho nechytil šéf; 3 checkpointy): stážista zůstane 1/2/3/4 kola podle checkpointů, každé kolo 0.4× + 1 Burnout; dorazil do cíle → navíc rozšíří Toxic Feedback (refresh DoT). Styl: nahoď Toxic Feedback, Hot Take sbírej Burnout, Escalation = Backdraft, pak Reply-All Nuke. Hra "nastav a vybuchni".
- **Excel Wizard – VLOOKUP OF DOOM** (minihra: tabulka, doplň výsledky vzorců, 6 s, Math): značka na soupeři 2 kola sbírá 25 % tvého dmg, pak exploduje ×(1 + 0.25 × správné, max 4); 4/4 → navíc 4 Nested Formulas. Styl: =SUM() nabij 4 formule (dražší a silnější), Ctrl+Enter vybij, Autofill při Clearcasting, hlídej STA, Ctrl+S jako reset. Hra o řízení many.
- **Espresso Monk – TRIPLE SHOT ESPRESSO** (minihra: Brew, 3× zastav ručičku v zóně): každý dobrý shot = 1 klon na 2 kola, kopíruje tvoje útoky 0.35×; 3/3 → +2 Shots a imunita na stun. Styl: Quick Sip generuje Shots, nikdy stejná schopnost 2× za sebou (Combo +8 %), Jittery Hands jako burst, "Per my last email" proti burstu soupeře. Rytmická, nejvíc taktická.
- **Headhunter – CAT DISTRIBUTION SYSTEM** (minihra: Bow, mířidlo na pobíhající životopisy/kočky, 3 střely): každý zásah = 1 kočka na 2 kola (0.3×/kolo), bullseye → všechny kočky hned skočí (Sic 'em zdarma). Styl: Cold Call drží Frenzy kočky, Sic 'em na CD, LinkedIn Ping na zbytek Focusu, Hiring Spree na burst. Nejjednodušší, pet dělá velkou část dmg – vhodné pro nové hráče.

## 12. TĚŽŠÍ MINIHRY (feedback: catch, brew, dodge moc easy)
- **CATCH (Crunch Time):** padají i ŠPATNÉ věci (📅 Meeting invite = −1 a krabice zmrzne 0.5 s, 💣 "Urgent from CEO" = konec série); rychlost roste s každým chyceným; věci se kývají do stran; krabice se po každém chycení zúží o 6 %; max 9 dobrých z ~14 objektů. qOf(dobré − 2×špatné, 9).
- **BREW (Triple Shot):** po každém shotu zóna −30 % a přesune se jinam; ručička zrychluje a náhodně otáčí směr (1–2× za shot); uvnitř zóny tenký PERFECT pruh (perfect = klon 0.45× místo 0.35×); 1 minutí = ten shot propadne (žádné opakování).
- **DODGE (obecně, i dodge3):** útok je telegrafovaný jen 250–400 ms (dle levelu soupeře); 30 % útoků je FINTA (změní dráhu v půlce); série 2–3 střel z různých stran; PERFECT dodge = uhnout v posledních 120 ms; po úspěšném dodge v řadě se okno zužuje (stejně jako PSTREAK u parry), reset po zásahu. Mobil: okna o 20 % delší.
- Obtížnost všech minihier škáluje: tower floor / boss / duel = těžší než běžný fight.
- **PARRY (těžší):** útoky v KOMBU 2–3 rány s různým tempem (musíš trefit všechny, perfect jen za všechny); ZAVÁHÁNÍ = soupeř se napřáhne, zastaví a udeří později; ČERVENÝ záblesk = nekrytelný útok → parry = trest (musíš uhnout/nechat být); HEAVY = podrž a pusť přesně v okamžiku dopadu; perfect okno 90 ms (teď širší), streak ho zúží až na 60 ms; fintu teď poznáš jen podle postavy, ne podle UI.

## 13. NOVÝ DESIGN POSTAV (HSRig zůstává jako kostra, nový vzhled + animace)
- **Overtime Berserker:** povolená kravata kolem hlavy, vyhrnuté rukávy, kalhoty od obleku, zbraň klávesnice (2H). Stress = červená pára z hlavy, při Enrage žíly a třes.
- **Burnout Specialist:** mikina s kapucí, kruhy pod očima, kouřící notebook v ruce, žhavé jiskry kolem. Burnout = plamínky na ramenou (1–5).
- **Excel Wizard:** svetr, brýle, propiska za uchem; kolem létají zelené buňky tabulky. Nested Formulas = 4 orbitující buňky, které se rozsvěcují.
- **Espresso Monk:** zástěra baristy, čelenka, hrnek, sloupek páry za pohybem. Shots = kávová zrnka nad hlavou (0–5).
- **Headhunter:** sako, visačka na šňůrce, desky s CV; vedle ní Office Cat (vlastní rig: idle, skok, útok, mňouk). Focus = lišta na deskách.
- Každá schopnost vlastní póza/animace (cast, nápřah, kanál), idle animace podle třídy, hit/flinch, vítězná a prohraná póza.
- Gear dál vidět na postavě (barva/doplňky), nepřátelé dostanou nové "office" skiny později (mimo Gen 3).

## 14. BALANC – výsledek simulace (tools/v12sim, sim.py + tune.py, p2.json)
- Model: duel HP 3000×hpM, cap 35 %, max 2 debuffy, reakce obránce 15+35 %×skill (−60 %, 15 STA), focus +12/akci +8/zásah, náhlá smrt po kole 12, heal ×0.65.
- hpM: Berserker 1.1, Burnout 0.95, Excel 0.9, Monk 1.0, Headhunter 1.0.
- Výsledné násobiče dmg třídy (relativně k Berserkerovi = 1.00): Burnout 1.01, Excel 1.55, Monk 1.42, Headhunter 1.22 → při Genu zapéct do koeficientů schopností (Excel a Monk mají nízké základní koeficienty / drahou manu).
- Průměr winrate všech tříd 47–54 %, průměrná délka duelu 11 kol (náhlá smrt rozhoduje jen výjimečně).
- Matchupy 34–65 % (kámen-nůžky-papír): Excel > Burnout (65 %), Monk > Headhunter (66 %), Monk > Excel (62 %), Berserker > Headhunter (61 %).
- Skill (0.8 vs 0.4) vyhrává 75–94 % → minihry a reakce rozhodují víc než třída. Berserker nejvíc odměňuje skill (94 %), Excel nejmíň (75 %).
- Největší jedna rána v sim: 15–25 % max HP (pod capem 35 %) → žádný oneshot.
- Při Genu: přenést do hs_engine, pak ověřit stávajícími testy (tunepvp) + PvE kampaň/tower/weekly boss.

## 15. ROZHODNUTO (1. 11.)
- Převod tříd AUTOMATICKY (Warden→Berserker, Trojan→Burnout, Mage→Excel, Caffeine→Monk, Hunter→Headhunter), level+gear zůstávají, talenty prázdné.
- Loterie = varianta B.
- Talenty 3 typy: (a) MĚNÍ schopnost, (b) NAHRADÍ schopnost novou, (c) PASIVKA. Talent mění jen schopnost, kterou máš v panelu → UI talentu ukáže "vyžaduje X v panelu", pokud tam není.
- DEBUFFY: limit počtu ZRUŠEN (debuff buildy OK). Místo toho: stejný debuff se nestackuje (jen obnoví délku / max 3 stacky u vybraných), součet DoT ticků za kolo max 15 % max HP cíle, BREATHE sundá 1 nejstarší debuff (counterplay). Sim bez limitu: průměry 47–53 %, beze změny.
- UI návrh SCHVÁLEN (artifact "High Stakes v12 UI", Main = PC duel): dock vlevo, arena + akční panel 6 tlačítek (klávesa, cena, cooldown výseč, "ready" červeně, zašedlé když nelze), focus lišta ulti nad panelem, log se 3 záložkami vpravo. Mobil = artboard "Mobile".
- UI v2 (1. 11.): TMAVÉ téma jako současná hra (bg #0d0f14, panely #161a23, okraje #242a36, šedý text #8e96a6, Space Grotesk), barvy lišt jako teď (HP zelená, stamina oranžová, focus fialová, soupeř červená), kancelářská scéna v pozadí arény zůstává.
- ZMĚNA (1. 11.): návrh UI působí jako downgrade → NEDĚLAT redesign vzhledu. Zachovat současný vzhled 1:1 (HSRig postavy, scéna s budovami a publikem, lišty, tlačítka, panely). Jen přidat: office dock vlevo (jen office inventář), akční panel 6 slotů ve stylu současných tlačítek (+klávesa, cooldown, ready), lištu zdroje třídy, buff odznaky, log se záložkami. Při Genu nejdřív screenshot ke schválení.
- POSTAVY = STYL C "Glow silhouettes" (SCHVÁLENO, uživatel nadšený, vibe Shadow Fight 2 – ale vlastní, office detaily):
  - Černé siluety (HSRig kostra → plynulé animace), svítí jen detaily třídy: Berserker rudá (čelenka, kravata, oči, pára), Burnout oranžovo-fialová (žhavý notebook, jiskry, kruhy pod očima), Excel zelená (buňky, brýle, pruhy svetru), Monk jantarová (pára z hrnku, čelenka, zrnka), Headhunter azurová (visačka, desky) + kočka se svítícíma očima.
  - Zdroj třídy = intenzita glow (víc Stress → víc páry; 4 formule → 4 svítící buňky).
  - Nepřátelé taky siluety, každý typ svou barvu glow; bossové víc detailů.
  - Scéna: tmavá kancelář s PROTISVĚTLEM (okna, monitory za postavami), aby siluety vynikly; publikum taky siluety.
  - Gear = svítící doplňky v barvě rarity. Efekty zásahů ve barvě útočníka (stopa zbraně, jiskry, rozmazání pohybu).
  - UI: současné rozložení + dock, akční panel; tlačítka schopností dostanou glow v barvě třídy.
- OFFICE REDESIGN SCHVÁLEN (artboard Office): neon obrysová místnost + silueta hráče, Resolve ticket tmavý s glow, šance chestu jako 1 pruh, inventář s rarity glow + merge přetažením, Workshop záložky (Scrap/Upgrades/Loadout/Plant), zdroje v horní liště. Samostatná etapa na konci.

## 16. CHEST SCALING FIX (do Gen 1 / malých věcí)
Problém (ověřeno v kódu script.html): cena otevření roste EXPONENCIÁLNĚ (×1.25 každých 10 lvl od 20: lvl100 = 7.5×, lvl200 = 69×), šance rostou LINEÁRNĚ a stropují (T2 ~lvl51, T3 ~lvl167, Mythic ~282, T4 až 334). Token = 0.3 % za OTEVŘENÍ → na vysokém lvl o 98 % míň tokenů za scrap. Legendary za scrap: peak ~lvl50 (0.61), lvl100 0.40, lvl200 0.09 → vyplatí se zůstat nízko.
Návrh:
- Cena: chestLevelCostFactor lineárně: lvl<20 = 1, jinak 1 + (lvl−20)/40 (lvl100 = 3×, lvl200 = 5.5×).
- Slot Token: šance × costFactor (cap 25 %) → tokeny za SCRAP stejné na každém levelu (spam nízko nic nedá).
- Po stropech šancí: každý level nad 170 +0.25 % šance na DOUBLE DROP (2 předměty z 1 otevření, cap 50 %) → upgrade má vždy smysl.
- Ověřit simem: položky/tokeny/legendary za 1 scrap musí s levelem jen RŮST; zkontrolovat ekonomiku GC (levnější open = víc itemů → případně upravit salvage).
- TOKEN ROZHODNUTÍ: Slot Token už NEPADÁ z otevírání chestu (TOKEN_CHANCE pryč). Žádné daily úkoly, nic za klikání (v práci drží Enter). Návrh nových zdrojů (čeká na OK):
  - Upgrade chestu: každých 10 levelů chestu +1 token (v rámci runu; motivuje upgradovat místo spamu).
  - Prestiž: +2 tokeny.
  - High Stakes: první výhra nad bossem kapitoly / nové patro toweru / účast na weekly bossovi +1.
  - Office Plant: ovoce má šanci dát token (už existuje Plant.fx("token") → přesunout na ovoce).
  - Zůstává: nákup za GC, achievementy, colleague, tréninková odměna.
- SCHVÁLENO: Slot Token → **⏱ OVERTIME HOURS** (OT). Úplně odpojeno od chestu (nepadá, tlačítko "Use Slot Token" u chestu pryč, Upgrade Station merge+1 za token pryč). Zdroje: +1 za každých 10 lvl chestu, PRESTIŽ +5 (+1 za každých 5 prestiží navíc), HS bossové/tower/weekly, ovoce Plant, achievementy, nákup za GC. Použití: HS energie, dungeon klíče, Forge garance/ochrana, reroll odměny v HS.
- MIGRACE v12: všem slotTokens = 0, pak retro: (součet prestiž odměn za dosažené prestiže) + (počet splněných achievementů × REWARD_TOKENS). Flag p.ot12, aby proběhlo 1×. Server: duel/nick nic, jen klient save.
- CHEST LEVELING: cena open lineárně (viz výš), GC cena upgradu zůstává 75×lvl^1.35, nad lvl 170 double drop, každých 10 lvl +1 OT a +1 LP (LP už je). UI ukáže "Next level: +X % Legendary, … " aby bylo vidět, že se to vyplatí.
- ZMĚNA: cena open ZŮSTÁVÁ EXPONENCIÁLNÍ (scrapu je hodně), jen zmírnit nahoře: ×1.25 / 10 lvl do lvl 100 (= 7.5×), potom ×1.12 / 10 lvl (lvl150 = 13×, lvl200 = 23× místo 69×). Šance jako PRUH (schváleno).
- VYSOKÉ LEVELY (200+, kluci jsou výš): cena ×1.25/10 do 100, ×1.12/10 do 300, ×1.08/10 nad 300. Po stropech šancí (T4 ~334): DOUBLE DROP od 170 (+0.25 %/lvl, cap 50 % ~lvl 370), TRIPLE DROP od 400 (+0.1 %/lvl, cap 25 % ~lvl 650), soft-cap šancí: nad stropem T4/T5/T6 dál +0.002 %/lvl (bez limitu). Každých 10 lvl dál +1 OT, +1 LP. → žádný level, kde by upgrade přestal dávat smysl.

## 17. HS GEAR – návrh doplnění (čeká na výběr)
1. LEGENDARY EFEKTY tříd: T4+ může mít efekt, který mění schopnost (např. "Rage Quit +1 rána", "Toxic Feedback se šíří", "Autofill +1 střela", "Kočka útočí 2×"). Gear tak doplní talenty → buildy.
2. SETY (2/4 kusy) pro každou třídu: 2 ks = bonus ke zdroji, 4 ks = změna ulti.
3. LOADOUTY: uložit 3 sestavy (gear + 4 schopnosti + talenty) a přepnout jedním klikem (PvE vs duel).
4. Porovnání při dropu: zelená/červená čísla + "lepší pro tvůj build" podle zvolených schopností.
5. Glow doplňky na siluetě v barvě rarity (už v plánu) + legendary efekt má vlastní částice.
6. Duel equal mode dál ignoruje staty, ale legendary efekty/sety NE? → rozhodnout (návrh: v equal módu jen efekty, ne čísla).
7. SEKUNDÁRNÍ STATY na gearu (WoW styl): CRIT, HASTE (rychlejší regen zdroje / kratší CD), VERSATILITY (+dmg i −dmg přijatý), MASTERY = jiná pro každou třídu:
   - Berserker "Unhinged": +% dmg během Enrage
   - Burnout "Chronic Stress": +% dmg DoT a stážisty
   - Excel "Nested Logic": +% dmg za každou Nested Formula
   - Monk "Combo Strikes": větší bonus za střídání schopností
   - Headhunter "Pack Leader": +% dmg kočky
   Gear ukazuje, která staty sedí tvé třídě (zvýraznit). Zapéct do simu před Genem.
8. FIX AUTOSCRAP: dnes nejde scrapnout lvl40 když mám lvl43 +2, protože "by byl lepší na +8". Nově: předmět je "beznadějný", když NENÍ lepší než nasazený při STEJNÉM +levelu (nebo max +2 nad nasazeným). Nastavení "Keep if better within +N" (0–5, default 2). Autoscrap a "salvage hopeless" používají totéž.
9. SETY LITE (schváleno): každá třída 1 set, jen 2-kusový bonus (malý, bez změny ulti): Berserker "Overtime Suit" +10 % Stress z ran; Burnout "Smoke Break" DoT +1 kolo; Excel "Spreadsheet Robes" 4. formule −20 % ceny; Monk "Barista Kit" +1 Shot na začátku boje; Headhunter "Recruiter Lanyard" kočka +10 % dmg. Set kusy padají jako T3+ s tagem setu. 4-kus později.

## 18. FINÁLNÍ POŘADÍ (napiš jen "Gen")
Etapa 1 – 3a JÁDRO: schopnosti jako data, 5 nových tříd (office jména, §9–11), převod tříd auto, duel HP×3 + cap 35 %, debuffy BEZ limitu počtu (nestackují se, DoT cap 15 %/kolo, BREATHE čistí), balanc dle sim (§14), sekundární staty + Mastery (§17.7), sety lite.
Etapa 2 – 3b UI+POSTAVY: talenty (§9), akční panel, office dock (§8), STYL C glow siluety (§15), těžší minihry (§12), legendary efekty + loadouty + porovnání (§17.1/3/4), screenshot ke schválení PŘED commitem.
Etapa 3 – NIGHT SHIFT (§4–5).
Etapa 4 – MALÉ: loterie B, log 3 záložky, CHEST scaling (§16: exp. zmírněná, double/triple drop, šance pruh), OVERTIME HOURS (reset + retro za prestiž/achievementy), autoscrap fix (§17.8).
Etapa 5 – OFFICE REDESIGN (neon, artboard Office).
Konec: firemní verze najednou, changelog v12.0, DONE9 (smazat DONE8), přehled souborů.
Pokud dojde usage: každá etapa commitnutá a funkční, navázat příště podle tohoto souboru.

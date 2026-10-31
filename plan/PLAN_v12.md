# Office Royale v12 – FINÁLNÍ PLÁN (vše schváleno 1. 11. 2026)
Pravidla: začít až po "Gen". Etapy commitnout zvlášť (domácí verze), firemní verze najednou na konci. Na konci DONE9, smazat DONE8. In-game texty anglicky.

## POŘADÍ ETAP
1. **Jádro** – nové třídy, schopnosti jako data, duel pravidla, staty + Mastery, sety lite.
2. **UI + postavy** – talenty, akční panel, office dock, glow siluety, těžší minihry, legendary efekty, loadouty, porovnání. Screenshot ke schválení PŘED commitem.
3. **Night Shift** – deckbuilder místo SHIFT.
4. **Malé věci** – loterie B, log 3 záložky, chest scaling, Overtime Hours, autoscrap fix.
5. **Office redesign** (neon).
6. **Konec** – firemní verze, changelog v12.0, DONE9, přehled souborů.

---

## 1. TŘÍDY (office jména, WoW mechaniky v závorce jen pro orientaci)
Převod automaticky: Warden→Berserker, Trojan→Burnout, Mage→Excel, Caffeine→Monk, Hunter→Headhunter. Level + gear zůstávají, talenty prázdné.

| Třída | Zdroj | Mastery | Ulti (minihra) |
|---|---|---|---|
| Overtime Berserker (Fury) | Stress 0–100 | Unhinged: +% dmg v Enrage | Crunch Time (chytání úkolů) |
| Burnout Specialist (Destro) | Burnout 0–5 | Chronic Stress: +% DoT a stážista | Summon the Intern (Intern Run) |
| Excel Wizard (Arcane) | Nested Formulas 0–4 + mana=STA | Nested Logic: +% dmg za formuli | VLOOKUP of Doom (vzorce v tabulce) |
| Espresso Monk (Windwalker) | Shots 0–5 | Combo Strikes: bonus za střídání | Triple Shot Espresso (Brew) |
| Headhunter (BM) + Office Cat | Focus 0–100 | Pack Leader: +% dmg kočky | Cat Distribution System (luk) |

### Spellbook (8 schopností, odemykání L1, L1, L5, L10, L15, L20, L30, L40; do boje 4 + STRIKE + BREATHE vždy)
**Berserker** (Stress: STRIKE +15, přijatý dmg +1 za 1 % max HP, −5/kolo)
- Keyboard Smash: 0.9× (1.2× v Enrage), +12 Stress, 10 STA
- Energy Drink Chug: 1.1×, heal 3 %, 30 % Enrage, +10 Stress, CD1, 15 STA
- Rage Quit: 80 Stress, 4× 0.45×, vždy Enrage (+20 % dmg 2 kola)
- Desk Flip: 20 Stress, 0.7× + další 2 útoky +0.3×, CD2
- "You're Fired": 30 Stress, jen cíl <25 % HP, 1.8×
- Lunch Break: heal 12 % během 2 kol, CD5
- Motivational Speech: +15 % ATK 3 kola, CD6
- "Let me stop you there": 10 Stress, přeruší speciál soupeře, CD4
- Ulti Crunch Time: každý chycený úkol = rána 0.15×; ≥6 → Enrage 3 kola; vše = Rage Quit zdarma; +40 Stress.

**Burnout Specialist**
- Hot Take: 1.0×, +1 Burnout, 15 STA
- Toxic Feedback: DoT 0.3×/kolo 4 kola, tick 40 % +1 Burnout, CD3, 15 STA
- Reply-All Nuke: 2 Burnout, 1.6× vždy crit
- Escalation: 1.0×, cíl s DoT → +1 Burnout a příští Hot Take ×1.3, CD3
- Spam Storm: 3 Burnout, 3 kola 0.5×/kolo, nejde dodge
- Sick Day: štít 15 % max HP za 5 % HP, CD5
- Final Warning: 1 Burnout, 1.2×, cíl <20 % → Burnout zpět, CD4
- "1:1 with HR": 1 Burnout, soupeř 1 kolo jen BREATHE, CD6
- Ulti Summon the Intern: stážista 1–4 kola (checkpointy), 0.4×/kolo +1 Burnout; cíl → obnoví Toxic Feedback.

**Excel Wizard** (každá formule: +15 % dmg =SUM(), +25 % cena)
- =SUM(): 1.0×, +1 formule, 15 STA, 20 % Clearcasting
- Ctrl+Enter: 0.6× + 0.3× za formuli, vybije je, +5 STA za formuli
- Autofill: jen po Clearcasting, 3× 0.4×, nejde blok
- Pivot Table: 0.8×, +1 formule, 25 % Clearcasting, 20 STA
- Ctrl+S: místo BREATHE +60 STA, vybije formule, CD5
- Read-Only Mode: 1 kolo imunita, CD7
- #REF!: přeruší + soupeř −20 Focus, CD5, 15 STA
- Macro: 2.0× × (STA/max), CD6, 30 STA
- Ulti VLOOKUP of Doom: značka 2 kola sbírá 25 % dmg, výbuch ×(1+0.25×správné); 4/4 → plné formule.

**Espresso Monk** (Combo: jiná schopnost než minule = +8 %, lifesteal 5 %)
- Quick Sip: 0.6×, +2 Shots, 10 STA
- Rising Deadline: 2 Shots, 1.3×, soupeř −30 % léčení 2 kola, CD2
- Power Nap: 1 Shot, 0.9×, −1 CD Rising Deadline
- Jittery Hands: 3 Shots, 4× 0.35×, −30 % přijatý dmg, CD3
- "Per my last email": 2 kola vrací 50 % dmg (cap 20 % jeho max HP), sám dostane 50 %, CD7
- Refill: 1 Shot, heal 8 %, CD3
- Coffee Run: 0.8× + jistý dodge příští kolo, CD4, 15 STA
- Out of Office: 2 Shots, stun 1 kolo (ne ulti), CD6
- Ulti Triple Shot Espresso: každý dobrý shot = klon 2 kola (0.35×, perfect 0.45×); 3/3 → +2 Shots, imunita stun.

**Headhunter** (Focus +10/kolo, kočka 0.25×/kolo)
- Cold Call: DoT 0.2× 3 kola, +20 Focus, Frenzy kočky +1 (max 3, +8 %), CD2
- "Sic 'em, Whiskers": 30 Focus, kočka 1.1×, CD1
- LinkedIn Ping: 35 Focus, 0.8×, −1 CD Sic 'em
- Mass Mail: 40 Focus, 0.6× + kočka +30 % 2 kola
- Hiring Spree: +25 % dmg ty i kočka 2 kola, CD6
- Treats: heal 10 % tobě i kočce, CD6
- Endless Onboarding: 20 Focus, soupeř ztratí akci (ne ulti), CD7
- "Let's circle back": 10 Focus, jistý dodge +10 Focus, CD4
- Ulti Cat Distribution System: každý zásah = kočka 2 kola (0.3×); bullseye → Sic 'em zdarma.

### Talenty
- Řádek na L10/20/30/40/50/60, 3 volby, vybereš 1. Typy: mění schopnost / nahradí schopnost / pasivka. Talent na schopnost funguje jen když je v panelu ("requires X in your bar").
- Respec zdarma mimo boj. Server v duelu ověří schopnosti + talenty.
- Konkrétní talenty: vycházejí z WoW řádků (Fury/Destro/Arcane/WW/BM), při Genu přejmenovat do office stylu.

## 2. DUEL A BALANC
- Duel HP ×3, žádná rána >35 % max HP (mimo náhlou smrt), náhlá smrt zůstává (po kole 12).
- Debuffy BEZ limitu počtu. Stejný debuff se nestackuje (obnoví délku, vybrané max 3 stacky), všechny DoT max 15 % max HP/kolo, BREATHE sundá nejstarší debuff.
- Simulace (plan/v12sim): třídy 47–54 %, duel ~11 kol, matchupy 34–65 %, skill 0.8 vs 0.4 vyhrává 75–94 %, max rána 15–25 %.
- Relativní dmg násobiče z simu (Berserker = 1.00): Burnout 1.01, Excel 1.55, Monk 1.42, Headhunter 1.22 → zapéct do koeficientů. hpM: Berserker 1.1, Burnout 0.95, Excel 0.9, Monk 1.0, Headhunter 1.0.
- Po implementaci ověřit tunepvp + PvE kampaň/tower/weekly boss.
- Equal-mode duel: platí legendary efekty a sety, NE čísla.

## 3. GEAR
- Sekundární staty: Crit, Haste (regen zdroje/CD), Versatility (+dmg, −přijatý dmg), Mastery (podle třídy, tabulka výš). Zvýraznit staty sedící třídě.
- Legendary efekty (T4+) mění schopnost (např. Rage Quit +1 rána, Autofill +1 střela, kočka 2× útočí).
- Sety LITE (jen 2 kusy, T3+ s tagem): Overtime Suit +10 % Stress z ran; Smoke Break DoT +1 kolo; Spreadsheet Robes 4. formule −20 % ceny; Barista Kit +1 Shot na startu; Recruiter Lanyard kočka +10 % dmg. 4 kusy později.
- Loadouty: 3 uložené sestavy (gear + 4 schopnosti + talenty), přepnutí 1 klikem.
- Porovnání při dropu: zelená/červená čísla + "better for your build".
- Autoscrap fix: "hopeless" = není lepší než nasazený na stejném +levelu. Nastavení "Keep if better within +N" (0–5, default 2). Autoscrap i salvage stejná logika.

## 4. VZHLED HIGH STAKES
- Zachovat současné rozložení a tmavé téma, přidat: office dock vlevo (ticket button, buy/open chest, suroviny, JEN office inventář + Merger; sbalitelný; mobil = šuplík), akční panel 6 slotů (klávesa 1–6, cena, cooldown výseč, ready glow v barvě třídy, zašedlé když nejde), lišta zdroje třídy pod Focus, buff odznaky nad postavou, log 3 záložky.
- POSTAVY = glow siluety (styl C, vibe Shadow Fight 2): černé siluety na HSRig kostře, svítí jen detaily třídy: Berserker rudá, Burnout oranžovo-fialová, Excel zelená, Monk jantarová, Headhunter azurová + kočka se svítícíma očima. Glow = stav zdroje. Nepřátelé taky siluety (barva podle typu). Gear = svítící doplňky v barvě rarity.
- Scéna: tmavá kancelář s protisvětlem (okna, monitory), publikum jako siluety, parallax. Efekty: létající čísla, otřes při critu, částice podle třídy, záblesk perfect parry.
- Návrhy: artifact "High Stakes v12 UI" (Main/Mobile = rozložení, Styles = styl C, Office = office redesign).

## 5. TĚŽŠÍ MINIHRY
- Chytání: špatné věci (Meeting invite −1 + zmrznutí, CEO bomba = konec), zrychlení, kývání, krabice se zužuje. qOf(dobré − 2×špatné, 9).
- Brew: zóna −30 % a přeskočí, ručička zrychluje a mění směr, PERFECT pruh, minutí = shot propadne.
- Dodge: telegraf 250–400 ms, 30 % finty, série 2–3 střel, perfect jen v posledních 120 ms, okno se zužuje se sérií; mobil +20 %.
- Parry: komba 2–3 ran, zaváhání, červený nekrytelný útok, heavy = podrž a pusť, perfect 90 ms → se sérií 60 ms, fintu poznáš jen podle postavy.
- Obtížnost: fight < tower < boss < duel.
- Intern Run (Burnout ulti): klikatá chodba, táhnutí relativně (prst nezakrývá), 3 checkpointy, dotyk stěny = "DETECTED" návrat na checkpoint, limit 7 s, šipky na PC.

## 6. NIGHT SHIFT (místo SHIFT, nový soubor hs_shift)
- Mapa ~12 uzlů ve 3 sloupcích: boj, elita, incident, automat (shop / odebrat kartu), kuchyňka (heal 30 % nebo upgrade karty), boss. HP a balíček se nesou, energie HS jako teď.
- Karty = akce enginu + modifikátor; ruka 4 karty, reakce (block/dodge…) vždy dostupné.
- Startovní balíček 10: 4× STRIKE, 2× HEAVY, GAMBLE, BREATHE, 2× karta třídy (z nových schopností). ~30 dalších karet (Overtime, Coffee Break, Reply All, Escalate, Root Cause, Code Freeze, Rubber Duck…), po boji 1 ze 3.
- Relikvie místo perků (10–15), po elitě/bossovi 1 ze 3. Incidenty: Printer on fire, Phishing e-mail, CEO in the elevator.
- Art jen pro Shift: "kancelář v noci / papír a sodíkové lampy" (#0f1b2d, #f2a541, #efe6d2, #2b2b2b, #c8372d), karty jako kartotéční lístky/post-it (Special Elite + IBM Plex Mono), mapa jako blueprint půdorys, incident = vytištěný ticket s URGENT, výhra = razítko RESOLVED. Postavy glow siluety.

## 7. MALÉ VĚCI
- Loterie B: 3 čísla + 1 bonus; 2 shody + bonus = mini jackpot 25 % poolu (dělí se), 3 shody = jackpot 90 %. UI ukáže bonus a typ výhry.
- Log: záložky System / Chat / Incidents (duely, MK kill, jackpoty, announce), tečka nepřečtených, i na mobilu.
- CHEST:
  - Cena otevření exponenciální, nahoře mírnější: ×1.25 / 10 lvl do 100, ×1.12 / 10 lvl do 300, ×1.08 / 10 lvl nad 300 (lvl200 23×, lvl400 155×, lvl1000 ~15 700×).
  - Šance: po stropech dál +0.002 %/lvl (T4/T5/T6). Double drop od 170 (+0.25 %/lvl, cap 50 %), triple drop od 400 (+0.1 %/lvl, cap 25 %). Doladit podle hráčů.
  - Každých 10 lvl: +1 Overtime Hours, +1 LP. UI: šance jako barevný pruh + náhled "next level gives…". GC cena upgradu beze změny.
- OVERTIME HOURS (místo Slot Token): z chestu NEPADÁ, u chestu se nepoužívá (pryč "Use Slot Token" i merge +1 v Upgrade Station). Zdroje: +1 / 10 lvl chestu, prestiž +5 (+1 za každých 5 prestiží), HS boss kapitoly / nové patro toweru / účast weekly boss +1, ovoce Plant (šance), achievementy, nákup za GC. Použití: HS energie, dungeon klíče, Forge garance/ochrana, reroll odměny v HS.
  - Migrace: všem 0, pak retro jen za prestiže + achievementy (flag p.ot12, jednou).

## 8. OFFICE REDESIGN (artboard Office)
- Horní lišta se zdroji a navigací. Místnost jako neon obrysy + hráč jako silueta. Resolve ticket tmavý s glow + létající čísla. Šance chestu jako pruh. Inventář s rarity glow, merge přetažením. Workshop záložky: Scrap / Upgrades / Loadout / Plant. Gamble dole. Animace otevření chestu podle rarity.

## 9. FIREMNÍ VERZE
- Nové malé soubory: hsdock, hs_shift (vlastní skupiny v build_work GROUPS), aby se velké soubory měnily co nejmíň. Ostatní podle změn; na konci přehled, co zkopírovat.

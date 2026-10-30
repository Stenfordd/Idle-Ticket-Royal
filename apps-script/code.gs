/**
 * IDLE ROYALE - Home Edition  (backend, kontejnerový skript navázaný na Google Sheets)
 * Soubor v Apps Scriptu: "code" (.gs). Frontend je statický web (GitHub Pages), tohle je jen API.
 *
 * - Přihlášení: přezdívka + PIN (registrace bez pozvánky, limit hráčů v Config!B11)
 * - v7: dungeon v leaderboardu + score, sdílená historie rulety (Config!B12), vyšší max sázka PvP
 * - API: doPost({fn, args, auth:{nick,h}}) -> { ok, data } | { ok:false, error }
 * - Před prvním použitím spusť jednou funkci setupHome() (vytvoří listy, pozvánkový kód a sůl).
 *
 * Nasazení: Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone
 */

var CHUNK_SIZE = 45000;

function doGet(e) {
  return json_({ ok: true, name: 'Idle Royale API', version: getAppVersion_() });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('Idle Royale')
      .addItem('Bump version (donutí klienty k obnovení)', 'bumpAppVersionUi_')
      .addItem('Spustit firemní globální event', 'triggerGlobalEventUi_')
      .addItem('Zobrazit pozvánkový kód', 'showInviteUi_')
      .addItem('Reset PINu hráče', 'resetPlayerUi_')
      .addSeparator()
      .addItem('Wipe season (nová sezóna)', 'adminSeasonWipeUi_')
      .addToUi();
  } catch (e) {}
}

function showInviteUi_() {
  var cfg = getDb_().config;
  SpreadsheetApp.getUi().alert('Pozvánkový kód: ' + cfg.getRange('B9').getValue() + '\nMax hráčů: ' + cfg.getRange('B11').getValue());
}

function adminSeasonWipeUi_() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Opravdu spustit novou sezónu?', 'Smaže všechny savy, chat, feed a PvP. Nelze vrátit.', ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) ui.alert(adminSeasonWipe());
}

function bumpAppVersionUi_() {
  var v = bumpAppVersion_();
  SpreadsheetApp.getUi().alert('Verze nastavena na ' + v + '. Klienti se obnoví do pár minut (po dohrání kola a uložení).');
}

// ==========================================================================
// APP VERSION (Config!B8)
// ==========================================================================
function getAppVersion_() {
  try {
    var cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
    if (!cfg) return '1';
    var v = cfg.getRange('B8').getValue();
    if (v === '' || v === null) {
      cfg.getRange('A8:B8').setValues([['App_Version', '1']]);
      return '1';
    }
    return String(v);
  } catch (e) { return '1'; }
}

function getAppVersion() { return getAppVersion_(); }

function bumpAppVersion_() {
  var cfg = getDb_().config;
  var v = String(Date.now());
  cfg.getRange('A8:B8').setValues([['App_Version', v]]);
  return v;
}

// ==========================================================================
// IDENTITY + DB
// ==========================================================================
var CURRENT_USER_ = '';
function getUserLdap() { return CURRENT_USER_ || ''; }

function getDb_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var savesSheet = ss.getSheetByName('Saves');
  if (!savesSheet) {
    savesSheet = ss.insertSheet('Saves');
    savesSheet.appendRow(['LDAP', 'SaveData']);
    savesSheet.setFrozenRows(1);
  }

  var configSheet = ss.getSheetByName('Config');
  if (!configSheet) {
    configSheet = ss.insertSheet('Config');
    configSheet.getRange('A1:B8').setValues([
      ['Current_Season', 1],
      ['Roulette_Start_Time', 0],
      ['Roulette_Pot', 0],
      ['Roulette_Status', 'WAITING'],
      ['Last_Winner', 'None yet'],
      ['Roulette_Feed', '[]'],
      ['Roulette_Top_Wins', '[]'],
      ['App_Version', '1']
    ]);
    configSheet.setFrozenRows(1);
  }

  var chatSheet = ss.getSheetByName('Chat');
  if (!chatSheet) {
    chatSheet = ss.insertSheet('Chat');
    chatSheet.appendRow(['Timestamp', 'User', 'Message']);
    chatSheet.setFrozenRows(1);
  }

  return { ss: ss, saves: savesSheet, config: configSheet, chat: chatSheet };
}

function rowToJson_(row) {
  var s = '';
  for (var c = 1; c < row.length; c++) {
    if (row[c] !== '' && row[c] !== null) s += String(row[c]);
  }
  return s;
}

function loadGame() {
  var db = getDb_();
  var user = getUserLdap();
  var currentSeason = Number(db.config.getRange('B1').getValue()) || 1;
  var data = db.saves.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === user) {
      try {
        var parsed = JSON.parse(rowToJson_(data[i]));
        parsed.ldap = user;
        if (!parsed.season || Number(parsed.season) < currentSeason) {
          return { ldap: user, isNew: true, season: currentSeason };
        }
        return parsed;
      } catch (e) {
        break;
      }
    }
  }
  return { ldap: user, isNew: true, season: currentSeason };
}

/**
 * Vrací { ok:true, rev } | { ok:false, reason:'season'|'busy'|'error'|'conflict' }
 * Optimistický zámek: klient posílá revizi, ze které vycházel (baseRev). Pokud mezitím uložilo jiné zařízení / záložka,
 * revize nesedí a uložení se odmítne (reason 'conflict'), takže starý stav nikdy nepřepíše novější progres.
 */
function saveGame(stateJson, baseRev) {
  var db = getDb_();
  var user = getUserLdap();
  var currentSeason = Number(db.config.getRange('B1').getValue()) || 1;

  var state;
  try {
    state = JSON.parse(stateJson);
  } catch (e) {
    return { ok: false, reason: 'error' };
  }
  if (state.season && Number(state.season) < currentSeason) {
    return { ok: false, reason: 'season', season: currentSeason };
  }
  state.season = currentSeason;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: false, reason: 'busy' };
  try {
    var lastRow = db.saves.getLastRow();
    var rowIndex = -1, storedRev = 0;
    if (lastRow >= 2) {
      var users = db.saves.getRange(2, 1, lastRow - 1, 1).getValues();
      for (var i = 0; i < users.length; i++) {
        if (users[i][0] === user) { rowIndex = i + 2; break; }
      }
    }
    if (rowIndex > 0) {
      var cur = db.saves.getRange(rowIndex, 1, 1, Math.max(db.saves.getLastColumn(), 2)).getValues()[0];
      var storedSid = '';
      try { var curObj = JSON.parse(rowToJson_(cur)); storedRev = Number(curObj.rev) || 0; storedSid = String(curObj.sid || ''); } catch (e2) { storedRev = 0; }
      // v8.6.1: poslední zápis udělal tentýž tab (jen se mu ztratila odpověď - mobil uspal stránku, timeout) -> není to konflikt
      var sameTab = !!state.sid && String(state.sid) === storedSid;
      if (Number(baseRev) !== storedRev && !sameTab) return { ok: false, reason: 'conflict', rev: storedRev };
    }
    state.rev = storedRev + 1;
    presenceStamp_(user, state);
    var json = JSON.stringify(state);

    var chunks = [];
    for (var p = 0; p < json.length; p += CHUNK_SIZE) chunks.push(json.substring(p, p + CHUNK_SIZE));
    var row = [user].concat(chunks);

    if (rowIndex > 0) {
      var width = Math.max(db.saves.getLastColumn(), row.length);
      while (row.length < width) row.push('');
      db.saves.getRange(rowIndex, 1, 1, width).setValues([row]);
    } else {
      db.saves.appendRow(row);
    }
    return { ok: true, rev: state.rev };
  } catch (err) {
    return { ok: false, reason: 'error' };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================================================
// FEED (roulette / sloty / chicken / pachinko)
// ==========================================================================
function cleanTxt_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[<>&"']/g, '').substring(0, max);
}

function logRouletteSpin(entryJson) {
  var db = getDb_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;

  try {
    var entry = JSON.parse(entryJson);
    entry.user = cleanTxt_(entry.user, 30);
    entry.num = cleanTxt_(entry.num, 30);
    entry.color = cleanTxt_(entry.color, 20);
    entry.payout = Number(entry.payout) || 0;
    entry.wager = Number(entry.wager) || 0;
    entry.time = cleanTxt_(entry.time, 10);

    var configVals = db.config.getRange('A1:B7').getValues();

    var feed = [];
    try { feed = JSON.parse(configVals[5][1]); } catch (e) { feed = []; }
    if (!Array.isArray(feed)) feed = [];
    feed.unshift(entry);
    if (feed.length > 10) feed = feed.slice(0, 10);

    var topWins = [];
    try { topWins = JSON.parse(configVals[6][1]); } catch (e) { topWins = []; }
    if (!Array.isArray(topWins)) topWins = [];
    if (entry.payout > 0) {
      topWins.push(entry);
      topWins.sort(function (a, b) { return (b.payout || 0) - (a.payout || 0); });
      if (topWins.length > 10) topWins = topWins.slice(0, 10);
    }

    db.config.getRange('B6').setValue(JSON.stringify(feed));
    db.config.getRange('B7').setValue(JSON.stringify(topWins));
    if (/^(RED|BLACK|GREEN)$/.test(entry.color)) {
      var hist = [];
      try { hist = JSON.parse(db.config.getRange('B12').getValue() || '[]'); } catch (e) { hist = []; }
      if (!Array.isArray(hist)) hist = [];
      hist.unshift({ user: entry.user, num: entry.num, color: entry.color });
      db.config.getRange('A12:B12').setValues([['Roulette_History', JSON.stringify(hist.slice(0, 12))]]);
    }
    return true;
  } catch (err) {
    return false;
  } finally {
    lock.releaseLock();
  }
}

// ==========================================================================
// CHAT
// ==========================================================================
function sendChatMessage(text) {
  if (!text || typeof text !== 'string') return { success: false, error: 'Empty message' };
  var cleanText = text.trim().substring(0, 180);
  if (!cleanText) return { success: false, error: 'Empty message' };

  var user = getUserLdap();
  var db = getDb_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(4000)) return { success: false, error: 'Server busy, retry in a moment' };

  try {
    if (/^[=+\-@]/.test(cleanText)) cleanText = "'" + cleanText;
    db.chat.appendRow([new Date(), user, cleanText]);

    var lastRow = db.chat.getLastRow();
    if (lastRow > 105) {
      db.chat.deleteRows(2, lastRow - 101);
    }
    return { success: true, messages: getRecentChatMessages_(db.chat) };
  } catch (e) {
    return { success: false, error: e.toString() };
  } finally {
    lock.releaseLock();
  }
}

function getRecentChatMessages_(chatSheet) {
  var lastRow = chatSheet.getLastRow();
  if (lastRow <= 1) return [];

  var startRow = Math.max(2, lastRow - 39);
  var numRows = lastRow - startRow + 1;
  var rows = chatSheet.getRange(startRow, 1, numRows, 3).getValues();

  var result = [];
  for (var i = 0; i < rows.length; i++) {
    var rawDate = rows[i][0];
    var timeStr = '';
    if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
      timeStr = Utilities.formatDate(rawDate, Session.getScriptTimeZone() || 'GMT+1', 'HH:mm');
    } else if (rawDate) {
      var s = String(rawDate);
      var parts = s.split(' ');
      timeStr = parts.length > 1 ? parts[1].substring(0, 5) : s.substring(0, 5);
    }
    result.push({
      time: timeStr,
      user: String(rows[i][1] || 'agent'),
      text: String(rows[i][2] || '')
    });
  }
  return result;
}

// ==========================================================================
// LEADERBOARD + SCORE
// Score je monotónní: prestiž, lifetime tickets a nejvyšší chest level se nikdy nesnižují
// ani se neresetují prestiží. Coiny / scrap / gambling do skóre nevstupují.
// ==========================================================================
function prestigeCost_(p) {
  return Math.floor(200000 * Math.pow(4.2, p));
}

function computeScore_(s) {
  var prestige = Number(s.prestige) || 0;
  var life = Number(s.lifetimeTickets);
  if (!isFinite(life) || life <= 0) {
    // starý save bez lifetimeTickets: dopočet = ceny dosažených prestiží + aktuální tickety
    life = Number(s.tickets) || 0;
    for (var p = 0; p < prestige; p++) life += prestigeCost_(p);
  }
  var maxChest = Math.max(Number(s.maxChestLevel) || 0, Number(s.chestLevel) || 1);
  var floor = (s.dungeon && Number(s.dungeon.best)) || 0;
  return Math.floor(prestige * 1000000 + 100000 * Math.log(1 + life) / Math.LN10 + 5000 * maxChest + 25000 * floor);
}

function buildLeaderboard_(db, currentSeason) {
  var saves = db.saves.getDataRange().getValues();
  var leaderboard = [];
  for (var i = 1; i < saves.length; i++) {
    try {
      var raw = rowToJson_(saves[i]);
      if (!raw) continue;
      var s = JSON.parse(raw);
      if (!s.season || Number(s.season) < currentSeason) continue;

      var dg = s.dungeon || {};
      var gear = [];
      ['HEAD', 'RIG', 'TOOL', 'AUGMENT', 'OS', 'RELIC'].forEach(function (k) {
        var it = s.loadout && s.loadout[k];
        if (it) gear.push('T' + (Number(it.tier) || 0) + '+' + (Number(it.lvl) || 0));
      });
      leaderboard.push({
        ldap: saves[i][0],
        prestige: s.prestige || 0,
        chestLvl: Math.max(Number(s.maxChestLevel) || 0, Number(s.chestLevel) || 1),
        gambleNet: s.gambleNet || 0,
        peakCps: Number(s.peakCps) || 0,
        gear: cleanTxt_(dg.gearTxt ? String(dg.gearTxt) : gear.join(' '), 80),
        dungeon: { cls: cleanTxt_(dg.cls, 12), level: Number(dg.level) || 0, best: Number(dg.best) || 0, camp: Number(dg.camp) || 1, stars: Number(dg.stars) || 0, wins: Number(dg.wins) || 0, losses: Number(dg.losses) || 0, title: cleanTxt_(dg.title, 40), honor: arenaHonorOf_(saves[i][0]) },
        ach: (function () { var u = s.hs && s.hs.ach && s.hs.ach.u; if (!u || typeof u !== 'object') return []; return Object.keys(u).slice(0, 60).map(function (k) { return cleanTxt_(k, 20); }); })(),
        score: computeScore_(s),
        presence: presenceOf_(s).presence,
        seen: presenceOf_(s).seen
      });
    } catch (e) {}
  }
  leaderboard.sort(function (a, b) { return b.score - a.score; });
  return leaderboard.slice(0, 10);
}

function getLeaderboardAndRoulette() {
  var db = getDb_();
  var config = db.config.getRange('A1:B7').getValues();
  var currentSeason = Number(config[0][1]) || 1;

  var cache = CacheService.getScriptCache();
  var key = 'tt_lb_v4_s' + currentSeason;
  var leaderboard = null;
  try {
    var cached = cache.get(key);
    if (cached) leaderboard = JSON.parse(cached);
  } catch (e) {}
  if (!leaderboard) {
    leaderboard = buildLeaderboard_(db, currentSeason);
    try { cache.put(key, JSON.stringify(leaderboard), 10); } catch (e) {}
  }

  var feed = [];
  try { feed = JSON.parse(config[5][1]); } catch (e) {}
  var topWins = [];
  try { topWins = JSON.parse(config[6][1]); } catch (e) {}
  var rouletteHistory = [];
  try { rouletteHistory = JSON.parse(db.config.getRange('B12').getValue() || '[]'); } catch (e) {}

  return {
    leaderboard: leaderboard,
    feed: feed,
    topWins: topWins,
    rouletteHistory: rouletteHistory,
    chat: getRecentChatMessages_(db.chat),
    currentSeason: currentSeason
  };
}

// ==========================================================================
// PvP SHOWDOWN (kámen-nůžky-papír, best of 3, asynchronně)
// Stake se stahuje na klientu; server drží výzvy a výplaty. Výplata se vyzvedává přes pvpPoll().
// Moves: řetězec 3 znaků z R, P, S (kámen, papír, nůžky). Moves výzvy se klientům nikdy neposílají.
// ==========================================================================
var PVP_RAKE = 0.05;
var PVP_MAX_OPEN = 3;
var PVP_EXPIRE_MS = 24 * 3600 * 1000;
var PVP_MIN_STAKE = 10;
var PVP_MAX_STAKE = 10000000;

function pvpSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ch = ss.getSheetByName('PvP_Challenges');
  if (!ch) {
    ch = ss.insertSheet('PvP_Challenges');
    ch.appendRow(['ID', 'Creator', 'Stake', 'CreatorMoves', 'Status', 'Opponent', 'OppMoves', 'Result', 'CreatedAt', 'ResolvedAt', 'Score']);
    ch.setFrozenRows(1);
  }
  var pay = ss.getSheetByName('PvP_Payouts');
  if (!pay) {
    pay = ss.insertSheet('PvP_Payouts');
    pay.appendRow(['ID', 'Player', 'Amount', 'Claimed', 'Reason', 'Time']);
    pay.setFrozenRows(1);
  }
  return { ch: ch, pay: pay };
}

function pvpBeats_(x, y) {
  return (x === 'R' && y === 'S') || (x === 'P' && y === 'R') || (x === 'S' && y === 'P');
}

function pvpOutcome_(a, b) {
  var wa = 0, wb = 0;
  for (var i = 0; i < 3; i++) {
    var x = a.charAt(i), y = b.charAt(i);
    if (x === y) continue;
    if (pvpBeats_(x, y)) wa++; else wb++;
  }
  return { wa: wa, wb: wb, winner: wa > wb ? 'A' : (wb > wa ? 'B' : 'D') };
}

function pvpCreate(stake, moves) {
  stake = Math.floor(Number(stake));
  moves = String(moves || '').toUpperCase();
  if (!isFinite(stake) || stake < PVP_MIN_STAKE || stake > PVP_MAX_STAKE) return { ok: false, reason: 'stake' };
  if (!/^[RPS]{3}$/.test(moves)) return { ok: false, reason: 'moves' };

  var user = getUserLdap();
  var sh = pvpSheets_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) return { ok: false, reason: 'busy' };
  try {
    var data = sh.ch.getDataRange().getValues();
    var open = 0;
    for (var i = 1; i < data.length; i++) {
      if (data[i][4] === 'OPEN' && data[i][1] === user) open++;
    }
    if (open >= PVP_MAX_OPEN) return { ok: false, reason: 'limit' };
    var id = Utilities.getUuid().substring(0, 8);
    sh.ch.appendRow([id, user, stake, moves, 'OPEN', '', '', '', Date.now(), '', '']);
    return { ok: true, id: id };
  } catch (e) {
    return { ok: false, reason: 'error' };
  } finally {
    lock.releaseLock();
  }
}

function pvpCancel(id) {
  var user = getUserLdap();
  var sh = pvpSheets_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) return { ok: false, reason: 'busy' };
  try {
    var data = sh.ch.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        if (data[i][1] !== user || data[i][4] !== 'OPEN') return { ok: false, reason: 'state' };
        var now = Date.now();
        sh.ch.getRange(i + 1, 5).setValue('CANCELLED');
        sh.ch.getRange(i + 1, 10).setValue(now);
        sh.pay.appendRow([id, user, Number(data[i][2]), 0, 'CANCELLED', now]);
        return { ok: true };
      }
    }
    return { ok: false, reason: 'missing' };
  } catch (e) {
    return { ok: false, reason: 'error' };
  } finally {
    lock.releaseLock();
  }
}

function pvpAccept(id, moves, stake) {
  moves = String(moves || '').toUpperCase();
  stake = Math.floor(Number(stake));
  if (!/^[RPS]{3}$/.test(moves)) return { ok: false, reason: 'moves' };

  var user = getUserLdap();
  var sh = pvpSheets_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) return { ok: false, reason: 'busy' };
  try {
    var data = sh.ch.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] !== id) continue;
      var row = data[i];
      if (row[4] !== 'OPEN') return { ok: false, reason: 'taken' };
      if (row[1] === user) return { ok: false, reason: 'own' };
      if (Number(row[2]) !== stake) return { ok: false, reason: 'stake' };

      var creator = row[1];
      var cMoves = String(row[3]);
      var out = pvpOutcome_(cMoves, moves);        // A = tvůrce, B = přijímající
      var now = Date.now();
      var result = out.winner === 'A' ? 'CREATOR' : (out.winner === 'B' ? 'OPPONENT' : 'DRAW');
      var score = out.wa + '-' + out.wb;

      sh.ch.getRange(i + 1, 5, 1, 7).setValues([['DONE', user, moves, result, row[8], now, score]]);

      var win = Math.floor(stake * 2 * (1 - PVP_RAKE));
      var payout = 0;
      if (out.winner === 'B') {
        payout = win;
        sh.pay.appendRow([id, user, win, 1, 'WIN', now]);        // přijímající dostane hned v odpovědi
      } else if (out.winner === 'A') {
        sh.pay.appendRow([id, creator, win, 0, 'WIN', now]);
      } else {
        payout = stake;
        sh.pay.appendRow([id, user, stake, 1, 'DRAW', now]);
        sh.pay.appendRow([id, creator, stake, 0, 'DRAW', now]);
      }
      return {
        ok: true,
        result: out.winner === 'B' ? 'WIN' : (out.winner === 'A' ? 'LOSE' : 'DRAW'),
        score: out.wb + '-' + out.wa,
        creator: creator,
        theirMoves: cMoves,
        payout: payout
      };
    }
    return { ok: false, reason: 'missing' };
  } catch (e) {
    return { ok: false, reason: 'error' };
  } finally {
    lock.releaseLock();
  }
}

/** Expiruje staré výzvy, vyzvedne výplaty hráče a (volitelně) vrátí seznam výzev + historii. */
function pvpPoll(wantList) {
  var user = getUserLdap();
  var sh = pvpSheets_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) return { ok: false, reason: 'busy' };
  try {
    var now = Date.now();
    var ch = sh.ch.getDataRange().getValues();

    for (var i = 1; i < ch.length; i++) {
      if (ch[i][4] === 'OPEN' && now - Number(ch[i][8]) > PVP_EXPIRE_MS) {
        sh.ch.getRange(i + 1, 5).setValue('EXPIRED');
        sh.ch.getRange(i + 1, 10).setValue(now);
        sh.pay.appendRow([ch[i][0], ch[i][1], Number(ch[i][2]), 0, 'EXPIRED', now]);
        ch[i][4] = 'EXPIRED';
        ch[i][9] = now;
      }
    }

    var pay = sh.pay.getDataRange().getValues();
    var claimed = [];
    for (var j = 1; j < pay.length; j++) {
      if (pay[j][1] === user && Number(pay[j][3]) === 0) {
        claimed.push({ id: pay[j][0], amount: Number(pay[j][2]), reason: pay[j][4] });
        sh.pay.getRange(j + 1, 4).setValue(1);
      }
    }

    var out = { ok: true, claimed: claimed };
    if (!wantList) return out;

    var open = [], hist = [];
    var w = 0, l = 0, d = 0, net = 0;
    for (var k = ch.length - 1; k >= 1; k--) {
      var r = ch[k];
      var status = r[4];
      var stake = Number(r[2]);
      if (status === 'OPEN') {
        open.push({ id: r[0], creator: r[1], stake: stake, created: Number(r[8]), mine: r[1] === user });
        continue;
      }
      var iAmCreator = r[1] === user;
      var iAmOpp = r[5] === user;
      if (!iAmCreator && !iAmOpp) continue;

      var res;
      if (status === 'DONE') {
        var cw = r[7] === 'CREATOR', ow = r[7] === 'OPPONENT';
        if (r[7] === 'DRAW') { res = 'DRAW'; d++; }
        else if ((iAmCreator && cw) || (iAmOpp && ow)) { res = 'WIN'; w++; net += Math.floor(stake * 2 * (1 - PVP_RAKE)) - stake; }
        else { res = 'LOSE'; l++; net -= stake; }
      } else {
        res = status;
      }
      if (hist.length < 8) {
        var score = String(r[10] || '');
        var parts = score.split('-');
        var mine = iAmCreator ? parts[0] : parts[1];
        var theirs = iAmCreator ? parts[1] : parts[0];
        hist.push({
          id: r[0], res: res, stake: stake,
          vs: iAmCreator ? (r[5] || '-') : r[1],
          score: (parts.length === 2) ? (mine + '-' + theirs) : '',
          myMoves: status === 'DONE' ? String(iAmCreator ? r[3] : r[6]) : '',
          theirMoves: status === 'DONE' ? String(iAmCreator ? r[6] : r[3]) : '',
          at: Number(r[9]) || Number(r[8])
        });
      }
    }
    open.reverse();
    out.open = open;
    out.history = hist;
    out.stats = { w: w, l: l, d: d, net: net };
    return out;
  } catch (e) {
    return { ok: false, reason: 'error' };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================================================
// ADMIN
// ==========================================================================
function adminSeasonWipe() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var config = ss.getSheetByName('Config');
  var newSeason = 2;
  if (config) {
    var cur = Number(config.getRange('B1').getValue()) || 1;
    newSeason = cur + 1;
    config.getRange('A1:B7').setValues([
      ['Current_Season', newSeason],
      ['Roulette_Start_Time', 0],
      ['Roulette_Pot', 0],
      ['Roulette_Status', 'WAITING'],
      ['Last_Winner', 'None yet'],
      ['Roulette_Feed', '[]'],
      ['Roulette_Top_Wins', '[]']
    ]);
  }

  var saves = ss.getSheetByName('Saves');
  if (saves) {
    saves.clearContents();
    saves.appendRow(['LDAP', 'SaveData']);
    saves.setFrozenRows(1);
  }

  var chat = ss.getSheetByName('Chat');
  if (chat) {
    chat.clearContents();
    chat.appendRow(['Timestamp', 'User', 'Message']);
    chat.setFrozenRows(1);
  }

  var rouletteState = ss.getSheetByName('Roulette_State');
  if (rouletteState) {
    rouletteState.clearContents();
    rouletteState.appendRow(['LDAP', 'BetAmount', 'Status (IN / IDLE)']);
    rouletteState.setFrozenRows(1);
  }

  var pvpC = ss.getSheetByName('PvP_Challenges');
  if (pvpC) {
    pvpC.clearContents();
    pvpC.appendRow(['ID', 'Creator', 'Stake', 'CreatorMoves', 'Status', 'Opponent', 'OppMoves', 'Result', 'CreatedAt', 'ResolvedAt', 'Score']);
    pvpC.setFrozenRows(1);
  }
  var pvpP = ss.getSheetByName('PvP_Payouts');
  if (pvpP) {
    pvpP.clearContents();
    pvpP.appendRow(['ID', 'Player', 'Amount', 'Claimed', 'Reason', 'Time']);
    pvpP.setFrozenRows(1);
  }

  try { if (config) config.getRange('A12:B12').setValues([['Roulette_History', '[]']]); } catch (e) {}
  ['Arena', 'Arena_Log'].forEach(function (n) { var sh = ss.getSheetByName(n); if (sh) ss.deleteSheet(sh); });
  ARENA_HONOR_CACHE_ = null;
  try { CacheService.getScriptCache().remove('tt_lb_v3_s' + newSeason); } catch (e) {}
  bumpAppVersion_();
  return 'Season ' + newSeason + ' initialized. All old saves quarantined.';
}

// ==========================================================================
// HOME EDITION: ÚČTY (přezdívka + PIN) A API
// Klient pošle h = SHA-256(nick.toLowerCase() + ':' + PIN + ':idleroyale'), server ukládá SHA-256(h + sůl).
// PIN tedy nikdy neleží v tabulce ani nepřichází v čisté podobě.
// ==========================================================================
var API_ALLOWED_ = {
  loadGame: function () { return loadGame(); },
  saveGame: function (a) { return saveGame(a[0], a[1]); },
  logRouletteSpin: function (a) { return logRouletteSpin(a[0]); },
  sendChatMessage: function (a) { return sendChatMessage(a[0]); },
  getLeaderboardAndRoulette: function () { return getLeaderboardAndRoulette(); },
  pvpCreate: function (a) { return pvpCreate(a[0], a[1]); },
  pvpCancel: function (a) { return pvpCancel(a[0]); },
  pvpAccept: function (a) { return pvpAccept(a[0], a[1], a[2]); },
  pvpPoll: function (a) { return pvpPoll(a[0]); },
  arenaList: function () { return arenaList(); },
  arenaFight: function (a) { return arenaFight(a[0], a[1]); },
  wbState: function () { return wbState(); },
  poolBoard: function () { return poolBoard(); },
  wbSubmit: function (a) { return wbSubmit(a[0], a[1]); },
  weeklyState: function () { return weeklyState(); },
  weeklySubmit: function (a) { return weeklySubmit(a[0], a[1]); },
  prsList: function () { return prsList(); },
  prsCreate: function (a) { return prsCreate(a[0], a[1]); },
  prsJoin: function (a) { return prsJoin(a[0]); },
  prsLeave: function (a) { return prsLeave(a[0]); },
  prsStart: function (a) { return prsStart(a[0]); },
  prsPoll: function (a) { return prsPoll(a[0], a[1]); },
  prsMove: function (a) { return prsMove(a[0], a[1]); },
  ckList: function () { return ckList(); },
  ckCreate: function (a) { return ckCreate(a[0]); },
  ckJoin: function (a) { return ckJoin(a[0]); },
  ckLeave: function (a) { return ckLeave(a[0]); },
  ckPoll: function (a) { return ckPoll(a[0], a[1]); },
  ckMove: function (a) { return ckMove(a[0], a[1]); },
  ckDraw: function (a) { return ckDraw(a[0], a[1]); },
  metaPoll: function () { return metaPoll(); },
  lottoBuy: function (a) { return lottoBuy(a[0]); },
  lottoBuyMany: function (a) { return lottoBuyMany(a[0]); },
  lottoFeed: function (a) { return lottoFeed(a[0]); },
  lottoClaim: function () { return lottoClaim(); },
  officeView: function (a) { return officeView(a[0]); },
  officeAct: function (a) { return officeAct(a[0], a[1]); },
  officeInbox: function () { return officeInbox(); },
  dlList: function () { return dlList(); },
  dlCreate: function (a) { return dlCreate(a[0], a[1], a[2]); },
  dlJoin: function (a) { return dlJoin(a[0]); },
  dlLeave: function (a) { return dlLeave(a[0]); },
  dlPoll: function (a) { return dlPoll(a[0], a[1]); },
  dlMove: function (a) { return dlMove(a[0], a[1], a[2]); },
  dlStats: function (a) { return dlStats(a[0], a[1]); },
  nickList: function () { return nickList(); },
  setNick: function (a) { return setNick(a[0]); }
};

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad request' }); }
  var fn = String(req.fn || '');
  var args = Array.isArray(req.args) ? req.args : [];
  try {
    if (fn === 'getAppVersion') return json_({ ok: true, data: getAppVersion_() });
    if (fn === 'register') return json_({ ok: true, data: apiRegister_(args[0], args[1], args[2]) });
    if (fn === 'login') return json_({ ok: true, data: apiLogin_(args[0], args[1]) });
    if (!API_ALLOWED_.hasOwnProperty(fn)) return json_({ ok: false, error: 'unknown function' });
    var auth = req.auth || {};
    CURRENT_USER_ = authenticate_(auth.nick, auth.h);
    return json_({ ok: true, data: API_ALLOWED_[fn](args) });
  } catch (err2) {
    return json_({ ok: false, error: String((err2 && err2.message) || err2) });
  }
}

function sha256hex_(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function usersSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Users');
  if (!sh) {
    sh = ss.insertSheet('Users');
    sh.appendRow(['Nick', 'Key', 'Hash', 'Created', 'LastSeen']);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Zajistí řádky Config: B9 pozvánkový kód, B10 sůl, B11 max hráčů. */
function ensureHomeConfig_() {
  var cfg = getDb_().config;
  var vals = cfg.getRange('A9:B11').getValues();
  var invite = vals[0][1], salt = vals[1][1], max = vals[2][1];
  if (!invite) invite = 'royale-' + Utilities.getUuid().substring(0, 4);
  if (!salt) salt = Utilities.getUuid();
  if (!max) max = 30;
  cfg.getRange('A9:B11').setValues([['Invite_Code', invite], ['Salt', salt], ['Max_Users', max]]);
  return { invite: String(invite), salt: String(salt), max: Number(max) };
}

function getSalt_() {
  var cache = CacheService.getScriptCache();
  var s = cache.get('ir_salt');
  if (s) return s;
  s = ensureHomeConfig_().salt;
  cache.put('ir_salt', s, 21600);
  return s;
}

/** Spusť JEDNOU ručně z editoru (Run > setupHome). Vytvoří listy a vypíše pozvánkový kód. */
function setupHome() {
  var db = getDb_();
  usersSheet_();
  pvpSheets_();
  var c = ensureHomeConfig_();
  Logger.log('Hotovo. Pozvánkový kód: ' + c.invite + ' (max hráčů ' + c.max + ')');
  try { SpreadsheetApp.getUi().alert('Hotovo. Pozvánkový kód: ' + c.invite); } catch (e) {}
  return c.invite;
}

function normNick_(n) {
  n = String(n === undefined || n === null ? '' : n).trim();
  if (!/^[A-Za-z0-9_\-]{3,16}$/.test(n)) throw new Error('Nickname: 3-16 characters, letters, numbers, _ and - only');
  return n;
}

function checkHash_(h) {
  h = String(h || '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('Invalid PIN');
  return h;
}

function lookupUser_(key) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('u_' + key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  var sh = usersSheet_();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var rows = sh.getRange(2, 1, last - 1, 3).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][1] === key) {
      var u = { nick: String(rows[i][0]), hash: String(rows[i][2]) };
      cache.put('u_' + key, JSON.stringify(u), 21600);
      return u;
    }
  }
  return null;
}

function failCount_(key) {
  return Number(CacheService.getScriptCache().get('lf_' + key)) || 0;
}
function addFail_(key) {
  CacheService.getScriptCache().put('lf_' + key, String(failCount_(key) + 1), 600);
}

function verifyUser_(nick, h) {
  nick = normNick_(nick);
  h = checkHash_(h);
  var key = nick.toLowerCase();
  if (failCount_(key) >= 8) throw new Error('Too many failed attempts, try again in 10 minutes.');
  var u = lookupUser_(key);
  if (!u || u.hash !== sha256hex_(h + ':' + getSalt_())) {
    addFail_(key);
    throw new Error('Wrong nickname or PIN.');
  }
  return u.nick;
}

function authenticate_(nick, h) { return verifyUser_(nick, h); }

function apiLogin_(nick, h) {
  var n = verifyUser_(nick, h);
  try {
    var sh = usersSheet_();
    var key = n.toLowerCase();
    var last = sh.getLastRow();
    if (last >= 2) {
      var keys = sh.getRange(2, 2, last - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) if (keys[i][0] === key) { sh.getRange(i + 2, 5).setValue(new Date()); break; }
    }
  } catch (e) {}
  return { nick: n };
}

function apiRegister_(nick, h, invite) {
  nick = normNick_(nick);
  h = checkHash_(h);
  var cfg = ensureHomeConfig_();     // pozvánkový kód se už nekontroluje (v7) - kdo má odkaz, zaregistruje se; limit hráčů platí dál
  var key = nick.toLowerCase();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) throw new Error('Server is busy, try again.');
  try {
    var sh = usersSheet_();
    var last = sh.getLastRow();
    if (last >= 2) {
      var keys = sh.getRange(2, 2, last - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) if (keys[i][0] === key) throw new Error('This nickname is already taken.');
      if (last - 1 >= cfg.max) throw new Error('Server is full (max ' + cfg.max + ' players).');
    }
    sh.appendRow([nick, key, sha256hex_(h + ':' + cfg.salt), new Date(), new Date()]);
    CacheService.getScriptCache().remove('u_' + key);
    return { nick: nick };
  } finally {
    lock.releaseLock();
  }
}

/** Z menu: smaže účet (hráč se může znovu zaregistrovat se stejnou přezdívkou, save zůstane) */
function resetPlayerUi_() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Reset PINu', 'Přezdívka hráče (účet se smaže, save zůstane, hráč si znovu zvolí PIN):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var key = String(r.getResponseText()).trim().toLowerCase();
  var sh = usersSheet_();
  var last = sh.getLastRow();
  for (var i = 2; i <= last; i++) {
    if (sh.getRange(i, 2).getValue() === key) {
      sh.deleteRow(i);
      CacheService.getScriptCache().remove('u_' + key);
      ui.alert('Účet ' + key + ' smazán.');
      return;
    }
  }
  ui.alert('Hráč nenalezen.');
}


// ==========================================================================
// PRESENCE (v7.2): zelená = hraje (postup se změnil za ~2 min), žlutá = hru má otevřenou, ale AFK, šedá = offline
// ==========================================================================
function presenceStamp_(user, state) {
  var now = Date.now(), c = CacheService.getScriptCache(), k = 'pres_' + user, prev = null;
  try { prev = JSON.parse(c.get(k) || 'null'); } catch (e) {}
  var inv = Array.isArray(state.inventory) ? state.inventory.reduce(function (a, s) { return a + (Number(s && s.n) || 0); }, 0) : 0;
  var sig = [Math.floor(Number(state.lifetimeTickets) || 0), Math.floor(Number(state.scrap) || 0), Number(state.prestige) || 0,
    Number(state.chestLevel) || 0, Math.floor(Number(state.gambleNet) || 0), inv, (state.dungeon && state.dungeon.wins) || 0].join('|');
  var activeAt = (prev && prev.sig === sig && prev.activeAt) ? prev.activeAt : now;
  state.savedAt = now;
  state.activeAt = activeAt;
  try { c.put(k, JSON.stringify({ sig: sig, activeAt: activeAt }), 21600); } catch (e) {}
}
function presenceOf_(s) {
  var now = Date.now(), saved = Number(s.savedAt) || 0, act = Number(s.activeAt) || 0;
  var p = !saved || now - saved > 90000 ? 'off' : (now - act < 150000 ? 'on' : 'afk');
  return { presence: p, seen: saved ? now - saved : -1 };
}

// ==========================================================================
// ARÉNA (v7.1) - asynchronní PvP proti uloženým postavám ostatních.
// Souboj počítá SERVER stejným enginem jako hra (HSEngine níže, v11 High Stakes 2.0), klient ho jen přehrává.
// Honor = Elo (start 1000, K 32). Limit útoků za den, cooldown na stejného soupeře.
// ==========================================================================
var ARENA_PER_DAY = 8;
var ARENA_SAME_TARGET_MS = 20 * 60 * 1000;
var ARENA_START = 1000;
var ARENA_HONOR_CACHE_ = null;

function arenaSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var a = ss.getSheetByName('Arena');
  if (!a) { a = ss.insertSheet('Arena'); a.appendRow(['Nick', 'Honor', 'Day', 'FightsToday', 'Wins', 'Losses', 'LastTargets']); a.setFrozenRows(1); }
  var l = ss.getSheetByName('Arena_Log');
  if (!l) { l = ss.insertSheet('Arena_Log'); l.appendRow(['Time', 'Attacker', 'Defender', 'Winner', 'DeltaA', 'DeltaD', 'Turns', 'Reward']); l.setFrozenRows(1); }
  return { a: a, l: l };
}

function arenaDay_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'GMT', 'yyyy-MM-dd'); }

function arenaRows_(sh) {
  var last = sh.a.getLastRow();
  var rows = last >= 2 ? sh.a.getRange(2, 1, last - 1, 7).getValues() : [];
  var map = {};
  rows.forEach(function (r, i) { map[String(r[0])] = { row: i + 2, honor: Number(r[1]) || ARENA_START, day: String(r[2] || ''), fights: Number(r[3]) || 0, wins: Number(r[4]) || 0, losses: Number(r[5]) || 0, last: r[6] ? safeJson_(r[6], {}) : {} }; });
  return map;
}
function safeJson_(s, d) { try { return JSON.parse(s); } catch (e) { return d; } }

function arenaHonorOf_(nick) {
  if (!ARENA_HONOR_CACHE_) {
    ARENA_HONOR_CACHE_ = {};
    var ss = SpreadsheetApp.getActiveSpreadsheet(), a = ss.getSheetByName('Arena');
    if (a && a.getLastRow() >= 2) a.getRange(2, 1, a.getLastRow() - 1, 2).getValues().forEach(function (r) { ARENA_HONOR_CACHE_[String(r[0])] = Number(r[1]) || ARENA_START; });
  }
  return ARENA_HONOR_CACHE_[nick] || ARENA_START;
}

function arenaWrite_(sh, nick, rec) {
  var vals = [[nick, rec.honor, rec.day, rec.fights, rec.wins, rec.losses, JSON.stringify(rec.last || {})]];
  if (rec.row) sh.a.getRange(rec.row, 1, 1, 7).setValues(vals);
  else { sh.a.appendRow(vals[0]); rec.row = sh.a.getLastRow(); }
}

/** načte savy aktuální sezóny: { nick: stateObj } */
function arenaSaves_() {
  var db = getDb_();
  var season = Number(db.config.getRange('B1').getValue()) || 1;
  var data = db.saves.getDataRange().getValues(), out = {};
  for (var i = 1; i < data.length; i++) {
    try {
      var s = JSON.parse(rowToJson_(data[i]));
      if (!s.season || Number(s.season) < season) continue;
      out[String(data[i][0])] = s;
    } catch (e) {}
  }
  return out;
}

/** v11: postava z bojové karty v savu (HSEngine.fromCard přepočítá vše znovu a ořízne nesmyslné hodnoty) */
function arenaPlayer_(s) {
  var d = s.dungeon || {};
  if (!d.cls || !d.card) return null;
  return HSEngine.fromCard(d.card);
}

function arenaList() {
  var me = getUserLdap();
  var saves = arenaSaves_();
  var sh = arenaSheets_();
  var recs = arenaRows_(sh);
  var day = arenaDay_();
  var mine = recs[me] || { honor: ARENA_START, fights: 0, wins: 0, losses: 0, day: day };
  var used = mine.day === day ? mine.fights : 0;
  var opp = [];
  Object.keys(saves).forEach(function (nick) {
    if (nick === me) return;
    var p = arenaPlayer_(saves[nick]); if (!p) return;
    var d = saves[nick].dungeon || {}, r = recs[nick] || {};
    var last = (mine.last || {})[nick] || 0;
    opp.push({ nick: nick, cls: d.cls, level: p.level, title: cleanTxt_(d.title, 40), best: Number(d.best) || 0, honor: r.honor || ARENA_START,
      power: HSEngine.power(p), wins: r.wins || 0, losses: r.losses || 0, cooldown: Math.max(0, ARENA_SAME_TARGET_MS - (Date.now() - last)),
      presence: presenceOf_(saves[nick]).presence });
  });
  opp.sort(function (a, b) { return b.honor - a.honor; });
  // obrany: kdo na mě zaútočil (posledních 10)
  var logs = [], lr = sh.l.getLastRow();
  if (lr >= 2) {
    var rows = sh.l.getRange(Math.max(2, lr - 199), 1, Math.min(199, lr - 1), 8).getValues();
    for (var i = rows.length - 1; i >= 0 && logs.length < 12; i--) {
      var r2 = rows[i];
      if (r2[1] === me || r2[2] === me) logs.push({ time: Number(r2[0]) || 0, attacker: r2[1], defender: r2[2], winner: r2[3], delta: r2[1] === me ? Number(r2[4]) : Number(r2[5]), turns: Number(r2[6]) || 0 });
    }
  }
  var mp = saves[me] ? arenaPlayer_(saves[me]) : null;
  return { ok: true, me: { honor: mine.honor, wins: mine.wins, losses: mine.losses, left: Math.max(0, ARENA_PER_DAY - used), perDay: ARENA_PER_DAY, power: mp ? HSEngine.power(mp) : 0 }, opponents: opp, log: logs };
}

function arenaFight(target, stance) {
  var me = getUserLdap();
  target = String(target || '');
  if (!target || target === me) return { ok: false, reason: 'target' };
  if (['safe', 'normal', 'allin'].indexOf(stance) < 0) stance = 'normal';
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: false, reason: 'busy' };
  try {
    var saves = arenaSaves_();
    if (!saves[me] || !saves[target]) return { ok: false, reason: 'missing' };
    var A = arenaPlayer_(saves[me]), B = arenaPlayer_(saves[target]);
    if (!A) return { ok: false, reason: 'noclass' };
    if (!B) return { ok: false, reason: 'target' };
    var sh = arenaSheets_();
    var recs = arenaRows_(sh), day = arenaDay_();
    var ra = recs[me] || { honor: ARENA_START, day: day, fights: 0, wins: 0, losses: 0, last: {} };
    var rb = recs[target] || { honor: ARENA_START, day: '', fights: 0, wins: 0, losses: 0, last: {} };
    if (ra.day !== day) { ra.day = day; ra.fights = 0; }
    if (ra.fights >= ARENA_PER_DAY) return { ok: false, reason: 'limit' };
    var lastT = (ra.last || {})[target] || 0;
    if (Date.now() - lastT < ARENA_SAME_TARGET_MS) return { ok: false, reason: 'cooldown', wait: ARENA_SAME_TARGET_MS - (Date.now() - lastT) };
    var dStance = (saves[target].dungeon && saves[target].dungeon.arenaStance) || 'normal';
    if (['safe', 'normal', 'allin'].indexOf(dStance) < 0) dStance = 'normal';
    var seed = Math.floor(Math.random() * 2147483646) + 1;
    var res = HSEngine.duelAI(A, B, seed, stance, dStance);
    var exp = 1 / (1 + Math.pow(10, (rb.honor - ra.honor) / 400));
    var dA = Math.round(32 * ((res.win ? 1 : 0) - exp));
    if (res.win && dA < 1) dA = 1;
    var dB = -dA;
    ra.honor = Math.max(0, ra.honor + dA); rb.honor = Math.max(0, rb.honor + dB);
    ra.fights++; if (res.win) { ra.wins++; rb.losses++; } else { ra.losses++; rb.wins++; }
    ra.last = ra.last || {}; ra.last[target] = Date.now();
    Object.keys(ra.last).forEach(function (k) { if (Date.now() - ra.last[k] > ARENA_SAME_TARGET_MS) delete ra.last[k]; });
    var reward = res.win ? Math.round(1500 + 120 * A.level + 0.5 * Math.max(0, rb.honor - ra.honor + 200)) : Math.round(300 + 20 * A.level);
    arenaWrite_(sh, me, ra); arenaWrite_(sh, target, rb);
    sh.l.appendRow([Date.now(), me, target, res.win ? me : target, dA, dB, res.turns, reward]);
    if (sh.l.getLastRow() > 600) sh.l.deleteRows(2, 100);
    ARENA_HONOR_CACHE_ = null;
    return { ok: true, win: res.win, first: res.first, events: res.events, max: res.max, turns: res.turns, defStance: dStance,
      honor: ra.honor, delta: dA, reward: reward, left: ARENA_PER_DAY - ra.fights,
      opp: { nick: target, cls: B.cls, level: B.level, title: cleanTxt_((saves[target].dungeon || {}).title, 40), honor: rb.honor } };
  } catch (e) {
    return { ok: false, reason: 'error', msg: String(e) };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================================================
// WORLD BOSS (v8) - "Quarterly Review": jeden boss na týden pro celou firmu, sdílené HP.
// Souboj (10 kol) se hraje u klienta, server hlídá cooldown, rozumný strop damage a sčítá.
// Max HP roste s každým novým účastníkem (podle jeho síly), takže je boss stejně těžký pro 2 i 20 hráčů.
// ==========================================================================
var WB_COOLDOWN_MS = 60 * 60 * 1000;
var WB_COUNT = 16;                 // v11.4: 11 bossů kampaně + 5 týdenních bossů s vlastní třídou
var WB_BASE_HP = 3000;
var WB_CONTRIB = 100;
var WB_MK_HP = 1.8;            // v8.2: po zabití hned naskočí MK.II, MK.III... (HP ×1.6 za každý MK)

function wbWeek_() { return Math.floor((Date.now() - Date.UTC(2024, 0, 1)) / (7 * 86400000)); }
function wbSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('World_Boss');
  if (!sh) { sh = ss.insertSheet('World_Boss'); sh.appendRow(['Week', 'Data']); sh.setFrozenRows(1); }
  return sh;
}
function wbLoad_(sh, week) {
  var last = sh.getLastRow();
  if (last >= 2) {
    var rows = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = rows.length - 1; i >= 0; i--) if (Number(rows[i][0]) === week) return { row: i + 2, data: safeJson_(rows[i][1], null) };
  }
  return { row: 0, data: null };
}
function wbFresh_(week) { return { week: week, idx: week % WB_COUNT, maxHp: WB_BASE_HP, baseHp: WB_BASE_HP, mk: 1, kills: [], dmg: 0, killedAt: 0, killer: '', players: {} }; }
function wbFix_(d) {
  if (!d.mk) d.mk = d.killedAt ? 2 : 1;
  if (!d.baseHp) d.baseHp = d.maxHp;
  if (!d.kills) d.kills = d.killedAt ? [{ mk: 1, killer: d.killer, at: d.killedAt }] : [];
  if (d.killedAt && d.mk === 2 && d.dmg >= d.maxHp) { d.dmg = 0; d.maxHp = Math.round(d.baseHp * WB_MK_HP); }
  return d;
}
function wbMkMult_(mk) { return Math.pow(WB_MK_HP, mk - 1); }
function wbPublic_(d, me) {
  var list = Object.keys(d.players).map(function (n) { var p = d.players[n]; return { nick: n, dmg: p.dmg, n: p.n }; });
  list.sort(function (a, b) { return b.dmg - a.dmg; });
  var mine = d.players[me] || { dmg: 0, n: 0, last: 0 };
  return { week: d.week, idx: d.idx, maxHp: d.maxHp, dmg: d.dmg, mk: d.mk, kills: d.kills, killedAt: d.killedAt, killer: d.killer, players: list.slice(0, 30),
    me: { dmg: mine.dmg, n: mine.n, wait: Math.max(0, WB_COOLDOWN_MS - (Date.now() - (mine.last || 0))) } };
}
function wbState() {
  var me = getUserLdap(), sh = wbSheet_(), w = wbWeek_();
  var cur = wbFix_(wbLoad_(sh, w).data || wbFresh_(w));
  var prev = wbLoad_(sh, w - 1).data;
  if (prev) wbFix_(prev);
  var last = null;
  if (prev) {
    var top = Object.keys(prev.players).sort(function (a, b) { return prev.players[b].dmg - prev.players[a].dmg; })[0] || '';
    last = { week: prev.week, idx: prev.idx, killed: !!prev.killedAt, kills: prev.kills.length, mk: prev.mk, top: top, myDmg: (prev.players[me] || {}).dmg || 0, participants: Object.keys(prev.players).length };
  }
  return { ok: true, now: Date.now(), cooldown: WB_COOLDOWN_MS, cur: wbPublic_(cur, me), last: last };
}
function wbSubmit(dmg, atk) {
  var me = getUserLdap();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: false, reason: 'busy' };
  try {
    var sh = wbSheet_(), w = wbWeek_(), got = wbLoad_(sh, w), d = wbFix_(got.data || wbFresh_(w));
    var p = d.players[me];
    if (p && Date.now() - (p.last || 0) < WB_COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
    atk = Math.max(1, Math.min(1000000, Number(atk) || 1));
    dmg = Math.max(0, Math.min(Math.floor(Number(dmg) || 0), Math.round(atk * 150)));  // v11: 15 kol, crit 2.5×, ulti
    if (!p) { p = d.players[me] = { dmg: 0, n: 0, last: 0, contrib: Math.round(atk * WB_CONTRIB) }; d.baseHp += p.contrib; d.maxHp += Math.round(p.contrib * wbMkMult_(d.mk)); }
    var before = d.dmg, mkBefore = d.mk;
    dmg = Math.min(dmg, d.maxHp - d.dmg);                      // přebytek se nepřenáší do dalšího MK
    p.dmg += dmg; p.n++; p.last = Date.now();
    d.dmg += dmg;
    var kill = false;
    if (d.dmg >= d.maxHp) {
      kill = true;
      if (!d.killedAt) { d.killedAt = Date.now(); d.killer = me; }
      d.kills.push({ mk: d.mk, killer: me, at: Date.now() });
      d.mk++; d.dmg = 0; d.maxHp = Math.round(d.baseHp * wbMkMult_(d.mk));
      try { getDb_().chat.appendRow([new Date(), '📢 QUARTERLY REVIEW', me + ' took down MK.' + (d.mk - 1) + '! MK.' + d.mk + ' just walked in - the weekly reward grows.']); } catch (e) {}
    }
    var json = JSON.stringify(d);
    if (got.row) sh.getRange(got.row, 2).setValue(json); else sh.appendRow([w, json]);
    if (sh.getLastRow() > 30) sh.deleteRows(2, sh.getLastRow() - 30);
    return { ok: true, dmg: dmg, kill: kill, mk: mkBefore, counted: dmg, state: wbPublic_(d, me) };
  } catch (e) {
    return { ok: false, reason: 'error', msg: String(e) };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================================================
// WEEKLY BOARDS (v8.2) - týdenní žebříčky: výška v Corporate Climb, nejlepší Shift, damage na world bosse, největší výhra v kasinu.
// Klient posílá jen zlepšení; top 3 si odměnu (tokeny) vyzvedne sám po konci týdne.
// ==========================================================================
var WEEKLY_CATS = { climb: 280, shift: 999, casino: 1e18 };
/** v8.6: CLEAR THE POOL - žebříček nejhlubšího patra (ze savů, cache 60 s) */
function poolBoard() {
  try {
    var cache = CacheService.getScriptCache(), hit = cache.get('poolBoard');
    if (hit) return { ok: true, list: JSON.parse(hit) };
    var db = getDb_(), saves = db.saves.getDataRange().getValues(), list = [];
    for (var i = 1; i < saves.length; i++) {
      try {
        var raw = rowToJson_(saves[i]); if (!raw) continue;
        var s = JSON.parse(raw), b = Number(s.hs && s.hs.pool && s.hs.pool.best) || 0;
        if (b > 0) list.push({ nick: String(saves[i][0]), best: Math.min(100000, Math.floor(b)) });
      } catch (e) {}
    }
    list.sort(function (a, b) { return b.best - a.best; });
    list = list.slice(0, 10);
    try { cache.put('poolBoard', JSON.stringify(list), 60); } catch (e) {}
    return { ok: true, list: list };
  } catch (e) {
    return { ok: false, list: [], msg: String(e) };
  }
}

function weeklySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName('Weekly');
  if (!sh) { sh = ss.insertSheet('Weekly'); sh.appendRow(['Week', 'Data']); sh.setFrozenRows(1); }
  return sh;
}
function weeklyTop_(map, n) {
  return Object.keys(map || {}).map(function (k) { return { nick: k, v: Number(map[k]) || 0 }; })
    .filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; }).slice(0, n);
}
function weeklyBoards_(w) {
  var d = wbLoad_(weeklySheet_(), w).data || {};
  var wb = wbLoad_(wbSheet_(), w).data, dmg = {};
  if (wb && wb.players) Object.keys(wb.players).forEach(function (k) { dmg[k] = wb.players[k].dmg || 0; });
  return { climb: d.climb || {}, shift: d.shift || {}, casino: d.casino || {}, wbdmg: dmg };
}
function weeklyState() {
  var me = getUserLdap(), w = wbWeek_(), cur = weeklyBoards_(w), prev = weeklyBoards_(w - 1), out = { ok: true, week: w, cur: {}, last: {}, mine: {} };
  Object.keys(cur).forEach(function (c) {
    out.cur[c] = weeklyTop_(cur[c], 10);
    out.last[c] = weeklyTop_(prev[c], 3);
    out.mine[c] = Number(cur[c][me]) || 0;
  });
  return out;
}
function weeklySubmit(cat, val) {
  var me = getUserLdap();
  if (!WEEKLY_CATS.hasOwnProperty(cat)) return { ok: false, reason: 'cat' };
  val = Math.max(0, Math.min(WEEKLY_CATS[cat], Number(val) || 0));
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: false, reason: 'busy' };
  try {
    var sh = weeklySheet_(), w = wbWeek_(), got = wbLoad_(sh, w), d = got.data || {};
    d[cat] = d[cat] || {};
    var old = Number(d[cat][me]) || 0;
    if (val <= old) return { ok: true, best: old };
    d[cat][me] = val;
    var json = JSON.stringify(d);
    if (got.row) sh.getRange(got.row, 2).setValue(json); else sh.appendRow([w, json]);
    if (sh.getLastRow() > 20) sh.deleteRows(2, sh.getLastRow() - 20);
    return { ok: true, best: val };
  } catch (e) {
    return { ok: false, reason: 'error', msg: String(e) };
  } finally {
    lock.releaseLock();
  }
}

// ==========================================================================
// PRŠÍ (v8.3) - karetní hra pro 2-4 hráče o GC. Stav stolu v CacheService + záloha ve Script Properties.
// Vklad strhává klient (jako u Showdownu), server drží bank a výhry vyplácí přes prsPoll (Script Properties "pr_pay").
// Karty 0-31: barva = floor(c/8) (0 srdce, 1 kule, 2 listy, 3 žaludy), hodnota = c%8 (0=7,1=8,2=9,3=10,4=spodek,5=svršek,6=král,7=eso)
// ==========================================================================
var PRS_MIN_STAKE = 10, PRS_MAX_STAKE = 1000000000;   // vklad si volí zakladatel (jako u Showdownu)
var PRS_MAX_TABLES = 2, PRS_TURN_MS = 30000, PRS_WAIT_MS = 120000, PRS_IDLE_MS = 30 * 60000, PRS_RAKE = 0.05, PRS_MAX_MISS = 3;

function prsProps_() { return PropertiesService.getScriptProperties(); }
function prsGet_(id) {
  var raw = CacheService.getScriptCache().get('pr_' + id);
  if (!raw) raw = prsProps_().getProperty('pr_' + id);
  return raw ? JSON.parse(raw) : null;
}
function prsPut_(t) {
  var json = JSON.stringify(t);
  CacheService.getScriptCache().put('pr_' + t.id, json, 21600);
  prsProps_().setProperty('pr_' + t.id, json);
}
function prsDel_(id) { CacheService.getScriptCache().remove('pr_' + id); prsProps_().deleteProperty('pr_' + id); }
function prsIndex_() { try { return JSON.parse(prsProps_().getProperty('pr_index') || '[]'); } catch (e) { return []; } }
function prsSetIndex_(a) { prsProps_().setProperty('pr_index', JSON.stringify(a)); CacheService.getScriptCache().put('pr_ver', String(Date.now()), 21600); }
function prsPay_(nick, amt, why, id) {
  if (!(amt > 0)) return;
  var p = prsProps_(), m = {};
  try { m = JSON.parse(p.getProperty('pr_pay') || '{}'); } catch (e) {}
  (m[nick] = m[nick] || []).push({ amt: Math.floor(amt), why: why, id: id });
  p.setProperty('pr_pay', JSON.stringify(m));
}
function prsTakePay_(nick) {
  var p = prsProps_(), raw = p.getProperty('pr_pay');
  if (!raw || raw.indexOf('"' + nick + '"') < 0) return [];
  var m = {}; try { m = JSON.parse(raw); } catch (e) {}
  var out = m[nick] || []; delete m[nick];
  p.setProperty('pr_pay', JSON.stringify(m));
  return out;
}
function prsLock_() { var l = LockService.getScriptLock(); if (!l.tryLock(10000)) throw new Error('Server is busy, try again.'); return l; }
function prsShuffle_(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = a[i]; a[i] = a[j]; a[j] = x; } return a; }
function prsSuit_(c) { return Math.floor(c / 8); }
function prsRank_(c) { return c % 8; }
function prsLog_(t, txt) { t.log.push({ at: Date.now(), t: txt }); if (t.log.length > 40) t.log.shift(); }
var PRS_SUITS = ['Hearts', 'Bells', 'Leaves', 'Acorns'], PRS_RANKS = ['7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
function prsName_(c) { return PRS_RANKS[prsRank_(c)] + ' of ' + PRS_SUITS[prsSuit_(c)]; }
function prsTop_(t) { return t.pile[t.pile.length - 1]; }
function prsPlayable_(t, c) {
  var r = prsRank_(c), top = prsTop_(t);
  if (t.pen > 0) return r === 0;                       // aktivní sedma: jen sedma
  if (t.skip) return r === 7;                          // aktivní eso: jen eso
  if (r === 5) return true;                            // svršek na cokoli
  return prsSuit_(c) === t.suit || r === prsRank_(top);
}
function prsDraw_(t, n) {
  var got = [];
  for (var i = 0; i < n; i++) {
    if (!t.deck.length) { if (t.pile.length <= 1) break; t.deck = prsShuffle_(t.pile.slice(0, -1)); t.pile = t.pile.slice(-1); }
    got.push(t.deck.pop());
  }
  return got;
}
function prsActive_(t) { var f = t.fin || []; return t.order.filter(function (n) { return t.out.indexOf(n) < 0 && f.indexOf(n) < 0; }); }
function prsNext_(t) {
  var act = prsActive_(t); if (!act.length) return;
  var cur = t.order[t.turn], i = t.order.indexOf(cur);
  for (var k = 1; k <= t.order.length; k++) { var n = t.order[(i + k) % t.order.length]; if (act.indexOf(n) >= 0) { t.turn = t.order.indexOf(n); break; } }
  t.deadline = Date.now() + PRS_TURN_MS;
}
/** někdo se zbavil karet: 1. místo bere bank, pak se (od 3 hráčů) dohrává o 2. místo */
function prsPlaceOut_(t, nick, why) {
  t.fin = t.fin || [];
  if (t.fin.indexOf(nick) >= 0) return;
  t.fin.push(nick);
  if (t.fin.length === 1) {
    t.winner = nick; t.win = Math.floor(t.pot * (1 - PRS_RAKE));
    m96PoolAdd_(t.pot - t.win);                                  // v9.6: cut jde do loterie
    prsPay_(nick, t.win, 'WIN', t.id);
    prsLog_(t, '🏆 ' + nick + ' wins ' + t.win.toLocaleString() + ' GC' + (why ? ' (' + why + ')' : '') + '!');
  } else if (t.fin.length === 2) { t.second = nick; prsLog_(t, '🥈 ' + nick + ' finishes second' + (why ? ' (' + why + ')' : '') + '.'); }
  var act = prsActive_(t);
  if (t.fin.length >= 2 || act.length <= 1) {
    if (!t.second && act.length === 1 && t.fin.length === 1) { t.second = act[0]; t.fin.push(act[0]); }
    prsEnd_(t);
  } else if (t.order[t.turn] === nick) prsNext_(t);
  else t.deadline = t.deadline || Date.now() + PRS_TURN_MS;
}
function prsEnd_(t) {
  t.status = 'done'; t.doneAt = Date.now(); t.deadline = 0;
  try { getDb_().chat.appendRow([new Date(), '♣ PRŠÍ', '🏆 ' + t.winner + ' won a Prší table (+' + Math.round(t.win).toLocaleString() + ' GC)' + (t.second ? ', 🥈 ' + t.second + ' finished second' : '') + '.']); } catch (e) {}
  prsSetIndex_(prsIndex_());
}
function prsFinish_(t, winner, why) { prsPlaceOut_(t, winner, why); }
function prsCheckLastStanding_(t) {
  var act = prsActive_(t);
  if (t.status !== 'play' || act.length !== 1) return;
  if (!t.winner) prsPlaceOut_(t, act[0], 'everyone else left');
  else prsPlaceOut_(t, act[0], 'last one standing');
}
function prsRemovePlayer_(t, nick, why) {
  if (t.out.indexOf(nick) >= 0) return;
  t.out.push(nick);
  t.deck = (t.hands[nick] || []).concat(t.deck); t.hands[nick] = [];
  prsLog_(t, '🚪 ' + nick + ' ' + why + ' (stake lost)');
  if (t.order[t.turn] === nick) { prsNext_(t); }
  prsCheckLastStanding_(t);
}
/** úklid: čekající stoly po 2 min (vrátit vklady), dohrané po 2 min smazat, mrtvé hry po 30 min (vrátit vklady) */
function prsHousekeep_(t) {
  var now = Date.now();
  if (t.status === 'wait' && now - t.created > PRS_WAIT_MS) {
    t.players.forEach(function (n) { prsPay_(n, t.stake, 'REFUND', t.id); });
    t.status = 'gone'; return true;
  }
  if (t.status === 'done' && now - t.doneAt > 120000) { t.status = 'gone'; return true; }
  if (t.status === 'play' && now - t.moved > PRS_IDLE_MS) {
    if (t.winner) { t.status = 'gone'; return true; }        // bank už je vyplacený, jen se zavře
    var act = prsActive_(t);
    act.forEach(function (n) { prsPay_(n, Math.floor(t.pot / act.length), 'REFUND', t.id); });
    t.status = 'gone'; return true;
  }
  return false;
}
/** vyprší-li čas na tah: automaticky líže / stojí; 3× po sobě = vyhozen */
function prsTimeouts_(t) {
  var changed = false, guard = 0;
  while (t.status === 'play' && t.deadline && Date.now() > t.deadline && guard++ < 8) {
    var nick = t.order[t.turn];
    t.miss[nick] = (t.miss[nick] || 0) + 1;
    if (t.miss[nick] >= PRS_MAX_MISS) { prsRemovePlayer_(t, nick, 'timed out 3× and was kicked'); }
    else { prsAutoDraw_(t, nick, true); }
    t.rev++; changed = true;
  }
  return changed;
}
function prsAutoDraw_(t, nick, auto) {
  var pre = auto ? '⏱ ' + nick + ' ran out of time: ' : nick + ' ';
  if (t.pen > 0) { var g = prsDraw_(t, t.pen); t.hands[nick] = t.hands[nick].concat(g); prsLog_(t, pre + 'takes ' + g.length + ' cards'); t.pen = 0; }
  else if (t.skip) { t.skip = false; prsLog_(t, pre + 'stands (ace)'); }
  else { var g2 = prsDraw_(t, 1); t.hands[nick] = t.hands[nick].concat(g2); prsLog_(t, pre + 'draws a card'); }
  t.moved = Date.now();
  prsNext_(t);
}
function prsDeal_(t) {
  var deck = []; for (var i = 0; i < 32; i++) deck.push(i);
  t.deck = prsShuffle_(deck); t.hands = {}; t.order = prsShuffle_(t.players.slice());
  t.order.forEach(function (n) { t.hands[n] = t.deck.splice(-4, 4); });
  t.pile = [t.deck.pop()]; var top = prsTop_(t);
  t.suit = prsSuit_(top); t.pen = prsRank_(top) === 0 ? 2 : 0; t.skip = prsRank_(top) === 7;
  t.out = []; t.fin = []; t.winner = ''; t.second = ''; t.miss = {}; t.turn = 0; t.status = 'play'; t.pot = t.stake * t.players.length; t.started = Date.now(); t.moved = Date.now();
  t.deadline = Date.now() + PRS_TURN_MS + 5000; t.rev++;
  prsLog_(t, '🃏 Cards dealt! ' + t.order[0] + ' starts. Pot ' + t.pot.toLocaleString() + ' GC.');
}
function prsLoadAll_() {
  var ids = prsIndex_(), out = [], keep = [], dirty = false;
  ids.forEach(function (id) {
    var t = prsGet_(id);
    if (!t) { dirty = true; return; }
    var hk = prsHousekeep_(t), to = prsTimeouts_(t);
    if (hk || to) { dirty = true; if (t.status === 'gone') { prsDel_(id); return; } prsPut_(t); }
    keep.push(id); out.push(t);
  });
  if (dirty) prsSetIndex_(keep);
  return out;
}
function prsPublic_(t) {
  return { id: t.id, host: t.host, stake: t.stake, seats: t.seats, players: t.players, status: t.status, created: t.created };
}
function prsList() {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var ts = prsLoadAll_(), mine = '';
    ts.forEach(function (t) { if (t.players.indexOf(me) >= 0 && t.status !== 'gone' && !(t.seen && t.seen[me])) mine = t.id; });
    return { ok: true, tables: ts.filter(function (t) { return t.status === 'wait' || t.status === 'play'; }).map(prsPublic_), mine: mine, max: PRS_MAX_TABLES, minStake: PRS_MIN_STAKE, maxStake: PRS_MAX_STAKE, pay: prsTakePay_(me) };
  } finally { lock.releaseLock(); }
}
function prsCreate(stake, seats) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    stake = Math.floor(Number(stake)); seats = Math.max(2, Math.min(6, Number(seats) || 4));
    if (!(stake >= PRS_MIN_STAKE && stake <= PRS_MAX_STAKE)) return { ok: false, reason: 'stake' };
    var ts = prsLoadAll_();
    if (ts.some(function (t) { return t.players.indexOf(me) >= 0 && (t.status === 'wait' || t.status === 'play') && !(t.seen && t.seen[me]); })) return { ok: false, reason: 'already' };
    if (ts.filter(function (t) { return t.status === 'wait' || t.status === 'play'; }).length >= PRS_MAX_TABLES) return { ok: false, reason: 'full' };
    var t = { id: Utilities.getUuid().slice(0, 8), host: me, stake: stake, seats: seats, players: [me], status: 'wait', created: Date.now(), rev: 1, log: [], pot: 0, out: [], order: [], hands: {}, deck: [], pile: [], miss: {}, seen: {} };
    prsLog_(t, me + ' opened the table');
    prsPut_(t); var idx = prsIndex_(); idx.push(t.id); prsSetIndex_(idx);
    try { getDb_().chat.appendRow([new Date(), '♣ PRŠÍ', me + ' opened a Prší table (' + stake.toLocaleString() + ' GC, ' + seats + ' seats). Join in GAMBLE > SPECIAL!']); } catch (e) {}
    return { ok: true, id: t.id };
  } finally { lock.releaseLock(); }
}
function prsJoin(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var ts = prsLoadAll_(), t = ts.filter(function (x) { return x.id === id; })[0];
    if (!t || t.status !== 'wait') return { ok: false, reason: 'gone' };
    if (ts.some(function (x) { return x.players.indexOf(me) >= 0 && (x.status === 'wait' || x.status === 'play') && !(x.seen && x.seen[me]); })) return { ok: false, reason: 'already' };
    if (t.players.length >= t.seats) return { ok: false, reason: 'seats' };
    t.players.push(me); t.rev++; prsLog_(t, me + ' sat down');
    if (t.players.length >= t.seats) prsDeal_(t);
    prsPut_(t); prsSetIndex_(prsIndex_());
    return { ok: true, id: t.id, stake: t.stake };
  } finally { lock.releaseLock(); }
}
function prsStart(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = prsGet_(id);
    if (!t || t.status !== 'wait') return { ok: false, reason: 'gone' };
    if (t.host !== me) return { ok: false, reason: 'host' };
    if (t.players.length < 2) return { ok: false, reason: 'alone' };
    prsDeal_(t); prsPut_(t); prsSetIndex_(prsIndex_());
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function prsLeave(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = prsGet_(id);
    if (!t || t.players.indexOf(me) < 0) return { ok: true };
    if (t.status === 'wait') {
      t.players = t.players.filter(function (n) { return n !== me; });
      prsPay_(me, t.stake, 'REFUND', t.id); prsLog_(t, me + ' left (stake refunded)');
      if (!t.players.length) { prsDel_(id); prsSetIndex_(prsIndex_().filter(function (x) { return x !== id; })); return { ok: true }; }
      if (t.host === me) t.host = t.players[0];
    } else if (t.status === 'play' && (t.fin || []).indexOf(me) >= 0) { t.seen = t.seen || {}; t.seen[me] = 1; }
    else if (t.status === 'play') prsRemovePlayer_(t, me, 'left the table');
    else if (t.status === 'done') { t.seen = t.seen || {}; t.seen[me] = 1; }
    t.rev++; prsPut_(t); prsSetIndex_(prsIndex_());
    return { ok: true };
  } finally { lock.releaseLock(); }
}
/** pohled hráče: veřejný stav + moje ruka (ostatní jen počet karet) */
function prsView_(t, me) {
  var hands = {}; (t.order.length ? t.order : t.players).forEach(function (n) { hands[n] = (t.hands[n] || []).length; });
  return { id: t.id, rev: t.rev, host: t.host, stake: t.stake, seats: t.seats, players: t.players, order: t.order, status: t.status, pot: t.pot,
    turn: t.order[t.turn] || '', top: t.pile.length ? prsTop_(t) : -1, under: t.pile.length > 1 ? t.pile[t.pile.length - 2] : -1, suit: t.suit, pen: t.pen || 0, skip: !!t.skip,
    deck: t.deck.length, hands: hands, mine: t.hands[me] || [], out: t.out, fin: t.fin || [], winner: t.winner || '', second: t.second || '', win: t.win || 0, left: t.deadline ? Math.max(0, t.deadline - Date.now()) : 0,
    created: t.created, waitLeft: t.status === 'wait' ? Math.max(0, PRS_WAIT_MS - (Date.now() - t.created)) : 0, miss: t.miss || {}, log: t.log.slice(-14) };
}
function prsPoll(id, rev) {
  var me = getUserLdap(), t = prsGet_(id);
  var due = t && ((t.status === 'play' && t.deadline && Date.now() > t.deadline) || (t.status === 'wait' && Date.now() - t.created > PRS_WAIT_MS) || (t.status === 'play' && Date.now() - t.moved > PRS_IDLE_MS));
  var pay = [];
  if (due) {                                                  // jen když je co řešit, bereme zámek
    var lock = prsLock_();
    try {
      t = prsGet_(id);
      if (t) { var hk = prsHousekeep_(t), to = prsTimeouts_(t); if (hk || to) { t.rev++; if (t.status === 'gone') { prsDel_(id); prsSetIndex_(prsIndex_().filter(function (x) { return x !== id; })); } else prsPut_(t); } }
      if (t && t.status === 'gone') t = null;
    } finally { lock.releaseLock(); }
  }
  var payRaw = prsProps_().getProperty('pr_pay');
  if (payRaw && payRaw.indexOf('"' + me + '"') >= 0) { var l2 = prsLock_(); try { pay = prsTakePay_(me); } finally { l2.releaseLock(); } }
  if (!t) return { ok: true, gone: true, pay: pay };
  if (Number(rev) === t.rev && !pay.length) return { ok: true, same: true, rev: t.rev, left: t.deadline ? Math.max(0, t.deadline - Date.now()) : 0 };
  return { ok: true, view: prsView_(t, me), pay: pay };
}
/** tah: { t: 'play', c: karta, suit: barva pro svrška } | { t: 'draw' } (líznout / vzít trest / stát na eso) */
function prsMove(id, mv) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = prsGet_(id);
    if (!t || t.status !== 'play') return { ok: false, reason: 'gone' };
    prsTimeouts_(t);
    if (t.status !== 'play') { prsPut_(t); return { ok: false, reason: 'gone', view: prsView_(t, me) }; }
    if (t.order[t.turn] !== me) { prsPut_(t); return { ok: false, reason: 'turn', view: prsView_(t, me) }; }
    mv = mv || {};
    var hand = t.hands[me];
    if (mv.t === 'play') {
      var c = Number(mv.c), i = hand.indexOf(c);
      if (i < 0 || !prsPlayable_(t, c)) return { ok: false, reason: 'card', view: prsView_(t, me) };
      hand.splice(i, 1); t.pile.push(c);
      var r = prsRank_(c);
      if (r === 5) { var su = Number(mv.suit); t.suit = su >= 0 && su <= 3 ? su : prsSuit_(c); }
      else t.suit = prsSuit_(c);
      if (r === 0) t.pen = (t.pen || 0) + 2;
      if (r === 7) t.skip = true;
      t.miss[me] = 0; t.moved = Date.now();
      prsLog_(t, me + ' plays ' + prsName_(c) + (r === 5 ? ' and picks ' + PRS_SUITS[t.suit] : r === 0 ? ' (+' + t.pen + ' for the next player)' : r === 7 ? ' (next player stands)' : ''));
      if (!hand.length) { prsPlaceOut_(t, me, 'out of cards'); t.rev++; prsPut_(t); return { ok: true, view: prsView_(t, me) }; }
      prsNext_(t);
    } else {
      t.miss[me] = 0;
      prsAutoDraw_(t, me, false);
    }
    t.rev++; prsPut_(t);
    return { ok: true, view: prsView_(t, me) };
  } finally { lock.releaseLock(); }
}

// ==========================================================================
// CHECKERS (v8.4) - česká dáma pro 2 hráče o GC (stejná infrastruktura jako Prší).
// Deska 64 polí (index = řádek*8 + sloupec), hraje se na tmavých polích. 1 = bílý kámen, 2 = bílá dáma, -1/-2 = černé.
// Bílý (dole) táhne nahoru a začíná. Braní je povinné, kámen bere jen dopředu, dáma jezdí i bere na libovolnou vzdálenost;
// může-li brát dáma, musí brát dáma. Braní se musí dokončit; kámen, který dojde na poslední řadu, se mění v dámu a tah končí.
// ==========================================================================
var CK_MAX_TABLES = 3, CK_TURN_MS = 45000, CK_WAIT_MS = 180000, CK_IDLE_MS = 30 * 60000, CK_RAKE = 0.05, CK_MAX_MISS = 3, CK_QUIET = 40;
function ckGet_(id) { var raw = CacheService.getScriptCache().get('ck_' + id); if (!raw) raw = prsProps_().getProperty('ck_' + id); return raw ? JSON.parse(raw) : null; }
function ckPut_(t) { var j = JSON.stringify(t); CacheService.getScriptCache().put('ck_' + t.id, j, 21600); prsProps_().setProperty('ck_' + t.id, j); }
function ckDel_(id) { CacheService.getScriptCache().remove('ck_' + id); prsProps_().deleteProperty('ck_' + id); }
function ckIndex_() { try { return JSON.parse(prsProps_().getProperty('ck_index') || '[]'); } catch (e) { return []; } }
function ckSetIndex_(a) { prsProps_().setProperty('ck_index', JSON.stringify(a)); }
function ckLog_(t, txt) { t.log.push({ at: Date.now(), t: txt }); if (t.log.length > 30) t.log.shift(); }
function ckNewBoard_() { var b = []; for (var i = 0; i < 64; i++) { var r = Math.floor(i / 8), c = i % 8; b.push((r + c) % 2 === 1 ? (r < 3 ? -1 : r > 4 ? 1 : 0) : 0); } return b; }
/** všechny legální tahy hráče p (1 bílý, -1 černý) jako cesty [od, pole1, pole2, ...] + seznam sebraných */
function ckMoves_(b, p) {
  var caps = [], kingCaps = [], simple = [];
  for (var sq = 0; sq < 64; sq++) {
    var pc = b[sq]; if (!pc || (pc > 0) !== (p > 0)) continue;
    var king = Math.abs(pc) === 2, found = [];
    ckCaps_(b, sq, sq, pc, king, [sq], [], found);
    if (found.length) { if (king) kingCaps = kingCaps.concat(found); else caps = caps.concat(found); continue; }
    var r = Math.floor(sq / 8), c = sq % 8, dirs = king ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] : [[p > 0 ? -1 : 1, -1], [p > 0 ? -1 : 1, 1]];
    dirs.forEach(function (d) {
      for (var k = 1; k < 8; k++) {
        var rr = r + d[0] * k, cc = c + d[1] * k; if (rr < 0 || rr > 7 || cc < 0 || cc > 7 || b[rr * 8 + cc]) break;
        simple.push({ path: [sq, rr * 8 + cc], cap: [] }); if (!king) break;
      }
    });
  }
  if (kingCaps.length) return kingCaps;
  if (caps.length) return caps;
  return simple;
}
function ckCaps_(b, origin, sq, pc, king, path, cap, out) {
  var p = pc > 0 ? 1 : -1, r = Math.floor(sq / 8), c = sq % 8, any = false;
  var dirs = king ? [[-1, -1], [-1, 1], [1, -1], [1, 1]] : [[p > 0 ? -1 : 1, -1], [p > 0 ? -1 : 1, 1]];
  var occ = function (i) { return i === origin ? 0 : b[i]; };
  dirs.forEach(function (d) {
    var k = 1, rr, cc, i;
    if (king) { while (true) { rr = r + d[0] * k; cc = c + d[1] * k; if (rr < 0 || rr > 7 || cc < 0 || cc > 7) return; i = rr * 8 + cc; if (occ(i)) break; k++; } }
    else { rr = r + d[0]; cc = c + d[1]; if (rr < 0 || rr > 7 || cc < 0 || cc > 7) return; i = rr * 8 + cc; }
    var v = occ(i);
    if (!v || (v > 0) === (p > 0) || cap.indexOf(i) >= 0) return;            // musí to být soupeř, ještě nesebraný
    for (var m = 1; m < 8; m++) {
      var lr = rr + d[0] * m, lc = cc + d[1] * m; if (lr < 0 || lr > 7 || lc < 0 || lc > 7) break;
      var li = lr * 8 + lc; if (occ(li)) break;
      any = true;
      var promo = !king && (p > 0 ? lr === 0 : lr === 7);
      var np = path.concat([li]), nc = cap.concat([i]);
      if (promo) out.push({ path: np, cap: nc });                                // povýšení ukončí tah
      else { var before = out.length; ckCaps_(b, origin, li, pc, king, np, nc, out); if (out.length === before) out.push({ path: np, cap: nc }); }
      if (!king) break;
    }
  });
  return any;
}
function ckApply_(b, mv) {
  var from = mv.path[0], to = mv.path[mv.path.length - 1], pc = b[from];
  b[from] = 0; mv.cap.forEach(function (i) { b[i] = 0; });
  var r = Math.floor(to / 8);
  if (Math.abs(pc) === 1 && ((pc > 0 && r === 0) || (pc < 0 && r === 7))) pc = pc * 2;
  b[to] = pc;
}
function ckColor_(t, nick) { return t.white === nick ? 1 : t.black === nick ? -1 : 0; }
function ckPay_(nick, amt, why, id) {
  if (!(amt > 0)) return;
  var p = prsProps_(), m = {}; try { m = JSON.parse(p.getProperty('ck_pay') || '{}'); } catch (e) {}
  (m[nick] = m[nick] || []).push({ amt: Math.floor(amt), why: why, id: id }); p.setProperty('ck_pay', JSON.stringify(m));
}
function ckTakePay_(nick) {
  var p = prsProps_(), raw = p.getProperty('ck_pay'); if (!raw || raw.indexOf('"' + nick + '"') < 0) return [];
  var m = {}; try { m = JSON.parse(raw); } catch (e) {} var out = m[nick] || []; delete m[nick]; p.setProperty('ck_pay', JSON.stringify(m)); return out;
}
function ckEnd_(t, winner, why) {
  t.status = 'done'; t.doneAt = Date.now(); t.deadline = 0; t.winner = winner || ''; t.why = why;
  if (winner) {
    var win = Math.floor(t.stake * 2 * (1 - CK_RAKE)); t.win = win; ckPay_(winner, win, 'WIN', t.id);
    m96PoolAdd_(t.stake * 2 - win);                              // v9.6: cut jde do loterie
    ckLog_(t, '🏆 ' + winner + ' wins ' + win.toLocaleString() + ' GC (' + why + ')');
    try { getDb_().chat.appendRow([new Date(), '⛀ CHECKERS', '🏆 ' + winner + ' beat ' + (winner === t.white ? t.black : t.white) + ' at checkers (+' + win.toLocaleString() + ' GC, ' + why + ').']); } catch (e) {}
  } else {
    [t.white, t.black].forEach(function (n) { ckPay_(n, t.stake, 'DRAW', t.id); });
    ckLog_(t, '🤝 Draw (' + why + ') - stakes returned');
  }
}
function ckAfterMove_(t) {
  t.turnColor = -t.turnColor; t.deadline = Date.now() + CK_TURN_MS; t.moved = Date.now(); t.rev++;
  var next = t.turnColor > 0 ? t.white : t.black, moves = ckMoves_(t.board, t.turnColor);
  if (!moves.length) { ckEnd_(t, next === t.white ? t.black : t.white, next + ' has no moves left'); return; }
  if (t.quiet >= CK_QUIET) ckEnd_(t, '', CK_QUIET + ' moves without a capture');
}
function ckDoMove_(t, mv, nick, auto) {
  ckApply_(t.board, mv);
  t.last = { path: mv.path, cap: mv.cap, by: nick };
  t.quiet = mv.cap.length ? 0 : (t.quiet || 0) + 1;
  t.moves = (t.moves || 0) + 1; t.drawOffer = '';
  ckLog_(t, (auto ? '⏱ ' : '') + nick + (mv.cap.length ? ' captures ' + mv.cap.length + '×' : ' moves') + (auto ? ' (time ran out, random move)' : ''));
  ckAfterMove_(t);
}
function ckTimeouts_(t) {
  var ch = false, g = 0;
  while (t.status === 'play' && t.deadline && Date.now() > t.deadline && g++ < 4) {
    var nick = t.turnColor > 0 ? t.white : t.black;
    t.miss[nick] = (t.miss[nick] || 0) + 1; ch = true;
    if (t.miss[nick] >= CK_MAX_MISS) { ckEnd_(t, nick === t.white ? t.black : t.white, nick + ' timed out 3×'); t.rev++; break; }
    var ms = ckMoves_(t.board, t.turnColor); ckDoMove_(t, ms[Math.floor(Math.random() * ms.length)], nick, true);
  }
  return ch;
}
function ckHousekeep_(t) {
  var now = Date.now();
  if (t.status === 'wait' && now - t.created > CK_WAIT_MS) { ckPay_(t.host, t.stake, 'REFUND', t.id); t.status = 'gone'; return true; }
  if (t.status === 'done' && now - t.doneAt > 120000) { t.status = 'gone'; return true; }
  if (t.status === 'play' && now - t.moved > CK_IDLE_MS) { ckEnd_(t, '', 'abandoned'); t.status = 'gone'; return true; }
  return false;
}
function ckLoadAll_() {
  var ids = ckIndex_(), out = [], keep = [], dirty = false;
  ids.forEach(function (id) {
    var t = ckGet_(id); if (!t) { dirty = true; return; }
    var hk = ckHousekeep_(t), to = ckTimeouts_(t);
    if (hk || to) { dirty = true; if (t.status === 'gone') { ckDel_(id); return; } ckPut_(t); }
    keep.push(id); out.push(t);
  });
  if (dirty) ckSetIndex_(keep);
  return out;
}
function ckList() {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var ts = ckLoadAll_(), mine = '';
    ts.forEach(function (t) { if ((t.white === me || t.black === me || t.host === me) && !(t.seen && t.seen[me])) mine = t.id; });
    return { ok: true, tables: ts.filter(function (t) { return t.status === 'wait' || t.status === 'play'; }).map(function (t) { return { id: t.id, host: t.host, stake: t.stake, status: t.status, white: t.white, black: t.black }; }),
      mine: mine, max: CK_MAX_TABLES, minStake: PRS_MIN_STAKE, maxStake: PRS_MAX_STAKE, pay: ckTakePay_(me) };
  } finally { lock.releaseLock(); }
}
function ckBusy_(ts, me) { return ts.some(function (t) { return (t.status === 'wait' || t.status === 'play') && (t.host === me || t.white === me || t.black === me) && !(t.seen && t.seen[me]); }); }
function ckCreate(stake) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    stake = Math.floor(Number(stake));
    if (!(stake >= PRS_MIN_STAKE && stake <= PRS_MAX_STAKE)) return { ok: false, reason: 'stake' };
    var ts = ckLoadAll_();
    if (ckBusy_(ts, me)) return { ok: false, reason: 'already' };
    if (ts.filter(function (t) { return t.status === 'wait' || t.status === 'play'; }).length >= CK_MAX_TABLES) return { ok: false, reason: 'full' };
    var t = { id: Utilities.getUuid().slice(0, 8), host: me, stake: stake, status: 'wait', created: Date.now(), rev: 1, log: [], miss: {}, seen: {}, board: [], white: '', black: '' };
    ckLog_(t, me + ' is looking for an opponent'); ckPut_(t); var idx = ckIndex_(); idx.push(t.id); ckSetIndex_(idx);
    try { getDb_().chat.appendRow([new Date(), '⛀ CHECKERS', me + ' wants to play checkers for ' + stake.toLocaleString() + ' GC. Accept in GAMBLE > SPECIAL!']); } catch (e) {}
    return { ok: true, id: t.id };
  } finally { lock.releaseLock(); }
}
function ckJoin(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var ts = ckLoadAll_(), t = ts.filter(function (x) { return x.id === id; })[0];
    if (!t || t.status !== 'wait') return { ok: false, reason: 'gone' };
    if (t.host === me) return { ok: false, reason: 'self' };
    if (ckBusy_(ts, me)) return { ok: false, reason: 'already' };
    var hostWhite = Math.random() < 0.5;
    t.white = hostWhite ? t.host : me; t.black = hostWhite ? me : t.host;
    t.board = ckNewBoard_(); t.turnColor = 1; t.status = 'play'; t.started = Date.now(); t.moved = Date.now(); t.deadline = Date.now() + CK_TURN_MS + 5000; t.quiet = 0; t.moves = 0; t.rev++;
    ckLog_(t, me + ' accepted. ' + t.white + ' plays white and starts.');
    ckPut_(t);
    return { ok: true, id: t.id, stake: t.stake };
  } finally { lock.releaseLock(); }
}
function ckLeave(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = ckGet_(id); if (!t) return { ok: true };
    if (t.status === 'wait' && t.host === me) { ckPay_(me, t.stake, 'REFUND', t.id); ckDel_(id); ckSetIndex_(ckIndex_().filter(function (x) { return x !== id; })); return { ok: true }; }
    if (t.status === 'play' && ckColor_(t, me)) { ckEnd_(t, me === t.white ? t.black : t.white, me + ' resigned'); t.rev++; }
    t.seen = t.seen || {}; t.seen[me] = 1; ckPut_(t);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function ckView_(t, me) {
  var col = ckColor_(t, me), mine = t.status === 'play' && col === t.turnColor;
  return { id: t.id, rev: t.rev, status: t.status, host: t.host, stake: t.stake, white: t.white, black: t.black, me: col, board: t.board, turn: t.turnColor,
    moves: mine ? ckMoves_(t.board, col) : [], last: t.last || null, left: t.deadline ? Math.max(0, t.deadline - Date.now()) : 0, winner: t.winner || '', why: t.why || '', win: t.win || 0,
    drawOffer: t.drawOffer || '', quiet: t.quiet || 0, miss: t.miss || {}, waitLeft: t.status === 'wait' ? Math.max(0, CK_WAIT_MS - (Date.now() - t.created)) : 0, log: t.log.slice(-12) };
}
function ckPoll(id, rev) {
  var me = getUserLdap(), t = ckGet_(id), pay = [];
  var due = t && ((t.status === 'play' && t.deadline && Date.now() > t.deadline) || (t.status === 'wait' && Date.now() - t.created > CK_WAIT_MS) || (t.status === 'play' && Date.now() - t.moved > CK_IDLE_MS));
  if (due) {
    var lock = prsLock_();
    try { t = ckGet_(id); if (t) { var hk = ckHousekeep_(t), to = ckTimeouts_(t); if (hk || to) { if (t.status === 'gone') { ckDel_(id); ckSetIndex_(ckIndex_().filter(function (x) { return x !== id; })); t = null; } else { t.rev++; ckPut_(t); } } } }
    finally { lock.releaseLock(); }
  }
  var raw = prsProps_().getProperty('ck_pay');
  if (raw && raw.indexOf('"' + me + '"') >= 0) { var l2 = prsLock_(); try { pay = ckTakePay_(me); } finally { l2.releaseLock(); } }
  if (!t) return { ok: true, gone: true, pay: pay };
  if (Number(rev) === t.rev && !pay.length) return { ok: true, same: true, rev: t.rev, left: t.deadline ? Math.max(0, t.deadline - Date.now()) : 0 };
  return { ok: true, view: ckView_(t, me), pay: pay };
}
/** tah = cesta polí [od, ..., kam]; musí přesně odpovídat jednomu z legálních tahů */
function ckMove(id, path) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = ckGet_(id); if (!t || t.status !== 'play') return { ok: false, reason: 'gone' };
    ckTimeouts_(t);
    var col = ckColor_(t, me);
    if (t.status !== 'play' || col !== t.turnColor) { ckPut_(t); return { ok: false, reason: 'turn', view: ckView_(t, me) }; }
    path = (path || []).map(Number);
    var mv = ckMoves_(t.board, col).filter(function (m) { return m.path.join(',') === path.join(','); })[0];
    if (!mv) return { ok: false, reason: 'illegal', view: ckView_(t, me) };
    t.miss[me] = 0;
    ckDoMove_(t, mv, me, false);
    ckPut_(t);
    return { ok: true, view: ckView_(t, me) };
  } finally { lock.releaseLock(); }
}
/** remíza: what = 'offer' | 'accept' | 'decline' */
function ckDraw(id, what) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = ckGet_(id); if (!t || t.status !== 'play' || !ckColor_(t, me)) return { ok: false, reason: 'gone' };
    if (what === 'offer') { t.drawOffer = me; ckLog_(t, me + ' offers a draw'); }
    else if (what === 'accept' && t.drawOffer && t.drawOffer !== me) ckEnd_(t, '', 'agreed');
    else if (what === 'decline' && t.drawOffer && t.drawOffer !== me) { t.drawOffer = ''; ckLog_(t, me + ' declines the draw'); }
    t.rev++; ckPut_(t);
    return { ok: true, view: ckView_(t, me) };
  } finally { lock.releaseLock(); }
}


// ==========================================================================
// v9.6 META SERVER: firemní event z menu, loterie (Sazka), návštěvy kanceláře (kafe / prank)
// Stav v Script Properties (JSON), zápisy pod LockService. Funguje stejně v domácí i firemní verzi (getUserLdap).
// ==========================================================================
var M96_EVENTS = ['payday', 'coffee', 'audit', 'supply', 'overtime'];
var LOTTO_PRICE = 50000, LOTTO_MAX = 10, LOTTO_N = 20, LOTTO_K = 3, LOTTO_SMALL_X = 5;
function m96Get_(k, d) { try { var v = PropertiesService.getScriptProperties().getProperty(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
function m96Put_(k, v) { if (v == null) PropertiesService.getScriptProperties().deleteProperty(k); else PropertiesService.getScriptProperties().setProperty(k, JSON.stringify(v)); }
function m96Lock_() { var l = LockService.getScriptLock(); if (!l.tryLock(8000)) throw new Error('busy'); return l; }

/** menu v tabulce: ručně odpálit 10minutový firemní event pro všechny */
function triggerGlobalEventUi_() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Spustit firemní globální event (10 min pro všechny)',
    'Napiš jeden z: ' + M96_EVENTS.join(', ') + '\nPrázdné = náhodný · "stop" = zrušit běžící event', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var id = String(r.getResponseText() || '').trim().toLowerCase();
  if (id === 'stop') { m96Put_('ir_event', null); ui.alert('Event zrušen.'); return; }
  if (!id) id = M96_EVENTS[Math.floor(Math.random() * M96_EVENTS.length)];
  if (M96_EVENTS.indexOf(id) < 0) { ui.alert('Neznámý event: ' + id); return; }
  var ev = { id: id, start: Date.now(), end: Date.now() + 10 * 60000 };
  m96Put_('ir_event', ev);
  ui.alert('Spuštěno: ' + id.toUpperCase() + ' (10 minut). Hráčům se ukáže do ~30 s.');
}
function m96Event_() { var e = m96Get_('ir_event', null); return e && e.end > Date.now() ? e : null; }

// ---------- LOTERIE: tiket = 3 různá čísla z 1-20, losování každý den v 18:00 (čas skriptu). 3 shody = jackpot (90 % poolu, dělí se), 2 shody = 5× cena tiketu.
function lottoNextDraw_(now) {
  var d = new Date(now); d.setHours(18, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function lottoLoad_() {
  var s = m96Get_('ir_lotto', null);
  if (!s || !s.round) s = { round: 1, drawAt: lottoNextDraw_(Date.now()), pool: 0, t: {}, last: null };
  if (!s.t) s.t = {};
  return s;
}
function lottoDraw_(s) {
  var nums = [];
  while (nums.length < LOTTO_K) { var x = 1 + Math.floor(Math.random() * LOTTO_N); if (nums.indexOf(x) < 0) nums.push(x); }
  nums.sort(function (a, b) { return a - b; });
  var pay = m96Get_('ir_lotto_pay', {}), jack = [], small = [];
  Object.keys(s.t).forEach(function (nick) {
    (s.t[nick] || []).forEach(function (tk) {
      var hit = tk.filter(function (n) { return nums.indexOf(n) >= 0; }).length;
      if (hit === 3) jack.push(nick); else if (hit === 2) small.push(nick);
    });
  });
  var winners = [];
  small.forEach(function (nick) { var p = LOTTO_PRICE * LOTTO_SMALL_X; s.pool = Math.max(0, s.pool - p); pay[nick] = (pay[nick] || 0) + p; winners.push({ nick: nick, prize: p, kind: 2 }); });
  if (jack.length) {
    var pot = Math.floor(s.pool * 0.9), each = Math.floor(pot / jack.length);
    jack.forEach(function (nick) { pay[nick] = (pay[nick] || 0) + each; winners.push({ nick: nick, prize: each, kind: 3 }); });
    s.pool -= each * jack.length;
  }
  var players = Object.keys(s.t).length, tickets = Object.keys(s.t).reduce(function (a, k) { return a + (s.t[k] || []).length; }, 0);
  s.last = { round: s.round, nums: nums, winners: winners.slice(0, 30), pool: s.pool, players: players, tickets: tickets, at: s.drawAt };
  s.round++; s.t = {}; s.drawAt = lottoNextDraw_(Math.max(Date.now(), s.drawAt + 1000));
  m96Put_('ir_lotto_pay', pay);
}
function lottoCheck_() {
  var s = lottoLoad_();
  if (Date.now() < s.drawAt) return s;
  var lock = m96Lock_();
  try { s = lottoLoad_(); if (Date.now() >= s.drawAt) { lottoDraw_(s); m96Put_('ir_lotto', s); } return s; }
  finally { lock.releaseLock(); }
}
/** hra posílá klientem strhnutý tiket (cenu strhává klient jako u Showdownu) */
function lottoBuy(nums) {
  var me = getUserLdap();
  nums = (Array.isArray(nums) ? nums : []).map(Number).filter(function (n) { return n >= 1 && n <= LOTTO_N && Math.floor(n) === n; });
  nums = nums.filter(function (n, i) { return nums.indexOf(n) === i; }).sort(function (a, b) { return a - b; });
  if (nums.length !== LOTTO_K) return { ok: false, reason: 'nums' };
  lottoCheck_();
  var lock = m96Lock_();
  try {
    var s = lottoLoad_(), mine = s.t[me] || [];
    if (mine.length >= LOTTO_MAX) return { ok: false, reason: 'max' };
    mine.push(nums); s.t[me] = mine; s.pool += LOTTO_PRICE;
    m96Put_('ir_lotto', s);
    return { ok: true, mine: mine, pool: s.pool };
  } finally { lock.releaseLock(); }
}
/** v10.2: víc tiketů najednou (seznam trojic) - koupí, co se vejde do limitu, zbytek klient vrátí */
function lottoBuyMany(list) {
  var me = getUserLdap();
  list = (Array.isArray(list) ? list : []).slice(0, LOTTO_MAX);
  lottoCheck_();
  var lock = m96Lock_();
  try {
    var s = lottoLoad_(), mine = s.t[me] || [], n = 0;
    list.forEach(function (nums) {
      if (mine.length >= LOTTO_MAX) return;
      nums = (Array.isArray(nums) ? nums : []).map(Number).filter(function (x) { return x >= 1 && x <= LOTTO_N && Math.floor(x) === x; });
      nums = nums.filter(function (x, i) { return nums.indexOf(x) === i; }).sort(function (a, b) { return a - b; });
      if (nums.length !== LOTTO_K) return;
      mine.push(nums); s.pool += LOTTO_PRICE; n++;
    });
    s.t[me] = mine; m96Put_('ir_lotto', s);
    return { ok: true, bought: n, mine: mine, pool: s.pool };
  } finally { lock.releaseLock(); }
}
/** 40 % prohraných sázek z casina + 5 % cutu Prší (posílá klient po dávkách) */
function lottoFeed(amount) {
  amount = Math.max(0, Math.min(5e11, Math.floor(Number(amount) || 0)));
  if (!amount) return { ok: true };
  var lock = m96Lock_();
  try { var s = lottoLoad_(); s.pool += amount; m96Put_('ir_lotto', s); return { ok: true, pool: s.pool }; }
  finally { lock.releaseLock(); }
}
/** přičte do poolu bez vlastního zámku (volá se z míst, která už drží script lock) */
function m96PoolAdd_(v) { try { v = Math.max(0, Math.floor(Number(v) || 0)); if (!v) return; var s = lottoLoad_(); s.pool += v; m96Put_('ir_lotto', s); } catch (e) {} }
function lottoClaim() {
  var me = getUserLdap(), lock = m96Lock_();
  try { var pay = m96Get_('ir_lotto_pay', {}), v = Number(pay[me]) || 0; if (v) { delete pay[me]; m96Put_('ir_lotto_pay', pay); } return { ok: true, gc: v }; }
  finally { lock.releaseLock(); }
}

// ---------- NÁVŠTĚVY KANCELÁŘE: kafe (buff) nebo prank (post-it lístky za scrap), 1× za hodinu u každého kolegy
function m96SaveOf_(nick) {
  var db = getDb_(), saves = db.saves.getDataRange().getValues();
  for (var i = 1; i < saves.length; i++) if (String(saves[i][0]).toLowerCase() === String(nick).toLowerCase()) { try { return JSON.parse(rowToJson_(saves[i])); } catch (e) { return null; } }
  return null;
}
function m96Vis_(eq) {
  var o = {};
  ['w', 'a', 't'].forEach(function (k) { var it = eq && eq[k]; o[k] = { m: it && it.lv != null ? Math.max(0, Math.min(7, Math.floor(it.lv / 14) + (it.r >= 3 ? 1 : 0))) : 0 }; });
  return o;
}
function officeView(nick) {
  var s = m96SaveOf_(nick);
  if (!s) return { ok: false, reason: 'nobody' };
  var hs = s.hs || {}, col = hs.col || {}, ach = hs.ach && hs.ach.u ? Object.keys(hs.ach.u).length : 0, pl = s.plant || {};
  var v = m96Get_('ir_visit', { inbox: {}, cd: {} }), me = getUserLdap(), cdAt = (v.cd || {})[me + '>' + nick] || 0;
  return { ok: true, nick: String(nick), prestige: Number(s.prestige) || 0, maxChest: Math.max(Number(s.maxChestLevel) || 1, Number(s.chestLevel) || 1),
    plant: !!pl.seed, plantN: pl.n ? Object.keys(pl.n).length : 0, ach: ach,
    hs: { cls: hs.cls || '', level: Number(hs.level) || 1, gear: m96Vis_(hs.gear && hs.gear.eq) },
    col: col.unlocked ? { cls: col.cls || 'engineer', name: String(col.name || ''), gear: m96Vis_(col.gear) } : null,
    waiting: ((v.inbox || {})[nick] || []).length, cdLeft: Math.max(0, cdAt + 3600000 - Date.now()) };
}
function officeAct(nick, kind) {
  var me = getUserLdap();
  if (kind !== 'coffee' && kind !== 'prank') return { ok: false, reason: 'kind' };
  if (!nick || String(nick).toLowerCase() === String(me).toLowerCase()) return { ok: false, reason: 'self' };
  if (!m96SaveOf_(nick)) return { ok: false, reason: 'nobody' };
  var lock = m96Lock_();
  try {
    var v = m96Get_('ir_visit', { inbox: {}, cd: {} }); v.inbox = v.inbox || {}; v.cd = v.cd || {};
    var key = me + '>' + nick, at = v.cd[key] || 0;
    if (Date.now() - at < 3600000) return { ok: false, reason: 'cd', left: at + 3600000 - Date.now() };
    v.cd[key] = Date.now();
    Object.keys(v.cd).forEach(function (k) { if (Date.now() - v.cd[k] > 2 * 3600000) delete v.cd[k]; });
    var box = v.inbox[nick] || [];
    box.push({ from: me, k: kind, at: Date.now(), n: kind === 'prank' ? 4 + Math.floor(Math.random() * 5) : 0 });
    v.inbox[nick] = box.slice(-15);
    m96Put_('ir_visit', v);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
/** moje schránka: vrátí a smaže (kafe = buff, prank = lístky na stole) */
function officeInbox() {
  var me = getUserLdap(), lock = m96Lock_();
  try {
    var v = m96Get_('ir_visit', { inbox: {}, cd: {} }), box = (v.inbox || {})[me] || [];
    if (box.length) { delete v.inbox[me]; m96Put_('ir_visit', v); }
    return { ok: true, list: box };
  } finally { lock.releaseLock(); }
}
/** jedno volání pro klienta (každých ~30 s): event, loterie, kolik mám ve schránce */
function metaPoll() {
  var me = getUserLdap(), s = lottoCheck_(), pay = m96Get_('ir_lotto_pay', {}), v = m96Get_('ir_visit', { inbox: {} });
  return { ok: true, now: Date.now(), ev: m96Event_(),
    lotto: { round: s.round, drawAt: s.drawAt, pool: s.pool, price: LOTTO_PRICE, max: LOTTO_MAX, n: LOTTO_N, k: LOTTO_K, mine: s.t[me] || [], players: Object.keys(s.t).length, last: s.last, pay: Number(pay[me]) || 0 },
    inbox: ((v.inbox || {})[me] || []).length };
}


// ==========================================================================
// v11 HIGH STAKES DUEL - živý 1v1 souboj s kamarádem (stoly jako Dáma: CacheService + Script Properties, výplaty přes frontu).
// Každé půlkolo: útočník volí útok, obránce NASLEPO reakci. Až jsou obě volby (nebo vyprší 35 s), server půlkolo spočítá HSEngine.duelHalf.
// Vklad strhává klient (jako u Dámy), server drží bank a vyplácí přes dlPoll. Režim 'equal' = obě postavy přepočítané na stejný level a gear.
// ==========================================================================
var DL_MAX_TABLES = 4, DL_TURN_MS = 35000, DL_WAIT_MS = 300000, DL_IDLE_MS = 20 * 60000, DL_RAKE = 0.05, DL_MAX_MISS = 3, DL_MAX_STAKE = 1000000000;
function dlGet_(id) { var raw = CacheService.getScriptCache().get('dl_' + id); if (!raw) raw = prsProps_().getProperty('dl_' + id); return raw ? JSON.parse(raw) : null; }
function dlPut_(t) { var j = JSON.stringify(t); CacheService.getScriptCache().put('dl_' + t.id, j, 21600); prsProps_().setProperty('dl_' + t.id, j); }
function dlDel_(id) { CacheService.getScriptCache().remove('dl_' + id); prsProps_().deleteProperty('dl_' + id); }
function dlIndex_() { try { return JSON.parse(prsProps_().getProperty('dl_index') || '[]'); } catch (e) { return []; } }
function dlSetIndex_(a) { prsProps_().setProperty('dl_index', JSON.stringify(a)); }
function dlLog_(t, txt) { t.log.push({ at: Date.now(), t: txt }); if (t.log.length > 60) t.log.shift(); }
/** v11.6: podrobný řádek logu duelu - co se stalo s ránou (štít, block, parry, uhnutí, channel, mana, léčení, Wound...) */
function dlHitTxt_(e, names) {
  var A = names[e.i], B = names[1 - e.i], x = [];
  var what = e.a === 'ult' ? 'ULTIMATE ' + Math.round((e.q || 1) * 100) + '%' : (e.label || e.a);
  if (e.timing) what += ' (' + e.timing + ')'; if (e.reels) what += ' ' + e.reels.join('');
  if (e.manaOut) x.push('+' + e.manaOut + ' mana released');
  if (e.r === 'block') {
    if (e.rings) x.push(B + ' blocked ' + e.rings.filter(function (r) { return r !== 'none'; }).length + '/3 rings' + (e.rings.every(function (r) { return r === 'perfect'; }) ? ' (all PERFECT)' : ''));
    if (e.outcome === 'parry') x.push(B + ' PARRIED');
    else if (e.parry && e.parry !== 'none' && e.a !== 'strike') x.push(B + ' ' + e.parry + ' block');
    if (e.saved) x.push(e.saved + ' blocked');
  } else if (e.r === 'dodge') {
    if (e.dodged != null) x.push(B + ' dodged ' + e.dodged + '/3');
    else if (e.outcome === 'dodgefail') x.push(B + "'s dodge failed");
  } else if (e.r === 'channel') x.push(B + ' channeled ' + Math.round((e.cv || 0) * 100) + '% (-' + (e.saved || 0) + ', +' + (e.mana || 0) + ' mana)');
  else if (e.r === 'brace') x.push(B + ' breathed');
  if (e.shield) x.push(e.shield + ' into a shield');
  if (e.counter) x.push(B + ' countered for ' + e.counter);
  if (e.outcome === 'parry') x.push('🛡 ' + B + ' FORTIFIED (-20% damage 2 rounds)');
  if (e.heal) x.push(A + ' healed ' + e.heal + (e.healCut ? ' (-' + e.healCut + ' anti-heal)' : ''));
  if (e.wound) x.push('🩸 WOUND' + (e.wound === 'parry' ? ' on ' + A : ' on ' + B) + ': healing -50% for 2 rounds');
  return 'R' + e.t + ' ' + A + ': ' + what + ' → ' + (e.val || 0) + (e.crit ? ' CRIT' : '') + (x.length ? ' · ' + x.join(' · ') : '');
}
function dlPay_(nick, amt, why, id) {
  if (!(amt > 0)) return;
  var p = prsProps_(), m = {}; try { m = JSON.parse(p.getProperty('dl_pay') || '{}'); } catch (e) {}
  (m[nick] = m[nick] || []).push({ amt: Math.floor(amt), why: why, id: id }); p.setProperty('dl_pay', JSON.stringify(m));
}
function dlTakePay_(nick) {
  var p = prsProps_(), raw = p.getProperty('dl_pay'); if (!raw || raw.indexOf('"' + nick + '"') < 0) return [];
  var m = {}; try { m = JSON.parse(raw); } catch (e) {} var out = m[nick] || []; delete m[nick]; p.setProperty('dl_pay', JSON.stringify(m)); return out;
}
function dlCardOf_(nick) {
  var db = getDb_(), data = db.saves.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) if (String(data[i][0]) === nick) { try { var s = JSON.parse(rowToJson_(data[i])); return s.dungeon && s.dungeon.cls && s.dungeon.card ? s.dungeon.card : null; } catch (e) { return null; } }
  return null;
}
function dlHeroes_(t) {
  var a = HSEngine.fromCard(t.cards[t.host]), b = HSEngine.fromCard(t.cards[t.guest]);
  if (t.mode === 'equal') { var L = Math.max(a.level, b.level), al = t.al || {}; a = HSEngine.stdHero(a.cls, L, al[t.host]); b = HSEngine.stdHero(b.cls, L, al[t.guest]); }
  return [a, b];
}
/** v11.2: "rovné podmínky" - před startem si každý rozdělí stejné body (45 s), pak se teprve začne */
var DL_SETUP_MS = 45000;
function dlEqualL_(t) { var a = HSEngine.fromCard(t.cards[t.host]), b = HSEngine.fromCard(t.cards[t.guest]); return Math.max(a ? a.level : 1, b ? b.level : 1); }
function dlStats(id, al) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = dlGet_(id); if (!t || t.status !== 'play' || !t.setup) return { ok: false, reason: 'gone' };
    if (t.host !== me && t.guest !== me) return { ok: false, reason: 'seat' };
    var a = HSEngine.okAlloc(al, dlEqualL_(t)); if (!a) return { ok: false, reason: 'stats' };
    t.al = t.al || {}; t.al[me] = a; t.rev++;
    dlLog_(t, me + ' is ready.');
    if (t.al[t.host] && t.al[t.guest]) dlStart_(t);
    dlPut_(t);
    return { ok: true, view: dlView_(t, me) };
  } finally { lock.releaseLock(); }
}
function dlStart_(t) {
  delete t.setup;
  var c = dlHeroes_(t), d = HSEngine.duelNew(c[0], c[1], t.seed);
  delete d.R; delete d.c; d.events = [];
  t.ds = d; t.status = 'play'; t.started = Date.now(); t.moved = Date.now(); t.deadline = Date.now() + DL_TURN_MS + 5000; t.pick = { a: '', r: '' }; t.miss = {}; t.rev++;
  t.max = d.max.slice(); t.cls = [c[0].cls, c[1].cls]; t.lv = [c[0].level, c[1].level];
  dlLog_(t, (d.first === 0 ? t.host : t.guest) + ' strikes first.');
}
function dlResolve_(t, auto) {
  var c = dlHeroes_(t), d = t.ds;
  d.R = HSEngine.rng((t.seed + d.half * 7919 + 13) >>> 0); d.c = c; d.events = [];
  var names = [t.host, t.guest], att = d.atk;
  var opt = {}, ao = t.pick.ao || {}, ro = t.pick.ro || {};
  // v11.1: výsledky mini-her (HEAVY timing, ulti, gamble válce, parry, dodge) - hodnoty jsou už pročištěné v dlMove
  opt.t = ao.t || 'none'; opt.q = ao.q != null ? ao.q : 0.85;
  if (t.pick.a === 'gamble' && ao.g) { var re = !!ao.g.re && d.sta[att] >= 30; opt.reels = HSEngine.duelReels(c[att], dlRolls_(t), ao.g.hold, re); opt.respin = re; }
  if (ro.parry) opt.parry = ro.parry; if (ro.dq) opt.dq = ro.dq; if (ro.cq) opt.cq = ro.cq; if (ro.cv != null) opt.cv = ro.cv; if (ro.rings) opt.rings = ro.rings; if (ro.dqs) opt.dqs = ro.dqs;
  if (t.pick.a === 'ult' && ao.guess) opt.guess = ao.guess;
  var evs = HSEngine.duelHalf(d, t.pick.a || 'strike', t.pick.r || 'brace', opt);
  delete d.R; delete d.c; d.events = [];
  t.lastEv = evs; t.evSeq = (t.evSeq || 0) + 1; t.pick = { a: '', r: '' }; t.moved = Date.now(); t.deadline = Date.now() + DL_TURN_MS; t.rev++;
  evs.forEach(function (e) {
    if (e.type === 'hit') dlLog_(t, dlHitTxt_(e, names));
    else if (e.type === 'rest') dlLog_(t, 'R' + e.t + ' ' + names[e.i] + ' catches a breath (+30 stamina)');
    else if (e.type === 'guess') dlLog_(t, 'R' + e.t + ' ' + names[e.i] + (e.ok ? ' guessed right: ' + e.fx : ' guessed wrong'));
    else if (e.type === 'bm') dlLog_(t, names[e.i] + ' Blood Magic +' + e.val + ' HP');
    else if (e.type === 'ult' && e.shield) dlLog_(t, 'R' + e.t + ' ' + names[e.i] + ': FIREWALL ' + Math.round((e.q || 1) * 100) + '% · +' + e.shield + ' shield, +' + e.heal + ' HP');
    else if (e.type === 'poison') dlLog_(t, names[e.who] + ' infection -' + e.val + ' HP');
    else if (e.type === 'dodge') dlLog_(t, 'R' + e.t + ' ' + names[e.i] + ': ' + (e.a === 'ult' ? 'ULTIMATE' : (e.label || e.a)) + ' → ' + names[1 - e.i] + ' DODGED' + (e.dodged ? ' all 3' : '') + (e.riposte ? ' · ↩ riposte ' + e.riposte : ''));
    else if (e.type === 'bf') dlLog_(t, 'R' + e.t + ' ' + names[e.i] + ' backfired (' + e.val + ')');
    else if (e.type === 'revive') dlLog_(t, names[e.who] + ' gets back up with ' + e.val + ' HP!');
  });
  if (d.over) dlEnd_(t, names[d.win], d.hp[1 - d.win] <= 0 ? 'K.O.' : 'time');
}
function dlEnd_(t, winner, why) {
  t.status = 'done'; t.doneAt = Date.now(); t.deadline = 0; t.winner = winner || ''; t.why = why;
  if (winner) {
    var win = Math.floor(t.stake * 2 * (1 - DL_RAKE)); t.win = win; dlPay_(winner, win, 'WIN', t.id);
    if (t.stake > 0) m96PoolAdd_(t.stake * 2 - win);
    var loser = winner === t.host ? t.guest : t.host;
    dlLog_(t, '🏆 ' + winner + ' wins' + (win ? ' ' + win.toLocaleString() + ' GC' : '') + ' (' + why + ')');
    try { getDb_().chat.appendRow([new Date(), '⚔ DUEL', '🏆 ' + winner + ' beat ' + loser + ' in a High Stakes duel' + (win ? ' (+' + win.toLocaleString() + ' GC)' : '') + ' - ' + why + '.']); } catch (e) {}
  } else {
    [t.host, t.guest].forEach(function (n) { if (n) dlPay_(n, t.stake, 'DRAW', t.id); });
    dlLog_(t, '🤝 Draw (' + why + ') - stakes returned');
  }
}
function dlTimeouts_(t) {
  var ch = false;
  if (t.status === 'play' && t.setup && t.deadline && Date.now() > t.deadline) { dlLog_(t, '⏱ setup time is up - default stats for anyone not ready'); dlStart_(t); return true; }
  if (t.status === 'play' && t.deadline && Date.now() > t.deadline) {
    var names = [t.host, t.guest], d = t.ds, att = names[d.atk], def = names[1 - d.atk], ultWait = d.foc[d.atk] >= 100 && !t.pick.a;
    [[att, 'a'], [def, 'r']].forEach(function (x) { if (x[1] === 'r' && ultWait) return; if (!t.pick[x[1]]) t.miss[x[0]] = (t.miss[x[0]] || 0) + 1; else t.miss[x[0]] = 0; });
    ch = true;
    var out = [att, def].filter(function (n) { return (t.miss[n] || 0) >= DL_MAX_MISS; });
    if (out.length === 2) { dlEnd_(t, '', 'both players left'); t.rev++; }
    else if (out.length === 1) { dlEnd_(t, out[0] === t.host ? t.guest : t.host, out[0] + ' timed out 3×'); t.rev++; }
    else { dlLog_(t, '⏱ time ran out - default moves'); dlResolve_(t, true); }
  }
  return ch;
}
function dlHousekeep_(t) {
  var now = Date.now();
  if (t.status === 'wait' && now - t.created > DL_WAIT_MS) { dlPay_(t.host, t.stake, 'REFUND', t.id); t.status = 'gone'; return true; }
  if (t.status === 'done' && now - t.doneAt > 180000) { t.status = 'gone'; return true; }
  if (t.status === 'play' && now - t.moved > DL_IDLE_MS) { dlEnd_(t, '', 'abandoned'); t.status = 'gone'; return true; }
  return false;
}
function dlLoadAll_() {
  var ids = dlIndex_(), out = [], keep = [], dirty = false;
  ids.forEach(function (id) {
    var t = dlGet_(id); if (!t) { dirty = true; return; }
    var hk = dlHousekeep_(t), to = dlTimeouts_(t);
    if (hk || to) { dirty = true; if (t.status === 'gone') { dlDel_(id); return; } dlPut_(t); }
    keep.push(id); out.push(t);
  });
  if (dirty) dlSetIndex_(keep);
  return out;
}
function dlBusy_(ts, me) { return ts.some(function (t) { return (t.status === 'wait' || t.status === 'play') && (t.host === me || t.guest === me) && !(t.seen && t.seen[me]); }); }
function dlList() {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var ts = dlLoadAll_(), mine = '';
    ts.forEach(function (t) { if ((t.host === me || t.guest === me) && !(t.seen && t.seen[me])) mine = t.id; });
    return { ok: true, tables: ts.filter(function (t) { return t.status === 'wait' || t.status === 'play'; }).map(function (t) { return { id: t.id, host: t.host, guest: t.guest, target: t.target || '', stake: t.stake, mode: t.mode, status: t.status, cls: t.hostCls, lv: t.hostLv }; }),
      mine: mine, max: DL_MAX_TABLES, maxStake: DL_MAX_STAKE, pay: dlTakePay_(me) };
  } finally { lock.releaseLock(); }
}
/** stake 0 = přátelský duel; mode 'own' | 'equal'; target = přezdívka (jen ona se může připojit) nebo '' */
function dlCreate(stake, mode, target) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    stake = Math.floor(Number(stake) || 0);
    if (!(stake >= 0 && stake <= DL_MAX_STAKE)) return { ok: false, reason: 'stake' };
    mode = mode === 'equal' ? 'equal' : 'own'; target = cleanTxt_(target || '', 24);
    if (target === me) target = '';
    var card = dlCardOf_(me); if (!card || !HSEngine.fromCard(card)) return { ok: false, reason: 'noclass' };
    var ts = dlLoadAll_();
    if (dlBusy_(ts, me)) return { ok: false, reason: 'already' };
    if (ts.filter(function (t) { return t.status === 'wait' || t.status === 'play'; }).length >= DL_MAX_TABLES) return { ok: false, reason: 'full' };
    var h0 = HSEngine.fromCard(card);
    var t = { id: Utilities.getUuid().slice(0, 8), host: me, guest: '', target: target, stake: stake, mode: mode, status: 'wait', created: Date.now(), rev: 1, log: [], miss: {}, seen: {}, cards: {}, seed: Math.floor(Math.random() * 2147483646) + 1, hostCls: h0.cls, hostLv: h0.level };
    t.cards[me] = card;
    dlLog_(t, me + ' is waiting for ' + (target || 'an opponent'));
    dlPut_(t); var idx = dlIndex_(); idx.push(t.id); dlSetIndex_(idx);
    try { getDb_().chat.appendRow([new Date(), '⚔ DUEL', me + ' challenges ' + (target || 'anyone') + ' to a High Stakes duel' + (stake ? ' for ' + stake.toLocaleString() + ' GC' : '') + (mode === 'equal' ? ' (equal terms)' : '') + '. Accept in HIGH STAKES > DUEL!']); } catch (e) {}
    return { ok: true, id: t.id };
  } finally { lock.releaseLock(); }
}
function dlJoin(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var ts = dlLoadAll_(), t = ts.filter(function (x) { return x.id === id; })[0];
    if (!t || t.status !== 'wait') return { ok: false, reason: 'gone' };
    if (t.host === me) return { ok: false, reason: 'self' };
    if (t.target && t.target !== me) return { ok: false, reason: 'private' };
    if (dlBusy_(ts, me)) return { ok: false, reason: 'already' };
    var card = dlCardOf_(me); if (!card || !HSEngine.fromCard(card)) return { ok: false, reason: 'noclass' };
    t.guest = me; t.cards[me] = card;
    dlLog_(t, me + ' accepted the duel.');
    if (t.mode === 'equal') { t.status = 'play'; t.setup = true; t.al = {}; t.ds = null; t.pick = { a: '', r: '' }; t.miss = {}; t.moved = Date.now(); t.deadline = Date.now() + DL_SETUP_MS; t.rev++; dlLog_(t, 'Equal terms: both players split their stat points.'); }
    else dlStart_(t);
    dlPut_(t);
    return { ok: true, id: t.id, stake: t.stake };
  } finally { lock.releaseLock(); }
}
function dlLeave(id) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = dlGet_(id); if (!t) return { ok: true };
    if (t.status === 'wait' && t.host === me) { dlPay_(me, t.stake, 'REFUND', t.id); dlDel_(id); dlSetIndex_(dlIndex_().filter(function (x) { return x !== id; })); return { ok: true }; }
    if (t.status === 'play' && (t.host === me || t.guest === me)) { dlEnd_(t, me === t.host ? t.guest : t.host, me + ' fled'); t.rev++; }
    t.seen = t.seen || {}; t.seen[me] = 1; dlPut_(t);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
/** v11.1: 6 náhodných čísel na gamble válce v tomto půlkole (klient je ukáže, server z nich spočítá stejné válce) */
function dlRolls_(t) { var d = t.ds, R = HSEngine.rng(((t.seed || 1) + (d ? d.half : 0) * 104729 + 77) >>> 0), a = []; for (var k = 0; k < 6; k++) a.push(Math.round(R() * 1e6) / 1e6); return a; }
function dlView_(t, me) {
  var you = t.host === me ? 0 : t.guest === me ? 1 : -1, d = t.ds || null;
  var role = '', picked = false, oppPicked = false;
  if (d && t.status === 'play' && you >= 0) {
    role = d.atk === you ? 'atk' : 'react';
    picked = !!t.pick[role === 'atk' ? 'a' : 'r']; oppPicked = !!t.pick[role === 'atk' ? 'r' : 'a'];
  }
  var ultReady = !!(d && t.status === 'play' && d.foc[d.atk] >= 100), su = null;
  if (t.setup && you >= 0) { var Ls = dlEqualL_(t); su = { L: Ls, pts: HSEngine.statPoints(Ls), ready: [!!(t.al || {})[t.host], !!(t.al || {})[t.guest]], mine: (t.al || {})[me] || null }; }
  return { id: t.id, rev: t.rev, status: t.status, host: t.host, guest: t.guest, target: t.target || '', stake: t.stake, mode: t.mode, you: you, names: [t.host, t.guest],
    cls: t.cls || [t.hostCls, ''], lv: t.lv || [t.hostLv, 0], cards: t.cards, max: t.max || null,
    hp: d ? d.hp : null, sta: d ? d.sta : null, foc: d ? d.foc : null, sh: d ? d.sh : null, sure: d ? d.sure : null, chan: d ? d.chan : null, atk: d ? d.atk : -1, turn: d ? d.turn : 0, half: d ? d.half : 0,
    cd: d ? (d.cd || [0, 0]) : null, gr: role === 'atk' && !picked ? dlRolls_(t) : null, ultReady: ultReady, waitAtk: role === 'react' && ultReady && !t.pick.a, setup: su,
    gu: d ? (d.gu || [false, false]) : null, wd: d ? (d.wd || [0, 0]) : null, fort: d ? (d.fort || [0, 0]) : null, mana: d ? (d.mana || [0, 0]) : null, vuln: d ? d.vuln : null, bm: d ? (d.bm || [0, 0]) : null, ep: d ? (d.ep || [0, 0]) : null, sa: d ? (d.sa || [0, 0]) : null, nocd: d ? (d.nocd || [0, 0]) : null,
    role: role, picked: picked, oppPicked: oppPicked, left: t.deadline ? Math.max(0, t.deadline - Date.now()) : 0, last: t.lastEv || [], evSeq: t.evSeq || 0, miss: t.miss || {},
    winner: t.winner || '', why: t.why || '', win: t.win || 0, waitLeft: t.status === 'wait' ? Math.max(0, DL_WAIT_MS - (Date.now() - t.created)) : 0, log: t.log.slice(-30) };
}
function dlPoll(id, rev) {
  var me = getUserLdap(), t = dlGet_(id), pay = [];
  var due = t && ((t.status === 'play' && t.deadline && Date.now() > t.deadline) || (t.status === 'wait' && Date.now() - t.created > DL_WAIT_MS) || (t.status === 'play' && Date.now() - t.moved > DL_IDLE_MS));
  if (due) {
    var lock = prsLock_();
    try { t = dlGet_(id); if (t) { var hk = dlHousekeep_(t), to = dlTimeouts_(t); if (hk || to) { if (t.status === 'gone') { dlDel_(id); dlSetIndex_(dlIndex_().filter(function (x) { return x !== id; })); t = null; } else { t.rev++; dlPut_(t); } } } }
    finally { lock.releaseLock(); }
  }
  var raw = prsProps_().getProperty('dl_pay');
  if (raw && raw.indexOf('"' + me + '"') >= 0) { var l2 = prsLock_(); try { pay = dlTakePay_(me); } finally { l2.releaseLock(); } }
  if (!t) return { ok: true, gone: true, pay: pay };
  if (Number(rev) === t.rev && !pay.length) return { ok: true, same: true, rev: t.rev, left: t.deadline ? Math.max(0, t.deadline - Date.now()) : 0 };
  return { ok: true, view: dlView_(t, me), pay: pay };
}
/** choice = útok (strike/heavy/gamble/rest/ult), když útočíš, nebo reakce (block/dodge/channel/brace), když se bráníš.
 *  opt (v11.1) = výsledek mini-hry: { h: půlkolo, t, q, g: { hold, re }, parry, dq } */
function dlMove(id, choice, opt) {
  var me = getUserLdap(), lock = prsLock_();
  try {
    var t = dlGet_(id); if (!t || t.status !== 'play') return { ok: false, reason: 'gone' };
    dlTimeouts_(t);
    if (t.status !== 'play') { dlPut_(t); return { ok: false, reason: 'over', view: dlView_(t, me) }; }
    var you = t.host === me ? 0 : t.guest === me ? 1 : -1; if (you < 0) return { ok: false, reason: 'seat' };
    if (t.setup) return { ok: false, reason: 'setup', view: dlView_(t, me) };
    var d = t.ds, role = d.atk === you ? 'a' : 'r';
    if (role === 'r' && d.foc[d.atk] >= 100 && !t.pick.a) return { ok: false, reason: 'wait', view: dlView_(t, me) };
    choice = String(choice || '');
    var okA = ['strike', 'heavy', 'gamble', 'rest', 'ult'], okR = ['block', 'dodge', 'channel', 'brace'];
    if ((role === 'a' ? okA : okR).indexOf(choice) < 0) return { ok: false, reason: 'choice', view: dlView_(t, me) };
    if (t.pick[role]) return { ok: false, reason: 'picked', view: dlView_(t, me) };
    opt = opt && typeof opt === 'object' ? opt : {};
    if (opt.h != null && Number(opt.h) !== d.half) return { ok: false, reason: 'late', view: dlView_(t, me) };
    var TIER = ['perfect', 'good', 'none'], o = {};
    if (role === 'a') {
      if (choice === 'heavy' && TIER.indexOf(opt.t) >= 0) o.t = opt.t;
      if (choice === 'ult' && isFinite(Number(opt.q))) o.q = Math.max(0.7, Math.min(1.25, Number(opt.q)));
      if (choice === 'gamble' && opt.g && Array.isArray(opt.g.hold)) o.g = { hold: [0, 1, 2].map(function (k) { return !!opt.g.hold[k]; }), re: !!opt.g.re };
      if (choice === 'ult' && ['block', 'dodge', 'channel', 'brace'].indexOf(opt.guess) >= 0) o.guess = opt.guess;
      t.pick.ao = o;
    } else {
      var T3 = function (x) { return Array.isArray(x) ? [0, 1, 2].map(function (k) { return TIER.indexOf(x[k]) >= 0 ? x[k] : 'none'; }) : null; };
      if (choice === 'block' && TIER.indexOf(opt.parry) >= 0) o.parry = opt.parry;
      if (choice === 'block' && T3(opt.rings)) o.rings = T3(opt.rings);
      if (choice === 'dodge' && TIER.indexOf(opt.dq) >= 0) o.dq = opt.dq;
      if (choice === 'dodge' && T3(opt.dqs)) o.dqs = T3(opt.dqs);
      if (choice === 'channel' && TIER.indexOf(opt.cq) >= 0) o.cq = opt.cq;
      if (choice === 'channel' && isFinite(Number(opt.cv))) o.cv = Math.max(0, Math.min(1, Number(opt.cv)));
      t.pick.ro = o;
    }
    t.pick[role] = choice; t.miss[me] = 0; t.rev++;
    if (role === 'a' && d.foc[d.atk] >= 100 && !t.pick.r) t.deadline = Math.max(t.deadline || 0, Date.now() + DL_TURN_MS);   // v11.2: obránce teprve teď vybírá
    if (t.pick.a && t.pick.r) dlResolve_(t, false);
    dlPut_(t);
    return { ok: true, view: dlView_(t, me) };
  } finally { lock.releaseLock(); }
}

// ==========================================================================
// v11.4: PŘEZDÍVKY - každý si v nastavení může dát vlastní jméno, které se ukazuje ostatním (ID hráče zůstává stejné)
// ==========================================================================
function nicksAll_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('tt_nicks') || '{}') || {}; } catch (e) { return {}; } }
function nickList() { return { ok: true, nicks: nicksAll_() }; }
function setNick(nick) {
  var me = getUserLdap(), lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return { ok: false, reason: 'busy' };
  try {
    var all = nicksAll_();
    nick = cleanTxt_(nick || '', 20).replace(/[\u0000-\u001f]/g, '').replace(/^\s+|\s+$/g, '').replace(/\s+/g, ' ');
    if (!nick || nick.toLowerCase() === String(me).toLowerCase()) delete all[me];
    else {
      if (nick.length < 2) return { ok: false, reason: 'short' };
      var low = nick.toLowerCase();
      for (var k in all) if (k !== me && (String(all[k]).toLowerCase() === low || String(k).toLowerCase() === low)) return { ok: false, reason: 'taken' };
      try { var ids = getDb_().saves.getRange(1, 1, getDb_().saves.getLastRow(), 1).getValues(); for (var r = 0; r < ids.length; r++) { var id = String(ids[r][0]); if (id !== me && id.toLowerCase() === low) return { ok: false, reason: 'taken' }; } } catch (e) {}
      all[me] = nick;
    }
    PropertiesService.getScriptProperties().setProperty('tt_nicks', JSON.stringify(all));
    return { ok: true, nick: all[me] || '', nicks: all };
  } finally { lock.releaseLock(); }
}


// ===================== HIGH STAKES ENGINE (vygenerováno build.py ze src/hs_engine.js - neupravovat ručně) =====================
/**
 * HIGH STAKES 2.0 (v11) - bojový engine (čistý JS: hra, simulace, server pro arénu a duely).
 * Kolo = 2 rozhodnutí: 1) TVŮJ ÚTOK (strike / heavy / gamble / ultimate), 2) nepřítel ukáže, co chystá (telegraf), 3) TVOJE REAKCE (block / dodge / channel / breathe).
 * Staty po vzoru SFGame: damage = zbraň × (1 + max(tvůj/2, tvůj − jeho/2) / 10), HP = VIT × násobek třídy × (level + 6), crit = LUCK proti levelu soupeře (max 50 %).
 */
(function (root) {
  "use strict";

  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ------------------------------------------------------------------ TŘÍDY (id sysadmin/engineer/cyber zůstávají kvůli savům)
  const CLASSES = {
    sysadmin: { name: "Firewall Warden", role: "Warrior", icon: "🛡", main: "str", hpM: 4.4, armorM: 1.5, armorCap: 0.3, block: 0.45, blockCost: 35, dodge: 0, counter: 0.5, dmgM: 1.25,
      desc: "Warrior. The most HP and armor, a strong BLOCK (-45%, 35 stamina) - blocking a normal ⚔ attack COUNTERS for half your damage. Can't dodge. PvP: a PERFECT parry or PERFECT HEAVY inflicts 🩸 WOUND (the enemy heals 50% less for 2 rounds).",
      skill: "FIREWALL", skillTxt: "Shield bash 1.4× + a shield of 30% max HP and heal 5%." },
    cyber: { name: "Trojan", role: "Assassin", icon: "🦠", main: "agi", hpM: 4, armorM: 1, armorCap: 0.25, block: 0, dodge: 0.5, critX: 2.5, critAdd: 0.05, dodgeCost: 25, dmgM: 1.15,
      desc: "Assassin - a virus in the network. DODGE (50%, up to 75% with AGI, 25 stamina) - a dodge makes your next hit a sure crit. Crits deal 2.5×. Can't block, can't dodge 🔮 spells.",
      skill: "BACKDOOR", skillTxt: "2.8× hit that ignores armor, wipes the enemy's buffs and BREAKS it (PvP: also 🩸 WOUND)." },
    engineer: { name: "Code Wizard", role: "Mage", icon: "🧙", main: "int", hpM: 3.9, armorM: 1, armorCap: 0.15, block: 0, dodge: 0, dmgM: 1.75, spellImmune: true, channel: true,
      desc: "Mage. +75% damage and immune to enemy 🔮 spells, but the least HP. No block, no dodge - CHANNEL (20 stamina): hold the marker in a moving band to take 10-35% less damage and store the absorbed damage as MANA, released with your next hit. Enemies dodge your hits only half as often and their blocks work half as well.",
      skill: "PRODUCTION PUSH", skillTxt: "One huge 3.2× hit with double crit chance." },
    blood: { name: "Caffeine Abuser", role: "Caffeine Abuser", icon: "☕", main: "str", hpM: 3.8, armorM: 1, armorCap: 0.25, block: 0.4, blockCost: 30, dodge: 0.2, dmgM: 1.1, lifesteal: 0.15, revive: 0.25,
      desc: "Runs on coffee: heals 15% of the damage dealt and has a 25% chance to get back up once per fight with 30% HP. Can block (-40%) and dodge (20%), but neither well.",
      skill: "DOUBLE ESPRESSO", skillTxt: "2.6× hit that heals you for 60% of the damage." },
    hunter: { name: "Bug Hunter", role: "Hunter", icon: "🏹", main: "agi", hpM: 4.2, armorM: 1, armorCap: 0.25, block: 0, dodge: 0.35, dmgM: 1.1, double: true, dodgeCost: 25, firstStrike: true, mark: 0.15,
      desc: "Hits twice (2 × 60%, HEAVY too), strikes first in every fight and MARKS the target (+15% damage taken). Only 35% dodge.",
      skill: "HEADHUNT", skillTxt: "4 arrows × 0.9 - every arrow can crit." }
  };
  const CLASS_IDS = ["sysadmin", "cyber", "engineer", "blood", "hunter"];
  /** PvP (aréna, duel): delší boje (HP ×2) a vyrovnání tříd mezi sebou (laděno simulací, každá třída ~50 % proti ostatním) */
  const PVP = { hp: 2, heal: 0.65, revive: 0.15, wound: 0.5, hpc: {}, blk: { sysadmin: 0.45 }, ctr: 0.5, dmg: { sysadmin: 0.64, cyber: 0.69, engineer: 0.77, blood: 1.26, hunter: 1.02 } };
  const HPK = 0.28, ENEMY_HPM = 6, ENEMY_DMG = 0.82, BASE = 10;

  // ------------------------------------------------------------------ AKCE
  const ATTACKS = {
    strike: { name: "STRIKE", icon: "⚔", sta: 0, gain: 10, mult: 1, brk: 10, txt: "free · 1× hit · +10 stamina" },
    heavy: { name: "HEAVY", icon: "💥", sta: 30, cd: 1, mult: 1.7, brk: 20, txt: "30 STA · stop the needle: 1.7× / gold 2.2× · breaks a guard, interrupts a charge · then 1 round cooldown" },
    rest: { name: "BREATHE", icon: "😮‍💨", sta: 0, gain: 30, foc: 0, brk: 0, txt: "no attack · +30 stamina, +15 focus, cures poison" },
    gamble: { name: "GAMBLE", icon: "🎰", sta: 20, mult: 0, brk: 0, txt: "20 STA · slot machine, HOLD + 1 re-spin" },
    ult: { name: "ULTIMATE", icon: "✨", foc: 100, brk: 40, txt: "100 focus" }
  };
  const REACTS = {
    block: { name: "BLOCK", icon: "🛡", txt: "less damage, PARRY the big ones" },
    dodge: { name: "DODGE", icon: "💨", sta: 25, txt: "25 stamina · avoid the hit completely (not 🔮 spells)" },
    channel: { name: "CHANNEL", icon: "🔮", sta: 20, txt: "20 stamina · hold the band: -10 to -35% damage, absorbed damage becomes MANA for your next hit" },
    brace: { name: "BREATHE", icon: "😮‍💨", txt: "+15 stamina, +10 focus, cures poison" }
  };
  // starší názvy (save / server / staré odkazy)
  const ACTIONS = Object.assign({}, ATTACKS, REACTS);
  const ATK_KEYS = ["strike", "heavy", "gamble", "rest", "ult"];
  /** v11.1: TŘÍDY NEPŘÁTEL (běžní a elitní nepřátelé, bossové mají vlastní mechaniky) */
  const ECLS = {
    virus: { n: "🦠 Virus", t: "its hits POISON you (4% max HP per round for 2 rounds) - BREATHE cures it" },
    swarm: { n: "🐛 Swarm", t: "attacks in two quick bites" },
    firewall: { n: "🧱 Firewall", t: "guards a lot and reflects 20% of your damage while guarding" },
    manager: { n: "📈 Manager", t: "motivates itself every 3rd round (+12% damage, stacks) - a BREAK resets it" },
    leech: { n: "🧛 Leech", t: "heals 30% of the damage it deals" },
    brute: { n: "🦍 Brute", t: "more HP, hits harder and swings HEAVY more often" }
  };
  /** v11.2: TIP U ULTIMÁTKY - když uhodneš další tah soupeře, spustí se efekt tvé třídy (jednou za boj) */
  const GUESS_FX = {
    engineer: { n: "🩸 BLOOD MAGIC", t: "your next 3 hits heal you for 25% of their damage (max 8% HP each)" },
    sysadmin: { n: "🧱 FIREWALL UP", t: "+20% max HP shield and the next hit you take is halved" },
    cyber: { n: "🦠 INFECTION", t: "poison: 4% of its max HP every round for 3 rounds" },
    hunter: { n: "🎯 MARKED FOR DEATH", t: "your next 2 attacks always crit" },
    blood: { n: "☕ SUGAR RUSH", t: "+40 stamina and HEAVY has no cooldown for 2 rounds" }
  };
  /** kategorie tahu nepřítele pro tip (kampaň) */
  const GUESS_PVE = ["atk", "heavy", "guard", "other"];
  /** v11.4: CHANNEL = držení v pohyblivém pásu; cv 0-1 = podíl času v pásu (staré cq tiery se převedou) */
  function chanVal(opt) { if (opt && typeof opt.cv === "number" && isFinite(opt.cv)) return clamp(opt.cv, 0, 1); const q = opt && opt.cq; return q === "perfect" ? 0.95 : q === "none" ? 0.3 : 0.7; }
  function guessCat(k) { return k === "atk" ? "atk" : k === "heavy" || k === "unleash" ? "heavy" : k === "defend" ? "guard" : "other"; }
  const ITEMS = {}, MAX_ITEMS_PER_FIGHT = 0;
  const REELS = [["🍒", 30], ["🔔", 22], ["⭐", 12], ["7️⃣", 8], ["💀", 14]];

  // ------------------------------------------------------------------ STATY
  function statPoints(level) { return 5 * (Math.max(1, level | 0) - 1); }
  /** typická postava levelu L: body 50 % hlavní / 30 % VIT / 20 % LUCK, gear kvality k (rarita × upgrade) */
  function typical(L, k) {
    L = Math.max(1, L); k = k || 1.4;
    const pts = statPoints(L);
    return { main: BASE + 0.5 * pts + 1.5 * L * k, vit: BASE + 0.3 * pts + 1.5 * L * k, luck: BASE + 0.2 * pts + 0.8 * L * k, wpn: (6 + 2 * L) * k, armor: 20 * L * k };
  }
  /** h = { cls, level, stats:{str,agi,int,vit,luck}, bonus }, gear = { wpn, armor, crit, stats:{main,vit,luck} } (Gear.mult()) */
  function buildHero(h, gear) {
    const L = Math.max(1, h.level || 1), st = h.stats || {};
    const cls = CLASSES[h.cls] ? h.cls : "sysadmin", C = CLASSES[cls];
    gear = gear || {};
    const gs = gear.stats || {}, bonus = h.bonus || 0;
    const S = (k) => BASE + (Number(st[k]) || 0);
    const main = S(C.main) + (Number(gs.main) || 0), vit = S("vit") + (Number(gs.vit) || 0), luck = S("luck") + (Number(gs.luck) || 0);
    const wpn = (Number(gear.wpn) > 0 ? Number(gear.wpn) : 4 + 1.5 * L) * (1 + bonus);
    const hero = {
      cls: cls, level: L, mainKey: C.main, main: main, def: main, vit: vit, luck: luck,
      str: S("str"), agi: S("agi"), int: S("int"),
      wpn: wpn, armor: (Number(gear.armor) || 0) * C.armorM, armorCap: C.armorCap,
      maxHp: Math.max(10, Math.round(vit * C.hpM * (L + 6) * HPK * (1 + bonus))),
      dmgM: C.dmgM || 1, critX: C.critX || 2, critAdd: (C.critAdd || 0) + (Number(gear.crit) || 0),
      block: C.block || 0, blockCost: C.blockCost || 25, dodge: C.dodge || 0, dodgeCost: C.dodgeCost || 25, canChannel: !!C.channel, spellImmune: !!C.spellImmune,
      lifesteal: C.lifesteal || 0, revive: C.revive || 0, counter: C.counter || 0, double: !!C.double, firstStrike: !!C.firstStrike, mark: C.mark || 0,
      dr: 0, staMax: 100, staGain: 0,
      zone: Math.min(0.42, 0.16 + luck / (luck + 40 + 6 * L) * 0.3 + (cls === "engineer" ? 0.06 : 0)),
      luckReel: Math.min(30, luck / (L + 9) * 3) + (cls === "cyber" ? 10 : 0),
      items: {}
    };
    hero.atk = estDmg(hero, hero.level, hero.main);
    return hero;
  }
  /** průměrná rána proti soupeři se stejným hlavním statem (pro UI, kolegu, world boss) */
  function estDmg(h, L, def) { const eff = Math.max(h.main / 2, h.main - (def == null ? h.main : def) / 2); return h.wpn * (1 + eff / 10) * (h.dmgM || 1); }
  function critOf(a, d) { return clamp(a.luck * 0.12 / ((d.level || 1) + 9), 0, 0.5) + (a.critAdd || 0); }

  // ------------------------------------------------------------------ NEPŘÁTELÉ
  const ARCH = { tank: { hp: 1.45, dmg: 0.8, armor: 0.3, def: 1.15, n: "🛡 Tank" }, glass: { hp: 0.72, dmg: 1.32, armor: 0.05, def: 0.85, n: "🗡 Glass cannon" },
    bal: { hp: 1, dmg: 1, armor: 0.15, def: 1, n: "" }, spec: { hp: 0.92, dmg: 0.95, armor: 0.12, def: 1, n: "✨ Specialist" } };
  const KIND = { normal: [1, 1], compliance: [1.05, 1], elite: [1.2, 1.03], mini: [1.3, 1.05], boss: [1.4, 1.05], secret: [1.7, 1.1], world: [1, 1] };
  /** o = { level, arch, kind, hpM, dmgM, name, icon, mech, pattern, sprite, k } */
  function buildEnemy(o) {
    const L = Math.max(1, Math.round(o.level || 1)), t = typical(L, o.k || 1.4), A = ARCH[o.arch] || ARCH.bal, K = KIND[o.kind] || KIND.normal;
    const ec = ECLS[o.ecls] ? o.ecls : "", ps = 1 + 0.67 * Math.max(0, Number(o.ps) || 0);          // ps = High Stakes prestiž (+67 % HP a damage za každou)
    const eh = ec === "brute" ? 1.12 : ec === "swarm" ? 0.92 : ec === "firewall" ? 1.05 : 1, ed = ec === "brute" ? 1.08 : ec === "leech" ? 0.92 : ec === "virus" ? 0.9 : 1;
    const e = Object.assign({}, o, {
      enemy: true, level: L, main: t.main, def: t.main * A.def, luck: t.luck * 0.8, vit: t.vit,
      maxHp: Math.max(5, Math.round(t.vit * ENEMY_HPM * (L + 6) * HPK * A.hp * K[0] * (o.hpM || 1) * eh * ps)),
      wpn: t.wpn * ENEMY_DMG * A.dmg * K[1] * (o.dmgM || 1) * ed * ps, armorRed: A.armor, dmgM: 1, critX: 2, critAdd: 0, ecls: ec, archName: ec ? ECLS[ec].n : A.n
    });
    if (ec === "brute") e.pattern = Object.assign({}, e.pattern || { atk: 6, heavy: 2, defend: 1 }, { heavy: ((e.pattern || {}).heavy || 2) * 2 });
    if (ec === "firewall") e.pattern = Object.assign({}, e.pattern || { atk: 6, heavy: 2, defend: 1 }, { defend: Math.max(3, ((e.pattern || {}).defend || 1) * 3) });
    e.hp = e.maxHp; e.atk = estDmg(e, L, t.main);
    return e;
  }

  // ------------------------------------------------------------------ RÁNA
  /** jedna rána a -> d. o = { mult, ignoreArmor, crit (vynucený), critMul } ; d.armorRed = hotová redukce, jinak z d.armor */
  function rawHit(R, a, d, o) {
    o = o || {};
    const eff = Math.max(a.main / 2, a.main - (d.def || 0) / 2);
    let v = a.wpn * (0.88 + R() * 0.24) * (1 + eff / 10) * (a.dmgM || 1) * (o.mult == null ? 1 : o.mult);
    const red = o.ignoreArmor ? 0 : d.armorRed != null ? d.armorRed : clamp((d.armor || 0) / (Math.max(1, a.level) * 100), 0, d.armorCap || 0);
    v *= 1 - red;
    const cc = o.crit === true ? 1 : o.crit === false ? 0 : Math.min(0.95, critOf(a, d) * (o.critMul || 1) + (o.critAdd || 0));
    const crit = o.crit === true || R() < cc;
    if (crit) v *= a.critX || 2;
    return { v: Math.max(1, Math.round(v)), crit: crit };
  }

  // ------------------------------------------------------------------ SOUBOJ (PvE)
  function ev(f, type, extra) { const e = Object.assign({ t: f.turn, type: type }, extra || {}); f.events.push(e); return e; }
  function newFight(hero, mission, seed) {
    const R = rng(seed || 1);
    const e = mission.enemy && mission.enemy.enemy ? mission.enemy : buildEnemy(mission.enemy || {});
    const h = hero, P = h.perks || {};
    const f = {
      R: R, h: h, m: mission, e: e, turn: 0, phase: "atk", over: false, win: false, events: [],
      hp: h.startHp != null ? clamp(Math.round(h.startHp), 1, h.maxHp) : h.maxHp, sta: h.staMax, focus: Math.min(99, 30 + (h.startFocus || 0)),
      shield: Math.round(h.maxHp * (P.shieldStart || 0)), firstHit: !!P.firstStrike, duckUsed: false, revived: false,
      ehp: e.maxHp, emax: e.maxHp, eatk: e.atk, eshield: 0, estacks: 0, eguard: false, estun: false, unleashNext: false,
      disabled: {}, cd: {}, demand: null, redTape: 0, poison: 0, mgr: 0, mana: 0, adds: 0, heat: 0, heatLast: "", eshieldP: 0, bm: 0, halfNext: false, epoison: 0, sureAtk: 0, nocd: 0, guessUsed: false, _sa: false, sureCrit: false, channel: 0, marked: false, dodgeStreak: 0, lastAct: null,
      flamenco: 0, slow: 0, rage: 0, payroll: 0, siesta: false, pastaPending: false, restartPending: false, form: "I", phase2: false,
      intent: null, lastIntent: null, brk: 0, vuln: false, stunNext: false, deceive: Number(mission.deceive) || 0, coin: 0, hotfix: false,
      st: { usedGamble: 0, usedItem: 0, perfectBlocks: 0, jackpots: 0, usedSkill: 0, perfectPower: 0, usedBlock: 0, usedReact: 0, reacts: 0, crits: 0, parries: 0, breaks: 0, forms: 0, maxHit: 0, dodges: 0 }
    };
    // jak moc chrání tvoje zbroj proti tomuhle nepříteli + šance na úhyb (AGI proti jeho obraně)
    f.hArmor = clamp((h.armor || 0) / (Math.max(1, e.level) * 100), 0, h.armorCap || 0);
    f.dodgeCh = h.dodge > 0 ? Math.min(0.75, h.dodge + (h.cls === "cyber" ? 0.3 * clamp(h.main / Math.max(1, e.def) - 0.5, 0, 1) : 0) + (P.dodge || 0)) : 0;
    pickDemand(f);
    if (h.firstStrike) {                                               // Bug Hunter: první rána ještě před bojem
      const r = rawHit(R, h, e, { mult: 0.6 }); const d = hurtEnemy(f, r.v); f.marked = true;
      ev(f, "pact", { a: "first", val: d, crit: r.crit, msg: "First strike" });
    }
    return f;
  }

  function hasReact(h, r) {
    if (r === "brace") return true;
    if (r === "block") return h.block > 0;
    if (r === "dodge") return h.dodge > 0;
    if (r === "channel") return !!h.canChannel;
    return false;
  }
  function reactsOf(h) { return ["block", "dodge", "channel", "brace"].filter(r => hasReact(h, r)); }
  function isDmgIntent(k) { return k === "atk" || k === "heavy" || k === "spell" || k === "unleash" || k === "withdraw"; }
  function allowedAtk(f, a) {
    const A = ATTACKS[a]; if (!A || f.over || f.phase !== "atk") return false;
    if (f.disabled[a] > 0 && (a !== "strike" || f.disabled[a] > 50)) return false;     // STRIKE jde zamknout jen v tréninku
    if (a === "ult") return f.focus >= 100;
    if (f.cd[a] > 0) return false;
    return f.sta >= (A.sta || 0);
  }
  function allowedReact(f, r) {
    if (f.over || f.phase !== "react" || !hasReact(f.h, r)) return false;
    if (r === "brace") return true;
    if (f.disabled[r] > 0) return false;
    const k = f.intent ? f.intent.k : "";
    if (r === "dodge" && (k === "spell")) return false;
    if (r === "block") return f.sta >= f.h.blockCost;
    if (r === "dodge") return f.sta >= f.h.dodgeCost;                   // v11.3: všechny reakce stojí STAMINU, focus je jen na ultimátku
    if (r === "channel") return f.sta >= REACTS.channel.sta;
    return true;
  }
  function allowed(f, a) { return ATTACKS[a] ? allowedAtk(f, a) : allowedReact(f, a); }

  // ---------- záměr nepřítele (vybírá se AŽ PO tvém útoku)
  const DMG_MECH = { llm: 1, cobol: 1, admin: 1, compliance: 1, "": 1 };
  function pickIntent(f) {
    const e = f.e, R = f.R, p = e.pattern || { atk: 6, heavy: 2, defend: 1 };
    const set = (k, extra) => { f.intent = Object.assign({ k: k, val: 0, shown: k }, extra || {}); f.lastIntent = k; };
    if (f.forceIntent) { const x = f.forceIntent; f.forceIntent = null; set(x.k, x); f.intent.val = intentVal(f, f.intent); return; }
    if (f.estun) { set("stun"); return; }
    if (f.unleashNext) { f.unleashNext = false; set("unleash", { rm: f.rmNext }); f.rmNext = false; return; }
    const fx = forcedIntent(f);
    if (fx) { set(fx.k, fx); return; }
    const chW = f.lastIntent === "unleash" || f.lastIntent === "charge" || f.turn < 2 ? 0 : (p.charge != null ? p.charge : (f.m.kind === "normal" || f.m.kind === "compliance" ? 0 : 1));
    let w = [["charge", chW], ["atk", p.atk || 0], ["heavy", f.lastIntent === "heavy" ? 0 : (p.heavy || 0)], ["defend", f.lastIntent === "defend" ? 0 : (p.defend || 0)], ["special", f.lastIntent === "special" || f.lastIntent === "spell" ? 0 : (p.special || 0)]];
    if (e.mech === "pookie" && (f.turn + 1) % 3 === 0) w = [["flex", 1]];
    if (e.mech === "pookie" && f.lastIntent === "flex") w = [["heavy", 1]];
    const sum = w.reduce((a, x) => a + x[1], 0);
    let r = R() * sum, k = "atk";
    for (const x of w) { if (r < x[1]) { k = x[0]; break; } r -= x[1]; }
    let sub = "";
    if (k === "special") { if (DMG_MECH[e.mech || ""] || !e.mech) { k = "spell"; sub = e.mech || ""; } }
    set(k, { sub: sub });
    if (e.mech === "llm" && R() < 0.3) f.intent.shown = "?";
    else if (f.deceive && (k === "heavy" || k === "atk") && R() < f.deceive) { f.intent.shown = k === "heavy" ? "atk" : "heavy"; f.intent.feint = true; }
    f.intent.val = intentVal(f, f.intent);
  }
  const IMULT = { atk: 1, heavy: 2, spell: 1.4, unleash: 3 };
  function intentVal(f, it) {
    if (it.k === "withdraw") return Math.max(1, Math.round(Math.max(0, f.hp) * 0.2));
    if (!IMULT[it.shown] && !IMULT[it.k]) return 0;
    const m = IMULT[it.shown] || IMULT[it.k];
    const eff = Math.max(f.e.main / 2, f.e.main - f.h.def / 2);
    return Math.round(f.e.wpn * (1 + eff / 10) * m * (1 - f.hArmor) * eMult(f));
  }
  function forcedIntent(f) {
    const m = f.e.mech;
    if (m === "louis") {
      if (f.lastIntent === "siesta") return { k: "heavy" };
      if ((f.turn + 1) % 5 === 0) return { k: "siesta" };
    }
    if (m === "consultant" && f.lastAct) { const mp = { strike: "atk", heavy: "heavy", gamble: "spell", rest: "defend", ult: "charge" }; return { k: mp[f.lastAct] || "atk", sub: "consultant" }; }   // v11.4: kopíruje tvůj poslední útok
    if (m === "italian" && f.pastaPending) { f.pastaPending = false; return { k: "pasta" }; }
    if (m === "polishen" && f.turn % 4 === 0) return { k: "withdraw" };
    if (m === "admin") {
      if (f.restartPending) { f.restartPending = false; return { k: "restart" }; }
      if (f.ehp < f.emax * 0.25 && f.turn % 3 === 0 && f.lastIntent !== "unleash" && f.lastIntent !== "charge") { f.rmNext = true; return { k: "charge", rm: true }; }
    }
    return null;
  }

  // ---------- formuláře (Compliance / Louis / Cobol): udělej X
  const FORM_NO = { strike: "ST-12", heavy: "PW-99", gamble: "GM-7", rest: "RS-0", block: "27-B", dodge: "DG-6", channel: "CH-3", brace: "BR-1" };
  const RED_TAPE_MAX = 6;
  function pickDemand(f) {
    const m = f.e.mech;
    // v11.1: na začátku kola se smí chtít jen ÚTOK (reakce se chce až po telegrafu, viz demandReact)
    if (m === "louis") { if (!(f.turn > 0 && f.R() < 0.3)) { f.demand = null; return; } }
    else if (m === "auditor") { if (f.R() < 0.1) { f.demand = null; return; } }            // v11.4: weekly Auditor chce skoro každé kolo
    else if (m !== "compliance" || f.R() < 0.4) { f.demand = null; return; }
    const pool = ["strike", "heavy", "gamble", "rest"].filter(a => a !== f.demand && !(f.disabled[a] > 0) && !(f.cd[a] > 0) && f.sta >= (ATTACKS[a].sta || 0));
    f.demand = pool.length ? pool[Math.floor(f.R() * pool.length)] : "strike";
  }
  /** po telegrafu (jen když se opravdu reaguje): Compliance chce reakci, kterou zrovna můžeš udělat; Cobol nabízí bryndzu (BREATHE) */
  function demandReact(f) {
    const m = f.e.mech;
    if (f.demand) return;
    if (m === "cobol") { if (f.R() < 0.3) f.demand = "brace"; return; }
    if (m === "auditor" ? f.R() < 0.3 : (m !== "compliance" || f.R() < 0.5)) return;
    const pool = reactsOf(f.h).filter(x => allowedReact(f, x));
    if (pool.length) f.demand = pool[Math.floor(f.R() * pool.length)];
  }
  function formCheck(f, act, phase) {
    if (!f.demand) return;
    const isAtk = !!ATTACKS[f.demand];
    if ((phase === "atk") !== isAtk) return;
    const e = f.e, d0 = f.demand;
    f.demand = null;
    if (f.bribed && act !== d0) {
      f.bribed = false; f.st.forms++; if (f.redTape > 0) f.redTape--;
      ev(f, "form", { ok: true, a: d0, val: 0, no: FORM_NO[d0], tape: f.redTape, txt: "💼 The auditor pockets the envelope. FORM " + FORM_NO[d0] + " approved, no questions asked." });
    } else if (act === d0) {
      f.bribed = false; f.st.forms++;
      const r = rawHit(f.R, f.h, f.e, { mult: 0.7, ignoreArmor: true, crit: false });
      const d = hurtEnemy(f, r.v);
      if (f.redTape > 0) f.redTape--;
      const txt = e.mech === "cobol" ? "🥟 \"Do you want a bryndza?\" - \"Yes, thanks!\" He is happy. Bonus hit for <b>" + d + "</b>"
        : e.mech === "louis" ? "👑 SUPREME DECREE obeyed (" + ACTIONS[act].name + ") - bonus hit for <b>" + d + "</b>" : "";
      ev(f, "form", { ok: true, a: act, val: d, no: FORM_NO[act], tape: f.redTape, txt: txt });
    } else {
      f.redTape = Math.min(RED_TAPE_MAX, f.redTape + 1);
      if (e.mech === "cobol") f.rage = 2;
      const txt = e.mech === "cobol" ? "🥟 You refused the bryndza! He is offended: <b>+30% damage for 2 rounds</b> · RED TAPE ×" + f.redTape
        : e.mech === "louis" ? "👑 You ignored the SUPREME DECREE (" + ACTIONS[d0].name + ") - <b>RED TAPE ×" + f.redTape + "</b>" : "";
      ev(f, "form", { ok: false, a: d0, no: FORM_NO[d0], tape: f.redTape, txt: txt });
    }
  }

  // ---------- zásahy
  const BREAK_RES = { boss: 0.65, secret: 0.65, world: 0.65, mini: 0.85, elite: 0.85 };
  function addBreak(f, n) {
    if (f.over || f.estun) return;
    n *= 1 + ((f.h.perks || {}).breakBonus || 0);
    f.brk = Math.min(100, f.brk + n * (BREAK_RES[f.m.kind] || 1) * (f.unleashNext ? 1.6 : 1));
  }
  function hurtEnemy(f, dmg) {
    const P = f.h.perks || {};
    dmg = Math.max(0, Math.round(dmg));
    const s = Math.min(f.eshield, dmg); f.eshield -= s;
    f.ehp -= dmg - s;
    if (dmg > 0 && (f.h.lifesteal || P.vamp)) { const hh = Math.round(dmg * ((f.h.lifesteal || 0) + (P.vamp || 0)) * healMul(f)); if (hh > 0) { f.hp = Math.min(f.h.maxHp, f.hp + hh); f.lsAcc = (f.lsAcc || 0) + hh; } }
    if (dmg > f.st.maxHit) f.st.maxHit = dmg;
    return dmg;
  }
  /** násobky tvých ran (stav boje) */
  function myMult(f, kind, perfect) {
    let m = (1 + f.coin) * (1 - 0.08 * f.redTape) * (f.payroll > 0 ? 0.75 : 1) * (f.marked ? 1 + (f.h.mark || 0) : 1);
    if (f.vuln) m *= 1.5;
    if (f.firstHit) m *= 2;
    if (f.channel) m *= f.channel;
    if (f.siesta) m *= 1.5;
    if (f.eguard && kind !== "heavy" && kind !== "ult") m *= 0.4;
    if (f.e.mech === "great_i" && f.form === "l" && kind !== "heavy") m *= 0.6;
    if (f.flamenco > 0 && !(kind === "heavy" && perfect)) m *= 0.5;
    return m;
  }
  function consumeBuffs(f) { f.vuln = false; f.firstHit = false; f.channel = 0; f.siesta = false; }
  /** tvoje rána: vrací {val, crit} */
  function myHit(f, mult, o) {
    o = o || {};
    const sure = (f.sureCrit || f._sa) && o.crit !== false; if (sure && !f._sa) f.sureCrit = false;
    const r = rawHit(f.R, f.h, f.e, { mult: mult, ignoreArmor: o.ignoreArmor, crit: sure ? true : o.crit, critMul: o.critMul, critAdd: o.critAdd });
    if (r.crit) { f.st.crits++; f.focus = Math.min(100, f.focus + 8); }
    let v0 = r.v;
    if (f.eshieldP > 0 && o.crit !== false) {                         // v11.4: CEO - rozpočtový štít; plně ho láme jen HEAVY a ULTI
      const eff = f._kind === "heavy" || f._kind === "ult" ? 1 : 0.25, toS = v0 * eff;
      if (toS >= f.eshieldP) { v0 = Math.round((toS - f.eshieldP) / eff); f.eshieldP = 0; ev(f, "mech", { msg: "💼 BUDGET SHIELD broken!" }); }
      else { f.eshieldP = Math.round(f.eshieldP - toS); v0 = 0; }
    }
    if (f.mana > 0 && o.crit !== false) { v0 += f.mana; ev(f, "mech", { msg: "🔮 Mana release: +" + f.mana + " damage" }); f.mana = 0; }
    const val = hurtEnemy(f, v0);
    if (f.bm > 0 && val > 0 && o.crit !== false) { f.bm--; const hh = Math.round(Math.min(Math.round(f.h.maxHp * 0.08), Math.round(val * 0.25)) * healMul(f)); f.hp = Math.min(f.h.maxHp, f.hp + hh); ev(f, "mech", { msg: "🩸 Blood Magic: +" + hh + " HP" + (f.bm ? " (" + f.bm + " left)" : "") }); }
    if (f.eguard && f.e.ecls === "firewall" && val > 0) { const d = hurtHero(f, val * 0.2, "reflect"); ev(f, "mech", { msg: "🧱 The Firewall reflects " + d + " damage back at you." }); }
    return { val: val, crit: r.crit };
  }

  /** v11.7: týdenní boss - každé kolo +10 % (násobí se), tvoje léčení a štíty -3 % za kolo (max -90 %) */
  function healMul(f) { return f.m && f.m.kind === "world" ? Math.max(0.1, 1 - 0.03 * f.turn) : 1; }
  function eMult(f) { let m = f.m && f.m.kind === "world" ? Math.pow(1.1, f.turn) : 1; if (f.e.mech === "pookie") m *= 1 + 0.05 * f.estacks; if (f.rage > 0) m *= 1.3; if (f.mgr) m *= 1 + 0.12 * f.mgr; return m; }
  function hurtHero(f, dmg, src) {
    const P = f.h.perks || {};
    if (f.h.dr && src !== "backfire" && src !== "withdraw") dmg *= 1 - f.h.dr;
    if (f.fort > 0 && src !== "backfire" && src !== "poison" && src !== "withdraw") dmg *= 0.8;
    if (f.halfNext && src !== "backfire" && src !== "poison" && src !== "reflect" && dmg > 0) { f.halfNext = false; dmg *= 0.5; }
    dmg = Math.max(0, Math.round(dmg));
    const s = Math.min(f.shield, dmg); f.shield -= s;
    f.hp -= dmg - s;
    if (dmg > 0) f.focus = Math.min(100, f.focus + 8);
    if (P.thorns && src !== "backfire" && dmg - s > 0) f.ehp -= Math.round((dmg - s) * P.thorns);
    if (f.hp <= 0 && f.h.revive && !f.revived) { f.revived = true; if (f.R() < f.h.revive) { f.hp = Math.round(f.h.maxHp * 0.3); ev(f, "revive", { val: f.hp, src: "blood" }); } }
    if (f.hp <= 0 && P.duck && !f.duckUsed) { f.duckUsed = true; f.hp = 1; ev(f, "revive", { val: 1, src: "duck" }); }
    ev(f, "hhit", { val: dmg, absorbed: s, src: src });
    return dmg;
  }

  // ---------- GAMBLE (válce)
  function spinReels(f) {
    const L = f.h.luckReel || 0;
    const w = REELS.map(([s, x]) => [s, s === "💀" ? Math.max(4, x - L * 0.3) : s === "7️⃣" ? x + L * 0.15 : s === "⭐" ? x + L * 0.1 : x]);
    const sum = w.reduce((a, x) => a + x[1], 0);
    const one = () => { let r = f.R() * sum; for (const x of w) { if (r < x[1]) return x[0]; r -= x[1]; } return "🍒"; };
    return [one(), one(), one()];
  }
  const SYM = { "🍒": { m: 0.2, heal: 0.06 }, "🔔": { m: 0.3, brk: 12 }, "⭐": { m: 0.3, foc: 14 }, "7️⃣": { m: 0.75 }, "💀": { m: 0, self: 0.25 } };
  const RESPIN_STA = 10;
  function reelResult(r, opt) {
    opt = opt || {};
    const c = {}; r.forEach(s => { c[s] = (c[s] || 0) + 1; });
    if (opt.wildCherry && c["🍒"]) {
      const best = Object.keys(c).filter(s => s !== "🍒" && s !== "💀").sort((a, b) => c[b] - c[a] || (SYM[b].m - SYM[a].m))[0];
      if (best) { c[best] += c["🍒"]; delete c["🍒"]; }
    }
    if (c["7️⃣"] === 3) return { mult: 6, txt: "JACKPOT", jp: true, heal: 0, brk: 30, foc: 20, self: 0 };
    if (c["💀"] === 3) return { mult: 0, txt: "BACKFIRE", bf: true, heal: 0, brk: 0, foc: 0, self: 0.9 };
    if (c["⭐"] === 3) return { mult: 3.5, txt: "STARS", heal: 0.15, brk: 15, foc: 60, self: 0 };
    if (c["🔔"] === 3) return { mult: 3, txt: "BELLS", heal: 0, brk: 70, foc: 10, self: 0 };
    if (c["🍒"] === 3) return { mult: 2.2, txt: "CHERRIES", heal: 0.3, brk: 10, foc: 10, self: 0 };
    let mult = 0, heal = 0, brk = 0, foc = 0, self = 0;
    Object.keys(c).forEach(s => { const x = SYM[s], n = c[s]; mult += x.m * n; heal += (x.heal || 0) * n; brk += (x.brk || 0) * n; foc += (x.foc || 0) * n; self += (x.self || 0) * n; });
    const pair = Object.keys(c).find(s => c[s] === 2 && s !== "💀");
    if (pair) mult += 0.4;
    if (c["🍒"] === 2) heal = 0.15;                                     // v11.2: pár třešní = 15 % HP
    const txt = c["💀"] === 2 ? "two skulls" : pair ? "pair " + pair + pair : "mixed";
    return { mult: Math.round(mult * 100) / 100, txt: txt, heal: heal, brk: brk, foc: foc, self: self, critAdd: c["7️⃣"] === 2 ? 0.2 : 0 };
  }
  function gambleRoll(f) { f.gReels = spinReels(f); f.gRespun = false; return f.gReels.slice(); }
  function canRespin(f) { return !!f.gReels && !f.gRespun && f.sta >= ATTACKS.gamble.sta + RESPIN_STA; }
  function gambleRespin(f, hold) {
    if (!canRespin(f)) return null;
    const fresh = spinReels(f);
    f.gReels = f.gReels.map((s, i) => hold && hold[i] ? s : fresh[i]);
    f.gRespun = true; f.sta -= RESPIN_STA; f.st.respins = (f.st.respins || 0) + 1;
    return f.gReels.slice();
  }
  function autoHold(r) {
    const c = {}; r.forEach(s => { c[s] = (c[s] || 0) + 1; });
    const keep = Object.keys(c).find(s => c[s] >= 2 && s !== "💀") || (c["7️⃣"] ? "7️⃣" : null);
    return r.map(s => s === keep);
  }
  function useItem() { return null; }

  // ================================================================== 1) TVŮJ ÚTOK
  /** opt: { t: "perfect"|"good"|"none" (HEAVY timing), q: 0.7-1.25 (síla ulti z mini-hry), all: EXPLOIT plný break, assist: rána kolegy } */
  function attack(f, a, opt) {
    if (f.over || f.phase !== "atk") return [];
    opt = opt && typeof opt === "object" ? opt : { t: opt };
    if (!allowedAtk(f, a)) a = "strike";
    const start = f.events.length, h = f.h, e = f.e, R = f.R, A = ATTACKS[a];
    if (opt.assist > 0) {
      const d = hurtEnemy(f, opt.assist); ev(f, "assist", { val: d, who: String(opt.assistName || "Your colleague") });
      if (f.ehp <= 0) return finish(f, true, start);
    }
    f.turn++;
    if (f.stunNext) { f.stunNext = false; f.estun = true; }
    if (e.mech === "polishen" && f.lastAct === a && a !== "strike") { f.redTape = Math.min(RED_TAPE_MAX, f.redTape + 1); ev(f, "mech", { msg: "🇵🇱 AUDIT: " + A.name + " twice in a row? That's a deduction. RED TAPE ×" + f.redTape }); }
    if (e.mech === "serverroom" && a !== "rest") {                     // v11.4: Server Room - stejný útok za sebou přehřívá
      f.heat = a === f.heatLast ? f.heat + 1 : Math.max(0, f.heat - 1); f.heatLast = a;
      if (f.heat >= 2) { const d0 = hurtHero(f, h.maxHp * 0.06, "heat"); ev(f, "mech", { msg: "🔥 OVERHEATING! " + A.name + " again? The rack burns you for " + d0 + " - switch it up." }); }
    }
    f.lastAct = a; f._kind = a;
    formCheck(f, a, "atk");
    if (f.ehp <= 0) return finish(f, true, start);
    f.sta -= A.sta || 0;
    const q = clamp(opt.q == null ? 1 : Number(opt.q) || 0.7, 0.7, 1.25);
    const wasGuard = f.eguard;
    f._sa = f.sureAtk > 0 && a !== "rest"; if (f._sa) f.sureAtk--;
    if (a === "strike") {
      const m = myMult(f, "strike");
      if (h.double) {
        const r1 = myHit(f, 0.6 * m), r2 = myHit(f, 0.6 * m);
        ev(f, "pact", { a: a, val: r1.val + r2.val, crit: r1.crit || r2.crit, hits: [r1.val, r2.val] });
      } else { const r = myHit(f, m); ev(f, "pact", { a: a, val: r.val, crit: r.crit }); }
      consumeBuffs(f); f.marked = f.marked || !!h.mark;
      f.focus = Math.min(100, f.focus + 5); f.sta = Math.min(h.staMax, f.sta + A.gain);
      addBreak(f, A.brk * (f.eguard ? 0.5 : 1));
    } else if (a === "rest") {
      f.sta = Math.min(h.staMax, f.sta + A.gain); f.focus = Math.min(100, f.focus + 15);
      const cured = f.poison > 0; f.poison = 0;
      ev(f, "rest", { cured: cured });
    } else if (a === "heavy") {
      if (!(f.nocd > 0)) f.cd.heavy = A.cd + 1;
      const tm = opt.t === "perfect" ? "PERFECT" : opt.t === "good" ? "GOOD" : opt.t === "auto" ? "" : "";
      const base = opt.t === "perfect" ? 2.2 : opt.t === "good" ? 1.7 : opt.t === "auto" ? 1.7 : 1.3;
      if (tm === "PERFECT") f.st.perfectPower++;
      let m = base * myMult(f, "heavy", tm === "PERFECT");
      if (tm === "PERFECT" && e.mech === "italian") { m *= 1.2; ev(f, "mech", { msg: "🤌 \"Perfetto! Al dente!\" (+20% damage)" }); }
      let val = 0, crit = false;
      let hits = null;
      if (h.double) { const r1 = myHit(f, 0.6 * m), r2 = myHit(f, 0.6 * m); val = r1.val + r2.val; crit = r1.crit || r2.crit; hits = [r1.val, r2.val]; }
      else { const r = myHit(f, m); val = r.val; crit = r.crit; }
      consumeBuffs(f); f.marked = f.marked || !!h.mark;
      f.focus = Math.min(100, f.focus + 4);
      ev(f, "pact", { a: a, val: val, crit: crit, timing: tm, hits: hits });
      addBreak(f, A.brk * (tm === "PERFECT" ? 1.4 : tm === "GOOD" ? 1.2 : 1) + (wasGuard ? 15 : 0));
      if (wasGuard) ev(f, "mech", { msg: "💥 Guard broken! The HEAVY went straight through." });
      if (f.unleashNext) { f.unleashNext = false; f.rmNext = false; f.estun = true; f.st.breaks++; ev(f, "interrupt", {}); }
      if (f.adds > 0) { f.adds--; ev(f, "mech", { msg: "📇 Your HEAVY sends an intern home (" + f.adds + " left)." }); }
      if (e.mech === "ransom" && Object.keys(f.disabled).length) { f.disabled = {}; ev(f, "mech", { msg: "Decrypted! All actions available again." }); }
    } else if (a === "gamble") {
      f.st.usedGamble++;
      const P = h.perks || {};
      const reels = f.gReels || spinReels(f), respun = !!f.gRespun;
      f.gReels = null; f.gRespun = false;
      let res = reelResult(reels, { wildCherry: !!(P.wildCherry || h.wildCherry) });
      if (res.bf && P.noBackfire) { res = reelResult(["7️⃣", "7️⃣", "🍒"]); res.txt = "pair (Rubber Gloves)"; }
      if (P.noBackfire) res.self = 0;
      if (res.bf) { const self = hurtHero(f, f.h.atk * res.self, "backfire"); ev(f, "gamble", { reels: reels, res: res.txt, val: 0, self: self, bf: true, respun: respun }); }
      else {
        let d = 0, c = false;
        if (res.mult > 0) { const r = myHit(f, res.mult * myMult(f, "gamble"), { crit: res.jp ? true : undefined, critAdd: res.critAdd }); d = r.val; c = r.crit; consumeBuffs(f); }
        if (res.jp) f.st.jackpots++;
        addBreak(f, 9 * Math.min(res.mult, 3) + res.brk);
        let hh = 0;
        if (res.heal) { hh = Math.round(h.maxHp * res.heal * healMul(f)); f.hp = Math.min(h.maxHp, f.hp + hh); }
        const self = res.self > 0 ? hurtHero(f, f.h.atk * res.self, "backfire") : 0;
        f.focus = Math.min(100, f.focus + 6 + res.foc);
        ev(f, "gamble", { reels: reels, res: res.txt, val: d, crit: c, jp: !!res.jp, mult: res.mult, heal: hh, brk: Math.round(res.brk), foc: res.foc, self: self, respun: respun });
      }
    } else if (a === "ult") {
      f.focus = 0; f.st.usedSkill++;
      if (f.adds > 0) { f.adds = 0; ev(f, "mech", { msg: "📇 Your ultimate clears out every intern!" }); }
      const pct = Math.round(q * 100), cls = h.cls, C = CLASSES[cls];
      if (cls === "sysadmin") {
        const sh = Math.round(h.maxHp * 0.3 * q * healMul(f)), hh = Math.round(h.maxHp * 0.05 * q * healMul(f));
        f.shield += sh; f.hp = Math.min(h.maxHp, f.hp + hh);
        const r = myHit(f, 1.4 * q * myMult(f, "ult")); consumeBuffs(f); addBreak(f, 20 * q);
        ev(f, "skill", { a: C.skill, q: q, val: r.val, crit: r.crit, msg: "Firewall up (" + pct + "%)! Shield bash for " + r.val + ", +" + sh + " shield, +" + hh + " HP" });
      } else if (cls === "engineer") {
        const r = myHit(f, 3.2 * q * myMult(f, "ult"), { critMul: 2 }); consumeBuffs(f);
        addBreak(f, 50 * q); ev(f, "skill", { a: C.skill, q: q, val: r.val, crit: r.crit, msg: "Deployed at " + pct + "% - pushed straight to production for " + r.val + (r.crit ? " - CRIT!" : "") });
      } else if (cls === "cyber") {
        const r = myHit(f, 2.8 * q * myMult(f, "ult"), { ignoreArmor: true }); consumeBuffs(f);
        f.estacks = 0; f.eshield = 0; f.rage = 0; f.flamenco = 0; f.disabled = {}; f.eguard = false;
        const all = opt.all == null ? true : !!opt.all;
        if (all) f.brk = 100; else addBreak(f, 50);
        ev(f, "skill", { a: C.skill, q: q, val: r.val, crit: r.crit, msg: "Backdoor (" + pct + "%) for " + r.val + " - enemy buffs wiped" + (all ? " and its defences BROKEN" : "") });
      } else if (cls === "blood") {
        const r = myHit(f, 2.6 * q * myMult(f, "ult")); consumeBuffs(f);
        const hh = Math.round(r.val * 0.6 * healMul(f)); f.hp = Math.min(h.maxHp, f.hp + hh); addBreak(f, 35 * q);
        ev(f, "skill", { a: C.skill, q: q, val: r.val, crit: r.crit, heal: hh, msg: "Double espresso (" + pct + "%) for " + r.val + " - the caffeine gives you " + hh + " HP" });
      } else {
        let sum = 0, crits = 0; const m = myMult(f, "ult");
        for (let i = 0; i < 4; i++) { const r = myHit(f, 0.9 * q * m); sum += r.val; if (r.crit) crits++; }
        consumeBuffs(f); f.marked = true; addBreak(f, 45 * q);
        ev(f, "skill", { a: C.skill, q: q, val: sum, crit: crits > 0, msg: "Headhunt (" + pct + "%): 4 arrows for " + sum + (crits ? " - " + crits + " crit" + (crits > 1 ? "s" : "") : "") });
      }
    }
    f._sa = false;
    f.eguard = false;
    if (f.coinTurns > 0 && --f.coinTurns === 0) f.coin = 0;
    if (f.ehp <= 0) return finish(f, true, start);
    if (f.brk >= 100 && !f.estun) {
      f.brk = 0; f.st.breaks++; f.vuln = true; f.estun = true; f.unleashNext = false; f.rmNext = false; f.mgr = 0; f.adds = 0;
      ev(f, "break", {});
    }
    // ---------- nepřítel ukáže, co chystá
    pickIntent(f);
    ev(f, "telegraph", { k: f.intent.k, shown: f.intent.shown, val: f.intent.val });
    if (a === "ult" && opt.guess) {                                       // v11.6: tip u KAŽDÉ ulti - první trefa plný efekt, další poloviční
      const real = f.intent.k === "stun" ? opt.guess : guessCat(f.intent.k), ok = real === opt.guess, half = !!f.guessUsed;
      if (ok) { guessFx(f, half ? 0.5 : 1); f.guessUsed = true; }
      ev(f, "guess", { ok: ok, g: opt.guess, real: real, fx: ok ? GUESS_FX[h.cls].n + (half ? " (half)" : "") : "" });
    }
    if (!isDmgIntent(f.intent.k)) { enemyAct(f, "none", {}); endRound(f); return f.events.slice(start); }
    f.phase = "react";
    demandReact(f);
    return f.events.slice(start);
  }

  function guessFx(f, k) {
    const h = f.h; k = k || 1;
    if (h.cls === "engineer") f.bm = Math.max(f.bm, Math.round(3 * k));
    else if (h.cls === "sysadmin") { f.shield += Math.round(h.maxHp * 0.2 * k); f.halfNext = true; }
    else if (h.cls === "cyber") f.epoison = Math.max(f.epoison, Math.round(3 * k));
    else if (h.cls === "hunter") f.sureAtk = Math.max(f.sureAtk, Math.round(2 * k));
    else { f.sta = Math.min(h.staMax, f.sta + Math.round(40 * k)); f.nocd = Math.max(f.nocd, Math.round(2 * k)); delete f.cd.heavy; }
    ev(f, "mech", { msg: GUESS_FX[h.cls].n + "! " + GUESS_FX[h.cls].t.charAt(0).toUpperCase() + GUESS_FX[h.cls].t.slice(1) + "." });
  }
  // ================================================================== 2) TVOJE REAKCE
  /** opt: { parry: "perfect"|"good"|"none" (BLOCK proti HEAVY / UNLEASH / WITHDRAWAL), rings: [..] UNLEASH 3 kroužky } */
  function react(f, r, opt) {
    if (f.over || f.phase !== "react") return [];
    opt = opt && typeof opt === "object" ? opt : { parry: opt };
    if (!allowedReact(f, r)) r = "brace";
    const start = f.events.length;
    formCheck(f, r, "react");
    if (f.ehp <= 0) { f.phase = "atk"; return finish(f, true, start); }
    if (r === "block") f.sta -= f.h.blockCost;
    if (r === "dodge") f.sta -= f.h.dodgeCost;
    if (r === "channel") f.sta -= REACTS.channel.sta;
    if (r !== "brace") f.st.usedReact++;
    enemyAct(f, r, opt);
    endRound(f);
    return f.events.slice(start);
  }

  function enemyAct(f, r, opt) {
    const h = f.h, e = f.e, R = f.R, it = f.intent, k = it.k;
    f.phase = "atk";
    if (r === "brace") { f.sta = Math.min(h.staMax, f.sta + 15); f.focus = Math.min(100, f.focus + 10); if (f.poison > 0) { f.poison = 0; ev(f, "mech", { msg: "😮‍💨 You catch your breath - the poison is gone." }); } }
    f.dodgeStreak = r === "dodge" ? f.dodgeStreak + 1 : 0;
    if (it.feint) ev(f, "mech", { msg: "🎭 A FEINT! It showed " + (it.shown === "atk" ? "⚔ ATTACK" : "💥 HEAVY") + " but did " + (k === "atk" ? "⚔ ATTACK" : "💥 HEAVY") + "." });
    if (isDmgIntent(k)) {
      let mult = IMULT[k] || 1;
      if (k === "spell" && it.sub === "llm") mult = 0.5 + R() * 1.4;
      if (k === "spell" && it.sub === "cobol") mult = 1.5;
      if (k === "spell" && it.sub === "admin") mult = 1.5;
      if (k === "spell" && it.sub === "compliance") mult = 1 + 0.15 * f.redTape;
      if (it.sub === "consultant") mult *= 1.15;
      const hit = rawHit(R, e, h, { mult: mult * eMult(f) });
      if (hit.crit) hit.v = Math.round(hit.v * 0.75);                 // nepřátelský crit jen ×1.5
      let dmg = hit.v;                                                  // zbroj hráče už započítal rawHit
      if (k === "withdraw") dmg = Math.max(1, Math.round(Math.max(0, f.hp) * 0.2));
      if (k === "unleash" && it.rm) ev(f, "mech", { msg: "🕶 sudo rm -rf / --no-preserve-root" });
      const src = k === "unleash" ? "heavy" : k === "spell" ? (it.sub === "llm" ? "hallucination" : "spell") : k;
      if (k === "spell" && h.spellImmune) { ev(f, "immune", {}); f.st.reacts++; }
      else if (r === "dodge") {
        const dq = opt.dq === "perfect" ? 1.6 : opt.dq === "good" ? 1.15 : opt.dq === "none" ? 0.4 : 1;          // v11.1: dodge mini-hra
        const ch = opt.dq === "perfect" ? 1 : Math.min(0.95, Math.max(0, f.dodgeCh * dq * Math.pow(0.8, f.dodgeStreak - 1) - 0.04 * f.redTape - (f.slow > 0 ? 0.2 : 0)));   // v11.7: PERFECT dodge = jistý úhyb
        if (R() < ch) {
          f.st.dodges++; f.st.reacts++; f.focus = Math.min(100, f.focus + 5);
          if (h.cls === "cyber") f.sureCrit = true;
          let rip = 0;
          if (opt.dq === "perfect") { rip = myHit(f, 0.5 * myMult(f, "strike"), { crit: false }).val; f.sta = Math.min(h.staMax, f.sta + 10); }   // ↩ RIPOSTE
          ev(f, "dodge", { heavy: k !== "atk", sure: h.cls === "cyber", riposte: rip });
        } else { ev(f, "dodgefail", {}); hitHero(f, dmg, src, k); }
      } else if (r === "block") {
        f.st.usedBlock++;
        let red = h.block * (k === "atk" ? 1 : k === "spell" ? 0.4 : 0.5);
        let tier = "none";
        if (k === "heavy" || k === "unleash" || k === "withdraw") {
          tier = opt.parry || "none";
          if (k === "unleash" && Array.isArray(opt.rings) && opt.rings.length) {
            const rs = opt.rings.slice(0, 3); while (rs.length < 3) rs.push("none");
            tier = rs.every(x => x === "perfect") ? "perfect" : rs.filter(x => x !== "none").length >= 2 ? "good" : "none";
          }
        }
        if (tier === "perfect") {                                       // v11.7: PERFECT parry vezme 75 % (ne všechno) + protiútok + 🛡 FORTIFIED (-20 % na 2 kola)
          f.st.perfectBlocks++; f.st.parries++; f.st.reacts++;
          const taken = hitHero(f, dmg * 0.25, src, k);
          const ctr = myHit(f, (h.cls === "sysadmin" ? 1.0 : 0.6) * myMult(f, "strike"), { crit: false });
          f.focus = Math.min(100, f.focus + 20); f.sta = Math.min(h.staMax, f.sta + 10);
          addBreak(f, 35); f.stunNext = true; f.fort = 2;
          ev(f, "parry", { val: ctr.val, heavy: true, taken: taken });
        } else {
          if (tier === "good") { red = Math.min(0.95, red + 0.35); f.st.perfectBlocks++; f.st.reacts++; }
          if (k === "withdraw" && tier !== "good") red = 0;
          const taken = hitHero(f, dmg * (1 - red), src, k);
          let ctr = 0;
          if (k === "atk" && h.counter) { ctr = myHit(f, h.counter * myMult(f, "strike"), { crit: false }).val; f.st.reacts++; }
          ev(f, tier === "good" ? "perfect" : "block", { val: ctr, saved: Math.round(dmg * red), taken: taken });
        }
      } else {
        if (r === "channel") {                                          // v11.2: CHANNEL mini-hra: -17.5 / 30 / 45 %, další rána ×1.3 (PERFECT ×1.6)
          const cv = chanVal(opt), red = 0.1 + 0.25 * cv, mana = Math.round(dmg * red * (0.5 + 0.5 * cv));      // v11.4: -10 až -35 %, pohlcené damage se uloží jako MANA
          f.channel = 1.35 * (1 + ((h.perks || {}).channelBonus || 0)); f.mana = (f.mana || 0) + mana; f.st.reacts++;
          ev(f, "channel", { cv: Math.round(cv * 100) / 100, red: red, x: f.channel, mana: mana, total: f.mana }); dmg *= 1 - red;
        }
        hitHero(f, dmg, src, k);
      }
      if (k === "spell" && it.sub === "cobol") { f.slow = 2; ev(f, "mech", { msg: "🥟 \"Take a Halušky!\" You're stuffed: -20% dodge for 2 rounds." }); }
    } else if (k === "charge") ev(f, "mech", { msg: "⏳ " + e.name + (it.rm ? " types sudo rm -rf..." : " is CHARGING a 3× UNLEASH for next round!") + " HEAVY next round interrupts it." }), f.unleashNext = true;
    else if (k === "stun") { f.estun = false; ev(f, "mech", { msg: "😵 " + e.name + " is stunned and does nothing!" }); }
    else if (k === "defend") { f.eguard = true; ev(f, "edef", {}); }
    else if (k === "flex") { f.estacks += 2; ev(f, "mech", { msg: "PRE-WORKOUT! The E flexes... HEAVY hit incoming next round!" }); }
    else if (k === "special") special(f);
    else if (k === "siesta") { f.siesta = true; ev(f, "mech", { msg: "😴 SIESTA... zzz. Your next hit deals +50%. He wakes up grumpy - HEAVY next round!" }); }
    else if (k === "pasta") { const hh = Math.round(f.emax * 0.2); f.ehp = Math.min(f.emax, f.ehp + hh); ev(f, "eheal", { val: hh }); ev(f, "mech", { msg: "🍝 PASTA BREAK! \"First we eat, then we fight.\" +" + hh + " HP" }); }
    else if (k === "restart") { const hh = Math.round(f.emax * 0.2); f.ehp = Math.min(f.emax, f.ehp + hh); f.shield = 0; f.vuln = false; f.channel = 0; ev(f, "eheal", { val: hh }); ev(f, "mech", { msg: "🔄 FORCE RESTART! The Administrator reboots: +" + hh + " HP and your buffs are gone." }); }
    if (k !== "stun") f.estun = false;
  }
  function hitHero(f, dmg, src, k) {
    if (k === "withdraw") { const d = hurtHero(f, dmg, "withdraw"); f.ehp = Math.min(f.emax, f.ehp + d); ev(f, "mech", { msg: "💸 \"The withdrawal from your life.\" She takes " + d + " HP and keeps it." }); return d; }
    const ec = f.e.ecls;
    let d = 0;
    if (ec === "swarm") { d = hurtHero(f, dmg * 0.55, src) + hurtHero(f, dmg * 0.55, src); }
    else d = hurtHero(f, dmg, src);
    if (d > 0 && ec === "virus" && f.hp > 0) { if (!f.poison) ev(f, "mech", { msg: "🦠 Infected! You lose 4% HP for 2 rounds - BREATHE cures it." }); f.poison = 2; }
    if (d > 0 && ec === "leech") { const hh = Math.round(d * 0.3); f.ehp = Math.min(f.emax, f.ehp + hh); ev(f, "eheal", { val: hh }); }
    return d;
  }
  function special(f) {
    const e = f.e, R = f.R;
    const pool = (list) => list.filter(a => !f.disabled[a] && (ATTACKS[a] || hasReact(f.h, a)));
    switch (e.mech) {
      case "heal": { const h = Math.round(f.emax * 0.12); f.ehp = Math.min(f.emax, f.ehp + h); ev(f, "eheal", { val: h }); break; }
      case "drain": { const d = Math.min(f.sta, 25); f.sta -= d; const d2 = Math.min(f.focus, 15); f.focus -= d2; ev(f, "mech", { msg: "Drains " + d + " stamina and " + d2 + " focus!" }); break; }
      case "ransom": case "audit": {
        const p = pool(["heavy", "gamble", "block", "dodge", "channel"]); if (!p.length) break;
        const a = p[Math.floor(R() * p.length)]; f.disabled[a] = 2;
        ev(f, "mech", { msg: (e.mech === "ransom" ? "ENCRYPTED: " : "AUDITED: ") + ACTIONS[a].name + " is disabled for 2 rounds!" + (e.mech === "ransom" ? " (a HEAVY hit decrypts)" : "") });
        break;
      }
      case "great_i": { f.form = f.form === "I" ? "l" : "I"; ev(f, "mech", { msg: f.form === "l" ? "Identity crisis! The Great \"I\" turns into a lowercase \"l\" - your hits deal 40% less (HEAVY still lands)." : "It's a capital \"I\" again." }); break; }
      case "massi": { const h = Math.round(f.h.maxHp * 0.12); f.hp = Math.min(f.h.maxHp, f.hp + h); ev(f, "mech", { msg: "The Big Massi approves your PTO. You heal " + h + ". Best boss ever." }); break; }
      case "italian": { const p = pool(["heavy", "gamble", "dodge", "block"]); if (p.length) { const a = p[Math.floor(R() * p.length)]; f.disabled[a] = 2; ev(f, "mech", { msg: "🍝 SPAGHETTI CODE! " + ACTIONS[a].name + " is tangled up for a round." }); } break; }
      case "louis": { f.flamenco = 2; ev(f, "mech", { msg: "💃 FLAMENCO! The Supreme Louis dances around: your hits deal half damage for 2 rounds (a PERFECT HEAVY always lands in full)." }); break; }
      case "polishen": { f.payroll = 2; ev(f, "mech", { msg: "🧾 PAYROLL CUT! -25% damage for 2 rounds." }); break; }
      default: ev(f, "mech", { msg: e.name + " does something weird." });
    }
  }
  function endRound(f) {
    const h = f.h, e = f.e;
    f.sta = Math.min(h.staMax, f.sta + (h.staGain || 0));          // v11.1: stamina se sama NEDOPLŇUJE (STRIKE +10, BREATHE +30 / +15)
    f.focus = Math.min(100, f.focus + 10);
    if (e.mech === "recruiter" && f.ehp > 0) {
      if (f.adds > 0) { const hh = Math.round(Math.min(f.emax * 0.02, h.atk * 0.5) * f.adds); f.ehp = Math.min(f.emax, f.ehp + hh); ev(f, "eheal", { val: hh }); }
      if (f.turn % 3 === 0 && f.adds < 3 && !f.estun) { f.adds++; ev(f, "mech", { msg: "📇 The Recruiter hires an intern (" + f.adds + "/3) - each one heals it 2% per round. HEAVY sends one home, ULTIMATE or a BREAK all of them." }); }
    }
    if (e.mech === "ceo" && f.turn % 4 === 1 && f.turn > 1 && !f.eshieldP) { f.eshieldP = Math.round(Math.min(f.emax * 0.12, h.atk * 4)); ev(f, "mech", { msg: "💼 BUDGET SHIELD (" + f.eshieldP + "): only HEAVY and ULTIMATE break it at full strength." }); }
    if (e.mech === "serverroom" && f.turn % 4 === 0) { const d0 = Math.min(f.sta, 15); f.sta -= d0; ev(f, "mech", { msg: "🌀 FAN FAILURE: the heat drains " + d0 + " stamina." }); }
    if (f.epoison > 0 && f.ehp > 0) { f.epoison--; const d = hurtEnemy(f, Math.min(f.emax * 0.04, h.atk * 1.5)); ev(f, "mech", { msg: "🦠 Infection: -" + d + " HP to " + e.name }); }
    if (f.nocd > 0) f.nocd--;
    if (f.fort > 0) f.fort--;
    if (f.poison > 0 && f.hp > 0) { f.poison--; const d = hurtHero(f, h.maxHp * 0.04, "poison"); ev(f, "mech", { msg: "🦠 Poison: -" + d + " HP" }); }
    if (e.ecls === "manager" && f.turn % 3 === 0 && !f.estun) { f.mgr = (f.mgr || 0) + 1; ev(f, "mech", { msg: "📈 \"Let's go team!\" The Manager motivates itself: +" + 12 * f.mgr + "% damage (BREAK it to reset)." }); }
    const P = h.perks || {};
    if (P.regen && f.hp > 0) f.hp = Math.min(h.maxHp, f.hp + Math.round(h.maxHp * P.regen));
    Object.keys(f.disabled).forEach(a => { if (--f.disabled[a] <= 0) delete f.disabled[a]; });
    Object.keys(f.cd).forEach(a => { if (--f.cd[a] <= 0) delete f.cd[a]; });
    ["flamenco", "slow", "rage", "payroll"].forEach(k => { if (f[k] > 0) f[k]--; });
    if (e.mech === "italian" && !f.phase2 && f.ehp > 0 && f.ehp < f.emax * 0.5) { f.phase2 = true; f.pastaPending = true; ev(f, "mech", { msg: "🍝 The Italian Guy is getting hungry... PASTA BREAK next round! BREAK him (fill the bar) to stop it." }); }
    if (e.mech === "cobol" && f.turn % 5 === 0) {
      if (f.estun) ev(f, "mech", { msg: "🖥 LEGACY CODE crashed - you broke it before it could recover." });
      else { const hh = Math.round(f.emax * 0.08); f.ehp = Math.min(f.emax, f.ehp + hh); ev(f, "eheal", { val: hh }); ev(f, "mech", { msg: "🖥 LEGACY CODE: \"It still runs.\" +" + hh + " HP (BREAK him to stop it)" }); }
    }
    if (e.mech === "admin") {
      if (!f.phase2 && f.ehp > 0 && f.ehp < f.emax * 0.5) { f.phase2 = true; f.restartPending = true; ev(f, "mech", { msg: "🔄 The Administrator is preparing a FORCE RESTART! BREAK him to cancel it." }); }
      const p = ["heavy", "gamble", "dodge", "block", "channel"].filter(a => !f.disabled[a] && (ATTACKS[a] || hasReact(h, a)));
      if (p.length) { const a = p[Math.floor(f.R() * p.length)]; f.disabled[a] = 1; ev(f, "mech", { msg: "🕶 ROOT ACCESS: " + ACTIONS[a].name + " - permission denied next round." }); }
    }
    if (e.mech === "pookie") { f.estacks++; if (f.turn % 2 === 0) ev(f, "mech", { msg: ["\"Do you even lift, bro?\"", "\"It's not fat, it's BULK.\"", "🤘 BLAST BEAT! 🤘", "\"Skip leg day? NEVER.\"", "\"Protein shake break? No. MORE METAL.\""][(f.turn / 2) % 5] }); }
    if (e.mech === "massi" && !f.phase2 && f.ehp < f.emax * 0.5) { f.phase2 = true; e.wpn *= 1.3; const hh = Math.round(f.emax * 0.15); f.ehp += hh; ev(f, "mech", { msg: "EXECUTIVE OVERRIDE! The Big Massi restructures: +" + hh + " HP, +30% damage." }); }
    if (e.mech === "audit_final") {
      const p = ["heavy", "gamble", "dodge", "block", "channel"].filter(a => !f.disabled[a] && (ATTACKS[a] || hasReact(h, a)));
      if (p.length) { const a = p[Math.floor(f.R() * p.length)]; f.disabled[a] = 1; ev(f, "mech", { msg: "AUDIT FINDING: " + ACTIONS[a].name + " is not compliant next round." }); }
    }
    pickDemand(f);
    if (f.hp <= 0) return finish(f, false, 0);
    if (f.ehp <= 0) return finish(f, true, 0);
    if (f.m.survive && f.turn >= f.m.survive) { ev(f, "mech", { msg: f.m.surviveMsg || "You survived!" }); return finish(f, true, 0); }
    if (f.m.turnLimit && f.turn >= f.m.turnLimit) { ev(f, "mech", { msg: "Out of time!" }); return finish(f, false, 0); }
    if (f.turn >= 60) return finish(f, false, 0);
  }
  function finish(f, win, start) {
    if (f.over) return f.events.slice(start);
    f.over = true; f.win = win; f.hp = Math.max(0, f.hp); f.ehp = Math.max(0, f.ehp); f.phase = "done";
    ev(f, win ? "win" : "lose", {});
    return f.events.slice(start);
  }

  /** kompatibilita: jeden "tah" = útok (+ automatická reakce) */
  function step(f, a, opt) {
    if (ATTACKS[a]) { const evs = attack(f, a, opt); if (!f.over && f.phase === "react") return evs.concat(react(f, autoReact(f, f.R), {})); return evs; }
    return react(f, a, opt);
  }

  // ------------------------------------------------------------------ HVĚZDY: 1 výhra · 2 výhra s 50 %+ HP · 4 bonus NEBO výhra do 4 kol
  const QUICK_WIN = 4;
  function starMask(f) { if (!f.win) return 0; let m = 1; if (f.hp >= f.h.maxHp * 0.5) m |= 2; if (bonusDone(f) || f.turn <= QUICK_WIN) m |= 4; return m; }
  function starCount(m) { return (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1); }
  function stars(f) { return starCount(starMask(f)); }
  function bonusDone(f) {
    const b = f.m.bonus || {}, st = f.st;
    switch (b.type) {
      case "turns": return f.turn <= b.n;
      case "noGamble": return st.usedGamble === 0;
      case "noItem": return true;
      case "noBlock": return st.usedReact === 0;
      case "perfectBlock": return st.reacts >= (b.n || 1) + 1;
      case "jackpot": return st.jackpots >= 1;
      case "hp": return f.hp >= f.h.maxHp * b.pct / 100;
      case "skill": return st.usedSkill >= 1;
      case "perfectPower": return st.perfectPower >= (b.n || 1);
      case "crits": return st.crits >= (b.n || 1);
      default: return true;
    }
  }
  function bonusText(b) {
    switch ((b || {}).type) {
      case "turns": return "Win within " + b.n + " rounds";
      case "noGamble": return "Win without GAMBLE";
      case "noItem": return "Win";
      case "noBlock": return "Win without blocking, dodging or channeling";
      case "perfectBlock": return "Land " + ((b.n || 1) + 1) + " great reactions (parry, dodge, counter, channel)";
      case "jackpot": return "Hit a 7️⃣7️⃣7️⃣ jackpot";
      case "hp": return "Win with " + b.pct + "%+ HP";
      case "skill": return "Use your ultimate";
      case "perfectPower": return "Land " + (b.n || 1) + " PERFECT HEAVY hit" + ((b.n || 1) > 1 ? "s" : "");
      case "crits": return "Land " + b.n + " crits";
      default: return "-";
    }
  }

  // ------------------------------------------------------------------ AI (simulace, kolega, aréna)
  function autoAttack(f, R, style) {
    const h = f.h; style = style || "normal";
    const can = (a) => allowedAtk(f, a);
    if (f.demand && ATTACKS[f.demand] && can(f.demand)) return f.demand;
    if (can("ult")) return "ult";
    if ((f.unleashNext || f.eguard || f.siesta) && can("heavy")) return "heavy";
    if (f.poison > 0 && f.hp < h.maxHp * 0.5 && R() < 0.6) return "rest";
    const reserve = h.block > 0 ? h.blockCost : 0;
    if (f.sta < 30 + reserve * 0.5 && R() < (h.block > 0 ? 0.55 : 0.35)) return "rest";
    if (style === "allin" && can("gamble") && R() < 0.35) return "gamble";
    if (can("heavy") && f.sta - 30 >= reserve && (f.sta >= 65 || R() < 0.5)) return "heavy";
    if (style !== "safe" && can("gamble") && f.sta - 20 >= reserve + 20 && R() < 0.12) return "gamble";
    return "strike";
  }
  function autoReact(f, R) {
    const h = f.h, it = f.intent || {}, k = it.shown === "?" ? "atk" : (it.shown || it.k);
    const can = (r) => allowedReact(f, r);
    if (f.demand && REACTS[f.demand] && can(f.demand)) return f.demand;
    if (k === "spell") { if (h.spellImmune) return "brace"; return can("block") && f.sta >= h.blockCost + 20 ? "block" : "brace"; }
    const big = k === "heavy" || k === "unleash" || k === "withdraw";
    if (big) { if (can("dodge")) return "dodge"; if (can("block")) return "block"; if (can("channel")) return "channel"; return "brace"; }
    if (h.cls === "sysadmin") return can("block") && f.sta >= h.blockCost + 10 ? "block" : "brace";
    if (h.cls === "blood") return can("block") && f.sta >= 60 ? "block" : "brace";
    if (h.cls === "engineer") return can("channel") && f.sta >= 45 ? "channel" : "brace";
    if (can("dodge") && f.sta >= 55) return "dodge";
    return "brace";
  }
  function timingRoll(R, zone) { const r = R(); return r < zone * 0.35 ? "perfect" : r < zone * 1.9 ? "good" : "none"; }
  const PARRY_SKILL = { perfect: 0.3, good: 0.45, dodge: { perfect: 0.3, good: 0.45 } };
  const ULT_SKILL = { q: 1.0, sd: 0.1, all: 0.6 };
  function parryRoll(R) { const r = R(); return r < PARRY_SKILL.perfect ? "perfect" : r < PARRY_SKILL.perfect + PARRY_SKILL.good ? "good" : "none"; }
  function dodgeRoll(R) { const r = R(), D = PARRY_SKILL.dodge; return r < D.perfect ? "perfect" : r < D.perfect + D.good ? "good" : "none"; }
  function autoOpt(f, a, R, skill) {
    if (a === "heavy") return { t: timingRoll(R, skill == null ? f.h.zone : skill) };
    if (a === "ult") return { q: ULT_SKILL.q + (R() + R() + R() - 1.5) * ULT_SKILL.sd * 2, all: R() < ULT_SKILL.all, guess: GUESS_PVE[Math.floor(R() * 4)] };
    if (a === "channel") return { cv: Math.min(1, Math.max(0, 0.45 + (R() + R() - 1) * 0.35)) };
    if (a === "gamble") { const r = gambleRoll(f), hold = autoHold(r); if (!hold.every(Boolean) && canRespin(f) && R() < 0.85) gambleRespin(f, hold); return {}; }
    if (a === "dodge") return { dq: dodgeRoll(R) };
    if (a === "block" && f.intent && (f.intent.k === "heavy" || f.intent.k === "unleash" || f.intent.k === "withdraw")) {
      if (f.intent.k === "unleash") return { rings: [parryRoll(R), parryRoll(R), parryRoll(R)] };
      return { parry: parryRoll(R) };
    }
    return {};
  }
  function simulate(hero, mission, seed, skill, style) {
    const f = newFight(hero, mission, seed), R = rng((seed || 1) * 7 + 3);
    let g = 0;
    while (!f.over && g++ < 400) {
      if (f.phase === "atk") { const a = autoAttack(f, R, style); attack(f, a, autoOpt(f, a, R, skill)); }
      else { const r = autoReact(f, R); react(f, r, autoOpt(f, r, R, skill)); }
    }
    return f;
  }

  // ================================================================== PvP (aréna proti AI, živý duel s kamarádem)
  /** karta = co se ukládá na server (z ní se postava přepočítá znovu, nic se nepřebírá slepě) */
  function card(h) { return { v: 11, cls: h.cls, level: h.level, main: Math.round(h.main), vit: Math.round(h.vit), luck: Math.round(h.luck), wpn: Math.round(h.wpn * 10) / 10, armor: Math.round(h.armor / ((CLASSES[h.cls] || {}).armorM || 1)) }; }
  function fromCard(c) {
    if (!c || !CLASSES[c.cls]) return null;
    const L = clamp(Math.floor(Number(c.level) || 1), 1, 999), cap = 60 + 25 * L;
    const C = CLASSES[c.cls], st = {};
    st[C.main] = clamp(Number(c.main) || BASE, BASE, cap) - BASE; st.vit = clamp(Number(c.vit) || BASE, BASE, cap) - BASE; st.luck = clamp(Number(c.luck) || BASE, BASE, cap) - BASE;
    return buildHero({ cls: c.cls, level: L, stats: st }, { wpn: clamp(Number(c.wpn) || 1, 1, 30 + 30 * L), armor: clamp(Number(c.armor) || 0, 0, 120 * L) });
  }
  /** "rovné podmínky": typická postava levelu L s gearem Rare+3 */
  function stdHero(cls, L, al) {
    const t = typical(L, 1.5), C = CLASSES[cls] || CLASSES.sysadmin, st = {};
    st[C.main] = t.main - BASE; st.vit = t.vit - BASE; st.luck = t.luck - BASE;
    const a = okAlloc(al, L);
    if (a) { const k = 1.5, pts = statPoints(L); st[C.main] += a.main - 0.5 * pts; st.vit += a.vit - 0.3 * pts; st.luck += a.luck - 0.2 * pts; }      // v11.2: vlastní rozdělení bodů (rovné podmínky)
    return buildHero({ cls: cls, level: L, stats: st }, { wpn: t.wpn, armor: t.armor });
  }
  /** rozdělení bodů pro duel "rovné podmínky": { main, vit, luck } - celá čísla, součet = body levelu L */
  function okAlloc(al, L) {
    if (!al || typeof al !== "object") return null;
    const pts = statPoints(L), v = ["main", "vit", "luck"].map(k => Math.max(0, Math.floor(Number(al[k]) || 0)));
    const sum = v[0] + v[1] + v[2]; if (sum <= 0 || sum > pts) return null;
    return { main: v[0], vit: v[1], luck: v[2] + (pts - sum) };
  }
  function power(h) { if (!h) return 0; return Math.round(Math.sqrt(estDmg(h, h.level, h.level * 4.75 + 10) * h.maxHp * (h.cls === "sysadmin" ? 1.5 : h.cls === "engineer" ? 1.1 : 1.25))); }

  const PVP_ATK = ["strike", "heavy", "gamble", "rest", "ult"];
  const SYMS = ["🍒", "🔔", "⭐", "7️⃣", "💀"];
  /** d = stav duelu: dva bojovníci, střídají se v útoku. V jednom půlkole volí útočník útok a obránce naslepo reakci. */
  function duelNew(A, B, seed) {
    const R = rng(seed || 1);
    const c = [A, B];
    const pv = (h) => PVP.dmg[h.cls] || 1;
    let first = A.firstStrike && !B.firstStrike ? 0 : B.firstStrike && !A.firstStrike ? 1 : (R() < 0.5 ? 0 : 1);
    const mA = Math.round(A.maxHp * PVP.hp * ((PVP.hpc || {})[A.cls] || 1)), mB = Math.round(B.maxHp * PVP.hp * ((PVP.hpc || {})[B.cls] || 1));
    const d = { R: R, c: c, hp: [mA, mB], max: [mA, mB], pv: [pv(A), pv(B)], sta: [100, 100], foc: [30, 30], sh: [0, 0], sure: [false, false], chan: [0, 0], mark: [false, false],
      rev: [false, false], streak: [0, 0], vuln: [false, false], cd: [0, 0], mana: [0, 0], bm: [0, 0], ep: [0, 0], sa: [0, 0], nocd: [0, 0], gd: [false, false], gu: [false, false], half: 0, turn: 1, atk: first, first: first, over: false, win: -1, events: [], miss: [0, 0] };
    d.armor = [clamp(A.armor / (B.level * 100), 0, A.armorCap), clamp(B.armor / (A.level * 100), 0, B.armorCap)];
    d.dodge = [A.dodge > 0 ? Math.min(0.75, A.dodge + (A.cls === "cyber" ? 0.3 * clamp(A.main / Math.max(1, B.main) - 0.5, 0, 1) : 0)) : 0,
      B.dodge > 0 ? Math.min(0.75, B.dodge + (B.cls === "cyber" ? 0.3 * clamp(B.main / Math.max(1, A.main) - 0.5, 0, 1) : 0)) : 0];
    return d;
  }
  function dEv(d, type, x) { const e = Object.assign({ t: d.turn, i: d.atk, type: type, hp: d.hp.slice(), sh: d.sh.slice() }, x || {}); d.events.push(e); return e; }
  function duelAtkOk(d, i, a) {
    if (a === "strike" || a === "rest") return true;
    if (a === "heavy") return d.sta[i] >= 30 && !((d.cd || [])[i] > 0);
    if (a === "gamble") return d.sta[i] >= 20;
    if (a === "ult") return d.foc[i] >= 100;
    return false;
  }
  function duelReactOk(d, i, r) { const h = d.c[i]; if (!hasReact(h, r)) return false; if (r === "block") return d.sta[i] >= h.blockCost; if (r === "dodge") return d.sta[i] >= h.dodgeCost; if (r === "channel") return d.sta[i] >= REACTS.channel.sta; return true; }
  function dHurt(d, i, v) {
    v = Math.max(0, Math.round(v)); const s = Math.min(d.sh[i], v); d.sh[i] -= s; d.hp[i] -= v - s;
    if (s > 0) d.absorbed = (d.absorbed || 0) + s;                       // v11.6: pro log (kolik vzal štít)
    if (v > 0) d.foc[i] = Math.min(100, d.foc[i] + 8);
    const h = d.c[i];
    if (d.hp[i] <= 0 && h.revive && !d.rev[i]) { d.rev[i] = true; if (d.R() < h.revive) { d.hp[i] = Math.round(d.max[i] * PVP.revive); dEv(d, "revive", { who: i, val: d.hp[i] }); } }
    return v;
  }
  function dHit(d, a, b, mult, o) {
    o = o || {};
    const A = d.c[a], B = d.c[b];
    let m = mult * (d.chan[a] || 1) * (d.mark[a] ? 1 + (A.mark || 0) : 1) * (d.vuln[b] ? 1.5 : 1) * ((d.pv && d.pv[a]) || 1);
    if (d.turn > 12) m *= 1 + 0.15 * (d.turn - 12);                       // v11.7: NÁHLÁ SMRT - od 13. kola +15 % damage každé kolo (žádné nekonečné tankování)
    d.vuln[b] = false;
    const sure = d.sure[a]; if (sure) d.sure[a] = false;
    const r = rawHit(d.R, A, Object.assign({}, B, { armorRed: o.ignoreArmor ? 0 : d.armor[b] }), { mult: m, crit: sure || o.crit ? true : undefined, critMul: o.critMul, critAdd: o.critAdd });
    return r;
  }
  /** v11.1: válce v duelu z předem daných čísel (server je losuje za každé půlkolo) - klient i server dostanou stejný výsledek */
  function duelReels(h, rolls, hold, re) {
    let k = 0; const f = { h: h, R: () => Number(rolls[k++ % rolls.length]) || 0 };
    const a = spinReels(f); if (!re) return a;
    const b = spinReels(f); return a.map((s, i) => hold && hold[i] ? s : b[i]);
  }
  function okReels(x) { return Array.isArray(x) && x.length === 3 && x.every(s => SYMS.indexOf(s) >= 0) ? x.slice() : null; }
  /** jedno půlkolo: útočník d.atk dá útok a, obránce naslepo reaguje r.
   *  opt (v11.1 - quick time eventy v duelu): { t: HEAVY timing, q: síla ulti 0.7-1.25, reels: válce z gamble mini-hry,
   *        parry: tier obránce při BLOCKu (proti HEAVY / GAMBLE / ULTI), dq: dodge mini-hra obránce } */
  /** jedno půlkolo: útočník d.atk dá útok a, obránce naslepo reaguje r.
   *  opt: { t: HEAVY timing, q: síla ulti, reels/respin: gamble, parry: tier BLOCKu, dq: dodge mini-hra, cq: CHANNEL mini-hra,
   *        rings: [3 tiery] BLOCK proti ulti (3× jako UNLEASH), dqs: [3 tiery] DODGE proti ulti, guess: tip útočníka na reakci (ulti) } */
  function duelHalf(d, a, r, opt) {
    if (d.over) return [];
    opt = opt || {};
    ["cd", "bm", "ep", "sa", "nocd"].forEach(k => { if (!d[k]) d[k] = [0, 0]; });
    ["gd", "gu"].forEach(k => { if (!d[k]) d[k] = [false, false]; });
    if (!d.wd) d.wd = [0, 0]; if (!d.fort) d.fort = [0, 0];
    const start = d.events.length, i = d.atk, j = 1 - i, A = d.c[i], B = d.c[j], R = d.R;
    if (!duelAtkOk(d, i, a)) a = "strike";
    if (!duelReactOk(d, j, r)) r = "brace";
    const q = clamp(opt.q == null ? 1 : Number(opt.q) || 0.7, 0.7, 1.25);
    const T3 = (x) => Array.isArray(x) ? [0, 1, 2].map(k => x[k] === "perfect" || x[k] === "good" ? x[k] : "none") : null;
    const rings = T3(opt.rings), dqs = T3(opt.dqs);
    const parry = rings ? rings[0] : opt.parry, dq1 = dqs ? dqs[0] : opt.dq;
    if (a === "gamble" && opt.respin && d.sta[i] >= ATTACKS.gamble.sta + RESPIN_STA) d.sta[i] -= RESPIN_STA;
    if (a === "heavy") d.sta[i] -= 30; if (a === "gamble") d.sta[i] -= 20;
    d.cd[i] = a === "heavy" && !(d.nocd[i] > 0) ? 1 : 0;
    if (d.nocd[i] > 0) d.nocd[i]--;
    const sure = d.sa[i] > 0 && a !== "rest"; if (sure) d.sa[i]--;
    if (r === "block") d.sta[j] -= B.blockCost; if (r === "dodge") d.sta[j] -= B.dodgeCost; if (r === "channel") d.sta[j] -= REACTS.channel.sta;
    if (r === "brace") { d.sta[j] = Math.min(100, d.sta[j] + 15); d.foc[j] = Math.min(100, d.foc[j] + 10); }
    d.streak[j] = r === "dodge" ? d.streak[j] + 1 : 0;
    // útok
    let hits = [], label = ATTACKS[a].name, ignoreArmor = false, critMul = 1, critAdd = 0, forceCrit = sure, gres = null, healSelf = 0, timing = "";
    if (a === "strike") { hits = A.double ? [0.6, 0.6] : [1]; d.sta[i] = Math.min(100, d.sta[i] + 10); }
    else if (a === "rest") { d.sta[i] = Math.min(100, d.sta[i] + 30); d.foc[i] = Math.min(100, d.foc[i] + 15); }
    else if (a === "heavy") { const m = opt.t === "perfect" ? 2.2 : opt.t === "none" ? 1.3 : 1.7; timing = opt.t === "perfect" ? "PERFECT" : opt.t === "none" ? "MISS" : "GOOD"; hits = A.double ? [0.6 * m, 0.6 * m] : [m]; }
    else if (a === "gamble") {
      const reels = okReels(opt.reels) || spinReels({ h: A, R: R });
      gres = reelResult(reels); gres.reels = reels;
      if (gres.bf) { const s = dHurt(d, i, estDmg(A, A.level) * gres.self); dEv(d, "bf", { val: s, reels: reels }); hits = []; }
      else { hits = gres.mult > 0 ? [gres.mult] : []; if (gres.heal) healSelf = Math.round(d.max[i] * gres.heal); d.foc[i] = Math.min(100, d.foc[i] + gres.foc); if (gres.jp) forceCrit = true; critAdd = gres.critAdd || 0; }
    } else if (a === "ult") {
      d.foc[i] = 0;
      if (A.cls === "sysadmin") { const s = Math.round(d.max[i] * 0.3 * q), hh = Math.round(d.max[i] * 0.05 * q * PVP.heal); d.sh[i] += s; d.hp[i] = Math.min(d.max[i], d.hp[i] + hh); hits = [1.4 * q]; dEv(d, "ult", { a: CLASSES[A.cls].skill, shield: s, heal: hh, q: q }); }
      else if (A.cls === "engineer") { hits = [3.2 * q]; critMul = 2; }
      else if (A.cls === "cyber") { hits = [2.8 * q]; ignoreArmor = true; d.chan[j] = 0; }
      else if (A.cls === "blood") { hits = [2.6 * q]; }
      else hits = [0.9 * q, 0.9 * q, 0.9 * q, 0.9 * q];
    }
    // reakce obránce
    const magic = A.cls === "engineer", big = a !== "strike", ult3 = a === "ult";
    let total = 0, anyCrit = false, outcome = a === "rest" ? "rest" : "hit", saved = 0, counter = 0, scale = 1, hv = [], dodged = 0, manaOut = 0, manaIn = 0, cvD = 0, riposte = 0;
    if (!d.mana) d.mana = [0, 0];
    if (hits.length) {
      if (r === "dodge") {
        const base = d.dodge[j] * (magic ? 0.5 : 1) * Math.pow(0.8, d.streak[j] - 1);          // v11.4: proti Mágovi poloviční šance (dřív 0)
        const chOf = (x) => Math.min(0.95, Math.max(0, base * (x === "perfect" ? 1.6 : x === "good" ? 1.15 : x === "none" ? 0.4 : 1)));
        if (ult3 && dqs) {                                                // v11.2: proti ULTI 3 uskoky - každý úspěšný vezme třetinu
          dodged = dqs.filter(x => R() < chOf(x)).length; scale = 1 - dodged / 3;
          if (dodged === 3) { outcome = "dodge"; hits = []; } else outcome = dodged ? "partdodge" : "dodgefail";
        } else if (dq1 === "perfect" || R() < chOf(dq1)) outcome = "dodge", hits = [];   // v11.7: PERFECT dodge = jistý (i proti Mágovi)
        else outcome = "dodgefail";
        if (outcome === "dodge") { d.foc[j] = Math.min(100, d.foc[j] + 5); if (B.cls === "cyber") d.sure[j] = true;
          if (dq1 === "perfect" && !(ult3 && dqs && dqs.some(x => x !== "perfect"))) { const rp = dHit(d, j, i, 0.5, {}); riposte = dHurt(d, i, rp.v); d.sta[j] = Math.min(100, d.sta[j] + 10); } }
      }
      let red = 0;
      if (r === "channel") { cvD = chanVal(opt); red = 0.1 + 0.25 * cvD; d.chan[j] = 1.2; outcome = "channel"; }
      if (r === "block") {
        const bk = B.block * ((PVP.blk || {})[B.cls] || 1) * (a === "strike" ? 1 : 0.5), tierRed = (x) => x === "perfect" ? 0.75 : x === "good" ? Math.min(0.7, bk + 0.3) : bk;
        if (ult3 && rings) red = rings.reduce((s2, x) => s2 + tierRed(x), 0) / 3;
        else red = big ? tierRed(parry) : bk;
        const full = big && (ult3 && rings ? rings.every(x => x === "perfect") : parry === "perfect");
        if (magic) red *= 0.5;                                            // v11.2: proti Mágovi blok funguje jen z poloviny
        outcome = full ? "parry" : "block";
        if (full) d.fort[j] = 2;                                // proti Mágovi perfect parry vezme jen polovinu, ale protiútok dá
      }
      hits.forEach(m => {
        const h0 = dHit(d, i, j, m, { ignoreArmor: ignoreArmor, critMul: critMul, critAdd: critAdd, crit: forceCrit || undefined });
        if (d.mana[i] > 0) { h0.v += d.mana[i]; manaOut = d.mana[i]; d.mana[i] = 0; }
        let v = h0.v * scale * (1 - red) * (d.fort[j] > 0 ? 0.8 : 1);
        if (d.gd[j] && v > 0) { d.gd[j] = false; v *= 0.5; }
        saved += h0.v - v; const got = dHurt(d, j, v); total += got; hv.push(got); if (h0.crit) anyCrit = true;
      });
      if (hits.length) d.chan[i] = 0;
      if (r === "channel" && saved > 0) { manaIn = Math.round(saved * (0.5 + 0.5 * cvD)); d.mana[j] += manaIn; }
      if (a === "ult" && A.cls === "cyber") d.vuln[j] = true;
      if (r === "block" && hits.length && ((a === "strike" && B.counter) || outcome === "parry")) { const c0 = dHit(d, j, i, (outcome === "parry" ? (B.counter ? 1 : 0.6) : B.counter) * (PVP.ctr || 1), {}); counter = dHurt(d, i, c0.v); }
      if (A.lifesteal && total) healSelf += Math.round(total * A.lifesteal);
      if (a === "ult" && A.cls === "blood") healSelf += Math.round(total * 0.6);
      if (d.bm[i] > 0 && total > 0) { d.bm[i]--; const bh = Math.min(Math.round(d.max[i] * 0.08), Math.round(total * 0.25)); healSelf += bh; dEv(d, "bm", { val: bh, left: d.bm[i] }); }
      if (A.mark) d.mark[i] = true;
    }
    let healRaw = healSelf;
    if (healSelf) { healSelf = Math.round(healSelf * PVP.heal * (d.wd[i] > 0 ? PVP.wound : 1)); d.hp[i] = Math.min(d.max[i], d.hp[i] + healSelf); }   // v11.6: v PvP léčení -35 %, 🩸 Wound dalších -50 %
    // v11.6: 🩸 WOUND - Warden: PERFECT parry nebo PERFECT HEAVY; Trojan: ultimátka (BACKDOOR). Soupeř se 2 kola léčí o 50 % méně.
    let wound = "";
    if (outcome === "parry" && B.cls === "sysadmin") { d.wd[i] = 2; wound = "parry"; }
    if (a === "heavy" && timing === "PERFECT" && A.cls === "sysadmin" && total > 0) { d.wd[j] = 2; wound = "heavy"; }
    if (a === "ult" && A.cls === "cyber" && total > 0) { d.wd[j] = 2; wound = "backdoor"; }
    const absorbed = d.absorbed || 0; d.absorbed = 0;
    if (a !== "ult" || A.cls !== "sysadmin") dEv(d, outcome === "dodge" ? "dodge" : a === "rest" ? "rest" : "hit", { a: a, r: r, val: total, crit: anyCrit, outcome: outcome, saved: Math.round(saved), counter: counter, heal: healSelf, reels: gres && gres.reels, jp: gres && gres.jp, label: label, mult: gres ? gres.mult : null, timing: timing, q: a === "ult" ? q : undefined, hv: hv.length > 1 ? hv : undefined, mana: manaIn || undefined, manaOut: manaOut || undefined, dodged: ult3 && r === "dodge" ? dodged : undefined, rings: ult3 && r === "block" ? rings : undefined, shield: absorbed || undefined, wound: wound || undefined, riposte: riposte || undefined, healCut: healRaw > healSelf ? healRaw - healSelf : undefined, cv: r === "channel" ? Math.round(cvD * 100) / 100 : undefined, parry: r === "block" && !rings ? parry : undefined });
    // v11.2: tip u ulti - uhodl útočník reakci obránce?
    if (a === "ult" && opt.guess) {                                       // v11.6: u každé ulti; první trefa plný efekt, další poloviční
      const ok = opt.guess === r, k = d.gu[i] ? 0.5 : 1;
      if (ok) {
        d.gu[i] = true;
        if (A.cls === "engineer") d.bm[i] = Math.max(d.bm[i], Math.round(3 * k));
        else if (A.cls === "sysadmin") { d.sh[i] += Math.round(d.max[i] * 0.2 * k); d.gd[i] = true; }
        else if (A.cls === "cyber") d.ep[j] = Math.max(d.ep[j], Math.round(3 * k));
        else if (A.cls === "hunter") d.sa[i] = Math.max(d.sa[i], Math.round(2 * k));
        else { d.sta[i] = Math.min(100, d.sta[i] + Math.round(40 * k)); d.nocd[i] = Math.max(d.nocd[i], Math.round(2 * k)); d.cd[i] = 0; }
      }
      dEv(d, "guess", { ok: ok, g: opt.guess, real: r, fx: ok ? GUESS_FX[A.cls].n + (k < 1 ? " (half)" : "") : "" });
    }
    // konec půlkola
    if (d.hp[j] <= 0 || d.hp[i] <= 0) return duelEnd(d, d.hp[j] <= 0 && d.hp[i] > 0 ? i : d.hp[i] <= 0 && d.hp[j] > 0 ? j : (d.hp[i] >= d.hp[j] ? i : j), start);
    d.half++;
    if (d.half % 2 === 0) {
      for (let k = 0; k < 2; k++) { d.foc[k] = Math.min(100, d.foc[k] + 10); if (d.wd[k] > 0) d.wd[k]--; if (d.fort[k] > 0) d.fort[k]--; }      // v11.1: stamina se sama nedoplňuje
      for (let k = 0; k < 2; k++) if (d.ep[k] > 0 && d.hp[k] > 0) { d.ep[k]--; const pv = dHurt(d, k, d.max[k] * 0.04); dEv(d, "poison", { who: k, val: pv }); }
      d.turn++;
      if (d.hp[0] <= 0 || d.hp[1] <= 0) return duelEnd(d, d.hp[0] > 0 ? 0 : d.hp[1] > 0 ? 1 : (d.hp[0] >= d.hp[1] ? 0 : 1), start);
    }
    d.atk = j;
    if (d.turn > 30) return duelEnd(d, d.hp[0] / d.max[0] >= d.hp[1] / d.max[1] ? 0 : 1, start, "time");
    return d.events.slice(start);
  }
  function duelEnd(d, w, start, why) { d.over = true; d.win = w; d.hp = d.hp.map(x => Math.max(0, x)); dEv(d, "end", { win: w, why: why || "ko" }); return d.events.slice(start); }
  /** AI v duelu: útočí podle stavu, reaguje naslepo (neví, co soupeř zvolí) */
  function duelAiAtk(d, i, R, style) {
    if (duelAtkOk(d, i, "ult")) return "ult";
    const st = d.sta[i], h = d.c[i], reserve = h.block > 0 ? h.blockCost : 0;
    if (st < 30 + reserve * 0.5 && R() < 0.5) return "rest";
    if (style === "allin" && st >= 20 && R() < 0.35) return "gamble";
    if (duelAtkOk(d, i, "heavy") && st - 30 >= reserve && (st >= 65 || R() < 0.45)) return "heavy";
    if (style !== "safe" && st - 20 >= reserve + 10 && R() < 0.12) return "gamble";
    return "strike";
  }
  function duelAiReact(d, j, R, style) {
    const h = d.c[j], opp = d.c[1 - j], heavyLikely = (d.sta[1 - j] >= 65 && !(d.cd && d.cd[1 - j] > 0)) || d.foc[1 - j] >= 100;
    if (h.cls === "sysadmin") return duelReactOk(d, j, "block") && d.sta[j] >= h.blockCost + 10 ? "block" : "brace";
    if (h.dodge > 0 && duelReactOk(d, j, "dodge") && (heavyLikely || d.sta[j] >= 55)) return "dodge";
    if (h.cls === "blood" && duelReactOk(d, j, "block") && d.sta[j] >= 60) return "block";
    if (h.canChannel && duelReactOk(d, j, "channel") && d.sta[j] >= 45) return "channel";
    return "brace";
  }
  function duelAI(A, B, seed, sa, sb) {
    const d = duelNew(A, B, seed), R = rng((seed || 1) * 13 + 5), st = [sa || "normal", sb || "normal"];
    let g = 0;
    while (!d.over && g++ < 200) {
      const i = d.atk, j = 1 - i;
      const a = duelAiAtk(d, i, R, st[i]), r = duelAiReact(d, j, R, st[j]), rs = reactsOf(d.c[j]);
      duelHalf(d, a, r, { t: R() < 0.25 ? "perfect" : "good", parry: parryRoll(R), dq: dodgeRoll(R), cv: Math.min(1, Math.max(0, 0.45 + (R() + R() - 1) * 0.35)), rings: [parryRoll(R), parryRoll(R), parryRoll(R)], dqs: [dodgeRoll(R), dodgeRoll(R), dodgeRoll(R)], guess: rs[Math.floor(R() * rs.length)] });
    }
    return { win: d.win === 0, first: d.first, events: d.events, max: d.max, turns: d.turn };
  }

  const api = { rng: rng, CLASSES: CLASSES, CLASS_IDS: CLASS_IDS, ATTACKS: ATTACKS, REACTS: REACTS, ACTIONS: ACTIONS, ITEMS: ITEMS, MAX_ITEMS_PER_FIGHT: MAX_ITEMS_PER_FIGHT,
    statPoints: statPoints, typical: typical, buildHero: buildHero, buildEnemy: buildEnemy, estDmg: estDmg, critOf: critOf, rawHit: rawHit, ARCH: ARCH, KIND: KIND,
    newFight: newFight, attack: attack, react: react, step: step, allowed: allowed, allowedAtk: allowedAtk, allowedReact: allowedReact, hasReact: hasReact, reactsOf: reactsOf, isDmgIntent: isDmgIntent, useItem: useItem,
    stars: stars, starMask: starMask, starCount: starCount, QUICK_WIN: QUICK_WIN, bonusDone: bonusDone, bonusText: bonusText, FORM_NO: FORM_NO,
    simulate: simulate, autoAttack: autoAttack, autoReact: autoReact, autoPolicy: autoAttack, autoOpt: autoOpt, PARRY_SKILL: PARRY_SKILL, ULT_SKILL: ULT_SKILL, timingRoll: timingRoll,
    reelResult: reelResult, gambleRoll: gambleRoll, gambleRespin: gambleRespin, canRespin: canRespin, autoHold: autoHold, RESPIN_STA: RESPIN_STA, SYM: SYM,
    chanVal: chanVal, GUESS_FX: GUESS_FX, GUESS_PVE: GUESS_PVE, guessCat: guessCat, card: card, fromCard: fromCard, PVP: PVP, ATK_KEYS: ATK_KEYS, ECLS: ECLS, dodgeRoll: dodgeRoll, okReels: okReels, duelReels: duelReels, stdHero: stdHero, okAlloc: okAlloc, power: power, duelNew: duelNew, duelHalf: duelHalf, duelAI: duelAI, duelAiAtk: duelAiAtk, duelAiReact: duelAiReact, duelAtkOk: duelAtkOk, duelReactOk: duelReactOk, PVP_ATK: PVP_ATK };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HSEngine = api;
})(typeof window !== "undefined" ? window : this);

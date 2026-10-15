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
      try { storedRev = Number(JSON.parse(rowToJson_(cur)).rev) || 0; } catch (e2) { storedRev = 0; }
      if (Number(baseRev) !== storedRev) return { ok: false, reason: 'conflict', rev: storedRev };
    }
    state.rev = storedRev + 1;
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
        gear: cleanTxt_(gear.join(' '), 80),
        dungeon: { cls: cleanTxt_(dg.cls, 12), level: Number(dg.level) || 0, best: Number(dg.best) || 0, wins: Number(dg.wins) || 0, losses: Number(dg.losses) || 0, title: cleanTxt_(dg.title, 40) },
        score: computeScore_(s)
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
  var key = 'tt_lb_v3_s' + currentSeason;
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
  pvpPoll: function (a) { return pvpPoll(a[0]); }
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

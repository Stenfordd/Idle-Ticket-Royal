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
        dungeon: { cls: cleanTxt_(dg.cls, 12), level: Number(dg.level) || 0, best: Number(dg.best) || 0, wins: Number(dg.wins) || 0, losses: Number(dg.losses) || 0, title: cleanTxt_(dg.title, 40), honor: arenaHonorOf_(saves[i][0]) },
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
  arenaFight: function (a) { return arenaFight(a[0], a[1]); }
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
// ARÉNA (v7.1) - asynchronní PvP proti uloženým postavám ostatních.
// Souboj počítá SERVER stejným enginem jako dungeon (DungeonEngine níže), klient ho jen přehrává.
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

function arenaPlayer_(s) {
  var d = s.dungeon || {};
  if (!d.cls) return null;
  var lo = s.loadout || {}, g = { atk: 1, hp: 1 };
  ['TOOL', 'AUGMENT', 'RELIC'].forEach(function (k) { var it = lo[k]; if (it) g.atk += DungeonEngine.gearSlotValue(Number(it.tier) || 1, Number(it.lvl) || 0); });
  ['HEAD', 'RIG', 'OS'].forEach(function (k) { var it = lo[k]; if (it) g.hp += DungeonEngine.gearSlotValue(Number(it.tier) || 1, Number(it.lvl) || 0); });
  var arts = d.artifacts || {}, eq = Array.isArray(d.equipped) ? d.equipped.filter(function (id) { return arts[id]; }).slice(0, 6) : [];
  var dd = { cls: d.cls, level: Math.max(1, Math.min(999, Number(d.level) || 1)), tier: Math.max(1, Math.min(4, Number(d.tier) || 1)), branch: d.branch === 'a' || d.branch === 'b' ? d.branch : '',
    artifacts: arts, equipped: eq, exec: !!(d.promos && d.promos.bod) };
  return DungeonEngine.buildPlayer(dd, g);
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
      power: DungeonEngine.power(p), wins: r.wins || 0, losses: r.losses || 0, cooldown: Math.max(0, ARENA_SAME_TARGET_MS - (Date.now() - last)) });
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
  return { ok: true, me: { honor: mine.honor, wins: mine.wins, losses: mine.losses, left: Math.max(0, ARENA_PER_DAY - used), perDay: ARENA_PER_DAY, power: mp ? DungeonEngine.power(mp) : 0 }, opponents: opp, log: logs };
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
    var res = DungeonEngine.duel(A, B, seed, stance, dStance);
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


// ===================== DUNGEON ENGINE (vygenerováno build.py ze src/dungeon_engine.js - neupravovat ručně) =====================
/**
 * IDLE ROYALE - DUNGEON ENGINE (čistá logika bez DOM; stejný kód běží ve hře i v simulaci pro ladění čísel)
 * Tahový souboj: hráč udeří (útok se losuje z tabulky podle třídy a postoje), pak boss.
 * Každý postoj má průměr (EV) přesně 1.00× ATK - postoj mění jen riziko, ne průměrný damage.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ RNG (seedovatelný, přehratelný)
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------------ TABULKY ÚTOKŮ
  // řádek: [šance, násobek ATK, typ] ; typ: "low" | "mid" | "high" | "jp" (jackpot) | "bf" (backfire = rána do sebe)
  const RAW = {
    sysadmin: {
      safe:   [[0.25, 0.70, "low"], [0.55, 1.00, "mid"], [0.20, 1.38, "high"]],
      normal: [[0.15, 0.40, "low"], [0.50, 0.90, "mid"], [0.30, 1.30, "high"], [0.05, 3.00, "jp"]],
      allin:  [[0.03, 0, "bf"], [0.30, 0.15, "low"], [0.30, 0.70, "mid"], [0.32, 1.60, "high"], [0.05, 5.50, "jp"]]
    },
    engineer: {
      safe:   [[0.30, 0.60, "low"], [0.45, 1.00, "mid"], [0.25, 1.55, "high"]],
      normal: [[0.25, 0.30, "low"], [0.40, 0.85, "mid"], [0.28, 1.60, "high"], [0.07, 3.50, "jp"]],
      allin:  [[0.04, 0, "bf"], [0.33, 0.10, "low"], [0.25, 0.60, "mid"], [0.31, 1.80, "high"], [0.07, 8.00, "jp"]]
    },
    cyber: {
      safe:   [[0.25, 0.60, "low"], [0.50, 1.00, "mid"], [0.25, 1.50, "high"]],
      normal: [[0.25, 0.30, "low"], [0.42, 0.90, "mid"], [0.27, 1.50, "high"], [0.06, 3.00, "jp"]],
      allin:  [[0.03, 0, "bf"], [0.30, 0.10, "low"], [0.30, 0.60, "mid"], [0.31, 1.70, "high"], [0.06, 7.00, "jp"]]
    }
  };
  const BACKFIRE_SELF = { sysadmin: 1.2, engineer: 1.5, cyber: 1.2 };   // backfire = tolik × vlastní ATK do sebe
  const TABLES = {};
  Object.keys(RAW).forEach(c => {
    TABLES[c] = {};
    Object.keys(RAW[c]).forEach(s => {
      const rows = RAW[c][s];
      const ev = rows.reduce((a, r) => a + r[0] * r[1], 0);
      TABLES[c][s] = rows.map(r => ({ p: r[0], m: Math.round(r[1] / ev * 1000) / 1000, k: r[2] }));   // normalizace na EV = 1.00
    });
  });
  function tableEV(rows) { return rows.reduce((a, r) => a + r.p * r.m, 0); }

  // ------------------------------------------------------------------ TŘÍDY + KARIÉRA
  const CLASSES = {
    sysadmin: { name: "SysAdmin", icon: "🛡", desc: "Tank. Low variance, +4% HP and a small shield (4% HP) at the start of every fight.",
      tiers: ["Junior Helpdesk Agent", "System Administrator", "Senior Infrastructure Engineer"],
      branches: { a: "Site Reliability Engineer", b: "Cloud Infrastructure Architect" },
      perks: ["Power Cycle: once per fight you survive a lethal hit with 10% HP.",
              "Reboot Script: in SAFE stance, hits of 1.0× or more heal 4% max HP.",
              "HA Cluster: backfire self-damage is halved and turns into a shield.",
              "SRE - SLO Breach Counter: after a heavy boss hit (>12% HP) the next one is halved.",
              "Cloud Architect - Elastic Auto-Scaling: jackpots add 2× your current shield as damage, +8% starting shield."] },
    engineer: { name: "Software Engineer", icon: "💻", desc: "Burst. High variance, +18% ATK, +5% HP, big jackpots. +1% click crit chance per career tier.",
      tiers: ["Intern Developer", "Full-Stack Developer", "Lead Software Architect"],
      branches: { a: "Algorithmic Quant Dev", b: "Principal Systems Engineer" },
      perks: ["StackOverflow Copy-Paste: 8% chance to repeat your previous good hit.",
              "Unit Test Coverage: backfire self-damage -30%.",
              "CI Burst: every hit of 1.0× or more in a row adds +1.5% jackpot chance (max +6%).",
              "Quant Dev - HFT: jackpots hit ×1.35 harder, but backfire chance +1%.",
              "Principal - Zero-Cost Abstraction: your weakest hits are never below 0.6×."] },
    cyber: { name: "Cybersecurity Specialist", icon: "🕶", desc: "Gambler. 17% dodge, +10% boss loot.",
      tiers: ["Script Kiddie", "SOC Security Analyst", "Senior Red Teamer"],
      branches: { a: "CISO", b: "Black-Hat Mercenary" },
      perks: ["Lucky Port Scan: 4% of your weakest hits become strong hits.",
              "Threat Intel: a dodge reflects 40% of the boss attack back.",
              "Zero-Day Payload: jackpots infect the boss - 0.4× ATK damage for 3 turns.",
              "CISO - Corporate Insurance: boss loot ×1.5 and 35% chance a won fight costs no key.",
              "Black-Hat - Ghost in the Shell: after a dodge your next hit can't backfire and deals +40%."] }
  };

  // ------------------------------------------------------------------ ARTEFAKTY (aditivní %, každý má protiváhu)
  const ARTIFACTS = [
    { id: "key",    name: "Master Admin Key",     icon: "🗝", fx: { atk: 0.12, hp: -0.08 } },
    { id: "token",  name: "Quantum Token",        icon: "🪙", fx: { hp: 0.08, jp: 0.015 } },
    { id: "pen",    name: "Cyber Pen",            icon: "🖊", fx: { dodge: 0.08, atk: -0.05 } },
    { id: "drive",  name: "Encrypted Hard Drive", icon: "💽", fx: { hp: 0.15, atk: -0.05 } },
    { id: "usb",    name: "Zero-Day USB",         icon: "🔌", fx: { atk: 0.08, bf: 0.01 } },
    { id: "mug",    name: "SME Coffee Mug",       icon: "☕", fx: { hp: 0.10, safeDef: 0.10 } },
    { id: "gpu",    name: "Overclocked GPU",      icon: "🎛", fx: { atk: 0.15, bfDmg: 0.25 } },
    { id: "node",   name: "Decentralized Node",   icon: "🛰", fx: { loot: 0.15, atk: 0.03 } },
    { id: "fw",     name: "Shadow Firewall",      icon: "🧱", fx: { dodge: 0.05, hp: 0.05 } },
    { id: "coin",   name: "Coin Toss Token",      icon: "🎲", fx: { coin: 1 } },
    { id: "bounty", name: "Bug Bounty Badge",     icon: "🏅", fx: { loot: 0.20, jp: 0.01 } },
    { id: "relic",  name: "Mainframe Relic",      icon: "🗄", fx: { hp: 0.20, dodge: -0.06 } }
  ];
  const ARTIFACT_BY_ID = {}; ARTIFACTS.forEach(a => { ARTIFACT_BY_ID[a.id] = a; });
  function artifactText(a, lvl) {
    const f = 1 + 0.25 * ((lvl || 1) - 1), o = [];
    const pct = (v) => (v > 0 ? "+" : "") + Math.round(v * f * 1000) / 10 + "%";
    const fx = a.fx;
    if (fx.atk) o.push(pct(fx.atk) + " ATK");
    if (fx.hp) o.push(pct(fx.hp) + " HP");
    if (fx.dodge) o.push(pct(fx.dodge) + " dodge");
    if (fx.jp) o.push(pct(fx.jp) + " jackpot chance");
    if (fx.bf) o.push(pct(fx.bf) + " backfire chance (All-in)");
    if (fx.bfDmg) o.push(pct(fx.bfDmg) + " backfire self-damage");
    if (fx.safeDef) o.push(pct(-fx.safeDef) + " damage taken in SAFE");
    if (fx.loot) o.push(pct(fx.loot) + " boss loot");
    if (fx.coin) o.push("fight start: 50% +25% ATK or 50% -15% ATK");
    return o.join(", ");
  }

  // ------------------------------------------------------------------ BOSSOVÉ (20 pater, pak se opakují jako Mk II, Mk III ...)
  const BOSSES = [
    { name: "Unplugged Router",          icon: "📡", mech: "router",   txt: "Cable Glitch: every 4th turn the signal drops and it skips its attack." },
    { name: "The Great \"I\"",          icon: "🅸", mech: "dust",     txt: "The Great I: hits weaker as it loses HP, but dodges more (up to 25%) - it's just one letter, how hard can it be?" },
    { name: "Printer Spooler Ghost",     icon: "🖨", mech: "printer",  txt: "Paper Jam: its hits have a 25% chance to jam your next attack (0 damage)." },
    { name: "Rogue Cron Job",            icon: "⏰", mech: "cron",     txt: "Scheduled Run: weak hits, but every 4th turn a massive batch job (×2.6)." },
    { name: "Memory Leak Java App",      icon: "☕", mech: "leak",     txt: "OutOfMemory: its attack grows +8% every turn. End it fast." },
    { name: "Legacy COBOL Mainframe",    icon: "🖥", mech: "cobol",    txt: "Tape Backup: every 4th turn it restores 12% of its max HP." },
    { name: "DDoS Botnet Cluster",       icon: "🕸", mech: "ddos",     txt: "Packet Storm: attacks 3× per turn with weak hits (dodge each one)." },
    { name: "Shadow IT Spreadsheet",     icon: "📊", mech: "excel",    txt: "VLOOKUP Crash: 15% chance to reflect 30% of your damage back at you." },
    { name: "Crypto-Miner Trojan",       icon: "⛏", mech: "miner",    txt: "Resource Theft: its hits halve your jackpot chance for 2 turns." },
    { name: "Rogue LLM Agent",           icon: "🤖", mech: "llm",      txt: "Hallucination Counter: after your strong hit or jackpot it counterattacks instantly." },
    { name: "Spaghetti Cabling Rack",    icon: "🍝", mech: "spaghetti",txt: "Cable Trap: every 5th turn your stance is locked for 2 turns." },
    { name: "Zero-Day Broker",           icon: "🕵", mech: "broker",   txt: "Exposed Vulnerability: each of your weak hits makes you take +10% damage (max +50%)." },
    { name: "Public S3 Leak",            icon: "🪣", mech: "s3",       txt: "Data Siphon: your strong hits give it a shield of 20% of that damage." },
    { name: "Deprecated API Dependency", icon: "🧩", mech: "api",      txt: "Breaking Change: below 50% HP its attack is ×1.4." },
    { name: "Ransomware Executive",      icon: "🔒", mech: "ransom",   txt: "Equipment Encryption: every 5th turn your ATK -20% until you land a 1.3×+ hit." },
    { name: "Corporate Audit Bot",       icon: "📋", mech: "audit",    txt: "Bureaucratic Brake: all your hits are pulled halfway towards average (All-in is weaker)." },
    { name: "Rogue Microservice Mesh",   icon: "🧬", mech: "mesh",     txt: "Cascade Failure: after hitting you 3 turns in a row its next hit is ×2." },
    { name: "Unstable Staging Env",      icon: "🧪", mech: "staging",  txt: "Environment Reset: every 4th turn it wipes all shields, buffs and debuffs." },
    { name: "Legacy Monolith Architect", icon: "🏛", mech: "monolith", txt: "Monolithic Armor: your hits under 1.0× only deal 40% damage." },
    { name: "The Big Massi",            icon: "👑", mech: "darkweb",  txt: "FINAL BOSS - Executive Override: below 30% HP his attack is ×2, but he burns 5% max HP per turn. The best boss you could ever ask for." }
  ];
  const PROMOS = [
    { id: "lead",  name: "Micromanager Team Lead",   icon: "📣", lvl: 10, mech: "lead",  reward: "tier2",   txt: "Quick Sync: every 4th turn ALL-IN is disabled for 2 turns.", unlock: "Unlocks career tier 2" },
    { id: "hr",    name: "HR Compliance Specialist", icon: "🧑‍💼", lvl: 15, mech: "hr",   reward: "slot",    txt: "Mandatory Team Building: after your strong hit or jackpot you are forced into SAFE for 1 turn.", unlock: "+1 artifact slot" },
    { id: "board", name: "Technical Board Review",   icon: "🧾", lvl: 20, mech: "board", reward: "tier3",   txt: "Budget Cuts: below 50% HP it cuts your ATK by 25%.", unlock: "Unlocks career tier 3" },
    { id: "cto",   name: "The CTO",                  icon: "🎩", lvl: 25, mech: "cto",   reward: "branch",  txt: "AI Paradigm Shift: every 3 turns it demands a stance - if you are not in it, it hits +60% harder.", unlock: "Choose your career branch" },
    { id: "bod",   name: "Board of Directors",       icon: "🏦", lvl: 30, mech: "bod",   reward: "exec",    txt: "Quarterly Goals: defeat it within 18 turns or the contract is terminated.", unlock: "EXECUTIVE title: +10% ATK/HP, +5% ticket multiplier" }
  ];

  function roman(n) { return n <= 1 ? "" : (["", "", " Mk II", " Mk III", " Mk IV", " Mk V", " Mk VI", " Mk VII", " Mk VIII", " Mk IX", " Mk X"][n] || (" Mk " + n)); }

  // Statistiky bosse pro patro F (vyladěno simulací: referenční hráč na patře F vyhrává ~65 %)
  // Referenční hráč: level = F, gear ATK/HP násobek = 1 + 0.06·F, bez artefaktů, kariéra tier 1, postoj NORMAL.
  // [HP, ATK] pro patra 1-100, vygenerováno simulací (tune.js); nad 100 exponenciálně
  let BOSS_TABLE = [[215,11.9],[295,14.6],[382,12.2],[477,19.3],[579,18],[688,19.6],[805,28.4],[929,36.3],[1060,43.8],[1199,53],[1345,58.9],[1498,55.7],[1658,71.9],[1826,66.1],[2001,83.7],[2183,99.1],[2372,82.3],[2569,113.2],[2773,85.7],[2985,124.7],[3204,175.9],[3430,173.2],[3663,121.3],[3903,161.4],[4151,127.7],[4406,121.5],[4669,165.3],[4939,194.8],[5216,212.5],[5500,240],[5792,256.4],[6090,220.6],[6397,271.1],[6710,242.1],[7031,286],[7359,328.2],[7694,270.8],[8037,348.2],[8387,261.5],[8744,366.1],[9108,495.2],[9480,473.4],[9859,326.5],[10246,422.9],[10639,325.3],[11040,306.9],[11449,413.5],[11864,461.3],[12287,505.2],[12717,557.3],[13154,573.2],[13599,483.2],[14051,589.4],[14510,523.8],[14977,604.7],[15451,690.8],[15932,558.2],[16420,714.4],[16916,515.2],[17419,720.5],[17929,1004.7],[18447,932],[18972,618.8],[19504,812.5],[20043,621.7],[20590,572.8],[21144,760.9],[21706,855],[22274,900.9],[22850,1003.3],[23433,1031],[24024,891.2],[24622,1033.6],[25227,915.3],[25839,1072.2],[26459,1184],[27086,951.6],[27720,1212],[28361,889.6],[29010,1222],[29666,1637.7],[30330,1552.7],[31000,1031.1],[31678,1326.7],[32364,998.3],[33056,921.1],[33756,1211.2],[34463,1360.1],[35177,1446.6],[35899,1560.7],[36628,1589],[37364,1349.6],[38108,1645.2],[38859,1400],[39617,1606.4],[40383,1816.3],[41155,1421.9],[41935,1865.9],[42723,1318.9],[43517,1807.7]];
  function bossFor(floor) {
    const b = BOSSES[(floor - 1) % 20];
    const t = bossStats(floor);
    return { floor: floor, name: b.name + roman(Math.ceil(floor / 20)), icon: b.icon, mech: b.mech, txt: b.txt, hp: t.hp, atk: t.atk, sprite: (floor - 1) % 20 };
  }
  const EASE = [0.72, 0.8, 0.87, 0.93, 0.97];          // první patra mírnější (nováček ještě nemá gear)
  function bossStats(floor) {
    if (BOSS_TABLE && floor <= BOSS_TABLE.length) { const r = BOSS_TABLE[floor - 1], e = EASE[floor - 1] || 1; return { hp: Math.round(r[0] * e), atk: Math.round(r[1] * e * 10) / 10 }; }
    // nad tabulkou: vezme vyladěné patro se STEJNÝM bossem z posledních 20 a přeškáluje ho podle síly referenčního hráče
    const N = BOSS_TABLE.length;
    const F0 = N - 20 + ((floor - 1) % 20) + 1;
    const refA = (F) => (15 + 4.5 * (F - 1)) * (1 + 0.06 * F), refH = (F) => (100 + 30 * (F - 1)) * (1 + 0.06 * F);
    const r = BOSS_TABLE[F0 - 1];
    return { hp: Math.round(r[0] * refA(floor) / refA(F0)), atk: Math.round(r[1] * refH(floor) / refH(F0) * 10) / 10 };
  }
  let PROMO_TABLE = {"lead":[1288,51.7],"hr":[2149,86.5],"board":[3206,110.5],"cto":[4459,125.1],"bod":[4481,300.9]};
  function promoBoss(id) {
    const p = PROMOS.find(x => x.id === id);
    const t = (PROMO_TABLE && PROMO_TABLE[id]) ? { hp: PROMO_TABLE[id][0], atk: PROMO_TABLE[id][1] } : bossStats(p.lvl);
    return { floor: 0, promo: p.id, name: p.name, icon: p.icon, mech: p.mech, txt: p.txt, hp: t.hp, atk: t.atk, sprite: 20 + PROMOS.indexOf(p) };
  }

  // ------------------------------------------------------------------ HRÁČ
  /** gear: { atk: násobek ze zbraní (TOOL/AUGMENT/RELIC), hp: násobek ze zbroje (HEAD/RIG/OS) } */
  function gearSlotValue(tier, lvl) { return 0.1 * Math.pow(tier, 1.3) * (1 + 0.2 * (lvl || 0)); }

  function buildPlayer(d, gear) {
    const L = Math.max(1, d.level || 1);
    const cls = d.cls || "sysadmin";
    const tier = d.tier || 1, branch = d.branch || "";
    const fx = { atk: 0, hp: 0, dodge: 0, jp: 0, bf: 0, bfDmg: 0, safeDef: 0, loot: 0, coin: 0 };
    (d.equipped || []).forEach(id => {
      const a = ARTIFACT_BY_ID[id]; if (!a) return;
      const f = 1 + 0.25 * (((d.artifacts || {})[id] || 1) - 1);
      Object.keys(a.fx).forEach(k => { fx[k] += a.fx[k] * (k === "coin" ? 1 : f); });
    });
    let atkMul = 1 + fx.atk, hpMul = 1 + fx.hp;
    if (cls === "engineer") { atkMul += 0.18; hpMul += 0.05; }
    if (cls === "sysadmin") hpMul += 0.04;
    if (d.exec) { atkMul += 0.10; hpMul += 0.10; }
    const maxHp = Math.round((100 + 30 * (L - 1)) * (gear ? gear.hp : 1) * hpMul);
    const atk = (15 + 4.5 * (L - 1)) * (gear ? gear.atk : 1) * atkMul;
    let dodge = (cls === "cyber" ? 0.17 : 0) + fx.dodge;
    dodge = Math.max(0, Math.min(0.35, dodge));
    return { cls: cls, tier: tier, branch: branch, level: L, maxHp: maxHp, atk: atk, dodge: dodge, fx: fx,
      shieldPct: cls === "sysadmin" ? 0.04 + (branch === "b" && tier >= 4 ? 0.08 : 0) : 0,
      loot: fx.loot + (cls === "cyber" ? 0.10 : 0) + (cls === "cyber" && tier >= 4 && branch === "a" ? 0.5 : 0) };
  }

  // ------------------------------------------------------------------ SOUBOJ
  function newFight(player, boss, seed) {
    const R = rng(seed || 1);
    const f = {
      R: R, p: player, b: boss, turn: 0, over: false, win: false, events: [],
      php: player.maxHp, shield: Math.round(player.maxHp * player.shieldPct),
      bhp: boss.hp, bmax: boss.hp, bshield: 0,
      atkBuff: 1, jam: false, jpDebuff: 0, weakStacks: 0, ransom: false, hitStreak: 0, lockLeft: 0, lockedStance: null,
      forceSafe: 0, ctoWant: null, sreHalf: false, revived: false, ciStacks: 0, prevMult: 0, dot: 0, ghost: false, allinBlock: 0,
      coin: 0
    };
    if (player.fx.coin) { f.coin = R() < 0.5 ? 0.25 : -0.15; f.atkBuff *= 1 + f.coin; }
    return f;
  }

  /** Které postoje teď smí hráč použít (zámky bossů). */
  function allowedStances(f) {
    if (f.lockLeft > 0) return [f.lockedStance];
    if (f.forceSafe > 0) return ["safe"];
    if (f.allinBlock > 0) return ["safe", "normal"];
    return ["safe", "normal", "allin"];
  }

  function rollRow(f, stance) {
    const p = f.p, R = f.R;
    let rows = TABLES[p.cls][stance].map(r => ({ p: r.p, m: r.m, k: r.k }));
    const take = (fromK, toK, amt) => {
      const a = rows.find(r => r.k === fromK), b = rows.find(r => r.k === toK);
      if (!a || !b) return;
      const x = Math.min(a.p, amt); a.p -= x; b.p += x;
    };
    // jackpot bonusy (artefakty, CI Burst) berou pravděpodobnost z nejslabšího řádku
    let jp = p.fx.jp + (p.cls === "engineer" && p.tier >= 3 ? f.ciStacks * 0.015 : 0);
    if (f.jpDebuff > 0) { const j = rows.find(r => r.k === "jp"); if (j) { const half = j.p / 2; j.p -= half; rows.find(r => r.k === "low").p += half; } }
    if (jp > 0) take("low", "jp", jp);
    if (p.cls === "cyber") take("low", "high", 0.04);
    if (stance === "allin") {
      let bf = p.fx.bf + (p.cls === "engineer" && p.tier >= 4 && p.branch === "a" ? 0.01 : 0);
      if (bf > 0) take("low", "bf", bf);
    }
    let r = R(), row = rows[rows.length - 1];
    for (const x of rows) { if (r < x.p) { row = x; break; } r -= x.p; }
    let m = row.m, k = row.k;
    if (p.cls === "engineer" && f.prevMult >= 1 && R() < 0.08) { m = f.prevMult; k = "copy"; }
    if (k === "jp" && p.cls === "engineer" && p.tier >= 4 && p.branch === "a") m *= 1.35;
    if (k === "low" && p.cls === "engineer" && p.tier >= 4 && p.branch === "b") m = Math.max(m, 0.6);
    if (k === "bf" && f.ghost) { k = "mid"; m = 1; }
    return { m: m, k: k };
  }

  function ev(f, type, val, extra) { const e = { t: f.turn, type: type, val: val }; if (extra) Object.assign(e, extra); f.events.push(e); return e; }

  function damagePlayer(f, dmg, src) {
    const p = f.p;
    if (p.cls === "sysadmin" && p.tier >= 4 && p.branch === "a" && f.sreHalf) { dmg *= 0.5; f.sreHalf = false; }
    dmg = Math.round(dmg);
    const s = Math.min(f.shield, dmg); f.shield -= s; dmg -= s;
    f.php -= dmg;
    if (f.php <= 0 && p.cls === "sysadmin" && !f.revived) { f.revived = true; f.php = Math.round(p.maxHp * 0.10); ev(f, "revive", f.php); }
    if (p.cls === "sysadmin" && p.tier >= 4 && p.branch === "a" && dmg + s > p.maxHp * 0.12) f.sreHalf = true;
    ev(f, "phit", dmg + s, { src: src, absorbed: s });
    return dmg + s;
  }

  function damageBoss(f, dmg, label) {
    dmg = Math.max(0, Math.round(dmg));
    const s = Math.min(f.bshield, dmg); f.bshield -= s;
    f.bhp -= (dmg - s);
    return dmg;
  }

  /** Jeden tah. stance = "safe" | "normal" | "allin". Vrací nové eventy. */
  function step(f, stance) {
    if (f.over) return [];
    const start = f.events.length;
    const p = f.p, b = f.b, R = f.R;
    f.turn++;
    const allowed = allowedStances(f);
    if (allowed.indexOf(stance) < 0) stance = allowed.indexOf("normal") >= 0 ? "normal" : allowed[0];
    const mech = b.mech;

    // --- začátek tahu: mechaniky
    if (mech === "staging" && f.turn % 4 === 0) {
      f.shield = 0; f.bshield = 0; f.atkBuff = 1 + f.coin; f.jam = false; f.jpDebuff = 0; f.weakStacks = 0; f.ransom = false; f.dot = 0; f.ghost = false;
      ev(f, "mech", 0, { msg: "ENVIRONMENT RESET - all buffs and shields wiped!" });
    }
    if (mech === "spaghetti" && f.turn % 5 === 0 && f.lockLeft <= 0) { f.lockLeft = 2; f.lockedStance = stance; ev(f, "mech", 0, { msg: "CABLE TRAP - stance locked for 2 turns!" }); }
    if (mech === "ransom" && f.turn % 5 === 0 && !f.ransom) { f.ransom = true; ev(f, "mech", 0, { msg: "EQUIPMENT ENCRYPTED - your ATK -20% until you land a 1.3× hit!" }); }
    if (mech === "lead" && f.turn % 4 === 0) { f.allinBlock = 2; ev(f, "mech", 0, { msg: "QUICK SYNC - ALL-IN disabled for 2 turns!" }); }
    if (mech === "cto" && f.turn % 3 === 1) { f.ctoWant = ["safe", "normal", "allin"][Math.floor(R() * 3)]; ev(f, "mech", 0, { msg: "CTO demands: " + f.ctoWant.toUpperCase() + "!", want: f.ctoWant }); }
    if (f.dot > 0) { const d = damageBoss(f, p.atk * 0.4); f.dot--; ev(f, "dot", d); }

    // --- útok hráče
    let mult = 0, kind = "mid", self = 0;
    if (f.jam) { f.jam = false; kind = "jam"; ev(f, "pattack", 0, { kind: "jam", stance: stance }); }
    else {
      const r = rollRow(f, stance);
      mult = r.m; kind = r.k;
      if (mech === "audit") mult = 1 + (mult - 1) * 0.5;
      let atk = p.atk * f.atkBuff * (f.ransom ? 0.8 : 1);
      if (mech === "board" && f.bhp < f.bmax * 0.5) atk *= 0.75;
      if (f.ghost) { atk *= 1.4; f.ghost = false; }
      let dmg = atk * mult;
      if (mech === "monolith" && mult < 1) dmg *= 0.4;
      if (mech === "dust") { const bd = 0.25 * (1 - f.bhp / f.bmax); if (R() < bd) { dmg = 0; kind = "bdodge"; } }
      if (kind === "bf") {
        self = p.atk * BACKFIRE_SELF[p.cls] * (1 + p.fx.bfDmg);
        if (p.cls === "engineer" && p.tier >= 2) self *= 0.7;
        if (p.cls === "sysadmin" && p.tier >= 3) { self *= 0.5; f.shield += Math.round(self); }
      }
      if (kind === "jp" && p.cls === "sysadmin" && p.tier >= 4 && p.branch === "b") dmg += f.shield * 2;
      const dealt = damageBoss(f, dmg);
      ev(f, "pattack", dealt, { kind: kind, mult: Math.round(mult * 100) / 100, stance: stance });
      if (self > 0) damagePlayer(f, self, "backfire");
      if (kind === "jp" && p.cls === "cyber" && p.tier >= 3) { f.dot = 3; ev(f, "mech", 0, { msg: "ZERO-DAY PAYLOAD injected!" }); }
      if (p.cls === "sysadmin" && p.tier >= 2 && stance === "safe" && mult >= 1) { const h = Math.round(p.maxHp * 0.04); f.php = Math.min(p.maxHp, f.php + h); ev(f, "heal", h); }
      if (p.cls === "engineer" && p.tier >= 3) f.ciStacks = mult >= 1 ? Math.min(4, f.ciStacks + 1) : 0;
      f.prevMult = mult >= 1 ? mult : 0;
      if (mech === "excel" && dealt > 0 && R() < 0.15) damagePlayer(f, dealt * 0.3, "reflect");
      if (mech === "broker" && mult < 0.8) f.weakStacks = Math.min(5, f.weakStacks + 1);
      if (mech === "s3" && mult >= 1.5) { f.bshield += Math.round(dealt * 0.2); ev(f, "mech", 0, { msg: "DATA SIPHON - boss gains a shield!" }); }
      if (mech === "ransom" && mult >= 1.3 && f.ransom) { f.ransom = false; ev(f, "mech", 0, { msg: "Decrypted! ATK restored." }); }
      if (mech === "hr" && (kind === "jp" || mult >= 1.6)) { f.forceSafe = 2; ev(f, "mech", 0, { msg: "MANDATORY TEAM BUILDING - forced into SAFE!" }); }
      if (mech === "llm" && (kind === "jp" || mult >= 1.6) && f.bhp > 0) { ev(f, "mech", 0, { msg: "HALLUCINATION COUNTER!" }); bossHit(f, b.atk * (0.5 + R()), "counter", stance); }
    }
    if (f.php <= 0) return finish(f, false, start);
    if (f.bhp <= 0) return finish(f, true, start);

    // --- útok bosse
    let skip = false;
    if (mech === "router" && f.turn % 4 === 0) { skip = true; ev(f, "mech", 0, { msg: "Signal dropped - the router skips its attack." }); }
    if (!skip) {
      if (mech === "ddos") { for (let i = 0; i < 3; i++) bossHit(f, b.atk * 0.4, "packet", stance); }
      else {
        let a = b.atk;
        if (mech === "dust") a *= 0.5 + 0.5 * (f.bhp / f.bmax);
        if (mech === "cron") a *= (f.turn % 4 === 0 ? 2.6 : 0.6);
        if (mech === "leak") a *= 1 + 0.08 * (f.turn - 1);
        if (mech === "api" && f.bhp < f.bmax * 0.5) a *= 1.4;
        if (mech === "darkweb" && f.bhp < f.bmax * 0.3) a *= 2;
        if (mech === "mesh" && f.hitStreak >= 3) { a *= 2; f.hitStreak = 0; ev(f, "mech", 0, { msg: "CASCADE FAILURE!" }); }
        if (mech === "cto" && f.ctoWant && stance !== f.ctoWant) a *= 1.6;
        bossHit(f, a, "hit", stance);
      }
    }
    if (mech === "cobol" && f.turn % 4 === 0) { const h = Math.round(f.bmax * 0.12); f.bhp = Math.min(f.bmax, f.bhp + h); ev(f, "bheal", h); }
    if (mech === "darkweb" && f.bhp < f.bmax * 0.3) { const d = Math.round(f.bmax * 0.05); f.bhp -= d; ev(f, "mech", d, { msg: "Self-destruct: the boss burns " + d + " HP." }); }

    // --- konec tahu
    if (f.lockLeft > 0) f.lockLeft--;
    if (f.forceSafe > 0) f.forceSafe--;
    if (f.allinBlock > 0) f.allinBlock--;
    if (f.jpDebuff > 0) f.jpDebuff--;
    if (f.php <= 0) return finish(f, false, start);
    if (f.bhp <= 0) return finish(f, true, start);
    if (mech === "bod" && f.turn >= 18) { ev(f, "mech", 0, { msg: "QUARTERLY GOALS MISSED - contract terminated!" }); return finish(f, false, start); }
    if (f.turn >= 60) { ev(f, "mech", 0, { msg: "Overtime - the boss escaped." }); return finish(f, false, start); }
    return f.events.slice(start);
  }

  function bossHit(f, a, src, stance) {
    const p = f.p, R = f.R;
    if (R() < p.dodge) {
      ev(f, "dodge", 0, { src: src });
      if (p.cls === "cyber" && p.tier >= 2) { const d = damageBoss(f, a * 0.4); ev(f, "reflect", d); }
      if (p.cls === "cyber" && p.tier >= 4 && p.branch === "b") f.ghost = true;
      f.hitStreak = 0;
      return;
    }
    let d = a * (0.85 + 0.3 * R());
    if (f.b.mech === "broker") d *= 1 + 0.1 * f.weakStacks;
    if (stance === "safe" && p.fx.safeDef) d *= 1 - p.fx.safeDef;
    damagePlayer(f, d, src);
    f.hitStreak++;
    if (f.b.mech === "printer" && R() < 0.25) { f.jam = true; ev(f, "mech", 0, { msg: "PAPER JAM - your next attack is blocked!" }); }
    if (f.b.mech === "miner") f.jpDebuff = 2;
  }

  function finish(f, win, start) {
    f.over = true; f.win = win;
    f.php = Math.max(0, f.php); f.bhp = Math.max(0, f.bhp);
    ev(f, win ? "win" : "lose", 0);
    return f.events.slice(start);
  }

  /** Celý souboj s pevnou strategií (pro simulace). policy(f) -> stance */
  function simulate(player, boss, seed, policy) {
    const f = newFight(player, boss, seed);
    while (!f.over) step(f, typeof policy === "function" ? policy(f) : (policy || "normal"));
    return f;
  }

  // ------------------------------------------------------------------ ARÉNA: duel hráč vs hráč (počítá server, klient jen přehrává)
  const PVP_HP = 2.0;                       // v aréně mají oba víc HP, ať duel trvá ~10-16 akcí
  function duel(A, B, seed, stA, stB) {
    const R = rng(seed || 1);
    const mk = (p, st) => {
      const hp = Math.round(p.maxHp * PVP_HP);
      return { p: p, R: R, stance: st || "normal", hp: hp, max: hp, shield: Math.round(hp * p.shieldPct), ciStacks: 0, prevMult: 0, ghost: false,
        jpDebuff: 0, revived: false, dot: 0, sreHalf: false, atkBuff: p.fx.coin ? (R() < 0.5 ? 1.25 : 0.85) : 1 };
    };
    const S = [mk(A, stA), mk(B, stB)];
    const events = [];
    const snap = () => [Math.max(0, S[0].hp), Math.max(0, S[1].hp)];
    const shs = () => [S[0].shield, S[1].shield];
    const push = (e) => { e.hp = snap(); e.sh = shs(); events.push(e); };
    const hurt = (side, dmg) => {
      const p = side.p;
      if (p.cls === "sysadmin" && p.tier >= 4 && p.branch === "a" && side.sreHalf) { dmg *= 0.5; side.sreHalf = false; }
      dmg = Math.round(dmg);
      const sh = Math.min(side.shield, dmg); side.shield -= sh; side.hp -= dmg - sh;
      let revived = false;
      if (side.hp <= 0 && p.cls === "sysadmin" && !side.revived) { side.revived = true; side.hp = Math.round(side.max * 0.10); revived = true; }
      if (p.cls === "sysadmin" && p.tier >= 4 && p.branch === "a" && dmg > side.max * 0.12) side.sreHalf = true;
      return { dmg: dmg, absorbed: sh, revived: revived };
    };
    let turn = 0, cur = R() < 0.5 ? 0 : 1;
    const first = cur;
    while (turn < 60) {
      turn++;
      const a = S[cur], d = S[1 - cur];
      if (d.dot > 0) { d.dot--; const x = hurt(d, a.p.atk * 0.4); push({ t: turn, i: cur, type: "dot", val: x.dmg }); if (d.hp <= 0) break; }
      const r = rollRow(a, a.stance);
      if (r.k === "bf") {
        let self = a.p.atk * BACKFIRE_SELF[a.p.cls] * (1 + a.p.fx.bfDmg);
        if (a.p.cls === "engineer" && a.p.tier >= 2) self *= 0.7;
        if (a.p.cls === "sysadmin" && a.p.tier >= 3) { self *= 0.5; a.shield += Math.round(self); }
        const x = hurt(a, self);
        push({ t: turn, i: cur, type: "bf", val: x.dmg, rev: x.revived });
        a.prevMult = 0; a.ciStacks = 0;
      } else if (r.m > 0 && R() < d.p.dodge) {
        push({ t: turn, i: cur, type: "dodge" });
        if (d.p.cls === "cyber" && d.p.tier >= 2) { const x = hurt(a, a.p.atk * r.m * 0.4); push({ t: turn, i: 1 - cur, type: "reflect", val: x.dmg }); }
        if (d.p.cls === "cyber" && d.p.tier >= 4 && d.p.branch === "b") d.ghost = true;
      } else {
        let atk = a.p.atk * a.atkBuff;
        if (a.ghost) { atk *= 1.4; a.ghost = false; }
        let dmg = atk * r.m;
        if (r.k === "jp" && a.p.cls === "sysadmin" && a.p.tier >= 4 && a.p.branch === "b") dmg += a.shield * 2;
        const x = hurt(d, dmg);
        push({ t: turn, i: cur, type: "hit", val: x.dmg, kind: r.k, mult: Math.round(r.m * 100) / 100, abs: x.absorbed, rev: x.revived });
        if (r.k === "jp" && a.p.cls === "cyber" && a.p.tier >= 3) d.dot = 3;
        if (a.p.cls === "sysadmin" && a.p.tier >= 2 && a.stance === "safe" && r.m >= 1) { const h = Math.round(a.max * 0.04); a.hp = Math.min(a.max, a.hp + h); push({ t: turn, i: cur, type: "heal", val: h }); }
        if (a.p.cls === "engineer" && a.p.tier >= 3) a.ciStacks = r.m >= 1 ? Math.min(4, a.ciStacks + 1) : 0;
        a.prevMult = r.m >= 1 ? r.m : 0;
      }
      if (S[0].hp <= 0 || S[1].hp <= 0) break;
      cur = 1 - cur;
    }
    let winner;
    if (S[0].hp <= 0 && S[1].hp <= 0) winner = 1;              // oba padli (backfire) - vyhrává obránce
    else if (S[0].hp <= 0) winner = 1;
    else if (S[1].hp <= 0) winner = 0;
    else winner = (S[0].hp / S[0].max >= S[1].hp / S[1].max) ? 0 : 1;   // limit tahů: rozhodne % HP
    return { win: winner === 0, winner: winner, first: first, turns: turn, events: events, max: [S[0].max, S[1].max], hp: snap() };
  }

  /** síla postavy (pro řazení soupeřů v aréně) */
  function power(p) { return Math.round(Math.sqrt(p.atk * p.maxHp) * (1 + p.dodge)); }

  // ------------------------------------------------------------------ PROGRESE
  function xpToNext(L) { return 75 + 30 * L; }
  function winXp(floor, first) { return Math.round((30 + 12 * floor) * (first ? 2.5 : 1)); }
  function refGear(floor) { return 1 + 0.06 * floor; }

  const api = {
    rng: rng, TABLES: TABLES, tableEV: tableEV, CLASSES: CLASSES, ARTIFACTS: ARTIFACTS, ARTIFACT_BY_ID: ARTIFACT_BY_ID, artifactText: artifactText,
    BOSSES: BOSSES, PROMOS: PROMOS, bossFor: bossFor, bossStats: bossStats, promoBoss: promoBoss, setBossTable: function (t, pt) { BOSS_TABLE = t; if (pt) PROMO_TABLE = pt; },
    gearSlotValue: gearSlotValue, buildPlayer: buildPlayer, newFight: newFight, step: step, allowedStances: allowedStances, simulate: simulate,
    xpToNext: xpToNext, winXp: winXp, refGear: refGear, duel: duel, power: power, PVP_HP: PVP_HP
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DungeonEngine = api;
})(typeof window !== "undefined" ? window : this);

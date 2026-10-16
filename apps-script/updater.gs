/**
 * IDLE_ROYALE_UPDATER - automatická aktualizace backendu z GitHubu.
 * Každých 10 min stáhne apps-script/code.gs z repa; když se změnil, nahraje ho do projektu,
 * vytvoří novou verzi a přepne na ni stávající nasazení (URL zůstává). Při změně webu (index.html)
 * nebo backendu udělá Bump version, takže se hráčům hra sama obnoví.
 * Tenhle soubor updater sám nikdy nepřepisuje. Nastavení: jednou spusť setupUpdater.
 */
var UPD = {
  REPO: 'Stenfordd/Idle-Ticket-Royal',
  BRANCH: 'main',
  DEPLOYMENT_ID: 'AKfycbzof6xaHiWtrDrnwAoqW4VPgiJdmHQUzG-sSvEp9MOfNqfdu_hQMpx-IFPzYq61uTmp7A',
  MARK: 'IDLE_ROYALE_UPDATER'
};

/** Spusť jednou: nastaví kontrolu každých 10 minut a hned zkontroluje (a nasadí) nejnovější verzi. */
function setupUpdater() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkForUpdate') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkForUpdate').timeBased().everyMinutes(10).create();
  var r = checkForUpdate(true);
  Logger.log(r);
  return r;
}

/** Ruční aktualizace hned teď (nasadí backend z GitHubu, i když se nezměnil). */
function updateNow() { var r = checkForUpdate(true); Logger.log(r); return r; }

/** Volá časovač. force === true jen při ručním spuštění. */
function checkForUpdate(force) {
  force = force === true;
  var cache = CacheService.getScriptCache();
  if (cache.get('upd_busy')) return 'busy';
  cache.put('upd_busy', '1', 240);
  var props = PropertiesService.getScriptProperties(), msg;
  try {
    var src = updRaw_('apps-script/code.gs');
    if (src.indexOf('function doPost') < 0 || src.length < 5000) throw new Error('downloaded code.gs looks wrong (' + src.length + ' chars)');
    var ver = '';
    try { ver = updSha_(updRaw_('index.html')).slice(0, 10); } catch (e) {}
    var h = updSha_(src), done = [];
    if (force || h !== props.getProperty('UPD_GS_HASH')) {
      var info = updDeploy_(src, ver);
      props.setProperty('UPD_GS_HASH', h);
      done.push('backend (' + info + ')');
    }
    if (ver && ver !== props.getProperty('UPD_WEB_VER')) { props.setProperty('UPD_WEB_VER', ver); done.push('web ' + ver); }
    if (done.length) {
      try { bumpAppVersion_(); } catch (e) { done.push('bump failed: ' + e.message); }
      msg = 'UPDATED: ' + done.join(' + ');
    } else msg = 'up to date';
  } catch (e) {
    msg = 'ERROR: ' + (e && e.message ? e.message : e);
  } finally {
    cache.remove('upd_busy');
  }
  updStatus_(msg);
  return msg;
}

function updDeploy_(src, ver) {
  var content = updApi_('get', '/content');
  var out = [], target = null, dropped = [];
  (content.files || []).forEach(function (f) {
    var keep = f.type !== 'SERVER_JS' || (f.source || '').indexOf(UPD.MARK) >= 0;
    if (keep) out.push({ name: f.name, type: f.type, source: f.source, functionSet: f.functionSet });
    else if (!target) { target = f.name; out.push({ name: f.name, type: 'SERVER_JS', source: src }); }
    else dropped.push(f.name);                       // backend je jeden soubor (code.gs už obsahuje engine)
  });
  if (!target) { target = 'code'; out.push({ name: 'code', type: 'SERVER_JS', source: src }); }
  out.forEach(function (f) { if (!f.functionSet) delete f.functionSet; });
  updApi_('put', '/content', { files: out });
  var v = updApi_('post', '/versions', { description: 'auto-update ' + ver });
  updApi_('put', '/deployments/' + UPD.DEPLOYMENT_ID, {
    deploymentConfig: { scriptId: ScriptApp.getScriptId(), versionNumber: v.versionNumber, manifestFileName: 'appsscript', description: 'auto-update ' + ver + ' (v' + v.versionNumber + ')' }
  });
  return 'v' + v.versionNumber + ', file "' + target + '"' + (dropped.length ? ', removed ' + dropped.join(',') : '');
}

function updRaw_(path) {
  var url = 'https://raw.githubusercontent.com/' + UPD.REPO + '/' + UPD.BRANCH + '/' + path + '?t=' + Date.now();
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (r.getResponseCode() !== 200) throw new Error('GitHub ' + path + ': HTTP ' + r.getResponseCode());
  return r.getContentText('UTF-8');
}

function updApi_(method, path, body) {
  var opt = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var r = UrlFetchApp.fetch('https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId() + path, opt);
  var code = r.getResponseCode(), txt = r.getContentText();
  if (code >= 300) throw new Error('Apps Script API ' + method.toUpperCase() + ' ' + path + ' -> HTTP ' + code + ': ' + txt.slice(0, 400));
  return txt ? JSON.parse(txt) : {};
}

function updSha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

/** Výsledek poslední kontroly je vidět v listu Config, řádek 9. */
function updStatus_(msg) {
  try {
    var cfg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Config');
    if (cfg) cfg.getRange('A9:B9').setValues([['Updater', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') + ' ' + msg]]);
  } catch (e) {}
}

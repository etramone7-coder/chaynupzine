/***** PROJECT CONFIG ****************************************************/
var CONFIG = {
  SPREADSHEET_ID       : '1-lBO2HC-CqD2h4HUHyTxgfggISh2TRqx06fmzMz03yA',
  SHEET_RECORDS        : 'Records',
  SHEET_LIVES          : 'Lives',
  SHEET_FEATURES       : 'Features',
  SHEET_REPORTS        : 'Reports',
  UPLOAD_FOLDER_ID     : '1HBxSyBZCIKUvRy0HmGFrfSh4TvM0OwzL',
  REPORT_WINDOW_DAYS   : 7,
  REPORT_HIDE_THRESHOLD: 5,
  RATE_LIMIT_MINUTES   : 5,
  ADMIN_TOKEN          : '',
  NG_TERMS             : [
    'kill','die','rape','suicide','terror','bomb',
    'fuck','cunt','asshole',
    'nazi','kkk','white power',
    'retard','spic','chink','gook','fag'
  ]
};

/***** SHEET HEADERS ****************************************************/
var RECORDS_HEADERS = [
  'timestamp','band','track','genre','country',
  'description','description_en','image_url','youtube_url','author',
  'release_year','catalog_no','format',
  'band_sort','band_initial',
  'edit_key_hash','is_hidden'
];

var LIVES_HEADERS = [
  'timestamp','artist','title','date','open_time','start_time','venue',
  'prefecture','region','price','reference_url','description','image_url',
  'youtube_url','author','status',
  'band_sort','band_initial',
  'edit_key_hash','is_hidden'
];

var FEATURES_HEADERS = [
  'timestamp','status','title','author','genre','genre_other','era','region',
  'para1_text','p1_img1_url','p1_img2_url','p1_img3_url','youtube1',
  'para2_text','p2_img1_url','p2_img2_url','p2_img3_url','youtube2',
  'para3_text','p3_img1_url','p3_img2_url','p3_img3_url','youtube3',
  'para4_text','p4_img1_url','p4_img2_url','p4_img3_url','youtube4',
  'para5_text','p5_img1_url','p5_img2_url','p5_img3_url','youtube5',
  'subject','subject_sort','subject_initial','slug','updated_at',
  'edit_key_hash','is_hidden'
];

var REPORTS_HEADERS = [
  'timestamp','sheet','row_index','reason','client_id','count_7d'
];

/***** WEB UI ************************************************************/
function doGet(e) {
  var p = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : '';
  var page = 'home';
  if (p === 'records_browse' || p === 'records.browse') page = 'records_browse';
  else if (p === 'home') page = 'home';
  else if (p === 'search_records' || p === 'records_search' || p === 'records.search') page = 'search_records';

  var t = HtmlService.createTemplateFromFile(page);
  t.EXEC_URL = ScriptApp.getService().getUrl();

  // ★ 追加：records_browse に row をサーバ側から埋め込む（クエリ解析に頼らない）
  if (page === 'records_browse') t.ROW = (e && e.parameter && e.parameter.row) ? String(e.parameter.row) : '';

  return t.evaluate()
    .setTitle('CHAYNUPZINE')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/***** RATE LIMIT *******************************************************/
function rateLimitGuard_(kind, clientId){
  if(!clientId) return;
  var key = 'rl:'+kind+':'+clientId;
  var cache = CacheService.getScriptCache();
  if(cache.get(key)) throw new Error('Please wait a few minutes before posting again.');
  cache.put(key, String(Date.now()), CONFIG.RATE_LIMIT_MINUTES*60);
}

/***** NG WORD FILTER ***************************************************/
function enforceNgWords_(fields, excludeKeys){
  excludeKeys = excludeKeys || {};
  var terms = CONFIG.NG_TERMS || [];
  if(!terms.length) return;
  var text = (fields||[]).map(function(v){ return String(v||''); }).join('\n').toLowerCase();
  if(excludeKeys.band)  text = text.replace(String(excludeKeys.band).toLowerCase(), '');
  if(excludeKeys.track) text = text.replace(String(excludeKeys.track).toLowerCase(), '');
  if(excludeKeys.title) text = text.replace(String(excludeKeys.title).toLowerCase(), '');
  for(var i=0;i<terms.length;i++){
    var w = String(terms[i]||'').toLowerCase();
    if(w && text.indexOf(w)>=0) throw new Error('NGワードに該当する表現が含まれています。');
  }
}

/***** RECORDS: submit **************************************************/
function submitFromClient(payload){
  try{
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.SHEET_RECORDS) || ss.insertSheet(CONFIG.SHEET_RECORDS);
    ensureCoreHeaders_(sh, RECORDS_HEADERS);
    rateLimitGuard_('records', payload && payload.client_id);
    enforceNgWords_([
      payload.description, payload.description_en, payload.genre, payload.country,
      payload.author, payload.format, payload.catalog_no
    ], { band:payload.band, track:payload.track });

    var imageUrl = (payload.image_url || '').trim();
    if(!imageUrl && payload.image_data && /^data:/.test(payload.image_data)){
      var blob = dataUrlToBlob_(payload.image_data);
      imageUrl = saveToDriveAndGetPublicUrl_(blob, 'rec_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
    }else if(imageUrl){ imageUrl = normalizeDriveUrl_(imageUrl); }

    var bandSort    = normalizeBand_(payload.band || '');
    var bandInitial = bandInitial_(bandSort);
    var editHash    = hashEditKey_(payload.edit_key || '');

    var H = buildHeaderIndex_(sh);
    var row = sh.getLastRow() + 1;
    function set(k, v){ var c = H[k]; if(c) sh.getRange(row, c).setValue(v); }
    set('timestamp', new Date());
    set('band', (payload.band || '').trim());
    set('track', (payload.track || '').trim());
    set('genre', (payload.genre || '').trim());
    set('country', (payload.country || '').trim());
    set('description', (payload.description || '').trim());
    set('description_en', (payload.description_en || '').trim());
    set('image_url', imageUrl);
    set('youtube_url', (payload.youtube_url || '').trim());
    set('author', (payload.author || '').trim());
    set('release_year', (payload.release_year || '').trim());
    set('catalog_no', (payload.catalog_no || '').trim());
    set('format', (payload.format || '').trim());
    set('band_sort', bandSort);
    set('band_initial', bandInitial);
    set('edit_key_hash', editHash);
    set('is_hidden', false);
    return { ok:true, imageUrl:imageUrl, rowIndex:row };
  }catch(err){ return { ok:false, error:String(err) }; }
}

/***** LIVES: submit *****************************************************/
function submitLive(payload){
  try{
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.SHEET_LIVES) || ss.insertSheet(CONFIG.SHEET_LIVES);
    ensureCoreHeaders_(sh, LIVES_HEADERS);
    rateLimitGuard_('lives', payload && payload.client_id);
    enforceNgWords_([
      payload.title, payload.description, payload.venue, payload.price,
      payload.reference_url, payload.prefecture, payload.author
    ], { band:payload.artist });

    var imageUrl = (payload.image_url || '').trim();
    if(!imageUrl && payload.image_data && /^data:/.test(payload.image_data)){
      var blob = dataUrlToBlob_(payload.image_data);
      imageUrl = saveToDriveAndGetPublicUrl_(blob, 'live_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
    }else if(imageUrl){ imageUrl = normalizeDriveUrl_(imageUrl); }

    var pref   = (payload.prefecture || '').trim();
    var region = prefectureToRegion_(pref);

    var bandSort    = normalizeBand_(payload.artist || '');
    var bandInitial = bandInitial_(bandSort);
    var editHash    = hashEditKey_(payload.edit_key || '');

    var H = buildHeaderIndex_(sh);
    var row = sh.getLastRow() + 1;
    function set(k, v){ var c = H[k]; if(c) sh.getRange(row, c).setValue(v); }

    set('timestamp',   new Date());
    set('artist',      (payload.artist || '').trim());
    set('title',       (payload.title  || '').trim());
    set('date',        (payload.date   || '').trim());
    set('open_time',   (payload.open_time  || '').trim());
    set('start_time',  (payload.start_time || '').trim());
    set('venue',       (payload.venue  || '').trim());
    set('prefecture',   pref);
    set('region',       region);
    set('price',       (payload.price  || '').trim());
    set('reference_url',(payload.reference_url || '').trim());
    set('description', (payload.description  || '').trim());
    set('image_url',   imageUrl);
    set('youtube_url', (payload.youtube_url || '').trim());
    set('author',      (payload.author || '').trim());
    set('status',      (payload.status || 'scheduled').trim());
    set('band_sort',   bandSort);
    set('band_initial',bandInitial);
    set('edit_key_hash', editHash);
    set('is_hidden',     false);

    return { ok:true, imageUrl:imageUrl, rowIndex:row };
  }catch(err){ return { ok:false, error:String(err) }; }
}

/***** FEATURES: submit **************************************************/
function submitFeature(payload){
  try{
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.SHEET_FEATURES) || ss.insertSheet(CONFIG.SHEET_FEATURES);
    ensureCoreHeaders_(sh, FEATURES_HEADERS);
    rateLimitGuard_('features', payload && payload.client_id);
    enforceNgWords_([
      payload.author, payload.genre, payload.genre_other, payload.era,
      payload.region,
      payload.para1_text, payload.para2_text, payload.para3_text,
      payload.para4_text, payload.para5_text
    ], { title: payload.title });

    var subject = (payload.title || '').trim();
    if ((payload.genre || '') === 'other' && (payload.genre_other || '').trim()) {
      subject = payload.genre_other.trim();
    }
    var subjectSort    = normalizeBand_(subject || '');
    var subjectInitial = bandInitial_(subjectSort);

    var slug = (payload.slug || '').trim();
    if (!slug) slug = createSlug_(subject || Utilities.getUuid());

    function ensureImageUrl(keyBase) {
      var urlKey  = keyBase + '_url';
      var dataKey = keyBase + '_data';
      var url  = (payload[urlKey]  || '').trim();
      var data = (payload[dataKey] || '');
      if (!url && data && /^data:/.test(data)) {
        var blob = dataUrlToBlob_(data);
        url = saveToDriveAndGetPublicUrl_(blob, keyBase + '_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
      } else if (url) {
        url = normalizeDriveUrl_(url);
      }
      return url;
    }

    var p = {};
    for (var i = 1; i <= 5; i++) {
      for (var j = 1; j <= 3; j++) {
        var keyBase = 'p' + i + '_img' + j;
        p[keyBase + '_url'] = ensureImageUrl(keyBase);
      }
    }

    var editHash = hashEditKey_(payload.edit_key || '');

    var H = buildHeaderIndex_(sh);
    var row = sh.getLastRow() + 1;
    function set(k, v){ var c = H[k]; if (c) sh.getRange(row, c).setValue(v); }

    set('timestamp', new Date());
    set('status',   (payload.status || 'published').trim());
    set('title',    (payload.title  || '').trim());
    set('author',   (payload.author || '').trim());
    set('genre',    (payload.genre  || '').trim());
    set('genre_other', (payload.genre_other || '').trim());
    set('era',         (payload.era    || '').trim());
    set('region',      (payload.region || '').trim());

    for (var k = 1; k <= 5; k++) {
      set('para' + k + '_text', (payload['para' + k + '_text'] || '').trim());
      for (var m = 1; m <= 3; m++) {
        set('p' + k + '_img' + m + '_url', p['p' + k + '_img' + m + '_url'] || '');
      }
      set('youtube' + k, (payload['youtube' + k] || '').trim());
    }

    set('subject',         subject);
    set('subject_sort',    subjectSort);
    set('subject_initial', subjectInitial);
    set('slug',            slug);
    set('updated_at',      new Date());
    set('edit_key_hash',   editHash);
    set('is_hidden',       false);

    return { ok: true, rowIndex: row, slug: slug };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/***** EDIT / DELETE *****************************************************/
function editEntry(params) {
  try {
    var sheetName = String(params.sheetName || '').trim();
    var rowIndex  = Number(params.rowIndex || 0);
    var editKey   = String(params.edit_key || '').trim();
    var action    = String(params.action  || '').trim();
    if (!sheetName || !rowIndex || !editKey || !action) throw new Error('bad request');

    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(sheetName);
    if (!sh) throw new Error('sheet missing');

    var H = buildHeaderIndex_(sh);
    var vals = sh.getRange(rowIndex, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];

    var curHash = (H['edit_key_hash'] ? String(vals[H['edit_key_hash'] - 1] || '') : '');
    var inHash  = hashEditKey_(editKey);
    if (!curHash || curHash !== inHash) throw new Error('編集キーが違います');

    if (action === 'delete') {
      if (sheetName === CONFIG.SHEET_FEATURES && H['status']) {
        sh.getRange(rowIndex, H['status']).setValue('hidden');
      } else if (H['is_hidden']) {
        sh.getRange(rowIndex, H['is_hidden']).setValue(true);
      }
      sh.getRange(rowIndex, H['updated_at'] || H['timestamp'] || 1).setValue(new Date());
      return { ok: true, action: 'hidden' };
    }

    if (action === 'unhide') {
      if (sheetName === CONFIG.SHEET_FEATURES && H['status']) {
        var cur = String(vals[H['status'] - 1] || '');
        if (cur === 'hidden') sh.getRange(rowIndex, H['status']).setValue('published');
      } else if (H['is_hidden']) {
        sh.getRange(rowIndex, H['is_hidden']).setValue(false);
      }
      sh.getRange(rowIndex, H['updated_at'] || H['timestamp'] || 1).setValue(new Date());
      return { ok: true, action: 'unhidden' };
    }

    if (action === 'update') {
      var p = params.payload || {};
      var set = function(k, v){ var c = H[k]; if (c) sh.getRange(rowIndex, c).setValue(v); };
      var now = new Date();

      if (sheetName === CONFIG.SHEET_RECORDS) {
        var img = (p.image_url || '').trim();
        if (!img && p.image_data && /^data:/.test(p.image_data)) {
          var blob = dataUrlToBlob_(p.image_data);
          img = saveToDriveAndGetPublicUrl_(blob, 'rec_upd_' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
        } else if (img) {
          img = normalizeDriveUrl_(img);
        }
        set('band', (p.band || '').trim());
        set('track', (p.track || '').trim());
        set('genre', (p.genre || '').trim());
        set('country', (p.country || '').trim());
        set('description', (p.description || '').trim());
        set('description_en', (p.description_en || '').trim());
        set('image_url', img);
        set('youtube_url', (p.youtube_url || '').trim());
        set('release_year', (p.release_year || '').trim());
        set('catalog_no', (p.catalog_no || '').trim());
        set('format', (p.format || '').trim());
        var bsort = normalizeBand_(p.band || '');
        set('band_sort', bsort);
        set('band_initial', bandInitial_(bsort));
      }

      if (sheetName === CONFIG.SHEET_LIVES) {
        var img2 = (p.image_url || '').trim();
        if (!img2 && p.image_data && /^data:/.test(p.image_data)) {
          var blob2 = dataUrlToBlob_(p.image_data);
          img2 = saveToDriveAndGetPublicUrl_(blob2, 'live_upd_' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
        } else if (img2) {
          img2 = normalizeDriveUrl_(img2);
        }
        set('artist', (p.artist || '').trim());
        set('title', (p.title || '').trim());
        set('date', (p.date || '').trim());
        set('open_time', (p.open_time || '').trim());
        set('start_time', (p.start_time || '').trim());
        set('venue', (p.venue || '').trim());
        set('prefecture', (p.prefecture || '').trim());
        set('region', prefectureToRegion_(p.prefecture || ''));
        set('price', (p.price || '').trim());
        set('reference_url', (p.reference_url || '').trim());
        set('description', (p.description || '').trim());
        set('image_url', img2);
        set('youtube_url', (p.youtube_url || '').trim());
        set('status', (p.status || 'scheduled').trim());
        var s2 = normalizeBand_(p.artist || '');
        set('band_sort', s2);
        set('band_initial', bandInitial_(s2));
      }

      if (sheetName === CONFIG.SHEET_FEATURES) {
        set('title', (p.title || '').trim());
        set('author', (p.author || '').trim());
        set('genre', (p.genre || '').trim());
        set('genre_other', (p.genre_other || '').trim());
        set('era', (p.era || '').trim());
        set('region', (p.region || '').trim());
        for (var i = 1; i <= 5; i++) {
          set('para' + i + '_text', (p['para' + i + '_text'] || '').trim());
          for (var j = 1; j <= 3; j++) {
            var kb = 'p' + i + '_img' + j;
            var u = (p[kb + '_url'] || '').trim();
            if (!u && p[kb + '_data'] && /^data:/.test(p[kb + '_data'])) {
              var bl = dataUrlToBlob_(p[kb + '_data']);
              u = saveToDriveAndGetPublicUrl_(bl, kb + '_upd_' + Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
            } else if (u) {
              u = normalizeDriveUrl_(u);
            }
            set(kb + '_url', u);
          }
          set('youtube' + i, (p['youtube' + i] || '').trim());
        }
        var subj = (p.title || '').trim();
        if ((p.genre || '') === 'other' && (p.genre_other || '').trim()) subj = p.genre_other.trim();
        var ssrt = normalizeBand_(subj || '');
        set('subject', subj);
        set('subject_sort', ssrt);
        set('subject_initial', bandInitial_(ssrt));
        if (p.slug) set('slug', createSlug_(p.slug));
        set('updated_at', now);
      }

      return { ok: true, action: 'updated' };
    }

    throw new Error('unsupported action');
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/***** REPORTS ***********************************************************/
function submitReport(payload) {
  try {
    var sheetName = String(payload.sheetName || '').trim();
    var rowIndex  = Number(payload.rowIndex || 0);
    var reason    = String(payload.reason   || '').trim();
    var clientId  = String(payload.client_id|| '').trim();
    if (!sheetName || !rowIndex || !reason) throw new Error('bad request');

    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var rep = ss.getSheetByName(CONFIG.SHEET_REPORTS) || ss.insertSheet(CONFIG.SHEET_REPORTS);
    ensureCoreHeaders_(rep, REPORTS_HEADERS);

    var RH = buildHeaderIndex_(rep);
    var rrow = rep.getLastRow() + 1;
    rep.getRange(rrow, RH['timestamp']).setValue(new Date());
    rep.getRange(rrow, RH['sheet']).setValue(sheetName);
    rep.getRange(rrow, RH['row_index']).setValue(rowIndex);
    rep.getRange(rrow, RH['reason']).setValue(reason);
    rep.getRange(rrow, RH['client_id']).setValue(clientId);

    var since = new Date(Date.now() - CONFIG.REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    var allR = rep.getRange(2, 1, Math.max(0, rep.getLastRow() - 1), Math.max(1, rep.getLastColumn())).getValues();
    var cnt = 0;
    for (var i = 0; i < allR.length; i++) {
      var item = allR[i], map = {};
      for (var k in RH) map[k] = RH[k] ? item[RH[k] - 1] : '';
      if (String(map.sheet) === sheetName && Number(map.row_index) === rowIndex) {
        var ts = map.timestamp instanceof Date ? map.timestamp : new Date(map.timestamp);
        if (ts >= since) cnt++;
      }
    }
    rep.getRange(rrow, RH['count_7d']).setValue(cnt);

    if (cnt >= CONFIG.REPORT_HIDE_THRESHOLD) {
      var sh = ss.getSheetByName(sheetName);
      if (sh) {
        var H = buildHeaderIndex_(sh);
        if (sheetName === CONFIG.SHEET_FEATURES && H['status']) sh.getRange(rowIndex, H['status']).setValue('hidden');
        else if (H['is_hidden']) sh.getRange(rowIndex, H['is_hidden']).setValue(true);
        if (H['updated_at']) sh.getRange(rowIndex, H['updated_at']).setValue(new Date());
      }
      return { ok: true, autoHidden: true, count: cnt };
    }
    return { ok: true, autoHidden: false, count: cnt };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/***** ADMIN *************************************************************/
function toggleVisibilityAdmin(payload) {
  try {
    if (!CONFIG.ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not set');
    if (String(payload.token || '') !== CONFIG.ADMIN_TOKEN) throw new Error('forbidden');

    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(String(payload.sheetName || '').trim());
    if (!sh) throw new Error('sheet missing');

    var H = buildHeaderIndex_(sh);
    if (payload.sheetName === CONFIG.SHEET_FEATURES && H['status']) {
      sh.getRange(payload.rowIndex, H['status']).setValue(payload.visible ? 'published' : 'hidden');
    } else if (H['is_hidden']) {
      sh.getRange(payload.rowIndex, H['is_hidden']).setValue(!payload.visible);
    }
    if (H['updated_at']) sh.getRange(payload.rowIndex, H['updated_at']).setValue(new Date());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/***** SEARCH (Records) **************************************************/
function listRecords(params) {
  params = params || {};
  var genre   = String(params.genre   || '').trim();
  var country = String(params.country || '').trim();
  var era     = String(params.era     || '').trim();
  var initial = String(params.initial || '').trim();
  var limit   = Math.max(1, Math.min(200, Number(params.limit  || 18)));
  var offset  = Math.max(0, Number(params.offset || 0));

  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SHEET_RECORDS);
  if (!sh) return { ok: true, items: [], total: 0, offset: 0, limit: limit };

  var H = buildHeaderIndex_(sh);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, items: [], total: 0, offset: 0, limit: limit };

  function matchEra(y, eraStr) {
    if (!eraStr) return true;
    if (!y) return false;
    var m = /^(\d{4})s$/i.exec(String(eraStr));
    if (!m) return false;
    var base = parseInt(m[1], 10);
    var yyMatch = String(y).match(/(\d{4})/);
    if (!yyMatch) return false;
    var yy = parseInt(yyMatch[1], 10);
    if (isNaN(yy)) return false;
    return (yy >= base && yy <= base + 9);
  }

  var data = sh.getRange(2, 1, lastRow - 1, Math.max(1, sh.getLastColumn())).getValues();
  var items = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    function gv(h){ var c = H[h]; return c ? row[c - 1] : ''; }

    if (gv('is_hidden') === true) continue;
    if (genre   && String(gv('genre')  || '').toLowerCase()   !== genre.toLowerCase()) continue;
    if (country && String(gv('country')|| '').toLowerCase()   !== country.toLowerCase()) continue;
    if (era     && !matchEra(gv('release_year'), era)) continue;
    if (initial) {
      var iniStored = String(gv('band_initial') || '').toUpperCase();
      var calcIni = bandInitial_(normalizeBand_(String(gv('band') || '')));
      var ini = (iniStored || calcIni).toUpperCase();
      if (ini !== initial.toUpperCase()) continue;
    }

    var ts = gv('timestamp');
    var tsStr = (ts instanceof Date)
      ? Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX")
      : (ts ? String(ts) : '');

    items.push({
      rowIndex     : i + 2,
      band         : String(gv('band') || ''),
      track        : String(gv('track') || ''),
      genre        : String(gv('genre') || ''),
      country      : String(gv('country') || ''),
      image_url    : normalizeDriveUrl_(String(gv('image_url') || '')),
      description  : String(gv('description') || ''),
      release_year : String(gv('release_year') || ''),
      catalog_no   : String(gv('catalog_no') || ''),
      format       : String(gv('format') || ''),
      author       : String(gv('author') || ''),
      band_initial : String((gv('band_initial') || '') || bandInitial_(normalizeBand_(String(gv('band') || '')))),
      youtube_url  : String(gv('youtube_url') || ''),
      timestamp    : tsStr
    });
  }

  var total = items.length;
  var sliced = items.slice(offset, offset + limit);
  return { ok: true, items: sliced, total: total, offset: offset, limit: limit };
}

/***** SEARCH (Lives) ****************************************************/
function listLives(params) {
  params = params || {};
  var prefecture = String(params.prefecture || '').trim();
  var region     = String(params.region     || '').trim();
  var initial    = String(params.initial    || '').trim();
  var status     = String(params.status     || '').trim();
  var date_from  = String(params.date_from  || '').trim();
  var date_to    = String(params.date_to    || '').trim();
  var limit      = Math.max(1, Math.min(200, Number(params.limit  || 24)));
  var offset     = Math.max(0, Number(params.offset || 0));

  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SHEET_LIVES);
  if (!sh) return { ok: true, items: [], total: 0, offset: 0, limit: limit };

  var H = buildHeaderIndex_(sh);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, items: [], total: 0, offset: 0, limit: limit };

  function inDateRange(dstr) {
    if (!date_from && !date_to) return true;
    if (!dstr) return false;
    var d = new Date(dstr); if (isNaN(d.getTime())) return false;
    if (date_from) { var df = new Date(date_from); if (!isNaN(df.getTime()) && d < df) return false; }
    if (date_to)   { var dt = new Date(date_to);   if (!isNaN(dt.getTime()) && d > dt) return false; }
    return true;
  }

  var data = sh.getRange(2, 1, lastRow - 1, Math.max(1, sh.getLastColumn())).getValues();
  var items = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    function gv(h){ var c = H[h]; return c ? row[c - 1] : ''; }

    if (gv('is_hidden') === true) continue;
    if (prefecture && String(gv('prefecture') || '') !== prefecture) continue;
    if (region     && String(gv('region')     || '') !== region) continue;
    if (status     && String(gv('status')     || '').toLowerCase() !== status.toLowerCase()) continue;
    if (initial) {
      var iniStored = String(gv('band_initial') || '').toUpperCase();
      var calcIni = bandInitial_(normalizeBand_(String(gv('artist') || '')));
      var ini = (iniStored || calcIni).toUpperCase();
      if (ini !== initial.toUpperCase()) continue;
    }
    if (!inDateRange(gv('date'))) continue;

    items.push({
      rowIndex     : i + 2,
      artist       : String(gv('artist') || ''),
      title        : String(gv('title') || ''),
      date         : String(gv('date') || ''),
      open_time    : String(gv('open_time') || ''),
      start_time   : String(gv('start_time') || ''),
      venue        : String(gv('venue') || ''),
      prefecture   : String(gv('prefecture') || ''),
      region       : String(gv('region') || ''),
      price        : String(gv('price') || ''),
      reference_url: String(gv('reference_url') || ''),
      description  : String(gv('description') || ''),
      image_url    : normalizeDriveUrl_(String(gv('image_url') || '')),
      youtube_url  : String(gv('youtube_url') || ''),
      author       : String(gv('author') || ''),
      status       : String(gv('status') || ''),
      band_initial : String((gv('band_initial') || '') || bandInitial_(normalizeBand_(String(gv('artist') || '')))),
      timestamp    : String(gv('timestamp') || '')
    });
  }

  var total = items.length;
  var sliced = items.slice(offset, offset + limit);
  return { ok: true, items: sliced, total: total, offset: offset, limit: limit };
}

/***** SEARCH (Features) *************************************************/
function listFeatures(params) {
  params = params || {};
  var genre   = String(params.genre   || '').trim();
  var era     = String(params.era     || '').trim();
  var initial = String(params.initial || '').trim();
  var limit   = Math.max(1, Math.min(200, Number(params.limit || 50)));
  var offset  = Math.max(0, Number(params.offset || 0));

  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SHEET_FEATURES);
  if (!sh) return { ok: true, items: [], total: 0, offset: 0, limit: limit };

  var H = buildHeaderIndex_(sh);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: true, items: [], total: 0, offset: 0, limit: limit };

  var data = sh.getRange(2, 1, lastRow - 1, Math.max(1, sh.getLastColumn())).getValues();
  var items = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    function gv(h){ var c = H[h]; return c ? row[c - 1] : ''; }

    if (String(gv('status') || '').toLowerCase() === 'hidden') continue;
    if (gv('is_hidden') === true) continue;
    if (String(gv('status') || '').toLowerCase() && String(gv('status') || '').toLowerCase() !== 'published') continue;

    if (genre && String(gv('genre')).toLowerCase() !== genre.toLowerCase()) continue;
    if (era   && String(gv('era')).toLowerCase()   !== era.toLowerCase())   continue;
    if (initial) {
      var iniStored = String(gv('subject_initial') || '').toUpperCase();
      var calcIni = bandInitial_(normalizeBand_(String(gv('subject') || '')));
      var ini = (iniStored || calcIni).toUpperCase();
      if (ini !== initial.toUpperCase()) continue;
    }

    items.push({
      rowIndex   : i + 2,
      title      : String(gv('title') || ''),
      author     : String(gv('author') || ''),
      genre      : String(gv('genre') || ''),
      era        : String(gv('era') || ''),
      subject    : String(gv('subject') || ''),
      subject_initial: String((gv('subject_initial') || '') || bandInitial_(normalizeBand_(String(gv('subject') || '')))),
      timestamp  : String(gv('timestamp') || ''),
      slug       : String(gv('slug') || '')
    });
  }

  var total = items.length;
  var sliced = items.slice(offset, offset + limit);
  return { ok: true, items: sliced, total: total, offset: offset, limit: limit };
}

/***** FEATURE detail ****************************************************/
function getFeatureById(param) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SHEET_FEATURES);
  if (!sh) return { ok: false, error: 'Features sheet missing' };

  var H = buildHeaderIndex_(sh);
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { ok: false, error: 'No data' };

  if (param && param.rowIndex) {
    var r = Number(param.rowIndex);
    if (r >= 2 && r <= lastRow) {
      var vals = sh.getRange(r, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
      return { ok: true, rowIndex: r, data: rowToObject_(vals, H) };
    }
  }
  if (param && param.slug) {
    var colSlug = H['slug'];
    if (colSlug) {
      var rng = sh.getRange(2, colSlug, lastRow - 1, 1).getValues();
      for (var i = 0; i < rng.length; i++) {
        if (String(rng[i][0] || '') === String(param.slug || '')) {
          var rr = i + 2;
          var vals2 = sh.getRange(rr, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0];
          return { ok: true, rowIndex: rr, data: rowToObject_(vals2, H) };
        }
      }
    }
  }
  return { ok: false, error: 'not found' };
}

/***** RECORDS detail (for records_browse.html) **************************/
function getRecordByRow(rowIndex){
  try{
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    var sh = ss.getSheetByName(CONFIG.SHEET_RECORDS);
    if(!sh) return { ok:false, error:'Records sheet missing' };
    var H = buildHeaderIndex_(sh);
    var last = sh.getLastRow();
    var r = Number(rowIndex||0);
    if(!(r>=2 && r<=last)) return { ok:false, error:'row out of range' };
    var row = sh.getRange(r,1,1,Math.max(1,sh.getLastColumn())).getValues()[0];
    function gv(h){ var c=H[h]; return c ? row[c-1] : ''; }
    var data = {
      band        : String(gv('band')||''),
      track       : String(gv('track')||''),
      genre       : String(gv('genre')||''),
      country     : String(gv('country')||''),
      description : String(gv('description')||''),
      description_en : String(gv('description_en')||''),
      image_url   : normalizeDriveUrl_(String(gv('image_url')||'')),
      youtube_url : String(gv('youtube_url')||''),
      author      : String(gv('author')||''),
      release_year: String(gv('release_year')||''),
      catalog_no  : String(gv('catalog_no')||''),
      format      : String(gv('format')||'')
    };
    return { ok:true, data:data };
  }catch(err){
    return { ok:false, error:String(err) };
  }
}

/***** SHEETS HELPERS ****************************************************/
function ensureCoreHeaders_(sh, headers){
  var last = Math.max(1, sh.getLastColumn());
  var vals = sh.getRange(1, 1, 1, last).getValues()[0];
  var out  = vals.slice(0), changed = false;
  for (var i = 0; i < headers.length; i++) {
    if (out[i] !== headers[i]) { out[i] = headers[i]; changed = true; }
  }
  if (changed) {
    sh.getRange(1, 1, 1, headers.length).setValues([out.slice(0, headers.length)]);
    sh.setFrozenRows(1);
  }
}

function buildHeaderIndex_(sh){
  var last = Math.max(1, sh.getLastColumn());
  var headers = sh.getRange(1, 1, 1, last).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim();
    if (h && !map[h]) map[h] = i + 1;
  }
  return map;
}

function rowToObject_(vals, H){
  var obj = {};
  var keys = Object.keys(H);
  for (var i=0;i<keys.length;i++){
    var k = keys[i];
    obj[k] = vals[ H[k]-1 ];
  }
  return obj;
}

/***** DRIVE / IMAGE HELPERS ********************************************/
function dataUrlToBlob_(dataUrl){
  var m = String(dataUrl).match(/^data:(.+?);base64,(.+)$/);
  if(!m) throw new Error('Bad dataURL');
  var mime = m[1];
  var bytes = Utilities.base64Decode(m[2]);
  return Utilities.newBlob(bytes, mime, 'upload');
}

function saveToDriveAndGetPublicUrl_(blob, baseName){
  var folder = DriveApp.getFolderById(CONFIG.UPLOAD_FOLDER_ID);
  var ext = mimeToExt_(blob.getContentType());
  var file = folder.createFile(blob.copyBlob().setName(baseName + (ext ? ('.'+ext) : '')));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function normalizeDriveUrl_(url){
  try{
    var id = extractDriveId_(url);
    return id ? ('https://drive.google.com/uc?export=view&id=' + id) : url;
  }catch(_){ return url; }
}
function extractDriveId_(url){
  var s = String(url||'');
  var m = s.match(/\/file\/d\/([a-zA-Z0-9_-]+)/); if(m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);         if(m) return m[1];
  return '';
}
function mimeToExt_(mime){
  mime = String(mime||'').toLowerCase();
  if(mime.indexOf('jpeg')>=0 || mime.indexOf('jpg')>=0) return 'jpg';
  if(mime.indexOf('png') >=0) return 'png';
  if(mime.indexOf('webp')>=0) return 'webp';
  if(mime.indexOf('gif') >=0) return 'gif';
  if(mime.indexOf('heic')>=0 || mime.indexOf('heif')>=0) return 'heic';
  return '';
}

/***** AUTH / DIAG *******************************************************/
function touchAuthOnce(){
  DriveApp.getFolderById(CONFIG.UPLOAD_FOLDER_ID).getName();
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var shR = ss.getSheetByName(CONFIG.SHEET_RECORDS)  || ss.insertSheet(CONFIG.SHEET_RECORDS);
  var shL = ss.getSheetByName(CONFIG.SHEET_LIVES)    || ss.insertSheet(CONFIG.SHEET_LIVES);
  var shF = ss.getSheetByName(CONFIG.SHEET_FEATURES) || ss.insertSheet(CONFIG.SHEET_FEATURES);
  var shP = ss.getSheetByName(CONFIG.SHEET_REPORTS)  || ss.insertSheet(CONFIG.SHEET_REPORTS);
  ensureCoreHeaders_(shR, RECORDS_HEADERS);
  ensureCoreHeaders_(shL, LIVES_HEADERS);
  ensureCoreHeaders_(shF, FEATURES_HEADERS);
  ensureCoreHeaders_(shP, REPORTS_HEADERS);
  return { drive: true, sheets: true };
}

/***** TEXT NORMALIZE / REGION / SLUG / HASH ****************************/
function normalizeBand_(name){
  if(!name) return '';
  var s = String(name).trim();
  s = s.replace(/^(the\s+|ザ\s*|ｻﾞ\s*)/i, '');
  s = s.replace(/^[\s\W_]+/, '');
  return s;
}
function bandInitial_(s){
  var c = (s || '').charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : '#';
}
var JP_REGIONS = {
  '北海道・東北': ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県'],
  '関東': ['茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県'],
  '中部': ['新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県'],
  '近畿': ['三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県'],
  '中国': ['鳥取県','島根県','岡山県','広島県','山口県'],
  '四国': ['徳島県','香川県','愛媛県','高知県'],
  '九州・沖縄': ['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県']
};
function prefectureToRegion_(pref){
  if(!pref) return '';
  for (var r in JP_REGIONS) { if (JP_REGIONS[r].indexOf(pref) >= 0) return r; }
  return '';
}
function createSlug_(s){
  s = String(s || '').toLowerCase();
  s = s.replace(/[ぁ-ん]/g, '');
  s = s.normalize('NFKD').replace(/[^\w\s-]/g, '');
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-');
  return s.substring(0, 64).replace(/^-+|-+$/g, '') || Utilities.getUuid().slice(0, 8);
}
function hashEditKey_(key){
  key = String(key || '').trim();
  if (!key) return '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8);
  return Utilities.base64Encode(bytes);
}

/***** DIAG: ping / probe ***********************************************/
function pingRecords() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(CONFIG.SHEET_RECORDS);
  if (!sh) return { ok: false, error: 'Records sheet missing' };
  var last = Math.max(1, sh.getLastColumn());
  var headers = sh.getRange(1, 1, 1, last).getValues()[0].map(function(v){ return String(v || ''); });
  return { ok: true, sheetName: sh.getName(), lastRow: sh.getLastRow(), lastColumn: sh.getLastColumn(), headers: headers };
}

function probeRecords(params) {
  params = params || {};
  params.limit = Math.min(5, Number(params.limit || 5));
  params.offset = Number(params.offset || 0);
  var res = listRecords(params);
  if (!res || !res.ok) return { ok: false, error: 'listRecords failed' };
  var sample = (res.items || []).map(function(it){
    return {
      rowIndex : it.rowIndex,
      band     : String(it.band || ''),
      track    : String(it.track || ''),
      country  : String(it.country || ''),
      genre    : String(it.genre || ''),
      image_url: String(it.image_url || ''),
      author   : String(it.author || ''),
      timestamp: String(it.timestamp || '')
    };
  });
  return { ok: true, total: Number(res.total || 0), sample: sample };
}

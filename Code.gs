/***** ChaynupZine — Core Apps Script (.gs) *****
 * 目的：
 *  - doGet/doPost API ルーティング
 *  - Records/Lives/Features/Reports をヘッダー名ベースで読み書き
 *  - 画像DataURLはDrive保存し公開URL返却
 *  - 編集更新時の反映不具合を回避
 *  - Features は edit_key_hash / edit_key 両対応
 ************************************************/

const SPREADSHEET_ID = '1-lBO2HC-CqD2h4HUHyTxgfggISh2TRqx06fmzMz03yA';
const SHEETS = {
  Records: 'Records',
  Lives: 'Lives',
  Features: 'Features',
  Reports: 'Reports'
};
const REPORT_AUTOHIDE_THRESHOLD = 3;

/* === Security/RateLimit === */
const SEC_STRICT = false;
const ALLOWED_IMAGE_MIMES = ['image/jpeg','image/png','image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RATE_POST_MIN_INTERVAL_MS   = 5 * 60 * 1000;
const RATE_REPORT_MIN_INTERVAL_MS = 1 * 60 * 1000;
const NG_TERMS = ["kill","die","rape","suicide","terror","bomb","fuck","cunt","asshole","nazi","kkk","white power","retard","spic","chink","gook","fag"];

/* ========== doGet / doPost ========== */
function doGet(e) {
  try{
    const p = (e && e.parameter) || {};
    if (p.fn) {
      const fn = String(p.fn || '').trim();
      const payload = p.payload ? JSON.parse(p.payload) : {};
      const map = {
        submitFromClient, listRecords, getRecordByRow,
        submitLive, listLives, editEntry,
        submitFeature, listFeatures, getFeatureById,
        submitReport
      };
      if (!map[fn]) {
        return ContentService.createTextOutput(JSON.stringify({ok:false,error:'unknown fn'}))
          .setMimeType(ContentService.MimeType.JSON);
      }
      const res = map[fn](payload);
      return ContentService.createTextOutput(JSON.stringify(res || {ok:true}))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }catch(err){
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const page = (e && e.parameter && e.parameter.page) || 'home';
  const allow = new Set([
    'home',
    'search_records','records_browse',
    'submit','submit_live','submit_feature',
    'search_lives','lives_browse',
    'search_features','features_browse'
  ]);
  const file = allow.has(page) ? page : 'home';
  const t = HtmlService.createTemplateFromFile(file);
  t.EXEC_URL = ScriptApp.getService().getUrl();

  const clientId = (e && e.parameter && e.parameter.client_id) || '';
  const csrfTok = issueCsrfToken_(clientId);

  const out = t.evaluate()
    .setTitle('CHAYNUPZINE')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  out.append('<script>window.__CZ_CSRF=' + JSON.stringify(csrfTok) + ';</script>');
  return out;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData && e.postData.contents || '{}');
    const fn = String(body.fn || '').trim();
    const payload = body.payload || {};

    if (SEC_STRICT) {
      const okCsrf = verifyCsrfToken_(String(body.csrf || ''));
      if (!okCsrf) {
        return ContentService.createTextOutput(JSON.stringify({ok:false,error:'bad csrf'}))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (!fn) {
      return ContentService.createTextOutput(JSON.stringify({ok:false,error:'no fn'}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const map = {
      submitFromClient, listRecords, getRecordByRow,
      submitLive, listLives, editEntry,
      submitFeature, listFeatures, getFeatureById,
      submitReport
    };
    if (!map[fn]) {
      return ContentService.createTextOutput(JSON.stringify({ok:false,error:'unknown fn'}))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const res = map[fn](payload);
    return ContentService.createTextOutput(JSON.stringify(res || {ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ========== Utilities ========== */
function getSheet(name){
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
}

function readAll(name){
  const sh = getSheet(name);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const head = vals[0];
  return vals.slice(1).map((row,i)=>{
    const o = {};
    head.forEach((h,idx)=>o[String(h||'')] = row[idx]);
    o.rowIndex = i + 2;
    return o;
  });
}

function appendRowByHeader(name, obj){
  const sh = getSheet(name);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const row = head.map(h => Object.prototype.hasOwnProperty.call(obj, h) ? obj[h] : '');
  sh.appendRow(row);
  return sh.getLastRow();
}

function updateRowByHeader(name, rowIndex, patch){
  const sh = getSheet(name);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const cur = sh.getRange(rowIndex,1,1,head.length).getValues()[0];
  const map = {};
  head.forEach((h,i)=>map[String(h||'')] = i);
  Object.keys(patch).forEach(k=>{
    if (Object.prototype.hasOwnProperty.call(map, k)) cur[map[k]] = patch[k];
  });
  sh.getRange(rowIndex,1,1,head.length).setValues([cur]);
}

function ensureFolder_(...names){
  let f = DriveApp.getRootFolder();
  names.forEach(n=>{
    const it = f.getFoldersByName(n);
    f = it.hasNext() ? it.next() : f.createFolder(n);
  });
  return f;
}

function getHeaderMap_(sheetName){
  const sh = getSheet(sheetName);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(h=>String(h||''));
  const map = {};
  head.forEach((h,i)=>map[h]=i);
  return { sh, head, map };
}

/* === Cache Helpers === */
function _cacheVersion_(){
  const p = PropertiesService.getScriptProperties();
  const v = p.getProperty('CACHE_VER');
  if (v) return v;
  p.setProperty('CACHE_VER', '1');
  return '1';
}

function _bumpCacheVersion_(){
  const p = PropertiesService.getScriptProperties();
  p.setProperty('CACHE_VER', String(Date.now()));
}

function _cacheKey_(prefix, obj){
  return prefix + ':v=' + _cacheVersion_() + ':' + JSON.stringify(obj || {});
}

/* === Security Helpers === */
function _rateLimitAllowNow(kind, clientId, minIntervalMs){
  try{
    if(!clientId) return true;
    const cache = CacheService.getScriptCache();
    const key = 'rl:'+kind+':'+String(clientId);
    const last = cache.get(key);
    const now = Date.now();
    if(last){
      const diff = now - Number(last);
      if(diff < minIntervalMs) return false;
    }
    cache.put(key, String(now), Math.ceil(minIntervalMs/1000));
    return true;
  }catch(_){ return true; }
}

function _isPrivateHost(host){
  if(!host) return true;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.startsWith('127.')) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  return false;
}

function _isAllowedHttpUrl(u){
  try{
    const s = String(u||'').trim();
    if(!s) return true;
    if(/^data:|^javascript:|^file:|^about:|^chrome:|^vbscript:/i.test(s)) return false;
    const url = new URL(s);
    if(url.protocol !== 'https:') return false;
    if(_isPrivateHost(url.hostname)) return false;
    return true;
  }catch(_){ return false; }
}

function _normalizeYouTube(u){
  try{
    if(!u) return '';
    const s = String(u).trim();
    const m1 = s.match(/youtu\.be\/([\w-]{6,})/);
    const m2 = s.match(/[?&]v=([\w-]{6,})/);
    const m3 = s.match(/youtube\.com\/shorts\/([\w-]{6,})/);
    const id = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || '';
    return id ? ('https://www.youtube.com/watch?v=' + id) : '';
  }catch(_){ return ''; }
}

function _serverNgCheck(text){
  try{
    const low = String(text||'').toLowerCase();
    return NG_TERMS.some(w => low.indexOf(w) >= 0);
  }catch(_){ return false; }
}

/* === CSRF === */
function issueCsrfToken_(clientId){
  try{
    const tok = Utilities.getUuid().replace(/-/g,'');
    CacheService.getScriptCache().put('csrf:'+tok, clientId || '1', 2 * 60 * 60);
    return tok;
  }catch(_){
    return Utilities.getUuid().replace(/-/g,'');
  }
}

function verifyCsrfToken_(tok){
  try{
    if(!tok) return false;
    const v = CacheService.getScriptCache().get('csrf:'+String(tok));
    return !!v;
  }catch(_){ return false; }
}

/* === DataURL 保存 === */
function saveDataUrl(dataUrl, kindFolder){
  if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return '';
  const m = String(dataUrl).match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if(!m) return '';
  const mime = m[1];
  if (SEC_STRICT && ALLOWED_IMAGE_MIMES.indexOf(mime) < 0) {
    throw new Error('image mime not allowed');
  }
  const bin = Utilities.base64Decode(m[2]);
  if (SEC_STRICT && bin.length > MAX_IMAGE_BYTES) {
    throw new Error('image too large');
  }
  const blob = Utilities.newBlob(bin, mime, 'image');
  const folder = ensureFolder_('CHAYNUPZINE_Images', kindFolder);
  const file = folder.createFile(blob);
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(_){}
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function decadeFromYearStr(y){
  const m = String(y||'').match(/(\d{4})/);
  if(!m) return '';
  const yy = Number(m[1]);
  if(!yy) return '';
  return (Math.floor(yy/10)*10) + 's';
}

function asciiInitial(s){
  let t = String(s||'').trim().replace(/^(the)\s+/i, '');
  const ch = (t[0]||'').toUpperCase();
  if(!ch) return '';
  return /[A-Z]/.test(ch) ? ch : '#';
}

function containsCi(hay, needle){
  return String(hay||'').toLowerCase().indexOf(String(needle||'').toLowerCase()) >= 0;
}

/* === Drive共有URL 正規化 === */
function normalizeDriveUrl_(u){
  try{
    const s = String(u||'').trim();
    if(!s) return '';
    if (/^https:\/\/drive\.google\.com\/uc\?export=view&id=/.test(s)) return s;

    let m = s.match(/https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m && m[1]) return 'https://drive.google.com/uc?export=view&id=' + m[1];

    m = s.match(/https:\/\/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]{20,})/);
    if (m && m[1]) return 'https://drive.google.com/uc?export=view&id=' + m[1];

    m = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (m && m[1] && s.indexOf('drive.google.com') >= 0) {
      return 'https://drive.google.com/uc?export=view&id=' + m[1];
    }

    return s;
  }catch(_){ return String(u||''); }
}

/* === 一覧キャッシュ === */
function _getCacheJSON_(key){
  try{
    const s = CacheService.getScriptCache().get(key);
    return s ? JSON.parse(s) : null;
  }catch(_){ return null; }
}

function _putCacheJSON_(key, obj, ttlSec){
  try{
    CacheService.getScriptCache().put(key, JSON.stringify(obj), ttlSec || 30);
  }catch(_){}
}

/* === Hash Helpers for Features === */
function _sha256Hex_(s){
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(s||''),
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('');
}

function _sha256Base64_(s){
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(s||''),
    Utilities.Charset.UTF_8
  );
  return Utilities.base64Encode(bytes);
}

function _editKeyMatch_(storedHash, inputKey){
  const stored = String(storedHash||'').trim();
  const key = String(inputKey||'').trim();
  if(!stored || !key) return false;
  if(stored === key) return true;
  if(stored === _sha256Hex_(key)) return true;
  if(stored === _sha256Base64_(key)) return true;
  return false;
}

/* === Patch alias normalize === */
function _normalizePatchKeys_(sheetName, patch){
  const p = {};
  Object.keys(patch || {}).forEach(k => p[k] = patch[k]);

  if (sheetName === SHEETS.Records){
    if (p.releaseYear != null && p.release_year == null) p.release_year = p.releaseYear;
    if (p.catalogNo != null && p.catalog_no == null) p.catalog_no = p.catalogNo;
    if (p.imageUrl != null && p.image_url == null) p.image_url = p.imageUrl;
    if (p.youtubeUrl != null && p.youtube_url == null) p.youtube_url = p.youtubeUrl;
    if (p.desc != null && p.description == null) p.description = p.desc;
    if (p.descEn != null && p.description_en == null) p.description_en = p.descEn;
  }

  else if (sheetName === SHEETS.Lives){
    if (p.openTime != null && p.open_time == null) p.open_time = p.openTime;
    if (p.startTime != null && p.start_time == null) p.start_time = p.startTime;
    if (p.titleEn != null && p.title_en == null) p.title_en = p.titleEn;
    if (p.venueEn != null && p.venue_en == null) p.venue_en = p.venueEn;
    if (p.regionEn != null && p.region_en == null) p.region_en = p.regionEn;
    if (p.prefectureEn != null && p.prefecture_en == null) p.prefecture_en = p.prefectureEn;
    if (p.priceEn != null && p.price_en == null) p.price_en = p.priceEn;
    if (p.descriptionEn != null && p.description_en == null) p.description_en = p.descriptionEn;
    if (p.imageUrl != null && p.image_url == null) p.image_url = p.imageUrl;
    if (p.youtubeUrl != null && p.youtube_url == null) p.youtube_url = p.youtubeUrl;
    if (p.desc != null && p.description == null) p.description = p.desc;
    if (p.descEn != null && p.description_en == null) p.description_en = p.descEn;
  }

  else if (sheetName === SHEETS.Features){
    if (p.titleEn != null && p.title_en == null) p.title_en = p.titleEn;
    for (var i=1; i<=5; i++){
      if (p['para' + i + 'Text'] != null && p['para' + i + '_text'] == null) {
        p['para' + i + '_text'] = p['para' + i + 'Text'];
      }
      if (p['para' + i + 'TextEn'] != null && p['para' + i + '_text_en'] == null) {
        p['para' + i + '_text_en'] = p['para' + i + 'TextEn'];
      }
    }
  }

  return p;
}

/* ========== Records ========== */
function submitFromClient(p){
  try{
    if(SEC_STRICT && !_rateLimitAllowNow('post_records', p.client_id||'', RATE_POST_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length < 8){
      return {ok:false,error:'invalid edit_key'};
    }
    if (p.image_url && !_isAllowedHttpUrl(p.image_url)) {
      return {ok:false, error:'invalid image_url'};
    }

    const yt = _normalizeYouTube(p.youtube_url||'');
    const ngTxt = [p.description||'', p.description_en||'', p.author||''].join('\n');
    if(SEC_STRICT && _serverNgCheck(ngTxt)){
      return {ok:false, error:'ng word detected'};
    }

    let descJa = p.description || '';
    let descEn = p.description_en || '';
    try{
      if (!descEn && descJa) descEn = LanguageApp.translate(descJa, 'ja', 'en');
      if (!descJa && descEn) descJa = LanguageApp.translate(descEn, 'en', 'ja');
    }catch(_){}

    const imgUrl = p.image_url ? normalizeDriveUrl_(p.image_url) : '';

    const bandVal = p.band || '';
    const bandSortVal = String(bandVal).trim().replace(/^(the)\s+/i, '').toLowerCase();
    const t = String(bandVal).trim().replace(/^(the)\s+/i, '');
    const ch = (t[0] || '').toUpperCase();
    const bandInitialVal = /[A-Z]/.test(ch) ? ch : '#';

    const row = {
      timestamp: new Date(),
      genre: p.genre||'',
      country: p.country||'',
      band: bandVal,
      track: p.track||'',
      release_year: p.release_year||'',
      catalog_no: p.catalog_no||'',
      format: p.format||'',
      description: descJa,
      description_en: descEn,
      image_url: imgUrl || (p.image_data ? saveDataUrl(p.image_data, 'Records') : ''),
      youtube_url: yt,
      author: p.author||'',
      band_sort: bandSortVal,
      band_initial: bandInitialVal,
      edit_key: p.edit_key||'',
      is_hidden: false
    };

    if(!row.band || !row.track || !row.genre || !row.country || !row.edit_key){
      return {ok:false, error:'missing required'};
    }

    appendRowByHeader(SHEETS.Records, row);
    _bumpCacheVersion_();
    return {ok:true};
  }catch(e){
    return {ok:false, error:String(e)};
  }
}

function listRecords(q){
  try{
    q = q || {};
    const key = _cacheKey_('records:list', {
      g:(q.genre||'').trim(),
      c:(q.country||'').trim(),
      e:(q.era||'').trim(),
      i:(q.initial||'').trim(),
      l:Number(q.limit||20),
      o:Number(q.offset||0)
    });
    const cached = _getCacheJSON_(key);
    if (cached) return cached;

    const all = readAll(SHEETS.Records).filter(r => !String(r.is_hidden||'').match(/true/i));

    const genre   = (q.genre   || '').trim();
    const country = (q.country || '').trim();
    const era     = (q.era     || '').trim();
    const initial = (q.initial || '').trim();

    const limit = Number(q.limit||20);
    const offset = Number(q.offset||0);

    const filtered = all.filter(r=>{
      if (genre   && String(r.genre||'').trim() !== genre) return false;
      if (country && String(r.country||'').trim() !== country) return false;
      if (era){
        const de = decadeFromYearStr(String(r.release_year||'').trim());
        if (de !== era) return false;
      }
      if (initial){
        const ini = asciiInitial(r.band);
        if (ini !== initial) return false;
      }
      return true;
    });

    const items = filtered.slice(offset, offset+limit).map(r=>({
      rowIndex: r.rowIndex,
      band: r.band,
      track: r.track,
      country: r.country,
      genre: r.genre,
      image_url: r.image_url,
      youtube_url: r.youtube_url,
      author: r.author,
      release_year: r.release_year || '',
      catalog_no: r.catalog_no || '',
      format: r.format || '',
      description: r.description || '',
      description_en: r.description_en || ''
    }));

    const out = {ok:true, total:filtered.length, items};
    _putCacheJSON_(key, out, 30);
    return out;
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

function getRecordByRow(p){
  try{
    const row = Number(p && p.rowIndex || 0);
    if(!(row >= 2)) return {ok:false,error:'invalid row'};
    const sh = getSheet(SHEETS.Records);
    const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const vals = sh.getRange(row,1,1,head.length).getValues()[0];
    const o = {};
    head.forEach((h,i)=>o[h] = vals[i]);
    o.rowIndex = row;
    return {ok:true, data:o};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

/* ========== Lives ========== */
function submitLive(p){
  try{
    if(SEC_STRICT && !_rateLimitAllowNow('post_lives', p.client_id||'', RATE_POST_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    if(!(p.artist||p.artist2||p.artist3||p.artist4||p.artist5||p.artist6)) return {ok:false,error:'artist required'};
    if(!p.date || !p.venue) return {ok:false,error:'date/venue required'};
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length < 8) return {ok:false,error:'invalid edit_key'};

    const yt = _normalizeYouTube(p.youtube_url||'');

    const ngText = [
      p.price||'', p.description||'', p.author||'',
      p.genre||'', p.prefecture||'', p.region||'', p.status||''
    ].join('\n');
    if(SEC_STRICT && _serverNgCheck(ngText)){
      return {ok:false, error:'ng word detected'};
    }

    let titleJa = p.title || '';
    let titleEn = p.title_en || '';
    let descJa  = p.description || '';
    let descEn  = p.description_en || '';
    let venueJa = p.venue || '';
    let venueEn = p.venue_en || '';
    let regionJa = p.region || (p.prefecture ? regionFromPref_(p.prefecture) : '');
    let regionEn = p.region_en || '';
    let prefJa = p.prefecture || '';
    let prefEn = p.prefecture_en || '';
    let priceJa = p.price || '';
    let priceEn = p.price_en || '';

    try{
      if (!titleEn && titleJa) titleEn = LanguageApp.translate(titleJa, 'ja', 'en');
      if (!titleJa && titleEn) titleJa = LanguageApp.translate(titleEn, 'en', 'ja');
      if (!descEn  && descJa)  descEn  = LanguageApp.translate(descJa,  'ja', 'en');
      if (!descJa  && descEn)  descJa  = LanguageApp.translate(descEn,  'en', 'ja');
      if (!venueEn && venueJa) venueEn = LanguageApp.translate(venueJa, 'ja', 'en');
      if (!venueJa && venueEn) venueJa = LanguageApp.translate(venueEn, 'en', 'ja');
      if (!regionEn && regionJa) regionEn = LanguageApp.translate(regionJa, 'ja', 'en');
      if (!regionJa && regionEn) regionJa = LanguageApp.translate(regionEn, 'en', 'ja');
      if (!prefEn && prefJa) prefEn = LanguageApp.translate(prefJa, 'ja', 'en');
      if (!prefJa && prefEn) prefJa = LanguageApp.translate(prefEn, 'en', 'ja');
      if (!priceEn && priceJa) priceEn = LanguageApp.translate(priceJa, 'ja', 'en');
      if (!priceJa && priceEn) priceJa = LanguageApp.translate(priceEn, 'en', 'ja');
    }catch(_){}

    const artistJoined = [p.artist,p.artist2,p.artist3,p.artist4,p.artist5,p.artist6].filter(Boolean).join(' / ');
    const imgUrl = p.image_url ? normalizeDriveUrl_(p.image_url) : '';

    const row = {
      timestamp: new Date(),
      artist: artistJoined,
      title: titleJa,
      title_en: titleEn,
      genre: p.genre||'',
      date: p.date||'',
      open_time: p.open_time||'',
      start_time: p.start_time||'',
      venue: venueJa,
      venue_en: venueEn,
      region: regionJa,
      region_en: regionEn,
      prefecture: prefJa,
      prefecture_en: prefEn,
      price: priceJa,
      price_en: priceEn,
      description: descJa,
      description_en: descEn,
      image_url: imgUrl || (p.image_data ? saveDataUrl(p.image_data,'Lives') : ''),
      youtube_url: yt,
      author: p.author||'',
      status: (p.status||'scheduled'),
      edit_key: p.edit_key||'',
      client_id: p.client_id||'',
      is_hidden: false
    };

    appendRowByHeader(SHEETS.Lives, row);
    _bumpCacheVersion_();
    return {ok:true};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

function regionFromPref_(pref){
  const MAP = {
    '北海道・東北':['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県'],
    '関東':['茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県'],
    '中部':['新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県'],
    '近畿':['三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県'],
    '中国':['鳥取県','島根県','岡山県','広島県','山口県'],
    '四国':['徳島県','香川県','愛媛県','高知県'],
    '九州・沖縄':['福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県']
  };
  for (var k in MAP){
    if (MAP[k].indexOf(pref) >= 0) return k;
  }
  return '';
}

function listLives(q){
  try{
    q = q || {};
    const key = _cacheKey_('lives:list', {
      g:(q.genre||'').trim(),
      r:(q.region||'').trim(),
      p:(q.prefecture||'').trim(),
      i:(q.initial||'').trim(),
      s:(q.status||'').trim(),
      a:(q.artist||'').trim(),
      df:(q.date_from||'').trim(),
      dt:(q.date_to||'').trim(),
      ms: JSON.stringify(q.months || []),
      l:Number(q.limit||24),
      o:Number(q.offset||0)
    });
    const cached = _getCacheJSON_(key);
    if (cached) return cached;

    const all = readAll(SHEETS.Lives).filter(r=>!String(r.is_hidden||'').match(/true/i));
    let out = all;

    if(q.genre) out = out.filter(r=> String(r.genre||'') === String(q.genre));
    if(q.region) out = out.filter(r=> String(r.region||'') === String(q.region));
    if(q.prefecture) out = out.filter(r=> String(r.prefecture||'') === String(q.prefecture));
    if(q.initial){
      out = out.filter(r => asciiInitial((r.artist||'').split('/')[0]) === String(q.initial));
    }
    if(q.status){
      out = out.filter(r=> String(r.status||'').toLowerCase() === String(q.status).toLowerCase());
    }
    if(q.artist){
      out = out.filter(r=> containsCi(r.artist, q.artist));
    }

    const from = q.date_from ? new Date(q.date_from) : null;
    const to   = q.date_to ? new Date(q.date_to) : null;
    if(from || to){
      out = out.filter(r=>{
        const d = new Date(r.date||'');
        if(from && d < from) return false;
        if(to && d > to) return false;
        return true;
      });
    }

    if(q.months && q.months.length){
      const set = new Set(q.months.map(n=>Number(n)));
      out = out.filter(r=>{
        const m = (new Date(r.date||'')).getMonth() + 1;
        return set.has(m);
      });
    }

    const total = out.length;
    const limit = Number(q.limit||24);
    const offset = Number(q.offset||0);

    const items = out.slice(offset, offset+limit).map(r=>({
      rowIndex:r.rowIndex,
      artist:r.artist,
      title:r.title,
      title_en:r.title_en,
      genre:r.genre,
      date:r.date,
      open_time:r.open_time,
      start_time:r.start_time,
      venue:r.venue,
      venue_en:r.venue_en,
      region:r.region,
      region_en:r.region_en,
      prefecture:r.prefecture,
      prefecture_en:r.prefecture_en,
      price:r.price,
      price_en:r.price_en,
      description:r.description,
      description_en:r.description_en,
      image_url: normalizeDriveUrl_(r.image_url),
      youtube_url:r.youtube_url,
      status:r.status
    }));

    const res = {ok:true, total, items};
    _putCacheJSON_(key, res, 30);
    return res;
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

/* ========== Features ========== */
function submitFeature(p){
  try{
    if(SEC_STRICT && !_rateLimitAllowNow('post_features', p.client_id||'', RATE_POST_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    if(!p.title && !p.title_en) return {ok:false,error:'title required (ja or en)'};
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length < 8) {
      return {ok:false,error:'invalid edit_key'};
    }

    for (let i=1;i<=5;i++){
      for (let j=1;j<=3;j++){
        const kUrl = 'p'+i+'_img'+j+'_url';
        if (p[kUrl] && !_isAllowedHttpUrl(p[kUrl])) {
          return {ok:false, error:'invalid image_url'};
        }
      }
    }

    let ngPool = [p.author||'', p.era||'', p.region||''].join('\n');
    for (let i=1;i<=5;i++){
      ngPool += '\n' + (p['para'+i+'_text']||'');
    }
    if(SEC_STRICT && _serverNgCheck(ngPool)){
      return {ok:false, error:'ng word detected'};
    }

    let titleJa = p.title || '';
    let titleEn = p.title_en || '';
    try{
      if (!titleEn && titleJa) titleEn = LanguageApp.translate(titleJa,'ja','en');
      if (!titleJa && titleEn) titleJa = LanguageApp.translate(titleEn,'en','ja');
    }catch(_){}

    const slug = p.slug || (slugify_(titleJa) + '-' + (new Date().getTime().toString(36)));
    const nowIso = new Date().toISOString();

    const row = {
      timestamp: new Date(),
      status: p.status || 'published',
      title: titleJa,
      title_en: titleEn,
      author: p.author||'',
      genre: p.genre||'',
      genre_other: p.genre_other||'',
      era: p.era||'',
      region: p.region||'',
      slug: slug,
      updated_at: nowIso,
      edit_key: p.edit_key||'',
      edit_key_hash: _sha256Hex_(p.edit_key||''),
      client_id: p.client_id||'',
      is_hidden: false
    };

    for (let i=1;i<=5;i++){
      let jp = p['para'+i+'_text'] || '';
      let en = p['para'+i+'_text_en'] || '';
      try{
        if (!en && jp) en = LanguageApp.translate(jp,'ja','en');
        if (!jp && en) jp = LanguageApp.translate(en,'en','ja');
      }catch(_){}
      row['para'+i+'_text'] = jp;
      row['para'+i+'_text_en'] = en;
      row['youtube'+i] = _normalizeYouTube(p['youtube'+i] || '');
      for (let j=1;j<=3;j++){
        const kUrl = 'p'+i+'_img'+j+'_url';
        const kData= 'p'+i+'_img'+j+'_data';
        row[kUrl] = p[kUrl] ? normalizeDriveUrl_(p[kUrl]) : (p[kData] ? saveDataUrl(p[kData],'Features') : '');
      }
    }

    appendRowByHeader(SHEETS.Features, row);
    _bumpCacheVersion_();
    return {ok:true, slug: slug};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

function slugify_(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^\w\s-]/g,'')
    .trim()
    .replace(/\s+/g,'-')
    .slice(0,72);
}

function listFeatures(q){
  try{
    q = q || {};
    const key = _cacheKey_('features:list', {
      l:Number(q.limit||100),
      o:Number(q.offset||0)
    });
    const cached = _getCacheJSON_(key);
    if (cached) return cached;

    const all = readAll(SHEETS.Features).filter(r => !String(r.is_hidden||'').match(/true/i));
    const out = all.filter(r => String((r.status||'published')).toLowerCase() === 'published');

    const total = out.length;
    const limit = Number(q.limit||100);
    const offset = Number(q.offset||0);

    const items = out.slice(offset, offset+limit).map(r=>{
      const d = {
        rowIndex:r.rowIndex,
        slug:r.slug,
        status:r.status,
        title:r.title,
        title_en:r.title_en,
        author:r.author,
        genre:r.genre,
        genre_other:r.genre_other || '',
        era:r.era,
        region:r.region,
        updated_at:r.updated_at || ''
      };
      d.para1_text = r.para1_text || '';
      d.para2_text = r.para2_text || '';
      d.para3_text = r.para3_text || '';
      d.para1_text_en = r.para1_text_en || '';
      d.para2_text_en = r.para2_text_en || '';
      d.para3_text_en = r.para3_text_en || '';
      return d;
    });

    const res = {ok:true, total, items};
    _putCacheJSON_(key, res, 30);
    return res;
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

function getFeatureById(p){
  try{
    const all = readAll(SHEETS.Features);
    let r = null;
    let rowIndex = 0;

    if (p && p.slug){
      r = all.find(x => String(x.slug||'') === String(p.slug));
      rowIndex = r ? r.rowIndex : 0;
    }else if(p && p.rowIndex){
      r = all.find(x => x.rowIndex === Number(p.rowIndex));
      rowIndex = Number(p.rowIndex||0);
    }

    if(!r) return {ok:false};
    return {ok:true, data:r, rowIndex};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

/* ========== 共通編集 ========== */
function editEntry(p){
  try{
    const sheetName = String((p && p.sheetName) || '').trim();
    const rowIndex = Number((p && p.rowIndex) || 0);
    const ek = String((p && p.edit_key) || '').trim();
    const action = String((p && p.action) || '').toLowerCase();

    if(!(rowIndex >= 2) || !sheetName || !ek){
      return {ok:false,error:'invalid params'};
    }

    const info = getHeaderMap_(sheetName);
    const sh = info.sh;
    const head = info.head;
    const map = info.map;
    const vals = sh.getRange(rowIndex,1,1,head.length).getValues()[0];

    if (sheetName === SHEETS.Features){
      const hasHash = Object.prototype.hasOwnProperty.call(map, 'edit_key_hash');
      const hasPlain = Object.prototype.hasOwnProperty.call(map, 'edit_key');

      if (hasHash){
        const stored = vals[map['edit_key_hash']];
        if (!_editKeyMatch_(stored, ek)) return {ok:false,error:'edit_key mismatch'};
      } else if (hasPlain){
        if (String(vals[map['edit_key']]||'') !== ek) return {ok:false,error:'edit_key mismatch'};
      } else {
        return {ok:false,error:'no edit_key column'};
      }
    } else {
      if (!Object.prototype.hasOwnProperty.call(map, 'edit_key')) return {ok:false,error:'no edit_key column'};
      if (String(vals[map['edit_key']]||'') !== ek) return {ok:false,error:'edit_key mismatch'};
    }

    if (action === 'delete'){
      const patchDelete = {is_hidden:true};
      if (sheetName === SHEETS.Features && Object.prototype.hasOwnProperty.call(map, 'updated_at')) {
        patchDelete.updated_at = new Date().toISOString();
      }
      updateRowByHeader(sheetName, rowIndex, patchDelete);
      _bumpCacheVersion_();
      return {ok:true, deleted:true};
    }

    if (action === 'restore'){
      const patchRestore = {is_hidden:false};
      if (sheetName === SHEETS.Features && Object.prototype.hasOwnProperty.call(map, 'updated_at')) {
        patchRestore.updated_at = new Date().toISOString();
      }
      updateRowByHeader(sheetName, rowIndex, patchRestore);
      _bumpCacheVersion_();
      return {ok:true, restored:true};
    }

    if (action === 'update'){
      let patch = _normalizePatchKeys_(sheetName, p.patch || {});

      if (sheetName === SHEETS.Records){
        const protectedCols = {
          rowIndex:true,
          timestamp:true,
          edit_key:true
        };

        const safePatch = {};
        Object.keys(patch).forEach(k=>{
          if (protectedCols[k]) return;
          if (!Object.prototype.hasOwnProperty.call(map, k)) return;
          safePatch[k] = patch[k];
        });

        if (safePatch.image_url) safePatch.image_url = normalizeDriveUrl_(safePatch.image_url);
        if (safePatch.youtube_url) safePatch.youtube_url = _normalizeYouTube(safePatch.youtube_url);

        try{
          if (safePatch.description != null && String(safePatch.description).trim() !== '' && !safePatch.description_en && Object.prototype.hasOwnProperty.call(map, 'description_en')){
            safePatch.description_en = LanguageApp.translate(String(safePatch.description),'ja','en');
          }else if ((safePatch.description == null || String(safePatch.description).trim() === '') && safePatch.description_en && Object.prototype.hasOwnProperty.call(map, 'description')){
            safePatch.description = LanguageApp.translate(String(safePatch.description_en),'en','ja');
          }
        }catch(_){}

        if (Object.prototype.hasOwnProperty.call(safePatch, 'band')){
          const bandVal = String(safePatch.band || '').trim();
          if (Object.prototype.hasOwnProperty.call(map, 'band_sort')){
            safePatch.band_sort = bandVal.replace(/^(the)\s+/i, '').toLowerCase();
          }
          if (Object.prototype.hasOwnProperty.call(map, 'band_initial')){
            const t = bandVal.replace(/^(the)\s+/i, '');
            const ch = (t[0] || '').toUpperCase();
            safePatch.band_initial = /[A-Z]/.test(ch) ? ch : '#';
          }
        }

        if (Object.keys(safePatch).length === 0){
          return {ok:false, error:'no valid fields'};
        }

        updateRowByHeader(sheetName, rowIndex, safePatch);
        _bumpCacheVersion_();
        return {ok:true, updated:true, saved:safePatch};
      }

      else if (sheetName === SHEETS.Lives){
        const allow = [
          'artist','title','title_en','genre','date','open_time','start_time',
          'venue','venue_en','region','region_en','prefecture','prefecture_en',
          'price','price_en','description','description_en',
          'image_url','youtube_url','author','status','is_hidden'
        ];

        if (patch.image_url) patch.image_url = normalizeDriveUrl_(patch.image_url);
        if (patch.youtube_url) patch.youtube_url = _normalizeYouTube(patch.youtube_url);

        try{
          if (patch.title && !patch.title_en){
            patch.title_en = LanguageApp.translate(String(patch.title),'ja','en');
          }else if (!patch.title && patch.title_en){
            patch.title = LanguageApp.translate(String(patch.title_en),'en','ja');
          }

          if (patch.description && !patch.description_en){
            patch.description_en = LanguageApp.translate(String(patch.description),'ja','en');
          }else if (!patch.description && patch.description_en){
            patch.description = LanguageApp.translate(String(patch.description_en),'en','ja');
          }

          if (patch.venue && !patch.venue_en){
            patch.venue_en = LanguageApp.translate(String(patch.venue),'ja','en');
          }else if (!patch.venue && patch.venue_en){
            patch.venue = LanguageApp.translate(String(patch.venue_en),'en','ja');
          }

          if (patch.region && !patch.region_en){
            patch.region_en = LanguageApp.translate(String(patch.region),'ja','en');
          }else if (!patch.region && patch.region_en){
            patch.region = LanguageApp.translate(String(patch.region_en),'en','ja');
          }

          if (patch.prefecture && !patch.prefecture_en){
            patch.prefecture_en = LanguageApp.translate(String(patch.prefecture),'ja','en');
          }else if (!patch.prefecture && patch.prefecture_en){
            patch.prefecture = LanguageApp.translate(String(patch.prefecture_en),'en','ja');
          }

          if (patch.price && !patch.price_en){
            patch.price_en = LanguageApp.translate(String(patch.price),'ja','en');
          }else if (!patch.price && patch.price_en){
            patch.price = LanguageApp.translate(String(patch.price_en),'en','ja');
          }
        }catch(_){}

        const safePatch = {};
        allow.forEach(k=>{
          if (Object.prototype.hasOwnProperty.call(patch, k)) safePatch[k] = patch[k];
        });

        if (Object.keys(safePatch).length === 0){
          return {ok:false, error:'no valid fields'};
        }

        updateRowByHeader(sheetName, rowIndex, safePatch);
        _bumpCacheVersion_();
        return {ok:true, updated:true, saved: safePatch};
      }

      else if (sheetName === SHEETS.Features){
        const allow = [
          'status','title','title_en','author','genre','genre_other','era','region',
          'slug','updated_at',
          'para1_text','para2_text','para3_text','para4_text','para5_text',
          'para1_text_en','para2_text_en','para3_text_en','para4_text_en','para5_text_en',
          'youtube1','youtube2','youtube3','youtube4','youtube5',
          'p1_img1_url','p1_img2_url','p1_img3_url',
          'p2_img1_url','p2_img2_url','p2_img3_url',
          'p3_img1_url','p3_img2_url','p3_img3_url',
          'p4_img1_url','p4_img2_url','p4_img3_url',
          'p5_img1_url','p5_img2_url','p5_img3_url',
          'is_hidden'
        ];

        Object.keys(patch).forEach(k=>{
          if (/_img\d+_url$/.test(k) && patch[k]) patch[k] = normalizeDriveUrl_(patch[k]);
          if (/^youtube\d+$/.test(k) && patch[k]) patch[k] = _normalizeYouTube(patch[k]);
        });

        try{
          if (patch.title && !patch.title_en){
            patch.title_en = LanguageApp.translate(String(patch.title),'ja','en');
          }else if (!patch.title && patch.title_en){
            patch.title = LanguageApp.translate(String(patch.title_en),'en','ja');
          }

          for (let i=1;i<=5;i++){
            const jpKey = 'para'+i+'_text';
            const enKey = 'para'+i+'_text_en';
            const jp = patch[jpKey];
            const en = patch[enKey];

            if (jp && !en){
              patch[enKey] = LanguageApp.translate(String(jp),'ja','en');
            }else if (!jp && en){
              patch[jpKey] = LanguageApp.translate(String(en),'en','ja');
            }
          }
        }catch(_){}

        patch.updated_at = new Date().toISOString();

        const safePatch = {};
        allow.forEach(k=>{
          if (Object.prototype.hasOwnProperty.call(patch, k)) safePatch[k] = patch[k];
        });

        if (Object.keys(safePatch).length === 0){
          return {ok:false, error:'no valid fields'};
        }

        updateRowByHeader(sheetName, rowIndex, safePatch);
        _bumpCacheVersion_();
        return {ok:true, updated:true, saved: safePatch};
      }

      else {
        return {ok:false, error:'unknown sheet'};
      }
    }

    return {ok:false, error:'unknown action'};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

/* ========== Reports ========== */
function submitReport(p){
  try{
    if(SEC_STRICT && !_rateLimitAllowNow('report', p.client_id||'', RATE_REPORT_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    const sheetName = p.sheetName;
    const rowIndex = Number(p.rowIndex||0);
    const reason = p.reason||'';
    const client_id = p.client_id||'';

    appendRowByHeader(SHEETS.Reports, {
      timestamp:new Date(),
      sheetName:sheetName,
      rowIndex:rowIndex,
      reason:reason,
      client_id:client_id
    });

    const all = readAll(SHEETS.Reports).filter(r =>
      String(r.sheetName) === String(sheetName) &&
      Number(r.rowIndex) === Number(rowIndex)
    );

    let autoHidden = false;
    if (all.length >= REPORT_AUTOHIDE_THRESHOLD){
      updateRowByHeader(sheetName, rowIndex, {is_hidden:true});
      autoHidden = true;
      _bumpCacheVersion_();
    }

    return {ok:true, autoHidden};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

/* ========== include helper ========== */
function include_(name){
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ========== 補助関数群 ========== */
function backfillDescriptionEn(){
  const SHEET = SHEETS.Records;
  const SRC_LANG = 'ja';
  const DST_LANG = 'en';
  const DRY_RUN = false;
  const MAX_PER_RUN = 300;

  const sh = getSheet(SHEET);
  if (!sh) throw new Error('sheet not found: '+SHEET);

  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const colMap = {};
  head.forEach((h,i)=>colMap[String(h||'')] = i);

  const ciDesc = colMap['description'];
  const ciDescEn = colMap['description_en'];
  if (ciDesc == null || ciDescEn == null){
    throw new Error('必要列が見つかりません（description/description_en）');
  }

  const lastRow = sh.getLastRow();
  if (lastRow < 2){
    Logger.log('データ行なし');
    return;
  }

  const vals = sh.getRange(2,1,lastRow-1, head.length).getValues();
  let updates = 0;
  let translated = 0;

  for (let r=0; r<vals.length; r++){
    const ja = String(vals[r][ciDesc]||'').trim();
    const en = String(vals[r][ciDescEn]||'').trim();
    if (en || !ja) continue;

    try{
      vals[r][ciDescEn] = LanguageApp.translate(ja, SRC_LANG, DST_LANG);
      updates++;
      translated++;
    }catch(e){
      Logger.log('翻訳失敗 row='+(r+2)+': '+e);
      continue;
    }

    if (!DRY_RUN && updates >= MAX_PER_RUN){
      sh.getRange(2,1,vals.length, head.length).setValues(vals);
      Logger.log('中間保存：'+updates+'件を書き込み');
      updates = 0;
    }
  }

  if (!DRY_RUN){
    sh.getRange(2,1,vals.length, head.length).setValues(vals);
  }

  Logger.log('処理完了：翻訳して埋めた件数=' + translated + '（DRY_RUN=' + DRY_RUN + '）');
}

function backfillDescriptionEn_dryrun(){
  const SHEET = SHEETS.Records;
  const sh = getSheet(SHEET);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const colMap = {};
  head.forEach((h,i)=>colMap[String(h||'')] = i);

  const ciDesc = colMap['description'];
  const ciDescEn = colMap['description_en'];
  const vals = sh.getRange(2,1,Math.max(sh.getLastRow()-1,0), head.length).getValues();

  let target = 0;
  for (let r=0; r<vals.length; r++){
    const ja = String(vals[r][ciDesc]||'').trim();
    const en = String(vals[r][ciDescEn]||'').trim();
    if (!en && ja) target++;
  }
  Logger.log('DRY-RUN：今翻訳で埋められる対象行数 = ' + target);
}

function restoreLivesHeader() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sh = ss.getSheetByName("Lives");
  if (!sh) return;

  const HEADERS = [
    'timestamp','artist','title','title_en','genre','date','open_time','start_time',
    'venue','region','prefecture','price','description','description_en','image_url',
    'youtube_url','author','status','edit_key','client_id','is_hidden'
  ];

  const lastCol = Math.max(sh.getLastColumn(), HEADERS.length);
  const row1 = (sh.getLastRow() >= 1)
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0]
    : [];

  const looksLikeHeader = row1.some(v =>
    typeof v === 'string' && HEADERS.includes(String(v).trim())
  );

  if (!looksLikeHeader) {
    sh.insertRowBefore(1);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function normalizeLivesImageUrls(){
  const sh = getSheet(SHEETS.Lives);
  if (!sh) return;
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const col = {};
  head.forEach((h,i)=>col[String(h||'')] = i);
  const ciUrl = col['image_url'];
  if (ciUrl == null) return;

  const last = sh.getLastRow();
  if (last < 2) return;

  const vals = sh.getRange(2,1,last-1, head.length).getValues();
  let changed = 0;
  for (let r=0; r<vals.length; r++){
    const u = vals[r][ciUrl];
    const nu = normalizeDriveUrl_(u);
    if (u && nu && u !== nu){
      vals[r][ciUrl] = nu;
      changed++;
    }
  }
  if (changed){
    sh.getRange(2,1,vals.length, head.length).setValues(vals);
  }
  Logger.log('Lives.image_url 正規化件数 = ' + changed);
}

function ensureLivesExtraHeaders(){
  const sh = getSheet(SHEETS.Lives);
  if(!sh) return;
  const need = ['venue_en','region_en','prefecture_en','price_en','image_updated_at'];
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(String);
  let col = sh.getLastColumn();

  need.forEach(h=>{
    if (head.indexOf(h) < 0){
      col += 1;
      sh.getRange(1,col).setValue(h);
      head.push(h);
    }
  });
}

function backfillLivesEn(){
  const sh = getSheet(SHEETS.Lives);
  if(!sh) throw new Error('Lives sheet not found');
  ensureLivesExtraHeaders();

  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0].map(String);
  const idx = {};
  head.forEach((h,i)=>{ idx[h]=i; });

  const needJ = ['title','description','venue','region','prefecture','price'];
  const needE = ['title_en','description_en','venue_en','region_en','prefecture_en','price_en'];

  const last = sh.getLastRow();
  if (last < 2) return;

  const vals = sh.getRange(2,1,last-1, head.length).getValues();
  let touched = 0;

  for (let r=0; r<vals.length; r++){
    const row = vals[r];

    if (idx.image_url != null){
      const u = row[idx.image_url];
      const nu = normalizeDriveUrl_(u);
      if (u && nu && u !== nu){
        row[idx.image_url] = nu;
        if (idx.image_updated_at != null) row[idx.image_updated_at] = new Date().toISOString();
        touched++;
      }
    }

    for (let i=0; i<needJ.length; i++){
      const jpKey = needJ[i], enKey = needE[i];
      const jpI = idx[jpKey], enI = idx[enKey];
      if (jpI == null || enI == null) continue;

      const jp = String(row[jpI]||'').trim();
      const en = String(row[enI]||'').trim();

      try{
        if (!en && jp){
          row[enI] = LanguageApp.translate(jp,'ja','en');
          touched++;
        }else if (!jp && en){
          row[jpI] = LanguageApp.translate(en,'en','ja');
          touched++;
        }
      }catch(_){}
    }

    vals[r] = row;
  }

  if (touched){
    sh.getRange(2,1,vals.length, head.length).setValues(vals);
  }
  Logger.log('backfillLivesEn touched rows: ' + touched);
}

function migrateLivesOnce(){
  ensureLivesExtraHeaders();
  normalizeLivesImageUrls();
  backfillLivesEn();
}

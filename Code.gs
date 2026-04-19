/***** ChaynupZine — Core Apps Script (.gs) / 日本語専用版 *****
 * 変更方針
 *  - 英語翻訳関連の列・補完処理を削除
 *  - LanguageApp.translate 依存を削除
 *  - フロントの日本語専用 submit/search/browse に合わせて返却項目を整理
 *  - 画像DataURL保存 / 通報 / 編集 / 非表示 は維持
 ************************************************/

const SPREADSHEET_ID = '1-lBO2HC-CqD2h4HUHyTxgfggISh2TRqx06fmzMz03yA';
const SHEETS = {
  Records: 'Records',
  Lives: 'Lives',
  Features: 'Features',
  Reports: 'Reports'
};

const REPORT_AUTOHIDE_THRESHOLD = 3;

/* === Security / RateLimit === */
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
  head.forEach((h,i)=>map[h]=i);

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
  }catch(_){
    return true;
  }
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
  }catch(_){
    return false;
  }
}

function _normalizeYouTube(u){
  try{
    if(!u) return '';
    const s = String(u).trim();
    const m1 = s.match(/youtu\.be\/([\w-]{6,})/);
    const m2 = s.match(/[?&]v=([\w-]{6,})/);
    const m3 = s.match(/youtube\.com\/shorts\/([\w-]{6,})/);
    const id = (m1 && m1[1]) || (m2 && m2[1]) || (m3 && m3[1]) || '';
    return id ? ('https://www.youtube.com/watch?v='+id) : '';
  }catch(_){
    return '';
  }
}

function _serverNgCheck(text){
  try{
    const low = String(text||'').toLowerCase();
    return NG_TERMS.some(w => low.indexOf(w) >= 0);
  }catch(_){
    return false;
  }
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
  }catch(_){
    return false;
  }
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
  try{
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }catch(_){}
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function decadeFromYearStr(y){
  const m = String(y||'').match(/(\d{4})/);
  if(!m) return '';
  const yy = Number(m[1]);
  if(!yy) return '';
  return (Math.floor(yy/10)*10)+'s';
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

function normalizeDriveUrl_(u){
  try{
    const s = String(u||'').trim();
    if(!s) return '';
    if (/^https:\/\/drive\.google\.com\/uc\?export=view&id=/.test(s)) return s;

    const m1 = s.match(/https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/);
    if (m1 && m1[1]) return 'https://drive.google.com/uc?export=view&id='+m1[1];

    const m2 = s.match(/https:\/\/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]{20,})/);
    if (m2 && m2[1]) return 'https://drive.google.com/uc?export=view&id='+m2[1];

    return s;
  }catch(_){
    return String(u||'');
  }
}

/* === 一覧キャッシュ === */
function _getCacheJSON_(key){
  try{
    const s = CacheService.getScriptCache().get(key);
    return s ? JSON.parse(s) : null;
  }catch(_){
    return null;
  }
}

function _putCacheJSON_(key, obj, ttlSec){
  try{
    CacheService.getScriptCache().put(key, JSON.stringify(obj), ttlSec||30);
  }catch(_){}
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

function slugify_(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^\w\s-]/g,'')
    .trim()
    .replace(/\s+/g,'-')
    .slice(0,72);
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

    const ngTxt = [p.description||'', p.author||''].join('\n');
    if(SEC_STRICT && _serverNgCheck(ngTxt)){
      return {ok:false, error:'ng word detected'};
    }

    const imgUrl = p.image_url ? normalizeDriveUrl_(p.image_url) : '';

    const row = {
      timestamp: new Date(),
      genre: p.genre||'',
      country: p.country||'',
      band: p.band||'',
      track: p.track||'',
      release_year: p.release_year||'',
      catalog_no: p.catalog_no||'',
      format: p.format||'',
      description: p.description||'',
      image_url: imgUrl || (p.image_data ? saveDataUrl(p.image_data, 'Records') : ''),
      youtube_url: yt,
      author: p.author||'',
      edit_key: p.edit_key||'',
      client_id: p.client_id||'',
      is_hidden: false
    };

    if(!row.band || !row.track || !row.genre || !row.country || !row.edit_key){
      return {ok:false, error:'missing required'};
    }

    appendRowByHeader(SHEETS.Records, row);
    return {ok:true};
  }catch(e){
    return {ok:false, error:String(e)};
  }
}

function listRecords(q){
  try{
    const key = 'rec:list:v3:' + JSON.stringify({
      g:(q&&q.genre)||'', c:(q&&q.country)||'', e:(q&&q.era)||'',
      i:(q&&q.initial)||'', l:Number(q&&q.limit||20), o:Number(q&&q.offset||0)
    });
    const cached = _getCacheJSON_(key);
    if (cached) return cached;

    const all = readAll(SHEETS.Records).filter(r => !String(r.is_hidden||'').match(/true/i));
    const genre   = (q.genre   || '').trim();
    const country = (q.country || '').trim();
    const era     = (q.era     || '').trim();
    const initial = (q.initial || '').trim();
    const limit   = Number(q.limit||20);
    const offset  = Number(q.offset||0);

    const filtered = all.filter(r=>{
      if (genre   && String(r.genre   ||'').trim() !== genre)   return false;
      if (country && String(r.country ||'').trim() !== country) return false;
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
      rowIndex:r.rowIndex,
      band:r.band,
      track:r.track,
      country:r.country,
      genre:r.genre,
      image_url: normalizeDriveUrl_(r.image_url),
      author:r.author,
      description:r.description || ''
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
    if(!(row>=2)) return {ok:false,error:'invalid row'};
    const sh = getSheet(SHEETS.Records);
    const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const vals = sh.getRange(row,1,1,head.length).getValues()[0];
    const o = {};
    head.forEach((h,i)=>o[h]=vals[i]);
    o.rowIndex=row;
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

    if(!(p.artist||p.artist2||p.artist3||p.artist4||p.artist5||p.artist6)){
      return {ok:false,error:'artist required'};
    }
    if(!p.date || !p.venue){
      return {ok:false,error:'date/venue required'};
    }
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length<8){
      return {ok:false,error:'invalid edit_key'};
    }

    const yt = _normalizeYouTube(p.youtube_url||'');

    const ngText = [
      p.price||'', p.description||'', p.author||'',
      p.genre||'', p.prefecture||'', p.region||'', p.status||''
    ].join('\n');
    if(SEC_STRICT && _serverNgCheck(ngText)){
      return {ok:false, error:'ng word detected'};
    }

    const artistJoined = [p.artist,p.artist2,p.artist3,p.artist4,p.artist5,p.artist6].filter(Boolean).join(' / ');
    const imgUrl = p.image_url ? normalizeDriveUrl_(p.image_url) : '';

    const row = {
      timestamp: new Date(),
      artist: artistJoined,
      title: p.title || '',
      genre: p.genre || '',
      date: p.date || '',
      open_time: p.open_time || '',
      start_time: p.start_time || '',
      venue: p.venue || '',
      region: p.region || (p.prefecture ? regionFromPref_(p.prefecture) : ''),
      prefecture: p.prefecture || '',
      price: p.price || '',
      description: p.description || '',
      image_url: imgUrl || (p.image_data ? saveDataUrl(p.image_data,'Lives') : ''),
      youtube_url: yt,
      author: p.author || '',
      status: (p.status || 'scheduled'),
      edit_key: p.edit_key || '',
      client_id: p.client_id || '',
      is_hidden: false
    };

    appendRowByHeader(SHEETS.Lives, row);
    return {ok:true};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

function listLives(q){
  try{
    const key = 'lv:list:jp:' + JSON.stringify({
      g:(q&&q.genre)||'', r:(q&&q.region)||'', p:(q&&q.prefecture)||'',
      i:(q&&q.initial)||'', s:(q&&q.status)||'',
      a:(q&&q.artist)||'',
      df:(q&&q.date_from)||'', dt:(q&&q.date_to)||'',
      ms:JSON.stringify((q&&q.months)||[]),
      l:Number(q&&q.limit||24), o:Number(q&&q.offset||0)
    });
    const cached = _getCacheJSON_(key);
    if (cached) return cached;

    const all = readAll(SHEETS.Lives).filter(r=>!String(r.is_hidden||'').match(/true/i));
    let out = all;

    if(q.genre)      out = out.filter(r=> String(r.genre||'')===String(q.genre));
    if(q.region)     out = out.filter(r=> String(r.region||'')===String(q.region));
    if(q.prefecture) out = out.filter(r=> String(r.prefecture||'')===String(q.prefecture));
    if(q.initial){
      out = out.filter(r => asciiInitial((r.artist||'').split('/')[0]) === String(q.initial));
    }
    if(q.status){
      out = out.filter(r=> String(r.status||'').toLowerCase()===String(q.status).toLowerCase());
    }
    if(q.artist){
      out = out.filter(r=> containsCi(r.artist, q.artist));
    }

    const from = q.date_from ? new Date(q.date_from) : null;
    const to   = q.date_to   ? new Date(q.date_to)   : null;
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
        const m = (new Date(r.date||'')).getMonth()+1;
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
      genre:r.genre,
      date:r.date,
      open_time:r.open_time,
      start_time:r.start_time,
      venue:r.venue,
      region:r.region,
      prefecture:r.prefecture,
      price:r.price,
      description:r.description,
      image_url: normalizeDriveUrl_(r.image_url),
      youtube_url:r.youtube_url,
      author:r.author,
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

    if(!p.title) return {ok:false,error:'title required'};
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length<8){
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

    var ngPool = [p.author||'', p.era||'', p.region||''].join('\n');
    for (let i=1;i<=5;i++){
      ngPool += '\n' + (p['para'+i+'_text']||'');
    }
    if(SEC_STRICT && _serverNgCheck(ngPool)){
      return {ok:false, error:'ng word detected'};
    }

    const slug = p.slug || (slugify_(p.title)+'-'+(new Date().getTime().toString(36)));
    const row = {
      timestamp: new Date(),
      status: p.status || 'published',
      title: p.title || '',
      author: p.author || '',
      genre: p.genre || '',
      genre_other: p.genre_other || '',
      era: p.era || '',
      region: p.region || '',
      slug: slug,
      edit_key: p.edit_key || '',
      client_id: p.client_id || '',
      is_hidden: false
    };

    for (let i=1;i<=5;i++){
      row['para'+i+'_text'] = p['para'+i+'_text'] || '';
      row['youtube'+i] = _normalizeYouTube(p['youtube'+i] || '');

      for (let j=1;j<=3;j++){
        const kUrl = 'p'+i+'_img'+j+'_url';
        const kData= 'p'+i+'_img'+j+'_data';
        row[kUrl] = p[kUrl] ? normalizeDriveUrl_(p[kUrl]) : (p[kData] ? saveDataUrl(p[kData],'Features') : '');
      }
    }

    appendRowByHeader(SHEETS.Features, row);
    return {ok:true, slug};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

function listFeatures(q){
  try{
    const all = readAll(SHEETS.Features).filter(r => !String(r.is_hidden||'').match(/true/i));
    let out = all.filter(r => String((r.status||'published')).toLowerCase()==='published');
    const total = out.length;
    const limit = Number(q.limit||100);
    const offset = Number(q.offset||0);

    const items = out.slice(offset, offset+limit).map(r=>{
      const d = {
        rowIndex:r.rowIndex,
        slug:r.slug,
        status:r.status,
        title:r.title,
        author:r.author,
        genre:r.genre,
        era:r.era,
        region:r.region
      };
      d.para1_text = r.para1_text||'';
      d.para2_text = r.para2_text||'';
      d.para3_text = r.para3_text||'';
      return d;
    });

    return {ok:true, total, items};
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

/* ========== Edit / Hide / Restore ========== */
function editEntry(p){
  try{
    const sheetName = p.sheetName;
    const rowIndex = Number(p.rowIndex||0);
    const ek = String(p.edit_key||'');
    const action = String(p.action||'').toLowerCase();

    if(!(rowIndex>=2) || !sheetName || !ek) return {ok:false,error:'invalid params'};

    const sh = getSheet(sheetName);
    const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const vals = sh.getRange(rowIndex,1,1,head.length).getValues()[0];
    const map = {};
    head.forEach((h,i)=>map[h]=i);

    if (!Object.prototype.hasOwnProperty.call(map, 'edit_key')) return {ok:false,error:'no edit_key column'};
    if (String(vals[map.edit_key]||'') !== ek) return {ok:false,error:'edit_key mismatch'};

    if (action === 'delete'){
      updateRowByHeader(sheetName, rowIndex, {is_hidden:true});
      return {ok:true, deleted:true};
    }

    if (action === 'restore' || action === 'unhide'){
      updateRowByHeader(sheetName, rowIndex, {is_hidden:false});
      return {ok:true, restored:true};
    }

    if (action === 'update'){
      const patch = p.patch || {};
      let allow = [];

      if (sheetName === SHEETS.Records){
        allow = ['genre','country','band','track','release_year','catalog_no','format','description','image_url','youtube_url','author','is_hidden'];
        if (patch.image_url) patch.image_url = normalizeDriveUrl_(patch.image_url);
      } else if (sheetName === SHEETS.Lives){
        allow = [
          'artist','title','genre','date','open_time','start_time',
          'venue','region','prefecture','price','description',
          'image_url','youtube_url','author','status','is_hidden'
        ];
        if (patch.image_url) patch.image_url = normalizeDriveUrl_(patch.image_url);
      } else if (sheetName === SHEETS.Features){
        allow = [
          'status','title','author','genre','genre_other','era','region','slug',
          'para1_text','para2_text','para3_text','para4_text','para5_text',
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
        });
      } else {
        return {ok:false, error:'unknown sheet'};
      }

      const safePatch = {};
      allow.forEach(k=>{
        if (Object.prototype.hasOwnProperty.call(patch, k)) safePatch[k] = patch[k];
      });

      if (Object.keys(safePatch).length===0) return {ok:false, error:'no valid fields'};

      updateRowByHeader(sheetName, rowIndex, safePatch);
      return {ok:true, updated:true};
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
      sheetName,
      rowIndex,
      reason,
      client_id
    });

    const all = readAll(SHEETS.Reports).filter(r => String(r.sheetName)===sheetName && Number(r.rowIndex)===rowIndex);
    let autoHidden = false;
    if (all.length >= REPORT_AUTOHIDE_THRESHOLD){
      updateRowByHeader(sheetName, rowIndex, {is_hidden:true});
      autoHidden = true;
    }
    return {ok:true, autoHidden};
  }catch(e){
    return {ok:false,error:String(e)};
  }
}

/* ========== HTML include helper ========== */
function include_(name){
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ========== Optional maintenance helpers / 日本語専用版 ========== */

/* Lives の image_url を一括正規化 */
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

  for (let r=0;r<vals.length;r++){
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

/* Features の画像URLを一括正規化 */
function normalizeFeaturesImageUrls(){
  const sh = getSheet(SHEETS.Features);
  if (!sh) return;

  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const idx = {};
  head.forEach((h,i)=>idx[String(h||'')] = i);

  const last = sh.getLastRow();
  if (last < 2) return;

  const vals = sh.getRange(2,1,last-1, head.length).getValues();
  let changed = 0;

  for (let r=0;r<vals.length;r++){
    for (let i=1;i<=5;i++){
      for (let j=1;j<=3;j++){
        const key = 'p'+i+'_img'+j+'_url';
        if (idx[key] == null) continue;
        const u = vals[r][idx[key]];
        const nu = normalizeDriveUrl_(u);
        if (u && nu && u !== nu){
          vals[r][idx[key]] = nu;
          changed++;
        }
      }
    }
  }

  if (changed){
    sh.getRange(2,1,vals.length, head.length).setValues(vals);
  }
  Logger.log('Features 画像URL 正規化件数 = ' + changed);
}

/* Records の image_url を一括正規化 */
function normalizeRecordsImageUrls(){
  const sh = getSheet(SHEETS.Records);
  if (!sh) return;

  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const idx = {};
  head.forEach((h,i)=>idx[String(h||'')] = i);
  if (idx.image_url == null) return;

  const last = sh.getLastRow();
  if (last < 2) return;

  const vals = sh.getRange(2,1,last-1, head.length).getValues();
  let changed = 0;

  for (let r=0;r<vals.length;r++){
    const u = vals[r][idx.image_url];
    const nu = normalizeDriveUrl_(u);
    if (u && nu && u !== nu){
      vals[r][idx.image_url] = nu;
      changed++;
    }
  }

  if (changed){
    sh.getRange(2,1,vals.length, head.length).setValues(vals);
  }
  Logger.log('Records.image_url 正規化件数 = ' + changed);
}

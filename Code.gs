/***** ChaynupZine — Core Apps Script (.gs) *****
 * 注意: 本ファイルは「基盤となる .gs の修正点のみ」を反映した統合版です。
 *  - doGet で EXEC_URL をテンプレへ注入
 *  - doPost で外部（fetch）呼び出しをルーティング
 *  - 各 API はフロントの期待に合わせて {ok:..., items/data, total, rowIndex, error} を返却
 *  - シートは 1 行目をヘッダーとし、ヘッダー名ベースで読み書き
 *  - 画像 DataURL は Drive に保存し公開リンク（uc?export=view&id=）を返却
 *  - 通報は Reports シートに蓄積し、一定回数で自動非表示
 ************************************************/

const SPREADSHEET_ID = '1-lBO2HC-CqD2h4HUHyTxgfggISh2TRqx06fmzMz03yA';
const SHEETS = {
  Records: 'Records',
  Lives: 'Lives',
  Features: 'Features',
  Reports: 'Reports'
};
const REPORT_AUTOHIDE_THRESHOLD = 3; // 通報回数が閾値に達したら自動で is_hidden=TRUE

/* === Security/RateLimit (追加) === */
const SEC_STRICT = false; // ★変更: GitHub Pages からの fetch を一旦許可（CSRF厳格検証を無効化）
const ALLOWED_IMAGE_MIMES = ['image/jpeg','image/png','image/webp'];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
const RATE_POST_MIN_INTERVAL_MS   = 5 * 60 * 1000; // 投稿は5分に1回
const RATE_REPORT_MIN_INTERVAL_MS = 1 * 60 * 1000; // 通報は1分に1回
const NG_TERMS = ["kill","die","rape","suicide","terror","bomb","fuck","cunt","asshole","nazi","kkk","white power","retard","spic","chink","gook","fag"];

/* ========== doGet / doPost ========== */
function doGet(e) {
  // ★追加：GitHub Pages からの GET での API 呼び出しを許可（405 回避）
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
  t.EXEC_URL = ScriptApp.getService().getUrl(); // ★修正点: テンプレに EXEC_URL を渡す

  // ★修正点: CSRF トークンを発行してフロントに埋め込み
  const clientId = (e && e.parameter && e.parameter.client_id) || '';
  const csrfTok = issueCsrfToken_(clientId);

  const out = t.evaluate()
    .setTitle('CHAYNUPZINE')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  // 全ページ末尾に window.__CZ_CSRF を注入（既存HTML側の改変不要）
  out.append('<script>window.__CZ_CSRF=' + JSON.stringify(csrfTok) + ';</script>');
  return out;
}

// 外部（GitHub Pages 等）からの fetch(JSON) 呼び出し用
function doPost(e) {
  try {
    const body = JSON.parse(e.postData && e.postData.contents || '{}');
    const fn = String(body.fn || '').trim();
    const payload = body.payload || {};

    // ★修正点: CSRF 検証（google.script.run 直叩きは doPost を通らないため外部fetchのみ対象）
    if (SEC_STRICT) {
      const okCsrf = verifyCsrfToken_(String(body.csrf || ''));
      if (!okCsrf) {
        return ContentService.createTextOutput(JSON.stringify({ok:false,error:'bad csrf'})).setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (!fn) return ContentService.createTextOutput(JSON.stringify({ok:false,error:'no fn'})).setMimeType(ContentService.MimeType.JSON);
    const map = {
      submitFromClient, listRecords, getRecordByRow,
      submitLive, listLives, editEntry,
      submitFeature, listFeatures, getFeatureById,
      submitReport
    };
    if (!map[fn]) return ContentService.createTextOutput(JSON.stringify({ok:false,error:'unknown fn'})).setMimeType(ContentService.MimeType.JSON);
    const res = map[fn](payload);
    return ContentService.createTextOutput(JSON.stringify(res || {ok:true})).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)})).setMimeType(ContentService.MimeType.JSON);
  }
}

/* ========== Utilities ========== */
function getSheet(name){ return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name); }
function readAll(name){
  const sh = getSheet(name);
  const vals = sh.getDataRange().getValues();
  if (vals.length < 2) return [];
  const head = vals[0];
  return vals.slice(1).map((row,i)=>{
    const o={}; head.forEach((h,idx)=>o[String(h||'')] = row[idx]);
    o.rowIndex = i+2; // 実シート行番号
    return o;
  });
}
function appendRowByHeader(name, obj){
  const sh = getSheet(name);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const row = head.map(h => obj.hasOwnProperty(h) ? obj[h] : '');
  sh.appendRow(row);
  return sh.getLastRow();
}
function updateRowByHeader(name, rowIndex, patch){
  const sh = getSheet(name);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const cur = sh.getRange(rowIndex,1,1,head.length).getValues()[0];
  const map = {}; head.forEach((h,i)=>map[h]=i);
  Object.keys(patch).forEach(k=>{
    if (map.hasOwnProperty(k)) cur[map[k]] = patch[k];
  });
  sh.getRange(rowIndex,1,1,head.length).setValues([cur]);
}
function ensureFolder_(...names){
  let f = DriveApp.getRootFolder();
  names.forEach(n=>{
    const it = f.getFoldersByName(n);
    f = it.hasNext()? it.next() : f.createFolder(n);
  });
  return f;
}
/* === Security Helpers (追加) === */
function _rateLimitAllowNow(kind, clientId, minIntervalMs){
  try{
    if(!clientId) return true; // client_id が無ければ制限不可
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
  // localhost / 127.0.0.1 / 10.x / 172.16-31.x / 192.168.x を弾く
  if(!host) return true;
  const h = host.toLowerCase();
  if (h==='localhost' || h.startsWith('127.') ) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  return false;
}
function _isAllowedHttpUrl(u){
  try{
    const s = String(u||'').trim();
    if(!s) return true; // 空は別途必須チェック側で判断
    if(/^data:|^javascript:|^file:|^about:|^chrome:|^vbscript:/i.test(s)) return false;
    const url = new URL(s);
    if(url.protocol !== 'https:') return false; // https 必須
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
    const id = (m1 && m1[1]) || (m2 && m2[1]) || '';
    return id ? ('https://www.youtube.com/watch?v='+id) : '';
  }catch(_){ return ''; }
}
function _serverNgCheck(text){
  try{
    const low = String(text||'').toLowerCase();
    return NG_TERMS.some(w => low.indexOf(w)>=0);
  }catch(_){ return false; }
}

/* === CSRF（追加） === */
function issueCsrfToken_(clientId){
  try{
    const tok = Utilities.getUuid().replace(/-/g,'');
    CacheService.getScriptCache().put('csrf:'+tok, clientId || '1', 2 * 60 * 60); // 2h
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

/* === DataURL 保存（強化） === */
// data:image/...;base64,XXXX → Drive 保存して公開URLを返す
function saveDataUrl(dataUrl, kindFolder){
  if (!dataUrl || String(dataUrl).indexOf('data:')!==0) return '';
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
  const m = String(y||'').match(/(\d{4})/); if(!m) return '';
  const yy = Number(m[1]); if(!yy) return '';
  return (Math.floor(yy/10)*10)+'s';
}
function asciiInitial(s){
  // ★修正のみ：先頭の "The" / "THE" / "the" を無視して頭文字判定
  let t = String(s||'').trim().replace(/^(the)\s+/i, '');
  const ch = (t[0]||'').toUpperCase();
  if(!ch) return '';
  return /[A-Z]/.test(ch) ? ch : '#';
}
function containsCi(hay, needle){
  return String(hay||'').toLowerCase().indexOf(String(needle||'').toLowerCase())>=0;
}

/* ========== Records ========== */
// 投稿（レコード紹介）
function submitFromClient(p){
  try{
    // rate limit
    if(SEC_STRICT && !_rateLimitAllowNow('post_records', p.client_id||'', RATE_POST_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    // edit_key
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length<8){
      return {ok:false,error:'invalid edit_key'};
    }
    // 画像URL（直URLが来た場合）も最低限のHTTPS/プライベート除外を検証
    if (p.image_url && !_isAllowedHttpUrl(p.image_url)) {
      return {ok:false, error:'invalid image_url'};
    }
    // youtube 正規化
    const yt = _normalizeYouTube(p.youtube_url||'');
    // 検閲：description系のみ
    const ngTxt = [p.description||'', p.description_en||'', p.author||''].join('\n');
    if(SEC_STRICT && _serverNgCheck(ngTxt)){ 
      return {ok:false, error:'ng word detected'}; 
    }

    // ★追加: description_en が空なら自動翻訳
    let descEn = p.description_en || '';
    if (!descEn && p.description) {
      try {
        descEn = LanguageApp.translate(p.description, 'ja', 'en');
      } catch(e) {
        descEn = '';
      }
    }

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
      description_en: descEn,   // ←変更済み
      image_url: p.image_url || (p.image_data ? saveDataUrl(p.image_data, 'Records') : ''),
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
  }catch(e){ return {ok:false, error:String(e)}; }
}

// 一覧（検索）
function listRecords(q){
  try{
    const all = readAll(SHEETS.Records).filter(r => !String(r.is_hidden||'').match(/true/i));
    // ▼追加：受け取ったクエリも trim
    const genre   = (q.genre   || '').trim();
    const country = (q.country || '').trim();
    const era     = (q.era     || '').trim();
    const initial = (q.initial || '').trim();

    const limit = Number(q.limit||20), offset=Number(q.offset||0);
    const filtered = all.filter(r=>{
      // シート側は従来通り trim 済みで比較
      if (genre   && String(r.genre   ||'').trim() !== genre)   return false;
      if (country && String(r.country ||'').trim() !== country) return false;
      if (era){
        const de = decadeFromYearStr(String(r.release_year||'').trim());
        if (de !== era) return false;
      }
      if (initial){
        const ini = asciiInitial(r.band); // ← "The "除外＋trim は asciiInitial 内
        if (ini !== initial) return false;
      }
      return true;
    });
    const items = filtered.slice(offset, offset+limit).map(r=>({
      rowIndex:r.rowIndex, band:r.band, track:r.track, country:r.country, genre:r.genre,
      image_url:r.image_url, author:r.author
    }));
    return {ok:true, total:filtered.length, items};
  }catch(e){ return {ok:false,error:String(e)}; }
}

// 詳細（row 指定）
function getRecordByRow(p){
  try{
    const row = Number(p && p.rowIndex || 0);
    if(!(row>=2)) return {ok:false,error:'invalid row'};
    const sh = getSheet(SHEETS.Records);
    const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const vals = sh.getRange(row,1,1,head.length).getValues()[0];
    const o={}; head.forEach((h,i)=>o[h]=vals[i]); o.rowIndex=row;
    return {ok:true, data:o};
  }catch(e){ return {ok:false,error:String(e)}; }
}
/* ========== Lives ========== */
// 投稿（ライブ）
function submitLive(p){
  try{
    if(SEC_STRICT && !_rateLimitAllowNow('post_lives', p.client_id||'', RATE_POST_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    if(!(p.artist||p.artist2||p.artist3||p.artist4||p.artist5||p.artist6)) return {ok:false,error:'artist required'};
    if(!p.date || !p.venue) return {ok:false,error:'date/venue required'};
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length<8) return {ok:false,error:'invalid edit_key'};

    // 参考URL検証 / YouTube正規化
    const refUrl = String(p.reference_url||'').trim();  // ★修正：trim を追加
    if(refUrl && !_isAllowedHttpUrl(refUrl)) return {ok:false, error:'invalid reference_url'};
    const yt = _normalizeYouTube(p.youtube_url||'');

    // 検閲（artist/title/venue は除外）
    const ngText = [
      p.price||'', p.reference_url||'', p.description||'', p.author||'',
      p.genre||'', p.prefecture||'', p.region||'', p.status||''
    ].join('\n');
    if(SEC_STRICT && _serverNgCheck(ngText)){ return {ok:false, error:'ng word detected'}; }

    const artistJoined = [p.artist,p.artist2,p.artist3,p.artist4,p.artist5,p.artist6].filter(Boolean).join(' / ');
    const row = {
      timestamp: new Date(),
      artist: artistJoined,
      title: p.title||'',
      genre: p.genre||'',
      date: p.date||'',
      open_time: p.open_time||'',
      start_time: p.start_time||'',
      venue: p.venue||'',
      region: p.region || (p.prefecture ? regionFromPref_(p.prefecture) : ''),
      prefecture: p.prefecture||'',
      price: p.price||'',
      reference_url: refUrl || '',
      description: p.description||'',
      image_url: p.image_url || (p.image_data ? saveDataUrl(p.image_data,'Lives') : ''),
      youtube_url: yt,
      author: p.author||'',
      status: (p.status||'scheduled'),
      edit_key: p.edit_key||'',
      client_id: p.client_id||'',
      is_hidden: false
    };
    appendRowByHeader(SHEETS.Lives, row);
    return {ok:true};
  }catch(e){ return {ok:false,error:String(e)}; }
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
  for (var k in MAP){ if (MAP[k].indexOf(pref)>=0) return k; }
  return '';
}
// 検索（ページング）
function listLives(q){
  try{
    const all = readAll(SHEETS.Lives).filter(r=>!String(r.is_hidden||'').match(/true/i));
    let out = all;
    if(q.genre) out = out.filter(r=> String(r.genre||'')===String(q.genre));
    if(q.region) out = out.filter(r=> String(r.region||'')===String(q.region));
    if(q.prefecture) out = out.filter(r=> String(r.prefecture||'')===String(q.prefecture));
    if(q.initial){
      out = out.filter(r => asciiInitial((r.artist||'').split('/')[0]) === String(q.initial));
    }
    if(q.status) out = out.filter(r=> String(r.status||'').toLowerCase()===String(q.status).toLowerCase());
    if(q.artist){
      out = out.filter(r=> containsCi(r.artist, q.artist));
    }
    // 日付範囲
    const from = q.date_from? new Date(q.date_from) : null;
    const to   = q.date_to? new Date(q.date_to) : null;
    if(from || to){
      out = out.filter(r=>{
        const d = new Date(r.date||'');
        if(from && d < from) return false;
        if(to && d > to) return false;
        return true;
      });
    }
    // months（1..12 の配列）
    if(q.months && q.months.length){
      const set = new Set(q.months.map(n=>Number(n)));
      out = out.filter(r=>{
        const m = (new Date(r.date||'')).getMonth()+1;
        return set.has(m);
      });
    }

    const total = out.length;
    const limit = Number(q.limit||24), offset = Number(q.offset||0);
    const items = out.slice(offset, offset+limit).map(r=>({
      rowIndex:r.rowIndex, artist:r.artist, title:r.title, genre:r.genre,
      date:r.date, open_time:r.open_time, start_time:r.start_time,
      venue:r.venue, region:r.region, prefecture:r.prefecture,
      price:r.price, description:r.description, reference_url:r.reference_url,
      image_url:r.image_url, youtube_url:r.youtube_url, status:r.status
    }));
    return {ok:true, total, items};
  }catch(e){ return {ok:false,error:String(e)}; }
}

// 編集/削除（非表示/再表示）
function editEntry(p){
  try{
    const sheetName = p.sheetName;
    const rowIndex = Number(p.rowIndex||0);
    const ek = String(p.edit_key||'');
    const action = String(p.action||'');
    if(!(rowIndex>=2) || !sheetName || !ek) return {ok:false,error:'invalid params'};
    const sh = getSheet(sheetName);
    const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    const vals = sh.getRange(rowIndex,1,1,head.length).getValues()[0];
    const map = {}; head.forEach((h,i)=>map[h]=i);
    if (!map.hasOwnProperty('edit_key')) return {ok:false,error:'no edit_key column'};
    if (String(vals[map.edit_key]||'') !== ek) return {ok:false,error:'edit_key mismatch'};
    const hide = (action==='delete');
    updateRowByHeader(sheetName, rowIndex, {is_hidden:hide});
    return {ok:true};
  }catch(e){ return {ok:false,error:String(e)}; }
}

/* ========== Features ========== */
// 投稿（特集）
function submitFeature(p){
  try{
    if(SEC_STRICT && !_rateLimitAllowNow('post_features', p.client_id||'', RATE_POST_MIN_INTERVAL_MS)){
      return {ok:false, error:'rate limited'};
    }
    if(!p.title) return {ok:false,error:'title required'};
    if(!/^[A-Za-z0-9]+$/.test(String(p.edit_key||'')) || String(p.edit_key||'').length<8) return {ok:false,error:'invalid edit_key'};

    // 直URLでの画像指定がある場合はHTTPS/プライベート除外を検証
    for (let i=1;i<=5;i++){
      for (let j=1;j<=3;j++){
        const kUrl = 'p'+i+'_img'+j+'_url';
        if (p[kUrl] && !_isAllowedHttpUrl(p[kUrl])) {
          return {ok:false, error:'invalid image_url'};
        }
      }
    }

    // 検閲（title/genre_other除外）
    var ngPool = [p.author||'', p.era||'', p.region||''].join('\n');
    for (let i=1;i<=5;i++){
      ngPool += '\n' + (p['para'+i+'_text']||'');
    }
    if(SEC_STRICT && _serverNgCheck(ngPool)){ return {ok:false, error:'ng word detected'}; }

    const slug = p.slug || (slugify_(p.title)+'-'+(new Date().getTime().toString(36)));
    const row = {
      timestamp: new Date(),
      status: p.status || 'published',
      title: p.title||'',
      author: p.author||'',
      genre: p.genre||'',
      genre_other: p.genre_other||'',
      era: p.era||'',
      region: p.region||'',
      slug: slug,
      edit_key: p.edit_key||'',
      client_id: p.client_id||'',
      is_hidden: false
    };
    for (let i=1;i<=5;i++){
      row['para'+i+'_text'] = p['para'+i+'_text'] || '';
      // YouTube 正規化
      row['youtube'+i] = _normalizeYouTube(p['youtube'+i] || '');
      for (let j=1;j<=3;j++){
        const kUrl = 'p'+i+'_img'+j+'_url';
        const kData= 'p'+i+'_img'+j+'_data';
        row[kUrl] = p[kUrl] || (p[kData] ? saveDataUrl(p[kData],'Features') : '');
      }
    }
    appendRowByHeader(SHEETS.Features, row);
    return {ok:true, slug};
  }catch(e){ return {ok:false,error:String(e)}; }
}
function slugify_(s){
  return String(s||'')
    .toLowerCase()
    .replace(/[^\w\s-]/g,'')
    .trim()
    .replace(/\s+/g,'-')
    .slice(0,72);
}

// 一覧（公開分）
function listFeatures(q){
  try{
    const all = readAll(SHEETS.Features).filter(r => !String(r.is_hidden||'').match(/true/i));
    let out = all.filter(r => String((r.status||'published')).toLowerCase()==='published');
    const total = out.length;
    const limit = Number(q.limit||100), offset=Number(q.offset||0);
    const items = out.slice(offset, offset+limit).map(r=>{
      const d = {
        rowIndex:r.rowIndex, slug:r.slug, status:r.status, title:r.title,
        author:r.author, genre:r.genre, era:r.era, region:r.region
      };
      d.para1_text = r.para1_text||''; d.para2_text=r.para2_text||''; d.para3_text=r.para3_text||'';
      return d;
    });
    return {ok:true, total, items};
  }catch(e){ return {ok:false,error:String(e)}; }
}

// 詳細（rowIndex または slug）
function getFeatureById(p){
  try{
    const all = readAll(SHEETS.Features);
    let r=null, rowIndex = 0;
    if (p && p.slug){
      r = all.find(x => String(x.slug||'')===String(p.slug));
      rowIndex = r ? r.rowIndex : 0;
    }else if(p && p.rowIndex){
      r = all.find(x => x.rowIndex===Number(p.rowIndex));
      rowIndex = Number(p.rowIndex||0);
    }
    if(!r) return {ok:false};
    return {ok:true, data:r, rowIndex};
  }catch(e){ return {ok:false,error:String(e)}; }
}

/* ========== Reports (通報) ========== */
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
      timestamp:new Date(), sheetName, rowIndex, reason, client_id
    });
    const all = readAll(SHEETS.Reports).filter(r => String(r.sheetName)===sheetName && Number(r.rowIndex)===rowIndex);
    let autoHidden = false;
    if (all.length >= REPORT_AUTOHIDE_THRESHOLD){
      updateRowByHeader(sheetName, rowIndex, {is_hidden:true});
      autoHidden = true;
    }
    return {ok:true, autoHidden};
  }catch(e){ return {ok:false,error:String(e)}; }
}

/* ========== HTML include helper (必要なら使用) ========== */
function include_(name){ return HtmlService.createHtmlOutputFromFile(name).getContent(); }

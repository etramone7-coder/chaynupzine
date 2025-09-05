// config.js
// GAS の実行URL（GitHub Pages から参照）
// クエリに ?exec=... が付いていればそちらを優先し、なければ FALLBACK_EXEC を使う
(function () {
  var FALLBACK_EXEC =
    'https://script.google.com/macros/s/AKfycbznOw5AqZl9NqA1JvCgZqVI5HmmlIXTWG59CTuRO81s47lwzijy7XDAFOk7SpTQl76HZw/exec';
  var qExec = new URLSearchParams(location.search).get('exec');
  window.EXEC_URL = qExec || FALLBACK_EXEC;
})();

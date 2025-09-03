// config.js
// GAS の実行URL（GitHub Pages から参照）
// クエリに ?exec=... が付いていればそちらを優先し、なければ FALLBACK_EXEC を使う
(function () {
  var FALLBACK_EXEC =
    'https://script.google.com/macros/s/AKfycbwOiiXfncZ7n-Ebp9gaCi66ZDOiUqdRbKZSIJhhc0rKiMQqu577CgjQ8_afOQc5md3DZw/exec';
  var qExec = new URLSearchParams(location.search).get('exec');
  window.EXEC_URL = qExec || FALLBACK_EXEC;
})();

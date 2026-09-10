/* MENUO visitor scanner - independent click handler and camera flow. */
(function () {
  'use strict';

  var controls = null;
  var reader = null;
  var starting = false;

  function showOnly(id) {
    document.querySelectorAll('.screen').forEach(function (el) {
      el.classList.add('hidden');
    });
    var target = document.getElementById(id);
    if (target) target.classList.remove('hidden');
  }

  function ensureScanner() {
    var existing = document.getElementById('scanner');
    if (existing) return existing;

    var s = document.createElement('section');
    s.id = 'scanner';
    s.className = 'screen hidden';
    s.innerHTML =
      '<div class="top"><button class="back" id="menuoScannerBack">‹</button>' +
      '<div class="brand">Сканировать QR</div><span style="width:40px"></span></div>' +
      '<div class="scan"><div class="camera"><video id="scannerVideo" playsinline muted></video>' +
      '<div class="frame"></div></div>' +
      '<div class="scan-status" id="scanStatus">Нажмите «Запустить камеру»</div>' +
      '<button class="secondary" id="menuoScannerRetry" style="margin-top:8px">Запустить камеру</button></div>' +
      '<div class="notice" id="scannerHelp">Наведите заднюю камеру на QR-код MENUO. После распознавания откроется именно это меню.</div>';

    var app = document.getElementById('app');
    var nav = app && app.querySelector('.global-nav');
    if (nav) app.insertBefore(s, nav);
    else if (app) app.appendChild(s);
    else document.body.appendChild(s);

    s.querySelector('#menuoScannerBack').onclick = function () {
      stop();
      showOnly('home');
    };
    s.querySelector('#menuoScannerRetry').onclick = function () {
      start();
    };
    return s;
  }

  function stop() {
    try { if (controls && controls.stop) controls.stop(); } catch (e) {}
    controls = null;
    try { if (reader && reader.reset) reader.reset(); } catch (e) {}
    reader = null;
    var video = document.getElementById('scannerVideo');
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach(function (track) { track.stop(); });
      video.srcObject = null;
    }
    starting = false;
  }

  function loadZXing() {
    if (window.ZXingBrowser && window.ZXingBrowser.BrowserQRCodeReader) {
      return Promise.resolve(window.ZXingBrowser);
    }
    return new Promise(function (resolve, reject) {
      var old = document.querySelector('script[data-menuo-zxing]');
      if (old) {
        var timer = setInterval(function () {
          if (window.ZXingBrowser && window.ZXingBrowser.BrowserQRCodeReader) {
            clearInterval(timer);
            resolve(window.ZXingBrowser);
          }
        }, 100);
        setTimeout(function () { clearInterval(timer); reject(new Error('zxing-timeout')); }, 10000);
        return;
      }
      var script = document.createElement('script');
      script.src = 'https://unpkg.com/@zxing/browser@0.1.5/umd/index.min.js';
      script.async = true;
      script.dataset.menuoZxing = '1';
      script.onload = function () {
        if (window.ZXingBrowser && window.ZXingBrowser.BrowserQRCodeReader) resolve(window.ZXingBrowser);
        else reject(new Error('zxing-global-missing'));
      };
      script.onerror = function () { reject(new Error('zxing-load-failed')); };
      document.head.appendChild(script);
    });
  }

  async function start() {
    var screen = ensureScanner();
    showOnly('scanner');
    var status = screen.querySelector('#scanStatus');
    var video = screen.querySelector('#scannerVideo');

    if (starting) return;
    starting = true;
    stop();
    starting = true;
    status.textContent = 'Запрашиваем доступ к камере…';

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('camera-api-unavailable');
      }

      /* Request camera immediately so the user gets the browser permission prompt. */
      var stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      stream.getTracks().forEach(function (track) { track.stop(); });
      video.srcObject = null;

      status.textContent = 'Загружаем сканер QR…';
      var ZX = await loadZXing();
      reader = new ZX.BrowserQRCodeReader();
      var devices = await ZX.BrowserCodeReader.listVideoInputDevices();
      var device = (devices || []).find(function (d) {
        return /back|rear|environment/i.test(d.label);
      }) || (devices || [])[0];
      if (!device) throw new Error('camera-not-found');

      controls = await reader.decodeFromVideoDevice(device.deviceId, video, function (result) {
        if (!result) return;
        var raw = result.getText();
        stop();
        try {
          var url = new URL(raw, location.href);
          var token = url.searchParams.get('menu');
          if (token) {
            location.href = url.origin + url.pathname + '?menu=' + encodeURIComponent(token);
            return;
          }
          if (/^https?:\/\//i.test(raw)) {
            location.href = raw;
            return;
          }
        } catch (e) {}
        status.textContent = 'Этот QR не является ссылкой MENUO.';
        starting = false;
      });
      status.textContent = 'Наведите камеру на QR-код MENUO';
      starting = false;
    } catch (error) {
      console.error('MENUO scanner error:', error);
      status.textContent = 'Не удалось открыть камеру. Разрешите доступ к камере и нажмите кнопку ещё раз.';
      starting = false;
    }
  }

  function bind() {
    /* Capture phase guarantees this works even if the old inline onclick is broken. */
    document.addEventListener('click', function (event) {
      var button = event.target && event.target.closest ? event.target.closest('button.role') : null;
      if (!button) return;
      if ((button.textContent || '').indexOf('Я посетитель ресторана') === -1) return;
      event.preventDefault();
      event.stopPropagation();
      start();
    }, true);

    window.startScanner = start;
    window.stopScanner = stop;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();

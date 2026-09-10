/* MENUO visitor flow hardening: always open a working scanner UI. */
(function(){
  'use strict';
  function esc(s){return String(s).replace(/[&<>\"]/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]})}
  function ensureScanner(){
    var existing=document.getElementById('scanner');
    if(existing) return existing;
    var s=document.createElement('section');
    s.id='scanner'; s.className='screen hidden';
    s.innerHTML='<div class="top"><button class="back" id="menuoScannerBack">‹</button><div class="brand">Сканировать QR</div><span style="width:40px"></span></div><div class="scan"><div class="camera"><video id="scannerVideo" playsinline muted></video><div class="frame"></div></div><div class="scan-status" id="scanStatus">Подготовка камеры…</div><button class="secondary" id="menuoScannerRetry" style="margin-top:8px">Запустить камеру</button></div><div class="notice" id="scannerHelp">Наведите заднюю камеру на QR-код MENUO. После распознавания откроется именно то меню, к которому привязан QR.</div>';
    var app=document.getElementById('app');
    var nav=app&&app.querySelector('.global-nav');
    if(nav) app.insertBefore(s,nav); else if(app) app.appendChild(s); else document.body.appendChild(s);
    s.querySelector('#menuoScannerBack').onclick=function(){stop(); showSafe('home')};
    s.querySelector('#menuoScannerRetry').onclick=function(){start()};
    return s;
  }
  function showSafe(id){
    document.querySelectorAll('.screen').forEach(function(x){x.classList.add('hidden')});
    var el=document.getElementById(id); if(el) el.classList.remove('hidden');
  }
  var controls=null, reader=null;
  function stop(){
    try{if(controls&&controls.stop)controls.stop()}catch(e){}
    controls=null;
    try{if(reader&&reader.reset)reader.reset()}catch(e){}
    reader=null;
    var v=document.getElementById('scannerVideo');
    if(v&&v.srcObject){v.srcObject.getTracks().forEach(function(t){t.stop()});v.srcObject=null}
  }
  async function start(){
    var s=ensureScanner(); showSafe('scanner');
    var status=s.querySelector('#scanStatus'), video=s.querySelector('#scannerVideo');
    status.textContent='Запрашиваем доступ к камере…';
    try{
      var z=await import('https://unpkg.com/@zxing/browser@0.1.5/+esm');
      reader=new z.BrowserQRCodeReader();
      var devices=await z.BrowserCodeReader.listVideoInputDevices();
      var device=(devices||[]).find(function(d){return /back|rear|environment/i.test(d.label)})||(devices||[])[0];
      if(!device) throw new Error('camera-not-found');
      controls=await reader.decodeFromVideoDevice(device.deviceId,video,function(result){
        if(!result)return;
        var raw=result.getText();
        stop();
        try{
          var u=new URL(raw,location.href), token=u.searchParams.get('menu');
          if(token){u.searchParams.set('menu',token); location.href=u.toString(); return}
          if(/^https?:\\/\\//i.test(raw)){location.href=raw;return}
        }catch(e){}
        status.textContent='Этот QR не является ссылкой MENUO.';
      });
      status.textContent='Наведите камеру на QR-код MENUO';
    }catch(e){
      console.error('MENUO scanner error',e);
      status.textContent='Камеру не удалось открыть. Разрешите доступ к камере в браузере.';
    }
  }
  function bind(){
    var buttons=document.querySelectorAll('button.role');
    buttons.forEach(function(b){
      if((b.textContent||'').indexOf('Я посетитель ресторана')!==-1){
        b.onclick=function(e){e.preventDefault();e.stopPropagation();start()};
      }
    });
    window.startScanner=start;
    window.stopScanner=stop;
    if(new URLSearchParams(location.search).get('menu')){
      // The production bridge handles the actual public-menu load.
      // Do not show the home screen while that route is being resolved.
      setTimeout(function(){
        var pub=document.getElementById('publicMenu');
        if(pub && pub.classList.contains('hidden')) pub.classList.remove('hidden');
      },800);
    }
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',bind);else bind();
})();

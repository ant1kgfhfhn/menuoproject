/* MENUO production bridge: Supabase persistence, immutable QR routing and ZXing scanner. */
(function(){
  'use strict';
  const SUPABASE_URL='https://vizmqgmefbgcggyfzdkj.supabase.co';
  const SUPABASE_KEY='sb_publishable_G_9VANFg4Dh7vuw8qpwwGw_Ck0h0H_3';
  let sb=null, scanner=null, scanControls=null;

  function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});}
  async function boot(){
    try{
      if(!window.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
      window.MENUO_SUPABASE=sb;
      await routePublicMenu();
      sb.auth.onAuthStateChange(()=>{});
      patchNavigation();
    }catch(e){console.error('MENUO backend boot failed',e);}
  }

  function appUrl(token){const u=new URL(window.location.href);u.search='';u.hash='';u.searchParams.set('menu',token);return u.toString();}
  function getLocalState(){try{return typeof state!=='undefined'?state:null}catch(_){return null}}
  function getCurrentRestaurant(){
    try{if(typeof currentRestaurant==='function'){const r=currentRestaurant();if(r)return r;}}catch(_){ }
    const s=getLocalState(); if(!s)return null;
    const list=s.restaurants||[]; return list.find(r=>r.id===s.currentRestaurantId||r.id===s.currentRestaurant)||list[0]||null;
  }
  function slugify(v){return String(v||'restaurant').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70)||'restaurant';}
  function dishesOf(r){return Array.isArray(r?.dishes)?r.dishes:(Array.isArray(r?.items)?r.items:[])}
  function catsOf(r){return Array.isArray(r?.categories)?r.categories:[]}

  async function syncLocalMenu(){
    const {data:{user}}=await sb.auth.getUser();
    if(!user) throw new Error('Сначала войдите в аккаунт MENUO.');
    const r=getCurrentRestaurant(); if(!r) throw new Error('Сначала создайте ресторан.');
    const slug=slugify(r.slug||r.name);
    const restaurantPayload={owner_id:user.id,name:r.name||'Мой ресторан',slug,logo_url:r.logoUrl||r.logo_url||null,address:r.address||null,phone:r.phone||null,description:r.description||null,website:r.website||null,instagram:r.instagram||null,facebook:r.facebook||null,hours:r.hours||{},default_locale:r.defaultLocale||r.default_locale||'ru',published:true};
    let {data:rest,error}=await sb.from('restaurants').upsert(restaurantPayload,{onConflict:'owner_id,slug'}).select().maybeSingle();
    if(error){
      const q=await sb.from('restaurants').select('*').eq('owner_id',user.id).eq('slug',slug).maybeSingle();
      if(q.error) throw q.error; rest=q.data;
      if(rest){const u=await sb.from('restaurants').update(restaurantPayload).eq('id',rest.id).select().single();if(u.error)throw u.error;rest=u.data;}
    }
    if(!rest) throw new Error('Не удалось сохранить ресторан.');
    const cats=catsOf(r);
    if(cats.length){
      await sb.from('categories').delete().eq('restaurant_id',rest.id);
      const rows=cats.map((c,i)=>({restaurant_id:rest.id,name:String(c.name||c.title||`Категория ${i+1}`),sort_order:i,is_active:true}));
      const cr=await sb.from('categories').insert(rows).select(); if(cr.error)throw cr.error;
    }
    const catRows=await sb.from('categories').select('id,name').eq('restaurant_id',rest.id).order('sort_order'); if(catRows.error)throw catRows.error;
    const catMap=new Map((catRows.data||[]).map(c=>[c.name,c.id]));
    await sb.from('dishes').delete().eq('restaurant_id',rest.id);
    const ds=dishesOf(r).map((d,i)=>({restaurant_id:rest.id,category_id:catMap.get(d.categoryName||d.category||d.categoryTitle)||null,name:String(d.name||'Блюдо'),description:String(d.description||''),price_cents:Math.max(0,Math.round(Number(String(d.price??d.priceCents??0).replace(',','.'))*100)),currency:d.currency||'EUR',image_url:(d.imageUrl||d.image_url||'').startsWith('http')?(d.imageUrl||d.image_url):null,is_available:d.available!==false&&d.isAvailable!==false,sort_order:i,allergens:Array.isArray(d.allergens)?d.allergens:[]}));
    if(ds.length){const dr=await sb.from('dishes').insert(ds);if(dr.error)throw dr.error;}
    let qr=await sb.from('qr_codes').select('*').eq('restaurant_id',rest.id).maybeSingle();
    if(qr.error)throw qr.error;
    if(!qr.data){const made=await sb.from('qr_codes').insert({restaurant_id:rest.id,name:'Основной QR',is_active:true}).select().single();if(made.error)throw made.error;qr=made;}
    return {restaurant:rest,qr:qr.data,url:appUrl(qr.data.token)};
  }

  function showQr(url){
    let layer=document.getElementById('menuoQrLayer');
    if(!layer){layer=document.createElement('div');layer.id='menuoQrLayer';layer.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(20,29,24,.72);display:grid;place-items:center;padding:18px';document.body.appendChild(layer);}
    layer.innerHTML='<div style="width:min(100%,430px);background:#fffdfa;border-radius:26px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,.25);text-align:center;color:#17201c"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:20px">Постоянный QR-код</b><button id="menuoQrClose" style="border:0;background:#eef2ef;border-radius:10px;width:38px;height:38px;font-size:22px">×</button></div><p style="color:#69756e;font-size:13px;line-height:1.4">Этот QR привязан к этому меню и не меняется при редактировании блюд.</p><div id="menuoQrCanvas" style="display:grid;place-items:center;margin:15px auto"></div><div style="background:#f4f5ef;border-radius:11px;padding:10px;font-size:11px;word-break:break-all;color:#69756e">'+escapeHtml(url)+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px"><button id="menuoQrOpen" style="border:0;border-radius:12px;padding:13px;background:#ddf4e9;color:#1b6b4e;font-weight:800">Открыть меню</button><button id="menuoQrDownload" style="border:0;border-radius:12px;padding:13px;background:#1b6b4e;color:#fff;font-weight:800">Скачать QR</button></div></div>';
    layer.querySelector('#menuoQrClose').onclick=()=>layer.remove();
    layer.querySelector('#menuoQrOpen').onclick=()=>location.href=url;
    layer.querySelector('#menuoQrDownload').onclick=()=>downloadQr(url);
    loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js').then(()=>{const box=layer.querySelector('#menuoQrCanvas');new QRCode(box,{text:url,width:270,height:270,correctLevel:QRCode.CorrectLevel.H});});
  }
  function escapeHtml(s){return String(s).replace(/[&<>\"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
  async function downloadQr(url){try{await loadScript('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/build/qrcode.min.js');const data=await QRCode.toDataURL(url,{width:1200,margin:3,errorCorrectionLevel:'H'});const a=document.createElement('a');a.href=data;a.download='menuo-qr.png';a.click();}catch(e){alert('Не удалось скачать QR. Откройте меню и попробуйте ещё раз.');}}

  async function routePublicMenu(){
    const token=new URLSearchParams(location.search).get('menu'); if(!token)return;
    const {data,error}=await sb.rpc('get_public_menu',{p_token:token});
    if(error||!data){console.error(error);return;}
    if(typeof show==='function')show('publicMenu');
    const r=data.restaurant,dishes=data.dishes||[],cats=data.categories||[];
    const host=document.getElementById('publicMenu'); if(!host)return;
    const byCat=new Map(cats.map(c=>[c.id,c.name]));
    host.innerHTML='<div class="public-hero"><div class="rest-logo">'+escapeHtml((r.name||'R').slice(0,1).toUpperCase())+'</div><h1>'+escapeHtml(r.name)+'</h1><p>'+escapeHtml(r.description||'Цифровое меню MENUO')+'</p></div><div id="menuoPublicItems"></div>';
    const items=host.querySelector('#menuoPublicItems');
    if(!dishes.length){items.innerHTML='<div class="empty">Меню пока пустое.</div>';return;}
    items.innerHTML=dishes.map(d=>'<article class="dish '+(d.is_available?'':'unavailable')+'"><div class="food">'+(d.image_url?'<img src="'+escapeHtml(d.image_url)+'" alt="">':'🍽️')+'</div><div class="dish-info"><h3>'+escapeHtml(d.name)+'</h3><p>'+escapeHtml(d.description||'')+'</p><small style="color:#69756e">'+escapeHtml(byCat.get(d.category_id)||'')+'</small></div><div class="price">'+(Number(d.price_cents)/100).toFixed(2).replace('.',',')+' '+escapeHtml(d.currency||'EUR')+'</div></article>').join('');
    try{await sb.from('analytics_events').insert({restaurant_id:r.id,qr_code_id:null,event_type:'menu_view',metadata:{source:'public'}})}catch(_){ }
  }

  async function startScannerProduction(){
    const video=document.querySelector('#scannerVideo, video');
    if(typeof show==='function')show('scanner');
    if(!video){alert('Не найдено окно камеры.');return;}
    let status=document.querySelector('#scanStatus,.scan-status'); if(status)status.textContent='Запрашиваем доступ к камере…';
    try{
      const z=await import('https://unpkg.com/@zxing/browser@0.1.5/+esm');
      const reader=new z.BrowserQRCodeReader(); scanner=reader;
      const devices=await z.BrowserCodeReader.listVideoInputDevices();
      const device=(devices||[]).find(d=>/back|rear|environment/i.test(d.label))||(devices||[])[0];
      if(!device)throw new Error('Камера не найдена');
      scanControls=await reader.decodeFromVideoDevice(device.deviceId,video,(result,err)=>{
        if(result){stopScanner();handleScan(result.getText());}
      });
      if(status)status.textContent='Наведите камеру на QR-код MENUO';
    }catch(e){console.error(e);if(status)status.textContent='Не удалось открыть камеру. Разрешите доступ к камере и используйте HTTPS.';}
  }
  function stopScanner(){try{scanControls&&scanControls.stop();}catch(_){ }scanControls=null;try{scanner&&scanner.reset();}catch(_){ }scanner=null;const v=document.querySelector('#scannerVideo, video');if(v&&v.srcObject){v.srcObject.getTracks().forEach(t=>t.stop());v.srcObject=null;}}
  function handleScan(raw){try{const u=new URL(raw,location.href);const token=u.searchParams.get('menu');if(token){location.href=appUrl(token);return;}if(/^https?:/i.test(raw)){location.href=raw;return;}throw new Error('unsupported');}catch(_){alert('Это не QR-код меню MENUO.');}}

  function patchNavigation(){
    window.startScanner=startScannerProduction;
    window.stopScanner=stopScanner;
    const oldSave=window.saveMenuAndQr;
    document.addEventListener('click',async e=>{
      const b=e.target.closest('button'); if(!b)return;
      const text=(b.textContent||'').trim();
      if(/Сохранить меню и открыть QR-код|Сохранить меню и сгенерировать QR-код/i.test(text)){
        e.preventDefault();e.stopImmediatePropagation();
        try{b.disabled=true;const x=await syncLocalMenu();showQr(x.url);}catch(err){console.error(err);alert(err.message||'Не удалось сохранить меню.');}finally{b.disabled=false;}
      }
    },true);
    window.addEventListener('beforeunload',stopScanner);
  }
  window.MENUO_SYNC_MENU=syncLocalMenu;
  window.MENUO_OPEN_QR=async()=>{try{const x=await syncLocalMenu();showQr(x.url)}catch(e){alert(e.message||'Ошибка QR');}};
  boot();
})();

/* MENUO production runtime: Supabase persistence + immutable QR. */
(function(){
  'use strict';

  const SUPABASE_URL='https://vizmqgmefbgcggyfzdkj.supabase.co';
  const SUPABASE_KEY='sb_publishable_G_9VANFg4Dh7vuw8qpwwGw_Ck0h0H_3';
  let sb=null;

  function loadScript(src){
    return new Promise((resolve,reject)=>{
      const s=document.createElement('script');
      s.src=src;s.async=true;s.onload=resolve;s.onerror=reject;
      document.head.appendChild(s);
    });
  }

  function localState(){try{return typeof state!=='undefined'?state:null}catch(_){return null}}
  function saveLocal(){try{if(typeof save==='function')save()}catch(_){}}
  function current(){
    try{if(typeof currentRestaurant==='function')return currentRestaurant()}catch(_){}
    const s=localState();
    return s?.restaurants?.find(r=>r.id===s.activeRestaurantId&&r.ownerId===s.session)||null;
  }
  function slugify(v){
    return String(v||'restaurant').toLowerCase().normalize('NFKD')
      .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-')
      .replace(/^-+|-+$/g,'').slice(0,70)||'restaurant';
  }
  function esc(v){
    return String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  }
  function publicUrl(token){
    const u=new URL(location.href);
    u.search='';u.hash='';
    u.searchParams.set('menu',token);
    return u.toString();
  }

  async function boot(){
    try{
      if(!window.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
      sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
      });
      window.MENUO_SUPABASE=sb;
      patchPublicLinks();
      patchSaveButton();
    }catch(e){console.error('MENUO backend boot failed',e)}
  }

  async function saveRestaurant(r,user){
    const slug=slugify(r.slug||r.name);
    const payload={
      owner_id:user.id,name:r.name||'Мой ресторан',slug,
      logo_url:r.logoUrl||r.logo_url||null,address:r.address||null,phone:r.phone||null,
      description:r.description||null,website:r.website||null,instagram:r.instagram||null,
      facebook:r.facebook||null,hours:typeof r.hours==='object'&&r.hours!==null?r.hours:{display:String(r.hours||'')},
      default_locale:r.defaultLocale||r.default_locale||'ru',published:true
    };

    let rest=null;

    if(r.remoteId){
      const q=await sb.from('restaurants').update(payload).eq('id',r.remoteId).select().maybeSingle();
      if(q.error)throw q.error;
      rest=q.data;
    }

    if(!rest){
      const q=await sb.from('restaurants').select('*').eq('owner_id',user.id).eq('slug',slug).maybeSingle();
      if(q.error)throw q.error;
      rest=q.data||null;
    }

    if(rest){
      const q=await sb.from('restaurants').update(payload).eq('id',rest.id).select().single();
      if(q.error)throw q.error;
      rest=q.data;
    }else{
      // Recover a restaurant already created by an earlier partial save.
      // This is important when the local restaurant id/slug differs from the DB row.
      const byName=await sb.from('restaurants').select('*').eq('owner_id',user.id).eq('name',payload.name).order('created_at',{ascending:true}).limit(1).maybeSingle();
      if(byName.error)throw byName.error;
      if(byName.data){
        const uq=await sb.from('restaurants').update(payload).eq('id',byName.data.id).select().single();
        if(uq.error)throw uq.error;
        rest=uq.data;
      }
      if(rest)return (r.remoteId=rest.id,r.slug=rest.slug,saveLocal(),rest);
      const q=await sb.from('restaurants').insert(payload).select().single();
      if(q.error){
        // A previous save may have created the restaurant before a later step failed.
        // On FREE (1 restaurant) the local copy can have a different slug, so recover
        // the owner's existing restaurant instead of hitting the plan-limit trigger.
        const retry=await sb.from('restaurants').select('*').eq('owner_id',user.id).eq('slug',slug).maybeSingle();
        if(retry.error)throw q.error;
        if(retry.data){
          rest=retry.data;
        }else if(false && (q.error?.code==='P0001' || /restaurant_limit_reached/i.test(q.error?.message||''))){
          const owned=await sb.from('restaurants').select('*').eq('owner_id',user.id).order('created_at',{ascending:true}).limit(1).maybeSingle();
          if(owned.error||!owned.data)throw q.error;
          const recovered=await sb.from('restaurants').update(payload).eq('id',owned.data.id).select().single();
          if(recovered.error)throw recovered.error;
          rest=recovered.data;
        }else throw q.error;
      }else rest=q.data;
    }

    if(!rest)throw new Error('Не удалось сохранить ресторан в базе данных.');
    r.remoteId=rest.id;r.slug=rest.slug;
    saveLocal();
    return rest;
  }

  async function syncCategories(r,restaurantId){
    const names=[...(Array.isArray(r.categories)?r.categories:[])].map(x=>String(x||'').trim()).filter(Boolean);
    const unique=[...new Set(names.length?names:['Все'])];

    const existing=await sb.from('categories').select('id,name').eq('restaurant_id',restaurantId);
    if(existing.error)throw existing.error;
    const byName=new Map((existing.data||[]).map(x=>[x.name,x.id]));

    // Keep existing UUIDs; omit id for new rows so Postgres generates it.
    const existingRows=unique.filter(name=>byName.has(name)).map((name,i)=>({
      id:byName.get(name),restaurant_id:restaurantId,name,sort_order:i,is_active:true
    }));
    if(existingRows.length){
      const uq=await sb.from('categories').upsert(existingRows,{onConflict:'id'}).select();
      if(uq.error)throw uq.error;
    }
    const newRows=unique.filter(name=>!byName.has(name)).map((name,i)=>({
      restaurant_id:restaurantId,name,sort_order:i,is_active:true
    }));
    let inserted=[];
    if(newRows.length){
      const iq=await sb.from('categories').insert(newRows).select();
      if(iq.error)throw iq.error;
      inserted=iq.data||[];
    }
    const qData=[...existingRows.map(x=>({id:x.id,name:x.name})),...inserted.map(x=>({id:x.id,name:x.name}))];

    const keep=new Set(unique);
    const stale=(existing.data||[]).filter(x=>!keep.has(x.name));
    if(stale.length){
      const del=await sb.from('categories').delete().in('id',stale.map(x=>x.id));
      if(del.error)throw del.error;
    }

    return new Map(qData.map(x=>[x.name,x.id]));
  }

  function localDishes(r){
    const s=localState();
    if(!Array.isArray(s?.dishes)||!r)return [];
    const ids=new Set([r.id,r.remoteId].filter(x=>x!=null).map(String));
    let matched=s.dishes.filter(d=>ids.has(String(d.restaurantId)));
    if(matched.length)return matched;
    // Recover draft dishes whose restaurantId was left pointing at an old local ID.
    const known=new Set((s.restaurants||[]).map(x=>String(x.id)));
    const active=String(s.activeRestaurantId||'')===String(r.id)||String(s.activeRestaurantId||'')===String(r.remoteId||'');
    if(active){
      const orphaned=s.dishes.filter(d=>!known.has(String(d.restaurantId)));
      if(orphaned.length){orphaned.forEach(d=>{d.restaurantId=r.id});saveLocal();return orphaned;}
    }
    return [];
  }

  async function syncDishes(r,restaurantId,catMap,userId){
    const old=await sb.from('dishes').select('id').eq('restaurant_id',restaurantId);
    if(old.error)throw old.error;

    // Build and upload all rows before touching existing records. A failed image upload
    // must never delete a restaurant's previously saved menu.
    const ds=[];
    const local=localDishes(r);
    const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for(let i=0;i<local.length;i++){
      const d=local[i];
      const stableId=uuidPattern.test(String(d.remoteId||''))?d.remoteId:
        (uuidPattern.test(String(d.id||''))?d.id:(crypto.randomUUID?crypto.randomUUID():null));
      if(stableId){d.id=stableId;d.remoteId=stableId;}
      let image=String(d.photo||d.imageUrl||d.image_url||'');
      if(image.startsWith('data:image/')){
        const response=await fetch(image);
        if(!response.ok)throw new Error('Не удалось подготовить фотографию блюда.');
        const blob=await response.blob();
        const ext=blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg';
        const path=`${userId}/${restaurantId}/dishes/${String(stableId||i).replace(/[^a-zA-Z0-9_-]/g,'-')}.${ext}`;
        const up=await sb.storage.from('restaurant-photos').upload(path,blob,{contentType:blob.type||'image/jpeg',upsert:true});
        if(up.error)throw up.error;
        image=sb.storage.from('restaurant-photos').getPublicUrl(path).data.publicUrl;
        d.imageUrl=image;
      }
      const row={
        restaurant_id:restaurantId,
        category_id:catMap.get(String(d.category||d.categoryName||'').trim())||null,
        name:String(d.name||'Блюдо').trim()||'Блюдо',
        description:String(d.description||''),
        price_cents:(d.priceCents!==undefined&&d.priceCents!==null&&Number.isFinite(Number(d.priceCents)))?Math.max(0,Math.round(Number(d.priceCents))):Math.max(0,Math.round((Number(String(d.price??0).replace(',','.').replace(/[^0-9.-]/g,''))||0)*100)),
        currency:d.currency||'EUR',
        image_url:image.startsWith('http')?image:null,
        is_available:d.available!==false&&d.isAvailable!==false,
        sort_order:i,
        allergens:Array.isArray(d.allergens)?d.allergens:[],
        discount_percent:Number(d.discountPercent)>0?Math.max(1,Math.min(100,Math.round(Number(d.discountPercent)))):null,
        discount_cents:Number(d.discountCents)>0?Math.max(1,Math.round(Number(d.discountCents))):null
      };
      if(stableId)row.id=stableId;
      ds.push(row);
    }

    if(ds.length){
      const q=await sb.from('dishes').upsert(ds,{onConflict:'id'}).select('id');
      if(q.error)throw q.error;
      const expected=ds.filter(d=>d.discount_percent!==null||d.discount_cents!==null);
      if(expected.length){
        const ids=expected.map(d=>d.id).filter(Boolean);
        const check=await sb.from('dishes').select('id,discount_percent,discount_cents').in('id',ids);
        if(check.error)throw check.error;
        const savedById=new Map((check.data||[]).map(d=>[String(d.id),d]));
        const missing=expected.find(d=>{const actual=savedById.get(String(d.id));return !actual||Number(actual.discount_percent||0)!==Number(d.discount_percent||0)||Number(actual.discount_cents||0)!==Number(d.discount_cents||0)});
        if(missing)throw new Error('Скидка блюда не подтвердилась в базе данных. Повтори сохранение.');
      }
    }
    const keep=new Set(ds.map(d=>d.id).filter(Boolean));
    const stale=(old.data||[]).map(d=>d.id).filter(id=>!keep.has(id));
    if(stale.length){
      const del=await sb.from('dishes').delete().in('id',stale);
      if(del.error)throw del.error;
    }
    saveLocal();
  }

  async function syncQr(r,restaurantId){
    let q=await sb.from('qr_codes').select('*').eq('restaurant_id',restaurantId).eq('is_active',true).order('created_at',{ascending:true}).limit(1).maybeSingle();
    if(q.error)throw q.error;
    if(!q.data){
      q=await sb.from('qr_codes').insert({
        restaurant_id:restaurantId,name:'Основной QR',is_active:true
      }).select().single();
      if(q.error){
        // Another save may have created the primary QR at the same time.
        const recovered=await sb.from('qr_codes').select('*').eq('restaurant_id',restaurantId)
          .eq('is_active',true).eq('name','Основной QR')
          .order('created_at',{ascending:true}).limit(1).maybeSingle();
        if(recovered.error||!recovered.data)throw q.error;
        q=recovered;
      }
    }
    r.qrToken=q.data.token;
    r.qrCreated=true;
    saveLocal();
    return q.data;
  }

  async function syncLocalMenu(){
    if(!sb)throw new Error('MENUO ещё загружает базу данных. Подождите секунду.');
    const {data:{user},error:userError}=await sb.auth.getUser();
    if(userError)throw userError;
    if(!user)throw new Error('Сначала войдите в аккаунт MENUO.');

    const r=current();
    if(!r)throw new Error('Сначала создайте ресторан.');
    const rest=await saveRestaurant(r,user);
    const catMap=await syncCategories(r,rest.id);
    await syncDishes(r,rest.id,catMap,user.id);
    const qr=await syncQr(r,rest.id);

    const url=publicUrl(qr.token);
    r.publicUrl=url;
    saveLocal();
    return {restaurant:rest,qr,url};
  }

  function showQr(url){
    let layer=document.getElementById('menuoQrLayer');
    if(!layer){
      layer=document.createElement('div');
      layer.id='menuoQrLayer';
      layer.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(20,29,24,.72);display:grid;place-items:center;padding:18px';
      document.body.appendChild(layer);
    }
    layer.innerHTML='<div style="width:min(100%,430px);max-height:92vh;overflow:auto;background:#fffdfa;border-radius:26px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,.25);text-align:center;color:#17201c"><div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:20px">Постоянный QR-код</b><button id="menuoQrClose" style="border:0;background:#eef2ef;border-radius:10px;width:38px;height:38px;font-size:22px">×</button></div><p style="color:#69756e;font-size:13px;line-height:1.4">Этот QR привязан к ресторану и не меняется при редактировании меню.</p><div id="menuoQrCanvas" style="display:grid;place-items:center;margin:15px auto"></div><div style="background:#f4f5ef;border-radius:11px;padding:10px;font-size:11px;word-break:break-all;color:#69756e">'+esc(url)+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:12px"><button id="menuoQrOpen" style="border:0;border-radius:12px;padding:13px;background:#ddf4e9;color:#1b6b4e;font-weight:800">Открыть меню</button><button id="menuoQrDownload" style="border:0;border-radius:12px;padding:13px;background:#1b6b4e;color:#fff;font-weight:800">Скачать QR</button></div></div>';
    layer.querySelector('#menuoQrClose').onclick=()=>layer.remove();
    layer.querySelector('#menuoQrOpen').onclick=()=>location.href=url;
    layer.querySelector('#menuoQrDownload').onclick=()=>downloadQr(url);
    loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js').then(()=>{
      const box=layer.querySelector('#menuoQrCanvas');
      if(window.QRCode) new window.QRCode(box,{text:url,width:270,height:270,correctLevel:window.QRCode.CorrectLevel.H});
    }).catch(()=>{layer.querySelector('#menuoQrCanvas').innerHTML='<div class="notice error">Не удалось загрузить генератор QR. Ссылка выше всё равно рабочая.</div>'});
  }

  async function downloadQr(url){
    try{
      const box=document.getElementById('menuoQrCanvas');
      const img=box?.querySelector('img');
      const canvas=box?.querySelector('canvas');
      const dataUrl=img?.src || (canvas?canvas.toDataURL('image/png'):'');
      if(!dataUrl)throw new Error('qr-not-ready');
      if(navigator.share){
        try{
          const res=await fetch(dataUrl);const blob=await res.blob();
          const file=new File([blob],'menuo-qr.png',{type:'image/png'});
          if(!navigator.canShare || navigator.canShare({files:[file]})){
            await navigator.share({files:[file],title:'MENUO QR-код',text:'QR-код меню MENUO'});return;
          }
        }catch(shareError){
          if(shareError?.name==='AbortError')return;
        }
      }
      const a=document.createElement('a');a.href=dataUrl;a.download='menuo-qr.png';a.target='_blank';a.rel='noopener';document.body.appendChild(a);a.click();a.remove();
    }catch(e){alert('Не удалось сохранить QR. На iPhone используйте «Поделиться» и сохраните изображение в Фото.')}
  }

  function patchPublicLinks(){
    const originalUrl=window.publicUrl;
    window.publicUrl=function(r){
      if(r?.qrToken)return publicUrl(r.qrToken);
      return typeof originalUrl==='function'?originalUrl(r):location.href;
    };
    const originalOpen=window.openPublic;
    window.openPublic=function(){
      const r=current();
      if(r?.qrToken){location.href=publicUrl(r.qrToken);return}
      if(typeof originalOpen==='function')return originalOpen();
    };
  }

  function patchSaveButton(){
    document.addEventListener('click',async e=>{
      const b=e.target?.closest?.('button');
      if(!b)return;
      if(!/Сохранить меню и открыть QR-код|Сохранить меню и сгенерировать QR-код/i.test((b.textContent||'').trim()))return;
      e.preventDefault();e.stopImmediatePropagation();
      try{
        b.disabled=true;
        const x=await syncLocalMenu();
        showQr(x.url);
      }catch(err){
        console.error('MENUO save/QR error',err);
        const message=err?.message||'Не удалось сохранить меню.';
        alert(message);
      }finally{b.disabled=false}
    },true);
  }

  window.MENUO_CREATE_RESTAURANT=async()=>{
    if(!sb)throw new Error('Система сохранения ещё загружается.');
    const {data:{user},error}=await sb.auth.getUser();
    if(error)throw error;
    if(!user)throw new Error('Войдите в аккаунт MENUO.');
    const r=current();
    if(!r)throw new Error('Сначала создайте ресторан.');
    const rest=await saveRestaurant(r,user);
    await syncCategories(r,rest.id);
    saveLocal();
    return rest;
  };
  window.MENUO_SAVE_MENU_DATA=async()=>{
    if(!sb)throw new Error('Система сохранения ещё загружается.');
    const {data:{user},error}=await sb.auth.getUser();
    if(error)throw error;
    if(!user)throw new Error('Войдите в аккаунт MENUO.');
    const r=current();
    if(!r)throw new Error('Сначала создайте ресторан.');
    const previousRestaurantId=String(r.id);
    const rest=await saveRestaurant(r,user);
    // The first cloud save may assign a Supabase UUID different from the local draft ID.
    // Re-key local dishes before sync so they cannot be silently skipped by localDishes().
    r.remoteId=rest.id;
    r.id=rest.id;
    const local=localState();
    if(local){
      (local.dishes||[]).forEach(d=>{if(String(d.restaurantId)===previousRestaurantId)d.restaurantId=rest.id;});
      local.activeRestaurantId=rest.id;
      saveLocal();
    }
    const catMap=await syncCategories(r,rest.id);
    await syncDishes(r,rest.id,catMap,user.id);
    return rest;
  };
  window.MENUO_SAVE_RESTAURANT=async()=>{
    if(!sb)throw new Error('MENUO ещё загружает базу данных. Подождите секунду.');
    const {data:{user},error}=await sb.auth.getUser();
    if(error)throw error;
    if(!user)throw new Error('Войдите в аккаунт MENUO.');
    const r=current();
    if(!r)throw new Error('Сначала создайте ресторан.');
    return await saveRestaurant(r,user);
  };
  window.MENUO_SYNC_MENU=syncLocalMenu;
  window.MENUO_OPEN_QR=async()=>{
    try{const x=await syncLocalMenu();showQr(x.url)}
    catch(e){alert(e?.message||'Не удалось открыть QR-код.')}
  };

  boot();
})();
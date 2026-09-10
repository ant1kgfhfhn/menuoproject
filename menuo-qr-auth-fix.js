/* MENUO QR auth bridge: connect the existing local MENUO login to Supabase before QR persistence. */
(function(){
  'use strict';

  function localEmail(){
    try{
      if(typeof state!=='undefined'){
        var u=state.currentUser||state.user||null;
        if(u&&u.email)return u.email;
        if(state.currentUserEmail)return state.currentUserEmail;
      }
    }catch(_){ }
    try{
      for(var i=0;i<localStorage.length;i++){
        var k=localStorage.key(i),v=localStorage.getItem(k);
        if(!v)continue;
        try{
          var o=JSON.parse(v),u=o&& (o.currentUser||o.user);
          if(u&&u.email)return u.email;
          if(o&&o.currentUserEmail)return o.currentUserEmail;
        }catch(_){ }
      }
    }catch(_){ }
    return '';
  }

  function waitForSupabase(timeout){
    return new Promise(function(resolve,reject){
      var started=Date.now();
      (function check(){
        if(window.MENUO_SUPABASE)return resolve(window.MENUO_SUPABASE);
        if(Date.now()-started>timeout)return reject(new Error('MENUO backend не успел загрузиться. Обновите страницу.'));
        setTimeout(check,100);
      })();
    });
  }

  async function ensureAuth(){
    var sb=await waitForSupabase(10000);
    var session=await sb.auth.getSession();
    if(session.data&&session.data.session)return sb;

    var email=localEmail();
    if(!email)email=window.prompt('Введите e-mail аккаунта MENUO:','');
    if(!email)return null;
    var password=window.prompt('Для синхронизации меню с облаком введите пароль аккаунта MENUO:','');
    if(!password)return null;

    var login=await sb.auth.signInWithPassword({email:email.trim(),password:password});
    if(login.data&&login.data.session)return sb;

    /* Existing prototype accounts may not exist in Supabase yet. Create the
       corresponding Supabase identity on the first successful confirmation. */
    var signup=await sb.auth.signUp({email:email.trim(),password:password});
    if(signup.error)throw new Error('Не удалось подтвердить аккаунт: '+signup.error.message);
    if(!(signup.data&&signup.data.session)){
      throw new Error('Аккаунт создан в облаке. Подтвердите e-mail и затем войдите в MENUO ещё раз.');
    }
    return sb;
  }

  function isQrButton(el){
    if(!el||el.tagName!=='BUTTON')return false;
    return /Сохранить меню и открыть QR-код|Сохранить меню и сгенерировать QR-код/i.test((el.textContent||'').trim());
  }

  window.addEventListener('click',function(e){
    var b=e.target&&e.target.closest?e.target.closest('button'):null;
    if(!isQrButton(b))return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if(b.dataset.menuoAuthBusy==='1')return;
    b.dataset.menuoAuthBusy='1';
    b.disabled=true;
    (async function(){
      try{
        await ensureAuth();
        if(typeof window.MENUO_OPEN_QR!=='function')throw new Error('QR-модуль ещё загружается. Нажмите кнопку ещё раз.');
        await window.MENUO_OPEN_QR();
      }catch(err){
        console.error('MENUO QR auth bridge',err);
        alert(err&&err.message?err.message:'Не удалось подтвердить аккаунт MENUO.');
      }finally{
        b.disabled=false;
        delete b.dataset.menuoAuthBusy;
      }
    })();
  },true);
})();

/* MENUO account persistence bridge (cache-independent). */
(function () {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let initPromise;

  function s() { try { return typeof state !== 'undefined' ? state : null; } catch (_) { return null; } }
  function localSave() { try { if (typeof save === 'function') save(); } catch (_) {} }
  function localRestaurant(id) {
    const st = s();
    if (!st) return null;
    if (id) return (st.restaurants || []).find((r) => r.id === id && r.ownerId === st.session) || null;
    try { if (typeof currentRestaurant === 'function') return currentRestaurant(); } catch (_) {}
    return (st.restaurants || []).find((r) => r.id === st.activeRestaurantId && r.ownerId === st.session) || null;
  }
  async function getAuth() {
    for (let i = 0; i < 240; i++) {
      const db = window.MENUO_SUPABASE;
      if (db && typeof db.from === 'function') {
        const { data, error } = await db.auth.getUser();
        if (error) throw error;
        if (!data?.user) throw new Error('Войди в аккаунт MENUO.');
        return { db, user: data.user };
      }
      await delay(100);
    }
    throw new Error('База MENUO ещё загружается. Обнови страницу.');
  }
  function restaurantPayload(r, ownerId) {
    return {
      owner_id: ownerId,
      name: String(r.name || 'Мой ресторан').trim() || 'Мой ресторан',
      slug: String(r.slug || 'restaurant').trim(),
      logo_url: r.logoUrl || r.logo_url || null,
      address: r.address || null,
      phone: r.phone || null,
      description: r.description || null,
      website: r.website || null,
      instagram: r.instagram || null,
      facebook: r.facebook || null,
      hours: r.hours && typeof r.hours === 'object' && !Array.isArray(r.hours) ? r.hours : { display: String(r.hours || '') },
      default_locale: r.defaultLocale || r.default_locale || 'ru',
      published: r.published !== false
    };
  }
  async function persistRestaurant(r, db, authUser) {
    const payload = restaurantPayload(r, authUser.id);
    let row = null;
    if (r.remoteId && UUID.test(String(r.remoteId))) {
      const updated = await db.from('restaurants').update(payload)
        .eq('id', r.remoteId).eq('owner_id', authUser.id).select('*').maybeSingle();
      if (updated.error) throw updated.error;
      row = updated.data || null;
    }
    if (!row) {
      const existing = await db.from('restaurants').select('*')
        .eq('owner_id', authUser.id).eq('slug', payload.slug).maybeSingle();
      if (existing.error) throw existing.error;
      row = existing.data || null;
    }
    if (row) {
      const updated = await db.from('restaurants').update(payload)
        .eq('id', row.id).eq('owner_id', authUser.id).select('*').single();
      if (updated.error) throw updated.error;
      row = updated.data;
    } else {
      const inserted = await db.from('restaurants').insert(payload).select('*').single();
      if (inserted.error) {
        // Retry only the exact same slug, never a different restaurant.
        const retry = await db.from('restaurants').select('*')
          .eq('owner_id', authUser.id).eq('slug', payload.slug).maybeSingle();
        if (retry.error || !retry.data) throw inserted.error;
        row = retry.data;
      } else row = inserted.data;
    }
    if (!row?.id) throw new Error('Не удалось сохранить ресторан в базе.');
    r.remoteId = row.id;
    r.slug = row.slug || r.slug;
    r.ownerId = authUser.id;
    localSave();
    return row;
  }
  async function syncCategories(r, restaurantId, db) {
    const raw = Array.isArray(r.categories) ? r.categories : [];
    const names = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
    const list = names.length ? names : ['Все'];
    const existing = await db.from('categories').select('id,name')
      .eq('restaurant_id', restaurantId);
    if (existing.error) throw existing.error;
    const byName = new Map((existing.data || []).map((x) => [x.name, x.id]));
    const map = new Map();
    for (let i = 0; i < list.length; i++) {
      const name = list[i];
      if (byName.has(name)) {
        const id = byName.get(name);
        const updated = await db.from('categories').update({ sort_order: i, is_active: true })
          .eq('id', id).eq('restaurant_id', restaurantId);
        if (updated.error) throw updated.error;
        map.set(name, id);
      } else {
        const created = await db.from('categories').insert({
          restaurant_id: restaurantId, name, sort_order: i, is_active: true
        }).select('id,name').single();
        if (created.error) {
          const retry = await db.from('categories').select('id,name')
            .eq('restaurant_id', restaurantId).eq('name', name).maybeSingle();
          if (retry.error || !retry.data) throw created.error;
          map.set(name, retry.data.id);
        } else map.set(name, created.data.id);
      }
    }
    // Keep older categories unless the user explicitly deletes them; no autosave may erase data.
    return map;
  }
  function parseCents(d) {
    if (d.priceCents !== undefined && d.priceCents !== null && Number.isFinite(Number(d.priceCents))) {
      return Math.max(0, Math.round(Number(d.priceCents)));
    }
    const price = Number(String(d.price ?? '0').replace(/\s/g, '').replace(/,/g, '.').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(price) ? Math.max(0, Math.round(price * 100)) : 0;
  }
  async function dishImage(d, userId, restaurantId, dishId, db) {
    let source = String(d.photo || d.imageUrl || d.image_url || '');
    if (source.startsWith('data:image/')) {
      const response = await fetch(source);
      if (!response.ok) throw new Error('Не удалось подготовить фото блюда.');
      const blob = await response.blob();
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      const path = userId + '/' + restaurantId + '/dishes/' + dishId + '.' + ext;
      const uploaded = await db.storage.from('restaurant-photos').upload(path, blob, {
        contentType: blob.type || 'image/jpeg', upsert: true
      });
      if (uploaded.error) throw uploaded.error;
      source = db.storage.from('restaurant-photos').getPublicUrl(path).data.publicUrl;
      d.photo = source;
      d.imageUrl = source;
    }
    return source.startsWith('http') ? source : null;
  }
  async function syncDishes(r, restaurantId, db, authUser) {
    const st = s();
    const items = (st?.dishes || []).filter((d) => d.restaurantId === r.id);
    const cq = await db.from('categories').select('id,name').eq('restaurant_id', restaurantId);
    if (cq.error) throw cq.error;
    const catMap = new Map((cq.data || []).map((x) => [x.name, x.id]));
    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      let id = UUID.test(String(d.remoteId || '')) ? d.remoteId : (UUID.test(String(d.id || '')) ? d.id : '');
      if (!id && crypto.randomUUID) id = crypto.randomUUID();
      if (!id) throw new Error('Этот браузер не поддерживает безопасные ID для блюд.');
      d.id = id;
      d.remoteId = id;
      rows.push({
        id,
        restaurant_id: restaurantId,
        category_id: catMap.get(String(d.category || d.categoryName || '').trim()) || null,
        name: String(d.name || 'Блюдо').trim() || 'Блюдо',
        description: String(d.description || ''),
        price_cents: parseCents(d),
        currency: d.currency || 'EUR',
        image_url: await dishImage(d, authUser.id, restaurantId, id, db),
        is_available: d.available !== false && d.isAvailable !== false,
        sort_order: i,
        allergens: Array.isArray(d.allergens) ? d.allergens : []
      });
    }
    // Upsert records before any deletion. Ordinary saves only upsert; explicit delete removes one row.
    if (rows.length) {
      const saved = await db.from('dishes').upsert(rows, { onConflict: 'id' }).select('id');
      if (saved.error) throw saved.error;
    }
    localSave();
  }
  async function saveMenuData(localId) {
    const r = localRestaurant(localId);
    if (!r) throw new Error('Сначала выбери ресторан.');
    const { db, user } = await getAuth();
    const restaurant = await persistRestaurant(r, db, user);
    await syncCategories(r, restaurant.id, db);
    await syncDishes(r, restaurant.id, db, user);
    return { restaurant };
  }
  async function createRestaurant() {
    const r = localRestaurant();
    if (!r) throw new Error('Сначала создай ресторан.');
    const { db, user } = await getAuth();
    const row = await persistRestaurant(r, db, user);
    await syncCategories(r, row.id, db);
    return row;
  }
  async function saveRestaurant() {
    const r = localRestaurant();
    if (!r) throw new Error('Сначала выбери ресторан.');
    const { db, user } = await getAuth();
    return persistRestaurant(r, db, user);
  }
  async function saveMenuAndQr() {
    const r = localRestaurant();
    if (!r) throw new Error('Сначала создай ресторан.');
    const { db, user } = await getAuth();
    const restaurant = await persistRestaurant(r, db, user);
    await syncCategories(r, restaurant.id, db);
    await syncDishes(r, restaurant.id, db, user);
    let q = await db.from('qr_codes').select('*')
      .eq('restaurant_id', restaurant.id).eq('is_active', true).maybeSingle();
    if (q.error) throw q.error;
    if (!q.data) {
      q = await db.from('qr_codes').insert({
        restaurant_id: restaurant.id, name: 'Основной QR', is_active: true
      }).select('*').single();
      if (q.error) throw q.error;
    }
    r.qrToken = q.data.token;
    r.qrCreated = true;
    r.publicUrl = new URL('?menu=' + encodeURIComponent(q.data.token), location.origin + location.pathname).toString();
    localSave();
    return { restaurant, qr: q.data, url: r.publicUrl };
  }
  function installPublicUrl() {
    const old = window.publicUrl;
    window.publicUrl = function (r) {
      if (r?.qrToken) return new URL('?menu=' + encodeURIComponent(r.qrToken), location.origin + location.pathname).toString();
      return typeof old === 'function' ? old(r) : location.href;
    };
  }
  function wrapDeleteDish() {
    if (typeof window.deleteDish !== 'function' || window.deleteDish.__menuoRemoteDelete) return;
    const original = window.deleteDish;
    const wrapped = function (id) {
      const before = s()?.dishes?.find((d) => d.id === id);
      original(id);
      if (!before || s()?.dishes?.some((d) => d.id === id)) return;
      const r = (s()?.restaurants || []).find((x) => x.id === before.restaurantId);
      const restaurantId = r?.remoteId || before.restaurantId;
      const dishId = before.remoteId || before.id;
      getAuth().then(({ db }) => db.from('dishes').delete().eq('id', dishId).eq('restaurant_id', restaurantId))
        .then((q) => { if (q?.error) throw q.error; })
        .catch((e) => alert(e?.message || 'Не удалось удалить блюдо на сервере.'));
    };
    wrapped.__menuoRemoteDelete = true;
    window.deleteDish = wrapped;
  }
  function accountCanManageRestaurant(id) {
    try {
      const list = typeof restaurants === 'function' ? restaurants() : [];
      const idx = list.findIndex((r) => r.id === id);
      const limit = typeof plan === 'function' ? Number(plan()?.restaurants ?? 1) : 1;
      return idx >= 0 && (limit === Infinity || idx < limit);
    } catch (_) { return false; }
  }
  function installApi() {
    window.MENUO_CREATE_RESTAURANT = createRestaurant;
    window.MENUO_SAVE_RESTAURANT = saveRestaurant;
    window.MENUO_SAVE_MENU_DATA = saveMenuData;
    window.MENUO_SYNC_MENU = saveMenuAndQr;
    window.MENUO_OPEN_QR = async function () {
      try { await saveMenuAndQr(); if (typeof renderQr === 'function') renderQr(); }
      catch (e) { alert(e?.message || 'Не удалось сохранить меню.'); }
    };
    window.saveMenuAndQr = async function () {
      try { await saveMenuAndQr(); if (typeof renderQr === 'function') renderQr(); }
      catch (e) { alert(e?.message || 'Не удалось сохранить меню. Проверь подключение.'); }
    };
    installPublicUrl();
    wrapDeleteDish();

    // Change the visible label before the legacy runtime checks for its old save-button text.
    const qrButton = document.querySelector('button[onclick="saveMenuAndQr()"]');
    if (qrButton) qrButton.textContent = 'Опубликовать меню и QR-код';

    let autoSaveTimer = null;
    window.queueMenuAutosave = function (immediate = false) {
      const targetId = localRestaurant()?.id || null;
      if (autoSaveTimer) clearTimeout(autoSaveTimer);
      return new Promise((resolve) => {
        autoSaveTimer = setTimeout(async () => {
          try {
            await window.MENUO_SAVE_MENU_DATA(targetId);
            const status = document.getElementById('saveStatus');
            if (status) status.textContent = 'Все изменения сохранены';
            resolve(true);
          } catch (error) {
            console.warn('MENUO autosave failed', error);
            const status = document.getElementById('saveStatus');
            if (status) status.textContent = 'Не удалось синхронизировать изменения';
            resolve(false);
          }
        }, immediate ? 0 : 900);
      });
    };

    const oldSelect = window.selectRestaurant;
    if (typeof oldSelect === 'function' && !oldSelect.__menuoPlanGate) {
      const nextSelect = function (id) {
        if (!accountCanManageRestaurant(id)) {
          alert('Ресторан и его данные сохранены, но для работы с ним нужен более высокий тариф.');
          if (typeof show === 'function') show('subscription');
          return;
        }
        return oldSelect(id);
      };
      nextSelect.__menuoPlanGate = true;
      window.selectRestaurant = nextSelect;
    }

    const oldRenderOwner = window.renderOwner;
    if (typeof oldRenderOwner === 'function' && !oldRenderOwner.__menuoPlanGate) {
      const nextRender = function () {
        const result = oldRenderOwner();
        const box = document.getElementById('restaurantsList');
        const list = typeof restaurants === 'function' ? restaurants() : [];
        const limit = typeof plan === 'function' ? Number(plan()?.restaurants ?? 1) : 1;
        if (box) [...box.children].forEach((card, index) => {
          if (index < limit) return;
          const small = card.querySelector('small');
          if (small && !small.dataset.menuoLocked) {
            small.textContent += ' · сохранено, доступ ограничен тарифом';
            small.dataset.menuoLocked = '1';
          }
          const button = card.querySelector('button.mini');
          if (button) { button.textContent = 'Выбрать тариф'; button.onclick = () => show('subscription'); }
        });
        return result;
      };
      nextRender.__menuoPlanGate = true;
      window.renderOwner = nextRender;
    }

    const oldShow = window.show;
    if (typeof oldShow === 'function' && !oldShow.__menuoPlanGate) {
      const nextShow = function (id, opts) {
        if (['editor', 'restaurantProfile', 'qr'].includes(id)) {
          const r = localRestaurant();
          if (r && !accountCanManageRestaurant(r.id)) return oldShow('subscription', opts);
        }
        return oldShow(id, opts);
      };
      nextShow.__menuoPlanGate = true;
      window.show = nextShow;
    }
  }

  // Install the UI entry points immediately, before the older runtime bridge can register.
  // The helpers below wait for Supabase only when a user actually saves data.
  function installUiShell() {
    if (!document.getElementById('menuoLegalConsentStyles')) {
      const style = document.createElement('style');
      style.id = 'menuoLegalConsentStyles';
      style.textContent = '#registrationLegal{background:#f5f8f5;border:1px solid var(--line);border-radius:13px;padding:12px;margin:12px 0 16px;font-size:12px;line-height:1.45;color:var(--muted)}#registrationLegal .legal-consent-row{display:flex;align-items:flex-start;gap:10px}#registrationLegal input[type=checkbox]{width:18px;height:18px;accent-color:var(--green);margin-top:1px;flex:none}#registrationLegal a{color:var(--green);font-weight:800;text-decoration:underline}';
      document.head.appendChild(style);
    }
    const originalCreateUi = window.createRestaurant;
    window.createRestaurant = async function () {
      const st = s();
      const name = document.getElementById('restaurantName')?.value.trim();
      if (!name || !st?.session) return;
      const list = typeof restaurants === 'function' ? restaurants() : [];
      const limit = typeof plan === 'function' ? Number(plan()?.restaurants ?? 1) : 1;
      if (list.length >= limit) { if (typeof show === 'function') show('subscription'); return; }
      const r = {
        id: typeof uid === 'function' ? uid() : (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        ownerId: st.session,
        name,
        address: document.getElementById('restaurantAddress')?.value.trim() || '',
        phone: document.getElementById('restaurantPhone')?.value.trim() || '',
        description: document.getElementById('restaurantDescription')?.value.trim() || '',
        hours: 'Пн–Вс 10:00–23:00',
        slug: typeof slugify === 'function' ? slugify(name) : ('restaurant-' + Date.now()),
        categories: ['Все', 'Основные'],
        qrCreated: false
      };
      st.restaurants.push(r);
      st.activeRestaurantId = r.id;
      localSave();
      ['restaurantName','restaurantAddress','restaurantPhone','restaurantDescription'].forEach((id) => {
        const input = document.getElementById(id); if (input) input.value = '';
      });
      if (typeof show === 'function') show('editor');
      try {
        await createRestaurant();
        await saveMenuData(r.id);
        if (typeof show === 'function') show('editor');
      } catch (error) {
        console.error('MENUO restaurant create failed', error);
        if (!r.remoteId) {
          st.restaurants = st.restaurants.filter((item) => item.id !== r.id);
          st.dishes = (st.dishes || []).filter((item) => item.restaurantId !== r.id);
          st.activeRestaurantId = (typeof restaurants === 'function' ? restaurants()[0]?.id : null) || null;
          localSave();
          if (typeof show === 'function') show('owner');
        }
        alert(error?.message || 'Не удалось сохранить ресторан. Проверь подключение и тариф.');
      }
    };

    let earlyAutosaveTimer = null;
    window.queueMenuAutosave = function (immediate = false) {
      const targetId = localRestaurant()?.id || null;
      if (earlyAutosaveTimer) clearTimeout(earlyAutosaveTimer);
      return new Promise((resolve) => {
        earlyAutosaveTimer = setTimeout(async () => {
          try {
            await saveMenuData(targetId);
            const status = document.getElementById('saveStatus');
            if (status) status.textContent = 'Все изменения сохранены';
            resolve(true);
          } catch (error) {
            console.warn('MENUO autosave failed', error);
            const status = document.getElementById('saveStatus');
            if (status) status.textContent = 'Не удалось синхронизировать изменения';
            resolve(false);
          }
        }, immediate ? 0 : 900);
      });
    };

    const qrButton = document.querySelector('button[onclick="saveMenuAndQr()"]');
    if (qrButton) qrButton.textContent = 'Опубликовать меню и QR-код';
    window.saveMenuAndQr = async function () {
      const button = document.querySelector('button[onclick="saveMenuAndQr()"]');
      if (button) button.disabled = true;
      try {
        await saveMenuAndQr();
        if (typeof renderQr === 'function') renderQr();
      } catch (error) {
        alert(error?.message || 'Не удалось сохранить меню и QR-код.');
      } finally {
        if (button) button.disabled = false;
      }
    };
  }
  async function hydrateAccountData() {
    const { db, user } = await getAuth();
    const [restaurantsQ, categoriesQ, dishesQ, qrsQ, planQ, subQ, profileQ] = await Promise.all([
      db.from('restaurants').select('*').eq('owner_id', user.id).order('created_at', { ascending: true }),
      db.from('categories').select('*').order('sort_order', { ascending: true }),
      db.from('dishes').select('*').order('sort_order', { ascending: true }),
      db.from('qr_codes').select('id,restaurant_id,token,is_active').eq('is_active', true),
      db.rpc('get_my_plan'),
      db.from('subscriptions').select('plan_id,status,current_period_end').eq('user_id', user.id).maybeSingle(),
      db.from('profiles').select('first_name,last_name,full_name,phone,avatar_url,settings,locale').eq('id', user.id).maybeSingle()
    ]);
    for (const query of [restaurantsQ,categoriesQ,dishesQ,qrsQ,planQ,subQ,profileQ]) {
      if (query.error) throw query.error;
    }
    const cats = categoriesQ.data || [];
    const dishRows = dishesQ.data || [];
    const qrRows = qrsQ.data || [];
    const subscription = subQ.data || null;
    const planRow = Array.isArray(planQ.data) ? planQ.data[0] : planQ.data;
    const resolvedPlan = String(
      subscription?.status === 'active' && subscription?.plan_id
        ? subscription.plan_id
        : (planRow?.code || planRow?.plan_code || planRow?.get_my_plan || 'FREE')
    ).toUpperCase();
    const localUser = (s()?.users || []).find((x) => x.id === user.id) || {};
    const profile = profileQ.data || {};
    let firstName = profile.first_name || user.user_metadata?.first_name || localUser.firstName || '';
    let lastName = profile.last_name || user.user_metadata?.last_name || localUser.lastName || '';
    if ((!firstName || !lastName) && profile.full_name) {
      const parts = String(profile.full_name).trim().split(/\s+/);
      firstName = firstName || parts.shift() || '';
      lastName = lastName || parts.join(' ');
    }
    const restaurants = (restaurantsQ.data || []).map((row) => {
      const rowCategories = cats.filter((cat) => cat.restaurant_id === row.id)
        .sort((a,b) => (a.sort_order || 0) - (b.sort_order || 0));
      const qr = qrRows.find((entry) => entry.restaurant_id === row.id);
      const hours = row.hours && typeof row.hours === 'object' ? (row.hours.display || '') : (row.hours || '');
      return {
        id: row.id, remoteId: row.id, ownerId: user.id, name: row.name || 'Мой ресторан',
        slug: row.slug || '', logoUrl: row.logo_url || '', address: row.address || '',
        phone: row.phone || '', description: row.description || '', website: row.website || '',
        instagram: row.instagram || '', facebook: row.facebook || '', hours,
        defaultLocale: row.default_locale || 'ru', published: row.published !== false,
        categories: rowCategories.map((cat) => cat.name), qrToken: qr?.token || '',
        qrCreated: !!qr, publicUrl: qr ? new URL('?menu=' + encodeURIComponent(qr.token), location.origin + location.pathname).toString() : ''
      };
    });
    const ids = new Set(restaurants.map((row) => row.id));
    const euro = (cents) => (Number(cents || 0) / 100).toFixed(2).replace('.', ',') + ' €';
    const dishes = dishRows.filter((row) => ids.has(row.restaurant_id)).map((row) => ({
      id: row.id, remoteId: row.id, restaurantId: row.restaurant_id,
      name: row.name || 'Блюдо', description: row.description || '',
      price: euro(row.price_cents), priceCents: Number(row.price_cents || 0),
      category: cats.find((cat) => cat.id === row.category_id)?.name || 'Основные',
      available: row.is_available !== false, photo: row.image_url || '', imageUrl: row.image_url || '',
      currency: row.currency || 'EUR', allergens: Array.isArray(row.allergens) ? row.allergens : []
    }));
    const st = s();
    const oldActive = st.activeRestaurantId;
    st.users = [{
      ...localUser, id: user.id, email: user.email || '', phone: profile.phone || user.phone || '',
      firstName, lastName, plan: resolvedPlan, avatarUrl: profile.avatar_url || '',
      settings: { theme: 'light', showTips: true, productEmails: false, ...(profile.settings || {}) }
    }];
    st.restaurants = restaurants;
    st.dishes = dishes;
    st.session = user.id;
    const max = Number((typeof plan === 'function' ? plan()?.restaurants : 1) ?? 1);
    const allowed = Number.isFinite(max) ? restaurants.slice(0, max) : restaurants;
    st.activeRestaurantId = allowed.some((row) => row.id === oldActive)
      ? oldActive
      : (allowed[0]?.id || null);
    if (profile.locale) st.language = profile.locale;
    localSave();
    if (typeof updateNav === 'function') updateNav();
    return true;
  }

  async function installWhenReady() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      for (let i = 0; i < 240; i++) {
        if (window.MENUO_SUPABASE && s() && typeof currentRestaurant === 'function' && typeof save === 'function') {
          installApi();
          const originalOpenOwner = window.openOwner;
          window.openOwner = async function () {
            let authenticated = false;
            try {
              const { db, user } = await getAuth();
              authenticated = !!user;
              await hydrateAccountData();
            } catch (_) {}
            if (!authenticated) {
              if (typeof window.openAuth === 'function') window.openAuth('login', 'owner');
              else if (typeof show === 'function') show('auth');
              return;
            }
            if (typeof show === 'function') show('owner');
            else if (typeof originalOpenOwner === 'function') originalOpenOwner();
          };
          return;
        }
        await delay(100);
      }
      console.error('MENUO account persistence: Supabase client not available.');
    })();
    return initPromise;
  }
  installUiShell();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
})();

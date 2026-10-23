/* MENUO durable persistence bridge.
   This file is intentionally named without the "menuo-" prefix so the GitHub Pages
   runtime-wiring workflow does not remove its cache-busted script reference. */
(function () {
  'use strict';

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let attachPromise = null;

  function appState() {
    try { return typeof state !== 'undefined' ? state : null; } catch (_) { return null; }
  }
  function saveLocal() {
    try { if (typeof save === 'function') save(); } catch (_) {}
  }
  function localRestaurant(id) {
    const s = appState();
    if (!s || !Array.isArray(s.restaurants)) return null;
    if (id) return s.restaurants.find((r) => r.id === id && r.ownerId === s.session) || null;
    try { if (typeof currentRestaurant === 'function') return currentRestaurant(); } catch (_) {}
    return s.restaurants.find((r) => r.id === s.activeRestaurantId && r.ownerId === s.session) || null;
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }
  function publicMenuUrl(token) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('menu', token);
    return url.toString();
  }
  async function client() {
    for (let i = 0; i < 240; i++) {
      if (window.MENUO_SUPABASE && typeof window.MENUO_SUPABASE.from === 'function') return window.MENUO_SUPABASE;
      await sleep(100);
    }
    throw new Error('Supabase ещё загружается. Обнови страницу и повтори попытку.');
  }
  async function authenticated() {
    const sb = await client();
    const { data, error } = await sb.auth.getUser();
    if (error) throw error;
    if (!data?.user) throw new Error('Войди в аккаунт MENUO.');
    return { sb, user: data.user };
  }
  function restaurantPayload(r, ownerId) {
    const hours = r.hours && typeof r.hours === 'object' && !Array.isArray(r.hours)
      ? r.hours
      : { display: String(r.hours || '') };
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
      hours,
      default_locale: r.defaultLocale || r.default_locale || 'ru',
      published: r.published !== false
    };
  }
  async function persistRestaurant(r, sb, user) {
    const payload = restaurantPayload(r, user.id);
    let row = null;

    // Updates are always constrained to the authenticated owner's ID.
    if (r.remoteId && UUID.test(String(r.remoteId))) {
      const update = await sb.from('restaurants')
        .update(payload).eq('id', r.remoteId).eq('owner_id', user.id).select('*').maybeSingle();
      if (update.error) throw update.error;
      row = update.data || null;
    }
    if (!row) {
      const bySlug = await sb.from('restaurants').select('*')
        .eq('owner_id', user.id).eq('slug', payload.slug).maybeSingle();
      if (bySlug.error) throw bySlug.error;
      row = bySlug.data || null;
    }
    if (row) {
      const update = await sb.from('restaurants').update(payload)
        .eq('id', row.id).eq('owner_id', user.id).select('*').single();
      if (update.error) throw update.error;
      row = update.data;
    } else {
      const insert = await sb.from('restaurants').insert(payload).select('*').single();
      if (insert.error) {
        // Only recover the exact same slug after a possible network/response failure.
        const retry = await sb.from('restaurants').select('*')
          .eq('owner_id', user.id).eq('slug', payload.slug).maybeSingle();
        if (retry.error || !retry.data) throw insert.error;
        row = retry.data;
      } else {
        row = insert.data;
      }
    }
    if (!row?.id) throw new Error('Не удалось сохранить ресторан.');
    r.remoteId = row.id;
    r.slug = row.slug || r.slug;
    r.ownerId = user.id;
    saveLocal();
    return row;
  }
  async function syncCategories(r, restaurantId, sb) {
    const raw = Array.isArray(r.categories) ? r.categories : [];
    const names = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
    const list = names.length ? names : ['Все'];
    const query = await sb.from('categories').select('id,name').eq('restaurant_id', restaurantId);
    if (query.error) throw query.error;
    const prior = query.data || [];
    const byName = new Map(prior.map((x) => [x.name, x.id]));
    const result = new Map();

    for (let i = 0; i < list.length; i++) {
      const name = list[i];
      const existingId = byName.get(name);
      if (existingId) {
        const q = await sb.from('categories').update({ sort_order: i, is_active: true })
          .eq('id', existingId).eq('restaurant_id', restaurantId);
        if (q.error) throw q.error;
        result.set(name, existingId);
      } else {
        const q = await sb.from('categories').insert({
          restaurant_id: restaurantId, name, sort_order: i, is_active: true
        }).select('id,name').single();
        if (q.error) {
          // Recover an identical category created by another successful retry.
          const retry = await sb.from('categories').select('id,name')
            .eq('restaurant_id', restaurantId).eq('name', name).maybeSingle();
          if (retry.error || !retry.data) throw q.error;
          result.set(name, retry.data.id);
        } else result.set(name, q.data.id);
      }
    }
    return result;
  }
  function priceCents(d) {
    if (d.priceCents !== undefined && d.priceCents !== null && Number.isFinite(Number(d.priceCents))) {
      return Math.max(0, Math.round(Number(d.priceCents)));
    }
    const parsed = Number(String(d.price ?? '0').replace(/\s/g, '').replace(/,/g, '.').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
  }
  async function prepareDishImage(d, userId, restaurantId, dishId, sb) {
    let source = String(d.photo || d.imageUrl || d.image_url || '');
    if (source.startsWith('data:image/')) {
      const response = await fetch(source);
      if (!response.ok) throw new Error('Не удалось подготовить фотографию блюда.');
      const blob = await response.blob();
      const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
      const path = userId + '/' + restaurantId + '/dishes/' + dishId + '.' + ext;
      const up = await sb.storage.from('restaurant-photos').upload(path, blob, {
        contentType: blob.type || 'image/jpeg', upsert: true
      });
      if (up.error) throw up.error;
      source = sb.storage.from('restaurant-photos').getPublicUrl(path).data.publicUrl;
      d.photo = source;
      d.imageUrl = source;
    }
    return source.startsWith('http') ? source : null;
  }
  async function syncDishes(r, restaurantId, sb, user) {
    const s = appState();
    const items = Array.isArray(s?.dishes) ? s.dishes.filter((d) => d.restaurantId === r.id) : [];
    const categories = new Map();
    const catRows = await sb.from('categories').select('id,name').eq('restaurant_id', restaurantId);
    if (catRows.error) throw catRows.error;
    for (const cat of catRows.data || []) categories.set(cat.name, cat.id);

    const rows = [];
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      let id = UUID.test(String(d.remoteId || '')) ? d.remoteId : (UUID.test(String(d.id || '')) ? d.id : '');
      if (!id) id = crypto.randomUUID ? crypto.randomUUID() : null;
      if (!id) throw new Error('Браузер не смог создать идентификатор блюда.');
      d.id = id;
      d.remoteId = id;
      const image = await prepareDishImage(d, user.id, restaurantId, id, sb);
      rows.push({
        id,
        restaurant_id: restaurantId,
        category_id: categories.get(String(d.category || d.categoryName || '').trim()) || null,
        name: String(d.name || 'Блюдо').trim() || 'Блюдо',
        description: String(d.description || ''),
        price_cents: priceCents(d),
        currency: d.currency || 'EUR',
        image_url: image,
        is_available: d.available !== false && d.isAvailable !== false,
        sort_order: i,
        allergens: Array.isArray(d.allergens) ? d.allergens : []
      });
    }
    // Upsert first; never clear saved dishes as a side effect of a failed save.
    if (rows.length) {
      const result = await sb.from('dishes').upsert(rows, { onConflict: 'id' }).select('id');
      if (result.error) throw result.error;
    }
    saveLocal();
  }
  async function saveMenuData(localRestaurantId) {
    const r = localRestaurant(localRestaurantId);
    if (!r) throw new Error('Сначала выбери ресторан.');
    const { sb, user } = await authenticated();
    const restaurant = await persistRestaurant(r, sb, user);
    await syncCategories(r, restaurant.id, sb);
    await syncDishes(r, restaurant.id, sb, user);
    return { restaurant };
  }
  async function createRestaurant() {
    const r = localRestaurant();
    if (!r) throw new Error('Сначала создай ресторан.');
    const { sb, user } = await authenticated();
    const row = await persistRestaurant(r, sb, user);
    await syncCategories(r, row.id, sb);
    return row;
  }
  async function saveRestaurant() {
    const r = localRestaurant();
    if (!r) throw new Error('Сначала выбери ресторан.');
    const { sb, user } = await authenticated();
    return await persistRestaurant(r, sb, user);
  }
  async function createOrGetQr() {
    const r = localRestaurant();
    if (!r) throw new Error('Сначала выбери ресторан.');
    const { sb, user } = await authenticated();
    const restaurant = await persistRestaurant(r, sb, user);
    await syncCategories(r, restaurant.id, sb);
    await syncDishes(r, restaurant.id, sb, user);
    let q = await sb.from('qr_codes').select('*').eq('restaurant_id', restaurant.id).eq('is_active', true).maybeSingle();
    if (q.error) throw q.error;
    if (!q.data) {
      q = await sb.from('qr_codes').insert({ restaurant_id: restaurant.id, name: 'Основной QR', is_active: true }).select('*').single();
      if (q.error) throw q.error;
    }
    r.qrToken = q.data.token;
    r.qrCreated = true;
    r.publicUrl = publicMenuUrl(q.data.token);
    saveLocal();
    return { restaurant, qr: q.data, url: r.publicUrl };
  }
  function installPublicUrl() {
    const original = window.publicUrl;
    window.publicUrl = function (r) {
      if (r?.qrToken) return publicMenuUrl(r.qrToken);
      return typeof original === 'function' ? original(r) : location.href;
    };
  }
  function installApi() {
    window.MENUO_CREATE_RESTAURANT = createRestaurant;
    window.MENUO_SAVE_RESTAURANT = saveRestaurant;
    window.MENUO_SAVE_MENU_DATA = saveMenuData;
    window.MENUO_SYNC_MENU = createOrGetQr;
    window.MENUO_OPEN_QR = async function () {
      try { await createOrGetQr(); if (typeof renderQr === 'function') renderQr(); }
      catch (e) { alert(e?.message || 'Не удалось сохранить меню.'); }
    };
    installPublicUrl();

    // Intercept the menu/QR save before the legacy bridge can delete/recreate records.
    document.addEventListener('click', async function (event) {
      const button = event.target?.closest?.('button');
      if (!button || !/Сохранить меню и открыть QR-код|Сохранить меню и сгенерировать QR-код/i.test((button.textContent || '').trim())) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (button.dataset.menuoPersisting === '1') return;
      button.dataset.menuoPersisting = '1';
      button.disabled = true;
      try {
        const result = await createOrGetQr();
        if (typeof renderQr === 'function') renderQr();
        else if (typeof show === 'function') show('qr');
        if (result?.url) {
          const box = document.getElementById('publicUrlBox');
          if (box) box.textContent = result.url;
        }
      } catch (e) {
        alert(e?.message || 'Не удалось сохранить меню. Проверь интернет и повтори попытку.');
      } finally {
        button.disabled = false;
        delete button.dataset.menuoPersisting;
      }
    }, true);

    // A deleted dish is explicitly deleted remotely; other autosaves only upsert.
    if (typeof window.deleteDish === 'function' && !window.deleteDish.__menuoRemoteDelete) {
      const originalDelete = window.deleteDish;
      const wrapped = function (id) {
        const before = appState()?.dishes?.find((d) => d.id === id);
        originalDelete(id);
        if (!before || appState()?.dishes?.some((d) => d.id === id)) return;
        (async () => {
          const { sb, user } = await authenticated();
          const r = (appState()?.restaurants || []).find((item) => item.id === before.restaurantId);
          const remoteRestaurantId = r?.remoteId || before.restaurantId;
          const deleteId = before.remoteId || before.id;
          const removed = await sb.from('dishes').delete().eq('id', deleteId).eq('restaurant_id', remoteRestaurantId);
          if (removed.error) throw removed.error;
        })().catch((e) => alert(e?.message || 'Не удалось удалить блюдо с сервера.'));
      };
      wrapped.__menuoRemoteDelete = true;
      window.deleteDish = wrapped;
    }
  }

  async function installWhenReady() {
    if (attachPromise) return attachPromise;
    attachPromise = (async () => {
      for (let i = 0; i < 240; i++) {
        if (window.MENUO_SUPABASE && appState() && typeof currentRestaurant === 'function' && typeof save === 'function') {
          installApi();
          // Refresh plan and menus from the server before reopening the owner area.
          const originalOpenOwner = window.openOwner;
          window.openOwner = async function () {
            const { sb, user } = await authenticated().catch(() => ({ sb: null, user: null }));
            if (!sb || !user) {
              if (typeof window.openAuth === 'function') window.openAuth('login', 'owner');
              else if (typeof show === 'function') show('auth');
              return;
            }
            try { if (typeof window.MENUO_HYDRATE === 'function') await window.MENUO_HYDRATE(); } catch (e) { console.warn('MENUO refresh before owner screen failed', e); }
            if (typeof show === 'function') show('owner');
            else if (typeof originalOpenOwner === 'function') originalOpenOwner();
          };
          return;
        }
        await sleep(100);
      }
      console.error('MENUO persistence bridge could not find the Supabase client.');
    })();
    return attachPromise;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installWhenReady, { once: true });
  else installWhenReady();
})();

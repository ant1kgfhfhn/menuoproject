import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@22";
import { createClient } from "jsr:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "");
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
function isoTime(value: unknown) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function periodTimestamp(sub: any, field: "current_period_start" | "current_period_end"): number | null {
  const direct = Number(sub?.[field]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const items = sub?.items?.data || [];
  const candidates = items
    .map((item: any) => Number(item?.[field]))
    .filter((value: number) => Number.isFinite(value) && value > 0);
  if (!candidates.length) return null;
  // MENUO subscriptions use a single recurring base item. Fall back to the item-level
  // period fields used by newer Stripe API versions.
  return field === "current_period_end" ? Math.min(...candidates) : Math.min(...candidates);
}
function periodIso(sub: any, field: "current_period_start" | "current_period_end"): string | null {
  const value = periodTimestamp(sub, field);
  return value ? isoTime(value) : null;
}
function idOf(value: any): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (typeof value.id === "string" ? value.id : null);
}
async function fetchActiveSchedule(sub: any) {
  const scheduleId = idOf(sub.schedule);
  if (!scheduleId) return null;
  try { return await stripe.subscriptionSchedules.retrieve(scheduleId); }
  catch (error) {
    console.error("Unable to retrieve subscription schedule", scheduleId, error);
    throw error;
  }
}
async function ensureFreePrice(currency: string = "usd") {
  const normalizedCurrency = String(currency || "usd").toLowerCase();
  if (!["usd", "eur"].includes(normalizedCurrency)) throw new Error("Unsupported subscription currency.");
  const lookupKey = normalizedCurrency === "usd" ? "menuo_free_monthly" : "menuo_free_monthly_eur";
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const matching = existing.data.find((price: any) => price.currency === normalizedCurrency && price.unit_amount === 0 && price.recurring?.interval === "month");
  if (matching) return matching;
  const product = await stripe.products.create({ name: "MENUO FREE", metadata: { menuo_plan_id: "free", managed_by: "menuo" } });
  return await stripe.prices.create({
    product: product.id, currency: normalizedCurrency, unit_amount: 0,
    recurring: { interval: "month" }, lookup_key: lookupKey,
    metadata: { menuo_plan_id: "free", managed_by: "menuo" }
  });
}
async function upsertSubscriptionRow(userId: string, sub: any, planId: string) {
  const patch: Record<string, unknown> = {
    user_id: userId,
    plan_id: planId,
    status: sub.status,
    stripe_customer_id: String(idOf(sub.customer) || ""),
    stripe_subscription_id: sub.id
  };
  const start = periodIso(sub, "current_period_start");
  const end = periodIso(sub, "current_period_end");
  if (start) patch.current_period_start = start;
  if (end) patch.current_period_end = end;
  const result = await supabase.from("subscriptions").upsert(patch, { onConflict: "user_id" });
  if (result.error) throw result.error;
}
async function addInboxMessage(userId: string, title: string, body: string, messageType = "info") {
  const result = await supabase.from("user_messages").insert({
    user_id: userId, title, body, message_type: messageType
  });
  if (result.error) console.warn("Could not add subscription inbox message", result.error);
}

const ONE_TIME_PRO_RECOVERY = {
  userId: "f76e8115-4f04-4207-b61c-e7eda8ffab48",
  customerId: "cus_VUqKlwPUJHf4tS",
  subscriptionId: "sub_1UTqipJmpZ9OQn3slXwWuWDE"
};
async function canRecoverLastPaidPro(userId: string, row: any, sub: any, currentPlan: string) {
  if (userId !== ONE_TIME_PRO_RECOVERY.userId ||
      row?.stripe_customer_id !== ONE_TIME_PRO_RECOVERY.customerId ||
      row?.stripe_subscription_id !== ONE_TIME_PRO_RECOVERY.subscriptionId ||
      idOf(sub?.customer) !== ONE_TIME_PRO_RECOVERY.customerId ||
      sub?.id !== ONE_TIME_PRO_RECOVERY.subscriptionId ||
      String(row?.plan_id || "").toLowerCase() !== "business" ||
      currentPlan !== "business" ||
      !["active", "trialing"].includes(String(sub?.status || ""))) return false;
  const { data, error } = await supabase.from("payment_events")
    .select("payload,created_at,event_type,stripe_subscription_id,user_id")
    .eq("user_id", userId)
    .eq("event_type", "checkout.session.completed")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  const events = data || [];

  // The upgrade is a separate one-time Checkout session, so its database
  // stripe_subscription_id is the Checkout session ID (not sub.id). Read the
  // verified metadata to detect that the user has already paid for the upgrade.
  const paidUpgradeExists = events.some((event: any) =>
    event?.payload?.mode === "payment" &&
    event?.payload?.payment_status === "paid" &&
    event?.payload?.metadata?.action === "subscription_upgrade" &&
    event?.payload?.metadata?.supabase_user_id === userId &&
    event?.payload?.metadata?.subscription_id === sub.id &&
    ["pro", "business"].includes(String(event?.payload?.metadata?.target_plan || "").toLowerCase())
  );
  if (paidUpgradeExists) return false;

  return events.some((event: any) =>
    event?.stripe_subscription_id === sub.id &&
    event?.payload?.mode === "subscription" &&
    event?.payload?.payment_status === "paid" &&
    String(event?.payload?.metadata?.plan_id || "").toLowerCase() === "pro" &&
    event?.payload?.metadata?.supabase_user_id === userId
  );
}
async function ensureProMonthlyPrice(currency: string = "usd") {
  const normalizedCurrency = String(currency || "usd").toLowerCase();
  if (!["usd", "eur"].includes(normalizedCurrency)) throw new Error("Unsupported subscription currency.");
  const lookupKey = normalizedCurrency === "usd" ? "menuo_pro_monthly_recovery" : "menuo_pro_monthly_recovery_eur";
  const lookup = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const matching = lookup.data.find((price: any) => price.currency === normalizedCurrency && price.unit_amount === 499 && price.recurring?.interval === "month");
  if (matching) return matching;
  const prices = await stripe.prices.list({ active: true, limit: 100 });
  const existing = prices.data.find((price: any) => price.currency === normalizedCurrency && price.unit_amount === 499 && price.recurring?.interval === "month" && String(price.metadata?.menuo_plan_id || "").toLowerCase() === "pro");
  if (existing) return existing;
  const product = await stripe.products.create({ name: "MENUO PRO", metadata: { menuo_plan_id: "pro", managed_by: "menuo_recovery" } });
  return await stripe.prices.create({
    product: product.id, currency: normalizedCurrency, unit_amount: 499,
    recurring: { interval: "month" }, lookup_key: lookupKey,
    metadata: { menuo_plan_id: "pro", managed_by: "menuo_recovery" }
  });
}
function planIdOf(sub: any, row: any) {
  const itemPlan = (sub?.items?.data || [])
    .map((item: any) => item?.price?.metadata?.menuo_plan_id)
    .find((value: unknown) => typeof value === "string" && value.trim());
  return String(itemPlan || sub?.metadata?.plan_id || row?.plan_id || "free").toLowerCase();
}
async function releaseScheduleIfPresent(sub: any) {
  const scheduleId = idOf(sub.schedule);
  if (!scheduleId) return sub;
  await stripe.subscriptionSchedules.release(scheduleId);
  return await stripe.subscriptions.retrieve(sub.id);
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "status");
    const { data: row, error: rowError } = await supabase.from("subscriptions")
      .select("plan_id,status,stripe_customer_id,stripe_subscription_id,current_period_end")
      .eq("user_id", user.id).maybeSingle();
    if (rowError) throw rowError;

    if (!row?.stripe_subscription_id) {
      if (action === "status") {
        return json({
          planId: "free", status: "free", cancelAtPeriodEnd: false,
          currentPeriodEnd: null, hasSubscription: false,
          pendingPlanId: null, pendingPlanAt: null
        });
      }
      if (action === "switch_free") {
        return json({
          planId: "free", status: "free", cancelAtPeriodEnd: false,
          currentPeriodEnd: null, hasSubscription: false,
          pendingPlanId: null, pendingPlanAt: null, message: "already_free"
        });
      }
      return json({ error: "Для этого действия не найдена активная Stripe-подписка." }, 409);
    }

    let sub: any;
    try {
      sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    } catch (error) {
      if (row.status === "active") throw error;
      return json({
        planId: "free", status: row.status || "free", cancelAtPeriodEnd: false,
        currentPeriodEnd: row.current_period_end || null, hasSubscription: false,
        pendingPlanId: null, pendingPlanAt: null
      });
    }

    let schedule = await fetchActiveSchedule(sub);
    let currentPlan = planIdOf(sub, row);
    let newlyCanceled = false;

    if (action === "restore_pro_no_charge") {
      const allowed = await canRecoverLastPaidPro(user.id, row, sub, currentPlan);
      if (!allowed) {
        return json({ error: "Восстановление доступно только для той подписки, у которой была подтверждена последняя оплата PRO. Данные текущей подписки не изменены." }, 403);
      }
      if (!["active", "trialing"].includes(String(sub.status))) {
        return json({ error: "Подписка уже не активна. Восстановление остановлено без изменений." }, 409);
      }
      if (schedule) {
        await stripe.subscriptionSchedules.release(schedule.id);
        sub = await stripe.subscriptions.retrieve(sub.id);
        schedule = null;
      }
      const items = (sub.items?.data || []).filter((item: any) => !item.deleted);
      if (items.length !== 1) {
        return json({ error: "У подписки неожиданное количество платёжных элементов. Ничего не изменено — требуется ручная проверка." }, 409);
      }
      const item = items[0];
      const subscriptionCurrency = String(item.price?.currency || "usd").toLowerCase();
      const proPrice = await ensureProMonthlyPrice(subscriptionCurrency);
      const restored = await stripe.subscriptions.update(sub.id, {
        items: [{ id: item.id, price: proPrice.id, quantity: item.quantity || 1 }],
        proration_behavior: "none",
        metadata: {
          ...(sub.metadata || {}),
          supabase_user_id: user.id,
          plan_id: "pro",
          pending_plan_id: ""
        }
      });
      currentPlan = "pro";
      await upsertSubscriptionRow(user.id, restored, "pro");
      const end = periodIso(restored, "current_period_end");
      await addInboxMessage(
        user.id,
        "Тариф PRO восстановлен",
        "Тариф возвращён на PRO по последней подтверждённой оплате. Сейчас новое списание не создавалось. Дальнейшее продление — по цене PRO ($4.99/месяц) на текущую дату продления. Проверь дату на странице «Тарифы».",
        "success"
      );
      return json({
        restored: true,
        planId: "pro",
        status: restored.status,
        currentPeriodEnd: end,
        chargedNow: false,
        prorationBehavior: "none"
      });
    }

    if (action === "cancel") {
      if (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due" || sub.status === "unpaid") {
        // A scheduled downgrade must not override a full cancellation at the period end.
        if (schedule) {
          await stripe.subscriptionSchedules.release(schedule.id);
          sub = await stripe.subscriptions.retrieve(sub.id);
          schedule = null;
        }
        if (!sub.cancel_at_period_end) {
          sub = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
          newlyCanceled = true;
        }
      }
      currentPlan = planIdOf(sub, row);
      await upsertSubscriptionRow(user.id, sub, currentPlan);
      const end = periodIso(sub, "current_period_end");
      if (newlyCanceled) {
        await addInboxMessage(
          user.id,
          "Отмена подписки запланирована",
          "Автопродление MENUO отключено. Ваш текущий тариф остаётся доступен до " +
            (end ? new Date(end).toLocaleDateString("de-DE") : "конца оплаченного периода") +
            ". После этой даты подписка не продлится. Уже выставленные или просроченные счета и суммы, возникшие до отмены, не аннулируются.",
          "success"
        );
      }
      return json({
        planId: currentPlan, status: sub.status,
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        currentPeriodEnd: end, hasSubscription: true,
        pendingPlanId: null, pendingPlanAt: null,
        canceled: !!sub.cancel_at_period_end
      });
    }

    if (action === "resume") {
      if (sub.cancel_at_period_end && (sub.status === "active" || sub.status === "trialing")) {
        sub = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
        await addInboxMessage(
          user.id,
          "Автопродление восстановлено",
          "Автопродление подписки MENUO снова включено. Следующая дата продления: " +
            (periodIso(sub, "current_period_end") ? new Date(periodIso(sub, "current_period_end")!).toLocaleDateString("de-DE") : "согласно разделу «Тарифы»") + ".",
          "info"
        );
      }
      currentPlan = planIdOf(sub, row);
      await upsertSubscriptionRow(user.id, sub, currentPlan);
      schedule = await fetchActiveSchedule(sub);
    } else if (action === "switch_free") {
      currentPlan = planIdOf(sub, row);
      if (!["active", "trialing"].includes(String(sub.status))) {
        return json({ error: "Нельзя изменить тариф: подписка сейчас не активна. Обнови страницу или обратись в поддержку." }, 409);
      }

      schedule = await fetchActiveSchedule(sub);
      const hasFreeSchedule = !!schedule && (
        String(schedule.metadata?.pending_plan_id || "").toLowerCase() === "free" ||
        (schedule.phases || []).some((phase: any) =>
          Number(phase.start_date) >= Number(periodTimestamp(sub, "current_period_end") || 0) &&
          String(phase.metadata?.plan_id || "").toLowerCase() === "free"
        )
      );
      if (hasFreeSchedule) {
        return json({
          planId: currentPlan, status: sub.status,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          currentPeriodEnd: periodIso(sub, "current_period_end"), hasSubscription: true,
          pendingPlanId: "free", pendingPlanAt: periodIso(sub, "current_period_end"),
          message: "downgrade_already_scheduled"
        });
      }
      if (currentPlan === "free") {
        return json({
          planId: "free", status: sub.status,
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          currentPeriodEnd: periodIso(sub, "current_period_end"), hasSubscription: true,
          pendingPlanId: null, pendingPlanAt: null, message: "already_free"
        });
      }
      if (sub.cancel_at_period_end) {
        sub = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
        schedule = null;
      }
      if (schedule) {
        await stripe.subscriptionSchedules.release(schedule.id);
        sub = await stripe.subscriptions.retrieve(sub.id);
        schedule = null;
      }

      const endTimestamp = Number(periodTimestamp(sub, "current_period_end") || 0);
      if (!Number.isFinite(endTimestamp) || endTimestamp <= Math.floor(Date.now() / 1000)) {
        throw new Error("Stripe не вернул корректную дату окончания текущего периода.");
      }

      const subscriptionCurrency = String((sub.items?.data || []).find((item: any) => !item.deleted)?.price?.currency || "usd").toLowerCase();
      const freePrice = await ensureFreePrice(subscriptionCurrency);
      const createdSchedule = await stripe.subscriptionSchedules.create({
        from_subscription: sub.id,
        metadata: { supabase_user_id: user.id, pending_plan_id: "free" }
      });
      const currentPhase = createdSchedule.phases?.[0];
      const currentItems = (sub.items?.data || []).map((item: any) => ({
        price: idOf(item.price),
        quantity: item.quantity || 1
      })).filter((item: any) => !!item.price);
      if (!currentPhase || !currentItems.length) {
        await stripe.subscriptionSchedules.release(createdSchedule.id);
        throw new Error("Не удалось подготовить безопасную смену тарифа. Повторного списания не запускали.");
      }

      const firstPhase: any = {
        start_date: Number(currentPhase.start_date || periodTimestamp(sub, "current_period_start") || 0),
        end_date: endTimestamp,
        items: currentItems,
        metadata: { ...(sub.metadata || {}), supabase_user_id: user.id, plan_id: currentPlan },
        proration_behavior: "none"
      };
      if (currentPhase.default_tax_rates) firstPhase.default_tax_rates = currentPhase.default_tax_rates.map((x: any) => idOf(x)).filter(Boolean);
      if (currentPhase.discounts) firstPhase.discounts = currentPhase.discounts.map((x: any) => {
        const coupon = idOf(x.coupon);
        const promotionCode = idOf(x.promotion_code);
        return coupon ? { coupon } : (promotionCode ? { promotion_code: promotionCode } : null);
      }).filter(Boolean);
      if (currentPhase.collection_method) firstPhase.collection_method = currentPhase.collection_method;
      if (currentPhase.invoice_settings) firstPhase.invoice_settings = currentPhase.invoice_settings;
      if (currentPhase.automatic_tax) firstPhase.automatic_tax = currentPhase.automatic_tax;
      if (currentPhase.billing_thresholds) firstPhase.billing_thresholds = currentPhase.billing_thresholds;
      if (currentPhase.transfer_data) firstPhase.transfer_data = currentPhase.transfer_data;
      if (currentPhase.application_fee_percent != null) firstPhase.application_fee_percent = currentPhase.application_fee_percent;

      const freePhase: any = {
        start_date: endTimestamp,
        iterations: 1,
        items: [{ price: freePrice.id, quantity: 1 }],
        metadata: { supabase_user_id: user.id, plan_id: "free", promo_code: "" },
        proration_behavior: "none"
      };
      const updatedSchedule = await stripe.subscriptionSchedules.update(createdSchedule.id, {
        end_behavior: "release",
        proration_behavior: "none",
        metadata: { ...(createdSchedule.metadata || {}), supabase_user_id: user.id, pending_plan_id: "free" },
        phases: [firstPhase, freePhase]
      });

      await upsertSubscriptionRow(user.id, sub, currentPlan);
      await addInboxMessage(
        user.id,
        "Переход на FREE запланирован",
        "Тариф " + currentPlan.toUpperCase() + " остаётся доступен до " +
          new Date(endTimestamp * 1000).toLocaleDateString("de-DE") +
          ". После этой даты автоматически включится FREE за 0 USD в месяц. Дополнительное списание при планировании перехода не создаётся.",
        "success"
      );
      return json({
        planId: currentPlan, status: sub.status, cancelAtPeriodEnd: false,
        currentPeriodEnd: isoTime(endTimestamp), hasSubscription: true,
        pendingPlanId: "free", pendingPlanAt: isoTime(endTimestamp),
        scheduleId: updatedSchedule.id, message: "downgrade_scheduled"
      });
    } else if (action === "keep_current") {
      schedule = await fetchActiveSchedule(sub);
      if (schedule && String(schedule.metadata?.pending_plan_id || "").toLowerCase() === "free") {
        await stripe.subscriptionSchedules.release(schedule.id);
        sub = await stripe.subscriptions.retrieve(sub.id);
      }
      currentPlan = planIdOf(sub, row);
      await upsertSubscriptionRow(user.id, sub, currentPlan);
      schedule = await fetchActiveSchedule(sub);
      return json({
        planId: currentPlan, status: sub.status,
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
        currentPeriodEnd: periodIso(sub, "current_period_end"), hasSubscription: true,
        pendingPlanId: null, pendingPlanAt: null, message: "current_plan_kept"
      });
    } else if (action !== "status") {
      return json({ error: "Unsupported action" }, 400);
    }

    currentPlan = planIdOf(sub, row);
    schedule = await fetchActiveSchedule(sub);
    let pendingPlanId: string | null = null;
    let pendingPlanAt: string | null = null;
    if (schedule) {
      const pendingFromMetadata = String(schedule.metadata?.pending_plan_id || "").toLowerCase();
      const future = (schedule.phases || []).find((phase: any) =>
        Number(phase.start_date) >= Number(periodTimestamp(sub, "current_period_end") || 0) &&
        String(phase.metadata?.plan_id || "").toLowerCase() === "free"
      );
      if (pendingFromMetadata === "free" || future) {
        pendingPlanId = "free";
        pendingPlanAt = isoTime(future?.start_date || periodTimestamp(sub, "current_period_end"));
      }
    }

    let recoveryAvailable = false;
    if (action === "status") {
      // Repair dates from Stripe and surface the one-time recovery only to the
      // exact account/subscription whose paid PRO Checkout event was verified.
      await upsertSubscriptionRow(user.id, sub, currentPlan);
      recoveryAvailable = await canRecoverLastPaidPro(user.id, row, sub, currentPlan);
    }

    return json({
      planId: currentPlan,
      status: sub.status,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      currentPeriodEnd: periodIso(sub, "current_period_end") || row.current_period_end || null,
      hasSubscription: true,
      pendingPlanId,
      pendingPlanAt,
      recoveryAvailable
    });
  } catch (e) {
    console.error("manage-subscription failed", e);
    return json({ error: e instanceof Error ? e.message : "Subscription operation failed" }, 500);
  }
});

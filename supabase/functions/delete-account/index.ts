import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@22";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const ALLOWED_ORIGINS = new Set([
  "https://menuo-qr.com",
  "https://www.menuo-qr.com",
  "https://localhost",
  "http://localhost",
  "capacitor://localhost",
  "ionic://localhost"
]);

const BILLABLE_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
const POSSIBLY_BILLABLE_STATUSES = new Set([
  ...BILLABLE_STATUSES, "incomplete", "paused"
]);

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin") || "";
  const localDevOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) || localDevOrigin;
  return {
    "Access-Control-Allow-Origin": allowedOrigin ? origin : "https://menuo-qr.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" }
  });
}

function stripeId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

async function cancelAllAccountSubscriptions(userId: string) {
  const [primaryResult, contractsResult] = await Promise.all([
    admin.from("subscriptions")
      .select("status,stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle(),
    admin.from("subscription_contracts")
      .select("status,stripe_subscription_id")
      .eq("user_id", userId)
  ]);

  if (primaryResult.error) throw primaryResult.error;
  if (contractsResult.error) throw contractsResult.error;

  const rows = [
    ...(primaryResult.data ? [primaryResult.data] : []),
    ...(contractsResult.data || [])
  ];
  const ids = [...new Set(rows
    .map((row) => String(row.stripe_subscription_id || "").trim())
    .filter(Boolean))];

  if (!ids.length) return;

  if (!STRIPE_SECRET_KEY) {
    const hasPotentialBilling = rows.some((row) =>
      POSSIBLY_BILLABLE_STATUSES.has(String(row.status || "").toLowerCase())
    );
    if (hasPotentialBilling) {
      throw new Error("Найдена платная подписка, но сервер не может подтвердить её отмену. Обратись в поддержку MENUO перед удалением аккаунта.");
    }
    return;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  for (const subscriptionId of ids) {
    let current: any;
    try {
      current = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (error: any) {
      // A stale database reference to an already deleted Stripe subscription
      // cannot renew or charge the customer.
      if (error?.statusCode === 404 || error?.code === "resource_missing") continue;
      throw error;
    }

    if (!BILLABLE_STATUSES.has(String(current.status || "").toLowerCase())) continue;

    const scheduleId = stripeId(current.schedule);
    if (scheduleId) {
      await stripe.subscriptionSchedules.release(scheduleId);
      current = await stripe.subscriptions.retrieve(subscriptionId);
    }

    if (BILLABLE_STATUSES.has(String(current.status || "").toLowerCase())) {
      await stripe.subscriptions.cancel(subscriptionId, {
        invoice_now: false,
        prorate: false
      });
    }
  }
}

async function purgeStoragePrefix(bucket: string, prefix: string) {
  async function walk(path: string): Promise<void> {
    // Read every page before deleting anything. Offset pagination while
    // deleting from the same listing can skip objects as the result set shrinks.
    const rows: Array<{ name: string; id: string | null }> = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await admin.storage.from(bucket).list(path, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" }
      });
      if (error) throw error;
      const page = data || [];
      rows.push(...page);
      if (page.length < 100) break;
    }

    const files: string[] = [];
    const directories: string[] = [];
    for (const item of rows) {
      const fullPath = path ? `${path}/${item.name}` : item.name;
      if (item.id === null) directories.push(fullPath);
      else files.push(fullPath);
    }

    for (const directory of directories) await walk(directory);

    // Storage remove accepts batches; keep each request comfortably bounded.
    for (let i = 0; i < files.length; i += 100) {
      const removed = await admin.storage.from(bucket).remove(files.slice(i, i + 100));
      if (removed.error) throw removed.error;
    }
  }

  await walk(prefix);
}

Deno.serve(async (req: Request) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Для удаления войдите в аккаунт повторно." }, 401, cors);

    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: "Сессия недействительна. Войдите снова." }, 401, cors);

    const body = await req.json().catch(() => ({}));
    if (body.confirmation !== "DELETE") {
      return json({ error: "Подтверждение удаления не получено." }, 400, cors);
    }

    // Cancel every Stripe subscription associated with this account, including
    // older/additional contracts not represented by the primary plan row.
    await cancelAllAccountSubscriptions(user.id);

    // Remove account-owned files before deleting the Auth user.
    await purgeStoragePrefix("profile-avatars", user.id);
    await purgeStoragePrefix("restaurant-photos", user.id);

    // These tables are not all linked by foreign keys, so delete explicitly.
    const deletedMessages = await admin.from("user_messages").delete().eq("user_id", user.id);
    if (deletedMessages.error) throw deletedMessages.error;

    const deletedContracts = await admin.from("subscription_contracts").delete().eq("user_id", user.id);
    if (deletedContracts.error) throw deletedContracts.error;

    // Profile foreign keys cascade to restaurants, menus, QR codes, promotions,
    // subscriptions and promo redemptions. Payment-event audit rows are retained
    // with their user_id set to NULL by the existing FK.
    const deletedProfile = await admin.from("profiles").delete().eq("id", user.id);
    if (deletedProfile.error) throw deletedProfile.error;

    const deletedAuth = await admin.auth.admin.deleteUser(user.id, true);
    if (deletedAuth.error) throw deletedAuth.error;

    return json({ success: true }, 200, cors);
  } catch (error) {
    console.error("delete-account failed", error);
    return json({
      error: error instanceof Error ? error.message : "Не удалось удалить аккаунт."
    }, 500, cors);
  }
});
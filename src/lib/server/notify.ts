const TIMEOUT_MS = 8_000;
const MAX_LENGTH = 3_900;

/**
 * Invia un messaggio Telegram. No-op se le env mancano.
 * Non lancia mai: un problema di notifica non deve fermare il trading.
 */
export async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { ok: false as const, skipped: true as const };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, MAX_LENGTH),
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn("[scalper-notify] telegram_http", response.status, (await response.text().catch(() => "")).slice(0, 200));
      return { ok: false as const, skipped: false as const };
    }
    return { ok: true as const, skipped: false as const };
  } catch (error) {
    console.warn("[scalper-notify] telegram_error", error instanceof Error ? error.message : String(error));
    return { ok: false as const, skipped: false as const };
  } finally {
    clearTimeout(timer);
  }
}

export function money(value: unknown, digits = 2) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "—";
}

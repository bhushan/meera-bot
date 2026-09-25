/**
 * Point the Telegram bot at this deployment's webhook and verify the result.
 * Prints nothing that could reveal the bot token or the webhook secret.
 */
import {
  ALLOWED_UPDATES,
  callTelegram,
  describeToken,
  loadScriptEnv,
  printWebhookInfo,
  webhookUrl,
  type WebhookInfo,
} from './_shared';

async function main(): Promise<void> {
  const env = loadScriptEnv();
  const url = webhookUrl(env.APP_BASE_URL);

  if (!url.startsWith('https://')) {
    console.error(`Telegram requires an https webhook URL. APP_BASE_URL resolves to ${url}`);
    process.exit(1);
  }

  console.log(`Setting webhook for ${describeToken(env.TELEGRAM_BOT_TOKEN)}`);
  console.log(`  target: ${url}`);

  await callTelegram(env.TELEGRAM_BOT_TOKEN, 'setWebhook', {
    url,
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    max_connections: 20,
    drop_pending_updates: false,
  });

  const info = await callTelegram<WebhookInfo>(env.TELEGRAM_BOT_TOKEN, 'getWebhookInfo');

  console.log('\ngetWebhookInfo:');
  printWebhookInfo(info);

  if (info.url !== url) {
    console.error(
      `\nVerification failed: Telegram reports ${info.url ?? '(none)'}, expected ${url}`,
    );
    process.exit(1);
  }

  const missing = ALLOWED_UPDATES.filter(
    (update) => !(info.allowed_updates ?? []).includes(update),
  );
  if (missing.length > 0) {
    console.error(`\nVerification failed: allowed_updates is missing ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log('\nWebhook set and verified. The secret token was sent but is not printed here.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

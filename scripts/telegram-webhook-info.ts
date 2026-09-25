/** Read-only check of the current webhook registration. */
import {
  callTelegram,
  describeToken,
  loadScriptEnv,
  printWebhookInfo,
  webhookUrl,
  type WebhookInfo,
} from './_shared';

async function main(): Promise<void> {
  const env = loadScriptEnv();
  const info = await callTelegram<WebhookInfo>(env.TELEGRAM_BOT_TOKEN, 'getWebhookInfo');

  console.log(`Webhook for ${describeToken(env.TELEGRAM_BOT_TOKEN)}`);
  printWebhookInfo(info);
  console.log(`\n  expected url:          ${webhookUrl(env.APP_BASE_URL)}`);
  console.log(`  matches expected:      ${info.url === webhookUrl(env.APP_BASE_URL)}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

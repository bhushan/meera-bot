/**
 * Rollback: detach the bot from this deployment.
 *
 * Pending updates are preserved by default so nothing Meera sent is lost while
 * the webhook is down. Pass --drop-pending to discard the backlog instead.
 */
import {
  callTelegram,
  describeToken,
  loadScriptEnv,
  printWebhookInfo,
  type WebhookInfo,
} from './_shared';

async function main(): Promise<void> {
  const env = loadScriptEnv();
  const dropPending = process.argv.includes('--drop-pending');

  console.log(`Deleting webhook for ${describeToken(env.TELEGRAM_BOT_TOKEN)}`);
  console.log(`  drop_pending_updates: ${dropPending}`);

  await callTelegram(env.TELEGRAM_BOT_TOKEN, 'deleteWebhook', {
    drop_pending_updates: dropPending,
  });

  const info = await callTelegram<WebhookInfo>(env.TELEGRAM_BOT_TOKEN, 'getWebhookInfo');
  console.log('\ngetWebhookInfo:');
  printWebhookInfo(info);

  if (info.url) {
    console.error(`\nWebhook is still set to ${info.url}`);
    process.exit(1);
  }
  console.log('\nWebhook removed. The bot will not receive updates until it is set again.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

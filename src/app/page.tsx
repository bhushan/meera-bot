/**
 * There is deliberately no admin dashboard: drafts and review decisions are
 * reachable only through Telegram and Supabase, which keeps the attack surface
 * of this deployment to two authenticated API routes.
 */
export default function Home() {
  return (
    <main style={{ maxWidth: '38rem', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>meera-bot</h1>
      <p style={{ color: '#57534e' }}>
        A private Telegram assistant that turns notes into LinkedIn drafts for human review. It
        never publishes or schedules anything.
      </p>
      <p style={{ color: '#57534e' }}>
        There is no web interface. Operational endpoints: <code>/api/health</code> and{' '}
        <code>/api/telegram/webhook</code>.
      </p>
    </main>
  );
}

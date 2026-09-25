import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `voice-skill.txt` is read from disk only as a fallback when the database has
  // no active voice skill row. Trace it explicitly so the serverless bundle for
  // the webhook route actually contains the file.
  outputFileTracingIncludes: {
    '/api/telegram/webhook': ['./voice-skill.txt'],
  },
  // No server-only value is ever placed on `env` / `NEXT_PUBLIC_*`.
  // Secrets stay in process.env on the server and are validated in src/lib/env.ts.
  poweredByHeader: false,
};

export default nextConfig;

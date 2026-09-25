import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'meera-bot',
  description: 'Telegram to LinkedIn draft assistant. Human approval required.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          lineHeight: 1.6,
          margin: 0,
          padding: '3rem 1.5rem',
          color: '#1a1a1a',
          background: '#fafaf9',
        }}
      >
        {children}
      </body>
    </html>
  );
}

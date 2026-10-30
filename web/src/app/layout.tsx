import '@exp-textura/react/fonts.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Providers } from './providers.tsx';

export const metadata: Metadata = {
  title: 'Bulk Operations',
  description:
    'Bulk archive, delete, move and ownership updates for Nintex Process Manager.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

import { notFound } from 'next/navigation';

import { PreviewClient } from './PreviewClient.tsx';

/**
 * Both selection views rendered from the recorded fixture (lib/select/fixtures.ts), so
 * they can be looked at without a tenant. Development only: a production build answers
 * 404, so a deployment never shows made-up data as if it were a tenant's.
 */
export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <PreviewClient />;
}

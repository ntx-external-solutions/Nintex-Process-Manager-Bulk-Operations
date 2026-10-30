'use client';

/**
 * Textura's theme, with the Emotion cache registry the App Router needs.
 *
 * This is Textura's canonical App Router pattern (get_setup_context): styles generated
 * while the server streams are collected and flushed into the HTML, so they hydrate
 * instead of being re-inserted. `emotionCache={cache}` matters: without it ThemeProvider
 * makes its own cache and the flush below sees nothing.
 */

import { CacheProvider, createTexturaCache, ThemeProvider } from '@exp-textura/react/theme';
import { useServerInsertedHTML } from 'next/navigation';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [{ cache, flush }] = useState(() => {
    const cache = createTexturaCache();
    cache.compat = true;
    const prevInsert = cache.insert;
    let inserted: string[] = [];
    cache.insert = (...args) => {
      const serialized = args[1];
      if (cache.inserted[serialized.name] === undefined) {
        inserted.push(serialized.name);
      }
      return prevInsert(...args);
    };
    const flush = () => {
      const prevInserted = inserted;
      inserted = [];
      return prevInserted;
    };
    return { cache, flush };
  });

  useServerInsertedHTML(() => {
    const names = flush();
    if (names.length === 0) return null;
    let styles = '';
    for (const name of names) {
      styles += cache.inserted[name];
    }
    return (
      <style
        key={cache.key}
        data-emotion={`${cache.key} ${names.join(' ')}`}
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    );
  });

  return (
    <CacheProvider value={cache}>
      <ThemeProvider emotionCache={cache} hoistCSSVars hoistThemeScopedStyles>
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}

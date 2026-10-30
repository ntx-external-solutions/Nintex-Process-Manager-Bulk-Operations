'use client';

/**
 * Small compositions of Textura components that every page repeats, so the pages stay
 * about their content. No behavior lives here.
 */

import { Alert } from '@exp-textura/react';
import type { ReactNode } from 'react';

type Tone = 'critical' | 'warning' | 'info' | 'success';

/** A message about the page's state: an error, a caution, a confirmation. */
export function Notice({ tone, title, children }: { tone: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <Alert variant={tone} treatment="subtle" type="inline" className="notice">
      <Alert.Content>
        {title !== undefined && <Alert.Title>{title}</Alert.Title>}
        {children !== undefined && <Alert.Description>{children}</Alert.Description>}
      </Alert.Content>
    </Alert>
  );
}

/** Label above a control, with optional help text under the label. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      {id ? (
        <label htmlFor={id} className="field-label">
          {label}
        </label>
      ) : (
        <span className="field-label">{label}</span>
      )}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
      {children}
    </div>
  );
}

/** Textura's Input and Textarea type their change events loosely; this reads the text. */
export function valueOf(event: { target: EventTarget }): string {
  return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
}

/** The header's meta row on every operation page. */
export function SignedInAs({ username, tenant }: { username: string; tenant: string }) {
  return (
    <span className="muted">
      Signed in as {username} on <code>{tenant}</code>
    </span>
  );
}

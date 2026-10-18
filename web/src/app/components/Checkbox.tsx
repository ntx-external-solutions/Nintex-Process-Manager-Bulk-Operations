'use client';

import { useEffect, useRef } from 'react';

import type { CheckState } from '@/lib/select/selection.ts';

/** A checkbox that can show "some of this", which a plain input cannot do from markup. */
export function Checkbox({
  state,
  disabled,
  label,
  onChange,
}: {
  state: CheckState;
  disabled?: boolean | undefined;
  label: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'mixed';
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'checked'}
      disabled={disabled}
      aria-label={label}
      aria-checked={state === 'mixed' ? 'mixed' : state === 'checked'}
      onChange={onChange}
    />
  );
}

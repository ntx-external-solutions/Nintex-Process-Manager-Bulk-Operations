'use client';

/**
 * Picking processes by id: typed or pasted, or read from a CSV (W7). Bulk Delete and
 * Bulk Archive both use it. The parsing is in lib/select/ids.ts.
 *
 * Ids only. A file with names and no ids is explained, never matched by name: names are
 * not unique, and both operations are destructive.
 */

import { FileUpload, Textarea, TextLink } from '@exp-textura/react';

import { afterFileRead, ID_TEMPLATE_CSV, type IdInput } from '@/lib/select/ids.ts';
import { Field, valueOf } from '../_ui/kit.tsx';

const TEMPLATE_HREF = `data:text/csv;charset=utf-8,${encodeURIComponent(ID_TEMPLATE_CSV)}`;

export function ProcessIdInput({ value, onChange }: { value: IdInput; onChange: (next: IdInput) => void }) {
  async function read(file: File | undefined) {
    if (!file) return;
    onChange(afterFileRead(value, file.name, await file.text()));
  }

  return (
    <div className="panel">
      <Field
        id="ids"
        label="Process ids (GUIDs or numeric ids), one per line"
        hint="Ids only. A process is never matched by its name, because names are not unique."
      >
        <Textarea id="ids" rows={8} value={value.text} onChange={(e) => onChange({ ...value, text: valueOf(e) })} />
      </Field>
      <Field label="Or a CSV with a ProcessID or ObjectID column. A results file from this app works. Reading one replaces what is in the box.">
        <div id="ids-file">
          <FileUpload
            accept=".csv,text/csv"
            multiple={false}
            files={[]}
            labels={{ headline: 'Drop a CSV here, or choose one' }}
            onFilesAccepted={(files) => void read(files[0]?.file)}
          >
            <FileUpload.Dropzone size="sm" />
          </FileUpload>
        </div>
      </Field>
      <p className="small">
        <TextLink href={TEMPLATE_HREF} download="process-ids-template.csv">
          Download a template
        </TextLink>{' '}
        (one column, headed ProcessID)
      </p>
      {value.note !== null && (
        <p className="small" role="status">
          {value.note}
        </p>
      )}
    </div>
  );
}

'use client';

/**
 * Picking processes by id: typed or pasted, or read from a CSV (W7). Bulk Delete and
 * Bulk Archive both use it, and the document pages (W8) with `kind="document"`, where a
 * number is a document id, or `kind="restore"`, which takes from a results file only what
 * its run left archived. The parsing is in lib/select/ids.ts.
 *
 * Ids only. A file with names and no ids is explained, never matched by name: names are
 * not unique, and both operations are destructive.
 */

import { FileUpload, Textarea, TextLink } from '@exp-textura/react';

import { afterFileRead, DOCUMENT_ID_TEMPLATE_CSV, ID_TEMPLATE_CSV, type IdInput, type IdKind } from '@/lib/select/ids.ts';
import { Field, valueOf } from '../_ui/kit.tsx';

const href = (csv: string) => `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;

const WORDING = {
  process: {
    label: 'Process ids (GUIDs or numeric ids), one per line',
    hint: 'Ids only. A process is never matched by its name, because names are not unique.',
    file: 'Or a CSV with a ProcessID or ObjectID column. A results file from this app works. Reading one replaces what is in the box.',
    template: href(ID_TEMPLATE_CSV),
    templateName: 'process-ids-template.csv',
    column: 'ProcessID',
  },
  document: {
    label: 'Document ids (GUIDs or numeric ids), one per line',
    hint: 'On this page a number is a document id, never a process id. Ids only: a document is never matched by its name, because names are not unique.',
    file: 'Or a CSV with a DocumentID or ObjectID column. A results file from the document pages works. Reading one replaces what is in the box.',
    template: href(DOCUMENT_ID_TEMPLATE_CSV),
    templateName: 'document-ids-template.csv',
    column: 'DocumentID',
  },
  restore: {
    label: 'Document ids (GUIDs or numeric ids), one per line',
    hint: 'On this page a number is a document id, never a process id. Ids only: a document is never matched by its name, because names are not unique.',
    file: 'Or a CSV with a DocumentID or ObjectID column. From a results file of Archive or Delete documents, only the documents that run archived and did not delete or put back are taken. Reading one replaces what is in the box.',
    template: href(DOCUMENT_ID_TEMPLATE_CSV),
    templateName: 'document-ids-template.csv',
    column: 'DocumentID',
  },
} as const;

export function ProcessIdInput({
  value,
  onChange,
  kind = 'process',
}: {
  value: IdInput;
  onChange: (next: IdInput) => void;
  kind?: IdKind;
}) {
  const words = WORDING[kind];
  async function read(file: File | undefined) {
    if (!file) return;
    onChange(afterFileRead(value, file.name, await file.text(), kind));
  }

  return (
    <div className="panel">
      <Field
        id="ids"
        label={words.label}
        hint={words.hint}
      >
        <Textarea id="ids" rows={8} value={value.text} onChange={(e) => onChange({ ...value, text: valueOf(e) })} />
      </Field>
      <Field label={words.file}>
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
        <TextLink href={words.template} download={words.templateName}>
          Download a template
        </TextLink>{' '}
        (one column, headed {words.column})
      </p>
      {value.note !== null && (
        <p className="small" role="status">
          {value.note}
        </p>
      )}
    </div>
  );
}

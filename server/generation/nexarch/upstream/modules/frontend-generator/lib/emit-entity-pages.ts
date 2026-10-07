// Adapted from NexArch commit 398f4cbd9e314954eda95540411ed4d06cd50cf3; used with the original author's permission.
/**
 * Emits one page per module derived from architecture.json + openapi.json.
 * A module the backend-manifest marks `crud: true` gets the full page: a
 * searchable, paginated DataTable, a create/edit Dialog wrapping the
 * generated Form, and delete via ConfirmDialog. A module the backend never
 * implemented still gets a real page (so navigation and routing are
 * complete) — but renders an honest "not implemented yet" panel instead of
 * wiring a table against a route that doesn't exist.
 */
import { entitySingular } from './project-model.ts';
import type { PageModel } from './project-model.ts';
import { inputTypeOf, labelOf } from './type-map.ts';
import type { GeneratedFile } from '../frontend-generator.types.ts';
import { file } from './file-tree.ts';

function columnCell(column: PageModel['listColumns'][number]): string {
  if (column.prismaType === 'Boolean') {
    return `(row) => (row.${column.field} ? <Badge variant="success">Yes</Badge> : <Badge>No</Badge>)`;
  }
  if (column.enumValues) {
    return `(row) => <Badge variant="accent">{String(row.${column.field})}</Badge>`;
  }
  if (column.prismaType === 'DateTime') {
    return `(row) => (row.${column.field} ? new Date(row.${column.field} as string).toLocaleDateString() : '—')`;
  }
  return '';
}

function implementedPage(page: PageModel): string {
  const singular = entitySingular(page.name);
  const create = page.operations.includes('create');
  const update = page.operations.includes('update');
  const remove = page.operations.includes('delete');
  const write = create || update;
  const unsupported = page.semantic?.operations.filter(operation => operation.intent === 'requested' && operation.support === 'unsupported').map(operation => operation.name) ?? [];
  const icons = [create ? 'Plus' : '', update ? 'Pencil' : '', remove ? 'Trash2' : ''].filter(Boolean);
  const hooks = [`use${page.name}List`, create ? `useCreate${singular}` : '', update ? `useUpdate${singular}` : '', remove ? `useDelete${singular}` : ''].filter(Boolean);
  const wide = page.listColumns.length > 4;
  const needsBadge = page.listColumns.some((c) => c.prismaType === 'Boolean' || c.enumValues);
  // Decided at generation time, not runtime: the emitted JSX either wraps
  // its own local `content` variable in FullWidthLayout or renders it
  // directly — `content` here is a literal identifier in the OUTPUT file,
  // not an interpolation into this template.
  const wrappedContent = wide ? '<FullWidthLayout>{content}</FullWidthLayout>' : '{content}';

  const columnDefs = page.listColumns
    .map((c) => {
      const render = columnCell(c);
      return `    { key: '${c.field}', header: '${labelOf(c)}'${render ? `, render: ${render}` : ''} },`;
    })
    .join('\n');

  const imports = [
    "import { useState } from 'react';",
    icons.length ? `import { ${icons.join(', ')} } from 'lucide-react';` : null,
    '',
    "import { PageHeader } from '@/shared/components/page-header';",
    icons.length ? "import { Button } from '@/shared/components/ui/button';" : null,
    needsBadge ? "import { Badge } from '@/shared/components/ui/badge';" : null,
    "import { Dialog } from '@/shared/components/ui/dialog';",
    remove ? "import { ConfirmDialog } from '@/shared/components/ui/confirm-dialog';" : null,
    "import { DataTable } from '@/shared/components/ui/data-table';",
    "import type { DataTableColumn } from '@/shared/components/ui/data-table';",
    "import { Pagination } from '@/shared/components/ui/pagination';",
    "import { SearchInput } from '@/shared/components/ui/search-input';",
    "import { ErrorState } from '@/shared/components/ui/error-state';",
    wide ? "import { FullWidthLayout } from '@/shared/layouts/full-width-layout';" : null,
    write ? `import { ${singular}Form } from './components/${singular}Form';` : null,
    `import { ${hooks.join(', ')} } from './hooks/use-${page.slug}';`,
    `import type { ${page.name}Record } from './types';`,
    write ? `import type { Create${singular}FormValues } from './schema';` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return `${imports}

const columns: DataTableColumn<${page.name}Record>[] = [
${columnDefs}
];

export function ${page.name}Page() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [detailRecord, setDetailRecord] = useState<${page.name}Record | null>(null);
  ${write ? `const [dialogRecord, setDialogRecord] = useState<${page.name}Record | 'new' | null>(null);` : ''}
  ${remove ? `const [pendingDelete, setPendingDelete] = useState<${page.name}Record | null>(null);` : ''}

  const list = use${page.name}List({ page, limit: 20, search: search || undefined });
  ${create ? `const createMutation = useCreate${singular}();` : ''}
  ${update ? `const updateMutation = useUpdate${singular}();` : ''}
  ${remove ? `const deleteMutation = useDelete${singular}();` : ''}

  const items = list.data?.items ?? [];
  const pagination = list.data?.meta.pagination;

  ${write ? `const handleSubmit = (values: Create${singular}FormValues): void => {
    ${update ? `if (dialogRecord && dialogRecord !== 'new') {
      updateMutation.mutate(
        { id: dialogRecord.id, payload: values },
        { onSuccess: () => { setDialogRecord(null); } },
      );
    }` : ''}${create && update ? ' else {' : ''}
      ${create ? `
      createMutation.mutate(values, { onSuccess: () => { setDialogRecord(null); } });
      ` : ''}${create && update ? '}' : ''}
  };` : ''}

  const content = (
    <>
      ${unsupported.length ? `<p role="status" className="mb-4 text-sm text-fg-muted">Unsupported operations: {${JSON.stringify(unsupported.join(', '))}}. No corresponding action is enabled.</p>` : ''}
      <div className="mb-4 flex items-center justify-between gap-3">
        <SearchInput
          placeholder="Search ${page.navLabel.toLowerCase()}"
          onSearch={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
      </div>

      {list.isError ? (
        <ErrorState message="Could not load ${page.navLabel.toLowerCase()}. Try again shortly." />
      ) : (
        <>
          <DataTable
            columns={columns}
            data={items}
            getRowId={(row) => row.id}
            loading={list.isPending}
            emptyTitle="No ${page.navLabel.toLowerCase()} yet"
            emptyDescription="No records found."
            onRowClick={(row) => { setDetailRecord(row); }}
          />
          {pagination && (
            <Pagination
              page={pagination.page}
              totalPages={pagination.totalPages}
              hasNext={pagination.hasNext}
              hasPrev={pagination.hasPrev}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title="${page.navLabel}"
        description="Manage ${page.navLabel.toLowerCase()} records."
        ${create ? `actions={
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => { setDialogRecord('new'); }}>
            New ${singular}
          </Button>
        }` : ''}
      />

      ${wrappedContent}

      {detailRecord && (
        <Dialog open onClose={() => { setDetailRecord(null); }} title="${singular} details">
          <dl className="space-y-3">
${page.formFields.filter(field => inputTypeOf(field) !== 'password').map(field => `            <div><dt className="text-sm font-medium">${labelOf(field)}</dt><dd className="whitespace-pre-wrap break-words text-sm">{String(detailRecord.${field.field} ?? '')}</dd></div>`).join('\n')}
          </dl>
          ${update ? `<Button icon={<Pencil className="size-3.5" />} onClick={() => { setDialogRecord(detailRecord); setDetailRecord(null); }}>Edit ${singular}</Button>` : ''}
          ${remove ? `<Button icon={<Trash2 className="size-3.5" />} onClick={() => { setPendingDelete(detailRecord); setDetailRecord(null); }}>Delete ${singular}</Button>` : ''}
        </Dialog>
      )}

      ${write ? `{dialogRecord && (
        <Dialog
          open={Boolean(dialogRecord)}
          onClose={() => { setDialogRecord(null); }}
          title={dialogRecord === 'new' ? 'New ${singular}' : 'Edit ${singular}'}
        >
          <${singular}Form
            initialValues={dialogRecord === 'new' ? undefined : (dialogRecord as unknown as Partial<Create${singular}FormValues>)}
            onSubmit={handleSubmit}
            onCancel={() => { setDialogRecord(null); }}
            submitting={${[create ? 'createMutation.isPending' : '', update ? 'updateMutation.isPending' : ''].filter(Boolean).join(' || ')}}
          />
        </Dialog>
      )}` : ''}

      ${remove ? `<ConfirmDialog
        open={pendingDelete !== null}
        title="Delete ${singular.toLowerCase()}"
        description="This action cannot be undone."
        confirmLabel="Delete"
        destructive
        onCancel={() => { setPendingDelete(null); }}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />` : ''}
    </>
  );
}
`;
}

function pendingPage(page: PageModel): string {
  return `import { Construction } from 'lucide-react';

import { PageHeader } from '@/shared/components/page-header';
import { EmptyState } from '@/shared/components/ui/empty-state';

/**
 * The backend-manifest marks this module as not yet implemented — the page
 * exists so navigation and routing are complete, but no table or form is
 * wired against endpoints that don't exist yet.
 */
export function ${page.name}Page() {
  return (
    <>
      <PageHeader title="${page.navLabel}" description="This module is not implemented yet." />
      <EmptyState
        icon={<Construction className="size-4" />}
        title="Backend not implemented yet"
        description="The ${page.navLabel} API hasn't been generated. Once it is, this page will show live data automatically."
      />
    </>
  );
}
`;
}

export function emitEntityPages(pages: PageModel[]): GeneratedFile[] {
  return pages.map((page) =>
    file(
      `src/features/${page.slug}/${page.name}Page.tsx`,
      'typescriptreact',
      page.implemented ? implementedPage(page) : pendingPage(page),
    ),
  );
}

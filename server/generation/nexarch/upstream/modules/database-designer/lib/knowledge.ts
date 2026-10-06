/**
 * Database-design knowledge base.
 *
 * The column inference table encodes what an experienced DBA reads from a
 * field name: `price` is money, `email` is a unique indexed string, `*_at`
 * is a timestamp. Rules are matched in order (first hit wins) against the
 * snake_case column name. Adding domain vocabulary is a data change here,
 * never a code change in the designer.
 */

import type { DatabaseScalarKind } from '../../../shared/types/design.ts';

export interface ColumnTypeSpec {
  kind: DatabaseScalarKind;
  /** Semantic format for validation/OpenAPI, e.g. `email`, `uuid`, `date-time`. */
  format?: string;
  /** Non-negative numeric guard (money, quantities). */
  nonNegative?: boolean;
}

export interface InferenceRule {
  /** Matches the whole column name. */
  match: (column: string) => boolean;
  spec: ColumnTypeSpec;
}

const exact =
  (...names: string[]) =>
  (column: string): boolean =>
    names.includes(column);
const suffix =
  (...suffixes: string[]) =>
  (column: string): boolean =>
    suffixes.some((s) => column.endsWith(s));
const contains =
  (...tokens: string[]) =>
  (column: string): boolean =>
    tokens.some((t) => column === t || column.includes(t));

/** Ordered inference rules. `*_id` foreign keys are handled by the relationship
 * engine before inference runs, so no FK rule is needed here. */
export const INFERENCE_RULES: readonly InferenceRule[] = [
  {
    match: exact('email'),
    spec: {
      kind: 'string320',
      format: 'email',
    },
  },
  {
    match: exact('password_hash', 'password'),
    spec: { kind: 'string255' },
  },
  {
    match: exact('slug'),
    spec: {
      kind: 'string191',
      format: 'slug',
    },
  },
  {
    match: contains('phone', 'mobile', 'whatsapp'),
    spec: {
      kind: 'string32',
      format: 'phone',
    },
  },
  {
    match: contains(
      'price',
      'amount',
      'total',
      'balance',
      'cost',
      'salary',
      'fee',
      'fare',
      'rate',
      'subtotal',
      'tax',
      'wage',
      'budget',
    ),
    spec: {
      kind: 'decimal12_2',
      nonNegative: true,
    },
  },
  {
    match: contains(
      'quantity',
      'qty',
      'stock',
      'count',
      'capacity',
      'duration',
      'age',
      'score',
      'marks',
      'points',
      'reorder_level',
      'threshold',
    ),
    spec: { kind: 'integer', nonNegative: true },
  },
  {
    match: (c) => c.startsWith('is_') || c.startsWith('has_'),
    spec: { kind: 'boolean' },
  },
  {
    match: exact(
      'active',
      'available',
      'published',
      'verified',
      'enabled',
      'paid',
      'completed',
      'featured',
      'archived',
    ),
    spec: { kind: 'boolean' },
  },
  {
    match: exact(
      'check_in',
      'check_out',
      'scheduled_at',
      'published_at',
      'sent_at',
      'read_at',
      'started_at',
      'completed_at',
      'expires_at',
      'verified_at',
    ),
    spec: { kind: 'timestamp' },
  },
  { match: suffix('_at'), spec: { kind: 'timestamp' } },
  {
    match: exact(
      'dob',
      'birth_date',
      'date_of_birth',
      'start_date',
      'end_date',
      'due_date',
      'issue_date',
      'joining_date',
    ),
    spec: { kind: 'date', format: 'date' },
  },
  {
    match: suffix('_date'),
    spec: { kind: 'date', format: 'date' },
  },
  {
    match: contains(
      'description',
      'body',
      'content',
      'notes',
      'note',
      'address',
      'bio',
      'message',
      'remarks',
      'comment',
      'summary',
      'about',
    ),
    spec: { kind: 'text' },
  },
  {
    match: contains(
      'sku',
      'barcode',
      'isbn',
      'employee_no',
      'account_no',
      'invoice_no',
      'reference',
      'provider_ref',
      'transaction_ref',
    ),
    spec: { kind: 'string64' },
  },
  {
    match: exact('number', 'no', 'code', 'ref'),
    spec: { kind: 'string64' },
  },
  {
    match: contains(
      'url',
      'link',
      'image',
      'photo',
      'avatar',
      'thumbnail',
      'file',
      'attachment',
      'document',
    ),
    spec: {
      kind: 'string512',
      format: 'uri',
    },
  },
  {
    match: contains('metadata', 'settings', 'preferences', 'config', 'payload', 'options'),
    spec: { kind: 'json' },
  },
  {
    match: contains('name', 'title', 'subject', 'label', 'designation'),
    spec: { kind: 'string255' },
  },
];

/** Fallback when nothing matches. */
export const DEFAULT_COLUMN_SPEC: ColumnTypeSpec = {
  kind: 'string255',
};

/** Column names that carry an enumerable state — always emitted as enums. */
export const ENUM_COLUMNS: ReadonlySet<string> = new Set([
  'status',
  'state',
  'type',
  'role',
  'category',
  'gender',
  'mode',
  'method',
  'priority',
  'payment_status',
]);

/**
 * Known enum value sets, keyed by `Entity.column` first, then bare `column`.
 * Anything not found falls back to a generic ACTIVE/INACTIVE lifecycle.
 */
export const ENUM_VALUES: Readonly<Record<string, string[]>> = {
  'Orders.status': [
    'PENDING',
    'CONFIRMED',
    'PAID',
    'SHIPPED',
    'DELIVERED',
    'CANCELLED',
    'REFUNDED',
  ],
  'Payments.status': ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'REFUNDED'],
  'Invoices.status': ['DRAFT', 'ISSUED', 'PAID', 'OVERDUE', 'VOID'],
  'Appointments.status': ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'],
  'Bookings.status': ['PENDING', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED'],
  'Transactions.type': ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'PAYMENT', 'REFUND'],
  'Loans.status': ['APPLIED', 'APPROVED', 'DISBURSED', 'CLOSED', 'REJECTED'],
  'Leaves.status': ['REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'],
  'Tickets.status': ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  'Tasks.status': ['TODO', 'IN_PROGRESS', 'DONE', 'BLOCKED'],
  'Deals.status': ['NEW', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'],
  'Leads.status': ['NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'LOST'],
  gender: ['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED'],
  priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
  status: ['ACTIVE', 'INACTIVE'],
  type: ['STANDARD', 'PREMIUM'],
  method: ['CARD', 'CASH', 'UPI', 'BANK_TRANSFER', 'WALLET'],
  mode: ['ONLINE', 'OFFLINE'],
};

/** Reference/lookup tables that are read far more than written. */
export const CACHE_CANDIDATE_ENTITIES: ReadonlySet<string> = new Set([
  'Products',
  'Categories',
  'MenuItems',
  'Rooms',
  'RoomTypes',
  'Courses',
  'Departments',
  'Classes',
  'Subjects',
  'Suppliers',
]);

/** High-volume append-mostly tables worth range-partitioning by time. */
export const PARTITION_CANDIDATE_ENTITIES: ReadonlySet<string> = new Set([
  'Transactions',
  'Messages',
  'Orders',
  'StockMovements',
  'AttendanceRecords',
  'Notifications',
  'Activities',
  'Submissions',
]);

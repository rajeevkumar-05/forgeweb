/**
 * The feature lexicon: canonical requirement labels and the natural-language
 * phrases users write for them. Extraction never hardcodes phrases — every
 * synonym lives here, so teaching the analyzer new vocabulary is a data
 * change, not a code change.
 */

export interface LexiconEntry {
  readonly label: string;
  readonly phrases: readonly string[];
}

export interface ModuleLexiconEntry extends LexiconEntry {
  /** Database entities this module implies. */
  readonly entities: readonly string[];
}

/* ── Authentication ──────────────────────────────────────────────────── */

/** Generic signals that authentication is wanted, without naming a method. */
export const AUTH_GENERIC_PHRASES: readonly string[] = [
  'authentication',
  'auth',
  'login',
  'log in',
  'sign in',
  'signup',
  'sign up',
  'register',
  'user accounts',
];

export const AUTH_LEXICON: readonly LexiconEntry[] = [
  { label: 'JWT', phrases: ['jwt', 'json web token', 'token based', 'token authentication'] },
  { label: 'OAuth', phrases: ['oauth', 'social login', 'github login', 'facebook login'] },
  {
    label: 'Google Login',
    phrases: ['google login', 'google sign in', 'sign in with google', 'google auth'],
  },
  {
    label: 'Email Login',
    phrases: ['email login', 'email and password', 'email password', 'login with email'],
  },
  {
    label: 'OTP',
    phrases: ['otp', 'one time password', 'phone verification', 'two factor', '2fa', 'mfa'],
  },
  { label: 'Forgot Password', phrases: ['forgot password', 'password reset', 'reset password'] },
  {
    label: 'RBAC',
    phrases: ['rbac', 'role based', 'roles and permissions', 'access control', 'permissions'],
  },
];

/* ── Integrations & cross-cutting features ───────────────────────────── */

export const INTEGRATION_LEXICON: readonly LexiconEntry[] = [
  {
    label: 'Payment Gateway',
    phrases: ['payment', 'payments', 'stripe', 'razorpay', 'paypal', 'checkout', 'pay', 'pay online', 'invoice', 'invoices'],
  },
  {
    label: 'Email',
    phrases: [
      'email notification',
      'email notifications',
      'send email',
      'send emails',
      'transactional email',
      'email integration',
      'newsletter',
      'smtp',
      'sendgrid',
      'mailgun',
    ],
  },
  { label: 'SMS', phrases: ['sms', 'twilio', 'text message', 'text messages'] },
  {
    label: 'Notifications',
    phrases: [
      'notification',
      'notifications',
      'push notification',
      'alerts',
      'reminders',
      'reminder',
    ],
  },
  {
    label: 'Real-time (Socket.io)',
    phrases: [
      'real time',
      'real-time',
      'realtime',
      'live updates',
      'websocket',
      'websockets',
      'socket',
      'live chat',
      'live tracking',
    ],
  },
  {
    label: 'File Upload',
    phrases: [
      'file upload',
      'file uploads',
      'upload files',
      'upload images',
      'image upload',
      'attachments',
      'file sharing',
      'media sharing',
    ],
  },
  {
    label: 'Cloud Storage',
    phrases: ['cloud storage', 's3', 'aws s3', 'cloudinary', 'firebase storage'],
  },
  { label: 'PDF Export', phrases: ['pdf', 'export pdf', 'download invoice', 'printable'] },
  {
    label: 'Excel Export',
    phrases: ['excel', 'csv', 'export excel', 'spreadsheet', 'export data'],
  },
  {
    label: 'AI Features',
    phrases: [
      'ai',
      'artificial intelligence',
      'machine learning',
      'recommendation',
      'recommendations',
      'chatbot',
      'llm',
      'smart suggestions',
    ],
  },
];

/* ── Backend capabilities ────────────────────────────────────────────── */

export const BACKEND_LEXICON: readonly LexiconEntry[] = [
  { label: 'CRUD APIs', phrases: ['crud', 'manage', 'management', 'admin panel'] },
  { label: 'Search', phrases: ['search', 'searching'] },
  { label: 'Filtering', phrases: ['filter', 'filters', 'filtering', 'sorting', 'sort'] },
  { label: 'Pagination', phrases: ['pagination', 'paginated', 'infinite scroll'] },
  { label: 'Reports API', phrases: ['report', 'reports', 'reporting'] },
];

/* ── Frontend surfaces ───────────────────────────────────────────────── */

export const FRONTEND_LEXICON: readonly LexiconEntry[] = [
  { label: 'Dashboard', phrases: ['dashboard', 'dashboards', 'admin panel'] },
  { label: 'Landing Page', phrases: ['landing page', 'home page', 'homepage', 'marketing site'] },
  { label: 'Charts', phrases: ['chart', 'charts', 'graph', 'graphs', 'analytics', 'statistics'] },
  { label: 'Forms', phrases: ['form', 'forms'] },
];

/* ── User roles ──────────────────────────────────────────────────────── */

export const ROLE_LEXICON: readonly LexiconEntry[] = [
  { label: 'Admin', phrases: ['admin', 'administrator', 'super admin'] },
  { label: 'User', phrases: ['user', 'users'] },
  { label: 'Manager', phrases: ['manager', 'managers'] },
  { label: 'Employee', phrases: ['employee', 'employees', 'staff'] },
  { label: 'Customer', phrases: ['customer', 'customers', 'client', 'clients', 'buyer', 'buyers'] },
  { label: 'Vendor', phrases: ['vendor', 'vendors', 'seller', 'sellers', 'merchant', 'merchants'] },
  { label: 'Doctor', phrases: ['doctor', 'doctors', 'physician', 'physicians'] },
  { label: 'Patient', phrases: ['patient', 'patients'] },
  { label: 'Nurse', phrases: ['nurse', 'nurses'] },
  { label: 'Receptionist', phrases: ['receptionist', 'front desk'] },
  { label: 'Teacher', phrases: ['teacher', 'teachers', 'instructor', 'instructors', 'faculty'] },
  { label: 'Student', phrases: ['student', 'students', 'learner', 'learners'] },
  { label: 'Parent', phrases: ['parent', 'parents', 'guardian'] },
  { label: 'Guest', phrases: ['guest', 'guests', 'visitor', 'visitors'] },
  { label: 'HR Manager', phrases: ['hr', 'human resources', 'recruiter'] },
  { label: 'Accountant', phrases: ['accountant', 'accounts team'] },
  {
    label: 'Delivery Agent',
    phrases: ['delivery agent', 'delivery boy', 'courier', 'driver', 'rider'],
  },
  { label: 'Waiter', phrases: ['waiter', 'waiters', 'server staff'] },
  { label: 'Kitchen Staff', phrases: ['kitchen staff', 'chef', 'chefs', 'cook'] },
  {
    label: 'Sales Rep',
    phrases: ['sales rep', 'sales representative', 'salesperson', 'sales team'],
  },
];

/* ── Modules users name explicitly ───────────────────────────────────── */

export const MODULE_LEXICON: readonly ModuleLexiconEntry[] = [
  { label: 'Dashboard', phrases: ['dashboard', 'admin dashboard', 'admin panel'], entities: [] },
  { label: 'Recipes', phrases: ['recipe', 'recipes', 'cookbook'], entities: ['Recipes'] },
  { label: 'Categories', phrases: ['category', 'categories', 'cuisine', 'cuisines'], entities: ['Categories'] },
  { label: 'Students', phrases: ['student', 'students'], entities: ['Students'] },
  { label: 'Classes', phrases: ['class', 'classes', 'classroom', 'classrooms'], entities: ['Classes'] },
  {
    label: 'Users',
    phrases: ['user management', 'users module', 'manage users'],
    entities: ['Users'],
  },
  {
    label: 'Products',
    phrases: ['product', 'products', 'product management', 'catalog', 'catalogue'],
    entities: ['Products', 'Categories'],
  },
  {
    label: 'Orders',
    phrases: ['order', 'orders', 'order tracking', 'order management'],
    entities: ['Orders', 'OrderItems'],
  },
  {
    label: 'Cart',
    phrases: ['cart', 'shopping cart', 'wishlist'],
    entities: ['Carts', 'CartItems'],
  },
  {
    label: 'Payments',
    phrases: ['payment', 'payments', 'billing', 'invoicing', 'invoice', 'invoices', 'pay'],
    entities: ['Payments', 'Invoices'],
  },
  { label: 'Reports', phrases: ['report', 'reports', 'reporting'], entities: [] },
  {
    label: 'Notifications',
    phrases: ['notification', 'notifications', 'alerts'],
    entities: ['Notifications'],
  },
  { label: 'Settings', phrases: ['settings', 'preferences'], entities: [] },
  { label: 'Analytics', phrases: ['analytics', 'statistics', 'insights'], entities: [] },
  {
    label: 'Appointments',
    phrases: ['appointment', 'appointments', 'appointment booking'],
    entities: ['Appointments'],
  },
  {
    label: 'Prescriptions',
    phrases: ['prescription', 'prescriptions'],
    entities: ['Prescriptions'],
  },
  {
    label: 'Attendance',
    phrases: ['attendance'],
    entities: ['AttendanceRecords'],
  },
  {
    label: 'Exams',
    phrases: ['exam', 'exams', 'grades', 'results', 'marks'],
    entities: ['Exams', 'Grades'],
  },
  {
    label: 'Courses',
    phrases: ['course', 'courses', 'lessons', 'curriculum'],
    entities: ['Courses', 'Lessons'],
  },
  {
    label: 'Enrollments',
    phrases: ['enrollment', 'enrollments', 'enroll'],
    entities: ['Enrollments'],
  },
  {
    label: 'Leads',
    phrases: ['lead', 'leads', 'lead management'],
    entities: ['Leads'],
  },
  {
    label: 'Deals',
    phrases: ['deal', 'deals', 'pipeline', 'opportunities'],
    entities: ['Deals'],
  },
  {
    label: 'Contacts',
    phrases: ['contact management', 'contacts'],
    entities: ['Contacts'],
  },
  {
    label: 'Tasks',
    phrases: ['task', 'tasks', 'todo', 'to-do'],
    entities: ['Tasks'],
  },
  {
    label: 'Inventory',
    phrases: ['inventory', 'stock', 'stock management', 'warehouse'],
    entities: ['StockItems', 'StockMovements'],
  },
  {
    label: 'Suppliers',
    phrases: ['supplier', 'suppliers', 'purchase orders', 'procurement'],
    entities: ['Suppliers', 'PurchaseOrders'],
  },
  {
    label: 'Bookings',
    phrases: ['booking', 'bookings', 'reservation', 'reservations'],
    entities: ['Bookings'],
  },
  {
    label: 'Rooms',
    phrases: ['room', 'rooms', 'room management'],
    entities: ['Rooms', 'RoomTypes'],
  },
  {
    label: 'Menu',
    phrases: ['menu', 'menu management', 'dishes'],
    entities: ['MenuItems'],
  },
  {
    label: 'Tables',
    phrases: ['table booking', 'table management', 'dine in'],
    entities: ['Tables'],
  },
  {
    label: 'Payroll',
    phrases: ['payroll', 'salary', 'salaries', 'payslip'],
    entities: ['Payslips'],
  },
  {
    label: 'Leave Management',
    phrases: ['leave', 'leaves', 'leave management', 'time off'],
    entities: ['Leaves'],
  },
  {
    label: 'Recruitment',
    phrases: ['recruitment', 'hiring', 'job postings', 'candidates'],
    entities: ['JobPostings', 'Candidates'],
  },
  {
    label: 'Accounts',
    phrases: ['bank account', 'bank accounts', 'account balance'],
    entities: ['Accounts'],
  },
  {
    label: 'Transactions',
    phrases: ['transaction', 'transactions', 'transfers', 'transfer money'],
    entities: ['Transactions'],
  },
  {
    label: 'Loans',
    phrases: ['loan', 'loans', 'emi'],
    entities: ['Loans'],
  },
  {
    label: 'Chat',
    phrases: ['chat', 'chats', 'messaging', 'messages', 'direct messages'],
    entities: ['Conversations', 'Messages'],
  },
  {
    label: 'Posts',
    phrases: ['post', 'posts', 'articles', 'blog posts'],
    entities: ['Posts', 'Comments'],
  },
  {
    label: 'Reviews',
    phrases: ['review', 'reviews', 'ratings'],
    entities: ['Reviews'],
  },
  {
    label: 'Tickets',
    phrases: ['ticket', 'tickets', 'support tickets', 'helpdesk'],
    entities: ['Tickets'],
  },
];

export const OPERATION_LEXICON: readonly LexiconEntry[] = [
  { label: 'create', phrases: ['create', 'add'] },
  { label: 'edit', phrases: ['edit', 'editable', 'update', 'modify'] },
  { label: 'delete', phrases: ['delete', 'remove'] },
  { label: 'view', phrases: ['view', 'list', 'browse'] },
  { label: 'assign', phrases: ['assign', 'assignment'] },
  { label: 'track', phrases: ['track', 'tracking'] },
  { label: 'search', phrases: ['search', 'searching'] },
  { label: 'categorize', phrases: ['categorize', 'categorise'] },
  { label: 'record', phrases: ['mark', 'record'] },
];

export interface FieldLexiconEntry extends LexiconEntry {
  readonly modules: readonly string[];
}

export const FIELD_LEXICON: readonly FieldLexiconEntry[] = [
  { label: 'name', phrases: ['name', 'names'], modules: ['Recipes', 'Tasks', 'Classes'] },
  { label: 'description', phrases: ['description', 'descriptions'], modules: ['Recipes', 'Tasks'] },
  { label: 'ingredients', phrases: ['ingredient', 'ingredients'], modules: ['Recipes'] },
  { label: 'preparation steps', phrases: ['preparation steps', 'cooking steps', 'instructions', 'preparation instructions'], modules: ['Recipes'] },
  { label: 'cooking time', phrases: ['cooking time', 'cooking duration', 'preparation time'], modules: ['Recipes'] },
  { label: 'difficulty', phrases: ['difficulty', 'difficulty level'], modules: ['Recipes'] },
  { label: 'category', phrases: ['category', 'categories'], modules: ['Recipes'] },
  { label: 'cuisine', phrases: ['cuisine', 'cuisines'], modules: ['Recipes'] },
  { label: 'status', phrases: ['status', 'task status', 'attendance status', 'completed', 'completion'], modules: ['Tasks', 'Attendance'] },
  { label: 'due date', phrases: ['due date', 'due dates', 'deadline', 'deadlines'], modules: ['Tasks'] },
  { label: 'priority', phrases: ['priority', 'priorities'], modules: ['Tasks'] },
];

/** Excluding a capability also excludes its domain-default surfaces and data. */
export const EXCLUSION_LINKS = [
  { kind: 'module', label: 'Payments', modules: ['Payments', 'Billing', 'Fees'], entities: ['Payments', 'Invoices', 'FeePayments'], integrations: ['Payment Gateway'] },
  { kind: 'integration', label: 'Payment Gateway', modules: ['Payments', 'Billing', 'Fees'], entities: ['Payments', 'Invoices', 'FeePayments'], integrations: ['Payment Gateway'] },
] as const;

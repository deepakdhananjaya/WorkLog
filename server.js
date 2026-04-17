const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { OAuth2Client } = require("google-auth-library");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "invoiceflow.sqlite");
const BUSINESS_PROFILE_PATH = path.join(__dirname, "business-profile.json");
const SESSION_COOKIE = "invoiceflow_session";
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const BUSINESS_PROFILE = JSON.parse(fs.readFileSync(BUSINESS_PROFILE_PATH, "utf8"));
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    client_type TEXT NOT NULL DEFAULT 'therapy',
    default_therapy_fee REAL NOT NULL DEFAULT 0,
    default_supervision_fee REAL NOT NULL DEFAULT 0,
    address TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    pincode TEXT NOT NULL DEFAULT '',
    gstin TEXT NOT NULL DEFAULT '',
    pan TEXT NOT NULL DEFAULT '',
    next_invoice_sequence INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    invoice_number TEXT NOT NULL UNIQUE,
    invoice_kind TEXT NOT NULL DEFAULT 'manual',
    billing_month TEXT NOT NULL DEFAULT '',
    issue_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    item_name TEXT NOT NULL DEFAULT '',
    hsn_sac TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1,
    rate REAL NOT NULL DEFAULT 0,
    gst_rate REAL NOT NULL DEFAULT 18,
    country_of_supply TEXT NOT NULL DEFAULT 'India',
    place_of_supply TEXT NOT NULL DEFAULT '',
    supply_type TEXT NOT NULL DEFAULT 'intra',
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL,
    amount REAL NOT NULL,
    payment_date TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS invoice_share_links (
    id TEXT PRIMARY KEY,
    invoice_id TEXT NOT NULL UNIQUE,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS session_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    session_type TEXT NOT NULL,
    session_date TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 50,
    fee_amount REAL NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    invoice_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
  );
`);

migrateToMultiUserSchema();
ensureColumnExists("clients", "user_id", "TEXT");
ensureColumnExists("invoices", "user_id", "TEXT");
ensureColumnExists("session_logs", "user_id", "TEXT");
ensureColumnExists("users", "google_sub", "TEXT");
ensureColumnExists("users", "display_name", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("clients", "client_type", "TEXT NOT NULL DEFAULT 'therapy'");
ensureColumnExists("clients", "default_therapy_fee", "REAL NOT NULL DEFAULT 0");
ensureColumnExists("clients", "default_supervision_fee", "REAL NOT NULL DEFAULT 0");
ensureColumnExists("clients", "address", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("clients", "city", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("clients", "state", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("clients", "pincode", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("clients", "gstin", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("clients", "pan", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("invoices", "item_name", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("invoices", "hsn_sac", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("invoices", "quantity", "REAL NOT NULL DEFAULT 1");
ensureColumnExists("invoices", "rate", "REAL NOT NULL DEFAULT 0");
ensureColumnExists("invoices", "gst_rate", "REAL NOT NULL DEFAULT 18");
ensureColumnExists("invoices", "country_of_supply", "TEXT NOT NULL DEFAULT 'India'");
ensureColumnExists("invoices", "place_of_supply", "TEXT NOT NULL DEFAULT ''");
ensureColumnExists("invoices", "supply_type", "TEXT NOT NULL DEFAULT 'intra'");
ensureColumnExists("invoices", "invoice_kind", "TEXT NOT NULL DEFAULT 'manual'");
ensureColumnExists("invoices", "billing_month", "TEXT NOT NULL DEFAULT ''");

backfillOwnership();

const statements = {
  userCount: db.prepare("SELECT COUNT(*) AS count FROM users"),
  createUser: db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)"),
  createGoogleUser: db.prepare("INSERT INTO users (id, email, password_hash, google_sub, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  getUserByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  getUserByGoogleSub: db.prepare("SELECT * FROM users WHERE google_sub = ?"),
  linkGoogleIdentity: db.prepare("UPDATE users SET google_sub = ?, display_name = ? WHERE id = ?"),
  getUsers: db.prepare("SELECT id, email, created_at FROM users ORDER BY created_at ASC"),
  createSession: db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"),
  getSessionUser: db.prepare(`
    SELECT sessions.id AS session_id, sessions.expires_at, users.id AS user_id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `),
  deleteSession: db.prepare("DELETE FROM sessions WHERE id = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  createClient: db.prepare(`
    INSERT INTO clients (
      id, user_id, name, code, client_type, default_therapy_fee, default_supervision_fee,
      address, city, state, pincode, gstin, pan, next_invoice_sequence, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getClients: db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY created_at DESC"),
  getClientById: db.prepare("SELECT * FROM clients WHERE id = ? AND user_id = ?"),
  getClientByCode: db.prepare("SELECT * FROM clients WHERE code = ? AND user_id = ?"),
  updateClientSequence: db.prepare("UPDATE clients SET next_invoice_sequence = ? WHERE id = ? AND user_id = ?"),
  getSessionById: db.prepare(`
    SELECT session_logs.*, clients.name AS client_name, clients.code AS client_code
    FROM session_logs
    JOIN clients ON clients.id = session_logs.client_id
    WHERE session_logs.id = ? AND session_logs.user_id = ?
  `),
  createInvoice: db.prepare(`
    INSERT INTO invoices (
      id, user_id, client_id, invoice_number, invoice_kind, billing_month, issue_date, due_date, amount, description, item_name,
      hsn_sac, quantity, rate, gst_rate, country_of_supply, place_of_supply, supply_type, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getInvoiceById: db.prepare(`
    SELECT invoices.*, clients.name AS client_name, clients.code AS client_code,
      clients.address, clients.city, clients.state, clients.pincode, clients.gstin, clients.pan
    FROM invoices
    JOIN clients ON clients.id = invoices.client_id
    WHERE invoices.id = ? AND invoices.user_id = ?
  `),
  getInvoicesWithBalances: db.prepare(`
    SELECT
      invoices.*,
      clients.name AS client_name,
      clients.code AS client_code,
      clients.address,
      clients.city,
      clients.state,
      clients.pincode,
      clients.gstin,
      clients.pan,
      COALESCE(SUM(payments.amount), 0) AS paid_amount,
      invoices.amount - COALESCE(SUM(payments.amount), 0) AS balance
    FROM invoices
    JOIN clients ON clients.id = invoices.client_id
    LEFT JOIN payments ON payments.invoice_id = invoices.id
    WHERE invoices.user_id = ?
    GROUP BY invoices.id
    ORDER BY invoices.created_at DESC
  `),
  getPendingInvoices: db.prepare(`
    SELECT
      invoices.*,
      clients.name AS client_name,
      clients.address,
      clients.city,
      clients.state,
      clients.pincode,
      clients.gstin,
      clients.pan,
      COALESCE(SUM(payments.amount), 0) AS paid_amount,
      invoices.amount - COALESCE(SUM(payments.amount), 0) AS balance
    FROM invoices
    JOIN clients ON clients.id = invoices.client_id
    LEFT JOIN payments ON payments.invoice_id = invoices.id
    WHERE invoices.user_id = ?
    GROUP BY invoices.id
    HAVING balance > 0.001
    ORDER BY invoices.due_date ASC
  `),
  getInvoicePayments: db.prepare(`
    SELECT *
    FROM payments
    WHERE invoice_id = ?
    ORDER BY payment_date DESC, created_at DESC
  `),
  createPayment: db.prepare(`
    INSERT INTO payments (id, invoice_id, amount, payment_date, method, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getOwnedPaymentById: db.prepare(`
    SELECT payments.*, invoices.user_id, invoices.invoice_number
    FROM payments
    JOIN invoices ON invoices.id = payments.invoice_id
    WHERE payments.id = ? AND invoices.user_id = ?
  `),
  deletePaymentById: db.prepare("DELETE FROM payments WHERE id = ?"),
  createSessionLog: db.prepare(`
    INSERT INTO session_logs (
      id, user_id, client_id, session_type, session_date, duration_minutes, fee_amount, notes, invoice_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  attachSessionsToInvoice: db.prepare("UPDATE session_logs SET invoice_id = ? WHERE id = ?"),
  updateSessionLog: db.prepare(`
    UPDATE session_logs
    SET client_id = ?, session_type = ?, session_date = ?, duration_minutes = ?, fee_amount = ?, notes = ?
    WHERE id = ? AND user_id = ?
  `),
  getRecentSessionLogs: db.prepare(`
    SELECT session_logs.*, clients.name AS client_name, clients.code AS client_code
    FROM session_logs
    JOIN clients ON clients.id = session_logs.client_id
    WHERE session_logs.user_id = ?
    ORDER BY session_date DESC, session_logs.created_at DESC
    LIMIT 12
  `),
  deleteSessionLog: db.prepare("DELETE FROM session_logs WHERE id = ? AND user_id = ? AND invoice_id IS NULL"),
  getSessionLogsForInvoice: db.prepare(`
    SELECT session_logs.*, clients.name AS client_name
    FROM session_logs
    JOIN clients ON clients.id = session_logs.client_id
    WHERE session_logs.invoice_id = ?
    ORDER BY session_date ASC, session_logs.created_at ASC
  `),
  getUninvoicedSessionsForMonth: db.prepare(`
    SELECT *
    FROM session_logs
    WHERE client_id = ?
      AND user_id = ?
      AND invoice_id IS NULL
      AND substr(session_date, 1, 7) = ?
    ORDER BY session_date ASC, created_at ASC
  `),
  getMonthlyMetrics: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_logs WHERE user_id = ? AND substr(session_date, 1, 7) = ?) AS session_count,
      (SELECT ROUND(COALESCE(SUM(fee_amount), 0), 2) FROM session_logs WHERE user_id = ? AND substr(session_date, 1, 7) = ?) AS billed_from_sessions,
      (SELECT ROUND(COALESCE(SUM(payments.amount), 0), 2)
        FROM payments
        JOIN invoices ON invoices.id = payments.invoice_id
        WHERE invoices.user_id = ? AND substr(payment_date, 1, 7) = ?) AS collected_from_payments,
      (SELECT ROUND(COALESCE(SUM(invoices.amount - COALESCE(payment_totals.paid_amount, 0)), 0), 2)
        FROM invoices
        LEFT JOIN (
          SELECT invoice_id, ROUND(SUM(amount), 2) AS paid_amount
          FROM payments
          GROUP BY invoice_id
        ) AS payment_totals ON payment_totals.invoice_id = invoices.id
        WHERE invoices.user_id = ? AND substr(invoices.issue_date, 1, 7) = ?
      ) AS pending_for_month
  `),
  getClientMonthReport: db.prepare(`
    SELECT
      clients.id AS client_id,
      clients.name AS client_name,
      (SELECT COUNT(*) FROM session_logs WHERE session_logs.client_id = clients.id AND session_logs.user_id = clients.user_id AND substr(session_logs.session_date, 1, 7) = ?) AS session_count,
      (SELECT COUNT(*) FROM invoices WHERE invoices.client_id = clients.id AND invoices.user_id = clients.user_id) AS invoice_count,
      (SELECT ROUND(COALESCE(SUM(invoices.amount), 0), 2) FROM invoices WHERE invoices.client_id = clients.id AND invoices.user_id = clients.user_id AND substr(invoices.issue_date, 1, 7) = ?) AS invoiced_total,
      (SELECT ROUND(COALESCE(SUM(payments.amount), 0), 2)
        FROM payments
        JOIN invoices ON invoices.id = payments.invoice_id
        WHERE invoices.client_id = clients.id AND invoices.user_id = clients.user_id AND substr(payments.payment_date, 1, 7) = ?) AS collected_total,
      (SELECT ROUND(COALESCE(SUM(invoices.amount - COALESCE(payment_totals.paid_amount, 0)), 0), 2)
        FROM invoices
        LEFT JOIN (
          SELECT invoice_id, ROUND(SUM(amount), 2) AS paid_amount
          FROM payments
          GROUP BY invoice_id
        ) AS payment_totals ON payment_totals.invoice_id = invoices.id
        WHERE invoices.client_id = clients.id AND invoices.user_id = clients.user_id AND substr(invoices.issue_date, 1, 7) = ?) AS pending_total
    FROM clients
    WHERE clients.user_id = ?
    ORDER BY clients.name ASC
  `),
  getRecentPayments: db.prepare(`
    SELECT payments.*, invoices.invoice_number, clients.name AS client_name
    FROM payments
    JOIN invoices ON invoices.id = payments.invoice_id
    JOIN clients ON clients.id = invoices.client_id
    WHERE invoices.user_id = ?
    ORDER BY payments.payment_date DESC, payments.created_at DESC
    LIMIT 12
  `),
  getDashboardSummary: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM clients WHERE user_id = ?) AS client_count,
      (SELECT COUNT(*) FROM invoices WHERE user_id = ?) AS invoice_count,
      (SELECT COUNT(*) FROM (
        SELECT invoices.id
        FROM invoices
        LEFT JOIN payments ON payments.invoice_id = invoices.id
        WHERE invoices.user_id = ?
        GROUP BY invoices.id
        HAVING invoices.amount - COALESCE(SUM(payments.amount), 0) > 0.001
      )) AS pending_invoice_count,
      (SELECT COUNT(*) FROM (
        SELECT invoices.id
        FROM invoices
        LEFT JOIN payments ON payments.invoice_id = invoices.id
        WHERE invoices.user_id = ?
        GROUP BY invoices.id
        HAVING invoices.amount - COALESCE(SUM(payments.amount), 0) > 0.001
          AND invoices.due_date < date('now')
      )) AS overdue_invoice_count,
      (SELECT ROUND(COALESCE(SUM(payments.amount), 0), 2)
        FROM payments
        JOIN invoices ON invoices.id = payments.invoice_id
        WHERE invoices.user_id = ?) AS total_collected,
      (SELECT ROUND(COALESCE(SUM(balance), 0), 2) FROM (
        SELECT invoices.amount - COALESCE(SUM(payments.amount), 0) AS balance
        FROM invoices
        LEFT JOIN payments ON payments.invoice_id = invoices.id
        WHERE invoices.user_id = ?
        GROUP BY invoices.id
      )) AS total_outstanding
  `),
  upsertShareLink: db.prepare(`
    INSERT INTO invoice_share_links (id, invoice_id, token, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(invoice_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at
  `),
  deleteShareLinkByInvoiceId: db.prepare("DELETE FROM invoice_share_links WHERE invoice_id = ?"),
  getClientDeleteSummary: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_logs WHERE client_id = ? AND user_id = ?) AS session_count,
      (SELECT COUNT(*) FROM invoices WHERE client_id = ? AND user_id = ?) AS invoice_count
  `),
  deleteClientById: db.prepare("DELETE FROM clients WHERE id = ? AND user_id = ?"),
  getInvoiceDeleteSummary: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM payments WHERE invoice_id = ?) AS payment_count,
      (SELECT COUNT(*) FROM session_logs WHERE invoice_id = ? AND user_id = ?) AS session_count
  `),
  detachSessionsFromInvoice: db.prepare("UPDATE session_logs SET invoice_id = NULL WHERE invoice_id = ? AND user_id = ?"),
  deleteInvoiceById: db.prepare("DELETE FROM invoices WHERE id = ? AND user_id = ?"),
  getShareLinkByInvoiceId: db.prepare("SELECT * FROM invoice_share_links WHERE invoice_id = ?"),
  getSharedInvoiceByToken: db.prepare(`
    SELECT
      invoices.*,
      clients.name AS client_name,
      clients.code AS client_code,
      clients.address,
      clients.city,
      clients.state,
      clients.pincode,
      clients.gstin,
      clients.pan,
      invoice_share_links.token,
      COALESCE(SUM(payments.amount), 0) AS paid_amount,
      invoices.amount - COALESCE(SUM(payments.amount), 0) AS balance
    FROM invoice_share_links
    JOIN invoices ON invoices.id = invoice_share_links.invoice_id
    JOIN clients ON clients.id = invoices.client_id
    LEFT JOIN payments ON payments.invoice_id = invoices.id
    WHERE invoice_share_links.token = ?
    GROUP BY invoices.id
  `)
};

cleanupExpiredSessions();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const method = req.method || "GET";
    const session = getSession(req);
    const user = session ? getSessionUser(session) : null;
    const flash = getFlash(req);

    if (url.pathname.startsWith("/public/")) {
      return serveStatic(url.pathname, res);
    }

    if (method === "GET" && url.pathname === "/health") {
      return sendText(res, 200, "ok");
    }

    if (method === "GET" && url.pathname === "/") {
      return redirect(res, shouldShowSetup() ? "/setup" : user ? "/dashboard" : "/login");
    }

    if (method === "GET" && url.pathname === "/setup") {
      if (!shouldShowSetup()) {
        return redirect(res, "/login");
      }

      const baseUrl = getBaseUrl(req, url);
      return sendHtml(res, 200, renderAuthPage({
        title: "Create Admin Account",
        action: "/setup",
        submitLabel: "Create Account",
        message: "Set up the first login for your invoice platform.",
        flash,
        googleAuthUrl: GOOGLE_CLIENT_ID ? `${baseUrl}/auth/google` : ""
      }));
    }

    if (method === "POST" && url.pathname === "/setup") {
      if (!shouldShowSetup()) {
        return redirect(res, "/login");
      }

      const form = await parseForm(req);
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");

      if (!email || !password || password.length < 8) {
        return redirectWithFlash(res, "/setup", "Use a valid email and a password with at least 8 characters.");
      }

      const now = isoNow();
      statements.createUser.run(randomId(), email, hashPassword(password), now);
      return redirectWithFlash(res, "/login", "Admin account created. Please sign in.");
    }

    if (method === "GET" && url.pathname === "/login") {
      if (shouldShowSetup()) {
        return redirect(res, "/setup");
      }

      if (user) {
        return redirect(res, "/dashboard");
      }

      const baseUrl = getBaseUrl(req, url);
      return sendHtml(res, 200, renderAuthPage({
        title: "Sign In",
        action: "/login",
        submitLabel: "Sign In",
        message: "Access your invoices, reports, and payment tracker.",
        flash,
        secondaryLink: { href: "/register", label: "Create a new account" },
        googleAuthUrl: GOOGLE_CLIENT_ID ? `${baseUrl}/auth/google` : ""
      }));
    }

    if (method === "GET" && url.pathname === "/register") {
      if (shouldShowSetup()) {
        return redirect(res, "/setup");
      }

      if (user) {
        return redirect(res, "/dashboard");
      }

      const baseUrl = getBaseUrl(req, url);
      return sendHtml(res, 200, renderAuthPage({
        title: "Create Account",
        action: "/register",
        submitLabel: "Create Account",
        message: "Create your own login to manage your own clients, sessions, invoices, and payments.",
        flash,
        secondaryLink: { href: "/login", label: "Back to sign in" },
        googleAuthUrl: GOOGLE_CLIENT_ID ? `${baseUrl}/auth/google` : ""
      }));
    }

    if (method === "POST" && url.pathname === "/register") {
      if (shouldShowSetup()) {
        return redirect(res, "/setup");
      }

      const form = await parseForm(req);
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");

      if (!email || !password || password.length < 8) {
        return redirectWithFlash(res, "/register", "Use a valid email and a password with at least 8 characters.");
      }

      if (statements.getUserByEmail.get(email)) {
        return redirectWithFlash(res, "/register", "An account with that email already exists.");
      }

      statements.createUser.run(randomId(), email, hashPassword(password), isoNow());
      return redirectWithFlash(res, "/login", "Account created. Please sign in.");
    }

    if (method === "POST" && url.pathname === "/users") {
      const form = await parseForm(req);
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");

      if (!email || !password || password.length < 8) {
        return redirectWithFlash(res, "/dashboard", "Use a valid email and a password with at least 8 characters.");
      }

      if (statements.getUserByEmail.get(email)) {
        return redirectWithFlash(res, "/dashboard", "An account with that email already exists.");
      }

      statements.createUser.run(randomId(), email, hashPassword(password), isoNow());
      return redirectWithFlash(res, "/dashboard", `Login created for ${email}.`);
    }

    if (method === "POST" && url.pathname === "/auth/google") {
      if (!googleClient) {
        return redirectWithFlash(res, shouldShowSetup() ? "/setup" : "/login", "Google sign-in is not configured yet.");
      }

      const form = await parseForm(req);
      const csrfCookie = parseCookies(req.headers.cookie || "").g_csrf_token;
      const csrfBody = String(form.g_csrf_token || "");
      const credential = String(form.credential || "");

      if (!csrfCookie || !csrfBody || csrfCookie !== csrfBody) {
        return redirectWithFlash(res, shouldShowSetup() ? "/setup" : "/login", "Google sign-in could not be verified. Please try again.");
      }

      if (!credential) {
        return redirectWithFlash(res, shouldShowSetup() ? "/setup" : "/login", "Google sign-in did not return a valid credential.");
      }

      let googleProfile;
      try {
        googleProfile = await verifyGoogleCredential(credential);
      } catch (error) {
        return redirectWithFlash(res, shouldShowSetup() ? "/setup" : "/login", "Google sign-in failed verification. Check your Google client setup and try again.");
      }

      if (!googleProfile.email || !googleProfile.emailVerified) {
        return redirectWithFlash(res, shouldShowSetup() ? "/setup" : "/login", "Your Google account email could not be verified.");
      }

      let foundUser = statements.getUserByGoogleSub.get(googleProfile.sub);

      if (!foundUser) {
        const existingUser = statements.getUserByEmail.get(googleProfile.email);

        if (existingUser && existingUser.google_sub && existingUser.google_sub !== googleProfile.sub) {
          return redirectWithFlash(res, "/login", "That email address is already linked to a different Google account.");
        }

        if (existingUser) {
          statements.linkGoogleIdentity.run(googleProfile.sub, googleProfile.name, existingUser.id);
          foundUser = {
            ...existingUser,
            google_sub: googleProfile.sub,
            display_name: googleProfile.name
          };
        } else {
          const userId = randomId();
          statements.createGoogleUser.run(
            userId,
            googleProfile.email,
            hashPassword(randomId()),
            googleProfile.sub,
            googleProfile.name,
            isoNow()
          );
          foundUser = statements.getUserByEmail.get(googleProfile.email);
        }
      }

      const sessionId = randomId();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
      statements.createSession.run(sessionId, foundUser.id, expiresAt, isoNow());

      res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7
      }));

      return redirect(res, "/dashboard");
    }

    if (method === "POST" && url.pathname === "/login") {
      const form = await parseForm(req);
      const email = String(form.email || "").trim().toLowerCase();
      const password = String(form.password || "");
      const foundUser = statements.getUserByEmail.get(email);

      if (!foundUser || !verifyPassword(password, foundUser.password_hash)) {
        return redirectWithFlash(res, "/login", "Incorrect email or password.");
      }

      const sessionId = randomId();
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();
      statements.createSession.run(sessionId, foundUser.id, expiresAt, isoNow());

      res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, sessionId, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7
      }));

      return redirect(res, "/dashboard");
    }

    if (method === "POST" && url.pathname === "/logout") {
      if (session) {
        statements.deleteSession.run(session);
      }

      res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 0
      }));

      return redirect(res, "/login");
    }

    if (method === "GET" && url.pathname === "/share") {
      return redirect(res, "/");
    }

    if (method === "GET" && url.pathname.startsWith("/share/")) {
      const token = url.pathname.split("/").pop();
      const invoice = statements.getSharedInvoiceByToken.get(token);

      if (!invoice) {
        return sendHtml(res, 404, renderInvoiceDocumentPage({ missing: true, isPublic: true }));
      }

      const payments = statements.getInvoicePayments.all(invoice.id);
      return sendHtml(res, 200, renderInvoiceDocumentPage({
        invoice: enrichInvoice(invoice),
        payments,
        isPublic: true
      }));
    }

    if (!user) {
      return redirect(res, shouldShowSetup() ? "/setup" : "/login");
    }

    if (method === "GET" && url.pathname === "/dashboard") {
      return sendHtml(res, 200, renderDashboard({
        flash,
        userId: user.id,
        userEmail: user.email,
        selectedMonth: normalizeMonth(url.searchParams.get("month")) || formatInputDate(new Date()).slice(0, 7),
        selectedInvoiceId: url.searchParams.get("invoiceId") || ""
      }));
    }

    if (method === "GET" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/edit")) {
      const sessionId = url.pathname.split("/")[2];
      const sessionLog = statements.getSessionById.get(sessionId, user.id);

      if (!sessionLog) {
        return redirectWithFlash(res, "/dashboard", "Session not found.");
      }

      return sendHtml(res, 200, renderSessionEditPage({
        flash,
        clients: statements.getClients.all(user.id),
        sessionLog
      }));
    }

    if (method === "GET" && url.pathname.startsWith("/invoices/") && url.pathname.endsWith("/view")) {
      const invoiceId = url.pathname.split("/")[2];
      const invoice = getInvoiceWithBalance(invoiceId, user.id);

      if (!invoice) {
        return sendText(res, 404, "Invoice not found.");
      }

      const payments = statements.getInvoicePayments.all(invoice.id);
      return sendHtml(res, 200, renderInvoiceDocumentPage({ invoice, payments, isPublic: false }));
    }

    if (method === "POST" && url.pathname === "/clients") {
      const form = await parseForm(req);
      const name = String(form.name || "").trim();
      const code = normalizeClientCode(form.code);
      const clientType = normalizeSessionType(form.clientType || "therapy");
      const defaultTherapyFee = Number(form.defaultTherapyFee || 0);
      const defaultSupervisionFee = Number(form.defaultSupervisionFee || 0);
      const address = String(form.address || "").trim();
      const city = String(form.city || "").trim();
      const stateName = String(form.state || "").trim();
      const pincode = String(form.pincode || "").trim();
      const gstin = String(form.gstin || "").trim().toUpperCase();
      const pan = String(form.pan || "").trim().toUpperCase();

      if (!name || !code) {
        return redirectWithFlash(res, "/dashboard", "Client name and code are required.");
      }

      if (statements.getClientByCode.get(code, user.id)) {
        return redirectWithFlash(res, "/dashboard", "That client code already exists.");
      }

      statements.createClient.run(
        randomId(),
        user.id,
        name,
        code,
        clientType,
        roundCurrency(Number.isFinite(defaultTherapyFee) ? defaultTherapyFee : 0),
        roundCurrency(Number.isFinite(defaultSupervisionFee) ? defaultSupervisionFee : 0),
        address,
        city,
        stateName,
        pincode,
        gstin,
        pan,
        1,
        isoNow()
      );
      return redirectWithFlash(res, "/dashboard", `Client ${name} created.`);
    }

    if (method === "POST" && url.pathname === "/sessions") {
      const form = await parseForm(req);
      const clientId = String(form.clientId || "");
      const sessionType = normalizeSessionType(form.sessionType || "therapy");
      const sessionDate = String(form.sessionDate || "");
      const durationMinutes = Number(form.durationMinutes || 50);
      const manualFee = Number(form.feeAmount || 0);
      const notes = String(form.notes || "").trim();
      const client = statements.getClientById.get(clientId, user.id);

      if (!client) {
        return redirectWithFlash(res, "/dashboard", "Choose a valid client.");
      }

      if (!sessionDate) {
        return redirectWithFlash(res, "/dashboard", "Choose a valid session date.");
      }

      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        return redirectWithFlash(res, "/dashboard", "Enter a valid session duration.");
      }

      const defaultFee = sessionType === "supervision"
        ? Number(client.default_supervision_fee || 0)
        : Number(client.default_therapy_fee || 0);
      const feeAmount = roundCurrency(manualFee > 0 ? manualFee : defaultFee);

      if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
        return redirectWithFlash(res, "/dashboard", "Enter a valid session fee or set a default fee on the client.");
      }

      statements.createSessionLog.run(
        randomId(),
        user.id,
        client.id,
        sessionType,
        sessionDate,
        Math.round(durationMinutes),
        feeAmount,
        notes,
        null,
        isoNow()
      );
      return redirectWithFlash(res, "/dashboard", `${capitalizeWord(sessionType)} session saved for ${client.name}.`);
    }

    if (method === "POST" && url.pathname.startsWith("/sessions/") && !url.pathname.endsWith("/edit")) {
      const sessionId = url.pathname.split("/")[2];
      const existingSession = statements.getSessionById.get(sessionId, user.id);

      if (!existingSession) {
        return redirectWithFlash(res, "/dashboard", "Session not found.");
      }

      if (existingSession.invoice_id) {
        return redirectWithFlash(res, "/dashboard", "This session is already attached to an invoice and cannot be edited directly.");
      }

      const form = await parseForm(req);
      const clientId = String(form.clientId || "");
      const sessionType = normalizeSessionType(form.sessionType || "therapy");
      const sessionDate = String(form.sessionDate || "");
      const durationMinutes = Number(form.durationMinutes || 50);
      const feeAmount = Number(form.feeAmount || 0);
      const notes = String(form.notes || "").trim();
      const client = statements.getClientById.get(clientId, user.id);

      if (!client) {
        return redirectWithFlash(res, `/sessions/${sessionId}/edit`, "Choose a valid client.");
      }

      if (!sessionDate || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        return redirectWithFlash(res, `/sessions/${sessionId}/edit`, "Use a valid session date and duration.");
      }

      if (!Number.isFinite(feeAmount) || feeAmount <= 0) {
        return redirectWithFlash(res, `/sessions/${sessionId}/edit`, "Enter a valid fee amount.");
      }

      statements.updateSessionLog.run(
        client.id,
        sessionType,
        sessionDate,
        Math.round(durationMinutes),
        roundCurrency(feeAmount),
        notes,
        sessionId,
        user.id
      );

      return redirectWithFlash(res, "/dashboard", "Session updated.");
    }

    if (method === "POST" && url.pathname === "/monthly-invoices") {
      const form = await parseForm(req);
      const clientId = String(form.clientId || "");
      const billingMonth = String(form.billingMonth || "");
      const issueDate = String(form.issueDate || "");
      const dueDate = String(form.dueDate || "");
      const description = String(form.description || "").trim();
      const client = statements.getClientById.get(clientId, user.id);

      if (!client) {
        return redirectWithFlash(res, "/dashboard", "Choose a valid client for invoice generation.");
      }

      if (!billingMonth || !/^\d{4}-\d{2}$/.test(billingMonth)) {
        return redirectWithFlash(res, "/dashboard", "Choose a valid billing month.");
      }

      if (!issueDate || !dueDate || dueDate < issueDate) {
        return redirectWithFlash(res, "/dashboard", "Invoice dates are invalid.");
      }

      const sessionsForMonth = statements.getUninvoicedSessionsForMonth.all(client.id, user.id, billingMonth);

      if (sessionsForMonth.length === 0) {
        return redirectWithFlash(res, "/dashboard", "No uninvoiced sessions found for that client and month.");
      }

      const totalAmount = roundCurrency(sessionsForMonth.reduce((sum, sessionLog) => sum + Number(sessionLog.fee_amount || 0), 0));
      const invoiceNumber = buildInvoiceNumber(client.code, client.next_invoice_sequence);
      const sessionLabel = summarizeSessionMix(sessionsForMonth);
      const invoiceId = randomId();

      statements.createInvoice.run(
        invoiceId,
        user.id,
        client.id,
        invoiceNumber,
        "monthly_sessions",
        billingMonth,
        issueDate,
        dueDate,
        totalAmount,
        description || `${monthLabel(billingMonth)} sessions`,
        `${capitalizeWord(sessionLabel)} sessions`,
        "",
        sessionsForMonth.length,
        roundCurrency(totalAmount / sessionsForMonth.length),
        0,
        BUSINESS_PROFILE.countryOfSupply || "India",
        client.state || BUSINESS_PROFILE.stateName || "",
        "intra",
        isoNow()
      );
      statements.updateClientSequence.run(client.next_invoice_sequence + 1, client.id, user.id);
      for (const sessionLog of sessionsForMonth) {
        statements.attachSessionsToInvoice.run(invoiceId, sessionLog.id);
      }

      return redirectWithFlash(res, "/dashboard", `Monthly invoice ${invoiceNumber} created for ${client.name}.`);
    }

    if (method === "POST" && url.pathname === "/payments") {
      const form = await parseForm(req);
      const invoiceId = String(form.invoiceId || "");
      const amount = Number(form.amount);
      const paymentDate = String(form.paymentDate || "");
      const methodName = String(form.method || "").trim();
      const invoice = getInvoiceWithBalance(invoiceId, user.id);

      if (!invoice) {
        return redirectWithFlash(res, "/dashboard", "Choose a valid invoice.");
      }

      if (!paymentDate) {
        return redirectWithFlash(res, "/dashboard", "Choose a payment date.");
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        return redirectWithFlash(res, "/dashboard", "Enter a valid payment amount.");
      }

      const paymentAmount = roundCurrency(amount);

      if (paymentAmount - invoice.balance > 0.001) {
        return redirectWithFlash(res, "/dashboard", "Payment exceeds the remaining balance.");
      }

      statements.createPayment.run(randomId(), invoice.id, paymentAmount, paymentDate, methodName, isoNow());
      return redirectWithFlash(res, "/dashboard", `Payment recorded for ${invoice.invoice_number}.`);
    }

    if (method === "POST" && url.pathname.startsWith("/payments/") && url.pathname.endsWith("/delete")) {
      const paymentId = url.pathname.split("/")[2];
      const payment = statements.getOwnedPaymentById.get(paymentId, user.id);

      if (!payment) {
        return redirectWithFlash(res, "/dashboard", "Payment not found.");
      }

      statements.deletePaymentById.run(payment.id);
      return redirectWithFlash(res, "/dashboard", `Payment removed from ${payment.invoice_number}.`);
    }

    if (method === "POST" && url.pathname.startsWith("/invoices/") && url.pathname.endsWith("/share")) {
      const invoiceId = url.pathname.split("/")[2];
      const invoice = statements.getInvoiceById.get(invoiceId, user.id);

      if (!invoice) {
        return redirectWithFlash(res, "/dashboard", "Invoice not found.");
      }

      const token = crypto.randomBytes(18).toString("base64url");
      statements.upsertShareLink.run(randomId(), invoiceId, token, isoNow());
      return redirectWithFlash(res, "/dashboard", `Share link created for ${invoice.invoice_number}.`);
    }

    if (method === "POST" && url.pathname.startsWith("/invoices/") && url.pathname.endsWith("/delete")) {
      const invoiceId = url.pathname.split("/")[2];
      const invoice = statements.getInvoiceById.get(invoiceId, user.id);

      if (!invoice) {
        return redirectWithFlash(res, "/dashboard", "Invoice not found.");
      }

      const deletionSummary = statements.getInvoiceDeleteSummary.get(invoice.id, invoice.id, user.id);

      if ((deletionSummary?.payment_count || 0) > 0) {
        return redirectWithFlash(res, "/dashboard", "Delete recorded payments first before deleting this invoice.");
      }

      statements.detachSessionsFromInvoice.run(invoice.id, user.id);
      statements.deleteShareLinkByInvoiceId.run(invoice.id);
      statements.deleteInvoiceById.run(invoice.id, user.id);
      return redirectWithFlash(res, "/dashboard", `Invoice ${invoice.invoice_number} deleted.`);
    }

    if (method === "POST" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/delete")) {
      const sessionId = url.pathname.split("/")[2];
      const sessionLog = statements.getSessionById.get(sessionId, user.id);

      if (!sessionLog) {
        return redirectWithFlash(res, "/dashboard", "Session not found.");
      }

      if (sessionLog.invoice_id) {
        return redirectWithFlash(res, "/dashboard", "This session is already invoiced. Delete the invoice first if you need to remove it.");
      }

      statements.deleteSessionLog.run(sessionId, user.id);
      return redirectWithFlash(res, "/dashboard", "Session deleted.");
    }

    if (method === "POST" && url.pathname.startsWith("/clients/") && url.pathname.endsWith("/delete")) {
      const clientId = url.pathname.split("/")[2];
      const client = statements.getClientById.get(clientId, user.id);

      if (!client) {
        return redirectWithFlash(res, "/dashboard", "Client not found.");
      }

      const deletionSummary = statements.getClientDeleteSummary.get(client.id, user.id, client.id, user.id);

      if ((deletionSummary?.session_count || 0) > 0 || (deletionSummary?.invoice_count || 0) > 0) {
        return redirectWithFlash(res, "/dashboard", "Delete this client's sessions and invoices first before removing the client.");
      }

      statements.deleteClientById.run(client.id, user.id);
      return redirectWithFlash(res, "/dashboard", `Client ${client.name} deleted.`);
    }

    if (method === "GET" && url.pathname.startsWith("/invoices/") && url.pathname.endsWith("/pdf")) {
      const invoiceId = url.pathname.split("/")[2];
      const invoice = getInvoiceWithBalance(invoiceId, user.id);

      if (!invoice) {
        return sendText(res, 404, "Invoice not found.");
      }

      const payments = statements.getInvoicePayments.all(invoice.id);
      const pdf = renderInvoicePdf(invoice, payments);

      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${invoice.invoice_number}.pdf"`,
        "Content-Length": pdf.length
      });
      res.end(pdf);
      return;
    }

    sendText(res, 404, "Not found.");
  } catch (error) {
    console.error(error);
    sendHtml(res, 500, renderErrorPage(error));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`InvoiceFlow running at http://${HOST}:${PORT}`);
});

function renderDashboard({ flash, userId, userEmail, selectedMonth, selectedInvoiceId }) {
  const clients = statements.getClients.all(userId);
  const invoices = statements.getInvoicesWithBalances.all(userId).map(enrichInvoice);
  const pendingInvoices = statements.getPendingInvoices.all(userId).map(enrichInvoice);
  const users = statements.getUsers.all();
  const summary = statements.getDashboardSummary.get(userId, userId, userId, userId, userId, userId);
  const recentSessions = statements.getRecentSessionLogs.all(userId);
  const today = formatInputDate(new Date());
  const currentMonth = selectedMonth || today.slice(0, 7);
  const monthlyMetrics = statements.getMonthlyMetrics.get(userId, currentMonth, userId, currentMonth, userId, currentMonth, userId, currentMonth);
  const clientMonthReport = statements.getClientMonthReport.all(currentMonth, currentMonth, currentMonth, currentMonth, userId);
  const recentPayments = statements.getRecentPayments.all(userId);

  return renderLayout({
    title: "PracticeFlow Dashboard",
    bodyClass: "dashboard-body",
    content: `
      <div class="page-shell">
        <header class="hero">
          <div>
            <p class="eyebrow">PracticeFlow</p>
            <h1>Log therapy and supervision sessions, bill monthly, and track what’s still due.</h1>
            <p class="hero-copy">
              Capture each session, generate client-wise month-end invoices, record payments, and keep a
              clear view of monthly income and pending balances across your practice.
            </p>
          </div>
          <div class="hero-panel">
            <p>Signed in as <strong>${escapeHtml(userEmail)}</strong></p>
            <form action="/logout" method="post">
              <button class="secondary-button" type="submit">Sign Out</button>
            </form>
          </div>
        </header>

        ${flash ? `<div class="flash-banner">${escapeHtml(flash)}</div>` : ""}

        <section class="stat-grid">
          ${renderStatCard("Clients", summary.client_count || 0)}
          ${renderStatCard("This Month Sessions", monthlyMetrics.session_count || 0)}
          ${renderStatCard("This Month Billed", formatCurrency(monthlyMetrics.billed_from_sessions || 0))}
          ${renderStatCard("This Month Collected", formatCurrency(monthlyMetrics.collected_from_payments || 0))}
          ${renderStatCard("Month Pending", formatCurrency(monthlyMetrics.pending_for_month || 0))}
          ${renderStatCard("Pending Invoices", summary.pending_invoice_count || 0)}
          ${renderStatCard("Overdue", summary.overdue_invoice_count || 0)}
        </section>

        <section class="card card-wide">
          <div class="section-heading">
            <div>
              <p class="section-label">Report Filter</p>
              <h2>${escapeHtml(monthLabel(currentMonth))}</h2>
            </div>
          </div>
          <form class="inline-report-form" action="/dashboard" method="get">
            <label>
              Reporting month
              <input name="month" type="month" value="${currentMonth}" />
            </label>
            <button class="secondary-button" type="submit">Update Report</button>
          </form>
        </section>

        <main class="workspace-grid">
          <section class="card card-form">
            <div class="section-heading">
              <div>
                <p class="section-label">Access</p>
                <h2>Create User Login</h2>
              </div>
            </div>

            <form class="stack" action="/users" method="post">
              <label>
                User email
                <input name="email" type="email" placeholder="therapist@example.com" required />
              </label>
              <label>
                Temporary password
                <input name="password" type="password" minlength="8" placeholder="At least 8 characters" required />
              </label>
              <div class="info-banner">Each login gets its own private clients, sessions, invoices, payments, and reports.</div>
              <button class="primary-button" type="submit">Create Login</button>
            </form>

            <div class="list-section">
              <div class="section-heading compact">
                <div>
                  <p class="section-label">Accounts</p>
                  <h3>Available Logins</h3>
                </div>
              </div>
              <div class="list-panel">
                ${
                  users.length
                    ? users.map((account) => `
                      <article class="client-item">
                        <strong>${escapeHtml(account.email)}</strong>
                        <div class="client-meta">
                          <span>Created ${formatDisplayDate(account.created_at)}</span>
                        </div>
                      </article>
                    `).join("")
                    : renderEmptyState("No additional logins yet.")
                }
              </div>
            </div>
          </section>

          <section class="card card-form">
            <div class="section-heading">
              <div>
                <p class="section-label">Clients</p>
                <h2>Add Client</h2>
              </div>
            </div>

            <form class="stack" action="/clients" method="post">
              <label>
                Client name
                <input name="name" type="text" placeholder="Acme Studio" required />
              </label>
              <label>
                Client code
                <input name="code" type="text" maxlength="8" placeholder="ACME" required />
              </label>
              <label>
                Primary work
                <select name="clientType">
                  <option value="therapy">Therapy</option>
                  <option value="supervision">Supervision</option>
                </select>
              </label>
              <label>
                Default therapy fee
                <input name="defaultTherapyFee" type="number" min="0" step="0.01" placeholder="2500" />
              </label>
              <label>
                Default supervision fee
                <input name="defaultSupervisionFee" type="number" min="0" step="0.01" placeholder="4000" />
              </label>
              <label>
                Billing address
                <textarea name="address" rows="3" placeholder="Street, building, landmark"></textarea>
              </label>
              <button class="primary-button" type="submit">Save Client</button>
            </form>

            <div class="list-section">
              <div class="section-heading compact">
                <div>
                  <p class="section-label">Directory</p>
                  <h3>Clients</h3>
                </div>
              </div>
              <div class="list-panel">
                ${
                  clients.length
                    ? clients.map(renderClientCard).join("")
                    : renderEmptyState("No clients yet.")
                }
              </div>
            </div>
          </section>

          <section class="card card-form">
            <div class="section-heading">
              <div>
                <p class="section-label">Sessions</p>
                <h2>Log Session</h2>
              </div>
            </div>

            <form class="stack" action="/sessions" method="post">
              <label>
                Client
                <select name="clientId" required>
                  <option value="">Select client</option>
                  ${clients.map((client) => `<option value="${client.id}">${escapeHtml(client.name)} (${escapeHtml(client.code)})</option>`).join("")}
                </select>
              </label>
              <label>
                Session type
                <select name="sessionType">
                  <option value="therapy">Therapy</option>
                  <option value="supervision">Supervision</option>
                </select>
              </label>
              <label>
                Session date
                <input name="sessionDate" type="date" value="${today}" required />
              </label>
              <label>
                Duration in minutes
                <input name="durationMinutes" type="number" min="1" step="1" value="50" required />
              </label>
              <label>
                Fee amount
                <input name="feeAmount" type="number" min="0" step="0.01" placeholder="Leave blank to use client default" />
              </label>
              <label>
                Notes
                <textarea name="notes" rows="4" placeholder="Individual therapy, review, supervision focus, or any invoice note you want carried over."></textarea>
              </label>
              <div class="info-banner">Sessions stay open until you turn a month of sessions into a client invoice.</div>
              <button class="primary-button" type="submit" ${clients.length ? "" : "disabled"}>Save Session</button>
            </form>
          </section>

          <section class="card card-form">
            <div class="section-heading">
              <div>
                <p class="section-label">Month-End Billing</p>
                <h2>Generate Invoice</h2>
              </div>
            </div>

            <form class="stack" action="/monthly-invoices" method="post">
              <label>
                Client
                <select name="clientId" required>
                  <option value="">Select client</option>
                  ${clients.map((client) => `<option value="${client.id}">${escapeHtml(client.name)} (${escapeHtml(client.code)})</option>`).join("")}
                </select>
              </label>
              <label>
                Billing month
                <input name="billingMonth" type="month" value="${currentMonth}" required />
              </label>
              <label>
                Invoice date
                <input name="issueDate" type="date" value="${today}" required />
              </label>
              <label>
                Due date
                <input name="dueDate" type="date" value="${today}" required />
              </label>
              <label>
                Invoice note
                <textarea name="description" rows="3" placeholder="April therapy sessions, supervision hours, or any note for the invoice message."></textarea>
              </label>
              <div class="info-banner">This pulls all uninvoiced sessions for that client and month into one client-wise invoice.</div>
              <button class="primary-button" type="submit" ${clients.length ? "" : "disabled"}>Generate Monthly Invoice</button>
            </form>
          </section>

          <section class="card card-wide">
            <div class="section-heading">
              <div>
                <p class="section-label">Sessions</p>
                <h2>Recent Session Log</h2>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Client</th>
                    <th>Type</th>
                    <th>Duration</th>
                    <th>Fee</th>
                    <th>Invoice</th>
                    <th>Edit</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    recentSessions.length
                      ? recentSessions.map(renderSessionRow).join("")
                      : `<tr><td colspan="7">${renderEmptyState("No sessions logged yet.")}</td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card card-wide">
            <div class="section-heading">
              <div>
                <p class="section-label">Ledger</p>
                <h2>Client Invoices</h2>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Client</th>
                    <th>Month</th>
                    <th>Issue Date</th>
                    <th>Due Date</th>
                    <th>Amount</th>
                    <th>Paid</th>
                    <th>Balance</th>
                    <th>Status</th>
                    <th>Pay</th>
                    <th>Open</th>
                    <th>Share</th>
                    <th>Print</th>
                    <th>Delete</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    invoices.length
                      ? invoices.map(renderInvoiceRow).join("")
                      : `<tr><td colspan="14">${renderEmptyState("No invoices yet.")}</td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card card-form">
            <div class="section-heading">
              <div>
                <p class="section-label">Payments</p>
                <h2>Record Payment</h2>
              </div>
            </div>

            <form id="payment-form" class="stack" action="/payments" method="post">
              <label>
                Invoice
                <select name="invoiceId" required>
                  <option value="">Select invoice</option>
                  ${pendingInvoices.map((invoice) => `<option value="${invoice.id}" ${selectedInvoiceId === invoice.id ? "selected" : ""}>${escapeHtml(invoice.invoice_number)} - ${escapeHtml(invoice.client_name)} (${formatCurrency(invoice.balance)} due)</option>`).join("")}
                </select>
              </label>
              <label>
                Payment date
                <input name="paymentDate" type="date" value="${today}" required />
              </label>
              <label>
                Amount paid
                <input name="amount" type="number" min="0.01" step="0.01" required />
              </label>
              <label>
                Method
                <input name="method" type="text" placeholder="Bank transfer / UPI / cash" />
              </label>
              <button class="primary-button" type="submit" ${pendingInvoices.length ? "" : "disabled"}>Save Payment</button>
            </form>
          </section>

          <section class="card card-wide">
            <div class="section-heading">
              <div>
                <p class="section-label">Reports</p>
                <h2>Pending Payments</h2>
              </div>
            </div>
            <div class="report-grid">
              ${
                pendingInvoices.length
                  ? pendingInvoices.map(renderPendingCard).join("")
                  : renderEmptyState("No pending payments right now.")
              }
            </div>
          </section>

          <section class="card card-wide">
            <div class="section-heading">
              <div>
                <p class="section-label">Monthly Report</p>
                <h2>Client Wise Income Snapshot</h2>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Sessions</th>
                    <th>Invoices</th>
                    <th>Invoiced This Month</th>
                    <th>Collected This Month</th>
                    <th>Pending This Month</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    clientMonthReport.length
                      ? clientMonthReport.map(renderClientMonthRow).join("")
                      : `<tr><td colspan="5">${renderEmptyState("No monthly client report yet.")}</td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </section>

          <section class="card card-wide">
            <div class="section-heading">
              <div>
                <p class="section-label">Payments</p>
                <h2>Recent Payments</h2>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Client</th>
                    <th>Invoice</th>
                    <th>Method</th>
                    <th>Amount</th>
                    <th>Delete</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    recentPayments.length
                      ? recentPayments.map(renderPaymentRow).join("")
                      : `<tr><td colspan="6">${renderEmptyState("No payments recorded yet.")}</td></tr>`
                  }
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>
    `
  });
}

function renderAuthPage({ title, action, submitLabel, message, flash, secondaryLink, googleAuthUrl }) {
  const showGoogleAuth = GOOGLE_CLIENT_ID && googleAuthUrl;
  return renderLayout({
    title,
    bodyClass: "auth-body",
    content: `
      ${showGoogleAuth ? `<script src="https://accounts.google.com/gsi/client" async defer></script>` : ""}
      <main class="auth-shell">
        <section class="auth-card">
          <p class="eyebrow">InvoiceFlow Platform</p>
          <h1>${escapeHtml(title)}</h1>
          <p class="hero-copy">${escapeHtml(message)}</p>
          ${flash ? `<div class="flash-banner">${escapeHtml(flash)}</div>` : ""}
          <form class="stack" action="${action}" method="post">
            <label>
              Email
              <input name="email" type="email" placeholder="you@example.com" required />
            </label>
            <label>
              Password
              <input name="password" type="password" minlength="8" required />
            </label>
            <button class="primary-button" type="submit">${escapeHtml(submitLabel)}</button>
          </form>
          ${showGoogleAuth ? `
            <div class="auth-divider"><span>or</span></div>
            <div id="g_id_onload"
              data-client_id="${escapeHtml(GOOGLE_CLIENT_ID)}"
              data-login_uri="${escapeHtml(googleAuthUrl)}"
              data-ux_mode="redirect"
              data-auto_prompt="false"></div>
            <div class="google-signin-wrap">
              <div class="g_id_signin"
                data-type="standard"
                data-shape="pill"
                data-theme="outline"
                data-text="continue_with"
                data-size="large"
                data-width="320"></div>
            </div>
            <p class="hero-copy auth-note">Use your Google account to create or access the same practice workspace for that email address.</p>
          ` : ""}
          ${secondaryLink ? `<p class="hero-copy"><a href="${secondaryLink.href}">${escapeHtml(secondaryLink.label)}</a></p>` : ""}
        </section>
      </main>
    `
  });
}

function renderSessionEditPage({ flash, clients, sessionLog }) {
  return renderLayout({
    title: "Edit Session",
    bodyClass: "dashboard-body",
    content: `
      <main class="auth-shell">
        <section class="auth-card">
          <p class="eyebrow">PracticeFlow</p>
          <h1>Edit Session</h1>
          <p class="hero-copy">Correct the date, amount, duration, or notes for this session.</p>
          ${flash ? `<div class="flash-banner">${escapeHtml(flash)}</div>` : ""}
          <form class="stack" action="/sessions/${sessionLog.id}" method="post">
            <label>
              Client
              <select name="clientId" required>
                ${clients.map((client) => `<option value="${client.id}" ${client.id === sessionLog.client_id ? "selected" : ""}>${escapeHtml(client.name)} (${escapeHtml(client.code)})</option>`).join("")}
              </select>
            </label>
            <label>
              Session type
              <select name="sessionType">
                <option value="therapy" ${sessionLog.session_type === "therapy" ? "selected" : ""}>Therapy</option>
                <option value="supervision" ${sessionLog.session_type === "supervision" ? "selected" : ""}>Supervision</option>
              </select>
            </label>
            <label>
              Session date
              <input name="sessionDate" type="date" value="${sessionLog.session_date}" required />
            </label>
            <label>
              Duration in minutes
              <input name="durationMinutes" type="number" min="1" step="1" value="${sessionLog.duration_minutes}" required />
            </label>
            <label>
              Fee amount
              <input name="feeAmount" type="number" min="0.01" step="0.01" value="${sessionLog.fee_amount}" required />
            </label>
            <label>
              Notes
              <textarea name="notes" rows="4">${escapeHtml(sessionLog.notes || "")}</textarea>
            </label>
            <button class="primary-button" type="submit">Update Session</button>
          </form>
          <p class="hero-copy"><a href="/dashboard">Back to dashboard</a></p>
        </section>
      </main>
    `
  });
}

function renderInvoiceDocumentPage({ invoice, payments, missing = false, isPublic = false }) {
  return renderLayout({
    title: missing ? "Invoice Not Found" : `Invoice ${invoice.invoice_number}`,
    bodyClass: "dashboard-body",
    content: missing
      ? `
        <main class="auth-shell">
          <section class="auth-card">
            <h1>Invoice not found</h1>
            <p class="hero-copy">This share link is missing or no longer valid.</p>
          </section>
        </main>
      `
      : renderInvoiceDocument(invoice, payments, { isPublic })
  });
}

function renderErrorPage(error) {
  return renderLayout({
    title: "Server Error",
    bodyClass: "auth-body",
    content: `
      <main class="auth-shell">
        <section class="auth-card">
          <h1>Something went wrong</h1>
          <p class="hero-copy">The request could not be completed.</p>
          <pre class="error-box">${escapeHtml(error.message || "Unknown error")}</pre>
        </section>
      </main>
    `
  });
}

function renderLayout({ title, content, bodyClass }) {
  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(title)}</title>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
      <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet" />
      <link rel="stylesheet" href="/public/styles.css" />
    </head>
    <body class="${bodyClass}">
      ${content}
      <script>
        document.addEventListener("wheel", function (event) {
          const active = document.activeElement;
          if (active && active.tagName === "INPUT" && active.type === "number") {
            event.preventDefault();
          }
        }, { passive: false });
      </script>
    </body>
  </html>`;
}

function renderClientCard(client) {
  const outstanding = getClientOutstanding(client.id, client.user_id);
  const deletionLabel = outstanding > 0.001
    ? "Delete unavailable while outstanding remains"
    : "Delete client";
  return `
    <article class="client-item">
      <strong>${escapeHtml(client.name)}</strong>
      <div class="client-meta">
        <span>Code: ${escapeHtml(client.code)}</span>
        <span>${escapeHtml(capitalizeWord(client.client_type || "therapy"))}</span>
      </div>
      <div class="client-meta">
        <span>Therapy fee: ${formatCurrency(client.default_therapy_fee || 0)}</span>
        <span>Supervision fee: ${formatCurrency(client.default_supervision_fee || 0)}</span>
      </div>
      <div class="client-meta">
        <span>${countClientInvoices(client.id, client.user_id)} invoice(s)</span>
        <span>${formatCurrency(outstanding)} outstanding</span>
      </div>
      <form action="/clients/${client.id}/delete" method="post" class="inline-form danger-form">
        <button class="table-button danger-button" type="submit" title="${escapeHtml(deletionLabel)}">Delete</button>
      </form>
    </article>
  `;
}

function renderInvoiceRow(invoice) {
  const shareLink = statements.getShareLinkByInvoiceId.get(invoice.id);
  const publicUrl = shareLink ? `/share/${shareLink.token}` : "";

  return `
    <tr>
      <td>
        <strong>${escapeHtml(invoice.invoice_number)}</strong>
        <div class="invoice-meta">${escapeHtml(invoice.description || "No description")}</div>
      </td>
      <td>${escapeHtml(invoice.client_name)}</td>
      <td>${escapeHtml(invoice.billing_month ? monthLabel(invoice.billing_month) : "Custom")}</td>
      <td>${formatDisplayDate(invoice.issue_date)}</td>
      <td>${formatDisplayDate(invoice.due_date)}</td>
      <td>${formatCurrency(invoice.amount)}</td>
      <td>${formatCurrency(invoice.paid_amount)}</td>
      <td>${formatCurrency(invoice.balance)}</td>
      <td><span class="status-pill ${getStatusClass(invoice.status)}">${escapeHtml(invoice.status)}</span></td>
      <td>${invoice.balance > 0.001 ? `<a class="table-button anchor-button" href="/dashboard?invoiceId=${invoice.id}#payment-form">Mark Payment</a>` : `<span class="invoice-meta">Settled</span>`}</td>
      <td><a class="table-button anchor-button" href="/invoices/${invoice.id}/view" target="_blank" rel="noreferrer">Open</a></td>
      <td>
        <form action="/invoices/${invoice.id}/share" method="post" class="inline-form">
          <button class="table-button" type="submit">${shareLink ? "Refresh Link" : "Create Link"}</button>
        </form>
        ${publicUrl ? `<a class="share-link" href="${publicUrl}" target="_blank" rel="noreferrer">${escapeHtml(publicUrl)}</a>` : ""}
      </td>
      <td><a class="table-button anchor-button" href="/invoices/${invoice.id}/view" target="_blank" rel="noreferrer">Print</a></td>
      <td>
        <form action="/invoices/${invoice.id}/delete" method="post" class="inline-form danger-form">
          <button class="table-button danger-button" type="submit">Delete</button>
        </form>
      </td>
    </tr>
  `;
}

function renderSessionRow(sessionLog) {
  return `
    <tr>
      <td>${formatDisplayDate(sessionLog.session_date)}</td>
      <td>${escapeHtml(sessionLog.client_name)}</td>
      <td>${escapeHtml(capitalizeWord(sessionLog.session_type))}</td>
      <td>${escapeHtml(`${sessionLog.duration_minutes} min`)}</td>
      <td>${formatCurrency(sessionLog.fee_amount)}</td>
      <td>${sessionLog.invoice_id ? "Invoiced" : "Open"}</td>
      <td>${sessionLog.invoice_id ? `<span class="invoice-meta">Locked</span>` : `
        <div class="action-row">
          <a class="table-button anchor-button" href="/sessions/${sessionLog.id}/edit">Edit</a>
          <form action="/sessions/${sessionLog.id}/delete" method="post" class="inline-form danger-form">
            <button class="table-button danger-button" type="submit">Delete</button>
          </form>
        </div>
      `}</td>
      <td>${escapeHtml(sessionLog.notes || "No notes")}</td>
    </tr>
  `;
}

function renderPendingCard(invoice) {
  return `
    <article class="pending-item">
      <div class="pending-meta">
        <strong>${escapeHtml(invoice.invoice_number)}</strong>
        <span class="status-pill ${getStatusClass(invoice.status)}">${escapeHtml(invoice.status)}</span>
      </div>
      <div class="pending-meta">
        <span>${escapeHtml(invoice.client_name)}</span>
        <span>${escapeHtml(invoice.billing_month ? monthLabel(invoice.billing_month) : "Custom invoice")} · Due ${formatDisplayDate(invoice.due_date)}</span>
      </div>
      <div class="pending-balance">${formatCurrency(invoice.balance)}</div>
      <div class="pending-meta">
        <a class="table-button anchor-button" href="/dashboard?invoiceId=${invoice.id}#payment-form">Mark Payment</a>
      </div>
    </article>
  `;
}

function renderClientMonthRow(row) {
  return `
    <tr>
      <td>${escapeHtml(row.client_name)}</td>
      <td>${escapeHtml(String(row.session_count || 0))}</td>
      <td>${escapeHtml(String(row.invoice_count || 0))}</td>
      <td>${formatCurrency(row.invoiced_total || 0)}</td>
      <td>${formatCurrency(row.collected_total || 0)}</td>
      <td>${formatCurrency(row.pending_total || 0)}</td>
    </tr>
  `;
}

function renderPaymentRow(payment) {
  return `
    <tr>
      <td>${formatDisplayDate(payment.payment_date)}</td>
      <td>${escapeHtml(payment.client_name)}</td>
      <td>${escapeHtml(payment.invoice_number)}</td>
      <td>${escapeHtml(payment.method || "Payment recorded")}</td>
      <td>${formatCurrency(payment.amount)}</td>
      <td>
        <form action="/payments/${payment.id}/delete" method="post" class="inline-form danger-form">
          <button class="table-button danger-button" type="submit">Delete</button>
        </form>
      </td>
    </tr>
  `;
}

function renderStatCard(label, value) {
  return `
    <article class="stat-card">
      <p class="stat-title">${escapeHtml(String(label))}</p>
      <p class="stat-value">${escapeHtml(String(value))}</p>
    </article>
  `;
}

function renderEmptyState(message) {
  return `<div class="empty-state"><p>${escapeHtml(message)}</p></div>`;
}

function renderInvoiceDocument(invoice, payments, { isPublic }) {
  const invoiceSessions = statements.getSessionLogsForInvoice.all(invoice.id);
  const totals = {
    taxableAmount: Number(invoice.amount || 0),
    taxOne: 0,
    taxTwo: 0,
    taxLabelOne: "Tax",
    taxLabelTwo: "Tax",
    total: Number(invoice.amount || 0)
  };
  const billedToLines = [
    invoice.client_name,
    invoice.address,
    [invoice.city, invoice.state].filter(Boolean).join(", "),
    invoice.pincode,
    invoice.gstin ? `GSTIN: ${invoice.gstin}` : "",
    invoice.pan ? `PAN: ${invoice.pan}` : ""
  ].filter(Boolean);
  const billedByLines = [
    BUSINESS_PROFILE.companyName,
    ...BUSINESS_PROFILE.addressLines,
    `GSTIN: ${BUSINESS_PROFILE.gstin}`,
    `PAN: ${BUSINESS_PROFILE.pan}`
  ];

  return `
    <main class="invoice-doc-shell">
      <section class="invoice-doc ${isPublic ? "invoice-doc-public" : ""}">
        <div class="invoice-doc-header">
          <div>
            <h1 class="invoice-title">Invoice</h1>
            <div class="invoice-meta-grid">
              <div><span>Invoice No #</span><strong>${escapeHtml(invoice.invoice_number)}</strong></div>
              <div><span>Invoice Date</span><strong>${formatDisplayDate(invoice.issue_date)}</strong></div>
              <div><span>Due Date</span><strong>${formatDisplayDate(invoice.due_date)}</strong></div>
              ${invoice.billing_month ? `<div><span>Billing Month</span><strong>${escapeHtml(monthLabel(invoice.billing_month))}</strong></div>` : ""}
            </div>
          </div>
          <div class="invoice-brand">
            <div class="invoice-brand-mark">AS</div>
            <strong>${escapeHtml(BUSINESS_PROFILE.companyName)}</strong>
            <span>${escapeHtml(BUSINESS_PROFILE.brandTagline || "")}</span>
          </div>
        </div>

        <div class="party-grid">
          <section class="party-card">
            <h2>Billed By</h2>
            ${billedByLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
          </section>
          <section class="party-card">
            <h2>Billed To</h2>
            ${billedToLines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
          </section>
        </div>

        <div class="invoice-table-shell">
          <table class="invoice-doc-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Date</th>
                <th>Duration</th>
                <th>Fee</th>
              </tr>
            </thead>
            <tbody>
              ${
                invoiceSessions.length
                  ? invoiceSessions.map((sessionLog) => `
                    <tr>
                      <td>
                        <strong>${escapeHtml(capitalizeWord(sessionLog.session_type))}</strong>
                        ${sessionLog.notes ? `<div class="invoice-table-sub">${escapeHtml(sessionLog.notes)}</div>` : ""}
                      </td>
                      <td>${formatDisplayDate(sessionLog.session_date)}</td>
                      <td>${escapeHtml(`${sessionLog.duration_minutes} min`)}</td>
                      <td>${formatCurrency(sessionLog.fee_amount)}</td>
                    </tr>
                  `).join("")
                  : `
                    <tr>
                      <td>
                        <strong>${escapeHtml(invoice.item_name || "Professional services")}</strong>
                        ${invoice.description ? `<div class="invoice-table-sub">${escapeHtml(invoice.description)}</div>` : ""}
                      </td>
                      <td>${formatDisplayDate(invoice.issue_date)}</td>
                      <td>${escapeHtml(`${formatNumber(invoice.quantity)} session(s)`)}</td>
                      <td>${formatCurrency(invoice.amount)}</td>
                    </tr>
                  `
              }
            </tbody>
          </table>
        </div>

        <div class="invoice-summary-row">
          <div class="amount-words">
            <strong>Invoice note:</strong> ${escapeHtml(invoice.description || `${monthLabel(invoice.billing_month || invoice.issue_date.slice(0, 7))} sessions`)}
            <br />
            <strong>Total (in words):</strong> ${escapeHtml(numberToWordsInr(totals.total))}
          </div>
          <div class="totals-card">
            <div><span>Sessions</span><strong>${escapeHtml(String(invoiceSessions.length || invoice.quantity || 1))}</strong></div>
            <div><span>Amount</span><strong>${formatCurrency(totals.taxableAmount)}</strong></div>
            <div class="totals-grand"><span>Total (INR)</span><strong>${formatCurrency(totals.total)}</strong></div>
            <div><span>Paid</span><strong>${formatCurrency(invoice.paid_amount)}</strong></div>
            <div><span>Balance</span><strong>${formatCurrency(invoice.balance)}</strong></div>
          </div>
        </div>

        <div class="invoice-footer-grid">
          <section class="bank-card">
            <h3>Bank Details</h3>
            <div><span>Account Name</span><strong>${escapeHtml(BUSINESS_PROFILE.bankDetails.accountName)}</strong></div>
            <div><span>Account Number</span><strong>${escapeHtml(BUSINESS_PROFILE.bankDetails.accountNumber)}</strong></div>
            <div><span>IFSC</span><strong>${escapeHtml(BUSINESS_PROFILE.bankDetails.ifsc)}</strong></div>
            <div><span>Account Type</span><strong>${escapeHtml(BUSINESS_PROFILE.bankDetails.accountType)}</strong></div>
            <div><span>Bank</span><strong>${escapeHtml(BUSINESS_PROFILE.bankDetails.bankName)}</strong></div>
          </section>

          <section class="signature-card">
            <div class="signature-mark">/s/</div>
            <strong>${escapeHtml(BUSINESS_PROFILE.signatoryName)}</strong>
          </section>
        </div>

        <section class="terms-card">
          <h3>Terms and Conditions</h3>
          <ol>
            <li>Please quote invoice number when remitting funds.</li>
          </ol>
        </section>

        ${payments.length ? `
          <section class="payments-list invoice-payments">
            <h3>Payments</h3>
            ${payments.map((payment) => `
              <div class="payment-item">
                <span>${formatDisplayDate(payment.payment_date)}</span>
                <span>${escapeHtml(payment.method || "Recorded payment")}</span>
                <strong>${formatCurrency(payment.amount)}</strong>
              </div>
            `).join("")}
          </section>
        ` : ""}
      </section>
    </main>
  `;
}

function getInvoiceWithBalance(invoiceId, userId) {
  const invoice = statements.getInvoicesWithBalances.all(userId).find((item) => item.id === invoiceId);
  return invoice ? enrichInvoice(invoice) : null;
}

function enrichInvoice(invoice) {
  const quantity = Number(invoice.quantity || 1);
  const storedAmount = Number(invoice.amount || 0);
  const rate = Number(invoice.rate || storedAmount || 0);
  const gstRate = invoice.invoice_kind === "monthly_sessions" ? 0 : (invoice.rate ? Number(invoice.gst_rate || 0) : 0);
  const totals = invoice.invoice_kind === "monthly_sessions"
    ? { taxableAmount: storedAmount, cgst: 0, sgst: 0, igst: 0, total: storedAmount }
    : calculateInvoiceTotals({
      quantity,
      rate,
      gstRate,
      supplyType: invoice.supply_type
    });
  const amount = Number(storedAmount || totals.total || 0);
  const paidAmount = Number(invoice.paid_amount || 0);
  const balance = Number((amount - paidAmount).toFixed(2));
  const status = balance <= 0.001
    ? "Paid"
    : balance < amount
      ? "Partial"
      : invoice.due_date < formatInputDate(new Date())
        ? "Overdue"
        : "Pending";

  return {
    ...invoice,
    amount,
    quantity,
    rate,
    gst_rate: gstRate,
    paid_amount: paidAmount,
    balance: Number(balance.toFixed(2)),
    taxable_amount: totals.taxableAmount,
    cgst_amount: totals.cgst,
    sgst_amount: totals.sgst,
    igst_amount: totals.igst,
    status
  };
}

function countClientInvoices(clientId, userId) {
  return db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE client_id = ? AND user_id = ?").get(clientId, userId).count;
}

function getClientOutstanding(clientId, userId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(balance), 0) AS outstanding
    FROM (
      SELECT invoices.amount - COALESCE(SUM(payments.amount), 0) AS balance
      FROM invoices
      LEFT JOIN payments ON payments.invoice_id = invoices.id
      WHERE invoices.client_id = ? AND invoices.user_id = ?
      GROUP BY invoices.id
    )
  `).get(clientId, userId);

  return Number((row?.outstanding || 0).toFixed(2));
}

function shouldShowSetup() {
  return statements.userCount.get().count === 0;
}

function cleanupExpiredSessions() {
  statements.deleteExpiredSessions.run(isoNow());
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies[SESSION_COOKIE] || null;
}

function getSessionUser(sessionId) {
  const session = statements.getSessionUser.get(sessionId);

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at) < new Date()) {
    statements.deleteSession.run(sessionId);
    return null;
  }

  return {
    id: session.user_id,
    email: session.email
  };
}

function getBaseUrl(req, url) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || url.protocol.replace(":", "");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `${HOST}:${PORT}`;
  return `${protocol}://${host}`;
}

function parseCookies(cookieHeader) {
  return cookieHeader.split(";").reduce((accumulator, pair) => {
    const [key, ...rest] = pair.trim().split("=");
    if (!key) {
      return accumulator;
    }

    accumulator[key] = decodeURIComponent(rest.join("="));
    return accumulator;
  }, {});
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  parts.push(`Path=${options.path || "/"}`);
  return parts.join("; ");
}

function getFlash(req) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  return url.searchParams.get("flash");
}

function redirectWithFlash(res, location, message) {
  const target = new URL(location, `http://${HOST}:${PORT}`);
  target.searchParams.set("flash", message);
  redirect(res, target.pathname + target.search);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function parseForm(req) {
  const body = await readBody(req);
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(pathname, res) {
  const filePath = path.join(PUBLIC_DIR, pathname.replace("/public/", ""));

  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    return sendText(res, 404, "Asset not found.");
  }

  const ext = path.extname(filePath);
  const contentType = ext === ".css" ? "text/css; charset=utf-8" : "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

async function verifyGoogleCredential(credential) {
  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();

  if (!payload?.sub || !payload?.email) {
    throw new Error("Google credential payload was incomplete.");
  }

  return {
    sub: payload.sub,
    email: String(payload.email).trim().toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
    name: String(payload.name || payload.email || "Google user").trim()
  };
}

function verifyPassword(password, stored) {
  const [salt, originalHash] = stored.split(":");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

function normalizeClientCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function buildInvoiceNumber(code, sequence) {
  return `${code}-${String(sequence).padStart(4, "0")}`;
}

function isoNow() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function formatInputDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDisplayDate(value) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function formatCurrency(value) {
  const roundedValue = roundCurrency(value);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(roundedValue);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getStatusClass(status) {
  if (status === "Paid") {
    return "status-paid";
  }

  if (status === "Partial") {
    return "status-partial";
  }

  if (status === "Overdue") {
    return "status-overdue";
  }

  return "status-pending";
}

function renderInvoicePdf(invoice, payments) {
  return renderSimplePdfFallback(invoice, payments);
}

function renderSimplePdfFallback(invoice, payments) {
  const lines = [
    "InvoiceFlow",
    "",
    `Invoice: ${invoice.invoice_number}`,
    `Client: ${invoice.client_name}`,
    `Issue Date: ${formatDisplayDate(invoice.issue_date)}`,
    `Due Date: ${formatDisplayDate(invoice.due_date)}`,
    `Amount: ${formatCurrency(invoice.amount)}`,
    `Paid: ${formatCurrency(invoice.paid_amount)}`,
    `Balance: ${formatCurrency(invoice.balance)}`,
    "",
    ...(payments.length
      ? payments.map((payment) => `${formatDisplayDate(payment.payment_date)} | ${payment.method || "Payment"} | ${formatCurrency(payment.amount)}`)
      : ["No payments recorded yet."])
  ];

  const content = ["BT", "/F1 12 Tf", "50 780 Td", ...lines.flatMap((line, index) => [
    index === 0 ? `(${escapePdfText(line)}) Tj` : "0 -18 Td",
    index === 0 ? "" : `(${escapePdfText(line)}) Tj`
  ]).filter(Boolean), "ET"].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join(""), "utf8"));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(""), "utf8");
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  offsets.slice(1).forEach((offset) => chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`));
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(""), "utf8");
}

function escapePdfText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function migrateToMultiUserSchema() {
  const firstUser = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get();
  const fallbackUserId = firstUser?.id || "";
  const needsClientsMigration = !tableHasColumn("clients", "user_id")
    || !hasCompositeUniqueIndex("clients", ["user_id", "code"]);
  const needsInvoicesMigration = !tableHasColumn("invoices", "user_id")
    || !hasCompositeUniqueIndex("invoices", ["user_id", "invoice_number"])
    || foreignKeyTargetsTable("invoices", "clients_legacy_multi_user");
  const needsSessionLogsMigration = !tableHasColumn("session_logs", "user_id")
    || foreignKeyTargetsTable("session_logs", "invoices_legacy_multi_user")
    || foreignKeyTargetsTable("session_logs", "clients_legacy_multi_user");
  const needsPaymentsMigration = foreignKeyTargetsTable("payments", "invoices_legacy_multi_user");
  const needsShareLinksMigration = foreignKeyTargetsTable("invoice_share_links", "invoices_legacy_multi_user");

  if (!needsClientsMigration && !needsInvoicesMigration && !needsSessionLogsMigration && !needsPaymentsMigration && !needsShareLinksMigration) {
    return;
  }

  db.exec("PRAGMA foreign_keys = OFF");

  try {
    const migrate = db.transaction(() => {
      if (needsClientsMigration) {
        migrateClientsTable(fallbackUserId);
      }

      if (needsInvoicesMigration) {
        migrateInvoicesTable(fallbackUserId);
      }

      if (needsSessionLogsMigration) {
        migrateSessionLogsTable(fallbackUserId);
      }

      if (needsInvoicesMigration || needsPaymentsMigration) {
        migratePaymentsTable();
      }

      if (needsInvoicesMigration || needsShareLinksMigration) {
        migrateShareLinksTable();
      }
    });

    migrate();
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateClientsTable(fallbackUserId) {
  const oldTableName = "clients_legacy_multi_user";
  db.exec(`ALTER TABLE clients RENAME TO ${oldTableName}`);
  db.exec(`
    CREATE TABLE clients (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      client_type TEXT NOT NULL DEFAULT 'therapy',
      default_therapy_fee REAL NOT NULL DEFAULT 0,
      default_supervision_fee REAL NOT NULL DEFAULT 0,
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      pincode TEXT NOT NULL DEFAULT '',
      gstin TEXT NOT NULL DEFAULT '',
      pan TEXT NOT NULL DEFAULT '',
      next_invoice_sequence INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      UNIQUE (user_id, code),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const oldColumns = new Set(db.prepare(`PRAGMA table_info(${oldTableName})`).all().map((column) => column.name));
  const userExpression = oldColumns.has("user_id") ? "COALESCE(NULLIF(user_id, ''), ?)" : "?";
  const clientTypeExpression = oldColumns.has("client_type") ? "COALESCE(client_type, 'therapy')" : "'therapy'";
  const therapyFeeExpression = oldColumns.has("default_therapy_fee") ? "COALESCE(default_therapy_fee, 0)" : "0";
  const supervisionFeeExpression = oldColumns.has("default_supervision_fee") ? "COALESCE(default_supervision_fee, 0)" : "0";
  const addressExpression = oldColumns.has("address") ? "COALESCE(address, '')" : "''";
  const cityExpression = oldColumns.has("city") ? "COALESCE(city, '')" : "''";
  const stateExpression = oldColumns.has("state") ? "COALESCE(state, '')" : "''";
  const pincodeExpression = oldColumns.has("pincode") ? "COALESCE(pincode, '')" : "''";
  const gstinExpression = oldColumns.has("gstin") ? "COALESCE(gstin, '')" : "''";
  const panExpression = oldColumns.has("pan") ? "COALESCE(pan, '')" : "''";
  const nextSequenceExpression = oldColumns.has("next_invoice_sequence") ? "COALESCE(next_invoice_sequence, 1)" : "1";

  db.prepare(`
    INSERT INTO clients (
      id, user_id, name, code, client_type, default_therapy_fee, default_supervision_fee,
      address, city, state, pincode, gstin, pan, next_invoice_sequence, created_at
    )
    SELECT
      id,
      ${userExpression},
      name,
      code,
      ${clientTypeExpression},
      ${therapyFeeExpression},
      ${supervisionFeeExpression},
      ${addressExpression},
      ${cityExpression},
      ${stateExpression},
      ${pincodeExpression},
      ${gstinExpression},
      ${panExpression},
      ${nextSequenceExpression},
      created_at
    FROM ${oldTableName}
  `).run(fallbackUserId);

  db.exec(`DROP TABLE ${oldTableName}`);
}

function migrateInvoicesTable(fallbackUserId) {
  const oldTableName = "invoices_legacy_multi_user";
  db.exec(`ALTER TABLE invoices RENAME TO ${oldTableName}`);
  db.exec(`
    CREATE TABLE invoices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      invoice_kind TEXT NOT NULL DEFAULT 'manual',
      billing_month TEXT NOT NULL DEFAULT '',
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      item_name TEXT NOT NULL DEFAULT '',
      hsn_sac TEXT NOT NULL DEFAULT '',
      quantity REAL NOT NULL DEFAULT 1,
      rate REAL NOT NULL DEFAULT 0,
      gst_rate REAL NOT NULL DEFAULT 18,
      country_of_supply TEXT NOT NULL DEFAULT 'India',
      place_of_supply TEXT NOT NULL DEFAULT '',
      supply_type TEXT NOT NULL DEFAULT 'intra',
      created_at TEXT NOT NULL,
      UNIQUE (user_id, invoice_number),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )
  `);

  const oldColumns = new Set(db.prepare(`PRAGMA table_info(${oldTableName})`).all().map((column) => column.name));
  const userExpression = oldColumns.has("user_id")
    ? "COALESCE(NULLIF(user_id, ''), (SELECT user_id FROM clients WHERE clients.id = invoices_legacy_multi_user.client_id), ?)"
    : "COALESCE((SELECT user_id FROM clients WHERE clients.id = invoices_legacy_multi_user.client_id), ?)";
  const invoiceKindExpression = oldColumns.has("invoice_kind") ? "COALESCE(invoice_kind, 'manual')" : "'manual'";
  const billingMonthExpression = oldColumns.has("billing_month") ? "COALESCE(billing_month, '')" : "''";
  const itemNameExpression = oldColumns.has("item_name") ? "COALESCE(item_name, '')" : "''";
  const hsnExpression = oldColumns.has("hsn_sac") ? "COALESCE(hsn_sac, '')" : "''";
  const quantityExpression = oldColumns.has("quantity") ? "COALESCE(quantity, 1)" : "1";
  const rateExpression = oldColumns.has("rate") ? "COALESCE(rate, 0)" : "0";
  const gstRateExpression = oldColumns.has("gst_rate") ? "COALESCE(gst_rate, 18)" : "18";
  const countryExpression = oldColumns.has("country_of_supply") ? "COALESCE(country_of_supply, 'India')" : "'India'";
  const placeExpression = oldColumns.has("place_of_supply") ? "COALESCE(place_of_supply, '')" : "''";
  const supplyTypeExpression = oldColumns.has("supply_type") ? "COALESCE(supply_type, 'intra')" : "'intra'";

  db.prepare(`
    INSERT INTO invoices (
      id, user_id, client_id, invoice_number, invoice_kind, billing_month, issue_date, due_date,
      amount, description, item_name, hsn_sac, quantity, rate, gst_rate, country_of_supply,
      place_of_supply, supply_type, created_at
    )
    SELECT
      id,
      ${userExpression},
      client_id,
      invoice_number,
      ${invoiceKindExpression},
      ${billingMonthExpression},
      issue_date,
      due_date,
      amount,
      description,
      ${itemNameExpression},
      ${hsnExpression},
      ${quantityExpression},
      ${rateExpression},
      ${gstRateExpression},
      ${countryExpression},
      ${placeExpression},
      ${supplyTypeExpression},
      created_at
    FROM ${oldTableName}
  `).run(fallbackUserId);

  db.exec(`DROP TABLE ${oldTableName}`);
}

function migrateSessionLogsTable(fallbackUserId) {
  const oldTableName = "session_logs_legacy_multi_user";
  db.exec(`ALTER TABLE session_logs RENAME TO ${oldTableName}`);
  db.exec(`
    CREATE TABLE session_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      session_type TEXT NOT NULL,
      session_date TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL DEFAULT 50,
      fee_amount REAL NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      invoice_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
    )
  `);

  const oldColumns = new Set(db.prepare(`PRAGMA table_info(${oldTableName})`).all().map((column) => column.name));
  const userExpression = oldColumns.has("user_id")
    ? "COALESCE(NULLIF(user_id, ''), (SELECT user_id FROM clients WHERE clients.id = session_logs_legacy_multi_user.client_id), ?)"
    : "COALESCE((SELECT user_id FROM clients WHERE clients.id = session_logs_legacy_multi_user.client_id), ?)";
  const notesExpression = oldColumns.has("notes") ? "COALESCE(notes, '')" : "''";
  const invoiceExpression = oldColumns.has("invoice_id") ? "invoice_id" : "NULL";
  const durationExpression = oldColumns.has("duration_minutes") ? "COALESCE(duration_minutes, 50)" : "50";

  db.prepare(`
    INSERT INTO session_logs (
      id, user_id, client_id, session_type, session_date, duration_minutes, fee_amount, notes, invoice_id, created_at
    )
    SELECT
      id,
      ${userExpression},
      client_id,
      session_type,
      session_date,
      ${durationExpression},
      fee_amount,
      ${notesExpression},
      ${invoiceExpression},
      created_at
    FROM ${oldTableName}
  `).run(fallbackUserId);

  db.exec(`DROP TABLE ${oldTableName}`);
}

function migratePaymentsTable() {
  const oldTableName = "payments_legacy_multi_user";
  db.exec(`ALTER TABLE payments RENAME TO ${oldTableName}`);
  db.exec(`
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    INSERT INTO payments (id, invoice_id, amount, payment_date, method, created_at)
    SELECT id, invoice_id, amount, payment_date, method, created_at
    FROM ${oldTableName}
  `);

  db.exec(`DROP TABLE ${oldTableName}`);
}

function migrateShareLinksTable() {
  const oldTableName = "invoice_share_links_legacy_multi_user";
  db.exec(`ALTER TABLE invoice_share_links RENAME TO ${oldTableName}`);
  db.exec(`
    CREATE TABLE invoice_share_links (
      id TEXT PRIMARY KEY,
      invoice_id TEXT NOT NULL UNIQUE,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    INSERT INTO invoice_share_links (id, invoice_id, token, created_at)
    SELECT id, invoice_id, token, created_at
    FROM ${oldTableName}
  `);

  db.exec(`DROP TABLE ${oldTableName}`);
}

function tableHasColumn(tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((column) => column.name === columnName);
}

function hasCompositeUniqueIndex(tableName, expectedColumns) {
  const indexes = db.prepare(`PRAGMA index_list(${tableName})`).all();

  return indexes.some((index) => {
    if (!index.unique) {
      return false;
    }

    const columns = db.prepare(`PRAGMA index_info(${index.name})`).all().map((column) => column.name);
    return columns.length === expectedColumns.length
      && columns.every((columnName, indexPosition) => columnName === expectedColumns[indexPosition]);
  });
}

function foreignKeyTargetsTable(tableName, targetTableName) {
  return db.prepare(`PRAGMA foreign_key_list(${tableName})`).all().some((foreignKey) => foreignKey.table === targetTableName);
}

function ensureColumnExists(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function backfillOwnership() {
  const firstUser = db.prepare("SELECT id FROM users ORDER BY created_at ASC LIMIT 1").get();

  if (!firstUser) {
    return;
  }

  db.prepare("UPDATE clients SET user_id = ? WHERE user_id IS NULL OR user_id = ''").run(firstUser.id);
  db.prepare(`
    UPDATE invoices
    SET user_id = (
      SELECT clients.user_id
      FROM clients
      WHERE clients.id = invoices.client_id
    )
    WHERE user_id IS NULL OR user_id = ''
  `).run();
  db.prepare(`
    UPDATE session_logs
    SET user_id = (
      SELECT clients.user_id
      FROM clients
      WHERE clients.id = session_logs.client_id
    )
    WHERE user_id IS NULL OR user_id = ''
  `).run();
}

function calculateInvoiceTotals({ quantity = 1, rate = 0, gstRate = 0, supplyType = "intra" }) {
  const taxableAmount = roundCurrency(Number(quantity) * Number(rate));
  const totalTax = roundCurrency(taxableAmount * (Number(gstRate) / 100));
  const intraState = supplyType !== "inter";
  const cgst = intraState ? roundCurrency(totalTax / 2) : 0;
  const sgst = intraState ? roundCurrency(totalTax / 2) : 0;
  const igst = intraState ? 0 : totalTax;
  const total = roundCurrency(taxableAmount + cgst + sgst + igst);

  return {
    taxableAmount,
    cgst,
    sgst,
    igst,
    taxOne: intraState ? cgst : igst,
    taxTwo: intraState ? sgst : 0,
    taxLabelOne: intraState ? "CGST" : "IGST",
    taxLabelTwo: intraState ? "SGST" : "Tax 2",
    total
  };
}

function roundCurrency(value) {
  return Number(Number(value || 0).toFixed(2));
}

function formatPercent(value) {
  return `${formatNumber(value)}%`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(Number(value || 0));
}

function normalizeMonth(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}$/.test(text) ? text : "";
}

function normalizeSessionType(value) {
  return String(value || "").trim().toLowerCase() === "supervision" ? "supervision" : "therapy";
}

function capitalizeWord(value) {
  const text = String(value || "");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function monthLabel(monthValue) {
  if (!monthValue || !/^\d{4}-\d{2}$/.test(monthValue)) {
    return "Unscheduled";
  }

  const [year, month] = monthValue.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function summarizeSessionMix(sessionLogs) {
  const uniqueTypes = [...new Set(sessionLogs.map((sessionLog) => sessionLog.session_type))];
  if (uniqueTypes.length === 1) {
    return uniqueTypes[0];
  }

  return "mixed";
}

function numberToWordsInr(value) {
  const amount = Math.round(Number(value || 0));
  if (amount === 0) {
    return "ZERO RUPEES ONLY";
  }

  const belowTwenty = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  const convertBelowThousand = (n) => {
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    const hundredPart = hundred ? `${belowTwenty[hundred]} HUNDRED` : "";
    const tensPart = remainder < 20
      ? belowTwenty[remainder]
      : `${tens[Math.floor(remainder / 10)]}${remainder % 10 ? ` ${belowTwenty[remainder % 10]}` : ""}`;
    return [hundredPart, tensPart].filter(Boolean).join(" ");
  };

  const parts = [];
  const crore = Math.floor(amount / 10000000);
  const lakh = Math.floor((amount % 10000000) / 100000);
  const thousand = Math.floor((amount % 100000) / 1000);
  const remainder = amount % 1000;

  if (crore) parts.push(`${convertBelowThousand(crore)} CRORE`);
  if (lakh) parts.push(`${convertBelowThousand(lakh)} LAKH`);
  if (thousand) parts.push(`${convertBelowThousand(thousand)} THOUSAND`);
  if (remainder) parts.push(convertBelowThousand(remainder));

  return `${parts.join(" ")} RUPEES ONLY`;
}

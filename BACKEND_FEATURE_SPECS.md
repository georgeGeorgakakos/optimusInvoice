# OptimusInvoice — proposed features: backend work specs

This covers the features that need database / server changes. The frontend-only
features (command palette, keyboard shortcuts, branded empty states, shortcuts
help, CSV/XLSX export util) are already built and included.

Everything below is written against what already exists in `server/` and the
`drizzle` schema. **You must run any migration yourself** — I can't run MySQL
here, and the live `drizzle/schema.ts` wasn't in the upload, so verify column
names before applying.

---

## 1. RBAC — already partially present ✅

`server/_core/trpc.ts` already defines an admin-gated procedure
(`ctx.user.role !== 'admin'`) and `context.ts` sets `role` on the user. So the
primitive exists.

To finish it:
- Add roles beyond `admin` — suggest: `admin`, `approver`, `clerk`, `viewer`.
- Add an `approverProcedure` next to the existing admin one:
  ```ts
  export const approverProcedure = t.procedure.use(({ ctx, next }) => {
    if (!ctx.user || !["admin", "approver"].includes(ctx.user.role))
      throw new TRPCError({ code: "FORBIDDEN" });
    return next({ ctx: { ...ctx, user: ctx.user } });
  });
  ```
- Gate `approvals.submit` / approve / reject with `approverProcedure`.
- Prevent self-approval: in the approve handler, reject if
  `invoice.uploadedByUserId === ctx.user.id`.
- Schema: ensure `users.role` is an enum/varchar with a default of `clerk`.

## 2. Immutable audit log — NEW table

No audit table exists today. Add one (append-only; never UPDATE/DELETE):

```ts
export const auditLog = mysqlTable("audit_log", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull(),
  action: varchar("action", { length: 64 }).notNull(),   // invoice.posted, approval.granted, rule.learned, config.changed
  entityType: varchar("entity_type", { length: 32 }),     // invoice | approval | rule | config
  entityId: int("entity_id"),
  metadata: json("metadata"),                              // before/after diffs, amounts, etc.
  ip: varchar("ip", { length: 45 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- Write a tiny helper `recordAudit(ctx, action, entityType, entityId, metadata)`
  and call it from the mutation handlers that matter (upload, process, approve,
  reject, post-to-ERP, config save, rule create/delete).
- Expose `audit.list` (admin only) with date/action/entity filters.
- Frontend: an "Activity" page or a feed panel — I can build the UI once the
  `audit.list` procedure returns rows.

## 3. Duplicate / fraud detection — NEW, light

No new table strictly required; can be a query.

- On upload/process, flag potential duplicates: same `supplierId` +
  `totalAmount` + invoice date within N days, or identical `invoiceNumber` for a
  supplier.
- Cheap version: add `duplicateOfInvoiceId int NULL` to `invoices`; set it when a
  match is found during processing.
- Expose `invoices.duplicates` returning grouped suspects.
- Frontend: a "Possible duplicates" banner on the invoice detail + a filter chip
  on the list. I can build both once the field/procedure exist.

## 4. Multi-currency / FX — schema touch

- `invoices` already has `totalAmount`. Add `currency varchar(3) default 'EUR'`
  and optionally `fxRate decimal(12,6)` + `baseAmount` (in reporting currency).
- Extraction pipeline already parses numbers locale-robustly; surface the parsed
  currency symbol/code into `currency`.
- Frontend: show the currency next to every amount and let analytics group by it.

## 5. Confidence-driven review queue — mostly frontend ⚠️

Per-field confidence already exists in the VLM output (`extractedData`).
- Backend: add `invoices.minConfidence` (or compute lowest field confidence at
  process time) so the list can filter/sort by it without parsing JSON per row.
- Frontend: a "Needs review" tab that surfaces invoices below a threshold and
  highlights only the low-confidence fields. I can build this UI now if you tell
  me the confidence field name in `extractedData`.

## 6. Export — DONE (frontend) ✅

`client/src/lib/exportInvoices.ts` ships CSV (zero-dep) and optional XLSX
(`npm i xlsx`). The existing InvoiceList page also already has a detailed
myDATA-aware CSV export, which I left intact.

---

### Suggested order
1. Finish RBAC + self-approval guard (small, high trust value).
2. Audit log (procurement gate for your Banking/Insurance/Public Sector buyers).
3. Review queue (biggest day-to-day time saver).
4. Duplicates, then multi-currency.

Tell me which one to take next and share the relevant `drizzle/schema.ts` and I'll
build the migration + router + UI end to end.

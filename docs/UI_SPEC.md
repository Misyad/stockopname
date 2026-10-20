# UI Specification — Stock Opname SPPG PAKISKEMBAR 2

**Status:** Approved v0.1.0 — implementation baseline  
**Frontend:** HTML/CSS/Vanilla JavaScript  
**Priority:** PETUGAS mobile-first; ADMIN/SUPERVISOR desktop-friendly

## 1. UX Principles

1. Data stok lebih penting daripada dekorasi.
2. Dashboard read-only; mutation hanya dari workflow khusus.
3. Satu aksi mutation, satu loading state, satu hasil final.
4. Error harus menyebut field/reference yang salah dan cara memperbaiki.
5. Frontend role visibility hanya UX; API tetap memutuskan authorization.
6. Blind count tidak pernah menampilkan `system_quantity` kepada PETUGAS.
7. Nilai session secret dan `token` tidak disimpan di `localStorage`.

## 2. App Shell dan Navigation

Navigation utama:

```text
Dashboard
Stok
Transaksi
Kartu Stok
Stock Opname
Laporan
Import / Export
```

ADMIN tambahan:

```text
Barang
Kategori
Satuan
Gudang
Supplier
Pengguna
Sistem
```

Mobile memakai bottom navigation untuk Dashboard, Stok, Transaksi, Opname, dan menu Lainnya. Desktop memakai sidebar. Fokus keyboard pindah ke judul halaman setelah navigasi.

## 3. Role Menu Matrix

| Menu/Aksi | ADMIN | SUPERVISOR | PETUGAS |
|---|---:|---:|---:|
| Dashboard/Stok/Kartu Stok | Ya | Ya | Ya |
| Stock IN/OUT | Ya | Ya | Ya |
| Opening stock | Ya | Tidak | Tidak |
| Buat/count opname | Ya | Ya, semua opname | Ya, milik sendiri |
| Approve/reject opname | Ya | Ya | Tidak |
| Laporan | Ya | Ya | Ya |
| Master read | Ya | Ya | Ya |
| Master mutation | Ya | Tidak | Tidak |
| Import | Ya | Tidak | Tidak |
| Backup/rebuild/user | Ya | Tidak | Tidak |
| Health detail | Ya | Ya | Tidak |

Permission gudang dan supplier bersifat global sesuai role.

## 4. Route dan Screen Contract

| Route | Actor | Input utama | Output | API | Acceptance |
|---|---|---|---|---|---|
| `/login` | Publik | email, password | session aktif | `POST /auth/login` | invalid/inactive/rate limit jelas; redirect setelah sukses |
| `/dashboard` | Semua role | filter gudang/periode | cards, recent transactions | `GET /dashboard` | read-only; aggregate, bukan seluruh histori |
| `/stock` | Semua role | q, kategori, gudang, status, page | balance dan batch | `GET /stock` | pagination; expiry kosong tampil `Tanpa expiry` |
| `/transactions/in` | Semua role | stock-in fields | receipt/result | `POST /transactions/stock-in` | confirm; idempotency; tidak double submit |
| `/transactions/out` | Semua role | barang, gudang, qty, unit, alasan | FEFO allocation/result | `POST /transactions/stock-out` | stok kurang ditolak sebelum UI menyatakan sukses |
| `/transactions` | Semua role | filter, page | ledger list | `GET /transactions` | paginated; immutable |
| `/stock-card/:productId` | Semua role | periode, gudang | running balance | `GET /stock-card/:productId` | urut konsisten; total cocok ledger |
| `/opnames` | Semua role | status, gudang, date, page | opname list | `GET /opnames` | role controls benar |
| `/opnames/new` | ADMIN/SUPERVISOR/PETUGAS | gudang, tanggal, notes | DRAFT | `POST /opnames` | snapshot terbentuk |
| `/opnames/:id/count` | owner ADMIN/PETUGAS atau SUPERVISOR | physical qty, reason | saved counts | detail/start/counts/submit | PETUGAS tidak menerima system qty |
| `/opnames/:id/review` | ADMIN/SUPERVISOR | approve/reject reason | final/rejected state | approve/reject | movement-after-snapshot memblokir approval |
| `/imports` | ADMIN | file, type | preview/review/result | import endpoints | preview tidak menulis ledger |
| `/reports` | ADMIN/SUPERVISOR/PETUGAS | type, filter, format | table/CSV | report endpoints | pagination; export CSV streaming |
| `/masters/:type` | ADMIN mutation; lainnya read | q/status/form | master list/result | master endpoints | no hard delete |
| `/users` | ADMIN | user/role/status | user list/result | user endpoints | role invalid ditolak |
| `/system` | ADMIN | backup/rebuild action | health/backup status | maintenance endpoints | destructive-looking action butuh confirm |
| `/forbidden` | Semua | none | denial explanation | none | tidak bocorkan resource sensitif |

Unknown route menampilkan 404 dengan link Dashboard. `401` menghapus UI session state lalu menuju login. `403` menuju forbidden tanpa menghapus session.

## 5. Authentication UI

- Login response wajib mengandung `userId`, `email`, `role`, `token`, `license`; `license` selalu literal publik `SELF_HOSTED`.
- Browser menerima session credential hanya melalui secure HttpOnly cookie.
- `token` adalah reference non-secret; simpan di memory selama page lifecycle bila UI memerlukannya.
- CSRF token diambil dari `GET /auth/csrf`, disimpan di memory, lalu dikirim sebagai `X-CSRF-Token` pada mutation.
- Refresh memanggil `GET /auth/me`, lalu mengambil CSRF token baru.
- Logout memanggil API, membersihkan memory state, lalu redirect.

## 6. Dashboard

Cards:

| Card | Field API | Interaction |
|---|---|---|
| Total barang | `total_products` | link ke Stok |
| Total stok | `total_stock` | read-only |
| Aman/Rendah/Habis | `safe`,`low`,`out` | filter Stok |
| Expired/7d/30d | expiry fields | filter batch expiry |
| Pending opname | `pending_opnames` | link Opname |
| Total adjustment | `total_adjustment` | link report |

Recent transactions dibatasi. Tidak ada tombol edit/delete ledger.

## 7. Stock List

- Filter debounced: q, category, warehouse, status.
- Columns desktop: code, name, warehouse, quantity, unit, min/max, batch status, nearest expiry.
- Mobile card: name/code, quantity, warehouse, status; detail expandable.
- Badge: Aman, Rendah, Habis, Expired, Akan Expired, Tanpa Expiry.
- Empty state membedakan data kosong dan filter tanpa hasil.
- Quantity tampil dalam base unit dengan format locale Indonesia.

## 8. Stock In

Fields wajib: date, reference, warehouse, code, quantity, unit. `idempotencyKey` dibuat client sekali per form submission dan tetap sama saat retry payload sama.

Fields opsional: supplier, batch, production date, expiry, price, notes. Batch kosong tampil sebagai `Tanpa batch`; data disimpan sebagai `NULL` dan digabung per barang+gudang.

Flow:

```text
Edit → Validate client → Review summary → Confirm → Submit → Success receipt
```

Client validation tidak menggantikan server validation. Tombol submit disabled selama request. Retry memakai key sama hanya jika payload tidak berubah.

## 9. Stock Out

- Input quantity harus finite dan > 0.
- UI boleh menampilkan stok tersedia, tetapi server menentukan hasil final di bawah lock.
- FEFO allocation tampil setelah sukses: batch, expiry, quantity.
- Hanya batch belum kedaluwarsa yang dapat dialokasikan; expiry paling dekat dipakai dulu dan tanpa expiry terakhir.
- `INSUFFICIENT_STOCK` menampilkan quantity non-kedaluwarsa yang tersedia dari server.
- Batch kedaluwarsa diberi warning dan tidak dapat dipakai pada normal stock-out; UI tidak menyediakan bypass.

## 10. Stock Card

Header menampilkan barang, base unit, gudang, periode. Table berisi waktu, tipe, reference, batch, masuk, keluar, balance, actor. Tidak ada mutation. Export memakai filter aktif.

## 11. Blind Count Opname

PETUGAS response dan DOM tidak boleh memuat `system_quantity`, difference, atau hidden data ekuivalen sebelum submit.

Flow:

```text
DRAFT → Start → COUNTING → Save counts → Submit → SUBMITTED
SUBMITTED → REJECTED → Start recount → COUNTING
SUBMITTED → APPROVED
```

Count screen:

- daftar barang/batch dan input physical quantity
- progress counted/total
- autosave hanya jika API menyediakan idempotent save; selain itu tombol Simpan eksplisit
- seluruh item wajib counted, termasuk zero
- reason diwajibkan server untuk selisih non-zero saat submit
- recount membersihkan nilai physical/difference/reason/notes lama

## 12. Supervisor Review

Review menampilkan snapshot, physical, difference, value, reason, dan transaction warning. SUPERVISOR boleh mereview dan approve opname yang dihitung sendiri. Approve dan Reject punya modal confirmation. Reject wajib reason. Jika API mengembalikan `STOCK_MOVED_DURING_OPNAME` atau `STOCK_CHANGED_AFTER_OPNAME`, UI tidak menawarkan force approve; arahkan buat recount/opname baru.

## 13. Master Data

Satu reusable list/form pattern untuk products, categories, units, aliases, warehouses, suppliers.

- ADMIN: create/update/deactivate.
- SUPERVISOR/PETUGAS: read-only.
- `REVIEW` terlihat jelas dan tidak boleh dipakai transaksi baru.
- Deactivate menggantikan delete.
- Product form memakai reference picker; tidak membuat category/unit otomatis.

## 14. Import dan OCR Review

```text
Select type/file → Upload → Parse → Validate → Preview → Confirm → Result
```

Preview menampilkan valid, review, rejected, duplicate counts. `STAGING_OCR` tidak punya tombol commit ke ledger. READY stock-in wajib memakai header exact:

```text
date,reference,supplier,warehouse,code,batch,production_date,expiry,quantity,unit,price,notes
```

Confirm disabled jika row `REVIEW` tersisa. File hash dan preview version ditampilkan pada result.

## 15. Reports dan Export

Report type mengikuti `API.md`. Filter tersimpan di URL query agar dapat dibagikan. UI tidak menarik seluruh result untuk export; browser memakai endpoint streaming CSV. Nilai kosong, zero, dan unavailable dibedakan.

## 16. System Screen

Cards: app/database health, schema, negative stock, reconciliation, backup age, last verified restore. Backup dan rebuild hanya ADMIN.

Rebuild modal menampilkan urutan `BACKUP → LOCK → REBUILD → RECONCILE → AUDIT`; pengguna mengetik `REBUILD` untuk confirm. UI tidak menyediakan production restore; restore dijalankan operator melalui runbook terkontrol.

## 17. Shared State Contract

Setiap async screen mendukung:

- initial loading dengan skeleton atau text status
- empty state
- actionable error dengan retry aman
- success confirmation
- forbidden state
- offline/network failure tanpa klaim mutation gagal atau sukses sebelum status diketahui
- stale-session handling

Unknown mutation result memakai status `Hasil belum diketahui`; user dilarang submit dengan key baru sebelum query/retry idempotent selesai.

## 18. Modal Contract

Semua modal:

1. punya title dan accessible description
2. focus trap saat terbuka
3. initial focus aman, bukan destructive button
4. tutup melalui Batal, backdrop, dan Escape kecuali request sedang commit
5. mengembalikan focus ke trigger
6. membersihkan overlay/body lock saat close
7. mencegah duplicate submit

## 19. Responsive Rules

- `< 768px`: one-column forms, cards atau horizontal table scroll, sticky primary action.
- `768–1199px`: two-column forms bila label tetap terbaca.
- `>= 1200px`: sidebar tetap dan dense tables.
- Tap target minimal 44×44 CSS px.
- Jangan menentukan layout berdasarkan desktop-app flag; viewport menjadi sumber keputusan responsive.

## 20. Accessibility

- Native semantic controls sebelum custom widget.
- Setiap input punya visible label dan error association.
- Keyboard order mengikuti visual order.
- Focus indicator terlihat.
- Status async memakai `aria-live` seperlunya.
- Color bukan satu-satunya penanda status.
- Dialog memakai `role=dialog`, `aria-modal=true`.
- Contrast text/control memenuhi WCAG AA.

## 21. Component Inventory

`AppShell`, `Sidebar`, `BottomNav`, `PageHeader`, `FilterBar`, `DataTable`, `MobileCardList`, `StatusBadge`, `Pagination`, `Field`, `ReferenceSelect`, `QuantityInput`, `DateInput`, `Modal`, `ConfirmDialog`, `Toast`, `InlineError`, `EmptyState`, `LoadingState`.

Komponen tetap Vanilla JavaScript modules; jangan menambah framework tanpa approval.

## 22. UI Acceptance Gate

PASS jika:

- seluruh route punya actor, input, output, state, API, acceptance
- PETUGAS blind response/DOM tidak memuat system quantity
- dashboard tidak punya mutation
- role controls cocok API dan negative API tests tetap ada
- semua mutation punya confirm/loading/final state
- modal keyboard/backdrop/Escape/focus cleanup lulus
- mobile stock-in/out/opname dapat dipakai pada viewport 360px
- sensitive session data tidak ada di `localStorage`
- accessibility smoke lulus keyboard dan screen-reader labels

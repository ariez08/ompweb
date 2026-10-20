# OmpWeb — Branch Lineage & Fork Navigator Integration

| | |
|---|---|
| **Target Branch** | `feat/branch-lineage-fork-navigator` |
| **Baseline** | OmpWeb `5.2.0` (`custom/stable-prod` @ `2c759af`) |
| **Status** | **Planned (Tersimpan dalam Plan)** |
| **Scope** | Menyatukan konsep *Session Fork* (file-level) dan *In-Session Tree* (turn-level) ke dalam panel navigasi `BranchNavigator` di toolbar atas agar silsilah cabang transparan dan dapat dinavigasi bolak-balik. |

---

## 1. Latar Belakang & Masalah UX

Saat ini terdapat dua mekanisme percabangan terpisah di OMPWeb:
1. **File-Level Fork (`parentSession` di JSONL)**: Dibuat melalui tombol *Fork Session*, menghasilkan file sesi baru di disk yang tampil sebagai turunan di sidebar kiri.
2. **Turn-Level Branch (`parentId` di Entry)**: Dibuat saat turn pesan di-edit/regenerate di dalam file yang sama, dinavigasi melalui panel icon cabang (`BranchNavigator`) di toolbar atas.

### Masalah UX
Ketika user menekan tombol **`Fork Session`**, Web UI langsung berpindah ke sesi anak baru. Di sesi baru ini, karena riwayat pesannya baru berupa garis lurus (*linear*), panel icon cabang menampilkan:
> *"This session has no branches"*

User mengira tombol Fork gagal bekerja atau fiturnya rusak, padahal sesi hasil fork sudah terbentuk di sidebar kiri.

---

## 2. Solusi Desain: Branch Lineage Panel

Panel `BranchNavigator` di toolbar atas akan ditingkatkan menjadi navigator silsilah lengkap:

```
┌────────────────────────────────────────────────────────┐
│ Branches & Fork Lineage                                │
├────────────────────────────────────────────────────────┤
│ ↖ Forked from: Implement endpoint API hot-swapping     │
│   (Click to navigate back to parent session)           │
├────────────────────────────────────────────────────────┤
│ IN-SESSION TURNS                                       │
│ ├─ Turn 1: Setup project                               │
│ └─ Turn 2: Add endpoint [Active]                       │
│    (Linear history · No alternate message branches)    │
├────────────────────────────────────────────────────────┤
│ SESSION FORKS (2 children)                             │
│ ├─ 🌿 Implement endpoint API hot-swapping (Fork A)     │
│ └─ 🌿 Implement endpoint API hot-swapping (Fork B)     │
├────────────────────────────────────────────────────────┤
│ [ ⑂ Fork Session ]  Create a new branch from here      │
└────────────────────────────────────────────────────────┘
```

### Komponen Teknis:
1. **Parent Link**:
   - Jika `session.parentSessionId` ada: tampilkan header kartu *"Forked from: [Parent Name]"* dengan tombol lompat kembali ke sesi induk.
2. **Child Forks List**:
   - Query dari daftar sesi yang memiliki `parentSessionId === currentSession.id`.
   - Menampilkan daftar anak cabang yang pernah dibuat dari sesi ini, sehingga user bisa berpindah antar cabang langsung dari toolbar atas.
3. **Turn-Level Trees**:
   - Menampilkan pohon alternatif respon jika ada; jika tidak ada, beri keterangan jelas: *"Linear thread (no alternate turn branches)"* agar tidak rancu dengan ketiadaan fork.

---

## 3. Tahapan Implementasi

1. **API / Data Hook**:
   - Di `SessionSidebar` / `AppShell`, sediakan selector `getForksForSession(sessionId)` dan `getParentSession(sessionId)` dari cache daftar sesi aktif.
2. **Komponen `BranchNavigator.tsx`**:
   - Tambahkan prop `parentSession?: SessionInfo | null` dan `childForks?: SessionInfo[]`.
   - Render section `Fork Lineage` di atas daftar turn tree.
3. **Internasionalisasi (i18n)**:
   - Tambahkan token di `en.json`, `ja.json`, dan `zh-CN.json`.
4. **Verifikasi**:
   - Uji alur: Buat fork -> verifikasi parent link muncul di sesi baru -> klik parent link -> verifikasi child forks list menampilkan sesi baru.

# OmpWeb — Workspace & Per-Session Capabilities Toggle (Tools, MCP, Skills)

| | |
|---|---|
| **Target Branch** | `feat/capabilities-toggle` (bercabang dari `feat/multi-profile-live` @ `4dd0052`) |
| **Baseline** | OmpWeb `5.1.9` + Multi-Profile Live + Session CLI Lock Guard |
| **Status** | **Rancangan Rinci (Plan)** |
| **Scope** | Kontrol token granular untuk tools (native + MCP) dan skills per-workspace & per-session dengan model-awareness mid-chat |

---

## 1. Latar Belakang & Analisis Token (ROI)

Berdasarkan telemetri memori runtime langsung dari OMP engine (`cli.js`), setiap giliran prompt saat ini selalu membawa baseline **~14.167 token** di *system prompt*, bahkan untuk percakapan teks biasa:

```
┌────────────────────────────────────────────────────────────────────────┐
│ TOTAL SYSTEM PROMPT: ~14.167 token / turn                              │
├───────────────────────────────┬───────────────────┬────────────────────┤
│ Komponen                      │ Ukuran Karakter   │ Beban Token / Turn │
├───────────────────────────────┼───────────────────┼────────────────────┤
│ 16 Definisi Tool (JSON Schema)│ 20.981 chars      │ ~5.245 token       │
│ - task (subagent engine)      │  3.192 chars      │   ~798 token       │
│ - eval (sandbox python/js)    │  2.951 chars      │   ~737 token       │
│ - edit (surgical diff patcher)│  2.172 chars      │   ~543 token       │
│ - read (file & url reader)    │  2.129 chars      │   ~532 token       │
│ - todo (task tracker)         │  1.658 chars      │   ~414 token       │
│ - ask (clarification)         │  1.524 chars      │   ~381 token       │
│ - bash (shell executor)       │  1.259 chars      │   ~314 token       │
│ - 4 Server MCP bawaan         │ ~3.300 chars      │   ~825 token       │
│ - Tool lainnya (glob, grep...)│ ~2.700 chars      │   ~675 token       │
│ Katalog Skills (<skills>)     │  3.338 chars      │   ~834 token       │
│ Aturan Workspace (<repo-rules>)│ 19.879 chars     │ ~4.969 token       │
│ Instruksi Dasar OMP           │ ~12.500 chars     │ ~3.125 token       │
└───────────────────────────────┴───────────────────┴────────────────────┘
```

### Dampak Pemborosan:
- Percakapan 20 giliran yang hanya butuh `read` + `edit` + `bash` membuang **~86.000 token** hanya untuk deklarasi tool/skill yang tidak pernah disentuh.
- Model kecil atau model reasoning sering terdistraksi (*hallucination / miss-target*) karena terlalu banyak opsi tool yang bersaing di system prompt.

---

## 2. Keputusan Arsitektur

### D-1: Manfaatkan Kapabilitas Bawaan OMP Engine (`cli.js`)
Engine OMP sudah mendukung pembatasan ini secara native:
- `--tools=<list>` atau `--no-tools` membatasi definisi tool JSON schema yang dikirim ke LLM.
- `--skills=<glob>` atau `--no-skills` membatasi katalog `<skills>` di system prompt.
- `--resume <file>` **dapat digabung** dengan `--tools` dan `--skills` (sudah diverifikasi pada sesi riset).

### D-2: Model Awareness & Zero-Corruption Mid-Chat Swap
Jika user mengubah toggle capabilities di tengah chat:
1. **Lapis Skema LLM**: Begitu turn berikutnya dipanggil, payload API ke model hanya memuat tool yang aktif. Model tidak bisa memanggil tool yang mati.
2. **Lapis Konteks (System Notice)**: OmpWeb menyuntikkan 1 baris notifikasi sistem terarah ke pesan turn tersebut:
   `[System: Capabilities updated. Active tools: read, edit, bash. Active skills: simrs-*. Disabled: eval, task]`
3. **Safe Idle Respawn**: Child proses OMP di-respawn dengan flag baru saat idle (~150ms). Jika sedang *busy* (agent sedang generate/menjalankan tool), perubahan di-queue dan baru berlaku saat turn selesai.

### D-3: Dua Tingkat Persistensi (Workspace vs Session)
1. **Per-Workspace (Default)**: Disimpan ke `<workspace>/.omp/config.yml` menggunakan setting resmi OMP:
   - `skills.includeSkills: [...]`
   - `skills.enabled: boolean`
   - `disabledExtensions: ["tool:eval", "mcp:server_name", "skill:name"]`
2. **Per-Session (Override)**: Disimpan di metadata sesi (`SessionInfo.capabilities`) dan di-pass via argumen spawn saat sesi di-resume.

---

## 3. Invariant Keras

1. **Anti-Breakage**: Mode default adalah `Full Agent` (identik dengan perilaku saat ini) — user yang tidak menyentuh toggle tidak akan mengalami perubahan apa pun.
2. **Non-Destructive**: Mengubah toggle di tengah percakapan tidak boleh memecah sesi (`session_split`), tidak boleh mengorup `.jsonl`, dan tidak boleh reload halaman.
3. **Tool Minimal Invariant**: Tool `read` dan `write` (atau `edit`) tidak boleh dimatikan jika mode eksekusi kode aktif, untuk mencegah agent terjebak tidak bisa merespons perubahan file.
4. **Theme & UI Standard**: Sesuai aturan keras user: **Dilarang emoji**, wajib CSS tokens (`var(--bg-panel)`, `var(--border)`, `var(--accent)`), typography ringkas enterprise-grade.

---

## 4. Peta File yang Disentuh

```
ompweb/
├── lib/
│   ├── capabilities-types.ts         # [BARU] Tipe data Preset, ToolItem, SkillItem, McpItem
│   ├── capabilities-service.ts       # [BARU] Scanner & resolver tools/skills per workspace
│   ├── tool-presets.ts               # [UPDATE] Perluasan preset (chat, code, full, custom)
│   ├── rpc-manager.ts                # [UPDATE] buildSessionSpawnArgs teruskan --tools & --skills pada --resume
│   └── session-cli-lock.ts           # [STABIL] Tidak berubah
├── app/api/
│   ├── capabilities/
│   │   └── route.ts                  # [BARU] GET: daftar tools, MCP, skills aktif di workspace
│   └── agent/
│       ├── new/route.ts              # [UPDATE] Terima toolNames & skillPatterns saat spawn baru
│       └── [id]/
│           └── capabilities/route.ts # [BARU] POST: update capabilities sesi live (mid-session swap)
├── components/
│   ├── CapabilitiesPicker.tsx        # [BARU] Dropdown popover di samping Thinking dropdown
│   ├── ChatInput.tsx                 # [UPDATE] Mount tombol CapabilitiesPicker di toolbar chat
│   └── ChatWindow.tsx                # [UPDATE] Sambungkan event & state capabilities ke ChatInput
└── lib/i18n/locales/
    ├── en.json                       # [UPDATE] Teks lokalisasi capabilities, presets, notice
    ├── ja.json                       # [UPDATE]
    └── zh-CN.json                    # [UPDATE]
```

---

## 5. Rencana Eksekusi per Fase

### Fase 1: Kontrak & Backend Capability Bridge

#### Task 1.1: Tipe Data & Presets
**Files:**
- Create: `lib/capabilities-types.ts`
- Modify: `lib/tool-presets.ts`

```typescript
// lib/capabilities-types.ts
export type CapabilityPreset = "chat_only" | "code_editor" | "full_agent" | "custom";

export interface SessionCapabilities {
  preset: CapabilityPreset;
  tools?: string[];        // Daftar nama tool yang aktif, e.g. ["read", "bash", "edit"]
  skills?: string[];       // Pola glob skill yang aktif, e.g. ["simrs-*"]
  disabledMcp?: string[];  // Nama server MCP yang dimatikan
}
```

#### Task 1.2: Teruskan `--tools` dan `--skills` pada `--resume` di `rpc-manager.ts`
**Files:**
- Modify: `lib/rpc-manager.ts:152-175`

```typescript
export function buildSessionSpawnArgs(
  sessionFile: string,
  toolNames?: string[],
  advisor = false,
  skillPatterns?: string[],
): string[] {
  const args: string[] = [];
  if (sessionFile) {
    args.push("--resume", sessionFile);
  }
  // Tetap terapkan --tools dan --skills meskipun sesi di-resume
  if (toolNames !== undefined) {
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (skillPatterns !== undefined) {
    if (skillPatterns.length === 0) {
      args.push("--no-skills");
    } else {
      args.push("--skills", skillPatterns.join(","));
    }
  }
  if (advisor) args.push("--advisor");
  return args;
}
```

---

### Fase 2: Endpoint API Discovery & Hot-Swap

#### Task 2.1: `GET /api/capabilities`
Mengembalikan katalog lengkap yang tersedia di workspace saat itu:
- Daftar tool bawaan OMP (`read`, `bash`, `edit`, `eval`, `task`, `todo`, dll.).
- Daftar server MCP yang terkonfigurasi di `mcp.json`.
- Daftar skills yang terdeteksi di workspace + user directory.
- Preset aktif saat ini dari config workspace.

#### Task 2.2: `POST /api/agent/[id]/capabilities` (Mid-Session Hot-Swap)
1. Validasi session ID dan kepemilikan.
2. Jika sesi sedang idle:
   - Sisipkan pesan sistem di transkrip: `[System: Capabilities updated by user...]`
   - Panggil `wrapper.restartWithArgs({ toolNames, skillPatterns })` via `destroyAndWait()` + re-spawn dalam ~150ms.
3. Jika sesi sedang busy (running command/prompt):
   - Simpan sebagai `pendingCapabilities`. Begitu event `agent_end` tiba, server otomatis me-respawn child sebelum prompt berikutnya.

---

### Fase 3: Komponen UI `CapabilitiesPicker.tsx`

Tampilan ringkas dan minimalis sesuai standar tema enterprise:

```
[ Model: Claude Sonnet 4.6 ▾ ]  [ Thinking: Auto ▾ ]  [ Capabilities: Code (4 tools) ▾ ]
```

#### Struktur Popover Panel:
1. **Bagian Preset Cepat (Paling Atas)**:
   - 🟢 **Chat Only**: 0 tool, 0 skill. *(Hemat ~6.000 token/turn)*.
   - 🔵 **Code Editor**: `read`, `edit`, `write`, `bash` + skill proyek. *(Hemat ~3.700 token/turn)*.
   - 🟣 **Full Agent**: Semua tool, subagent `task`, `eval`, MCP.
   - ⚙️ **Custom**: Menampilkan accordion checklist di bawah.

2. **Bagian Accordion Checklist (Jika Custom)**:
   - **Built-in Tools**: Checkbox per tool (`eval`, `task`, `todo`, `ask`, `glob`, `grep`, dll.).
   - **MCP Servers**: Checkbox per server MCP (`gitlab_repo_simrskartini`, `manage_omp`, dll.).
   - **Skills**: Checkbox per skill atau filter pattern.

3. **Bagian Footer Popover**:
   - Selector Lingkup: `Hanya Sesi Ini` | `Simpan ke Workspace (.omp/config.yml)`
   - Badge Estimasi Token yang dihemat: misal `Hemat ~3.500 token/turn`.

---

### Fase 4: Model Awareness Prompt Injection

Di `app/api/agent/[id]/route.ts` saat prompt berikutnya dikirim setelah perubahan:
- Jika terjadi perubahan capabilities di tengah sesi, sertakan context notice di prompt:
  ```json
  {
    "type": "custom",
    "customType": "capabilities_update_notice",
    "data": {
      "activeTools": ["read", "bash", "edit"],
      "disabledTools": ["eval", "task"],
      "message": "Notice: User updated active capabilities. Disabled tools cannot be called."
    }
  }
  ```
- Ini menjamin model tidak mengulang loop pemanggilan tool yang baru saja dimatikan.

---

### Fase 5: Verifikasi & Gerbang Pengujian

1. **Uji Coba Token Baseline (Benchmark)**:
   - Hitung system prompt sebelum vs sesudah memilih preset `Chat Only` $\rightarrow$ Buktikan penurunan ~6.000 token secara terukur.
   - Hitung preset `Code Editor` $\rightarrow$ Buktikan penurunan ~3.700 token.
2. **Uji Coba Mid-Session Hot-Swap**:
   - Mulai sesi di `Full Agent`.
   - Kirim prompt 1: *"Coba cek file README.md"*.
   - Ubah toggle ke `Chat Only` di UI.
   - Kirim prompt 2: *"Tolong jalankan bash ls"*.
   - **Hasil Diharapkan**: Model sadar bahwa tool bash tidak tersedia, menjawab via teks biasa tanpa crash/error.
3. **Uji Coba Workspace Persistence**:
   - Pilih simpan ke workspace $\rightarrow$ Verifikasi file `<workspace>/.omp/config.yml` terbuat/ter-update dengan benar.
4. **Gerbang Standar**:
   - `bun run typecheck` 0 error.
   - `node scripts/audit-client-api.mjs --check` in sync.
   - `node scripts/audit-error-codes.mjs --check` in sync.
   - Full JS test suite tetap hijau.

---

## 6. Pertimbangan Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Model halusinasi memanggil tool yang sudah dimatikan | Tool call gagal / error loop | Definition JSON Schema langsung dicabut dari API + disuntikkan 1 baris system notice. |
| User mematikan tool `read` saat coding | Agent buta tidak bisa membaca kode | Tool `read` diberi status *recommended core* dan dicegah mati jika mode coding aktif. |
| Respawn saat turn aktif memutus pekerjaan | Sesi rusak / terpotong | Jika status `sessionBusy`, perubahan di-*latch* dan baru di-respawn begitu `agent_end` selesai. |
| Konflik file lock CLI saat swap | Session split | Menggunakan instance wrapper internal `destroyAndWait` yang sudah ada, tanpa memicu `open-elsewhere`. |

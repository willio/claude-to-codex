# Codex with Claude

[English](README.md) | **Bahasa Indonesia** | [简体中文](README.zh-CN.md)

**Claude yang mikir. Codex jadi bekerja.**

Pakai Claude Web (free atau paid) untuk merencanakan, menganalisis, dan meninjau. Codex yang mengeksekusi — keduanya terhubung melalui MCP bridge yang aman dan read-only.

**Tanpa Claude API key. Tanpa reverse proxy.** Claude terhubung ke endpoint MCP yang dilindungi OAuth dan hanya membaca data workspace yang dibutuhkan.

- **Satu connector, banyak project.** Hubungkan Claude sekali. Menambah, berpindah, atau menutup project tidak memerlukan connector, OAuth, atau pairing baru.
- **Read-only sejak awal.** Claude tidak memiliki tool untuk menulis file, menjalankan shell, commit, atau mengeksekusi perintah. Codex tetap menjadi satu-satunya eksekutor.
- **Terisolasi per workspace.** Project didaftarkan secara lokal. Claude hanya melihat workspace ID yang opaque, bukan filesystem root secara bebas, dan setiap akses file dibatasi ke workspace yang diberikan.
- **Local-first.** Source code tetap berada di mesin Anda dan hanya bagian yang dibutuhkan yang diberikan kepada Claude melalui request MCP read-only.

## Cara kerjanya

```text
Claude Web (plan · reason · review)
    │
    │  OAuth sekali · satu connector
    ▼
C2C Broker ─────── endpoint /mcp yang stabil
    │
    │  opaque workspace capabilities
    │
    ├── Project A   ◄── Codex session
    ├── Project B   ◄── Codex session
    └── Project C
              ▲
              │  edit · shell · git · tests
              │
        Codex (execute · repair)
```

Claude memeriksa code, diff, status Git, dan hasil test yang telah direkam melalui broker, lalu memberikan rencana kerja kepada Codex. Codex adalah satu-satunya komponen yang melakukan perubahan.

Semua capability yang tersedia untuk Claude bersifat read-only. Workspace didaftarkan secara lokal oleh Codex/C2C dan diakses menggunakan ID opaque. Setiap path dicanonicalize dan dibatasi di dalam workspace yang diberikan, sementara file sensitif seperti `.env`, private key, dan credential ditolak.

## Quick start

Persyaratan: Node.js ≥ 20, `git`, `cloudflared`, dan Claude Web dengan dukungan custom connector.

```bash
git clone https://github.com/willio/codex-with-claude.git
cd codex-with-claude
pnpm install
pnpm build
npm install -g .
```

Install Codex skill:

```bash
mkdir -p ~/.codex/skills/codex-with-claude
cp skill/SKILL.md ~/.codex/skills/codex-with-claude/
```

### Hubungkan Claude — cukup sekali

Dari project pertama:

```bash
cd ~/Projects/your-project
c2c setup
```

C2C menjalankan broker dan memberikan endpoint MCP serta pairing code sekali pakai.

Di Claude Web:

**Customize → Connectors → Add custom connector**

Masukkan URL `/mcp`, selesaikan OAuth, lalu masukkan pairing code.

Pairing code berlaku sekitar lima menit. Jika diperlukan, buat kode baru saat halaman authorization masih terbuka:

```bash
c2c pair
```

Itulah satu-satunya konfigurasi yang perlu dilakukan di sisi Claude.

### Tambahkan project lain

```bash
cd ~/Projects/another-project
codex
```

Codex skill mendaftarkan workspace tersebut ke instalasi C2C yang sama. Tidak diperlukan connector Claude baru, authorization OAuth baru, maupun pairing ulang.

Untuk URL connector permanen, gunakan named Cloudflare tunnel:

```bash
c2c tunnel choose --mode named --zone <domain>
```

Endpoint yang stabil direkomendasikan untuk satu connector yang akan terus digunakan di Claude. Quick Tunnel tetap berguna untuk development dan pengujian sementara.

## Loop

```text
INIT → PLAN → EXECUTED → REVIEW → DONE
```

Claude mengambil context yang dibutuhkan melalui MCP sehingga file dan diff tidak perlu ditempel secara manual ke conversation.

Codex menjalankan rencana tersebut dan mencatat hasilnya:

```bash
c2c record --task <id> --iteration <n> --tests "27 passed"
```

Claude kemudian dapat memeriksa diff, status Git, dan hasil yang direkam secara independen sebelum menyelesaikan task.

### MCP tools

Semua tool bersifat read-only:

```text
list_workspaces
workspace_info
list_directory
read_file
search_workspace
git_status
git_diff
test_status
execution_summary
```

`test_status` dan `execution_summary` hanya membaca hasil yang sebelumnya telah direkam oleh Codex. Keduanya tidak dapat menjalankan command atau test.

## Model keamanan

**Tidak ada mutation surface.** MCP server tidak menyediakan tool untuk menulis file, menjalankan shell atau command, melakukan commit, maupun bentuk mutasi lainnya. Seluruh otoritas eksekusi tetap berada pada Codex.

**Authorization pada level instalasi.** Claude mengotorisasi satu instalasi C2C, bukan masing-masing project. OAuth menggunakan Dynamic Client Registration, PKCE dengan S256, pairing code berumur pendek, refresh-token rotation, dan revocation.

**Workspace sebagai capability.** Claude hanya dapat mengakses workspace yang telah didaftarkan secara lokal ke C2C. Workspace ID yang tidak dikenal, tidak tersedia, atau telah dicabut akan ditolak secara default. Path traversal dan symlink escape dicegah melalui canonical-path containment.

**Tidak ada akses filesystem bebas.** Claude bekerja dengan identitas workspace yang opaque. Claude tidak dapat menentukan direktori lain di komputer dan menjadikannya workspace secara sepihak.

**Isi repository dianggap tidak tepercaya.** Source code, dokumentasi, issue, dan isi workspace lainnya diperlakukan sebagai data, bukan sebagai sumber otorisasi.

**Pairing berumur pendek.** Proses pairing membentuk authorization tanpa mengekspos credential jangka panjang di browser.

Lihat [docs/security.md](docs/security.md) untuk threat model, [docs/multi-workspace.md](docs/multi-workspace.md) untuk arsitektur workspace, dan [docs/local-e2e.md](docs/local-e2e.md) untuk validasi end-to-end.

## CLI

```text
c2c setup
c2c start
c2c status
c2c doctor
c2c pair
c2c unpair
c2c record
c2c tunnel
c2c session
c2c logs
c2c sandbox-allow
c2c stop
```

Semua command mendukung `--json` untuk kebutuhan tooling.

`c2c doctor` mendiagnosis dan memperbaiki sisi lokal jika memungkinkan. Jika endpoint publik berubah dan connector Claude perlu ditambahkan ulang, C2C akan menjelaskan tindakan yang diperlukan.

Untuk kompatibilitas, `doctor --json` menggunakan `connectorRepair` sebagai field utama dan sementara tetap mempertahankan `chatgptRepair` sebagai alias deprecated.

## Kompatibilitas

Codex with Claude berawal dari ide dan arsitektur `codex-with-chatgpt`, kemudian berkembang menjadi implementasi independen.

Arsitektur saat ini menggunakan satu connector Claude pada level instalasi untuk melayani banyak workspace Codex yang didaftarkan secara lokal.

Kompatibilitas dengan instalasi C2C sebelumnya dipertahankan secara non-destruktif:

- Bridge per-project yang lama tetap didukung selama masa migrasi.
- State directory `codex-with-chatgpt` yang lama dapat diadopsi.
- Field dan alias kompatibilitas hanya dihapus melalui perubahan versi yang eksplisit.

Lihat [docs/migration.md](docs/migration.md).

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

CI menjalankan typecheck, test, dan build pada setiap push.

Area source utama:

```text
src/broker/       installation endpoint and routing
src/mcp/          read-only MCP tools
src/auth/         OAuth 2.1
src/workspaces/   workspace registry and sessions
src/bridge/       per-project bridge compatibility
src/cli/          C2C command-line interface
docs/             architecture, protocol, security and migration
```

## Credits

Codex with Claude dibangun di atas ide dan arsitektur asli [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt) karya [@XiaoDuoYa](https://github.com/XiaoDuoYa).

Project ini kemudian berkembang menjadi implementasi independen untuk Claude Web, dengan tetap menjaga atribusi untuk karya upstream dan copyright MIT-nya di [LICENSE](LICENSE).

Codex with Claude adalah project komunitas tidak resmi dan tidak berafiliasi dengan maupun didukung oleh Anthropic atau OpenAI.

## License

[MIT](LICENSE)

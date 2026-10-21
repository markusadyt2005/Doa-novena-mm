# Ruang Novena — pengingat iPhone

Web doa dan absen yang sama, ditambah pengingat Web Push setiap hari pukul **00.00 WIB**. Satu rangkaian doa lengkap tetap dihitung satu absen. Data absen, nama, dan intensi masih lokal di tiap browser/perangkat; pembaruan ini tidak menyinkronkannya. Hanya data langganan push perangkat (endpoint dan kunci enkripsi) yang disimpan di server.

## Aktivasi sekali di Vercel

1. Gabungkan perubahan ini ke `main`. Vercel akan memasang dependency dan menjalankan `npm run build`. Halaman tersedia di `/` dan `/ruang-novena.html`; file sumber tetap `ruang-novena.html`.
2. Di proyek Vercel, buka **Storage / Marketplace**, hubungkan **Upstash Redis**, lalu pilih database untuk proyek ini. Integrasi biasanya menambahkan `KV_REST_API_URL` dan `KV_REST_API_TOKEN` secara otomatis. Aplikasi langsung membaca keduanya; **tidak perlu menyalin ulang dengan nama UPSTASH**. Database ini menyimpan pendaftaran kedua iPhone secara persisten, bukan hitungan doa.
3. Buka `https://doa-novena.vercel.app/setup-keys.html`, tekan **Buat kunci untuk proyek saya**, lalu salin tiga nilainya ke Vercel. Kunci dibuat di browsermu, tidak dikirim ke server, dan akan hilang bila halaman ditutup. Alternatif dari komputer: di folder repo jalankan `npm install`, lalu `npm run setup:keys`. **Jangan unggah nilai rahasianya ke GitHub atau HTML**. Buat satu kali dan simpan nilainya. Mengganti pasangan VAPID mengharuskan iPhone mendaftar ulang.
4. Buka **Vercel → proyek → Settings → Environment Variables**. Pastikan dua variabel database dari integrasi tersedia untuk **Production**, lalu tambahkan empat variabel lainnya di tabel berikut.
5. **Redeploy** deployment Production setelah variabel tersimpan. Jika integrasi Redis menambahkan variabel ke Preview saja, tambahkan juga ke Production. Di **Settings → Cron Jobs**, pastikan `/api/pengingat-doa` aktif. Penjadwalan produksi tidak berjalan pada Preview.

| Variabel | Nilai |
| --- | --- |
| `APP_ORIGIN` | `https://doa-novena.vercel.app` (tanpa `/` di akhir; ganti bila domain utama berubah) |
| `KV_REST_API_URL` | REST URL dari database, biasanya sudah dibuat otomatis oleh integrasi |
| `KV_REST_API_TOKEN` | REST token biasa yang dapat membaca **dan menulis**, biasanya sudah dibuat otomatis oleh integrasi |
| `VAPID_PUBLIC_KEY` | Hasil `npm run setup:keys` |
| `VAPID_PRIVATE_KEY` | Hasil `npm run setup:keys`; rahasia |
| `CRON_SECRET` | Hasil `npm run setup:keys`; rahasia; Vercel menyertakannya sebagai `Authorization: Bearer …` |

Untuk database yang diatur manual, pasangan `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` juga didukung. Jika kedua pasangan lengkap, pasangan `UPSTASH_...` diprioritaskan. Pasangan yang belum lengkap diabaikan; URL dan token dari dua pasangan tidak dicampur. `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`, dan `REDIS_URL` tidak digunakan oleh pengingat.

Vercel menggunakan UTC. Jadwal `0 17 * * *` berarti setiap pukul 00.00 WIB pada hari berikutnya. **Pada paket Hobby, Vercel dapat memanggil jadwal kapan saja antara 00.00–00.59 WIB.** Paket Pro memiliki presisi per menit; pengantaran ke HP tetap dipengaruhi koneksi, izin, dan mode Fokus. Jangan menjanjikan alarm tepat waktu dari Web Push.

Jika memerlukan pemanggilan lebih dekat ke 00.00 tanpa Vercel Pro, gunakan scheduler eksternal yang mendukung zona `Asia/Jakarta` pada 00.00 (atau UTC 17.00) untuk melakukan GET ke `https://doa-novena.vercel.app/api/pengingat-doa`, dengan header `Authorization: Bearer <CRON_SECRET>`. Nonaktifkan jadwal Vercel bila memilih scheduler lain. Kode juga membatasi satu pengiriman sukses per perangkat per tanggal WIB agar pemanggilan ganda tidak mengirim ulang. Secret harus di header, jangan di URL atau repo. Scheduler maupun push tetap tidak menjamin penerimaan tepat detik.

## Lakukan pada kedua iPhone

1. Gunakan **iOS 16.4 atau lebih baru** dan buka alamat domain utama di Safari.
2. Tekan **Bagikan → Tambahkan ke Layar Utama**. Jika tersedia, aktifkan **Buka sebagai App Web**.
3. Buka **Ruang Novena dari ikon di Layar Utama**, bukan dari tab Safari.
4. Pada kartu Pengingat doa, tekan **Aktifkan pengingat**, lalu **Izinkan**.
5. Tekan **Tes notifikasi**. Periksa Pusat Notifikasi. Satu tes per menit per perangkat; tombol ini benar-benar mengirim push dari server, bukan notifikasi lokal palsu.
6. Ulangi di iPhone pasangan. Mematikan pengingat pada satu perangkat tidak mematikan perangkat lainnya.

Izin notifikasi hanya diminta setelah pengguna menekan tombol. Jika sebelumnya ditolak, izinkan kembali di **Pengaturan iPhone → Notifikasi → Ruang Novena**. Pastikan mode Fokus atau Ringkasan Terjadwal tidak menunda notifikasi. Notifikasi tidak menambah hitungan absen secara otomatis.

**Catatan data iPhone:** penyimpanan aplikasi dari Layar Utama dapat terpisah dari tab Safari. Hitungan yang sebelumnya dibuat di tab Safari belum tentu terlihat di aplikasi yang dipasang. Pemasangan ini tidak memindahkan atau menghapusnya; tetap dapat dibuka dari browser lama. Nama dan intensi tidak dikirim dalam notifikasi.

## Verifikasi

- `npm test`: tes terisolasi untuk pergantian tanggal WIB, autentikasi jadwal, dua perangkat, deduplikasi, langganan kedaluwarsa, percobaan kirim ulang, izin dari sentuhan pengguna, dan kegagalan penyimpanan. Transport Redis/push dipalsukan; tes tidak mengirim notifikasi kepada pengguna.
- `npm run build`: menghasilkan HTML, ikon, manifest, script pengingat, dan service worker ke `dist/`.
- `npm run dev`: pratinjau lokal di `http://127.0.0.1:8767`; API berjalan tanpa konfigurasi dengan status pengingat belum disiapkan. Aktifkan variabel yang diperlukan hanya bila ingin menguji backend sendiri. Untuk pengujian nyata iPhone, gunakan domain HTTPS Production.
- Buka `/api/push-config`: `configured: true` menunjukkan variabel lolos validasi lokal; ini belum membuktikan koneksi Redis atau pengiriman Apple berhasil.
- Bukti menyeluruh: kedua iPhone berhasil **Tes notifikasi**, kemudian pada eksekusi terjadwal log fungsi menunjukkan `sent: 2`. Respons job tidak memuat endpoint perangkat atau rahasia.

Endpoint tidak menerima target push sembarang, menolak permintaan lintas origin, membatasi frekuensi pendaftaran/tes, dan menghapus subscription saat provider mengembalikan 404/410. Tes dan pembatalan memerlukan kepemilikan kunci subscription perangkat. Token database, VAPID private key, dan cron secret hanya berada di server. Tidak ada file `.env` nyata dalam repo.

## Rujukan resmi

- [Apple: Web Push untuk aplikasi web](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
- [WebKit: Web Push pada iOS dan iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- [Vercel: jadwal dan UTC](https://vercel.com/docs/cron-jobs)
- [Vercel: presisi jadwal Hobby](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi)
- [web-push](https://github.com/web-push-libs/web-push)

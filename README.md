# FloodSense

Implementasi penuh dashboard pemantauan banjir berdasarkan proyek Google Stitch. Stack:

- Backend: Node.js, Express, Zod, Socket.io
- Frontend: Vue 3, Vite, Tailwind CSS
- Database: PostgreSQL (`pg` pool)
- Simulator: tiga node Hulu, Tengah, dan Hilir

## Menjalankan dengan Docker (disarankan)

Salin `.env.example` menjadi `.env`, lalu isi `MAPBOX_PUBLIC_TOKEN` dengan public token Mapbox yang diawali `pk.`. Token cukup menggunakan scope baca/list dan sebaiknya dibatasi ke URL aplikasi.

```bash
docker compose up --build
```

Buka `http://localhost:5173`. API tersedia di `http://localhost:3001` dan simulator otomatis mengirim data setiap 3 detik.

Map View memakai Mapbox Standard bertema monochrome/night. Label POI, jalan, transit, bangunan 3D, dan batas administratif disembunyikan agar peta fokus pada koridor Sungai Ciliwung dan tiga node sensor.

## Menjalankan untuk pengembangan

Jalankan PostgreSQL, salin `.env.example` menjadi `.env`, lalu:

```bash
npm install
npm --prefix backend install
npm --prefix frontend install
npm run dev
```

Di terminal lain:

```bash
npm run simulator
```

## API

- `POST /api/readings` — menerima dan memvalidasi payload sensor
- `GET /api/readings?limit=100&sensor_id=node_hilir_01` — riwayat pembacaan
- `GET /api/nodes` — metadata node beserta pembacaan terakhir
- `GET /api/health` — status API

Contoh payload:

```json
{
  "sensor_id": "node_hilir_01",
  "lokasi": "Hilir",
  "water_level_cm": 185.5,
  "flow_rate": 45.2,
  "timestamp": "2026-08-15T10:00:00.000Z"
}
```

Status dihitung backend: Normal `< 120 cm`, Waspada `120–179.99 cm`, Bahaya `>= 180 cm`.

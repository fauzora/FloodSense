import pg from "pg";
import { SENSOR_SOURCE_URL, sensorNodes } from "./sensor-nodes.js";

const { Pool } = pg;
const RIVER_COVERAGE_PROVINCES = [
  "Banten",
  "DKI Jakarta",
  "Daerah Istimewa Yogyakarta",
  "Jawa Barat",
  "Jawa Tengah",
  "Jawa Timur",
];

export async function initializeSchema(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;

    CREATE TABLE IF NOT EXISTS sensor_nodes (
      sensor_id VARCHAR(40) PRIMARY KEY,
      lokasi VARCHAR(20) NOT NULL,
      latitude NUMERIC(10, 7) NOT NULL,
      longitude NUMERIC(10, 7) NOT NULL,
      station_name VARCHAR(120),
      river_name VARCHAR(120),
      province VARCHAR(80),
      source_name VARCHAR(120),
      source_url TEXT,
      telemetry_mode VARCHAR(20) NOT NULL DEFAULT 'simulated',
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS station_name VARCHAR(120);
    ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS river_name VARCHAR(120);
    ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS province VARCHAR(80);
    ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS source_name VARCHAR(120);
    ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS source_url TEXT;
    ALTER TABLE sensor_nodes ADD COLUMN IF NOT EXISTS telemetry_mode VARCHAR(20) NOT NULL DEFAULT 'simulated';

    CREATE TABLE IF NOT EXISTS sensor_readings (
      id BIGSERIAL PRIMARY KEY,
      sensor_id VARCHAR(40) NOT NULL REFERENCES sensor_nodes(sensor_id),
      water_level_cm NUMERIC(8, 2) NOT NULL,
      flow_rate NUMERIC(8, 2) NOT NULL,
      risk_status VARCHAR(20) NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      warning_threshold_cm NUMERIC(8, 2) NOT NULL,
      danger_threshold_cm NUMERIC(8, 2) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (danger_threshold_cm > warning_threshold_cm)
    );

    INSERT INTO system_settings
      (id, warning_threshold_cm, danger_threshold_cm)
    VALUES (TRUE, 120, 180)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS java_province_boundaries (
      id BIGSERIAL PRIMARY KEY,
      province VARCHAR(80) NOT NULL,
      source_code VARCHAR(10),
      geom geometry(Geometry, 4326) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS indonesia_provinces (
      province VARCHAR(80) PRIMARY KEY,
      source_code VARCHAR(10),
      geom geometry(Geometry, 4326) NOT NULL,
      display_geom geometry(Geometry, 4326)
    );
    ALTER TABLE indonesia_provinces
      ADD COLUMN IF NOT EXISTS display_geom geometry(Geometry, 4326);

    CREATE TABLE IF NOT EXISTS indonesia_boundary (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
      geom geometry(Geometry, 4326) NOT NULL,
      mask_geom geometry(Geometry, 4326) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS river_segments (
      source_object_id INTEGER PRIMARY KEY,
      name VARCHAR(250),
      river_type SMALLINT,
      river_class SMALLINT,
      feature_code VARCHAR(255),
      remarks VARCHAR(250),
      watershed_region VARCHAR(100),
      basin VARCHAR(100),
      status VARCHAR(50),
      width_max_m DOUBLE PRECISION,
      discharge_max_m3s DOUBLE PRECISION,
      slope_avg DOUBLE PRECISION,
      length_m DOUBLE PRECISION NOT NULL,
      provinces TEXT,
      geom geometry(Geometry, 4326) NOT NULL,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS river_import_runs (
      id BIGSERIAL PRIMARY KEY,
      source_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      imported_count INTEGER,
      status VARCHAR(20) NOT NULL DEFAULT 'running'
    );

    CREATE INDEX IF NOT EXISTS idx_readings_sensor_time
      ON sensor_readings(sensor_id, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_river_segments_geom
      ON river_segments USING GIST(geom);
    CREATE INDEX IF NOT EXISTS idx_river_segments_name
      ON river_segments(LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_java_provinces_geom
      ON java_province_boundaries USING GIST(geom);
    CREATE INDEX IF NOT EXISTS idx_indonesia_provinces_geom
      ON indonesia_provinces USING GIST(geom);

  `);

  for (const node of sensorNodes) {
    await pool.query(`
      INSERT INTO sensor_nodes
        (sensor_id, lokasi, latitude, longitude, station_name, river_name,
         province, source_name, source_url, telemetry_mode)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'simulated')
      ON CONFLICT (sensor_id) DO UPDATE SET
        lokasi = EXCLUDED.lokasi,
        latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        station_name = EXCLUDED.station_name,
        river_name = EXCLUDED.river_name,
        province = EXCLUDED.province,
        source_name = EXCLUDED.source_name,
        source_url = EXCLUDED.source_url,
        telemetry_mode = EXCLUDED.telemetry_mode
    `, [node.sensor_id, node.lokasi, node.latitude, node.longitude,
      node.station_name, node.river_name, node.province,
      "Pos BPBD/Dinas SDA · geometri sungai BIG", SENSOR_SOURCE_URL]);
  }
}

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  const pool = new Pool({ connectionString });

  return {
    async initialize() {
      await initializeSchema(pool);
    },

    async insertReading(reading) {
      const result = await pool.query(
        `INSERT INTO sensor_readings
          (sensor_id, water_level_cm, flow_rate, risk_status, recorded_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sensor_id, water_level_cm::float, flow_rate::float,
                   risk_status, recorded_at AS timestamp`,
        [reading.sensor_id, reading.water_level_cm, reading.flow_rate,
          reading.risk_status, reading.timestamp],
      );
      return { ...result.rows[0], lokasi: reading.lokasi };
    },

    async getHistory({ sensorId, limit }) {
      const values = [];
      const filters = [];
      if (sensorId) {
        values.push(sensorId);
        filters.push(`r.sensor_id = $${values.length}`);
      }
      values.push(limit);
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const result = await pool.query(
        `SELECT r.id, r.sensor_id, n.lokasi, r.water_level_cm::float,
                r.flow_rate::float, r.risk_status, r.recorded_at AS timestamp
         FROM sensor_readings r
         JOIN sensor_nodes n USING (sensor_id)
         ${where}
         ORDER BY r.recorded_at DESC
         LIMIT $${values.length}`,
        values,
      );
      return result.rows;
    },

    async getNodes() {
      const result = await pool.query(`
        SELECT n.sensor_id, n.lokasi, n.latitude::float, n.longitude::float,
               n.station_name, n.river_name, n.province, n.source_name,
               n.source_url, n.telemetry_mode,
               r.water_level_cm::float, r.flow_rate::float,
               r.risk_status, r.recorded_at AS timestamp
        FROM sensor_nodes n
        LEFT JOIN LATERAL (
          SELECT * FROM sensor_readings
          WHERE sensor_id = n.sensor_id
          ORDER BY recorded_at DESC LIMIT 1
        ) r ON true
        ORDER BY CASE n.lokasi WHEN 'Hulu' THEN 1 WHEN 'Tengah' THEN 2 ELSE 3 END,
                 n.sensor_id
      `);
      return result.rows;
    },

    async getThresholds() {
      const result = await pool.query(`
        SELECT warning_threshold_cm::float AS warning_cm,
               danger_threshold_cm::float AS danger_cm,
               updated_at
        FROM system_settings WHERE id = TRUE
      `);
      return result.rows[0];
    },

    async updateThresholds({ warning_cm, danger_cm }) {
      const result = await pool.query(`
        UPDATE system_settings
        SET warning_threshold_cm = $1,
            danger_threshold_cm = $2,
            updated_at = NOW()
        WHERE id = TRUE
        RETURNING warning_threshold_cm::float AS warning_cm,
                  danger_threshold_cm::float AS danger_cm,
                  updated_at
      `, [warning_cm, danger_cm]);
      return result.rows[0];
    },

    async getRiverStats() {
      const result = await pool.query(`
        SELECT COUNT(*)::int AS segments,
               COUNT(DISTINCT NULLIF(NULLIF(BTRIM(name), ''), 'Anonim'))::int AS named_rivers,
               COALESCE(ROUND((SUM(length_m) / 1000)::numeric, 1), 0)::float AS total_length_km,
               MAX(imported_at) AS imported_at
        FROM river_segments
      `);
      return result.rows[0];
    },

    async getRegions() {
      const provincesResult = await pool.query(`
        SELECT p.province, p.source_code,
               p.province = ANY($1::text[]) AS filterable,
               ARRAY[
                 ST_XMin(Box3D(p.geom)), ST_YMin(Box3D(p.geom)),
                 ST_XMax(Box3D(p.geom)), ST_YMax(Box3D(p.geom))
               ]::float[] AS bounds,
               ARRAY[
                 ST_XMin(Box3D(main.geom)), ST_YMin(Box3D(main.geom)),
                 ST_XMax(Box3D(main.geom)), ST_YMax(Box3D(main.geom))
               ]::float[] AS focus_bounds,
               ST_AsGeoJSON(p.display_geom, 3) AS geometry
        FROM indonesia_provinces p
        CROSS JOIN LATERAL (
          SELECT part.geom
          FROM ST_Dump(p.geom) AS part
          ORDER BY ST_Area(part.geom::geography) DESC
          LIMIT 1
        ) main
        ORDER BY p.province
      `, [RIVER_COVERAGE_PROVINCES]);
      const maskResult = await pool.query(`
        SELECT ST_AsGeoJSON(mask_geom, 3) AS geometry
        FROM indonesia_boundary
        WHERE id = TRUE
      `);
      const features = provincesResult.rows.map((row) => ({
        type: "Feature",
        properties: {
          province: row.province,
          source_code: row.source_code,
          filterable: row.filterable,
          bounds: row.bounds,
          focus_bounds: row.focus_bounds,
        },
        geometry: JSON.parse(row.geometry),
      }));
      return {
        provinces: { type: "FeatureCollection", features },
        mask: {
          type: "Feature",
          properties: {},
          geometry: JSON.parse(maskResult.rows[0].geometry),
        },
        filterable: features
          .filter((feature) => feature.properties.filterable)
          .map((feature) => feature.properties.province),
      };
    },

    async getRiverTile({ z, x, y, province = null }) {
      const result = await pool.query(`
        WITH bounds AS (
          SELECT ST_TileEnvelope($1, $2, $3) AS geom
        ), render_options AS (
          SELECT CASE
            WHEN $1 <= 6 THEN 0.0108
            WHEN $1 = 7 THEN 0.0045
            WHEN $1 = 8 THEN 0.0016
            WHEN $1 = 9 THEN 0.00054
            WHEN $1 = 10 THEN 0.00018
            WHEN $1 = 11 THEN 0.00007
            ELSE 0.000018
          END AS tolerance_degrees
        ), tile_rows AS (
          SELECT r.source_object_id AS id,
                 NULLIF(NULLIF(BTRIM(r.name), ''), 'Anonim') AS name,
                 r.river_type AS type,
                 CASE WHEN $1 >= 10 THEN r.river_class END AS class,
                 CASE WHEN $1 >= 10 THEN r.remarks END AS remarks,
                 CASE WHEN $1 >= 10 THEN r.watershed_region END AS watershed,
                 CASE WHEN $1 >= 10 THEN r.basin END AS basin,
                 CASE WHEN $1 >= 10 THEN r.status END AS status,
                 CASE WHEN $1 >= 10 THEN ROUND(r.length_m)::int END AS length_m,
                 CASE WHEN $1 >= 10 THEN ROUND(r.width_max_m::numeric, 1)::float END AS width_m,
                 CASE WHEN $1 >= 10 THEN ROUND(r.discharge_max_m3s::numeric, 1)::float END AS discharge_m3s,
                 CASE WHEN $1 >= 10 THEN ROUND(r.slope_avg::numeric, 3)::float END AS slope,
                 CASE WHEN $1 >= 10 THEN r.provinces END AS provinces,
                 ST_AsMVTGeom(
                   ST_Transform(
                     ST_Simplify(ST_Force2D(r.geom), render_options.tolerance_degrees),
                     3857
                   ),
                   bounds.geom, 2048, 32, true
                 ) AS geom
          FROM river_segments r, bounds, render_options
          WHERE r.geom && ST_Transform(bounds.geom, 4326)
            AND ($4::text IS NULL OR $4 = ANY(string_to_array(r.provinces, ', ')))
            AND ($1 >= 10
              OR ($1 = 9 AND (NULLIF(BTRIM(r.name), '') IS NOT NULL OR r.length_m >= 1000))
              OR ($1 = 8 AND r.length_m >= 5000)
              OR ($1 = 7
                AND NULLIF(NULLIF(BTRIM(r.name), ''), 'Anonim') IS NOT NULL
                AND r.length_m >= 10000)
              OR ($1 <= 6
                AND NULLIF(NULLIF(BTRIM(r.name), ''), 'Anonim') IS NOT NULL
                AND r.length_m >= 30000))
        )
        SELECT ST_AsMVT(tile_rows, 'rivers', 2048, 'geom') AS tile
        FROM tile_rows
      `, [z, x, y, province]);
      return result.rows[0].tile;
    },

    async close() {
      await pool.end();
    },
  };
}

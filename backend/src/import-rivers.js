import "dotenv/config";
import pg from "pg";
import { initializeSchema } from "./database.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const forceImport = process.env.FORCE_RIVER_IMPORT === "true";
const batchSize = 1000;

const riverService = "https://geoservices.big.go.id/rbi/rest/services/BASEMAP/Rupabumi_Indonesia/MapServer/566";
const riverQueryUrl = `${riverService}/query`;
const provinceQueryUrl = "https://geoservices.big.go.id/rbi/rest/services/BATASWILAYAH/BATAS_WILAYAH/MapServer/12/query";

async function fetchArcGis(url, params) {
  const target = new URL(url);
  target.search = new URLSearchParams(params).toString();
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "ArcGIS query gagal");
      return body;
    } catch (error) {
      lastError = error;
      console.warn(`Percobaan ${attempt} gagal: ${error.message}`);
    }
  }
  throw lastError;
}

async function importProvinceBoundaries() {
  const catalog = await fetchArcGis(provinceQueryUrl, {
    f: "json",
    where: "1=1",
    outFields: "wadmpr,kdppum",
    returnGeometry: "false",
  });
  const provinceNames = [...new Set(catalog.features.map((feature) => feature.attributes.wadmpr))];
  const rows = [];
  let nextProvince = 0;
  const worker = async () => {
    while (nextProvince < provinceNames.length) {
      const province = provinceNames[nextProvince];
      nextProvince += 1;
      const data = await fetchArcGis(provinceQueryUrl, {
        f: "geojson",
        where: `wadmpr='${province.replaceAll("'", "''")}'`,
        outFields: "wadmpr,kdppum",
        outSR: "4326",
        returnGeometry: "true",
        geometryPrecision: "4",
        maxAllowableOffset: "0.001",
      });
      rows.push(...data.features.map((feature) => ({
        province: feature.properties.wadmpr,
        source_code: feature.properties.kdppum,
        geometry: feature.geometry,
      })));
    }
  };
  await Promise.all(Array.from({ length: 6 }, () => worker()));
  await pool.query("TRUNCATE java_province_boundaries RESTART IDENTITY");
  await pool.query(`
    INSERT INTO java_province_boundaries (province, source_code, geom)
    SELECT x.province, x.source_code,
           ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(x.geometry::text), 4326))
    FROM jsonb_to_recordset($1::jsonb)
      AS x(province text, source_code text, geometry jsonb)
  `, [JSON.stringify(rows)]);
  console.log(`${rows.length} bagian batas provinsi Indonesia dimuat.`);
}

async function buildRegionGeometry() {
  await pool.query(`
    TRUNCATE indonesia_provinces, indonesia_boundary;
    INSERT INTO indonesia_provinces (province, source_code, geom)
    SELECT province, MIN(source_code),
           ST_UnaryUnion(ST_Collect(ST_CollectionExtract(ST_MakeValid(geom), 3)))
    FROM java_province_boundaries
    GROUP BY province;

    WITH parts AS (
      SELECT province, (ST_Dump(geom)).geom AS geom
      FROM indonesia_provinces
    ), display AS (
      SELECT province,
             ST_Collect(ST_MakeValid(ST_Simplify(geom, 0.02))) AS geom
      FROM parts
      WHERE ST_Area(geom::geography) >= 50000000
      GROUP BY province
    )
    UPDATE indonesia_provinces p
    SET display_geom = d.geom
    FROM display d
    WHERE p.province = d.province;

    WITH country AS (
      SELECT ST_UnaryUnion(ST_Collect(ST_MakeValid(display_geom))) AS geom
      FROM indonesia_provinces
    )
    INSERT INTO indonesia_boundary (id, geom, mask_geom)
    SELECT TRUE, geom,
           ST_Difference(
             ST_MakeEnvelope(-180, -85, 180, 85, 4326),
             geom
           )
    FROM country;
    ANALYZE indonesia_provinces;
  `);
  console.log("Geometri provinsi dan mask Indonesia siap digunakan.");
}

function riverRows(features) {
  return features.map((feature) => ({
    source_object_id: feature.properties.OBJECTID,
    name: feature.properties.NAMOBJ,
    river_type: feature.properties.TIPSNG,
    river_class: feature.properties.KLSSNG,
    feature_code: feature.properties.FCODE,
    remarks: feature.properties.REMARK,
    watershed_region: feature.properties.NAMWS,
    basin: feature.properties.NAMDAS,
    status: feature.properties.STATUS,
    width_max_m: feature.properties.WMAX,
    discharge_max_m3s: feature.properties.DBTMAX,
    slope_avg: feature.properties.SLPRT,
    geometry: feature.geometry,
  }));
}

async function insertRiverBatch(features) {
  await pool.query(`
    INSERT INTO river_segments_stage (
      source_object_id, name, river_type, river_class, feature_code, remarks,
      watershed_region, basin, status, width_max_m, discharge_max_m3s,
      slope_avg, length_m, geom
    )
    SELECT x.source_object_id, x.name, x.river_type, x.river_class,
           x.feature_code, x.remarks, x.watershed_region, x.basin, x.status,
           x.width_max_m, x.discharge_max_m3s, x.slope_avg,
           ST_Length(parsed.geom::geography), parsed.geom
    FROM jsonb_to_recordset($1::jsonb) AS x(
      source_object_id integer, name text, river_type smallint, river_class smallint,
      feature_code text, remarks text, watershed_region text, basin text,
      status text, width_max_m double precision, discharge_max_m3s double precision,
      slope_avg double precision, geometry jsonb
    )
    CROSS JOIN LATERAL (
      SELECT ST_CollectionExtract(ST_MakeValid(
        ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(x.geometry::text), 4326))
      ), 2) AS geom
    ) parsed
    WHERE x.geometry IS NOT NULL AND NOT ST_IsEmpty(parsed.geom)
    ON CONFLICT (source_object_id) DO NOTHING
  `, [JSON.stringify(riverRows(features))]);
}

async function runImport() {
  await initializeSchema(pool);
  const boundaries = await pool.query("SELECT COUNT(DISTINCT province)::int AS count FROM java_province_boundaries");
  if (boundaries.rows[0].count < 30) await importProvinceBoundaries();
  const preparedRegions = await pool.query(`
    SELECT COUNT(display_geom)::int AS count,
           COALESCE(SUM(ST_NPoints(display_geom)), 0)::int AS points
    FROM indonesia_provinces
  `);
  if (preparedRegions.rows[0].count < 30 || preparedRegions.rows[0].points > 10000) {
    await buildRegionGeometry();
  }
  const current = await pool.query("SELECT COUNT(*)::int AS count FROM river_segments");
  if (current.rows[0].count > 0 && !forceImport) {
    console.log(`Database sungai sudah berisi ${current.rows[0].count} ruas; impor dilewati.`);
    return;
  }

  const run = await pool.query(`
    INSERT INTO river_import_runs (source_name, source_url)
    VALUES ('Badan Informasi Geospasial — RBI Sungai (Garis)', $1)
    RETURNING id
  `, [riverService]);
  const runId = run.rows[0].id;

  try {
    await pool.query(`
      CREATE UNLOGGED TABLE IF NOT EXISTS river_segments_stage
        (LIKE river_segments INCLUDING DEFAULTS);
      CREATE UNIQUE INDEX IF NOT EXISTS river_segments_stage_source_object_id_uq
        ON river_segments_stage(source_object_id);
    `);

    const commonQuery = {
      where: "1=1",
      geometry: "105,-9,114.75,-5.5",
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
    };
    const countResult = await fetchArcGis(riverQueryUrl, {
      f: "json",
      ...commonQuery,
      returnCountOnly: "true",
    });
    console.log(`${countResult.count} kandidat ruas tersedia pada RBI 1:25.000.`);

    const staged = await pool.query("SELECT COUNT(*)::int AS count FROM river_segments_stage");
    if (staged.rows[0].count >= countResult.count * 0.99) {
      console.log(`${staged.rows[0].count} ruas staging digunakan kembali.`);
    } else {
      let nextOffset = 0;
      let processed = 0;
      const importWorker = async () => {
        while (true) {
          const offset = nextOffset;
          nextOffset += batchSize;
          if (offset >= countResult.count) return;
          const data = await fetchArcGis(riverQueryUrl, {
            f: "geojson",
            ...commonQuery,
            outFields: "OBJECTID,NAMOBJ,TIPSNG,KLSSNG,FCODE,REMARK,NAMWS,NAMDAS,STATUS,WMAX,DBTMAX,SLPRT",
            outSR: "4326",
            returnGeometry: "true",
            geometryPrecision: "5",
            maxAllowableOffset: "0.00001",
            orderByFields: "OBJECTID",
            resultOffset: String(offset),
            resultRecordCount: String(batchSize),
          });
          await insertRiverBatch(data.features);
          processed += data.features.length;
          console.log(`${processed}/${countResult.count} ruas sungai diterima dari BIG.`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, () => importWorker()));
    }

    await pool.query(`
      CREATE INDEX IF NOT EXISTS river_segments_stage_geom
        ON river_segments_stage USING GIST(geom);
      ANALYZE river_segments_stage;

      UPDATE river_segments_stage r
      SET provinces = matched.provinces
      FROM (
        SELECT s.source_object_id,
               string_agg(DISTINCT p.province, ', ' ORDER BY p.province) AS provinces
        FROM river_segments_stage s
        JOIN indonesia_provinces p ON ST_Intersects(s.geom, p.geom)
        WHERE p.province IN (
          'Banten', 'DKI Jakarta', 'Daerah Istimewa Yogyakarta',
          'Jawa Barat', 'Jawa Tengah', 'Jawa Timur'
        )
        GROUP BY s.source_object_id
      ) matched
      WHERE r.source_object_id = matched.source_object_id;

      DELETE FROM river_segments_stage WHERE provinces IS NULL;
    `);

    const imported = await pool.query("SELECT COUNT(*)::int AS count FROM river_segments_stage");
    await pool.query("BEGIN");
    try {
      await pool.query("TRUNCATE river_segments");
      await pool.query(`
        INSERT INTO river_segments
        SELECT source_object_id, name, river_type, river_class, feature_code,
               remarks, watershed_region, basin, status, width_max_m,
               discharge_max_m3s, slope_avg, length_m, provinces, geom, NOW()
        FROM river_segments_stage
      `);
      await pool.query(`
        UPDATE river_import_runs
        SET completed_at = NOW(), imported_count = $1, status = 'completed'
        WHERE id = $2
      `, [imported.rows[0].count, runId]);
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    await pool.query("DROP TABLE river_segments_stage");
    console.log(`Impor selesai: ${imported.rows[0].count} ruas sungai Pulau Jawa tersimpan.`);
  } catch (error) {
    await pool.query(`
      UPDATE river_import_runs SET completed_at = NOW(), status = 'failed' WHERE id = $1
    `, [runId]);
    throw error;
  }
}

runImport()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

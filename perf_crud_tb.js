import sql from 'k6/x/sql';
import driver from 'k6/x/sql/driver/postgres';
import faker from 'k6/x/faker';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';

/* ---------- configuration ---------- */
const pgConn = 'postgres://sa:sa@localhost:5432/testdb?sslmode=disable';
const db = sql.open(driver, pgConn);

/* custom metrics */
const insertTrend = new Trend('db_insert_duration');
const updateTrend = new Trend('db_update_duration');
const selectTrend = new Trend('db_select_duration');
const deleteTrend = new Trend('db_delete_duration');
const rowsInserted = new Counter('rows_inserted');
const rowsUpdated  = new Counter('rows_updated');
const rowsSelected = new Counter('rows_selected');
const rowsDeleted  = new Counter('rows_deleted');
const insertOk = new Rate('insert_success');
const updateOk = new Rate('update_success');
const selectOk = new Rate('select_success');
const deleteOk = new Rate('delete_success');

/* ---------- lifecycle ---------- */
export function setup() {
  db.exec(`CREATE SCHEMA IF NOT EXISTS tb;`);
  db.exec(`
    DROP TABLE IF EXISTS tb.perf_test;
    CREATE TABLE tb.perf_test (
      id          SERIAL PRIMARY KEY,
      first_name  VARCHAR(80)  NOT NULL,
      last_name   VARCHAR(80)  NOT NULL,
      email       VARCHAR(255) NOT NULL UNIQUE,
      updated_at  TIMESTAMP DEFAULT NOW()
    );
  `);
}

export function teardown() {
  db.exec('DROP TABLE IF EXISTS tb.perf_test;');
  db.close();
}

/* ---------- scenario ---------- */
export const options = {
  stages: [
    { duration: '5s',  target: 10 },
    { duration: '20s', target: 50 },
    { duration: '5s',  target: 0 },
  ],
  thresholds: {
    'db_insert_duration': ['p(95)<50'],   // Use p(95) not p95
    'db_select_duration': ['avg<20'],
    'insert_success':     ['rate>0.99'],
  },
};

export default function () {
  const person = {
    firstName: faker.person.firstName(),
    lastName:  faker.person.lastName(),
    email:     faker.person.email(),
  };

  /* INSERT ------------------------------------------------- */
  let t0 = Date.now();
  let rows = db.query(
    `INSERT INTO tb.perf_test(first_name, last_name, email)
     VALUES ($1, $2, $3) RETURNING id;`,
    person.firstName, person.lastName, person.email
  );
  insertTrend.add(Date.now() - t0);
  
  // Get the ID from the returned row
  const id = rows.length > 0 ? rows[0].id : null;
  
  if (id) {
    rowsInserted.add(1);
    insertOk.add(true);
    
    /* UPDATE ------------------------------------------------- */
    t0 = Date.now();
    let res = db.exec(
      `UPDATE tb.perf_test
       SET last_name = $1, updated_at = NOW()
       WHERE id = $2;`,
      faker.person.lastName(), id
    );
    updateTrend.add(Date.now() - t0);
    rowsUpdated.add(res.rowsAffected());
    updateOk.add(res.rowsAffected() === 1);
    
    /* SELECT ------------------------------------------------- */
    t0 = Date.now();
    rows = db.query('SELECT * FROM tb.perf_test WHERE id = $1;', id);
    selectTrend.add(Date.now() - t0);
    rowsSelected.add(rows.length);
    selectOk.add(rows.length === 1);
    
    /* DELETE ------------------------------------------------- */
    t0 = Date.now();
    res = db.exec('DELETE FROM tb.perf_test WHERE id = $1;', id);
    deleteTrend.add(Date.now() - t0);
    rowsDeleted.add(res.rowsAffected());
    deleteOk.add(res.rowsAffected() === 1);
    
    check(res, { 'crud_round_ok': r => r.rowsAffected() === 1 });
  } else {
    insertOk.add(false);
    console.error('Failed to insert record');
  }
}
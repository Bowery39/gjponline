import { DatabaseSync } from 'node:sqlite';
import { standardAccounts } from './accounting.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export function validPassword(password, hash) {
  if (!hash || typeof password !== 'string' || password.length > 128) return false;
  return timingSafeEqual(Buffer.from(passwordHash(password, hash.split(':')[0])), Buffer.from(hash));
}

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS opening_state (
      id INTEGER PRIMARY KEY CHECK(id=1),opened INTEGER NOT NULL,date TEXT NOT NULL,revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opening_manual (account INTEGER PRIMARY KEY REFERENCES master(id),amount INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      hash TEXT NOT NULL, role TEXT NOT NULL, department TEXT NOT NULL DEFAULT '',
      warehouses TEXT NOT NULL DEFAULT '[]', active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_permissions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_settings (
      id INTEGER PRIMARY KEY CHECK (id=1), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_settings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
      defaults_json TEXT NOT NULL DEFAULT '{}', fields_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (user_id,type)
    );
    CREATE TABLE IF NOT EXISTS product_categories (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS partner_categories (path TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS master (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL DEFAULT '{}',
      created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(kind,code)
    );
    CREATE TABLE IF NOT EXISTS sequences (
      prefix TEXT, date TEXT, value INTEGER NOT NULL, PRIMARY KEY(prefix,date)
    );
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY, number TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
      date TEXT NOT NULL, status TEXT NOT NULL, partner INTEGER REFERENCES master(id),
      warehouse INTEGER REFERENCES master(id), target INTEGER REFERENCES master(id),
      department TEXT NOT NULL, creator INTEGER NOT NULL REFERENCES users(id),
      total INTEGER NOT NULL, data TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS document_search ON documents(type,status,date,id);
    CREATE TABLE IF NOT EXISTS lines (
      doc INTEGER REFERENCES documents(id), position INTEGER, product INTEGER REFERENCES master(id),
      quantity INTEGER NOT NULL, price INTEGER NOT NULL, net INTEGER NOT NULL, tax INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(doc,position)
    );
    CREATE TABLE IF NOT EXISTS stock (
      product INTEGER REFERENCES master(id), warehouse INTEGER REFERENCES master(id),
      quantity INTEGER NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(product,warehouse)
    );
    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY, doc INTEGER REFERENCES documents(id), position INTEGER NOT NULL,
      date TEXT NOT NULL, product INTEGER REFERENCES master(id), warehouse INTEGER REFERENCES master(id),
      quantity INTEGER NOT NULL, value INTEGER NOT NULL, incoming INTEGER NOT NULL, cost_method TEXT NOT NULL,
      batch TEXT NOT NULL, expiry TEXT NOT NULL, serials TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS movement_search ON movements(product,warehouse,date,id);
    CREATE TABLE IF NOT EXISTS lots (
      product INTEGER REFERENCES master(id), warehouse INTEGER REFERENCES master(id),
      batch TEXT NOT NULL, expiry TEXT NOT NULL, quantity INTEGER NOT NULL,
      PRIMARY KEY(product,warehouse,batch)
    );
    CREATE TABLE IF NOT EXISTS serials (
      product INTEGER REFERENCES master(id), serial TEXT, warehouse INTEGER REFERENCES master(id),
      batch TEXT NOT NULL, PRIMARY KEY(product,serial)
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY, doc INTEGER REFERENCES documents(id), date TEXT NOT NULL,
      category TEXT NOT NULL, entity INTEGER REFERENCES master(id), amount INTEGER NOT NULL,
      reference INTEGER REFERENCES documents(id)
    );
    CREATE INDEX IF NOT EXISTS ledger_search ON ledger(category,entity,date);
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY, doc INTEGER NOT NULL REFERENCES documents(id),
      name TEXT NOT NULL, content BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS statement_links (
      token TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), expires INTEGER NOT NULL,
      statement TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY, doc INTEGER NOT NULL REFERENCES documents(id), date TEXT NOT NULL,
      code TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, entity INTEGER REFERENCES master(id),
      amount INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS journal_search ON journal_entries(date,category,code);
    CREATE TABLE IF NOT EXISTS closes (month TEXT PRIMARY KEY, user_id INTEGER REFERENCES users(id), created TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      detail TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return {
    db,
    all: (sql, ...args) => db.prepare(sql).all(...args),
    one: (sql, ...args) => db.prepare(sql).get(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    tx(action) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = action();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}
export function seed(store, password, demo) {
  if (store.one('SELECT id FROM users LIMIT 1')) return;
  store.tx(() => {
    store.run('INSERT INTO users(username,name,hash,role) VALUES (?,?,?,?)','admin','系统管理员',passwordHash(password),'admin');
    const add = (kind,code,name,data={}) => store.run('INSERT INTO master(kind,code,name,data) VALUES (?,?,?,?)',kind,code,name,JSON.stringify(data)).lastInsertRowid;
    for (const [code,name,category] of Object.values(standardAccounts)) add('ledgerAccounts',code,name,{category});
    if (!demo) return;
    add('warehouses','WH-01','中心仓');
    add('warehouses','WH-02','门店仓');
    add('partners','S-001','青禾日用品供应商',{type:'supplier',phone:'010-55550101'});
    add('partners','C-001','晨光社区门店',{type:'customer',phone:'010-55550102'});
    add('accounts','A-01','门店现金',{type:'cash'});
    add('accounts','A-02','结算银行',{type:'bank'});
    add('products','P-1001','牛皮纸收纳盒',{category:'日用品/收纳',unit:'个',retail:15.8,purchase:8,barcode:'2000000001001',method:'moving'});
    add('products','P-1002','棉布手提袋',{category:'日用品/包装',unit:'个',retail:12,purchase:6.5,barcode:'2000000001002',method:'monthly'});
    add('products','P-1003','透明封箱胶带',{category:'办公用品/耗材',unit:'卷',retail:5.2,purchase:2.4,barcode:'2000000001003',method:'moving'});
    add('templates','TPL-01','标准出库单',{title:'销售出库单',footer:'请核对商品、数量及金额后签收。'});
  });
}

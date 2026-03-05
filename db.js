'use strict';
// ══ WORKTRACK DB — IndexedDB persistence layer ══
const DB_NAME = 'WorkTrackLight';
const DB_VER  = 1;
let _db = null;

const DB = {
  async open() {
    if (_db) return _db;
    return new Promise((ok, fail) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('users')) {
          d.createObjectStore('users', { keyPath: 'username' });
        }
        if (!d.objectStoreNames.contains('sessions')) {
          const ss = d.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          ss.createIndex('username', 'username', { unique: false });
        }
        if (!d.objectStoreNames.contains('timer')) {
          d.createObjectStore('timer', { keyPath: 'username' });
        }
        if (!d.objectStoreNames.contains('zones')) {
          d.createObjectStore('zones', { keyPath: 'username' });
        }
      };
      req.onsuccess = e => { _db = e.target.result; ok(_db); };
      req.onerror  = () => fail(req.error);
    });
  },

  async _store(name, mode='readonly') {
    const d = await this.open();
    return d.transaction(name, mode).objectStore(name);
  },

  async get(store, key) {
    const s = await this._store(store);
    return new Promise((ok, fail) => {
      const r = s.get(key);
      r.onsuccess = () => ok(r.result);
      r.onerror   = () => fail(r.error);
    });
  },

  async put(store, val) {
    const s = await this._store(store, 'readwrite');
    return new Promise((ok, fail) => {
      const r = s.put(val);
      r.onsuccess = () => ok(r.result);
      r.onerror   = () => fail(r.error);
    });
  },

  async del(store, key) {
    const s = await this._store(store, 'readwrite');
    return new Promise((ok, fail) => {
      const r = s.delete(key);
      r.onsuccess = () => ok();
      r.onerror   = () => fail(r.error);
    });
  },

  async getAllByIndex(store, idx, val) {
    const s = await this._store(store);
    const ix = s.index(idx);
    return new Promise((ok, fail) => {
      const r = ix.getAll(val);
      r.onsuccess = () => ok(r.result);
      r.onerror   = () => fail(r.error);
    });
  },

  async addSession(sess) {
    const s = await this._store('sessions', 'readwrite');
    return new Promise((ok, fail) => {
      const r = s.add(sess);
      r.onsuccess = () => ok(r.result);
      r.onerror   = () => fail(r.error);
    });
  },

  async getUserSessions(username) {
    return this.getAllByIndex('sessions', 'username', username);
  },

  async deleteUserSessions(username) {
    const all = await this.getUserSessions(username);
    const s = await this._store('sessions', 'readwrite');
    return new Promise((ok, fail) => {
      if (!all.length) { ok(); return; }
      let n = 0;
      all.forEach(sess => {
        const r = s.delete(sess.id);
        r.onsuccess = () => { if (++n === all.length) ok(); };
        r.onerror   = () => fail(r.error);
      });
    });
  }
};

// ══ AUTH ══
const Auth = {
  async hash(pwd) {
    const enc  = new TextEncoder();
    const buf  = await crypto.subtle.digest('SHA-256', enc.encode(pwd + 'wt_salt_v1'));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  },

  async register(name, username, pwd) {
    const u = username.toLowerCase().trim();
    const existing = await DB.get('users', u);
    if (existing) throw new Error('Username already taken.');
    if (pwd.length < 6) throw new Error('Password must be at least 6 characters.');
    const h = await this.hash(pwd);
    await DB.put('users', { username: u, name, passwordHash: h, createdAt: new Date().toISOString() });
    return u;
  },

  async login(username, pwd) {
    const u    = username.toLowerCase().trim();
    const user = await DB.get('users', u);
    if (!user) throw new Error('Invalid username or password.');
    const h = await this.hash(pwd);
    if (h !== user.passwordHash) throw new Error('Invalid username or password.');
    return user;
  },

  save(user) {
    sessionStorage.setItem('wt_session', JSON.stringify({ username: user.username, name: user.name }));
  },
  load() {
    const raw = sessionStorage.getItem('wt_session');
    return raw ? JSON.parse(raw) : null;
  },
  clear() { sessionStorage.removeItem('wt_session'); }
};

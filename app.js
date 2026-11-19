'use strict';
(() => {
  // クリックジャッキング対策(Pagesではヘッダーを設定できないため)
  if (window.top !== window.self) { document.documentElement.textContent = ''; return; }

  const STATUSES = ['アイデア', '制作中', '完成'];
  const LS_CFG = 'gitsuno.config';
  const KEY_TOKEN = 'gitsuno.token';
  const API = 'https://api.github.com';

  const $ = (s) => document.querySelector(s);
  const now = () => new Date().toISOString();

  const state = {
    cfg: null, token: null, connected: false,
    songs: [], sha: null,
    dirty: false, saving: false, pending: false,
    openId: null,
    filter: { q: '', status: '', pub: '', todo: false },
  };

  // ---------- ストレージ(失敗しても動くように) ----------
  const store = {
    get(area, k) { try { return window[area].getItem(k); } catch { return null; } },
    set(area, k, v) { try { window[area].setItem(k, v); } catch { /* ignore */ } },
    del(area, k) { try { window[area].removeItem(k); } catch { /* ignore */ } },
  };
  function loadConfig() {
    try { state.cfg = JSON.parse(store.get('localStorage', LS_CFG)); } catch { state.cfg = null; }
    state.token = store.get('sessionStorage', KEY_TOKEN) || store.get('localStorage', KEY_TOKEN);
  }

  // ---------- DOMヘルパー(データは必ず textContent / プロパティで扱う) ----------
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }
  function setStatus(msg, isError = false) {
    const s = $('#status');
    s.textContent = msg;
    s.classList.toggle('error', isError);
  }

  // ---------- Suno URL ----------
  function parseSunoUrl(input) {
    let u;
    try { u = new URL(String(input).trim()); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    if (!/^(www\.)?suno\.(com|ai)$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/song\/([0-9a-f-]{36})(?:\/|$)/i);
    if (m) { const id = m[1].toLowerCase(); return { url: `https://suno.com/song/${id}`, key: id }; }
    const s = u.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/);
    if (s) return { url: `https://suno.com/s/${s[1]}`, key: 's:' + s[1] };
    return null;
  }

  // ---------- Base64 (UTF-8) ----------
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  // ---------- GitHub API ----------
  async function gh(method, path, body) {
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const err = new Error(`${res.status} ${j.message || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  const repoPath = () => `/repos/${encodeURIComponent(state.cfg.owner)}/${encodeURIComponent(state.cfg.repo)}`;
  const contentsPath = () => `${repoPath()}/contents/${state.cfg.path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;

  function normalize(s) {
    if (s.deleted) return { id: String(s.id), deleted: true, updatedAt: String(s.updatedAt || '') };
    return {
      id: String(s.id || crypto.randomUUID()),
      url: String(s.url || ''),
      title: String(s.title || ''),
      status: STATUSES.includes(s.status) ? s.status : STATUSES[1],
      published: !!s.published,
      publishedAt: String(s.publishedAt || ''),
      publishedWhere: String(s.publishedWhere || ''),
      todos: Array.isArray(s.todos) ? s.todos.map((t) => ({ id: String(t.id || crypto.randomUUID()), text: String(t.text || ''), done: !!t.done })) : [],
      memo: String(s.memo || ''),
      createdAt: String(s.createdAt || now()),
      updatedAt: String(s.updatedAt || now()),
    };
  }

  async function fetchRemote() {
    try {
      const r = await gh('GET', `${contentsPath()}?ref=${encodeURIComponent(state.cfg.branch)}`);
      const data = JSON.parse(b64decode(r.content));
      return { sha: r.sha, songs: (Array.isArray(data.songs) ? data.songs : []).map(normalize) };
    } catch (e) {
      if (e.status === 404) return { sha: null, songs: [] };
      throw e;
    }
  }

  // 他端末との競合時: 曲ごとに updatedAt が新しい方を採用
  function merge(local, remote) {
    const map = new Map();
    for (const s of [...remote, ...local]) {
      const cur = map.get(s.id);
      if (!cur || s.updatedAt >= cur.updatedAt) map.set(s.id, s);
    }
    return [...map.values()];
  }

  let saveTimer = null;
  function scheduleSave() {
    state.dirty = true;
    setStatus('未保存の変更あり');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1500);
  }

  async function save() {
    if (!state.connected) return;
    if (state.saving) { state.pending = true; return; }
    clearTimeout(saveTimer);
    state.saving = true;
    state.dirty = false;
    setStatus('保存中…');
    try {
      for (let attempt = 0; ; attempt++) {
        const body = {
          message: `GitSuno: update (${now()})`,
          content: b64encode(JSON.stringify({ version: 1, songs: state.songs }, null, 2) + '\n'),
          branch: state.cfg.branch,
        };
        if (state.sha) body.sha = state.sha;
        try {
          const r = await gh('PUT', contentsPath(), body);
          state.sha = r.content.sha;
          break;
        } catch (e) {
          if ((e.status === 409 || e.status === 422) && attempt < 2) {
            const remote = await fetchRemote();
            state.songs = merge(state.songs, remote.songs);
            state.sha = remote.sha;
            render();
            continue;
          }
          throw e;
        }
      }
      setStatus(state.dirty ? '未保存の変更あり' : '保存済み');
    } catch (e) {
      state.dirty = true;
      setStatus('保存失敗: ' + e.message, true);
    } finally {
      state.saving = false;
      if (state.pending) { state.pending = false; save(); }
    }
  }

  async function connect() {
    state.connected = false;
    updateEnabled();
    if (!state.cfg || !state.token) { setStatus('設定からリポジトリとトークンを登録してください'); openSettings(); return; }
    setStatus('接続中…');
    try {
      const repo = await gh('GET', repoPath());
      if (!repo.private) {
        setStatus('データ用リポジトリが公開(public)です。非公開にするまで使用できません', true);
        return;
      }
      const remote = await fetchRemote();
      state.sha = remote.sha;
      state.songs = remote.songs;
      state.dirty = false;
      state.connected = true;
      setStatus(remote.sha ? '読み込み完了' : 'データ未作成(最初の登録時に作成されます)');
    } catch (e) {
      setStatus('接続失敗: ' + e.message, true);
    }
    updateEnabled();
    render();
  }

  function updateEnabled() {
    for (const e of document.querySelectorAll('#add-form input, #add-form button, #btn-export')) e.disabled = !state.connected;
  }

  // ---------- 描画 ----------
  function render() {
    const list = $('#list');
    list.replaceChildren();
    if (!state.connected) { $('#count').textContent = ''; return; }
    const f = state.filter;
    const q = f.q.trim().toLowerCase();
    const songs = state.songs.filter((s) => !s.deleted).filter((s) => {
      if (f.status && s.status !== f.status) return false;
      if (f.pub === 'yes' && !s.published) return false;
      if (f.pub === 'no' && s.published) return false;
      if (f.todo && !s.todos.some((t) => !t.done)) return false;
      if (q) {
        const hay = [s.title, s.memo, s.url, s.publishedWhere, ...s.todos.map((t) => t.text)].join('\n').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#count').textContent = `${songs.length} 曲`;
    if (!songs.length) list.append(el('p', { class: 'empty', text: '該当する曲がありません' }));
    for (const s of songs) list.append(card(s));
  }

  function card(s) {
    const open = state.openId === s.id;
    const remain = s.todos.filter((t) => !t.done).length;
    const titleEl = el('span', { class: 'title', text: s.title || '(無題)' });
    const head = el('button', {
      class: 'card-head', type: 'button', 'aria-expanded': String(open),
      onclick: () => { state.openId = open ? null : s.id; render(); },
    },
      titleEl,
      el('span', { class: `badge st${STATUSES.indexOf(s.status)}`, text: s.status }),
      s.published ? el('span', { class: 'badge pub', text: '公開済' }) : null,
      s.todos.length ? el('span', { class: 'badge todo' + (remain ? ' open' : ''), text: `ToDo ${s.todos.length - remain}/${s.todos.length}` }) : null,
    );
    const c = el('article', { class: 'card' + (open ? ' open' : '') }, head);
    if (open) c.append(detail(s, titleEl));
    return c;
  }

  function detail(s, titleEl) {
    const touch = (rerender = false) => { s.updatedAt = now(); scheduleSave(); if (rerender) render(); };
    const field = (label, input) => el('label', { class: 'field' }, el('span', { text: label }), input);
    const valid = parseSunoUrl(s.url);

    const urlInput = el('input', {
      type: 'url', value: s.url,
      onchange: (e) => {
        const p = parseSunoUrl(e.target.value);
        if (!p) { alert('SunoのURLではありません'); e.target.value = s.url; return; }
        s.url = p.url; touch(true);
      },
    });

    const todoList = el('ul', { class: 'todos' }, ...s.todos.map((t) => el('li', { class: t.done ? 'done' : '' },
      el('input', { type: 'checkbox', checked: t.done, 'aria-label': '完了', onchange: (e) => { t.done = e.target.checked; touch(true); } }),
      el('input', { type: 'text', value: t.text, oninput: (e) => { t.text = e.target.value; touch(); } }),
      el('button', { type: 'button', class: 'icon', 'aria-label': '削除', text: '×', onclick: () => { s.todos = s.todos.filter((x) => x !== t); touch(true); } }),
    )));
    const todoInput = el('input', { type: 'text', placeholder: 'ToDoを追加して Enter' });
    const addTodo = () => {
      const text = todoInput.value.trim();
      if (!text) return;
      s.todos.push({ id: crypto.randomUUID(), text, done: false });
      touch(true);
      const next = document.querySelector('.card.open .todo-add input');
      if (next) next.focus();
    };
    todoInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); addTodo(); } });

    return el('div', { class: 'detail' },
      el('div', { class: 'row' },
        valid ? el('a', { href: valid.url, target: '_blank', rel: 'noopener noreferrer', text: 'Sunoで開く ↗' }) : el('span', { class: 'error', text: '無効なURL' }),
        valid && valid.key.startsWith('s:') ? el('span', { class: 'hint', text: '短縮リンクです。開いた先の /song/... のURLに置き換えると重複判定が確実になります' }) : null,
      ),
      field('曲名', el('input', { type: 'text', value: s.title, oninput: (e) => { s.title = e.target.value; titleEl.textContent = s.title || '(無題)'; touch(); } })),
      field('共有リンク', urlInput),
      el('div', { class: 'grid' },
        field('状態', el('select', { onchange: (e) => { s.status = e.target.value; touch(true); } },
          ...STATUSES.map((st) => { const o = el('option', { value: st, text: st }); o.selected = st === s.status; return o; }))),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: s.published, onchange: (e) => {
          s.published = e.target.checked;
          if (s.published && !s.publishedAt) s.publishedAt = new Date().toISOString().slice(0, 10);
          touch(true);
        } }), ' 外部に公開済み'),
        s.published ? field('公開日', el('input', { type: 'date', value: s.publishedAt, onchange: (e) => { s.publishedAt = e.target.value; touch(); } })) : null,
      ),
      s.published ? field('公開先(YouTube、配信サービスなど)', el('input', { type: 'text', value: s.publishedWhere, oninput: (e) => { s.publishedWhere = e.target.value; touch(); } })) : null,
      el('div', { class: 'field' }, el('span', { text: 'ToDo' }), todoList,
        el('div', { class: 'todo-add' }, todoInput, el('button', { type: 'button', text: '追加', onclick: addTodo }))),
      field('メモ', el('textarea', { rows: '5', value: s.memo, oninput: (e) => { s.memo = e.target.value; touch(); } })),
      el('div', { class: 'row' },
        el('span', { class: 'hint', text: `登録 ${s.createdAt.slice(0, 10)} / 更新 ${s.updatedAt.slice(0, 16).replace('T', ' ')}` }),
        el('span', { class: 'spacer' }),
        el('button', { type: 'button', class: 'danger', text: 'この曲を削除', onclick: () => {
          if (!confirm(`「${s.title || '(無題)'}」を削除しますか?`)) return;
          const id = s.id;
          for (const k of Object.keys(s)) delete s[k];
          Object.assign(s, { id, deleted: true, updatedAt: now() });
          state.openId = null;
          scheduleSave();
          render();
        } }),
      ),
    );
  }

  // ---------- 設定ダイアログ ----------
  function openSettings() {
    const c = state.cfg || {};
    $('#s-owner').value = c.owner || '';
    $('#s-repo').value = c.repo || '';
    $('#s-branch').value = c.branch || 'main';
    $('#s-path').value = c.path || 'data/songs.json';
    $('#s-token').value = '';
    $('#s-token').placeholder = state.token ? '(登録済み。変更する場合のみ入力)' : 'github_pat_...';
    $('#s-remember').checked = !!store.get('localStorage', KEY_TOKEN);
    $('#settings').showModal();
  }

  // ---------- 初期化 ----------
  function init() {
    for (const st of STATUSES) $('#f-status').append(el('option', { value: st, text: st }));

    $('#add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const p = parseSunoUrl($('#add-url').value);
      if (!p) { alert('Sunoの共有リンク(https://suno.com/song/... または /s/...)を貼り付けてください'); return; }
      const dup = state.songs.find((s) => !s.deleted && parseSunoUrl(s.url)?.key === p.key);
      if (dup) { state.openId = dup.id; render(); alert('この曲は登録済みです'); return; }
      const t = now();
      const song = normalize({ id: crypto.randomUUID(), url: p.url, title: $('#add-title').value.trim(), status: '制作中', createdAt: t, updatedAt: t });
      state.songs.push(song);
      state.openId = song.id;
      e.target.reset();
      scheduleSave();
      render();
    });

    $('#f-q').addEventListener('input', (e) => { state.filter.q = e.target.value; render(); });
    $('#f-status').addEventListener('change', (e) => { state.filter.status = e.target.value; render(); });
    $('#f-pub').addEventListener('change', (e) => { state.filter.pub = e.target.value; render(); });
    $('#f-todo').addEventListener('change', (e) => { state.filter.todo = e.target.checked; render(); });

    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-cancel').addEventListener('click', () => $('#settings').close());
    $('#btn-reload').addEventListener('click', () => {
      if ((state.dirty || state.saving) && !confirm('未保存の変更があります。破棄して再読込しますか?')) return;
      clearTimeout(saveTimer);
      connect();
    });
    $('#btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ version: 1, songs: state.songs.filter((s) => !s.deleted) }, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `gitsuno-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $('#btn-forget').addEventListener('click', () => {
      store.del('localStorage', KEY_TOKEN);
      store.del('sessionStorage', KEY_TOKEN);
      state.token = null;
      state.connected = false;
      state.songs = [];
      updateEnabled();
      render();
      $('#settings').close();
      setStatus('トークンを削除しました');
    });
    $('#settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      state.cfg = {
        owner: $('#s-owner').value.trim(),
        repo: $('#s-repo').value.trim(),
        branch: $('#s-branch').value.trim() || 'main',
        path: $('#s-path').value.trim().replace(/^\/+/, '') || 'data/songs.json',
      };
      store.set('localStorage', LS_CFG, JSON.stringify(state.cfg));
      const tok = $('#s-token').value.trim() || state.token;
      if (tok) {
        state.token = tok;
        store.del('localStorage', KEY_TOKEN);
        store.del('sessionStorage', KEY_TOKEN);
        store.set($('#s-remember').checked ? 'localStorage' : 'sessionStorage', KEY_TOKEN, tok);
      }
      $('#settings').close();
      connect();
    });

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty || state.saving) { e.preventDefault(); e.returnValue = ''; }
    });

    loadConfig();
    updateEnabled();
    connect();
  }

  init();
})();

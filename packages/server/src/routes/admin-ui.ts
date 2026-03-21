import { Hono } from "hono";
import { html } from "hono/html";
import type { DocumentRepository } from "../storage/repository.js";

export function createAdminRoutes(repo: DocumentRepository): Hono {
  const app = new Hono();

  // GET /admin/api/collections - コレクション一覧を取得
  app.get("/admin/api/collections", (c) => {
    const allDocs = repo.listAll();
    const collectionSet = new Set<string>();
    for (const doc of allDocs) {
      collectionSet.add(doc.collectionPath);
    }
    const collections = [...collectionSet].sort();
    return c.json({ collections, totalDocuments: allDocs.length });
  });

  // GET /admin/api/documents?collection=xxx - コレクション内のドキュメント一覧
  app.get("/admin/api/documents", (c) => {
    const collectionPath = c.req.query("collection");
    if (!collectionPath) {
      return c.json({ error: "collection query parameter is required" }, 400);
    }
    const docs = repo.listCollection(collectionPath);
    return c.json({
      documents: docs.map((d) => ({
        path: d.path,
        documentId: d.documentId,
        data: d.data,
        createTime: d.createTime,
        updateTime: d.updateTime,
        version: d.version,
      })),
    });
  });

  // GET /admin/api/document?path=xxx - 単一ドキュメント取得
  app.get("/admin/api/document", (c) => {
    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "path query parameter is required" }, 400);
    }
    const doc = repo.get(path);
    if (!doc) {
      return c.json({ error: "Document not found" }, 404);
    }
    return c.json({
      path: doc.path,
      documentId: doc.documentId,
      collectionPath: doc.collectionPath,
      data: doc.data,
      createTime: doc.createTime,
      updateTime: doc.updateTime,
      version: doc.version,
    });
  });

  // PUT /admin/api/document?path=xxx - ドキュメント更新
  app.put("/admin/api/document", async (c) => {
    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "path query parameter is required" }, 400);
    }
    const existing = repo.get(path);
    if (!existing) {
      return c.json({ error: "Document not found" }, 404);
    }
    const body = await c.req.json<{ data: Record<string, unknown> }>();
    repo.set({
      path: existing.path,
      collectionPath: existing.collectionPath,
      documentId: existing.documentId,
      data: body.data,
    });
    return c.json({ success: true });
  });

  // DELETE /admin/api/document?path=xxx - ドキュメント削除
  app.delete("/admin/api/document", (c) => {
    const path = c.req.query("path");
    if (!path) {
      return c.json({ error: "path query parameter is required" }, 400);
    }
    const deleted = repo.delete(path);
    if (!deleted) {
      return c.json({ error: "Document not found" }, 404);
    }
    return c.json({ success: true });
  });

  // GET /admin - 管理画面HTML
  app.get("/admin", (c) => {
    return c.html(adminHtml());
  });

  return app;
}

function adminHtml() {
  return html`<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Local Firestore Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    header { background: #1a73e8; color: white; padding: 12px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; font-weight: 500; }
    header .stats { margin-left: auto; font-size: 13px; opacity: 0.85; }
    .container { display: flex; height: calc(100vh - 48px); }
    .sidebar { width: 280px; background: white; border-right: 1px solid #ddd; overflow-y: auto; flex-shrink: 0; }
    .sidebar h2 { font-size: 13px; text-transform: uppercase; color: #666; padding: 16px 16px 8px; letter-spacing: 0.5px; }
    .collection-item { padding: 10px 16px; cursor: pointer; font-size: 14px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 8px; }
    .collection-item:hover { background: #e8f0fe; }
    .collection-item.active { background: #d2e3fc; font-weight: 500; }
    .collection-item .icon { color: #1a73e8; font-size: 16px; }
    .collection-item .count { margin-left: auto; font-size: 12px; color: #999; }
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .doc-list { flex: 1; overflow-y: auto; padding: 16px; }
    .doc-list h2 { font-size: 15px; color: #666; margin-bottom: 12px; }
    .empty { text-align: center; color: #999; padding: 48px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #fafafa; text-align: left; padding: 10px 14px; font-size: 12px; text-transform: uppercase; color: #666; border-bottom: 2px solid #eee; }
    td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid #f0f0f0; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    tr:hover td { background: #f8f9fa; }
    .actions { display: flex; gap: 6px; }
    .btn { padding: 5px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 500; }
    .btn-view { background: #e8f0fe; color: #1a73e8; }
    .btn-edit { background: #e6f4ea; color: #1e8e3e; }
    .btn-delete { background: #fce8e6; color: #d93025; }
    .btn-primary { background: #1a73e8; color: white; padding: 8px 20px; font-size: 14px; }
    .btn:hover { opacity: 0.85; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 100; justify-content: center; align-items: center; }
    .modal-overlay.show { display: flex; }
    .modal { background: white; border-radius: 8px; width: 640px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 4px 24px rgba(0,0,0,0.2); }
    .modal-header { padding: 16px 20px; border-bottom: 1px solid #eee; display: flex; align-items: center; }
    .modal-header h3 { font-size: 16px; flex: 1; }
    .modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #666; padding: 4px 8px; }
    .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
    .modal-footer { padding: 12px 20px; border-top: 1px solid #eee; display: flex; justify-content: flex-end; gap: 8px; }
    .meta-row { display: flex; gap: 16px; margin-bottom: 12px; font-size: 13px; color: #666; }
    .meta-row span { background: #f5f5f5; padding: 4px 8px; border-radius: 4px; }
    textarea { width: 100%; min-height: 300px; font-family: "SF Mono", Monaco, Consolas, monospace; font-size: 13px; padding: 12px; border: 1px solid #ddd; border-radius: 4px; resize: vertical; }
    textarea:focus { outline: none; border-color: #1a73e8; }
    .error-msg { color: #d93025; font-size: 13px; margin-top: 8px; }
    .toast { position: fixed; bottom: 24px; right: 24px; background: #323232; color: white; padding: 12px 20px; border-radius: 4px; font-size: 14px; z-index: 200; display: none; }
    .toast.show { display: block; }
  </style>
</head>
<body>
  <header>
    <h1>Local Firestore Admin</h1>
    <div class="stats" id="stats"></div>
  </header>
  <div class="container">
    <div class="sidebar">
      <h2>Collections</h2>
      <div id="collections"></div>
    </div>
    <div class="main">
      <div class="doc-list" id="docList">
        <div class="empty">Select a collection from the sidebar</div>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="viewModal">
    <div class="modal">
      <div class="modal-header">
        <h3 id="viewTitle">Document</h3>
        <button class="modal-close" onclick="closeModal('viewModal')">&times;</button>
      </div>
      <div class="modal-body">
        <div class="meta-row" id="viewMeta"></div>
        <pre id="viewData" style="background:#f8f8f8;padding:12px;border-radius:4px;font-size:13px;overflow:auto;max-height:400px;"></pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-edit" onclick="openEditFromView()">Edit</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="editModal">
    <div class="modal">
      <div class="modal-header">
        <h3 id="editTitle">Edit Document</h3>
        <button class="modal-close" onclick="closeModal('editModal')">&times;</button>
      </div>
      <div class="modal-body">
        <textarea id="editData"></textarea>
        <div class="error-msg" id="editError"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('editModal')">Cancel</button>
        <button class="btn btn-primary" onclick="saveDocument()">Save</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="deleteModal">
    <div class="modal" style="width:420px;">
      <div class="modal-header">
        <h3>Delete Document</h3>
        <button class="modal-close" onclick="closeModal('deleteModal')">&times;</button>
      </div>
      <div class="modal-body">
        <p>Are you sure you want to delete <strong id="deletePath"></strong>?</p>
        <p style="color:#666;font-size:13px;margin-top:8px;">This action cannot be undone.</p>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('deleteModal')">Cancel</button>
        <button class="btn btn-delete" onclick="confirmDelete()">Delete</button>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    let currentCollection = null;
    let currentViewPath = null;
    let currentEditPath = null;
    let currentDeletePath = null;
    let collectionsData = {};

    async function loadCollections() {
      const res = await fetch('/admin/api/collections');
      const data = await res.json();
      document.getElementById('stats').textContent = data.totalDocuments + ' documents total';

      const container = document.getElementById('collections');
      if (data.collections.length === 0) {
        container.innerHTML = '<div class="empty" style="padding:16px;font-size:13px;">No collections found</div>';
        return;
      }

      container.innerHTML = '';
      for (const col of data.collections) {
        const el = document.createElement('div');
        el.className = 'collection-item' + (col === currentCollection ? ' active' : '');
        el.innerHTML = '<span class="icon">\u{1F4C1}</span>' + escapeHtml(col);
        el.addEventListener('click', () => selectCollection(col));
        container.appendChild(el);
      }
    }

    async function selectCollection(col) {
      currentCollection = col;
      document.querySelectorAll('.collection-item').forEach(el => {
        el.classList.toggle('active', el.textContent.includes(col));
      });
      const res = await fetch('/admin/api/documents?collection=' + encodeURIComponent(col));
      const data = await res.json();
      renderDocuments(col, data.documents);
    }

    function renderDocuments(col, docs) {
      const container = document.getElementById('docList');
      if (docs.length === 0) {
        container.innerHTML = '<h2>' + escapeHtml(col) + '</h2><div class="empty">No documents in this collection</div>';
        return;
      }

      const fields = new Set();
      for (const doc of docs) {
        for (const key of Object.keys(doc.data)) {
          fields.add(key);
        }
      }
      const fieldList = [...fields].slice(0, 5);

      let tableHtml = '<h2>' + escapeHtml(col) + ' (' + docs.length + ' docs)</h2><table><thead><tr><th>ID</th>';
      for (const f of fieldList) {
        tableHtml += '<th>' + escapeHtml(f) + '</th>';
      }
      tableHtml += '<th>Updated</th><th>Actions</th></tr></thead><tbody>';

      for (const doc of docs) {
        tableHtml += '<tr><td title="' + escapeHtml(doc.path) + '">' + escapeHtml(doc.documentId) + '</td>';
        for (const f of fieldList) {
          const val = doc.data[f];
          const display = val === undefined ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
          tableHtml += '<td title="' + escapeHtml(display) + '">' + escapeHtml(display) + '</td>';
        }
        const updated = doc.updateTime ? new Date(doc.updateTime).toLocaleString() : '-';
        tableHtml += '<td>' + updated + '</td>';
        tableHtml += '<td class="actions">';
        tableHtml += '<button class="btn btn-view" onclick="viewDoc(\'' + escapeAttr(doc.path) + '\')">View</button>';
        tableHtml += '<button class="btn btn-edit" onclick="editDoc(\'' + escapeAttr(doc.path) + '\')">Edit</button>';
        tableHtml += '<button class="btn btn-delete" onclick="deleteDoc(\'' + escapeAttr(doc.path) + '\')">Delete</button>';
        tableHtml += '</td></tr>';
      }
      tableHtml += '</tbody></table>';
      container.innerHTML = tableHtml;
    }

    async function viewDoc(path) {
      const res = await fetch('/admin/api/document?path=' + encodeURIComponent(path));
      const doc = await res.json();
      currentViewPath = path;
      document.getElementById('viewTitle').textContent = path;
      document.getElementById('viewMeta').innerHTML =
        '<span>Version: ' + doc.version + '</span>' +
        '<span>Created: ' + new Date(doc.createTime).toLocaleString() + '</span>' +
        '<span>Updated: ' + new Date(doc.updateTime).toLocaleString() + '</span>';
      document.getElementById('viewData').textContent = JSON.stringify(doc.data, null, 2);
      showModal('viewModal');
    }

    async function editDoc(path) {
      const res = await fetch('/admin/api/document?path=' + encodeURIComponent(path));
      const doc = await res.json();
      currentEditPath = path;
      document.getElementById('editTitle').textContent = 'Edit: ' + path;
      document.getElementById('editData').value = JSON.stringify(doc.data, null, 2);
      document.getElementById('editError').textContent = '';
      closeModal('viewModal');
      showModal('editModal');
    }

    function openEditFromView() {
      if (currentViewPath) editDoc(currentViewPath);
    }

    async function saveDocument() {
      const textarea = document.getElementById('editData');
      const errorEl = document.getElementById('editError');
      let data;
      try {
        data = JSON.parse(textarea.value);
      } catch (e) {
        errorEl.textContent = 'Invalid JSON: ' + e.message;
        return;
      }
      const res = await fetch('/admin/api/document?path=' + encodeURIComponent(currentEditPath), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (res.ok) {
        closeModal('editModal');
        showToast('Document saved');
        if (currentCollection) selectCollection(currentCollection);
        loadCollections();
      } else {
        const err = await res.json();
        errorEl.textContent = err.error || 'Failed to save';
      }
    }

    function deleteDoc(path) {
      currentDeletePath = path;
      document.getElementById('deletePath').textContent = path;
      showModal('deleteModal');
    }

    async function confirmDelete() {
      const res = await fetch('/admin/api/document?path=' + encodeURIComponent(currentDeletePath), { method: 'DELETE' });
      if (res.ok) {
        closeModal('deleteModal');
        showToast('Document deleted');
        if (currentCollection) selectCollection(currentCollection);
        loadCollections();
      }
    }

    function showModal(id) { document.getElementById(id).classList.add('show'); }
    function closeModal(id) { document.getElementById(id).classList.remove('show'); }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2500);
    }

    function escapeHtml(str) {
      const d = document.createElement('div');
      d.appendChild(document.createTextNode(str));
      return d.innerHTML;
    }

    function escapeAttr(str) {
      return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    // Initial load
    loadCollections();
  </script>
</body>
</html>`;
}

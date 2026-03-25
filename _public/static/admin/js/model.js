let apiKey = '';
let lastRegistryModels = [];
const selectedRemoteModelIds = new Set();

const byId = (id) => document.getElementById(id);

function fmtTs(ts) {
  const n = Number(ts || 0);
  if (!n) return '-';
  const d = new Date(n * 1000);
  return d.toLocaleString();
}

function renderRegistry(data) {
  const body = byId('models-body');
  const meta = byId('registry-meta');
  const aliasList = byId('alias-list');
  const mappedToSelect = byId('manual-mapped-to');
  if (!body || !meta) return;

  const models = Array.isArray(data.models) ? data.models : [];
  lastRegistryModels = models;
  const manualModels = Array.isArray(data.manual_models) ? data.manual_models : [];
  const aliases = data.aliases || {};
  const localModels = Array.isArray(data.local_models) ? data.local_models : [];
  meta.textContent = `enabled=${!!data.enabled} · source=${data.source || '-'} · last_sync=${fmtTs(data.last_sync_at)} · remote=${data.remote_count || 0} · supported=${data.supported_count || 0} · manual=${manualModels.length} · selected=${selectedRemoteModelIds.size}`;

  if (mappedToSelect) {
    mappedToSelect.innerHTML = ['<option value="">(不映射，仅加入下拉)</option>']
      .concat(localModels.map((m) => `<option value="${m}">${m}</option>`))
      .join('');
  }

  if (aliasList) {
    aliasList.innerHTML = manualModels.length
      ? manualModels.map((m) => {
          const mid = String(m.id || '');
          const mapped = aliases[mid] || '-';
          return `<div><span class="font-mono">${mid}</span> : ${m.name || mid}  ->  <span class="font-mono">${mapped}</span></div>`;
        }).join('')
      : '<div>暂无手工添加</div>';
  }

  if (!models.length) {
    body.innerHTML = `<tr><td colspan="6" class="py-4 text-[var(--accents-4)]">暂无模型数据</td></tr>`;
    return;
  }

  body.innerHTML = models.map((m) => {
    const id = String(m.id || '');
    const checked = selectedRemoteModelIds.has(id) ? 'checked' : '';
    return `
    <tr class="border-b border-[var(--border)]">
      <td class="py-2 pr-3"><input type="checkbox" class="remote-model-checkbox" data-model-id="${id}" ${checked} /></td>
      <td class="py-2 pr-3 font-mono text-xs">${id}</td>
      <td class="py-2 pr-3">${m.owned_by || '-'}</td>
      <td class="py-2 pr-3">${m.supported ? '是' : '否'}</td>
      <td class="py-2 pr-3">${m.executable ? '是' : '否'}</td>
      <td class="py-2 pr-3 font-mono text-xs">${m.mapped_to || '-'}</td>
    </tr>
  `;
  }).join('');

  body.querySelectorAll('.remote-model-checkbox').forEach((el) => {
    el.addEventListener('change', () => {
      const modelId = String(el.getAttribute('data-model-id') || '').trim();
      if (!modelId) return;
      if (el.checked) selectedRemoteModelIds.add(modelId);
      else selectedRemoteModelIds.delete(modelId);
      if (meta) {
        meta.textContent = `enabled=${!!data.enabled} · source=${data.source || '-'} · last_sync=${fmtTs(data.last_sync_at)} · remote=${data.remote_count || 0} · supported=${data.supported_count || 0} · manual=${manualModels.length} · selected=${selectedRemoteModelIds.size}`;
      }
    });
  });
}

async function loadRegistry() {
  const res = await fetch('/v1/admin/models/registry', {
    headers: buildAuthHeaders(apiKey)
  });
  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  renderRegistry(data);
}

async function discoverRegistry() {
  const status = byId('sync-status');

  if (status) status.textContent = '同步公开模型中...';
  const res = await fetch('/v1/admin/models/registry/discover', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(apiKey)
    },
    body: JSON.stringify({})
  });

  if (res.status === 401) {
    logout();
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (status) status.textContent = '';
    showToast((data.detail && data.detail.message) || data.detail || `同步失败: HTTP ${res.status}`, 'error');
    return;
  }

  if (status) status.textContent = `同步成功：remote=${data.remote_count || 0}，source=${data.source || '-'}`;
  showToast('模型同步成功', 'success');
  await loadRegistry();
}

async function saveManual() {
  const modelId = (byId('manual-model-id')?.value || '').trim();
  const modelName = (byId('manual-model-name')?.value || '').trim();
  const mappedTo = (byId('manual-mapped-to')?.value || '').trim();
  const mappingEnabled = !!byId('manual-enable-mapping')?.checked;
  if (!modelId || !modelName) {
    showToast('模型ID和模型名称不能为空', 'error');
    return;
  }

  const payload = { id: modelId, name: modelName };
  if (mappingEnabled && mappedTo) {
    payload.mapped_to = mappedTo;
  }

  const res = await fetch('/v1/admin/models/registry/manual/upsert', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(apiKey)
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.detail || `添加失败: HTTP ${res.status}`, 'error');
    return;
  }
  const mapped = data.mapped_to || '';
  if (mapped) {
    showToast(`手工模型已添加，并映射到 ${mapped}`, 'success');
  } else {
    showToast('手工模型已添加（仅下拉展示，不映射本地）', 'success');
  }
  const inputId = byId('manual-model-id');
  const inputName = byId('manual-model-name');
  if (inputId) inputId.value = '';
  if (inputName) inputName.value = '';
  await loadRegistry();
}

async function deleteManual() {
  const modelId = (byId('manual-model-id')?.value || '').trim();
  if (!modelId) {
    showToast('请填写要删除的模型ID', 'error');
    return;
  }

  const res = await fetch('/v1/admin/models/registry/manual/delete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(apiKey)
    },
    body: JSON.stringify({ id: modelId })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showToast(data.detail || `删除失败: HTTP ${res.status}`, 'error');
    return;
  }
  showToast('手工模型已删除', 'success');
  await loadRegistry();
}

async function selectAllVisible() {
  for (const m of lastRegistryModels) {
    const id = String((m && m.id) || '').trim();
    if (id) selectedRemoteModelIds.add(id);
  }
  await loadRegistry();
}

async function clearSelection() {
  selectedRemoteModelIds.clear();
  await loadRegistry();
}

async function batchAddSelected() {
  const ids = [...selectedRemoteModelIds];
  if (!ids.length) {
    showToast('请先勾选至少一个模型', 'error');
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const id of ids) {
    const res = await fetch('/v1/admin/models/registry/manual/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(apiKey)
      },
      body: JSON.stringify({ id, name: id })
    });
    if (res.ok) ok += 1;
    else failed += 1;
  }

  showToast(`批量添加完成：成功 ${ok}，失败 ${failed}`, failed ? 'warning' : 'success');
  await loadRegistry();
}

async function enableRegistry() {
  const status = byId('sync-status');
  const res = await fetch('/v1/admin/models/registry/enable', {
    method: 'POST',
    headers: buildAuthHeaders(apiKey)
  });

  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) {
    showToast(`启用失败: HTTP ${res.status}`, 'error');
    return;
  }

  if (status) status.textContent = '已启用注册表过滤，/v1/models 将按注册表返回。';
  showToast('已启用注册表过滤', 'success');
  await loadRegistry();
}

async function disableRegistry() {
  const status = byId('sync-status');
  const res = await fetch('/v1/admin/models/registry/disable', {
    method: 'POST',
    headers: buildAuthHeaders(apiKey)
  });

  if (res.status === 401) {
    logout();
    return;
  }
  if (!res.ok) {
    showToast(`停用失败: HTTP ${res.status}`, 'error');
    return;
  }

  if (status) status.textContent = '已停用注册表过滤，/v1/models 将返回本地模型全集。';
  showToast('已停用注册表过滤', 'success');
  await loadRegistry();
}

async function init() {
  apiKey = await ensureAdminKey();
  if (apiKey === null) return;

  byId('discover-btn')?.addEventListener('click', discoverRegistry);
  byId('enable-btn')?.addEventListener('click', enableRegistry);
  byId('disable-btn')?.addEventListener('click', disableRegistry);
  byId('save-manual-btn')?.addEventListener('click', saveManual);
  byId('delete-manual-btn')?.addEventListener('click', deleteManual);
  byId('select-all-btn')?.addEventListener('click', selectAllVisible);
  byId('clear-selection-btn')?.addEventListener('click', clearSelection);
  byId('batch-add-btn')?.addEventListener('click', batchAddSelected);

  await loadRegistry();
}

window.addEventListener('DOMContentLoaded', init);

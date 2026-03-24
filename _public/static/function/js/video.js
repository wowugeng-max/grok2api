(() => {
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const clearBtn = document.getElementById('clearBtn');
  const retryBtn = document.getElementById('retryBtn');
  const promptInput = document.getElementById('promptInput');
  const imageUrlInput = document.getElementById('imageUrlInput');
  const imageFileInput = document.getElementById('imageFileInput');
  const imageFileName = document.getElementById('imageFileName');
  const clearImageFileBtn = document.getElementById('clearImageFileBtn');
  const selectImageFileBtn = document.getElementById('selectImageFileBtn');
  const ratioSelect = document.getElementById('ratioSelect');
  const lengthSelect = document.getElementById('lengthSelect');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const presetSelect = document.getElementById('presetSelect');
  const statusText = document.getElementById('statusText');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressText = document.getElementById('progressText');
  const durationValue = document.getElementById('durationValue');
  const ttfpValue = document.getElementById('ttfpValue');
  const ttfrValue = document.getElementById('ttfrValue');
  const totalValue = document.getElementById('totalValue');
  const aspectValue = document.getElementById('aspectValue');
  const lengthValue = document.getElementById('lengthValue');
  const resolutionValue = document.getElementById('resolutionValue');
  const presetValue = document.getElementById('presetValue');
  const videoEmpty = document.getElementById('videoEmpty');
  const videoStage = document.getElementById('videoStage');
  const videoErrorTop = document.getElementById('videoErrorTop');
  const videoErrorClearBtn = document.getElementById('videoErrorClearBtn');
  const videoErrorExportBtn = document.getElementById('videoErrorExportBtn');
  const videoSmartRetryToggle = document.getElementById('videoSmartRetryToggle');

  let currentSource = null;
  let currentTaskId = '';
  let isRunning = false;
  let progressBuffer = '';
  let contentBuffer = '';
  let collectingContent = false;
  let startAt = 0;
  let fileDataUrls = [];
  let elapsedTimer = null;
  let lastProgress = 0;
  let currentPreviewItem = null;
  let previewCount = 0;
  let firstProgressAt = 0;
  let firstRenderableAt = 0;
  let lastRequestSnapshot = null;
  const videoErrorStats = new Map();
  const DEFAULT_REASONING_EFFORT = 'low';
  const MAX_REFERENCE_IMAGES = 7;

  function toast(message, type) {
    if (typeof showToast === 'function') {
      showToast(message, type);
    }
  }

  function setStatus(state, text) {
    if (!statusText) return;
    statusText.textContent = text;
    statusText.classList.remove('connected', 'connecting', 'error');
    if (state) {
      statusText.classList.add(state);
    }
  }

  function setButtons(running) {
    if (!startBtn || !stopBtn) return;
    if (running) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
      startBtn.disabled = false;
    }
  }

  function updateProgress(value) {
    const safe = Math.max(0, Math.min(100, Number(value) || 0));
    if (!firstProgressAt && safe > 0) {
      firstProgressAt = Date.now();
      if (startAt) {
        const ttfp = firstProgressAt - startAt;
        console.log('[video] TTFP(ms):', ttfp);
        if (ttfpValue) ttfpValue.textContent = `${ttfp} ms`;
      }
    }
    lastProgress = safe;
    if (progressFill) {
      progressFill.style.width = `${safe}%`;
    }
    if (progressText) {
      progressText.textContent = `${safe}%`;
    }
  }

  function updateMeta() {
    if (aspectValue && ratioSelect) {
      aspectValue.textContent = ratioSelect.value;
    }
    if (lengthValue && lengthSelect) {
      lengthValue.textContent = `${lengthSelect.value}s`;
    }
    if (resolutionValue && resolutionSelect) {
      resolutionValue.textContent = resolutionSelect.value;
    }
    if (presetValue && presetSelect) {
      presetValue.textContent = presetSelect.value;
    }
  }

  function resetOutput(keepPreview) {
    progressBuffer = '';
    contentBuffer = '';
    collectingContent = false;
    lastProgress = 0;
    currentPreviewItem = null;
    updateProgress(0);
    setIndeterminate(false);
    if (ttfpValue) ttfpValue.textContent = '-';
    if (ttfrValue) ttfrValue.textContent = '-';
    if (totalValue) totalValue.textContent = '-';
    if (!keepPreview) {
      if (videoStage) {
        videoStage.innerHTML = '';
        videoStage.classList.add('hidden');
      }
      if (videoEmpty) {
        videoEmpty.classList.remove('hidden');
      }
      previewCount = 0;
    }
    if (durationValue) {
      durationValue.textContent = t('video.elapsedTimeNone');
    }
  }

  function initPreviewSlot() {
    if (!videoStage) return;
    previewCount += 1;
    currentPreviewItem = document.createElement('div');
    currentPreviewItem.className = 'video-item';
    currentPreviewItem.dataset.index = String(previewCount);
    currentPreviewItem.classList.add('is-pending');

    const header = document.createElement('div');
    header.className = 'video-item-bar';

    const title = document.createElement('div');
    title.className = 'video-item-title';
    title.textContent = t('video.videoTitle', { n: previewCount });

    const actions = document.createElement('div');
    actions.className = 'video-item-actions';

    const openBtn = document.createElement('a');
    openBtn.className = 'geist-button-outline text-xs px-3 video-open hidden';
    openBtn.target = '_blank';
    openBtn.rel = 'noopener';
    openBtn.textContent = t('video.open');

    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'geist-button-outline text-xs px-3 video-download';
    downloadBtn.type = 'button';
    downloadBtn.textContent = t('imagine.download');
    downloadBtn.disabled = true;

    actions.appendChild(openBtn);
    actions.appendChild(downloadBtn);
    header.appendChild(title);
    header.appendChild(actions);

    const body = document.createElement('div');
    body.className = 'video-item-body';
    body.innerHTML = '<div class="video-item-placeholder">' + t('video.generatingPlaceholder') + '</div>';

    const link = document.createElement('div');
    link.className = 'video-item-link';

    currentPreviewItem.appendChild(header);
    currentPreviewItem.appendChild(body);
    currentPreviewItem.appendChild(link);
    videoStage.appendChild(currentPreviewItem);
    videoStage.classList.remove('hidden');
    if (videoEmpty) {
      videoEmpty.classList.add('hidden');
    }
  }

  function ensurePreviewSlot() {
    if (!currentPreviewItem) {
      initPreviewSlot();
    }
    return currentPreviewItem;
  }

  function updateItemLinks(item, url) {
    if (!item) return;
    const openBtn = item.querySelector('.video-open');
    const downloadBtn = item.querySelector('.video-download');
    const link = item.querySelector('.video-item-link');
    const safeUrl = url || '';
    item.dataset.url = safeUrl;
    if (link) {
      link.textContent = safeUrl;
      link.classList.toggle('has-url', Boolean(safeUrl));
    }
    if (openBtn) {
      if (safeUrl) {
        openBtn.href = safeUrl;
        openBtn.classList.remove('hidden');
      } else {
        openBtn.classList.add('hidden');
        openBtn.removeAttribute('href');
      }
    }
    if (downloadBtn) {
      downloadBtn.dataset.url = safeUrl;
      downloadBtn.disabled = !safeUrl;
    }
    if (safeUrl) {
      item.classList.remove('is-pending');
    }
  }

  function setIndeterminate(active) {
    if (!progressBar) return;
    if (active) {
      progressBar.classList.add('indeterminate');
    } else {
      progressBar.classList.remove('indeterminate');
    }
  }

  function startElapsedTimer() {
    stopElapsedTimer();
    if (!durationValue) return;
    elapsedTimer = setInterval(() => {
      if (!startAt) return;
      const seconds = Math.max(0, Math.round((Date.now() - startAt) / 1000));
      durationValue.textContent = t('video.elapsedTime', { sec: seconds });
    }, 1000);
  }

  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function clearFileSelection() {
    fileDataUrls = [];
    if (imageFileInput) {
      imageFileInput.value = '';
    }
    if (imageFileName) {
      imageFileName.textContent = t('video.noReferenceSelected');
    }
  }

  function updateReferenceSummary(names) {
    if (!imageFileName) return;
    if (!names || !names.length) {
      imageFileName.textContent = t('video.noReferenceSelected');
      return;
    }
    imageFileName.textContent = names.join('\n');
  }

  function parseReferenceUrls(value) {
    return (value || '')
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  function getReferenceImages() {
    const rawUrls = imageUrlInput ? parseReferenceUrls(imageUrlInput.value) : [];
    if (fileDataUrls.length && rawUrls.length) {
      toast(t('video.referenceConflict'), 'error');
      throw new Error('invalid_reference');
    }
    const images = fileDataUrls.length ? [...fileDataUrls] : rawUrls;
    if (images.length > MAX_REFERENCE_IMAGES) {
      toast(t('video.referenceLimit'), 'error');
      throw new Error('too_many_references');
    }
    return images;
  }

  function normalizeAuthHeader(authHeader) {
    if (!authHeader) return '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7).trim();
    }
    return authHeader;
  }

  function buildSseUrl(taskId, rawPublicKey) {
    const httpProtocol = window.location.protocol === 'https:' ? 'https' : 'http';
    const base = `${httpProtocol}://${window.location.host}/v1/function/video/sse`;
    const params = new URLSearchParams();
    params.set('task_id', taskId);
    params.set('t', String(Date.now()));
    if (rawPublicKey) {
      params.set('function_key', rawPublicKey);
    }
    return `${base}?${params.toString()}`;
  }

  function buildRequestPayload() {
    const prompt = promptInput ? promptInput.value.trim() : '';
    const imageUrls = getReferenceImages();
    return {
      prompt,
      image_urls: imageUrls,
      reasoning_effort: DEFAULT_REASONING_EFFORT,
      aspect_ratio: ratioSelect ? ratioSelect.value : '3:2',
      video_length: lengthSelect ? parseInt(lengthSelect.value, 10) : 6,
      resolution_name: resolutionSelect ? resolutionSelect.value : '480p',
      preset: presetSelect ? presetSelect.value : 'normal'
    };
  }

  async function createVideoTask(authHeader, payloadOverride) {
    const payload = payloadOverride || buildRequestPayload();
    const res = await fetch('/v1/function/video/start', {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(authHeader),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || 'Failed to create task');
    }
    const data = await res.json();
    return data && data.task_id ? String(data.task_id) : '';
  }

  async function stopVideoTask(taskId, authHeader) {
    if (!taskId) return;
    try {
      await fetch('/v1/function/video/stop', {
        method: 'POST',
        headers: {
          ...buildAuthHeaders(authHeader),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ task_ids: [taskId] })
      });
    } catch (e) {
      // ignore
    }
  }

  function extractVideoInfo(buffer) {
    if (!buffer) return null;
    if (buffer.includes('<video')) {
      const matches = buffer.match(/<video[\s\S]*?<\/video>/gi);
      if (matches && matches.length) {
        return { html: matches[matches.length - 1] };
      }
    }
    const mdMatches = buffer.match(/\[video\]\(([^)]+)\)/g);
    if (mdMatches && mdMatches.length) {
      const last = mdMatches[mdMatches.length - 1];
      const urlMatch = last.match(/\[video\]\(([^)]+)\)/);
      if (urlMatch) {
        return { url: urlMatch[1] };
      }
    }
    const urlMatches = buffer.match(/https?:\/\/[^\s<)]+/g);
    if (urlMatches && urlMatches.length) {
      return { url: urlMatches[urlMatches.length - 1] };
    }
    return null;
  }

  function renderVideoFromHtml(html) {
    const container = ensurePreviewSlot();
    if (!container) return;
    const body = container.querySelector('.video-item-body');
    if (!body) return;
    if (!firstRenderableAt) {
      firstRenderableAt = Date.now();
      if (startAt) {
        const ttfr = firstRenderableAt - startAt;
        console.log('[video] TTFR(ms):', ttfr);
        if (ttfrValue) ttfrValue.textContent = `${ttfr} ms`;
      }
    }
    body.innerHTML = html;
    const videoEl = body.querySelector('video');
    let videoUrl = '';
    if (videoEl) {
      videoEl.controls = true;
      videoEl.preload = 'metadata';
      const source = videoEl.querySelector('source');
      if (source && source.getAttribute('src')) {
        videoUrl = source.getAttribute('src');
      } else if (videoEl.getAttribute('src')) {
        videoUrl = videoEl.getAttribute('src');
      }
    }
    updateItemLinks(container, videoUrl);
  }

  function renderVideoFromUrl(url) {
    const container = ensurePreviewSlot();
    if (!container) return;
    const safeUrl = url || '';
    const body = container.querySelector('.video-item-body');
    if (!body) return;
    if (!firstRenderableAt) {
      firstRenderableAt = Date.now();
      if (startAt) {
        const ttfr = firstRenderableAt - startAt;
        console.log('[video] TTFR(ms):', ttfr);
        if (ttfrValue) ttfrValue.textContent = `${ttfr} ms`;
      }
    }
    body.innerHTML = `\n      <video controls preload="metadata">\n        <source src="${safeUrl}" type="video/mp4">\n      </video>\n    `;
    updateItemLinks(container, safeUrl);
  }

  function mapStageLabel(stage) {
    const map = {
      queued: t('common.connecting'),
      generating: t('common.generating'),
      recovering: t('video.recovering') || '正在恢复生成',
      retrying: t('video.retrying') || '正在重试',
      upscaling: t('video.superResolutionInProgress'),
      finalizing: t('video.finalizing') || '正在整理结果',
      completed: t('common.done'),
      failed: t('common.generationFailed')
    };
    return map[stage] || stage;
  }

  function normalizeVideoErrorKey(detail) {
    const text = String(detail || '').toLowerCase();
    if (text.includes('审查') || text.includes('blocked') || text.includes('moderated')) return '内容审查/拦截';
    if (text.includes('timeout') || text.includes('超时') || text.includes('idle')) return '上游超时';
    if (text.includes('rate') || text.includes('限流') || text.includes('429')) return '限流/号池繁忙';
    if (text.includes('reference') || text.includes('@图') || text.includes('placeholder')) return '参考图参数错误';
    return '其他错误';
  }

  function recordVideoError(detail) {
    const key = normalizeVideoErrorKey(detail);
    videoErrorStats.set(key, (videoErrorStats.get(key) || 0) + 1);
    renderVideoErrorTop();
  }

  function renderVideoErrorTop() {
    if (!videoErrorTop) return;
    if (!videoErrorStats.size) {
      videoErrorTop.textContent = '-';
      return;
    }
    const top = [...videoErrorStats.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k} (${v})`)
      .join(' · ');
    videoErrorTop.textContent = top;
  }

  function showRoundProgress(round, total, progress) {
    setIndeterminate(false);
    updateProgress(progress);
    if (progressText && Number.isFinite(round) && Number.isFinite(total) && total > 0) {
      progressText.textContent = `${Math.round(progress)}% · ${round}/${total}`;
    }
  }

  function handleVideoStageEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const stage = payload.stage || '';
    const detail = payload.detail || '';
    const label = mapStageLabel(stage);

    if (stage === 'failed') {
      const errText = detail || label;
      setStatus('error', errText);
      toast(errText, 'error');
      recordVideoError(errText);
      return;
    }

    if (stage === 'upscaling' || stage === 'queued' || stage === 'finalizing') {
      setIndeterminate(true);
      if (progressText) {
        progressText.textContent = label;
      }
    }

    setStatus('connected', detail || label);
  }

  function handleVideoRoundEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    const stage = payload.stage || '';
    const round = Number(payload.round_index || 0);
    const total = Number(payload.round_total || 0);
    if (stage === 'round_start') {
      if (progressText && round > 0 && total > 0) {
        progressText.textContent = `0% · ${round}/${total}`;
      }
      setIndeterminate(false);
      return;
    }
    if (stage === 'round_progress') {
      const p = Number(payload.progress || 0);
      showRoundProgress(round, total, p);
      return;
    }
    if (stage === 'round_done') {
      if (progressText && round > 0 && total > 0) {
        progressText.textContent = `100% · ${round}/${total}`;
      }
    }
  }

  function handleDelta(text) {
    if (!text) return;
    if (text.includes('<think>') || text.includes('</think>')) {
      return;
    }
    if (text.includes('超分辨率') || text.includes('super resolution')) {
      setStatus('connecting', t('video.superResolutionInProgress'));
      setIndeterminate(true);
      if (progressText) {
        progressText.textContent = t('video.superResolutionInProgress');
      }
      return;
    }

    if (!collectingContent) {
      const maybeVideo = text.includes('<video') || text.includes('[video](') || text.includes('http://') || text.includes('https://');
      if (maybeVideo) {
        collectingContent = true;
      }
    }

    if (collectingContent) {
      contentBuffer += text;
      const info = extractVideoInfo(contentBuffer);
      if (info) {
        if (info.html) {
          renderVideoFromHtml(info.html);
        } else if (info.url) {
          renderVideoFromUrl(info.url);
        }
      }
      return;
    }

    progressBuffer += text;
    const roundMatches = [...progressBuffer.matchAll(/\[round=(\d+)\/(\d+)\]\s*progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (roundMatches.length) {
      const last = roundMatches[roundMatches.length - 1];
      const round = parseInt(last[1], 10);
      const total = parseInt(last[2], 10);
      const value = parseFloat(last[3]);
      setIndeterminate(false);
      updateProgress(value);
      if (progressText && Number.isFinite(round) && Number.isFinite(total) && total > 0) {
        progressText.textContent = `${Math.round(value)}% · ${round}/${total}`;
      }
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 300));
      return;
    }

    const genericProgressMatches = [...progressBuffer.matchAll(/progress=([0-9]+(?:\.[0-9]+)?)%/g)];
    if (genericProgressMatches.length) {
      const last = genericProgressMatches[genericProgressMatches.length - 1];
      const value = parseFloat(last[1]);
      setIndeterminate(false);
      updateProgress(value);
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 240));
      return;
    }

    const matches = [...progressBuffer.matchAll(/进度\s*(\d+)%/g)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const value = parseInt(last[1], 10);
      setIndeterminate(false);
      updateProgress(value);
      progressBuffer = progressBuffer.slice(Math.max(0, progressBuffer.length - 200));
    }
  }

  function closeSource() {
    if (currentSource) {
      try {
        currentSource.close();
      } catch (e) {
        // ignore
      }
      currentSource = null;
    }
  }

  async function startConnection(payloadOverride) {
    const payload = payloadOverride || buildRequestPayload();
    const prompt = payload.prompt ? String(payload.prompt).trim() : '';
    if (!prompt) {
      toast(t('common.enterPrompt'), 'error');
      return;
    }

    if (isRunning) {
      toast(t('video.alreadyGenerating'), 'warning');
      return;
    }

    const authHeader = await ensureFunctionKey();
    if (authHeader === null) {
      toast(t('common.configurePublicKey'), 'error');
      window.location.href = '/login';
      return;
    }

    isRunning = true;
    startBtn.disabled = true;
    updateMeta();
    resetOutput(true);
    initPreviewSlot();
    firstProgressAt = 0;
    firstRenderableAt = 0;
    setStatus('connecting', t('common.connecting'));

    let taskId = '';
    try {
      taskId = await createVideoTask(authHeader, payload);
      lastRequestSnapshot = JSON.parse(JSON.stringify(payload));
      if (retryBtn) retryBtn.disabled = false;
    } catch (e) {
      setStatus('error', t('common.createTaskFailed'));
      startBtn.disabled = false;
      isRunning = false;
      return;
    }

    currentTaskId = taskId;
    startAt = Date.now();
    setStatus('connected', t('common.generating'));
    setButtons(true);
    setIndeterminate(true);
    startElapsedTimer();

    const rawPublicKey = normalizeAuthHeader(authHeader);
    const url = buildSseUrl(taskId, rawPublicKey);
    closeSource();
    const es = new EventSource(url);
    currentSource = es;

    es.onopen = () => {
      setStatus('connected', t('common.generating'));
    };

    es.onmessage = (event) => {
      if (!event || !event.data) return;
      if (event.data === '[DONE]') {
        finishRun();
        return;
      }
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      if (payload && payload.error) {
        const msg = payload.error.message || payload.error || t('common.generationFailed');
        toast(msg, 'error');
        setStatus('error', msg);
        finishRun(true);
        return;
      }
      const choice = payload.choices && payload.choices[0];
      const delta = choice && choice.delta ? choice.delta : null;
      if (delta && delta.content) {
        handleDelta(delta.content);
      }
      if (choice && choice.finish_reason === 'stop') {
        finishRun();
      }
    };

    es.addEventListener('video_generation.stage', (event) => {
      if (!event || !event.data) return;
      try {
        const payload = JSON.parse(event.data);
        handleVideoStageEvent(payload);
      } catch (e) {
        // ignore
      }
    });

    es.addEventListener('video_generation.round', (event) => {
      if (!event || !event.data) return;
      try {
        const payload = JSON.parse(event.data);
        handleVideoRoundEvent(payload);
      } catch (e) {
        // ignore
      }
    });

    es.onerror = () => {
      if (!isRunning) return;
      setStatus('error', t('common.connectionError'));
      finishRun(true);
    };
  }

  async function stopConnection() {
    const authHeader = await ensureFunctionKey();
    if (authHeader !== null) {
      await stopVideoTask(currentTaskId, authHeader);
    }
    closeSource();
    isRunning = false;
    currentTaskId = '';
    stopElapsedTimer();
    setButtons(false);
    setStatus('', t('common.notConnected'));
  }

  function finishRun(hasError) {
    if (!isRunning) return;
    closeSource();
    isRunning = false;
    setButtons(false);
    stopElapsedTimer();
    const now = Date.now();
    if (!hasError) {
      setStatus('connected', t('common.done'));
      setIndeterminate(false);
      updateProgress(100);
      if (startAt) {
        const totalMs = now - startAt;
        console.log('[video] total(ms):', totalMs);
        if (totalValue) totalValue.textContent = `${totalMs} ms`;
      }
    }
    if (durationValue && startAt) {
      const seconds = Math.max(0, Math.round((now - startAt) / 1000));
      durationValue.textContent = t('video.elapsedTime', { sec: seconds });
    }
  }

  if (startBtn) {
    startBtn.addEventListener('click', () => startConnection());
  }

  function buildSmartRetryPayload() {
    if (!lastRequestSnapshot) return null;
    const p = JSON.parse(JSON.stringify(lastRequestSnapshot));
    if (p.resolution_name === '720p') {
      p.resolution_name = '480p';
    } else {
      const len = Number(p.video_length || 6);
      p.video_length = Math.max(6, Math.min(30, len > 10 ? 10 : len));
    }
    return p;
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      const smart = buildSmartRetryPayload();
      if (!smart) {
        toast('暂无可重试的请求', 'warning');
        return;
      }
      const smartEnabled = !videoSmartRetryToggle || videoSmartRetryToggle.checked;
      if (!smartEnabled) {
        toast('已按原参数重试', 'warning');
        startConnection(lastRequestSnapshot);
        return;
      }
      toast('已启用智能重试：优先降分辨率/时长', 'warning');
      startConnection(smart);
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => stopConnection());
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => resetOutput());
  }

  if (videoErrorClearBtn) {
    videoErrorClearBtn.addEventListener('click', () => {
      videoErrorStats.clear();
      renderVideoErrorTop();
      toast('已清空失败统计', 'warning');
    });
  }

  if (videoErrorExportBtn) {
    videoErrorExportBtn.addEventListener('click', () => {
      const payload = {
        generated_at: new Date().toISOString(),
        stats: [...videoErrorStats.entries()].map(([reason, count]) => ({ reason, count }))
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'video_error_stats.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  if (videoStage) {
    videoStage.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.classList.contains('video-download')) return;
      event.preventDefault();
      const item = target.closest('.video-item');
      if (!item) return;
      const url = item.dataset.url || target.dataset.url || '';
      const index = item.dataset.index || '';
      if (!url) return;
      try {
        const response = await fetch(url, { mode: 'cors' });
        if (!response.ok) {
          throw new Error('download_failed');
        }
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = blobUrl;
        anchor.download = index ? `grok_video_${index}.mp4` : 'grok_video.mp4';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(blobUrl);
      } catch (e) {
        toast(t('video.downloadFailed'), 'error');
      }
    });
  }

  if (imageFileInput) {
    imageFileInput.addEventListener('change', () => {
      const files = imageFileInput.files ? Array.from(imageFileInput.files) : [];
      if (!files.length) {
        clearFileSelection();
        return;
      }
      if (files.length > MAX_REFERENCE_IMAGES) {
        clearFileSelection();
        toast(t('video.referenceLimit'), 'error');
        return;
      }
      if (imageUrlInput && imageUrlInput.value.trim()) {
        imageUrlInput.value = '';
      }
      Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === 'string') {
            resolve({ name: file.name, data: reader.result });
          } else {
            reject(new Error('read_failed'));
          }
        };
        reader.onerror = () => reject(new Error('read_failed'));
        reader.readAsDataURL(file);
      }))).then(items => {
        fileDataUrls = items.map(item => item.data);
        updateReferenceSummary(items.map((item, index) => `${index + 1}. ${item.name}`));
      }).catch(() => {
        fileDataUrls = [];
        toast(t('common.fileReadFailed'), 'error');
        updateReferenceSummary([]);
      });
    });
  }

  if (selectImageFileBtn && imageFileInput) {
    selectImageFileBtn.addEventListener('click', () => {
      imageFileInput.click();
    });
  }

  if (clearImageFileBtn) {
    clearImageFileBtn.addEventListener('click', () => {
      clearFileSelection();
    });
  }

  if (imageUrlInput) {
    imageUrlInput.addEventListener('input', () => {
      const urls = parseReferenceUrls(imageUrlInput.value);
      if (urls.length > MAX_REFERENCE_IMAGES) {
        toast(t('video.referenceLimit'), 'error');
      }
      if (imageUrlInput.value.trim() && fileDataUrls.length) {
        clearFileSelection();
      }
      if (urls.length) {
        updateReferenceSummary(urls.map((url, index) => `${index + 1}. ${url}`));
      } else if (!fileDataUrls.length) {
        updateReferenceSummary([]);
      }
    });
  }

  if (promptInput) {
    promptInput.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        startConnection();
      }
    });
  }

  updateMeta();
})();

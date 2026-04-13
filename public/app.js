const form = document.querySelector('#download-form');
const flash = document.querySelector('#flash');
const currentJobContainer = document.querySelector('#current-job');
const jobList = document.querySelector('#job-list');
const refreshButton = document.querySelector('#refresh-button');
const submitButton = document.querySelector('#submit-button');
const problemInput = document.querySelector('#problem-input');
const baseUrlElement = document.querySelector('#base-url');
const retentionElement = document.querySelector('#retention');

let currentJobId = window.localStorage.getItem('loj-download-current-job') || null;
let currentJobTimer = null;
let jobsTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }
  return payload;
}

function setFlash(message, tone = 'info') {
  if (!message) {
    flash.className = 'flash hidden';
    flash.textContent = '';
    return;
  }
  flash.className = `flash ${tone}`;
  flash.textContent = message;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function statusLabel(job) {
  if (job.status === 'completed') return '已完成';
  if (job.status === 'failed') return '失败';
  if (job.status === 'running') return '下载中';
  return '排队中';
}

function targetLabel(job) {
  if (job.targetLabel) return job.targetLabel;
  if (Number.isSafeInteger(job.problemId)) return String(job.problemId);
  if (Number.isSafeInteger(job.rangeStart) && Number.isSafeInteger(job.rangeEnd)) {
    return `${job.rangeStart}-${job.rangeEnd}`;
  }
  return '--';
}

function renderCurrentJob(job) {
  if (!job) {
    currentJobContainer.innerHTML = `
      <div class="empty-state">
        <h3>还没有任务</h3>
        <p>提交一个题号或题号区间后，这里会展示实时进度和下载入口。</p>
      </div>
    `;
    return;
  }

  const percent = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
  const metaLines = [];
  if (job.totalProblemCount) {
    let line = `题目 ${job.processedProblemCount || 0}/${job.totalProblemCount}`;
    if (job.currentProblemId) line += ` · 当前 P${job.currentProblemId}`;
    if (job.failedProblemIds?.length) line += ` · 失败 ${job.failedProblemIds.map((id) => `P${id}`).join(', ')}`;
    metaLines.push(line);
  }
  if (job.totalCount) {
    metaLines.push(`文件 ${job.downloadedCount || 0}/${job.totalCount} · ${formatBytes(job.downloadedSize || 0)}/${formatBytes(job.totalSize || 0)}`);
  }
  const progressMeta = metaLines
    .map((line) => `<p class="progress-meta">${escapeHtml(line)}</p>`)
    .join('');
  const downloadAction = job.downloadUrl
    ? `<a class="download-link" href="${job.downloadUrl}">下载 zip 包</a>`
    : '';
  const errorBlock = job.error ? `<p class="error-text">${escapeHtml(job.error)}</p>` : '';
  const warningBlock = job.warning ? `<p class="progress-meta">${escapeHtml(job.warning)}</p>` : '';

  currentJobContainer.innerHTML = `
    <article class="job-detail ${job.status}">
      <div class="job-detail-header">
        <div>
          <p class="section-label">Current Job</p>
          <h3>任务 #${escapeHtml(targetLabel(job))}</h3>
        </div>
        <span class="status-badge ${job.status}">${statusLabel(job)}</span>
      </div>
      <p class="job-message">${escapeHtml(job.message || '等待中')}</p>
      <div class="progress-track">
        <div class="progress-fill" style="width:${percent}%"></div>
      </div>
      <div class="progress-row">
        <span>${percent}%</span>
        <span>更新时间 ${escapeHtml(formatTime(job.updatedAt))}</span>
      </div>
      ${progressMeta}
      ${warningBlock}
      ${errorBlock}
      <div class="job-actions">
        ${downloadAction}
      </div>
    </article>
  `;
}

function renderJobList(jobs) {
  if (!jobs.length) {
    jobList.innerHTML = `
      <div class="empty-state compact">
        <p>暂无历史任务。</p>
      </div>
    `;
    return;
  }

  jobList.innerHTML = jobs
    .map((job) => {
      const percent = Math.max(0, Math.min(100, Math.round((job.progress || 0) * 100)));
      const action = job.downloadUrl
        ? `<a class="inline-link" href="${job.downloadUrl}">下载</a>`
        : `<button type="button" class="inline-link plain" data-job-id="${job.id}">查看</button>`;
      return `
        <article class="job-card ${job.id === currentJobId ? 'active' : ''}">
          <div class="job-card-head">
            <strong>#${escapeHtml(targetLabel(job))}</strong>
            <span class="status-badge ${job.status}">${statusLabel(job)}</span>
          </div>
          <p class="job-card-message">${escapeHtml(job.message || '等待中')}</p>
          <div class="mini-progress">
            <div class="mini-progress-fill" style="width:${percent}%"></div>
          </div>
          <div class="job-card-foot">
            <span>${escapeHtml(formatTime(job.createdAt))}</span>
            ${action}
          </div>
        </article>
      `;
    })
    .join('');

  jobList.querySelectorAll('button[data-job-id]').forEach((button) => {
    button.addEventListener('click', () => {
      currentJobId = button.getAttribute('data-job-id');
      window.localStorage.setItem('loj-download-current-job', currentJobId);
      pollCurrentJob();
      refreshJobs();
    });
  });
}

async function loadConfig() {
  const config = await requestJson('api/config');
  baseUrlElement.textContent = config.baseUrl;
  retentionElement.textContent = `${config.retentionHours} 小时`;
}

async function refreshJobs() {
  const payload = await requestJson('api/jobs');
  renderJobList(payload.jobs || []);
  if (!currentJobId && payload.jobs?.length) {
    currentJobId = payload.jobs[0].id;
    window.localStorage.setItem('loj-download-current-job', currentJobId);
  }
}

function stopCurrentJobPolling() {
  if (currentJobTimer) {
    window.clearTimeout(currentJobTimer);
    currentJobTimer = null;
  }
}

async function pollCurrentJob() {
  if (!currentJobId) {
    renderCurrentJob(null);
    return;
  }

  try {
    const payload = await requestJson(`api/jobs/${currentJobId}`);
    renderCurrentJob(payload.job);
    if (payload.job.status === 'running' || payload.job.status === 'queued') {
      currentJobTimer = window.setTimeout(pollCurrentJob, 2000);
    } else {
      stopCurrentJobPolling();
      refreshJobs();
    }
  } catch (error) {
    stopCurrentJobPolling();
    renderCurrentJob(null);
    setFlash(error.message, 'error');
  }
}

async function submitJob(event) {
  event.preventDefault();
  const inputText = problemInput.value.trim();
  if (!inputText) {
    setFlash('请输入题号或题号区间。', 'error');
    return;
  }

  submitButton.disabled = true;
  setFlash('任务已提交，正在加入队列。');

  try {
    const payload = await requestJson('api/jobs', {
      body: JSON.stringify({ problemInput: inputText }),
      method: 'POST',
    });
    currentJobId = payload.job.id;
    window.localStorage.setItem('loj-download-current-job', currentJobId);
    renderCurrentJob(payload.job);
    stopCurrentJobPolling();
    pollCurrentJob();
    refreshJobs();
    setFlash(`任务 #${inputText} 已进入队列。`, 'success');
    form.reset();
  } catch (error) {
    setFlash(error.message, 'error');
  } finally {
    submitButton.disabled = false;
  }
}

form.addEventListener('submit', submitJob);
refreshButton.addEventListener('click', () => {
  setFlash('');
  refreshJobs().catch((error) => setFlash(error.message, 'error'));
  pollCurrentJob();
});

window.addEventListener('load', async () => {
  try {
    await Promise.all([loadConfig(), refreshJobs()]);
    if (currentJobId) {
      pollCurrentJob();
    } else {
      renderCurrentJob(null);
    }
    jobsTimer = window.setInterval(() => {
      refreshJobs().catch(() => {});
    }, 10000);
  } catch (error) {
    setFlash(error.message, 'error');
  }
});

window.addEventListener('beforeunload', () => {
  stopCurrentJobPolling();
  if (jobsTimer) window.clearInterval(jobsTimer);
});

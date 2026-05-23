import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  SessionConfig,
  videoBrowserLink,
  videoComplete,
  videoInit,
  VideoInitResponse,
} from "../api";

const PANEL_ID = "jivahireVideoRecorder";
const PANEL_TITLE = "Record Solution Explainer";

/**
 * Open a full-tab WebviewPanel that walks the candidate through the
 * post-submit identity-verification recording flow:
 *   init  → getUserMedia → record → PUT to S3 → complete
 *
 * Non-blocking: errors here are surfaced to the candidate but do NOT
 * stop the rest of the submit flow — grading runs whether or not the
 * video uploads.
 */
export function openVideoRecorder(config: SessionConfig): void {
  const panel = vscode.window.createWebviewPanel(
    PANEL_ID,
    PANEL_TITLE,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );

  const nonce = crypto.randomBytes(16).toString("base64");
  const cspSource = panel.webview.cspSource;
  panel.webview.html = renderHtml(cspSource, nonce);

  panel.webview.onDidReceiveMessage(async (msg: VideoWebviewMessage) => {
    if (msg.type === "init") {
      try {
        const init = await videoInit(config);
        panel.webview.postMessage({ type: "init.ok", init });
      } catch (err) {
        panel.webview.postMessage({
          type: "init.error",
          message: friendlyInitError(err),
        });
      }
    } else if (msg.type === "complete") {
      try {
        await videoComplete(config, msg.s3_key, msg.duration_seconds);
        panel.webview.postMessage({ type: "complete.ok" });
        vscode.window.showInformationMessage(
          "Solution explainer video uploaded — thank you!",
        );
        // Give the webview a moment to render the success state before closing.
        setTimeout(() => panel.dispose(), 1500);
      } catch (err) {
        panel.webview.postMessage({
          type: "complete.error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (msg.type === "no-camera") {
      void offerBrowserFallback(
        config,
        "Camera or microphone unavailable in this environment. Your code submission has already been received — you can record the explainer from another device instead.",
      );
    } else if (msg.type === "request-browser-link") {
      void offerBrowserFallback(
        config,
        "We'll open the recorder in your default browser. You can also copy the link and open it on a phone.",
      );
    }
  });
}

/**
 * Mint a one-time recording URL and offer the candidate three ways to use it:
 *   1. Open it now in the default browser.
 *   2. Copy it to clipboard (so they can text/email it to their phone).
 *
 * The link is bound to the candidate's session and expires after ~15 minutes
 * or when the 10-minute post-submit upload window closes, whichever is sooner.
 */
async function offerBrowserFallback(
  config: SessionConfig,
  preamble: string,
): Promise<void> {
  let link: { url: string; expires_unix: number };
  try {
    link = await videoBrowserLink(config);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const m = raw.match(/HTTP\s+(\d{3})/i);
    const status = m ? parseInt(m[1], 10) : 0;
    let msg = "Could not create a browser recording link. Contact your recruiter.";
    if (status === 410) msg = "The 10-minute upload window has closed.";
    else if (status === 409) msg = "A video has already been uploaded for this session.";
    else if (status === 503) msg = "Video upload is not configured on this server.";
    vscode.window.showWarningMessage(msg, "Dismiss");
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    preamble,
    { modal: false },
    "Open in browser",
    "Copy link",
  );
  if (choice === "Open in browser") {
    void vscode.env.openExternal(vscode.Uri.parse(link.url));
  } else if (choice === "Copy link") {
    await vscode.env.clipboard.writeText(link.url);
    vscode.window.showInformationMessage(
      "Recording link copied. Open it on a phone or another browser to record.",
    );
  }
}

function friendlyInitError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/HTTP\s+(\d{3})/i);
  if (m) {
    const status = parseInt(m[1], 10);
    if (status === 410) return "The 10-minute video upload window has closed.";
    if (status === 409) return "You have already uploaded a video for this session.";
    if (status === 503) return "Video upload is not configured on this server.";
  }
  return "Could not start the recorder. Please contact your recruiter.";
}

type VideoWebviewMessage =
  | { type: "init" }
  | { type: "no-camera" }
  | { type: "request-browser-link" }
  | { type: "complete"; s3_key: string; duration_seconds: number };

function renderHtml(cspSource: string, nonce: string): string {
  // connect-src allows the server (validated origin embedded by the webview
  // via init.upload_url) and any S3 endpoint. AWS uses a handful of S3 host
  // shapes (virtual-hosted, path-style, accelerate, regional). The wildcard
  // keeps the CSP tight to amazonaws.com without enumerating every variant.
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    "media-src blob:",
    "img-src data:",
    "connect-src https://*.amazonaws.com https://*.s3.amazonaws.com https:",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${PANEL_TITLE}</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .sub { color: var(--vscode-descriptionForeground); margin: 0 0 20px; font-size: 13px; }
  .prompts { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 12px 16px; border-radius: 4px; margin-bottom: 16px; }
  .prompts ol { margin: 4px 0 0 16px; padding: 0; }
  .prompts li { margin: 4px 0; font-size: 13px; }
  video { width: 100%; background: #000; border-radius: 6px; aspect-ratio: 16 / 9; }
  .controls { display: flex; gap: 8px; align-items: center; margin: 12px 0; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .timer { font-family: var(--vscode-editor-font-family); font-size: 16px; margin-left: auto; color: var(--vscode-descriptionForeground); }
  .timer.armed { color: var(--vscode-charts-red); }
  .progress { width: 100%; height: 8px; background: var(--vscode-progressBar-background, #333); border-radius: 4px; overflow: hidden; margin: 12px 0; display: none; }
  .progress.show { display: block; }
  .progress > div { height: 100%; background: var(--vscode-progressBar-foreground, var(--vscode-button-background)); width: 0%; transition: width 0.2s ease; }
  .status { font-size: 13px; margin: 12px 0; min-height: 18px; }
  .error { color: var(--vscode-errorForeground); }
  .ok { color: var(--vscode-charts-green); }
</style>
</head>
<body>
  <h1>Record a short solution explainer</h1>
  <p class="sub">This brief video helps us verify identity and gives you a chance to walk through your thinking. Recording stays between you and the recruiter.</p>

  <div class="prompts">
    <strong>What to cover</strong>
    <ol id="prompt-list"><li>Loading prompts…</li></ol>
  </div>

  <video id="preview" autoplay muted playsinline></video>

  <div class="controls">
    <button id="start" disabled>Start recording</button>
    <button id="stop" class="secondary" disabled>Stop</button>
    <span class="timer" id="timer">0:00</span>
  </div>

  <div class="progress" id="progress"><div></div></div>
  <div class="status" id="status">Requesting camera access…</div>

  <div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border, #444);">
    <button id="browser-link" class="secondary">Record from another device</button>
    <span style="margin-left: 8px; font-size: 12px; color: var(--vscode-descriptionForeground);">
      Opens a short-lived link in your browser — useful if this machine has no camera.
    </span>
  </div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const promptList = $('prompt-list');
  const preview = $('preview');
  const startBtn = $('start');
  const stopBtn = $('stop');
  const timerEl = $('timer');
  const progressEl = $('progress');
  const progressBar = progressEl.firstElementChild;
  const statusEl = $('status');

  let initData = null;
  let mediaStream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let timerInterval = null;
  let minDur = 30;
  let maxDur = 300;

  function setStatus(msg, cls) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (cls || '');
  }

  function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  vscode.postMessage({ type: 'init' });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init.ok') {
      initData = msg.init;
      minDur = initData.min_duration_seconds || 30;
      maxDur = initData.max_duration_seconds || 300;
      promptList.innerHTML = '';
      (initData.prompts || []).forEach((p) => {
        const li = document.createElement('li');
        li.textContent = p;
        promptList.appendChild(li);
      });
      requestCamera();
    } else if (msg.type === 'init.error') {
      setStatus(msg.message, 'error');
      promptList.innerHTML = '<li>Video upload unavailable.</li>';
    } else if (msg.type === 'complete.ok') {
      setStatus('Upload complete. Thank you!', 'ok');
      progressBar.style.width = '100%';
    } else if (msg.type === 'complete.error') {
      setStatus('Could not finalize upload: ' + msg.message, 'error');
      startBtn.disabled = false;
    }
  });

  async function requestCamera() {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      preview.srcObject = mediaStream;
      startBtn.disabled = false;
      setStatus('Camera ready. Press "Start recording" when you are ready (min ' + minDur + 's, max ' + maxDur + 's).');
    } catch (err) {
      setStatus('Camera or microphone unavailable: ' + (err && err.name ? err.name : err), 'error');
      vscode.postMessage({ type: 'no-camera' });
    }
  }

  startBtn.addEventListener('click', () => {
    if (!mediaStream) return;
    chunks = [];
    const mime = pickMime();
    try {
      recorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
    } catch (e) {
      setStatus('MediaRecorder unavailable: ' + e, 'error');
      return;
    }
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    recorder.addEventListener('stop', onRecorderStop);
    recorder.start();
    startedAt = Date.now();
    startBtn.disabled = true;
    stopBtn.disabled = true;  // re-enabled once min duration met
    setStatus('Recording… you can stop after ' + minDur + 's.');
    timerInterval = setInterval(updateTimer, 200);
  });

  stopBtn.addEventListener('click', () => {
    if (recorder && recorder.state === 'recording') recorder.stop();
  });

  $('browser-link').addEventListener('click', () => {
    vscode.postMessage({ type: 'request-browser-link' });
  });

  function pickMime() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return '';
  }

  function updateTimer() {
    const elapsed = (Date.now() - startedAt) / 1000;
    timerEl.textContent = fmt(elapsed) + ' / ' + fmt(maxDur);
    if (elapsed >= minDur) {
      stopBtn.disabled = false;
      timerEl.classList.add('armed');
    }
    if (elapsed >= maxDur) {
      if (recorder && recorder.state === 'recording') recorder.stop();
    }
  }

  function onRecorderStop() {
    clearInterval(timerInterval);
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    // Stop the camera so the indicator light turns off.
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    stopBtn.disabled = true;
    startBtn.disabled = true;

    if (elapsedSec < minDur) {
      setStatus('Recording was too short (' + elapsedSec + 's). Please reload and try again.', 'error');
      return;
    }
    if (!initData) {
      setStatus('Upload session lost — please reload.', 'error');
      return;
    }

    const blob = new Blob(chunks, { type: chunks[0] && chunks[0].type ? chunks[0].type : 'video/webm' });
    uploadToS3(blob, elapsedSec);
  }

  function uploadToS3(blob, durationSec) {
    setStatus('Uploading… ' + Math.round(blob.size / 1024 / 1024 * 10) / 10 + ' MB');
    progressEl.classList.add('show');
    progressBar.style.width = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('PUT', initData.upload_url, true);
    xhr.setRequestHeader('Content-Type', 'video/webm');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        progressBar.style.width = ((e.loaded / e.total) * 100).toFixed(1) + '%';
      }
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        progressBar.style.width = '100%';
        setStatus('Finalizing…');
        vscode.postMessage({
          type: 'complete',
          s3_key: initData.s3_key,
          duration_seconds: durationSec,
        });
      } else {
        setStatus('Upload failed (status ' + xhr.status + '). Please reload to retry.', 'error');
      }
    });
    xhr.addEventListener('error', () => {
      setStatus('Network error during upload. Please reload to retry.', 'error');
    });
    xhr.send(blob);
  }
})();
</script>
</body>
</html>`;
}

document.addEventListener('alpine:init', () => {
  Alpine.data('App', () => ({
    // ── auth
    view: 'login',
    adminToken: localStorage.getItem('jh_token') || '',
    authError: '',

    // ── theme
    theme: document.documentElement.getAttribute('data-theme') || 'light',

    // ── sessions list
    sessions: [],
    challenges: [],         // flat id list, kept for back-compat
    challengeItems: [],     // [{id, title, language, difficulty, max_minutes, tags[]}]
    search: '',
    statusFilter: '',
    loading: false,
    listError: '',

    // ── session detail
    selectedSession: null,
    detailError: '',

    // ── invite drawer
    showInvitePanel: false,
    inviteForm: { email: '', challengeId: '', sourceRef: 'main', selection: '', maxMinutes: 60, budgetUsd: 2.00, sessionKey: '', meetLink: '', scheduledLocal: '', panelistEmails: '', panelExpanded: false, requireEndVideo: false },
    // Combined challenge+variant options for the Challenge dropdown. Each entry
    // is { value: "<challengeId>::<ref>", challengeId, sourceRef, label }.
    inviteOptions: [],
    inviteLoading: false,
    inviteError: '',
    inviteResult: null,  // { sessionKey }
    copied: false,

    // ── challenge file editor (Files view)
    filesChallengeId: '',
    filesBranch: 'main',
    filesBranches: ['main'],
    filesTree: [],
    filesLoading: false,
    filesCurrentPath: '',
    filesContent: '',          // live buffer for the open file
    filesSha: null,
    // Per-file edit buffer, keyed by path: { content, original, sha }. Holds
    // every file touched this session so switching files never loses edits.
    // A file is "unsaved" when content !== original.
    filesEdits: {},
    filesVariantName: 'variant/',
    filesSaving: false,
    filesSaveMsg: '',
    filesError: '',

    // ─────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────
    async init() {
      window.addEventListener('popstate', () => this._restoreFromHash());
      if (this.adminToken) {
        // A token restored from localStorage is untrusted: it may be malformed
        // (whitespace/control chars → uvicorn 400) or simply no longer valid.
        // Verify it before showing the dashboard, otherwise a bad token lands
        // the user on a dashboard where every authenticated GET fails.
        const token = this.adminToken.trim();
        if (!this._isValidTokenFormat(token) || !(await this._testToken(token))) {
          this.logout();
          return;
        }
        this.adminToken = token;
        localStorage.setItem('jh_token', token);
        await Promise.all([this.loadSessions(), this.loadChallenges()]);
        await this._restoreFromHash();
      }
    },

    toggleTheme() {
      this.theme = this.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', this.theme);
      localStorage.setItem('jh_theme', this.theme);
    },

    async _restoreFromHash() {
      if (!this.adminToken) return;
      const hash = window.location.hash.slice(1); // strip '#'
      if (hash.startsWith('session/')) {
        const id = hash.slice('session/'.length);
        await this.openDetail(id, false);
      } else if (hash === 'files') {
        await this.openFiles(false);
      } else {
        this.view = 'list';
      }
    },

    _setHash(hash) {
      history.pushState(null, '', '#' + hash);
    },

    // ─────────────────────────────────────────────
    // Auth
    // ─────────────────────────────────────────────
    async login() {
      this.authError = '';
      const token = this.adminToken.trim();
      if (!token) { this.authError = 'Enter your admin token.'; return; }
      if (!this._isValidTokenFormat(token)) {
        this.authError = 'Token contains invalid characters (spaces, line breaks, or non-ASCII). Re-copy it without any surrounding whitespace.';
        return;
      }
      this.adminToken = token;  // persist the cleaned value, not the raw input
      const ok = await this._testToken(token);
      if (ok) {
        localStorage.setItem('jh_token', token);
        await this.loadSessions();
        await this.loadChallenges();
        this.view = 'list';
        this._setHash('list');
      } else {
        this.authError = 'Invalid admin token.';
      }
    },

    // A valid admin token must be a single run of printable ASCII (0x21–0x7E):
    // no spaces, tabs, line breaks, control chars, or non-Latin-1 bytes. Such
    // characters are illegal in an HTTP header value and make uvicorn reject the
    // request with a bare 400 Bad Request before it ever reaches a route.
    _isValidTokenFormat(token) {
      return /^[\x21-\x7E]+$/.test(token);
    },

    async _testToken(token) {
      try {
        const r = await fetch('/api/v1/sessions', { headers: { 'x-admin-token': token } });
        // Require a genuinely OK response. The old check only rejected 401/403,
        // so a 400 (malformed header) or 5xx counted as "valid" and let a bad
        // token through to the dashboard.
        return r.ok;
      } catch { return false; }
    },

    logout() {  // also called automatically on 401/403
      localStorage.removeItem('jh_token');
      this.adminToken = '';
      this.sessions = [];
      this.selectedSession = null;
      this.view = 'login';
    },

    // ─────────────────────────────────────────────
    // Sessions list
    // ─────────────────────────────────────────────
    async loadSessions() {
      this.loading = true;
      this.listError = '';
      try {
        const r = await this._get('/api/v1/sessions');
        this.sessions = r.sessions ?? [];
      } catch (e) {
        this.listError = e.message;
      } finally {
        this.loading = false;
      }
    },

    async loadChallenges() {
      try {
        const r = await this._get('/api/v1/challenges');
        this.challenges = r.challenges ?? [];
        // Newer payload includes per-challenge metadata; fall back to deriving
        // it from the flat id list when the server is on the older shape.
        this.challengeItems = (r.items && r.items.length)
          ? r.items
          : this.challenges.map((id) => ({ id, title: id, language: 'unknown', difficulty: 'unknown', tags: [] }));
        if (this.challenges.length > 0 && !this.inviteForm.challengeId) {
          this.inviteForm.challengeId = this.challenges[0];
        }
      } catch { /* non-fatal */ }
    },

    challengeLabel(c) {
      const lang = c.language && c.language !== 'unknown' ? c.language : null;
      const diff = c.difficulty && c.difficulty !== 'unknown' ? c.difficulty : null;
      const meta = [lang, diff].filter(Boolean).join(' · ');
      return meta ? `${c.title} — ${meta}` : c.title;
    },

    get filteredSessions() {
      return this.sessions.filter(s => {
        const q = this.search.toLowerCase();
        const matchSearch = !q ||
          s.candidate_email.toLowerCase().includes(q) ||
          s.challenge_id.toLowerCase().includes(q) ||
          s.session_key.toLowerCase().includes(q);
        const matchStatus = !this.statusFilter || s.status === this.statusFilter;
        return matchSearch && matchStatus;
      });
    },

    // ─────────────────────────────────────────────
    // Session detail
    // ─────────────────────────────────────────────
    async openDetail(id, pushHash = true) {
      this.detailError = '';
      this.selectedSession = null;
      this.view = 'detail';
      if (pushHash) this._setHash('session/' + id);
      try {
        const r = await this._get(`/api/v1/sessions/${id}`);
        r.videoUrl = null;
        this.selectedSession = r;
        if (r.session && r.session.video_s3_key) {
          try {
            const v = await this._get(`/api/v1/sessions/${id}/video-url`);
            this.selectedSession.videoUrl = v.video_url;
          } catch (_) {
            // 404/503/etc. — leave videoUrl null; UI shows fallback text.
          }
        }
      } catch (e) {
        this.detailError = e.message;
      }
    },

    backToList() {
      this.view = 'list';
      this.selectedSession = null;
      this._setHash('list');
    },

    // ─────────────────────────────────────────────
    // Invite drawer
    // ─────────────────────────────────────────────
    async openInvite() {
      this.inviteResult = null;
      this.inviteError = '';
      this.inviteForm.email = '';
      this.inviteForm.sessionKey = '';
      this.inviteForm.maxMinutes = 60;
      this.inviteForm.budgetUsd = 2.00;
      this.inviteForm.meetLink = '';
      this.inviteForm.scheduledLocal = '';
      this.inviteForm.panelistEmails = '';
      this.inviteForm.panelExpanded = false;
      this.inviteForm.requireEndVideo = false;
      this.inviteForm.sourceRef = 'main';
      this.inviteForm.selection = '';
      this.inviteOptions = [];
      this.showInvitePanel = true;
      await this.loadInviteOptions();
      // Default to the first option (each challenge's "main" sorts first).
      if (this.inviteOptions.length) {
        this.applyInviteSelection(this.inviteOptions[0].value);
      } else if (this.challenges.length) {
        this.inviteForm.challengeId = this.challenges[0];
      }
    },

    closeInvite() {
      this.showInvitePanel = false;
      this.inviteResult = null;
    },

    // Build the Challenge dropdown options: each challenge contributes its
    // original ("main") plus one entry per saved variant/* branch, all sharing
    // the challenge's name and differentiated by the branch suffix. Branches
    // are fetched per challenge in parallel; any failure falls back to "main".
    async loadInviteOptions() {
      const results = await Promise.all(this.challengeItems.map(async (c) => {
        try {
          const r = await this._get(`/api/v1/admin/repos/${encodeURIComponent(c.id)}/branches`);
          return { c, branches: (r.branches && r.branches.length) ? r.branches : ['main'] };
        } catch {
          return { c, branches: ['main'] };
        }
      }));
      const opts = [];
      for (const { c, branches } of results) {
        opts.push({ value: `${c.id}::main`, challengeId: c.id, sourceRef: 'main', label: this.challengeLabel(c) });
        for (const b of branches) {
          if (b === 'main') continue;
          opts.push({ value: `${c.id}::${b}`, challengeId: c.id, sourceRef: b, label: `${this.challengeLabel(c)} — ${b}` });
        }
      }
      this.inviteOptions = opts;
    },

    // Parse a "<challengeId>::<ref>" dropdown value into the invite form.
    applyInviteSelection(value) {
      const i = (value || '').indexOf('::');
      if (i === -1) return;
      this.inviteForm.selection = value;
      this.inviteForm.challengeId = value.slice(0, i);
      this.inviteForm.sourceRef = value.slice(i + 2);
    },

    async sendInvite() {
      this.inviteError = '';
      if (!this.inviteForm.email.trim()) { this.inviteError = 'Email is required.'; return; }
      if (!this.inviteForm.challengeId) { this.inviteError = 'Select a challenge.'; return; }
      if (!this.inviteForm.sessionKey.trim()) { this.inviteError = 'Session key is required.'; return; }

      // Guard against the historical Alpine binding bug where the select displayed
      // one option but the model was stale. Re-read the actual <select> value
      // (a "<challengeId>::<ref>" token) and re-derive challenge + source ref.
      const selectEl = document.querySelector('select[x-model="inviteForm.selection"]');
      if (selectEl && selectEl.value && selectEl.value !== this.inviteForm.selection) {
        this.applyInviteSelection(selectEl.value);
      }
      if (this.challenges.length && !this.challenges.includes(this.inviteForm.challengeId)) {
        this.inviteError = `Unknown challenge "${this.inviteForm.challengeId}". Pick one from the list.`;
        return;
      }
      if (!confirm(`Send invite for challenge "${this.inviteForm.challengeId}" to ${this.inviteForm.email.trim()}?`)) {
        return;
      }

      const panelOn = !!this.inviteForm.panelExpanded;
      const meetLink = panelOn ? (this.inviteForm.meetLink || '').trim() : '';
      if (panelOn) {
        if (!meetLink) {
          this.inviteError = 'Video meeting link is required for a panel interview.';
          return;
        }
        if (!meetLink.startsWith('https://')) {
          this.inviteError = 'Video meeting link must start with https://';
          return;
        }
      }

      // datetime-local gives "YYYY-MM-DDTHH:mm" in the browser's local TZ. new
      // Date() parses that as local time; .getTime() returns ms since epoch
      // in UTC. Divide by 1000 to get the epoch seconds the API expects.
      let scheduledAt = null;
      if (panelOn) {
        if (!this.inviteForm.scheduledLocal) {
          this.inviteError = 'Scheduled start is required for a panel interview.';
          return;
        }
        const parsed = new Date(this.inviteForm.scheduledLocal);
        if (Number.isNaN(parsed.getTime())) {
          this.inviteError = 'Could not read the scheduled start time.';
          return;
        }
        scheduledAt = Math.floor(parsed.getTime() / 1000);
      }

      const panelistEmails = panelOn
        ? (this.inviteForm.panelistEmails || '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [];
      const badPanelist = panelistEmails.find((e) => !e.includes('@'));
      if (badPanelist) {
        this.inviteError = `Invalid panelist email: ${badPanelist}`;
        return;
      }

      this.inviteLoading = true;
      try {
        const body = {
          session_key: this.inviteForm.sessionKey.trim(),
          candidate_email: this.inviteForm.email.trim(),
          challenge_id: this.inviteForm.challengeId,
          source_ref: this.inviteForm.sourceRef || 'main',
          max_minutes: Number(this.inviteForm.maxMinutes),
          llm_budget_usd: Number(this.inviteForm.budgetUsd),
        };
        if (meetLink) body.meet_link = meetLink;
        if (scheduledAt !== null) body.scheduled_at = scheduledAt;
        if (panelistEmails.length > 0) body.panelist_emails = panelistEmails;
        // Override is panel-only — for async sessions the server already
        // requires the end video unconditionally. Sending the flag without
        // a meet_link would have no effect server-side but we omit it to
        // keep the request shape honest.
        if (panelOn && this.inviteForm.requireEndVideo) body.require_end_video = true;
        const r = await this._post('/api/v1/sessions', body);
        this.inviteResult = { sessionKey: this.inviteForm.sessionKey.trim(), sessionId: r.session_id };
        await this.loadSessions();
      } catch (e) {
        this.inviteError = e.message;
      } finally {
        this.inviteLoading = false;
      }
    },

    async copyKey() {
      if (!this.inviteResult) return;
      try {
        await navigator.clipboard.writeText(this.inviteResult.sessionKey);
        this.copied = true;
        setTimeout(() => { this.copied = false; }, 1800);
      } catch { /* clipboard access denied */ }
    },

    // ─────────────────────────────────────────────
    // Challenge file editor
    // ─────────────────────────────────────────────
    async openFiles(pushHash = true) {
      // Re-entering the editor (e.g. via the nav) discards in-memory edits.
      if (this.view === 'files' && !this._confirmDiscard()) return;
      this.view = 'files';
      if (pushHash) this._setHash('files');
      this.filesError = '';
      this.filesBranch = 'main';
      this.filesVariantName = 'variant/';
      this._resetEditor();
      if (!this.filesChallengeId && this.challengeItems.length) {
        this.filesChallengeId = this.challengeItems[0].id;
      }
      if (this.filesChallengeId) {
        await this.loadFilesBranches();
        await this.loadFilesTree();
      }
    },

    async changeFilesChallenge(id, el) {
      if (!this._confirmDiscard()) { if (el) el.value = this.filesChallengeId; return; }
      this.filesChallengeId = id;
      this.filesBranch = 'main';
      this.filesVariantName = 'variant/';
      this._resetEditor();
      await this.loadFilesBranches();
      await this.loadFilesTree();
    },

    async changeFilesBranch(branch, el) {
      if (!this._confirmDiscard()) { if (el) el.value = this.filesBranch; return; }
      this.filesBranch = branch;
      // Editing a variant saves back to itself; editing main forks a new variant.
      this.filesVariantName = branch.startsWith('variant/') ? branch : 'variant/';
      this._resetEditor();
      await this.loadFilesTree();
    },

    // Clear the editor and ALL buffered edits. Edits belong to one
    // challenge+branch, so switching either resets them.
    _resetEditor() {
      this.filesCurrentPath = '';
      this.filesContent = '';
      this.filesSha = null;
      this.filesEdits = {};
      this.filesSaveMsg = '';
    },

    // Paths with unsaved changes. Reads filesContent for the open file so its
    // dirty state stays live as the user types.
    get unsavedFiles() {
      return Object.keys(this.filesEdits).filter((p) => this.isFileDirty(p));
    },

    isFileDirty(path) {
      const e = this.filesEdits[path];
      if (!e) return false;
      const content = (path === this.filesCurrentPath) ? this.filesContent : e.content;
      return content !== e.original;
    },

    // Persist the open file's live buffer back into filesEdits before we
    // switch away from it, so its edits survive the switch.
    _stashActive() {
      const e = this.filesEdits[this.filesCurrentPath];
      if (e) { e.content = this.filesContent; e.sha = this.filesSha; }
    },

    _confirmDiscard() {
      const n = this.unsavedFiles.length;
      if (n === 0) return true;
      return confirm(`You have unsaved changes in ${n} file${n === 1 ? '' : 's'}. Discard them?`);
    },

    async loadFilesBranches() {
      if (!this.filesChallengeId) return;
      try {
        const r = await this._get(`/api/v1/admin/repos/${encodeURIComponent(this.filesChallengeId)}/branches`);
        this.filesBranches = (r.branches && r.branches.length) ? r.branches : ['main'];
        if (!this.filesBranches.includes(this.filesBranch)) this.filesBranch = 'main';
      } catch (e) { this.filesError = e.message; }
    },

    async loadFilesTree() {
      if (!this.filesChallengeId) return;
      this.filesLoading = true;
      this.filesError = '';
      this.filesTree = [];
      try {
        const r = await this._get(`/api/v1/admin/repos/${encodeURIComponent(this.filesChallengeId)}/tree?ref=${encodeURIComponent(this.filesBranch)}`);
        this.filesTree = r.files ?? [];
      } catch (e) {
        this.filesError = e.message;
      } finally {
        this.filesLoading = false;
      }
    },

    async openFile(path) {
      this.filesError = '';
      this.filesSaveMsg = '';
      this._stashActive();  // keep edits to the file we're leaving
      const cached = this.filesEdits[path];
      if (cached) {
        this.filesCurrentPath = path;
        this.filesContent = cached.content;
        this.filesSha = cached.sha;
        return;
      }
      try {
        const q = `path=${encodeURIComponent(path)}&ref=${encodeURIComponent(this.filesBranch)}`;
        const r = await this._get(`/api/v1/admin/repos/${encodeURIComponent(this.filesChallengeId)}/file?${q}`);
        this.filesEdits[path] = { content: r.content, original: r.content, sha: r.sha };
        this.filesCurrentPath = r.path;
        this.filesContent = r.content;
        this.filesSha = r.sha;
      } catch (e) {
        this.filesError = e.message;
      }
    },

    _resolveVariantBranch() {
      let branch = (this.filesVariantName || '').trim();
      if (branch && !branch.startsWith('variant/')) branch = 'variant/' + branch;
      if (!branch || branch === 'variant/') return null;
      return branch;
    },

    // Commit one path's buffer to `branch`. Returns the new blob sha.
    async _commitFile(path, branch) {
      const e = this.filesEdits[path];
      const r = await this._post(`/api/v1/admin/repos/${encodeURIComponent(this.filesChallengeId)}/save`, {
        branch,
        path,
        content: e.content,
        sha: e.sha,
        base_ref: this.filesBranch,
      });
      // Mark this file clean: original now matches the committed content.
      this.filesEdits[path] = { content: e.content, original: e.content, sha: r.sha };
      return r.sha;
    },

    async saveFile() {
      this.filesError = '';
      this.filesSaveMsg = '';
      if (!this.filesCurrentPath) { this.filesError = 'Open a file first.'; return; }
      const branch = this._resolveVariantBranch();
      if (!branch) { this.filesError = 'Enter a variant branch name (e.g. variant/my-edit).'; return; }
      this._stashActive();
      this.filesSaving = true;
      try {
        const newSha = await this._commitFile(this.filesCurrentPath, branch);
        this.filesSha = newSha;
        this.filesBranch = branch;
        this.filesVariantName = branch;
        const remaining = this.unsavedFiles.length;
        this.filesSaveMsg = remaining
          ? `Saved ${this.filesCurrentPath} to ${branch} — ${remaining} other file${remaining === 1 ? '' : 's'} still unsaved.`
          : `Saved ${this.filesCurrentPath} to ${branch}.`;
        await this.loadFilesBranches();
        await this.loadFilesTree();
      } catch (e) {
        this.filesError = e.message;
      } finally {
        this.filesSaving = false;
      }
    },

    async saveAllFiles() {
      this.filesError = '';
      this.filesSaveMsg = '';
      const branch = this._resolveVariantBranch();
      if (!branch) { this.filesError = 'Enter a variant branch name (e.g. variant/my-edit).'; return; }
      this._stashActive();
      const dirty = this.unsavedFiles;
      if (!dirty.length) { this.filesSaveMsg = 'No unsaved changes.'; return; }
      this.filesSaving = true;
      try {
        for (const path of dirty) {
          await this._commitFile(path, branch);
        }
        this.filesBranch = branch;
        this.filesVariantName = branch;
        if (this.filesEdits[this.filesCurrentPath]) this.filesSha = this.filesEdits[this.filesCurrentPath].sha;
        this.filesSaveMsg = `Saved ${dirty.length} file${dirty.length === 1 ? '' : 's'} to ${branch}.`;
        await this.loadFilesBranches();
        await this.loadFilesTree();
      } catch (e) {
        this.filesError = e.message;
      } finally {
        this.filesSaving = false;
      }
    },

    leaveFiles() {
      if (!this._confirmDiscard()) return;
      this.backToList();
    },

    // ─────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────
    // Maps a 0-10 score to a colour class. The session list still shows
    // total_score/10; the detail hero passes (score/10) so its 0-100 value maps
    // through the same thresholds.
    scoreCssClass(n) {
      if (n == null) return '';
      if (n >= 7) return 'score-good';
      if (n >= 4) return 'score-warn';
      return 'score-poor';
    },

    // ─────────────────────────────────────────────
    // Structured grade report (GRADING_METRICS_MAP.md §5)
    //
    // The session-detail API returns `report` — the exact per-track object
    // produced by server/vibe/grader/report.py (identical to one entry of
    // REPORT_DATA.reports.<track> in dummy_grading_report.html). These render
    // helpers are ported from that page's renderer, adapted to use the
    // dashboard's HTML-escaping and the .grade-report CSS namespace. The whole
    // grade view is built as one HTML string and injected via x-html.
    // ─────────────────────────────────────────────
    VERDICT_LABEL: { strong: 'Strong', weak: 'Weak', missing: 'Missing', na: 'N/A' },

    // HTML-escape — every dynamic value flows through this before going into
    // the x-html string, so report text can never inject markup.
    escHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    },

    grVerdictPill(verdict) {
      const e = this.escHtml.bind(this);
      return `<span class="gr-pill ${e(verdict)}">${e(this.VERDICT_LABEL[verdict] || verdict)}</span>`;
    },

    grLegendHtml(legend) {
      const e = this.escHtml.bind(this);
      const verdicts = (legend && legend.verdicts) || [];
      const items = verdicts.map((v) =>
        `<span class="gr-item">${this.grVerdictPill(v.key)} ${e(v.definition)}</span>`).join('');
      return `<div class="gr-legend"><span class="gr-legend-title">How to read a verdict:</span>${items}</div>`;
    },

    grSubpointsHtml(subpoints) {
      const e = this.escHtml.bind(this);
      if (!subpoints || !subpoints.length) return '';
      const rows = subpoints.map((sp) => `
        <li>
          <span>${this.grVerdictPill(sp.verdict)}</span>
          <span class="sp-body">
            <span class="checks">${e(sp.checks)}</span>
            ${sp.detail ? `<span class="detail"> — ${e(sp.detail)}</span>` : ''}
            <span class="sp-key"><code>${e(sp.key)}</code></span>
          </span>
        </li>`).join('');
      return `<ul class="gr-subpoints">${rows}</ul>`;
    },

    grRubricHtml(r) {
      const e = this.escHtml.bind(this);
      // Every rubric is shown. N/A rubrics (applies === false) render as N/A —
      // never dropped — with their na_reason and na verdict subpoints intact.
      const isNa = r.applies === false;
      const scoreBlock = isNa
        ? `<span class="gr-na-badge">N/A</span><div class="weight">not counted</div>`
        : `<div class="val">${e(r.score)}<span class="den"> / ${e(r.out_of)}</span></div>
           <div class="weight">weight ${e(r.weight)}%</div>`;
      return `
        <article class="gr-rubric ${isNa ? 'is-na' : ''}">
          <div class="gr-rubric-head">
            <div>
              <p class="gr-title">${e(r.title)}</p>
              <span class="gr-label"><code>${e(r.label)}</code> · ${e(r.kind === 'llm' ? 'LLM-judged' : 'deterministic')}</span>
            </div>
            <div class="gr-rubric-score">${scoreBlock}</div>
          </div>
          <div class="gr-yardstick">
            <div class="col good"><span class="k">Good</span>${e(r.good)}</div>
            <div class="col bad"><span class="k">Bad</span>${e(r.bad)}</div>
          </div>
          ${isNa && r.na_reason ? `<p class="gr-na-reason">${e(r.na_reason)}</p>` : ''}
          ${this.grSubpointsHtml(r.subpoints)}
          ${r.note ? `<p class="gr-note">${e(r.note)}</p>` : ''}
        </article>`;
    },

    grSectionHtml(sec) {
      const e = this.escHtml.bind(this);
      return `
        <h2 class="gr-section-title">${e(sec.title)}</h2>
        <p class="gr-section-sub">${e(sec.subtitle)}</p>
        ${(sec.rubrics || []).map((r) => this.grRubricHtml(r)).join('')}`;
    },

    grBonusHtml(b) {
      const e = this.escHtml.bind(this);
      return `
        <div class="gr-bonus">
          <div class="gr-bonus-head">
            <span class="gr-title">${e(b.title)}</span>
            <span>${b.attempted ? this.grVerdictPill('strong') : this.grVerdictPill('na')} <span class="lifts">lifts ${e(b.lifts)}</span></span>
          </div>
          <p class="note-plain">${e(b.note)}</p>
          ${this.grSubpointsHtml(b.subpoints)}
        </div>`;
    },

    grTelemetryHtml(rows) {
      const e = this.escHtml.bind(this);
      rows = rows || [];
      // vibe-only rows show as N/A on the non-AI track (applies === false).
      const groups = [
        { key: 'both', title: 'Shared — both tracks' },
        { key: 'vibe', title: 'AI collaboration — vibe coding only' },
      ];
      const body = groups.map((g) => {
        const rs = rows.filter((r) => r.track === g.key);
        if (!rs.length) return '';
        const trs = rs.map((r) => `
          <tr class="${r.applies === false ? 'is-na' : ''}">
            <td>${e(r.name)}<div class="src"><code>${e(r.source)}</code></div></td>
            <td class="val">${r.applies === false ? '<span class="gr-pill na">N/A</span>' : e(r.value)}</td>
            <td>${e(r.detail)}</td>
          </tr>`).join('');
        return `
          <div class="gr-tele-group-title">${e(g.title)}</div>
          <table class="gr-tele">
            <thead><tr><th>Signal</th><th>Value</th><th>Detail</th></tr></thead>
            <tbody>${trs}</tbody>
          </table>`;
      }).join('');
      return `<details class="gr-telemetry" open><summary>Telemetry — the raw signals behind the scores</summary>${body}</details>`;
    },

    // Banner surfaced from report.meta: the no-show / telemetry-tamper state now
    // lives in meta.no_show / meta.telemetry_tampered (reflected in floored
    // rubric scores + their note fields). We surface a headline banner from
    // meta; the per-rubric explanation rides along in each rubric's note.
    grMetaBannerHtml(meta) {
      if (!meta) return '';
      const e = this.escHtml.bind(this);
      let html = '';
      if (meta.telemetry_tampered) {
        html += `<div class="gr-banner">
          <span class="gr-banner-title">⚠ Telemetry integrity violation</span>
          The telemetry record this grade relies on was deleted or tampered with — all dimensions were floored. See the per-rubric notes below.
        </div>`;
      }
      if (meta.no_show) {
        html += `<div class="gr-banner">
          <span class="gr-banner-title">Candidate did not engage</span>
          The behavioural and judgment dimensions were floored because the candidate did not attempt the challenge. See the per-rubric notes below.
        </div>`;
      }
      return html;
    },

    // Build the whole grade view as one HTML string for x-html. Handles the
    // three states the API can present:
    //   • report present  → full §5 layout (overall + sections + bonuses + telemetry)
    //   • report === null but a grade row exists → flat headline + re-grade notice
    //   • no grade row at all → "grading in progress"
    gradeReportHtml(detail) {
      const e = this.escHtml.bind(this);
      const report = detail && detail.report;
      const grade = detail && detail.grade;

      if (report) {
        const o = report.overall || {};
        const overall = `
          <section class="gr-overall">
            <div class="gr-dial">
              <div class="num">${e(o.score)}</div>
              <div class="den">/ ${e(o.out_of)}</div>
              <span class="gr-band ${e(o.band)}">${e(o.band)}</span>
              <div class="dial-note">weighted average</div>
            </div>
            <div>
              <div class="gr-track-label">Track: ${e(report.track_label)}</div>
              <h1>Why this score</h1>
              <ul class="gr-summary">${(o.summary_points || []).map((p) => `<li>${e(p)}</li>`).join('')}</ul>
              ${this.grLegendHtml(report.legend)}
            </div>
          </section>`;
        const sections = (report.sections || []).map((s) => this.grSectionHtml(s)).join('');
        const bonuses = (report.bonuses && report.bonuses.length)
          ? `<h2 class="gr-section-title">Bonuses</h2>
             <p class="gr-section-sub">Optional credit that can only lift a score, never lower it.</p>
             ${report.bonuses.map((b) => this.grBonusHtml(b)).join('')}`
          : '';
        return `<div class="grade-report">
          ${this.grMetaBannerHtml(report.meta)}
          ${overall}
          ${sections}
          ${bonuses}
          ${this.grTelemetryHtml(report.telemetry)}
        </div>`;
      }

      // No structured report. Fall back to the flat grade headline, or to a
      // grading-in-progress notice when there's no grade row at all.
      if (grade && grade.total_score != null) {
        const band = grade.band || '';
        return `<div class="grade-report">
          <section class="gr-overall">
            <div class="gr-dial">
              <div class="num">${e(grade.total_score)}</div>
              <div class="den">/ 100</div>
              ${band ? `<span class="gr-band ${e(band)}">${e(band)}</span>` : ''}
            </div>
            <div>
              <div class="gr-track-label">Track: ${e(grade.track || '—')}</div>
              <h1>Grade summary</h1>
              <p class="gr-section-sub">The detailed per-rubric report is not available in the new format for this session — a re-grade is needed to populate it.</p>
            </div>
          </section>
        </div>`;
      }
      return `<div class="grade-report">
        <p class="text-muted" style="font-size:13px">Grading in progress — no grade is available yet.</p>
      </div>`;
    },

    formatDate(ts) {
      if (!ts) return '—';
      return new Date(ts * 1000).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    },

    hasPanel(s) {
      if (!s) return false;
      return !!(s.meet_link || s.scheduled_at || (s.panelist_emails && String(s.panelist_emails).trim().length > 0));
    },

    panelTooltip(s) {
      if (!s) return '';
      const parts = [];
      if (s.scheduled_at) parts.push(`Scheduled: ${this.formatDate(s.scheduled_at)}`);
      if (s.panelist_emails) parts.push(`Panelists: ${s.panelist_emails}`);
      if (s.meet_link) parts.push('Has video call link');
      return parts.join('\n');
    },

    elapsed(startedAt, submittedAt) {
      if (!startedAt) return '—';
      const end = submittedAt ?? Math.floor(Date.now() / 1000);
      const mins = Math.floor((end - startedAt) / 60);
      return `${mins}m`;
    },

    fmtNum(n) {
      if (n == null || n === 0) return '0';
      return n.toLocaleString();
    },

    fmtDuration(ms) {
      if (ms == null || ms <= 0) return '—';
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `${sec}s`;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
      const h = Math.floor(m / 60);
      const mm = m % 60;
      return mm ? `${h}h ${mm}m` : `${h}h`;
    },

    totalTokens(detail) {
      if (!detail?.chat_exchanges?.length) return { input: 0, output: 0, cached: 0 };
      return detail.chat_exchanges.reduce((acc, e) => {
        // Candidate-only input: their prompt + attachments, with the repo dump
        // and system instructions excluded. Null means the row predates the
        // column (backfilled at server startup); treat as 0 until filled.
        acc.input += e.candidate_prompt_tokens ?? 0;
        acc.output += e.completion_tokens ?? 0;
        acc.cached += e.cached_input_tokens ?? 0;
        return acc;
      }, { input: 0, output: 0, cached: 0 });
    },

    promptExchanges(detail) {
      return detail?.chat_exchanges ?? [];
    },

    promptClassBadge(cls) {
      if (cls === 'professional') return 'badge-graded';
      if (cls === 'specific') return 'badge-submitted';
      if (cls === 'vague') return 'badge-poor';
      return 'badge-pending';
    },

    promptScoreClass(score) {
      if (typeof score !== 'number') return 'prompt-score-mid';
      if (score >= 8) return 'prompt-score-high';
      if (score >= 4) return 'prompt-score-mid';
      return 'prompt-score-low';
    },

    async _get(url) {
      const r = await fetch(url, { headers: { 'x-admin-token': this.adminToken } });
      if (r.status === 401 || r.status === 403) { this.logout(); throw new Error('Session expired'); }
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return r.json();
    },

    async _post(url, body) {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'x-admin-token': this.adminToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401 || r.status === 403) { this.logout(); throw new Error('Session expired'); }
      if (!r.ok) throw new Error(data.detail ?? `${r.status} ${r.statusText}`);
      return data;
    },
  }));
});

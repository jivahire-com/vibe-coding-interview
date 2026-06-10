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
    scoreColor(n) {
      if (n == null) return '';
      if (n >= 7) return 'good';
      if (n >= 4) return 'warn';
      return 'poor';
    },

    scoreCssClass(n) {
      if (n == null) return '';
      if (n >= 7) return 'score-good';
      if (n >= 4) return 'score-warn';
      return 'score-poor';
    },

    scoreBarWidth(n, max = 10) {
      if (n == null) return '0%';
      return `${Math.round((n / max) * 100)}%`;
    },

    devConfidenceBadgeClass(verdict) {
      if (verdict === 'developer') return 'badge-graded';
      if (verdict === 'uncertain') return 'badge-submitted';
      if (verdict === 'non_developer') return 'badge-poor';
      return 'badge-pending';
    },

    parseDevConfidenceSignals(raw) {
      if (!raw) return {};
      if (typeof raw === 'object') return raw;
      try { return JSON.parse(raw); } catch { return {}; }
    },

    parseSummaryLine(line) {
      const m = (line || '').match(/^(.+?)\s*\(([\d.]+\/10)\)\s*:\s*(.*)$/s);
      if (!m) return { label: '', score: '', body: line || '', matched: false };
      return { label: m[1], score: m[2], body: m[3], matched: true };
    },

    // Plain-English glossary for criterion/signal names that surface in
    // grader_summary reasons like `weakest criterion 'sync_primitive' ...`.
    // Hover-tooltip lookup — keep blurbs short (≤ ~120 chars).
    criterionGlossary: {
      // code_quality
      correctness:        "Code runs and passes the hidden tests.",
      idiomatic:          "Uses the language's standard conventions and libraries.",
      clarity:            "Readable structure, well-named identifiers.",
      edge_cases:         "Handles empty inputs, limits, and unusual values.",
      no_ai_defects:      "No new races, security holes, hallucinated APIs, or unnecessary AI-suggested abstractions.",
      // llm_communication
      context_framing:    "Pasted relevant code, errors, and constraints into the prompt instead of relying on the model to guess.",
      constraint_spec:    "Stated requirements explicitly (e.g. O(1), thread-safe, no allocations).",
      decomposition:      "Broke big tasks into 2–3 focused prompts instead of one giant ask.",
      iterative_refinement: "Gave specific feedback when the AI's output was wrong (e.g. 'line 12 has a race because…').",
      debug_loop:         "After a test failed, included the failing assertion and the relevant snippet in the next prompt.",
      token_discipline:   "Prompt length is roughly proportional to the problem (no massive dumps, no underspecified one-liners).",
      // architectural_reasoning
      why_before_how:     "Asked about tradeoffs (X vs Y) before asking for an implementation.",
      algorithm_choice:   "Credit only if the candidate (not the AI) picked the algorithm.",
      data_structure_choice: "Credit only if the candidate (not the AI) picked the data structure.",
      concurrency_design: "Lock placement, primitive choice, deadlock avoidance.",
      edge_case_awareness:"Considered boundary conditions, capacity limits, and unexpected inputs in the design.",
      constraint_driven:  "The solution respects stated constraints because the candidate raised them.",
      not_over_engineered:"Didn't add AI-suggested abstractions the problem doesn't need.",
      // challenge_specific (per-challenge bonus)
      sync_primitive:     "Picked the right concurrency primitive (e.g. plain mutex vs shared_mutex, Lock vs RLock).",
      time_source:        "Used a monotonic clock (time.monotonic) instead of wall-clock time for TTLs.",
      ttl_strategy:       "Expired entries are checked on read (lazy expiry) instead of being returned stale.",
      const_correctness:  "Inspection methods are `const` and the mutex is `mutable` (C++).",
      // verification_discipline signals
      test_after_apply_ratio:    "How often the candidate ran tests after applying AI-suggested code.",
      apply_then_edit_rate:      "How often the candidate edited AI code after applying it (vs accepting blindly).",
      self_authored_ratio:       "Share of code the candidate typed themselves vs pasted from the AI.",
      incremental_apply_pattern: "Applied AI code in small chunks rather than huge unreviewable dumps.",
      pre_submit_test_run:       "Ran the test suite shortly before submitting.",
      // ai_judgment signals
      explicit_rejections: "Times the candidate explicitly told the AI its suggestion was wrong.",
      modify_after_apply:  "Times the candidate edited AI suggestions after applying them.",
      hand_fixed_traps:    "Planted bugs the candidate caught and fixed without AI help.",
      recovery_events:     "Times the candidate recovered from a bad AI suggestion (reverts, do-overs).",
    },

    // Split a grader_summary reason into (prefix, term, suffix) so the
    // criterion/signal name can be rendered with a glossary tooltip. If no
    // known term is present, returns the whole text as `prefix` with empty
    // `term`/`suffix` so the same template still renders cleanly.
    parseReasonParts(text) {
      const empty = { prefix: text || '', term: '', glossary: '', suffix: '' };
      if (!text) return empty;
      const m = text.match(/^(.*?weakest (?:criterion|signal) ')([a-z_][a-z0-9_]*)('.*)$/s);
      if (!m) return empty;
      const glossary = this.criterionGlossary[m[2]] || `Sub-criterion '${m[2]}' — no glossary entry yet.`;
      return { prefix: m[1], term: m[2], glossary, suffix: m[3] };
    },

    // Canonical dimension order — mirrors COMPOSITE_WEIGHTS in
    // server/vibe/grader/runner.py. The grader builds grader_summary in this
    // same order, so rendering both from this list keeps the breakdown rows
    // and summary reasoning in lock-step.
    scoreDimensions: [
      { label: 'Tests',                   key: 'tests',                   weight: 20, kind: 'fraction', num: 'tests_passed',    denom: 'tests_total',
        tip: 'Hidden quality checks the candidate\'s code passed.' },
      { label: 'Traps',                   key: 'traps',                   weight: 12, kind: 'fraction', num: 'traps_detected',  denom: 'traps_total',
        tip: 'Intentional bugs hidden in the starter code; counts how many the candidate caught and fixed.' },
      { label: 'Verification discipline', key: 'verification_discipline', weight: 13, kind: 'score',    field: 'verification_discipline_score',
        tip: 'How rigorously the candidate verified their own work (tests run, edge cases probed).' },
      { label: 'AI judgment',             key: 'ai_judgment',             weight:  8, kind: 'score',    field: 'ai_judgment_score',
        tip: 'Quality of decisions about when (and when not) to accept AI suggestions.' },
      { label: 'LLM communication',       key: 'llm_communication',       weight: 17, kind: 'score',    field: 'llm_communication_score',
        tip: 'How precisely and professionally the candidate prompted the AI.' },
      { label: 'Code quality',            key: 'code_quality',            weight: 15, kind: 'score',    field: 'code_quality_score',
        tip: 'Readability, structure, and idiomatic use of the language.' },
      { label: 'Architectural reasoning', key: 'architectural_reasoning', weight: 10, kind: 'score',    field: 'architectural_reasoning_score',
        tip: 'Soundness of the broader design choices the candidate made.' },
      { label: 'Challenge-specific',      key: 'challenge_specific',      weight:  5, kind: 'score',    field: 'challenge_specific_score',
        tip: 'Bonus criteria unique to this challenge\'s rubric.' },
    ],

    dimensionScore(grade, dim) {
      if (!grade) return null;
      if (dim.kind === 'fraction') {
        const denom = grade[dim.denom];
        if (!denom) return null;
        return (grade[dim.num] / denom) * 10;
      }
      const v = grade[dim.field];
      return (v == null) ? null : v;
    },

    dimensionDisplay(grade, dim) {
      if (!grade) return '—';
      if (dim.kind === 'fraction') return `${grade[dim.num] ?? 0}/${grade[dim.denom] ?? 0}`;
      return grade[dim.field] ?? '—';
    },

    // When the grader flagged a no-show, composite_breakdown carries a
    // `no_show` flag + reason. Returns the reason string to show as a banner, or
    // null when the candidate engaged. composite_breakdown arrives as a JSON
    // string from the grades row.
    gradeNoShow(grade) {
      if (!grade?.composite_breakdown) return null;
      let cb = grade.composite_breakdown;
      if (typeof cb === 'string') {
        try { cb = JSON.parse(cb); } catch { return null; }
      }
      return cb && cb.no_show
        ? (cb.no_show_reason || 'Candidate did not attempt the challenge.')
        : null;
    },

    // Map grader_summary lines (one per dimension, in canonical order) back to
    // each dimension's reasoning text, keyed by the human label.
    summaryReasonByLabel(grade) {
      const out = {};
      if (!grade?.grader_summary) return out;
      for (const line of grade.grader_summary.split(' | ')) {
        const p = this.parseSummaryLine(line);
        if (p.matched) out[p.label] = p.body;
      }
      return out;
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

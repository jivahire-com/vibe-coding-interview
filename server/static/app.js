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
    inviteForm: { email: '', challengeId: '', maxMinutes: 60, budgetUsd: 2.00, sessionKey: '', meetLink: '', scheduledLocal: '', panelistEmails: '' },
    inviteLoading: false,
    inviteError: '',
    inviteResult: null,  // { sessionKey }
    copied: false,

    // ─────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────
    async init() {
      window.addEventListener('popstate', () => this._restoreFromHash());
      if (this.adminToken) {
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
      if (!this.adminToken.trim()) { this.authError = 'Enter your admin token.'; return; }
      const ok = await this._testToken(this.adminToken.trim());
      if (ok) {
        localStorage.setItem('jh_token', this.adminToken.trim());
        await this.loadSessions();
        await this.loadChallenges();
        this.view = 'list';
        this._setHash('list');
      } else {
        this.authError = 'Invalid admin token.';
      }
    },

    async _testToken(token) {
      try {
        const r = await fetch('/api/v1/sessions', { headers: { 'x-admin-token': token } });
        return r.status !== 403 && r.status !== 401;
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
        this.selectedSession = r;
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
    openInvite() {
      this.inviteResult = null;
      this.inviteError = '';
      this.inviteForm.email = '';
      this.inviteForm.sessionKey = '';
      this.inviteForm.maxMinutes = 60;
      this.inviteForm.budgetUsd = 2.00;
      this.inviteForm.meetLink = '';
      this.inviteForm.scheduledLocal = '';
      this.inviteForm.panelistEmails = '';
      if (this.challenges.length) this.inviteForm.challengeId = this.challenges[0];
      this.showInvitePanel = true;
    },

    closeInvite() {
      this.showInvitePanel = false;
      this.inviteResult = null;
    },

    async sendInvite() {
      this.inviteError = '';
      if (!this.inviteForm.email.trim()) { this.inviteError = 'Email is required.'; return; }
      if (!this.inviteForm.challengeId) { this.inviteError = 'Select a challenge.'; return; }
      if (!this.inviteForm.sessionKey.trim()) { this.inviteError = 'Session key is required.'; return; }

      // Guard against the historical Alpine binding bug where the select displayed
      // one option but the model was stale. Confirm the admin's selection matches
      // the actual <select> value before sending the invite.
      const selectEl = document.querySelector('select[x-model="inviteForm.challengeId"]');
      const domValue = selectEl ? selectEl.value : this.inviteForm.challengeId;
      if (domValue !== this.inviteForm.challengeId) {
        // DOM is the source of truth — what the admin actually sees.
        this.inviteForm.challengeId = domValue;
      }
      if (this.challenges.length && !this.challenges.includes(this.inviteForm.challengeId)) {
        this.inviteError = `Unknown challenge "${this.inviteForm.challengeId}". Pick one from the list.`;
        return;
      }
      if (!confirm(`Send invite for challenge "${this.inviteForm.challengeId}" to ${this.inviteForm.email.trim()}?`)) {
        return;
      }

      const meetLink = (this.inviteForm.meetLink || '').trim();
      if (meetLink && !meetLink.startsWith('https://')) {
        this.inviteError = 'Video meeting link must start with https://';
        return;
      }

      // datetime-local gives "YYYY-MM-DDTHH:mm" in the browser's local TZ. new
      // Date() parses that as local time; .getTime() returns ms since epoch
      // in UTC. Divide by 1000 to get the epoch seconds the API expects.
      let scheduledAt = null;
      if (this.inviteForm.scheduledLocal) {
        const parsed = new Date(this.inviteForm.scheduledLocal);
        if (Number.isNaN(parsed.getTime())) {
          this.inviteError = 'Could not read the scheduled start time.';
          return;
        }
        scheduledAt = Math.floor(parsed.getTime() / 1000);
      }

      const panelistEmails = (this.inviteForm.panelistEmails || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const badPanelist = panelistEmails.find((e) => !e.includes('@'));
      if (badPanelist) {
        this.inviteError = `Invalid panelist email: ${badPanelist}`;
        return;
      }
      if (panelistEmails.length > 0 && !meetLink) {
        this.inviteError = 'Add a video meeting link before adding panelists.';
        return;
      }

      this.inviteLoading = true;
      try {
        const body = {
          session_key: this.inviteForm.sessionKey.trim(),
          candidate_email: this.inviteForm.email.trim(),
          challenge_id: this.inviteForm.challengeId,
          max_minutes: Number(this.inviteForm.maxMinutes),
          llm_budget_usd: Number(this.inviteForm.budgetUsd),
        };
        if (meetLink) body.meet_link = meetLink;
        if (scheduledAt !== null) body.scheduled_at = scheduledAt;
        if (panelistEmails.length > 0) body.panelist_emails = panelistEmails;
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

    formatDate(ts) {
      if (!ts) return '—';
      return new Date(ts * 1000).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
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

    totalTokens(detail) {
      if (!detail?.chat_exchanges?.length) return { input: 0, output: 0, cached: 0 };
      return detail.chat_exchanges.reduce((acc, e) => {
        acc.input += e.prompt_tokens ?? 0;
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

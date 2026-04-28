document.addEventListener('alpine:init', () => {
  Alpine.data('App', () => ({
    // ── auth
    view: 'login',
    adminToken: localStorage.getItem('jh_token') || '',
    authError: '',

    // ── sessions list
    sessions: [],
    challenges: [],
    search: '',
    statusFilter: '',
    loading: false,
    listError: '',

    // ── session detail
    selectedSession: null,
    detailError: '',

    // ── invite drawer
    showInvitePanel: false,
    inviteForm: { email: '', challengeId: '', maxMinutes: 90, budgetUsd: 2.00, sessionKey: '' },
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
        if (this.challenges.length > 0 && !this.inviteForm.challengeId) {
          this.inviteForm.challengeId = this.challenges[0];
        }
      } catch { /* non-fatal */ }
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
      this.inviteForm.maxMinutes = 90;
      this.inviteForm.budgetUsd = 2.00;
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

      this.inviteLoading = true;
      try {
        const body = {
          session_key: this.inviteForm.sessionKey.trim(),
          candidate_email: this.inviteForm.email.trim(),
          challenge_id: this.inviteForm.challengeId,
          max_minutes: Number(this.inviteForm.maxMinutes),
          llm_budget_usd: Number(this.inviteForm.budgetUsd),
        };
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
